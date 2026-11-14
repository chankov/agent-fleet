import { randomUUID } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ShadowTrace, ShadowTraceEvent } from "./drift-judge.ts";
import type { System1Result } from "../lib/system1/contracts.ts";
import { TASK_TRIAGE_STATE_VERSION, TASK_TRIAGE_QUESTION_VERSION, TASK_TRIAGE_POLICY_VERSION, TASK_TRIAGE_PROVIDER, TASK_TRIAGE_MODEL, type TaskTriageAssessment } from "./task-triage-contract.ts";

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

export const TASK_TRIAGE_TRACE_SCHEMA = "task-triage-trace/v1";
const TRIAGE_STATUSES = new Set(["applied", "no_additions", "invalid_result", "stale", "incomplete_input", "sensitive_input", "oversized_input", "skipped", "unavailable", "unsupported", "cancelled", "unknown"]);
const TRIAGE_REASONS = new Set([...REASONS, "policy_version", "version_or_provider", "answers", "counter_restore_ambiguous", "reserved_result_unavailable", "session_call_cap", "counter_persistence_failed", "result_persistence_failed", "deadline_or_cancelled", "provider_failure", "no_user_input", "shared_service_disabled", "shared_service_missing_config", "shared_service_missing_key", "shared_service_invalid_config", "shared_service_unavailable"]);
const TRIAGE_SIGNALS = ["security_change", "wide_change", "irreversible_execution"] as const;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export interface TaskTriageTraceIdentity { taskId: string; evaluationId: string; inputRevision: string }
export interface TaskTriageTraceRecord extends TaskTriageTraceIdentity {
 schema: typeof TASK_TRIAGE_TRACE_SCHEMA; consumer: "task-triage"; type: "evaluation_started" | "evaluation_finished";
 sessionId: string; sequence: number; at: number; stateVersion: typeof TASK_TRIAGE_STATE_VERSION;
 questionsVersion: typeof TASK_TRIAGE_QUESTION_VERSION; policyVersion: typeof TASK_TRIAGE_POLICY_VERSION;
 provider: typeof TASK_TRIAGE_PROVIDER; requestedModel: typeof TASK_TRIAGE_MODEL;
 logicalCall: boolean | null; status: string; reason: string; reasons: string[];
 probabilities: Record<string, number> | null; providerStatus: string; returnedModel: string | null;
 attempts: number | null; latencyMs: number | null; usage: { inputTokens: number; outputTokens: number } | null;
}
const triageIdentity = (v: TaskTriageTraceIdentity) => v && typeof v.taskId === "string" && UUID.test(v.taskId)
 && typeof v.evaluationId === "string" && UUID.test(v.evaluationId) && typeof v.inputRevision === "string" && /^[a-f0-9]{64}$/.test(v.inputRevision);
