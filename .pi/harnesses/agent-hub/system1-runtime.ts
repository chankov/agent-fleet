import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SYSTEM1_CONFIG_RELATIVE_PATH } from "../lib/system1/config.js";
import type { JsonText, System1Availability, System1Result, System1Service } from "../lib/system1/contracts.ts";
import { createSystem1Runtime, DEFAULT_SYSTEM1_TIMEOUT_MS } from "../lib/system1/service.ts";
import type { JevTransport } from "../lib/system1/jev.ts";
import { normalizeWatchdogSetting } from "./drift-watchdog.js";
import { WATCHDOG_POLICY_VERSION, type AcceptedWatchdogProfile } from "./drift-system1-policy.ts";
import {
	WATCHDOG_QUESTIONS,
	WATCHDOG_QUESTIONS_VERSION,
	WATCHDOG_REQUIRED_CAPABILITIES,
	WATCHDOG_STATE_MAX_BYTES,
	WATCHDOG_STATE_VERSION,
	buildWatchdogState,
	parseWatchdogStateV1,
	type WatchdogStateBuild,
	type WatchdogStateV1,
} from "./drift-system1.ts";

export const WATCHDOG_SYSTEM1_MODES = ["off", "shadow", "active"] as const;
export type WatchdogSystem1Mode = (typeof WATCHDOG_SYSTEM1_MODES)[number];
export const DEFAULT_WATCHDOG_SYSTEM1_MODE: WatchdogSystem1Mode = "off";
/** Production approved profiles stay empty until a separate reviewed G2 change. */
export const APPROVED_WATCHDOG_PROFILES: readonly AcceptedWatchdogProfile[] = Object.freeze([]);
export const ACTIVE_BLOCKED_LABEL = "active blocked: calibration_required";

export type WatchdogConsumerSkipReason =
	| "consumer_off"
	| "feature_unselected"
	| "watchdog_disarmed"
	| "state_too_large"
	| "invalid_state"
	| "disposed";

export type WatchdogConsumerResult =
	| System1Result
	| { status: "skipped"; reason: WatchdogConsumerSkipReason };

export interface WatchdogSystem1Session {
	readonly configuredMode: WatchdogSystem1Mode;
	readonly effectiveMode: "off" | "shadow" | "active";
	readonly requestedModel: string;
	readonly blockLabel: string | null;
	readonly readiness: System1Availability;
	readonly approvedProfiles: readonly AcceptedWatchdogProfile[];
	readonly hubArmed: boolean;
	readonly warnings: readonly string[];
	disposed: boolean;
	evaluate(input: { armed: boolean; state: WatchdogStateV1 | WatchdogStateBuild; signal?: AbortSignal }): Promise<WatchdogConsumerResult>;
	dispose(): void;
}

export function normalizeWatchdogSystem1Mode(value: unknown): { mode: WatchdogSystem1Mode; warning?: string } {
	if (value == null || String(value).trim() === "") return { mode: DEFAULT_WATCHDOG_SYSTEM1_MODE };
	const mode = String(value).trim().toLowerCase();
	if ((WATCHDOG_SYSTEM1_MODES as readonly string[]).includes(mode)) return { mode: mode as WatchdogSystem1Mode };
	return {
		mode: "off",
		warning: `watchdog-system1 "${value}" is not one of ${WATCHDOG_SYSTEM1_MODES.join("|")} — using off`,
	};
}

const WATCHDOG_PROFILE_RULES = new Set(["scope", "loop", "failures", "toolcap"]);

