import { randomUUID } from "node:crypto";
import { closeSync, constants, fchmodSync, lstatSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ShadowTrace, ShadowTraceEvent } from "./drift-judge.ts";

export const WATCHDOG_TRACE_SCHEMA = "watchdog-trace/v1";
export const WATCHDOG_TRACE_FILE = "events.jsonl";
const COMPLETED_LIMIT = 100;
const STATUSES = new Set(["ok", "skipped", "unavailable", "unsupported", "cancelled", "interrupted", "unknown", "verdict"]);
const REASONS = new Set(["consumer_off", "feature_unselected", "watchdog_disarmed", "state_too_large", "invalid_state", "disposed", "disabled", "missing_config", "missing_key", "timeout", "network", "auth", "rate_limit", "overloaded", "invalid_response", "invalid_config", "invalid_request", "cancelled", "interrupted", "observer_error", "unsupported", "unknown"]);
const VERDICTS = new Set(["on_track", "drifting", "stuck", "insufficient_evidence"]);
const OUTCOMES = new Set(["continue", "discard", "drift_stop", "advisory", "judge_unavailable", "unknown"]);

export interface WatchdogTraceRecord {
	schema: typeof WATCHDOG_TRACE_SCHEMA;
	type: "evaluation_started" | "evaluation_finished" | "llm_started" | "llm_finished" | "decision";
	sessionId: string;
	dispatchId: string;
	attemptId: string;
	checkId: string;
	snapshotId: string;
	sequence: number;
	at: number;
	consumer: "watchdog";
	llmAttemptId?: string;
	rule?: string;
	configuredMode?: "off" | "shadow" | "active";
	effectiveMode?: "off" | "shadow" | "active";
	stateVersion?: string;
	questionsVersion?: string;
	policyVersion: "none" | "watchdog-policy/v1";
	status?: string;
	reason?: string;
	elapsedMs?: number | null;
	unused?: boolean;
	verdict?: string;
	returnedModel?: string | null;
	attempts?: number | null;
	usage?: { inputTokens: number; outputTokens: number } | null;
	numerical?: Record<string, number>;
	source?: "llm" | "none" | "system1";
	applied?: "yes" | "no" | "unknown";
	outcome?: string;
	statusChoice?: "on_track" | "drifting" | "stuck" | "insufficient_evidence";
	requestedModel?: string;
	provider?: "typesafe";
	statusProvenance?: "provider" | "self_reported" | "derived";
	stateComplete?: boolean;
	predicatesProvider?: boolean;
}

export interface WatchdogCheckProjection {
	dispatchId: string;
	attemptId: string;
	checkId: string;
	snapshotId: string;
	evaluation: "evaluating" | "finished" | "interrupted" | "unknown";
	llm: "running" | "finished" | "interrupted" | "unknown" | "none";
	llmStatus?: string;
	status: string;
	reason: string;
	elapsedMs: number | null;
	usage: { inputTokens: number; outputTokens: number } | "unknown";
	returnedModel: string | "unknown";
	attempts: number | "unknown";
	applied: "yes" | "no" | "unknown";
	source: "llm" | "none" | "system1" | "unknown";
	outcome: string;
	unused: boolean;
	rule?: string;
	configuredMode?: "off" | "shadow" | "active";
	effectiveMode?: "off" | "shadow" | "active";
	stateVersion?: string;
	questionsVersion?: string;
	numerical?: Record<string, number>;
	statusChoice?: "on_track" | "drifting" | "stuck" | "insufficient_evidence";
	requestedModel?: string;
	provider?: "typesafe";
	statusProvenance?: "provider" | "self_reported" | "derived";
	stateComplete?: boolean;
	predicatesProvider?: boolean;
	llmVerdict?: string;
	finishedAt?: number;
}