const triageKey = (v: TaskTriageTraceIdentity) => JSON.stringify([v.taskId, v.evaluationId, v.inputRevision]);
const nonnegative = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
function triageProbabilities(value: unknown): Record<string, number> | null {
 if (!isRecord(value)) return null;
 const out: Record<string, number> = {};
 for (const key of TRIAGE_SIGNALS) if (nonnegative(value[key]) && value[key] <= 1) out[key] = value[key];
 return Object.keys(out).length ? out : null;
}
function safeTraceParent(path: string) {
 for (let parent = dirname(path); ; parent = dirname(parent)) {
  try { if (lstatSync(parent).isSymbolicLink()) throw new Error("linked trace directory"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (parent === dirname(parent)) break;
 }
}
/** Separate metadata-only observer. It cannot authorize effects or change runtime counters. */
export function createTaskTriageActivity(options: { directory?: string; sessionId?: string; now?: () => number; write?: (line: string) => void } = {}) {
 const sessionId = randomUUID(), path = options.directory ? join(options.directory, "task-triage-events.jsonl") : null;
 const spans = new Map<string, TaskTriageTraceRecord>();
 const finished = new Set<string>(), events: TaskTriageTraceRecord[] = [];
 let sequence = 0, degraded = false, disposed = false;
 const append = (record: TaskTriageTraceRecord) => {
  events.push(record);
  try {
   if (options.write) options.write(`${JSON.stringify(record)}\n`);
   else if (path) { safeTraceParent(path); secureAppend(path, `${JSON.stringify(record)}\n`); }
  } catch { degraded = true; }
 };
 const terminal = (identity: TaskTriageTraceIdentity, input: { assessment: TaskTriageAssessment; result?: System1Result }) => {
  const key = triageKey(identity), start = spans.get(key);
  if (!start || finished.has(key)) return;
  finished.add(key);
  const metadata = input.result?.status === "ok" ? input.result.evaluation.metadata : undefined;
  append({ ...start, type: "evaluation_finished", sequence: ++sequence, at: (options.now ?? Date.now)(),
   status: enumValue(input.assessment.status, TRIAGE_STATUSES, "unknown"), reason: enumValue(input.assessment.detail, TRIAGE_REASONS, "unknown"),
   reasons: [...new Set((input.assessment.reasons ?? []).filter(r => TRIAGE_SIGNALS.includes(r)))],
   probabilities: triageProbabilities(input.assessment.probabilities),
   providerStatus: enumValue(input.result?.status, STATUSES, "unknown"), returnedModel: metadata?.returnedModel === TASK_TRIAGE_MODEL ? TASK_TRIAGE_MODEL : null,
   attempts: Number.isSafeInteger(metadata?.attempts) && nonnegative(metadata?.attempts) ? metadata.attempts : null,
   latencyMs: nonnegative(metadata?.latencyMs) ? metadata.latencyMs : null, usage: usage(metadata?.usage) });
 };
 return {
  get path() { return path; }, get degraded() { return degraded; },
  live(): { events: TaskTriageTraceRecord[]; degraded: boolean } { return { events: structuredClone(events), degraded }; },
  evaluationStarted(identity: TaskTriageTraceIdentity, logicalCall: boolean | null) {
   if (disposed || !triageIdentity(identity) || spans.has(triageKey(identity))) return;
   if (spans.size >= COMPLETED_LIMIT) { degraded = true; return; }
   const record: TaskTriageTraceRecord = { taskId: identity.taskId, evaluationId: identity.evaluationId, inputRevision: identity.inputRevision,
    schema: TASK_TRIAGE_TRACE_SCHEMA, consumer: "task-triage", type: "evaluation_started", sessionId, sequence: ++sequence, at: (options.now ?? Date.now)(),
    stateVersion: TASK_TRIAGE_STATE_VERSION, questionsVersion: TASK_TRIAGE_QUESTION_VERSION, policyVersion: TASK_TRIAGE_POLICY_VERSION,
    provider: TASK_TRIAGE_PROVIDER, requestedModel: TASK_TRIAGE_MODEL, logicalCall: typeof logicalCall === "boolean" ? logicalCall : null,
    status: "unknown", reason: "unknown", reasons: [], probabilities: null, providerStatus: "unknown", returnedModel: null, attempts: null, latencyMs: null, usage: null };
   spans.set(triageKey(identity), record); append(record);
  },
  evaluationFinished(identity: TaskTriageTraceIdentity, input: { assessment: TaskTriageAssessment; result?: System1Result }) { if (!disposed) terminal(identity, input); },
  dispose() {
   if (disposed) return;
   for (const start of spans.values()) terminal(start, { assessment: { status: "cancelled", reasons: [], detail: "disposed" } });
   disposed = true;
  },
 };
}
export type TaskTriageActivity = ReturnType<typeof createTaskTriageActivity>;
const TRIAGE_TRACE_KEYS = new Set(["taskId", "evaluationId", "inputRevision", "schema", "consumer", "type", "sessionId", "sequence", "at", "stateVersion", "questionsVersion", "policyVersion", "provider", "requestedModel", "logicalCall", "status", "reason", "reasons", "probabilities", "providerStatus", "returnedModel", "attempts", "latencyMs", "usage"]);
/** Validate durable readback as strictly as emission; reject payload extras instead of copying them. */
export function isTaskTriageTraceRecord(value: unknown): value is TaskTriageTraceRecord {
 if (!isRecord(value) || Object.keys(value).length !== TRIAGE_TRACE_KEYS.size || Object.keys(value).some(k => !TRIAGE_TRACE_KEYS.has(k))) return false;
 const v = value as unknown as TaskTriageTraceRecord;
 return triageIdentity(v) && typeof v.sessionId === "string" && UUID.test(v.sessionId) && v.schema === TASK_TRIAGE_TRACE_SCHEMA && v.consumer === "task-triage"
  && ["evaluation_started", "evaluation_finished"].includes(v.type) && Number.isSafeInteger(v.sequence) && v.sequence > 0 && nonnegative(v.at)
  && v.stateVersion === TASK_TRIAGE_STATE_VERSION && v.questionsVersion === TASK_TRIAGE_QUESTION_VERSION && v.policyVersion === TASK_TRIAGE_POLICY_VERSION
  && v.provider === TASK_TRIAGE_PROVIDER && v.requestedModel === TASK_TRIAGE_MODEL && (typeof v.logicalCall === "boolean" || v.logicalCall === null)
  && TRIAGE_STATUSES.has(v.status) && TRIAGE_REASONS.has(v.reason) && Array.isArray(v.reasons) && v.reasons.length <= 3 && v.reasons.every(r => TRIAGE_SIGNALS.includes(r as typeof TRIAGE_SIGNALS[number]))
  && (v.probabilities === null || (isRecord(v.probabilities) && Object.keys(v.probabilities).every(k => TRIAGE_SIGNALS.includes(k as typeof TRIAGE_SIGNALS[number]) && nonnegative(v.probabilities![k]) && v.probabilities![k] <= 1)))
  && STATUSES.has(v.providerStatus) && (v.returnedModel === null || v.returnedModel === TASK_TRIAGE_MODEL)
  && (v.attempts === null || (Number.isSafeInteger(v.attempts) && v.attempts >= 0)) && (v.latencyMs === null || nonnegative(v.latencyMs))
  && (v.usage === null || (isRecord(v.usage) && Object.keys(v.usage).sort().join(",") === "inputTokens,outputTokens" && usage(v.usage) !== null));
}
export function readTaskTriageTrace(path: string, options: { after?: number; limit?: number } = {}) {
 const after = Number.isSafeInteger(options.after) && options.after! >= 0 ? options.after! : 0;
 const limit = Number.isSafeInteger(options.limit) ? Math.min(100, Math.max(1, options.limit!)) : 100;
 let text = "", fd: number | undefined;
 try {
  safeTraceParent(path);
  if (!lstatSync(path).isFile()) throw new Error("trace unavailable");
  fd = openSync(path, constants.O_RDONLY | ((constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0));
  const stat = fstatSync(fd); if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error("trace unavailable");
  text = readFileSync(fd, "utf8");
 } catch (error) { return { events: [] as TaskTriageTraceRecord[], nextOffset: after, invalidRecords: 0, partialTail: false, readError: (error as NodeJS.ErrnoException).code !== "ENOENT", missing: (error as NodeJS.ErrnoException).code === "ENOENT" }; }
 finally { if (fd !== undefined) closeSync(fd); }
 const lines = text.split("\n").slice(0, -1), page = lines.slice(after, after + limit);
 const events: TaskTriageTraceRecord[] = []; let invalidRecords = 0;
 for (const line of page) { try { const value: unknown = JSON.parse(line); if (isTaskTriageTraceRecord(value)) events.push(value); else invalidRecords++; } catch { invalidRecords++; } }
 return { events, nextOffset: after + page.length, invalidRecords, partialTail: !!text && !text.endsWith("\n"), readError: false, missing: false };
}

/** Separate proactive consumer in the existing session activity store; never stores evidence payloads. */
export const PROACTIVE_TRACE_SCHEMA = "proactive-review-trace/v1";
export interface ProactiveTraceRecord {
 readonly schema: typeof PROACTIVE_TRACE_SCHEMA;
 readonly consumer: "proactive-review";
 readonly type: "job_started" | "job_finished" | "evaluation_started" | "evaluation_finished";
 readonly sessionId: string; readonly jobId: string; readonly evaluationId?: string;
 readonly sequence: number; readonly at: number;
 readonly status?: "reviewed" | "not_checked" | "superseded" | "queue_timeout" | "backlog_full" | "session_budget" | "cancelled" | "unavailable" | "no_new_evidence" | "not_instrumented" | "ok";
}
export function createProactiveActivity(options: { directory?: string; sessionId?: string; now?: () => number; write?: (line: string) => void } = {}) {
 const path = options.directory ? join(options.directory, "proactive-events.jsonl") : null;
 const sessionId = randomUUID(); // Never copy a caller-supplied session/task string into metadata.
 const jobs = new Map<string, boolean>();
 const evaluations = new Map<string, boolean>();
 const events: ProactiveTraceRecord[] = [];
 let sequence = 0, degraded = false;
 const append = (type: ProactiveTraceRecord["type"], jobId: string, evaluationId?: string, status?: ProactiveTraceRecord["status"]) => {
  const safe = new Set(["reviewed", "not_checked", "superseded", "queue_timeout", "backlog_full", "session_budget", "cancelled", "unavailable", "no_new_evidence", "not_instrumented", "ok"]);
  const record: ProactiveTraceRecord = { schema: PROACTIVE_TRACE_SCHEMA, consumer: "proactive-review", type, sessionId, jobId, ...(evaluationId ? { evaluationId } : {}), sequence: ++sequence, at: (options.now ?? Date.now)(), ...(status ? { status: safe.has(status) ? status : "unavailable" } : {}) };
  events.push(record); if (events.length > COMPLETED_LIMIT * 4) events.shift();
  try { if (options.write) options.write(`${JSON.stringify(record)}\n`); else if (path) secureAppend(path, `${JSON.stringify(record)}\n`); } catch { degraded = true; }
 };
 const valid = (id: string) => /^[a-f0-9]{64}$/.test(id);
 return {
  get path() { return path; }, get degraded() { return degraded; },
  live() { return events.slice(); },
  jobStarted(id: string) { if (!valid(id) || jobs.has(id)) return; jobs.set(id, false); append("job_started", id); },
  jobFinished(id: string, status: ProactiveTraceRecord["status"]) { if (!jobs.has(id) || jobs.get(id)) return; jobs.set(id, true); append("job_finished", id, undefined, status); },
  evaluationStarted(jobId: string, id: string) { if (!jobs.has(jobId) || jobs.get(jobId) || !valid(id) || evaluations.has(id)) return; evaluations.set(id, false); append("evaluation_started", jobId, id); },
  evaluationFinished(jobId: string, id: string, status: ProactiveTraceRecord["status"]) { if (!evaluations.has(id) || evaluations.get(id)) return; evaluations.set(id, true); append("evaluation_finished", jobId, id, status); },
  dispose() { for (const [id, done] of evaluations) if (!done) { const job = events.find(e => e.evaluationId === id)?.jobId; if (job) this.evaluationFinished(job, id, "cancelled"); } for (const [id, done] of jobs) if (!done) this.jobFinished(id, "cancelled"); jobs.clear(); evaluations.clear(); },
 };
}
/** Crash readback treats open spans as unavailable, never as a passed review. */
export function projectProactiveReadback(events: readonly ProactiveTraceRecord[]) {
 const jobs = new Map<string, { jobId: string; status: string; evaluations: { id: string; status: string }[] }>();
 for (const event of events) {
  if (event.schema !== PROACTIVE_TRACE_SCHEMA || event.consumer !== "proactive-review" || !/^[a-f0-9]{64}$/.test(event.jobId)) continue;
  const job = jobs.get(event.jobId) ?? { jobId: event.jobId, status: "unavailable", evaluations: [] };
  if (event.type === "job_finished") job.status = event.status ?? "unavailable";
  if (event.type === "evaluation_started" && event.evaluationId) job.evaluations.push({ id: event.evaluationId, status: "unavailable" });
  if (event.type === "evaluation_finished" && event.evaluationId) { const slot = job.evaluations.find(e => e.id === event.evaluationId); if (slot) slot.status = event.status ?? "unavailable"; }
  jobs.set(event.jobId, job);
 }
 return [...jobs.values()].slice(-COMPLETED_LIMIT);
}

/** Durable metadata only; incomplete tail and malformed records cannot manufacture completion. */
export function readProactiveTrace(path: string, options: { after?: number; limit?: number } = {}) {
 let text = "";
 try { text = readFileSync(path, "utf8"); } catch { return { events: [] as ProactiveTraceRecord[], nextOffset: options.after ?? 0, invalidRecords: 0, partialTail: false, readError: true }; }
 const lines = text.split("\n").slice(0, -1);
 const after = Math.max(0, options.after ?? 0), page = lines.slice(after, after + Math.min(100, Math.max(1, options.limit ?? 100)));
 const events: ProactiveTraceRecord[] = []; let invalidRecords = 0;
 const types = new Set(["job_started", "job_finished", "evaluation_started", "evaluation_finished"]);
 const statuses = new Set(["reviewed", "not_checked", "superseded", "queue_timeout", "backlog_full", "session_budget", "cancelled", "unavailable", "no_new_evidence", "not_instrumented", "ok"]);
 for (const line of page) {
  try {
   const v: unknown = JSON.parse(line);
   if (!isRecord(v) || Object.keys(v).some(k => !["schema", "consumer", "type", "sessionId", "jobId", "evaluationId", "sequence", "at", "status"].includes(k)) || v.schema !== PROACTIVE_TRACE_SCHEMA || v.consumer !== "proactive-review" || !types.has(v.type as string) || typeof v.sessionId !== "string" || !/^[a-f0-9-]{36}$/.test(v.sessionId) || typeof v.jobId !== "string" || !/^[a-f0-9]{64}$/.test(v.jobId) || (v.evaluationId !== undefined && (typeof v.evaluationId !== "string" || !/^[a-f0-9]{64}$/.test(v.evaluationId))) || !Number.isSafeInteger(v.sequence) || typeof v.at !== "number" || !Number.isFinite(v.at) || (v.status !== undefined && !statuses.has(v.status as string))) { invalidRecords++; continue; }
   events.push(v as unknown as ProactiveTraceRecord);
  } catch { invalidRecords++; }
 }
 return { events, nextOffset: after + page.length, invalidRecords, partialTail: text.length > 0 && !text.endsWith("\n"), readError: false };
}