function eligibleProfiles(profiles: readonly AcceptedWatchdogProfile[], config: unknown): readonly AcceptedWatchdogProfile[] {
	const requested = config && typeof config === "object" ? config as { provider?: unknown; model?: unknown } : null;
	return profiles.filter(profile => profile.policyVersion === WATCHDOG_POLICY_VERSION
		&& profile.stateVersion === WATCHDOG_STATE_VERSION && profile.questionsVersion === WATCHDOG_QUESTIONS_VERSION
		&& profile.provider === requested?.provider && profile.model === requested?.model
		&& profile.rules.length > 0 && profile.rules.every(rule => WATCHDOG_PROFILE_RULES.has(rule))
		&& Number.isFinite(profile.minConfidence) && profile.minConfidence >= 0 && profile.minConfidence <= 1
		&& Number.isFinite(profile.maxContradiction) && profile.maxContradiction >= 0 && profile.maxContradiction <= 1);
}

function effectiveMode(configured: WatchdogSystem1Mode, profiles: readonly AcceptedWatchdogProfile[]): "off" | "shadow" | "active" {
	return configured === "off" ? "off" : configured === "active" && profiles.length > 0 ? "active" : "shadow";
}

export interface ReadWatchdogSystem1SnapshotInput {
	cwd: string;
	configuredMode: WatchdogSystem1Mode;
	watchdogSetting: string;
	env?: Record<string, string | undefined>;
	transport?: JevTransport;
	warnings?: readonly string[];
}

/** Caller-owned reads. Matches doctor selection: only an explicit features.system1 true counts. Does not load dotenv. */
export function readWatchdogSystem1Snapshot(input: ReadWatchdogSystem1SnapshotInput): CreateWatchdogSystem1SessionOptions {
	return {
		configuredMode: input.configuredMode,
		watchdogArmed: normalizeWatchdogSetting(input.watchdogSetting) !== "off",
		selected: readFeatureSelected(input.cwd),
		config: readSystem1Config(input.cwd),
		env: input.env ?? {},
		transport: input.transport,
		warnings: input.warnings,
	};
}

function readFeatureSelected(cwd: string): boolean {
	const path = join(cwd, ".ai", "agent-fleet.json");
	if (!existsSync(path)) return false;
	try {
		const desired = JSON.parse(readFileSync(path, "utf8"));
		return desired?.features?.system1 === true;
	} catch {
		return false;
	}
}

