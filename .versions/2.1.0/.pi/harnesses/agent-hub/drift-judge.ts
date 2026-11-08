import {
	WATCHDOG_QUESTIONS_VERSION,
	WATCHDOG_STATE_VERSION,
	buildWatchdogState,
	type WatchdogStateBuild,
	type WatchdogStateV1,
} from "./drift-system1.ts";
import type { DriftAppliedAttribution, DriftShadowLaunch, DriftStopRecord } from "./drift-runtime.ts";
import { decideSystem1 } from "./drift-system1-policy.ts";
import type { AcceptedWatchdogProfile } from "./drift-system1-policy.ts";


export interface ShadowSession {
	configuredMode: "off" | "shadow" | "active";
	effectiveMode: "off" | "shadow" | "active";
	requestedModel?: string;
	approvedProfiles?: readonly AcceptedWatchdogProfile[];
	evaluate(input: { armed: boolean; state: WatchdogStateV1 | WatchdogStateBuild; signal?: AbortSignal }): Promise<unknown>;
}

export interface ShadowTraceEvent {
	dispatchId: string;
	attemptId: string;
	checkId: string;
	snapshotId: string;
	llmAttemptId?: string;
	rule?: string;
	configuredMode?: "off" | "shadow" | "active";
	effectiveMode?: "off" | "shadow" | "active";
	stateVersion?: string;
	questionsVersion?: string;
	status?: string;
	reason?: string;
	elapsedMs?: number | null;
	unused?: boolean;
	verdict?: string;
	returnedModel?: string | null;
	attempts?: number | null;
	usage?: { inputTokens: number; outputTokens: number } | null;
	numerical?: Record<string, number>;
	statusChoice?: "on_track" | "drifting" | "stuck" | "insufficient_evidence";
	requestedModel?: string;
	provider?: string;
	statusProvenance?: "provider" | "self_reported" | "derived";
	stateComplete?: boolean;
	predicatesProvider?: boolean;
	source?: "llm" | "none" | "system1";
	applied?: "yes" | "no" | "unknown";
	outcome?: string;
}

export interface ShadowTrace {
	evaluationStarted(event: ShadowTraceEvent): void;
	evaluationFinished(event: ShadowTraceEvent): void;
	llmStarted(event: ShadowTraceEvent): void;
	llmFinished(event: ShadowTraceEvent): void;
	decision(event: ShadowTraceEvent): void;
	/** Close open spans for one dispatch. Session shutdown owns `dispose()`. */
	endDispatch(dispatchId: string): void;
	dispose(): void;
}

export interface ShadowCoordinator {
	launch(input: DriftShadowLaunch): { onLlmSettled: (value: unknown) => void };
	noteOutcome(input: { applied: boolean; driftStop: DriftStopRecord | null; advisories: DriftStopRecord[]; attributions?: DriftAppliedAttribution[] }): void;
	dispose(): void;
	readonly evaluations: number;
}

const VERDICTS = new Set(["on_track", "drifting", "stuck", "insufficient_evidence"]);
const CARD_STATUSES = new Set(["ok", "skipped", "unavailable", "unsupported", "cancelled", "interrupted", "unknown", "verdict"]);

export function formatSystem1Card(input: { rule?: string; effectiveMode?: string; checkId: string; attemptId?: string; status: string; elapsedMs?: number | null; statusChoice?: string; confidence?: number | null; returnedModel?: string | null; stateVersion?: string; questionsVersion?: string; usage?: { inputTokens: number; outputTokens: number } | null }): string {
	const elapsed = input.elapsedMs == null ? "elapsed unknown" : `${input.elapsedMs}ms`;
	const check = input.checkId.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 8) || "unknown";
	const attempt = input.attemptId ? input.attemptId.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 8) : "";
	const rule = (input.rule ?? "unknown").replace(/[^a-z0-9_-]/gi, "").slice(0, 32) || "unknown";
	const mode = input.effectiveMode === "shadow" || input.effectiveMode === "off" || input.effectiveMode === "active" ? input.effectiveMode : "unknown";
	const status = CARD_STATUSES.has(input.status) ? input.status : "unknown";
	const choice = input.statusChoice && VERDICTS.has(input.statusChoice) ? input.statusChoice : "unknown";
	const confidence = typeof input.confidence === "number" && Number.isFinite(input.confidence) ? String(input.confidence) : "unknown";
	const model = input.returnedModel ? input.returnedModel.replace(/[^a-zA-Z0-9_.:/-]/g, "").slice(0, 64) : "unknown";
	const usage = input.usage ? `${input.usage.inputTokens}/${input.usage.outputTokens}` : "unknown";
	return [
		`System 1 · watchdog · ${rule} · ${mode}`,
		`check ${check}${attempt ? ` / attempt ${attempt}` : ""} · ${status} · ${elapsed}`,
		`Jev: ${choice} · confidence ${confidence} (provider)`,
		`model ${model} · state ${input.stateVersion ?? "unknown"} · questions ${input.questionsVersion ?? "unknown"} · policy ${mode === "active" ? "watchdog-policy/v1" : "none"}`,
		`usage ${usage}`,
	].join("\n");
}