export interface WatchdogActivity extends ShadowTrace {
	readonly degraded: boolean;
	readonly path: string | null;
	live(): { active: WatchdogCheckProjection[]; completed: WatchdogCheckProjection[]; degraded: boolean };
	dispose(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function enumValue<T extends string>(value: unknown, allowed: Set<string>, fallback: T): T {
	return typeof value === "string" && allowed.has(value) ? value as T : fallback;
}

function model(value: unknown): string | null {
	if (typeof value !== "string" || value.length === 0 || value.length > 128) return null;
	if (value.startsWith("/") || value.includes("\\") || value.split("/").includes("..")) return null;
	return value;
}

function usage(value: unknown): { inputTokens: number; outputTokens: number } | null {
	if (!isRecord(value)) return null;
	if (typeof value.inputTokens !== "number" || typeof value.outputTokens !== "number") return null;
	if (!Number.isFinite(value.inputTokens) || !Number.isFinite(value.outputTokens) || value.inputTokens < 0 || value.outputTokens < 0) return null;
	return { inputTokens: value.inputTokens, outputTokens: value.outputTokens };
}

function numerical(value: unknown): Record<string, number> | undefined {
	if (!isRecord(value)) return undefined;
	const out: Record<string, number> = {};
	for (const [key, item] of Object.entries(value)) {
		if (!/^[a-z0-9_]{1,64}$/.test(key)) continue;
		if (typeof item !== "number" || !Number.isFinite(item)) continue;
		out[key] = item;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

function keyOf(event: { dispatchId?: string; attemptId?: string; checkId?: string; snapshotId?: string }): string {
	return JSON.stringify([event.dispatchId ?? "", event.attemptId ?? "", event.checkId ?? "", event.snapshotId ?? ""]);
}

function secureAppend(path: string, text: string): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	try { if (lstatSync(path).isSymbolicLink()) throw new Error("refused watchdog trace symlink"); } catch (error: unknown) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const noFollow = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
	const fd = openSync(path, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | noFollow, 0o600);
	try {
		try { fchmodSync(fd, 0o600); } catch (error) { if (process.platform !== "win32") throw error; }
		writeSync(fd, text, undefined, "utf8");
	} finally {
		closeSync(fd);
	}
}

interface CheckState {
	record: WatchdogCheckProjection;
	llmAttemptId?: string;
	evaluationOpen: boolean;
	llmOpen: boolean;
	evaluationDone: boolean;
	llmDone: boolean;
	decisionDone: boolean;
	archived: boolean;
}

function blank(event: ShadowTraceEvent): WatchdogCheckProjection {
	return {
		dispatchId: event.dispatchId,
		attemptId: event.attemptId,
		checkId: event.checkId,
		snapshotId: event.snapshotId,
		evaluation: "unknown",
		llm: "none",
		status: "unknown",
		reason: "unknown",
		elapsedMs: null,
		usage: "unknown",
		returnedModel: "unknown",
		attempts: "unknown",
		applied: "unknown",
		source: "unknown",
		outcome: "unknown",
		unused: false,
	};
}

export function createWatchdogActivity(options: { directory?: string; sessionId?: string; now?: () => number; write?: (line: string) => void } = {}): WatchdogActivity {
	const now = options.now ?? Date.now;
	const sessionId = options.sessionId ?? randomUUID();
	const path = options.directory ? join(options.directory, WATCHDOG_TRACE_FILE) : null;
	const active = new Map<string, CheckState>();
	const known = new Map<string, CheckState>();
	const completed: WatchdogCheckProjection[] = [];
	let sequence = 0;
	let degraded = false;
	const append = (event: ShadowTraceEvent, type: WatchdogTraceRecord["type"], extra: Partial<WatchdogTraceRecord> = {}) => {
		const record: WatchdogTraceRecord = {
			schema: WATCHDOG_TRACE_SCHEMA,
			type,
			sessionId,
			dispatchId: event.dispatchId,
			attemptId: event.attemptId,
			checkId: event.checkId,
			snapshotId: event.snapshotId,
			sequence: ++sequence,
			at: now(),
			consumer: "watchdog",
			policyVersion: event.effectiveMode === "active" ? "watchdog-policy/v1" : "none",
			...(event.llmAttemptId ? { llmAttemptId: event.llmAttemptId } : {}),
			...(event.rule ? { rule: event.rule.slice(0, 64) } : {}),
			...extra,
		};
		const line = `${JSON.stringify(record)}\n`;
		try {
			if (options.write) options.write(line);
			else if (path) secureAppend(path, line);
		} catch {
			degraded = true;
		}
	};
	const ensure = (event: ShadowTraceEvent): CheckState | null => {
		if (!event.dispatchId || !event.attemptId || !event.checkId || !event.snapshotId) return null;
		const key = keyOf(event);
		let state = known.get(key);
		if (!state) {
			state = { record: blank(event), llmAttemptId: event.llmAttemptId, evaluationOpen: false, llmOpen: false, evaluationDone: false, llmDone: false, decisionDone: false, archived: false };
			known.set(key, state);
			active.set(key, state);
		}
		if (event.llmAttemptId && !state.llmAttemptId) state.llmAttemptId = event.llmAttemptId;
		return state;
	};
	const finishSlot = (state: CheckState) => {
		if (state.archived || state.evaluationOpen || state.llmOpen) return;
		if (!state.evaluationDone && !state.llmDone) return;
		state.archived = true;
		active.delete(keyOf(state.record));
		completed.push(state.record);
		while (completed.length > COMPLETED_LIMIT) {
			const dropped = completed.shift();
			if (dropped) known.delete(keyOf(dropped));
		}
	};
	let activity: WatchdogActivity;
	const finishOpen = (state: CheckState) => {
		const identity = { dispatchId: state.record.dispatchId, attemptId: state.record.attemptId, checkId: state.record.checkId, snapshotId: state.record.snapshotId, llmAttemptId: state.llmAttemptId };
		if (state.evaluationOpen && !state.evaluationDone) {
			activity.evaluationFinished({ ...identity, status: "cancelled", reason: "disposed", elapsedMs: state.record.elapsedMs, unused: true });
		}
		if (state.llmOpen && !state.llmDone) {
			activity.llmFinished({ ...identity, status: "cancelled" });
		}
	};
	activity = {
		get degraded() { return degraded; },
		get path() { return path; },
		evaluationStarted(event) {
			const state = ensure(event);
			if (!state || state.evaluationOpen || state.evaluationDone) return;
			state.evaluationOpen = true;
			state.record.evaluation = "evaluating";
			if (event.rule) state.record.rule = event.rule;
			if (event.configuredMode) state.record.configuredMode = event.configuredMode;
			if (event.effectiveMode) state.record.effectiveMode = event.effectiveMode;
			if (event.stateVersion) state.record.stateVersion = event.stateVersion;
			if (event.questionsVersion) state.record.questionsVersion = event.questionsVersion;
			append(event, "evaluation_started", {
				configuredMode: event.configuredMode,
				effectiveMode: event.effectiveMode,
				stateVersion: event.stateVersion,
				questionsVersion: event.questionsVersion,
			});
		},
		evaluationFinished(event) {
			const state = known.get(keyOf(event));
			if (!state || state.evaluationDone) return;
			state.evaluationDone = true;
			state.evaluationOpen = false;
			state.record.evaluation = "finished";
			state.record.status = enumValue(event.status, STATUSES, "unknown");
			state.record.reason = enumValue(event.reason, REASONS, "unknown");
			state.record.elapsedMs = typeof event.elapsedMs === "number" && Number.isFinite(event.elapsedMs) ? event.elapsedMs : null;
			state.record.usage = usage(event.usage) ?? "unknown";
			state.record.returnedModel = model(event.returnedModel) ?? "unknown";
			state.record.attempts = typeof event.attempts === "number" && Number.isFinite(event.attempts) ? event.attempts : "unknown";
			state.record.unused = event.unused === true;
			state.record.finishedAt = now();
			const choice = event.statusChoice;
			if (choice === "on_track" || choice === "drifting" || choice === "stuck" || choice === "insufficient_evidence") state.record.statusChoice = choice;
			const numbers = numerical(event.numerical);
			if (numbers) state.record.numerical = numbers;
			state.record.requestedModel = model(event.requestedModel) ?? undefined;
			state.record.provider = event.provider === "typesafe" ? "typesafe" : undefined;
			state.record.statusProvenance = event.statusProvenance === "provider" || event.statusProvenance === "self_reported" || event.statusProvenance === "derived" ? event.statusProvenance : undefined;
			state.record.stateComplete = event.stateComplete === true;
			state.record.predicatesProvider = event.predicatesProvider === true;
			append(event, "evaluation_finished", {
				policyVersion: state.record.effectiveMode === "active" ? "watchdog-policy/v1" : "none",
				status: state.record.status,
				reason: state.record.reason,
				elapsedMs: state.record.elapsedMs,
				unused: state.record.unused,
				returnedModel: state.record.returnedModel === "unknown" ? null : state.record.returnedModel,
				attempts: state.record.attempts === "unknown" ? null : state.record.attempts,
				usage: state.record.usage === "unknown" ? null : state.record.usage,
				numerical: numbers,
				...(state.record.statusChoice ? { statusChoice: state.record.statusChoice } : {}),
				requestedModel: state.record.requestedModel,
				provider: state.record.provider,
				statusProvenance: state.record.statusProvenance,
				stateComplete: state.record.stateComplete,
				predicatesProvider: state.record.predicatesProvider,
			});
			finishSlot(state);
		},
		llmStarted(event) {
			const state = ensure(event);
			if (!state || state.llmOpen || state.llmDone) return;
			if (state.archived) {
				state.archived = false;
				const index = completed.indexOf(state.record);
				if (index >= 0) completed.splice(index, 1);
				active.set(keyOf(event), state);
			}
			state.llmOpen = true;
			state.record.llm = "running";
			append(event, "llm_started");
		},
		llmFinished(event) {
			const state = known.get(keyOf(event));
			if (!state || state.llmDone) return;
			state.llmDone = true;
			state.llmOpen = false;
			state.record.llm = "finished";
			state.record.llmStatus = enumValue(event.status, STATUSES, "unknown");
			const verdict = typeof event.verdict === "string" && VERDICTS.has(event.verdict) ? event.verdict : undefined;
			if (verdict) state.record.llmVerdict = verdict;
			append(event, "llm_finished", { status: enumValue(event.status, STATUSES, "unknown"), ...(verdict ? { verdict } : {}) });
			finishSlot(state);
		},
		decision(event) {
			const state = known.get(keyOf(event));
			if (!state || state.decisionDone) return;
			state.decisionDone = true;
			state.record.source = event.source === "llm" || event.source === "none" || event.source === "system1" ? event.source : "unknown";
			state.record.applied = event.applied === "yes" || event.applied === "no" ? event.applied : "unknown";
			state.record.outcome = enumValue(event.outcome, OUTCOMES, "unknown");
			append(event, "decision", { policyVersion: state.record.effectiveMode === "active" ? "watchdog-policy/v1" : "none", source: state.record.source === "unknown" ? "none" : state.record.source, applied: state.record.applied, outcome: state.record.outcome });
		},
		live() {
			return { active: [...active.values()].map((item) => item.record), completed: completed.slice(), degraded };
		},
		endDispatch(dispatchId) {
			if (!dispatchId) return;
			for (const state of [...active.values()]) {
				if (state.record.dispatchId !== dispatchId) continue;
				finishOpen(state);
			}
		},
		dispose() {
			for (const state of [...active.values()]) finishOpen(state);
		},
	};
	return activity;
}

export function readWatchdogTrace(path: string, options: { after?: number; limit?: number } = {}): { events: WatchdogTraceRecord[]; nextOffset: number; invalidRecords: number; partialTail: boolean; readError: boolean } {
	const after = Math.max(0, options.after ?? 0);
	const limit = Math.max(1, options.limit ?? 100);
	let text = "";
	try { text = readFileSync(path, "utf8"); } catch (error: unknown) {
		return { events: [], nextOffset: after, invalidRecords: 0, partialTail: false, readError: (error as NodeJS.ErrnoException)?.code !== "ENOENT" };
	}
	// Never treat a complete-looking JSON object without a newline as a durable record.
	const incomplete = text.length > 0 && !text.endsWith("\n");
	const lines = text.split("\n").slice(0, -1).filter(line => line.length > 0);
	const page = lines.slice(after, after + limit);
	const events: WatchdogTraceRecord[] = [];
	let invalidRecords = 0;
	for (const line of page) {
		try {
			const parsed: unknown = JSON.parse(line);
			const record = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Partial<WatchdogTraceRecord> : null;
			if (record?.schema === WATCHDOG_TRACE_SCHEMA && record.consumer === "watchdog"
				&& record.type != null && ["evaluation_started", "evaluation_finished", "llm_started", "llm_finished", "decision"].includes(record.type)
				&& [record.sessionId, record.dispatchId, record.attemptId, record.checkId, record.snapshotId]
					.every(v => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(v))
				&& typeof record.sequence === "number" && Number.isFinite(record.sequence)
				&& typeof record.at === "number" && Number.isFinite(record.at)) events.push(record as WatchdogTraceRecord);
			else invalidRecords++;
		} catch { invalidRecords++; }
	}
	return { events, nextOffset: after + page.length, invalidRecords, partialTail: incomplete && after + page.length >= lines.length, readError: false };
}

/** Crash readback. An unfinished span is interrupted/unknown, never still evaluating and never success. */
export function projectWatchdogReadback(events: readonly WatchdogTraceRecord[]): WatchdogCheckProjection[] {
	const checks = new Map<string, WatchdogCheckProjection>();
	for (const event of events) {
		const key = keyOf(event);
		const current = checks.get(key) ?? {
			...blank(event),
			evaluation: "unknown" as const,
		};
		if (event.type === "evaluation_started") {
			current.evaluation = "evaluating";
			if (event.rule) current.rule = event.rule;
			if (event.configuredMode) current.configuredMode = event.configuredMode;
			if (event.effectiveMode) current.effectiveMode = event.effectiveMode;
			if (event.stateVersion) current.stateVersion = event.stateVersion;
			if (event.questionsVersion) current.questionsVersion = event.questionsVersion;
		}
		if (event.type === "evaluation_finished") {
			current.evaluation = "finished";
			current.status = event.status ?? "unknown";
			current.reason = event.reason ?? "unknown";
			current.elapsedMs = event.elapsedMs ?? null;
			current.usage = event.usage ?? "unknown";
			current.returnedModel = event.returnedModel ?? "unknown";
			current.attempts = event.attempts ?? "unknown";
			current.unused = event.unused === true;
			current.finishedAt = event.at;
			if (event.statusChoice) current.statusChoice = event.statusChoice;
			if (event.numerical) current.numerical = event.numerical;
			if (event.requestedModel) current.requestedModel = model(event.requestedModel) ?? undefined;
			if (event.provider === "typesafe") current.provider = "typesafe";
			if (event.statusProvenance === "provider" || event.statusProvenance === "self_reported" || event.statusProvenance === "derived") current.statusProvenance = event.statusProvenance;
			current.stateComplete = event.stateComplete === true;
			current.predicatesProvider = event.predicatesProvider === true;
		}
		if (event.type === "llm_started") current.llm = "running";
		if (event.type === "llm_finished") {
			current.llm = "finished";
			current.llmStatus = enumValue(event.status, STATUSES, "unknown");
			if (event.verdict === "on_track" || event.verdict === "drifting" || event.verdict === "stuck" || event.verdict === "insufficient_evidence") current.llmVerdict = event.verdict;
		}
		if (event.type === "decision") {
			current.source = event.source ?? "unknown";
			current.applied = event.applied ?? "unknown";
			current.outcome = event.outcome ?? "unknown";
		}
		checks.set(key, current);
	}
	for (const check of checks.values()) {
		if (check.evaluation === "evaluating") {
			check.evaluation = "interrupted";
			check.status = "unknown";
			check.reason = "interrupted";
		}
		if (check.llm === "running") check.llm = "interrupted";
		if (check.usage == null) check.usage = "unknown";
	}
	return [...checks.values()];
}
