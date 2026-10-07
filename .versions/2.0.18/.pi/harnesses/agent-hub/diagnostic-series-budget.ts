import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export const COMPLETION_SERIES_BUDGET_SCHEMA = "agent-fleet.completion-series-budget/v2" as const;
export const COMPLETION_SERIES_BUDGET_V1_SCHEMA = "agent-fleet.completion-series-budget/v1" as const;
export const COMPLETION_SERIES_LOCK_SCHEMA = "agent-fleet.completion-series-lock/v1" as const;
export type CompletionSeriesStage = "diagnostic" | "benchmark";

export interface CompletionSeriesLimits {
	seriesRequestLimit: 60;
	stageRequestLimits: { diagnostic: 12; benchmark: 48 };
	inputTokensPerRequest: 16384;
	outputTokensPerRequest: 2048;
	requestTimeoutMs: 180000;
	maxActiveRequests: 1;
	maxRequestsPerUnit: { diagnostic: 2; benchmark: 4 };
	autoRetry: false;
	fallback: false;
}
export interface CompletionReservation {
	sequence: number; stage: CompletionSeriesStage; startedAt: string;
}
export interface CompletionSeriesState {
	schema: typeof COMPLETION_SERIES_BUDGET_SCHEMA;
	seriesId: string;
	seriesRequestsStarted: number;
	stages: { diagnostic: { requestsStarted: number }; benchmark: { requestsStarted: number } };
	reservationHistory: CompletionReservation[];
	cancelled: boolean;
	limits: CompletionSeriesLimits;
}
export interface CompletionSeriesLock {
	schema: typeof COMPLETION_SERIES_LOCK_SCHEMA; ownerId: string; pid: number; acquiredAt: string;
}
export interface CountingProvenance {
	method: "serialized-provider-payload-utf8-bytes-times-2-plus-1024/v1";
	count: number; serializedBytes: number; multiplier: 2; reservedTokens: 1024;
	unit: "conservative-token-upper-bound"; cap: number; textOnly: true;
}

export class CompletionBudgetRefusal extends Error {
	readonly reason: "cancelled" | "series-exhausted" | "stage-exhausted" | "probe-exhausted" | "lock-not-owned";
	constructor(reason: CompletionBudgetRefusal["reason"], message: string) { super(message); this.name = "CompletionBudgetRefusal"; this.reason = reason; }
}
export class CompletionSeriesBusyError extends Error { constructor(message = "completion series is busy in another process") { super(message); this.name = "CompletionSeriesBusyError"; } }

export const T12_SERIES_LIMITS: CompletionSeriesLimits = Object.freeze({
	seriesRequestLimit: 60,
	stageRequestLimits: Object.freeze({ diagnostic: 12, benchmark: 48 }),
	inputTokensPerRequest: 16384,
	outputTokensPerRequest: 2048,
	requestTimeoutMs: 180_000,
	maxActiveRequests: 1,
	maxRequestsPerUnit: Object.freeze({ diagnostic: 2, benchmark: 4 }),
	autoRetry: false,
	fallback: false,
});