export function formatSystem1DecisionCard(input: { checkId: string; attemptId?: string; source?: string; outcome?: string; applied?: string; llmVerdict?: string }): string {
	const check = input.checkId.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 8) || "unknown";
	const attempt = input.attemptId ? input.attemptId.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 8) : "unknown";
	const source = input.source === "llm" || input.source === "none" || input.source === "system1" ? input.source : "unknown";
	const outcome = (input.outcome ?? "unknown").replace(/[^a-z_]/gi, "").slice(0, 32) || "unknown";
	const applied = input.applied === "yes" || input.applied === "no" ? input.applied : "unknown";
	const verdict = input.llmVerdict && VERDICTS.has(input.llmVerdict) ? input.llmVerdict : "unknown";
	return `System 1 · watchdog · decision\ncheck ${check} / attempt ${attempt}\nsource ${source} · outcome ${outcome} · applied ${applied}\nLLM: ${verdict}`;
}

function resolve<T>(value: T | null | undefined | (() => T | null | undefined)): T | null {
	const resolved = typeof value === "function" ? (value as () => T | null | undefined)() : value;
	return resolved ?? null;
}

function clone<T>(value: T): T {
	try { return JSON.parse(JSON.stringify(value)) as T; } catch { return value; }
}

function isObservation(value: unknown): value is { events?: unknown; counters?: unknown; coverage?: unknown } {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safe(trace: ShadowTrace | null, fn: (trace: ShadowTrace) => void): void {
	if (!trace) return;
	try { fn(trace); } catch { /* observer failure must not change the judgment */ }
}

function ids(input: DriftShadowLaunch): ShadowTraceEvent {
	return {
		dispatchId: input.check.dispatchId,
		attemptId: input.check.attemptId,
		checkId: input.check.checkId,
		snapshotId: input.check.snapshotId,
		llmAttemptId: input.check.llmAttemptId,
		rule: input.violation.rule,
	};
}

function statusChoice(result: unknown): ShadowTraceEvent["statusChoice"] {
	if (!result || typeof result !== "object") return undefined;
	const answers = (result as { evaluation?: { answers?: unknown[] } }).evaluation?.answers;
	if (!Array.isArray(answers)) return undefined;
	for (const answer of answers) {
		if (!answer || typeof answer !== "object") continue;
		const record = answer as { questionId?: unknown; type?: unknown; value?: unknown };
		if (record.questionId === "status" && record.type === "choice" && typeof record.value === "string" && VERDICTS.has(record.value)) return record.value as ShadowTraceEvent["statusChoice"];
	}
	return undefined;
}

function numerical(result: unknown): Record<string, number> | undefined {
	if (!result || typeof result !== "object") return undefined;
	const answers = (result as { evaluation?: { answers?: unknown[] } }).evaluation?.answers;
	if (!Array.isArray(answers)) return undefined;
	const out: Record<string, number> = {};
	for (const answer of answers) {
		if (!answer || typeof answer !== "object") continue;
		const record = answer as { questionId?: unknown; type?: unknown; uncertainty?: { confidence?: unknown }; probabilityTrue?: unknown };
		if (record.questionId === "status" && record.type === "choice" && typeof record.uncertainty?.confidence === "number" && Number.isFinite(record.uncertainty.confidence)) {
			out.status_confidence = record.uncertainty.confidence;
			const distribution = (record.uncertainty as { distribution?: Record<string, unknown> }).distribution;
			for (const choice of ["on_track", "drifting", "stuck", "insufficient_evidence"]) {
				const probability = distribution?.[choice];
				if (typeof probability === "number" && Number.isFinite(probability)) out[`status_${choice}`] = probability;
			}
		}
		if (typeof record.questionId === "string" && record.type === "predicate" && typeof record.probabilityTrue === "number" && Number.isFinite(record.probabilityTrue)) {
			out[record.questionId] = record.probabilityTrue;
		}
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

function resultStatus(result: unknown): { status: string; reason?: string; returnedModel?: string | null; attempts?: number | null; usage?: ShadowTraceEvent["usage"] } {
	if (!result || typeof result !== "object") return { status: "unknown", attempts: null, usage: null, returnedModel: null };
	const record = result as { status?: unknown; reason?: unknown; missingCapabilities?: unknown; evaluation?: { metadata?: { returnedModel?: unknown; attempts?: unknown; usage?: { inputTokens?: unknown; outputTokens?: unknown } } } };
	const status = typeof record.status === "string" ? record.status : "unknown";
	const reason = typeof record.reason === "string" ? record.reason : undefined;
	const metadata = record.evaluation?.metadata;
	const usage = metadata?.usage;
	const knownUsage = usage && typeof usage.inputTokens === "number" && typeof usage.outputTokens === "number"
		&& Number.isFinite(usage.inputTokens) && Number.isFinite(usage.outputTokens)
		? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }
		: null;
	return {
		status,
		reason,
		returnedModel: typeof metadata?.returnedModel === "string" ? metadata.returnedModel : null,
		attempts: typeof metadata?.attempts === "number" && Number.isFinite(metadata.attempts) ? metadata.attempts : null,
		usage: knownUsage,
	};
}

function llmVerdict(value: unknown): { status: string; verdict?: string } {
	if (!value || typeof value !== "object") return { status: "unavailable" };
	const record = value as { status?: unknown; verdict?: unknown };
	if (record.status === "cancelled") return { status: "cancelled" };
	if (record.status === "unavailable" || record.status == null && typeof record.verdict !== "string") return { status: "unavailable" };
	if (typeof record.verdict === "string" && VERDICTS.has(record.verdict)) return { status: "verdict", verdict: record.verdict };
	if (record.status === "verdict") return { status: "unavailable" };
	return { status: "unavailable" };
}

export function createShadowCoordinator(options: {
	session?: ShadowSession | null | (() => ShadowSession | null);
	trace?: ShadowTrace | null | (() => ShadowTrace | null);
	task: string;
	scopeGlobs: string[];
	hubOwnedGlobs: string[];
	root?: string;
	armed: boolean;
	onCard?: (text: string) => void;
	now?: () => number;
}): ShadowCoordinator {
	const now = options.now ?? Date.now;
	let evaluations = 0;
	const dispatchIds = new Set<string>();
	const noted = new Set<string>();
	return {
		get evaluations() { return evaluations; },
		launch(input) {
			// In shadow the authoritative LLM starts immediately; active is gated below.
			dispatchIds.add(input.check.dispatchId);
			const trace = resolve(options.trace);
			const event = ids(input);
			const startLlm = () => { safe(trace, target => target.llmStarted(event)); input.startLlm(); };
			if (input.retry) {
				startLlm();
				// D1's new snapshot is LLM-only; the preceding System 1 result is not a pair.
				return { onLlmSettled: (value: unknown) => safe(trace, target => target.llmFinished({ ...event, ...llmVerdict(value) })) };
			}
			const session = resolve(options.session);
			const enabled = options.armed && session != null && session.configuredMode !== "off" && session.effectiveMode !== "off";
			const active = enabled && session.effectiveMode === "active" && !!session.approvedProfiles?.length;
			if (!active) startLlm();
			if (!enabled || input.signal.aborted) {
				return { onLlmSettled: (value) => safe(trace, (target) => target.llmFinished({ ...event, ...llmVerdict(value) })) };
			}
			let built: WatchdogStateBuild;
			try {
				built = buildWatchdogState({
					task: options.task,
					scope: options.scopeGlobs.slice(),
					hubOwnedPaths: options.hubOwnedGlobs.slice(),
					root: options.root,
					signal: { rule: input.violation.rule, terminal: input.violation.terminal === true },
					elapsedMs: input.elapsedMs,
					observation: isObservation(input.observation) ? clone(input.observation) : undefined,
				});
			} catch {
				built = { ok: false, reason: "state_too_large", bytes: Number.POSITIVE_INFINITY };
			}
			const profile = active ? session.approvedProfiles?.find(p => p.rules.includes(input.violation.rule)) ?? null : null;
			if (active && !profile) startLlm();
			const startedAt = now();
			evaluations++;
			safe(trace, (target) => target.evaluationStarted({
				...event,
				configuredMode: session.configuredMode,
				effectiveMode: session.effectiveMode,
				stateVersion: WATCHDOG_STATE_VERSION,
				questionsVersion: WATCHDOG_QUESTIONS_VERSION,
			}));
			const finish = (result: unknown, failed = false) => {
				const unused = !input.attemptLive();
				const parsed = failed ? { status: "unavailable", reason: "observer_error", returnedModel: null, attempts: null, usage: null } : resultStatus(result);
				const choice = failed ? undefined : statusChoice(result);
				const numbers = failed ? undefined : numerical(result);
				const evaluation = result && typeof result === "object" && "evaluation" in result ? (result as { evaluation?: { metadata?: { provider?: unknown; requestedModel?: unknown }; answers?: unknown[] } }).evaluation : undefined;
				const provenance = evaluation?.answers?.find((answer): answer is { questionId: string; uncertainty?: { provenance?: string } } => !!answer && typeof answer === "object" && (answer as { questionId?: unknown }).questionId === "status")?.uncertainty?.provenance;
				const predicatesProvider = ["repeating", "outside_task", "trail_carries_instructions"].every(id => evaluation?.answers?.some(answer => !!answer && typeof answer === "object" && (answer as { questionId?: unknown; type?: unknown; uncertainty?: { provenance?: unknown } }).questionId === id && (answer as { type?: unknown }).type === "predicate" && (answer as { uncertainty?: { provenance?: unknown } }).uncertainty?.provenance === "provider"));
				safe(trace, (target) => target.evaluationFinished({
					requestedModel: typeof evaluation?.metadata?.requestedModel === "string" ? evaluation.metadata.requestedModel : undefined,
					provider: typeof evaluation?.metadata?.provider === "string" ? evaluation.metadata.provider : undefined,
					statusProvenance: provenance === "provider" || provenance === "self_reported" || provenance === "derived" ? provenance : undefined,
					stateComplete: built.ok && !built.state.coverage.shortcut_blocked,
					predicatesProvider,
					...event,
					status: parsed.status,
					reason: parsed.reason,
					elapsedMs: Math.max(0, now() - startedAt),
					unused,
					returnedModel: parsed.returnedModel,
					attempts: parsed.attempts,
					usage: parsed.usage,
					numerical: numbers,
					statusChoice: choice,
				}));
				if (active && profile && !unused) {
					try {
						const decision = decideSystem1(result, { live: true, rule: input.violation.rule, state: built, requestedModel: session.requestedModel ?? "unknown" }, profile);
						if (decision.action === "continue") input.onShortcut?.();
						else startLlm();
					} catch { startLlm(); /* malformed provider result is never authority */ }
				}
				if (unused) return;
				try {
					options.onCard?.(formatSystem1Card({
						rule: input.violation.rule,
						effectiveMode: session.effectiveMode,
						checkId: input.check.checkId,
						attemptId: input.check.attemptId,
						status: parsed.status,
						elapsedMs: Math.max(0, now() - startedAt),
						statusChoice: choice,
						confidence: numbers?.status_confidence ?? null,
						returnedModel: parsed.returnedModel,
						stateVersion: WATCHDOG_STATE_VERSION,
						questionsVersion: WATCHDOG_QUESTIONS_VERSION,
						usage: parsed.usage,
					}));
				} catch { /* card delivery is not judgment */ }
			};
			try {
				void Promise.resolve(session.evaluate({ armed: true, state: built.ok ? built.state : built, signal: input.signal })).then(
					(result) => finish(result),
					() => finish(undefined, true),
				);
			} catch {
				finish(undefined, true);
			}
			return { deferLlm: active && !!profile, onLlmSettled: (value) => safe(trace, (target) => target.llmFinished({ ...event, ...llmVerdict(value) })) };
		},
		noteOutcome(input) {
			for (const item of input.attributions ?? []) {
				const key = `${item.dispatchId}:${item.attemptId}:${item.checkId}`;
				if (noted.has(key)) continue;
				noted.add(key);
				const source = item.source === "none" ? "none" : item.source === "llm" ? "llm" : "none";
				safe(resolve(options.trace), (target) => target.decision({
					dispatchId: item.dispatchId,
					attemptId: item.attemptId,
					checkId: item.checkId,
					snapshotId: item.snapshotId,
					llmAttemptId: item.llmAttemptId,
					rule: item.rule,
					source,
					applied: item.applied,
					outcome: item.outcome,
				}));
				try {
					options.onCard?.(formatSystem1DecisionCard({
						checkId: item.checkId,
						attemptId: item.attemptId,
						source,
						outcome: item.outcome,
						applied: item.applied,
					}));
				} catch { /* card delivery is not judgment */ }
			}
		},
		dispose() {
			const trace = resolve(options.trace);
			for (const dispatchId of dispatchIds) {
				safe(trace, (target) => target.endDispatch(dispatchId));
			}
		},
	};
}