function readSystem1Config(cwd: string): unknown {
	const path = join(cwd, SYSTEM1_CONFIG_RELATIVE_PATH);
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

export interface CreateWatchdogSystem1SessionOptions {
	configuredMode: WatchdogSystem1Mode;
	watchdogArmed: boolean;
	selected: boolean;
	config: unknown;
	env?: Record<string, string | undefined>;
	transport?: JevTransport;
	/** Test-only service/profile injection. Production wiring must omit both. */
	service?: System1Service;
	approvedProfilesForTest?: readonly AcceptedWatchdogProfile[];
	readiness?: System1Availability;
	warnings?: readonly string[];
}

export function createWatchdogSystem1Session(options: CreateWatchdogSystem1SessionOptions): WatchdogSystem1Session {
	const runtime = options.service
		? { readiness: options.readiness ?? { status: "ready" as const }, service: options.service }
		: createSystem1Runtime({
			selected: options.selected,
			config: options.config,
			env: options.env ?? {},
			transport: options.transport,
		});
	const configuredMode = options.configuredMode;
	// Only a profile matching this session's immutable provider/model and policy can open active.
	// An unrelated shipped profile must not turn configured active into effective active.
	const candidates = options.approvedProfilesForTest ?? APPROVED_WATCHDOG_PROFILES;
	const profiles = candidates.length ? eligibleProfiles(candidates, options.config) : candidates;
	const controller = new AbortController();
	let disposed = false;
	const session: WatchdogSystem1Session = {
		configuredMode,
		effectiveMode: effectiveMode(configuredMode, profiles),
		requestedModel: typeof (options.config as { model?: unknown } | null)?.model === "string" ? (options.config as { model: string }).model : "unknown",
		blockLabel: configuredMode === "active" && profiles.length === 0 ? ACTIVE_BLOCKED_LABEL : null,
		readiness: runtime.readiness,
		approvedProfiles: profiles,
		hubArmed: options.watchdogArmed,
		warnings: Object.freeze([...(options.warnings ?? [])]),
		disposed: false,
		async evaluate(input) {
			if (disposed || controller.signal.aborted) return { status: "skipped", reason: "disposed" };
			if (configuredMode === "off") return { status: "skipped", reason: "consumer_off" };
			if (!options.selected) return { status: "skipped", reason: "feature_unselected" };
			if (runtime.readiness.status !== "ready") return runtime.readiness;
			if (!input.armed) return { status: "skipped", reason: "watchdog_disarmed" };
			const outbound = consumerOutboundState(input.state);
			if (!outbound.ok) return { status: "skipped", reason: outbound.reason };
			if (input.signal?.aborted) return { status: "cancelled" };
			const call = new AbortController();
			const abortCall = () => call.abort();
			controller.signal.addEventListener("abort", abortCall, { once: true });
			input.signal?.addEventListener("abort", abortCall, { once: true });
			try {
				return await runtime.service.evaluate({
					state: outbound.state,
					questions: WATCHDOG_QUESTIONS,
					questionSetVersion: WATCHDOG_QUESTIONS_VERSION,
					timeoutMs: DEFAULT_SYSTEM1_TIMEOUT_MS,
					signal: call.signal,
					requiredCapabilities: WATCHDOG_REQUIRED_CAPABILITIES,
				});
			} finally {
				controller.signal.removeEventListener("abort", abortCall);
				input.signal?.removeEventListener("abort", abortCall);
			}
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			session.disposed = true;
			controller.abort();
		},
	};
	return session;
}

function consumerOutboundState(state: unknown): { ok: true; state: JsonText } | { ok: false; reason: "state_too_large" | "invalid_state" } {
	if (isOversizedBuild(state)) return { ok: false, reason: "state_too_large" };
	const candidate = isSuccessfulBuild(state) ? state.state : state;
	if (isRecord(state) && "ok" in state && !isSuccessfulBuild(state) && !isOversizedBuild(state)) {
		return { ok: false, reason: "invalid_state" };
	}
	const parsed = parseWatchdogStateV1(candidate);
	if (!parsed || parsed.schema !== WATCHDOG_STATE_VERSION) return { ok: false, reason: "invalid_state" };
	return byteGate(parsed);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(value);
	return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isOversizedBuild(state: unknown): state is Extract<WatchdogStateBuild, { ok: false }> {
	return isRecord(state)
		&& exactKeys(state, ["ok", "reason", "bytes"])
		&& state.ok === false
		&& state.reason === "state_too_large"
		&& typeof state.bytes === "number"
		&& Number.isFinite(state.bytes);
}

function isSuccessfulBuild(state: unknown): state is Extract<WatchdogStateBuild, { ok: true }> {
	return isRecord(state)
		&& exactKeys(state, ["ok", "state", "bytes"])
		&& state.ok === true
		&& typeof state.bytes === "number"
		&& Number.isFinite(state.bytes);
}

function byteGate(state: WatchdogStateV1): { ok: true; state: JsonText } | { ok: false; reason: "state_too_large" | "invalid_state" } {
	let serialized: string;
	try {
		serialized = JSON.stringify(state);
	} catch {
		return { ok: false, reason: "invalid_state" };
	}
	if (Buffer.byteLength(serialized, "utf8") > WATCHDOG_STATE_MAX_BYTES) return { ok: false, reason: "state_too_large" };
	const parsed: unknown = JSON.parse(serialized);
	if (!parseWatchdogStateV1(parsed) || typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { ok: false, reason: "invalid_state" };
	}
	return { ok: true, state: parsed as JsonText };
}

export function disposeWatchdogSystem1Session(session: WatchdogSystem1Session | null): null {
	session?.dispose();
	return null;
}

export { buildWatchdogState };