export function sharedCompletionSeriesBudgetPath(sessionDir: string, seriesId: string): string {
	if (!/^[A-Za-z0-9._-]{1,80}$/.test(seriesId)) throw new Error("invalid completion series identity");
	const sessionsDir = dirname(sessionDir);
	if (basename(sessionsDir) !== "sessions") throw new Error("managed session path is not under the runtime sessions directory");
	return join(dirname(sessionsDir), "series", `${seriesId}-budget.json`);
}
export function completionSeriesLockPath(budgetPath: string): string { return `${budgetPath}.lock`; }
export function createCompletionSeriesState(seriesId: string, limits: CompletionSeriesLimits = T12_SERIES_LIMITS): CompletionSeriesState {
	if (!seriesId.trim()) throw new Error("seriesId is required");
	return { schema: COMPLETION_SERIES_BUDGET_SCHEMA, seriesId, seriesRequestsStarted: 0, stages: { diagnostic: { requestsStarted: 0 }, benchmark: { requestsStarted: 0 } }, reservationHistory: [], cancelled: false, limits: structuredClone(limits) };
}
function isStage(value: unknown): value is CompletionSeriesStage { return value === "diagnostic" || value === "benchmark"; }
function safeCount(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0; }
function validateV2(value: any): CompletionSeriesState {
	if (value?.schema !== COMPLETION_SERIES_BUDGET_SCHEMA || typeof value.seriesId !== "string" || !safeCount(value.seriesRequestsStarted)
		|| !safeCount(value?.stages?.diagnostic?.requestsStarted) || !safeCount(value?.stages?.benchmark?.requestsStarted)
		|| !Array.isArray(value.reservationHistory) || typeof value.cancelled !== "boolean") throw new Error("invalid completion-series budget state");
	if (value.stages.diagnostic.requestsStarted + value.stages.benchmark.requestsStarted !== value.seriesRequestsStarted) throw new Error("completion-series counters do not reconcile");
	if (value.reservationHistory.length !== value.seriesRequestsStarted || value.reservationHistory.some((entry: any, index: number) => entry?.sequence !== index + 1 || !isStage(entry?.stage) || typeof entry?.startedAt !== "string")) throw new Error("completion-series reservation history does not reconcile");
	return value;
}
export function readCompletionSeriesState(path: string): CompletionSeriesState {
	return validateV2(JSON.parse(readFileSync(path, "utf8")));
}

/**
 * Migrate only when every consumed request has explicit stage provenance.
 * Old zero-use ledgers are unambiguous; nonzero aggregate-only v1 ledgers fail closed.
 */
export function migrateCompletionSeriesBudget(path: string): CompletionSeriesState {
	const raw = JSON.parse(readFileSync(path, "utf8"));
	if (raw?.schema === COMPLETION_SERIES_BUDGET_SCHEMA) return validateV2(raw);
	if (raw?.schema !== COMPLETION_SERIES_BUDGET_V1_SCHEMA || typeof raw.seriesId !== "string" || !safeCount(raw.seriesRequestsStarted) || !safeCount(raw.stageRequestsStarted)) throw new Error("invalid completion-series budget state");
	const history = Array.isArray(raw.reservationHistory) ? raw.reservationHistory : [];
	if (raw.seriesRequestsStarted !== raw.stageRequestsStarted) throw new Error("ambiguous v1 completion-series allocation; refusing migration");
	if (raw.seriesRequestsStarted > 0 && (history.length !== raw.seriesRequestsStarted || history.some((entry: any) => !isStage(entry?.stage) || typeof entry?.startedAt !== "string"))) throw new Error("ambiguous v1 completion-series allocation; refusing migration");
	const migrated = createCompletionSeriesState(raw.seriesId);
	migrated.cancelled = raw.cancelled === true;
	for (const [index, entry] of history.entries()) {
		const stage = entry.stage as CompletionSeriesStage;
		migrated.seriesRequestsStarted++;
		migrated.stages[stage].requestsStarted++;
		migrated.reservationHistory.push({ sequence: index + 1, stage, startedAt: entry.startedAt });
	}
	writeCompletionSeriesState(path, migrated);
	return migrated;
}

/** Crash-safe replacement: a provider request is sent only after this durable rename completes. */
export function writeCompletionSeriesState(path: string, state: CompletionSeriesState): void {
	const validated = validateV2(state);
	const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
	let fd: number | undefined;
	try {
		fd = openSync(temporary, "wx", 0o600);
		writeSync(fd, JSON.stringify(validated, null, 2)); fsyncSync(fd); closeSync(fd); fd = undefined;
		renameSync(temporary, path);
		try { const dirFd = openSync(dirname(path), "r"); try { fsyncSync(dirFd); } finally { closeSync(dirFd); } } catch {}
	} finally { if (fd !== undefined) closeSync(fd); try { unlinkSync(temporary); } catch {} }
}

export function acquireCompletionSeriesLock(lockPath: string, ownerId = randomUUID()): CompletionSeriesLock {
	const lock: CompletionSeriesLock = { schema: COMPLETION_SERIES_LOCK_SCHEMA, ownerId, pid: process.pid, acquiredAt: new Date().toISOString() };
	let fd: number;
	try { fd = openSync(lockPath, "wx", 0o600); }
	catch (error: any) { if (error?.code === "EEXIST") throw new CompletionSeriesBusyError(); throw error; }
	try { writeSync(fd, JSON.stringify(lock)); fsyncSync(fd); } catch (error) { try { unlinkSync(lockPath); } catch {} throw error; } finally { closeSync(fd); }
	return lock;
}
export function readCompletionSeriesLock(lockPath: string): CompletionSeriesLock | null {
	try { const value = JSON.parse(readFileSync(lockPath, "utf8")); return value?.schema === COMPLETION_SERIES_LOCK_SCHEMA && typeof value.ownerId === "string" && Number.isSafeInteger(value.pid) ? value : null; }
	catch { return null; }
}
export function releaseOwnedCompletionSeriesLock(lockPath: string, ownerId: string): void {
	const lock = readCompletionSeriesLock(lockPath);
	if (!lock || lock.ownerId !== ownerId) throw new Error("completion-series lock ownership changed; refusing release");
	unlinkSync(lockPath);
}
function processAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (error: any) { return error?.code !== "ESRCH"; } }
/** Human-only crash recovery. Never expires automatically and never releases a live owner. */
export function releaseCrashedCompletionSeriesLock(lockPath: string): "released" | "absent" {
	if (!existsSync(lockPath)) return "absent";
	const lock = readCompletionSeriesLock(lockPath);
	if (lock && processAlive(lock.pid)) throw new CompletionSeriesBusyError(`completion series is owned by live pid ${lock.pid}`);
	unlinkSync(lockPath); return "released";
}
function assertLockOwner(lockPath: string, ownerId: string): void {
	const lock = readCompletionSeriesLock(lockPath);
	if (!lock || lock.ownerId !== ownerId) throw new CompletionBudgetRefusal("lock-not-owned", "completion-series lock is not owned by this run");
}

/** Reserve durably immediately before provider transport. Failed started completions remain charged. */
export function reserveCompletionRequest(path: string, unitRequestsStarted: number, lockPath: string, ownerId: string, stage: CompletionSeriesStage): CompletionSeriesState {
	assertLockOwner(lockPath, ownerId);
	const state = readCompletionSeriesState(path);
	if (state.cancelled) throw new CompletionBudgetRefusal("cancelled", "completion series is fenced after cancellation");
	if (state.seriesRequestsStarted >= state.limits.seriesRequestLimit) throw new CompletionBudgetRefusal("series-exhausted", "whole-series provider request budget exhausted");
	if (state.stages[stage].requestsStarted >= state.limits.stageRequestLimits[stage]) throw new CompletionBudgetRefusal("stage-exhausted", `${stage}-stage provider request budget exhausted`);
	if (unitRequestsStarted >= state.limits.maxRequestsPerUnit[stage]) throw new CompletionBudgetRefusal("probe-exhausted", `${stage} unit provider request budget exhausted`);
	const next = structuredClone(state);
	next.seriesRequestsStarted++;
	next.stages[stage].requestsStarted++;
	next.reservationHistory.push({ sequence: next.seriesRequestsStarted, stage, startedAt: new Date().toISOString() });
	writeCompletionSeriesState(path, next); return next;
}
export function fenceCompletionSeries(path: string, lockPath: string, ownerId: string): CompletionSeriesState {
	assertLockOwner(lockPath, ownerId);
	const state = readCompletionSeriesState(path), next = { ...state, cancelled: true };
	writeCompletionSeriesState(path, next); return next;
}
export function conservativeTextInputPreflight(payload: unknown, cap: number): CountingProvenance {
	const serialized = JSON.stringify(payload);
	if (serialized === undefined) throw new Error("provider payload cannot be serialized for input preflight");
	const serializedBytes = Buffer.byteLength(serialized, "utf8");
	const count = serializedBytes * 2 + 1024;
	const provenance: CountingProvenance = { method: "serialized-provider-payload-utf8-bytes-times-2-plus-1024/v1", count, serializedBytes, multiplier: 2, reservedTokens: 1024, unit: "conservative-token-upper-bound", cap, textOnly: true };
	if (count > cap) throw new Error(`provider payload conservative upper bound ${count} exceeds ${cap} input-token cap`);
	return provenance;
}
