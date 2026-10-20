import { randomUUID } from "node:crypto";
import type { PiRunControl, Termination } from "./spawn.ts";

/** Only a valid judge verdict buys the success-path cooldown. */
export const DRIFT_JUDGE_COOLDOWN_MS = 90_000;

export type DriftJudgeOutcome =
	| { status: "verdict"; verdict: string; reason: string }
	| { status: "unavailable" }
	| { status: "cancelled" };

export interface DriftViolation {
	rule: string;
	terminal?: boolean;
	detail: string;
}

export interface DriftStopRecord {
	rule: string;
	detail: string;
	verdict: string;
	reason: string;
}

export interface DriftCheckIdentity {
	readonly dispatchId: string;
	readonly attemptId: string;
	readonly checkId: string;
	readonly snapshotId: string;
	readonly llmAttemptId: string;
	settled: boolean;
}

export interface DriftAttempt {
	readonly dispatchId: string;
	readonly attemptId: string;
	readonly generation: number;
	readonly signal: AbortSignal;
	readonly childSignal: AbortSignal;
	disposed: boolean;
	settled: boolean;
	stop: DriftStopRecord | null;
	stopCheck: DriftCheckIdentity | null;
	advisories: DriftStopRecord[];
	checks: DriftCheckIdentity[];
	unused: DriftJudgeOutcome[];
	control?: PiRunControl;
	dispose(): void;
	markSettled(): void;
	isLive(): boolean;
}

export interface DriftAttemptLifecycle {
	beforePhysicalSpawn(info: { generation: number }): { signal?: AbortSignal } | void;
	afterPhysicalSpawn(info: { generation: number }): void;
}

export interface DriftMonitorLike {
	onToolStart(toolName: string, argStr: string, callId?: string): DriftViolation | null | undefined;
	onToolEnd(toolName: string, isError?: boolean, callId?: string): DriftViolation | null | undefined;
	trail(): string[];
	isSignalCurrent?(violation: DriftViolation): boolean;
}

export interface DriftRuntime {
	readonly attempts: DriftAttempt[];
	readonly fence: { dispose(): void };
	readonly attemptLifecycle: DriftAttemptLifecycle;
	readonly monitor: DriftMonitorLike | null;
	acceptsCallbacks(): boolean;
	bindControl(control: PiRunControl): void;
	escalate(violation: DriftViolation): void;
	outcomeFor(result: { termination?: Termination | null }): {
		driftStop: DriftStopRecord | null;
		driftAdvisories: DriftStopRecord[];
		applied: boolean;
	};
	dispose(): void;
}

export function fenceOperatorCancel(state: object | null | undefined): void {
	// Research workers do not own a drift fence; native specialists may have one.
	try {
		if (state && "driftFence" in state) (state.driftFence as { dispose(): void } | null | undefined)?.dispose();
	} catch { /* a fence must not block the kill */ }
}

/** A terminate request is not an applied stop. Exit precedence stays with the spawn classifier. */
export function reconcileAppliedDriftStop(
	requested: DriftStopRecord | null,
	termination: Termination | null | undefined,
): { applied: boolean; driftStop: DriftStopRecord | null } {
	const applied = termination?.reason === "drift_stop";
	return { applied, driftStop: applied ? requested : null };
}

export function normalizeJudgeOutcome(value: unknown): DriftJudgeOutcome {
	if (!value || typeof value !== "object") return { status: "unavailable" };
	const record = value as { status?: string; verdict?: string; reason?: string };
	if (record.status === "cancelled" || record.status === "unavailable") return { status: record.status };
	if ((record.status === "verdict" || record.status == null) && (record.verdict === "on_track" || record.verdict === "drifting" || record.verdict === "stuck")) {
		return { status: "verdict", verdict: record.verdict, reason: String(record.reason ?? "") };
	}
	return { status: "unavailable" };
}

export function judgeSessionFileName(sessionKey: string): string {
	const safe = sessionKey.replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 180);
	return `drift-judge-${safe || randomUUID()}.json`;
}

export interface DriftShadowLaunch {
	check: DriftCheckIdentity;
	attemptLive: () => boolean;
	violation: DriftViolation;
	signal: AbortSignal;
	trail: string[];
	observation: unknown;
	/** Elapsed since this physical attempt began, captured with the tool observation. */
	elapsedMs?: number;
	retry?: boolean;
	startLlm: () => void;
	onShortcut?: () => void;
}

export interface DriftAppliedAttribution {
	dispatchId: string;
	attemptId: string;
	checkId: string;
	snapshotId: string;
	llmAttemptId: string;
	rule?: string;
	outcome: "continue" | "advisory" | "drift_stop" | "judge_unavailable";
	applied: "yes" | "no";
	source: "llm" | "none" | "system1";
}

export interface DriftRuntimeOptions {
	dispatchId: string;
	agentKey: string;
	agentLabel: string;
	task: string;
	scopeGlobs: string[];
	hubOwnedGlobs: string[];
	armed: boolean;
	ctx: unknown;
	runDriftJudge(input: Record<string, unknown>, ctx: unknown): Promise<unknown>;
	monitor?: DriftMonitorLike | null;
	now?: () => number;
	setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
	clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
	/** Called synchronously before the LLM promise is observed. Must not be awaited. */
	launchShadow?: (input: DriftShadowLaunch) => { onLlmSettled?: (value: unknown) => void; deferLlm?: boolean } | void;
	onDispose?: () => void;
	onOutcome?: (input: { applied: boolean; driftStop: DriftStopRecord | null; advisories: DriftStopRecord[]; attributions: DriftAppliedAttribution[] }) => void;
}

interface Attempt extends DriftAttempt {
	startedAt: number;
	childAbort: AbortController;
	judgeAbort: AbortController;
	busyCheckId: string | null;
	attachControl(control: PiRunControl): void;
	openCheck(): DriftCheckIdentity;
}

function createAttempt(dispatchId: string, generation: number, startedAt: number): Attempt {
	const childAbort = new AbortController();
	const judgeAbort = new AbortController();
	const attempt: Attempt = {
		dispatchId,
		generation,
		startedAt,
		attemptId: randomUUID(),
		disposed: false,
		settled: false,
		stop: null,
		stopCheck: null,
		advisories: [],
		checks: [],
		unused: [],
		busyCheckId: null,
		childAbort,
		judgeAbort,
		get signal() { return judgeAbort.signal; },
		get childSignal() { return childAbort.signal; },
		isLive() { return !attempt.disposed; },
		markSettled() { attempt.settled = true; },
		dispose() {
			if (attempt.disposed) return;
			attempt.disposed = true;
			attempt.control = undefined;
			judgeAbort.abort();
			if (!attempt.settled) childAbort.abort();
		},
		attachControl(control) {
			attempt.control = {
				terminate: (reason) => {
					if (!attempt.isLive()) return;
					control.terminate(reason);
				},
			};
		},
		openCheck() {
			const check: DriftCheckIdentity = {
				dispatchId,
				attemptId: attempt.attemptId,
				checkId: randomUUID(),
				snapshotId: randomUUID(),
				llmAttemptId: randomUUID(),
				settled: false,
			};
			attempt.checks.push(check);
			return check;
		},
	};
	childAbort.signal.addEventListener("abort", () => judgeAbort.abort(), { once: true });
	return attempt;
}

export function createDriftRuntime(options: DriftRuntimeOptions): DriftRuntime {
	const now = options.now ?? Date.now;
	const attempts: Attempt[] = [];
	const open: Attempt[] = [];
	let current: Attempt | null = null;
	let generation = 0;
	let cooldownUntil = 0;
	let operatorFenced = false;
	const queued = new Map<string, DriftViolation>();
	let retry: { attempt: Attempt; violation: DriftViolation } | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;
	const setTimer = options.setTimer ?? ((fn: () => void, delay: number) => { const handle = setTimeout(fn, delay); handle.unref?.(); return handle; });
	const clearTimer = options.clearTimer ?? clearTimeout;
	const clearPending = () => { if (timer) clearTimer(timer); timer = null; retry = null; queued.clear(); };
	const currentSignal = (violation: DriftViolation) => monitor?.isSignalCurrent?.(violation) ?? true;
	const dispatchAdvisories: DriftStopRecord[] = [];
	const attributions: DriftAppliedAttribution[] = [];
	const monitor = options.armed ? (options.monitor ?? null) : null;
	const attribute = (check: DriftCheckIdentity, violation: DriftViolation, outcome: DriftAppliedAttribution["outcome"]) => {
		attributions.push({
			dispatchId: check.dispatchId,
			attemptId: check.attemptId,
			checkId: check.checkId,
			snapshotId: check.snapshotId,
			llmAttemptId: check.llmAttemptId,
			rule: violation.rule,
			outcome,
			applied: "no",
			source: "llm",
		});
	};

	const beginAttempt = (): Attempt => {
		clearPending();
		if (current && !current.disposed) current.dispose();
		const attempt = createAttempt(options.dispatchId, ++generation, now());
		attempts.push(attempt);
		current = attempt;
		// A fence survives the gap before the next physical launch. Do not clear it here.
		if (operatorFenced) attempt.dispose();
		return attempt;
	};
	const disposeAll = () => {
		operatorFenced = true;
		clearPending();
		for (const attempt of attempts) attempt.dispose();
		open.length = 0;
	};
	const schedule = (ms: number) => {
		if (timer) clearTimer(timer);
		timer = setTimer(() => {
			timer = null;
			const attempt = current;
			if (!attempt?.isLive() || !monitor) return;
			if (attempt.busyCheckId) return;
			if (retry) {
				const pending = retry;
				retry = null;
				if (pending.attempt === attempt && currentSignal(pending.violation)) { startCheck(attempt, pending.violation, true); return; }
			}
			if (now() < cooldownUntil) { schedule(cooldownUntil - now()); return; }
			const signals = [...queued.values()].sort((a, b) => Number(b.terminal !== false) - Number(a.terminal !== false));
			queued.clear();
			for (const signal of signals) {
				if (currentSignal(signal)) { startCheck(attempt, signal, false); break; }
			}
		}, Math.max(0, ms));
	};
	const finishJudge = (attempt: Attempt, check: DriftCheckIdentity, violation: DriftViolation, value: unknown, wasRetry: boolean) => {
		if (check.settled) return;
		check.settled = true;
		if (attempt.busyCheckId === check.checkId) attempt.busyCheckId = null;
		const outcome = normalizeJudgeOutcome(value);
		if (!attempt.isLive() || current !== attempt) {
			attempt.unused.push(outcome);
			return;
		}
		if (outcome.status === "cancelled") return;
		// An absent verdict is not an LLM decision to continue.
		if (outcome.status === "unavailable") {
			attribute(check, violation, "judge_unavailable");
			if (!wasRetry && currentSignal(violation)) {
				retry = { attempt, violation };
				schedule(5_000);
			} else if (queued.size) schedule(0);
			return;
		}
		cooldownUntil = now() + DRIFT_JUDGE_COOLDOWN_MS;
		if (timer) { clearTimer(timer); timer = null; }
		if (queued.size && outcome.verdict !== "drifting" && outcome.verdict !== "stuck") schedule(DRIFT_JUDGE_COOLDOWN_MS);
		if (outcome.verdict !== "drifting" && outcome.verdict !== "stuck") {
			attribute(check, violation, "continue");
			return;
		}
		const record: DriftStopRecord = {
			rule: violation.rule,
			detail: violation.detail,
			verdict: outcome.verdict,
			reason: outcome.reason,
		};
		if (violation.terminal === false) {
			attempt.advisories.push(record);
			dispatchAdvisories.push(record);
			attribute(check, violation, "advisory");
			if (queued.size) schedule(DRIFT_JUDGE_COOLDOWN_MS);
			return;
		}
		attempt.stop = record;
		attempt.stopCheck = check;
		attribute(check, violation, "drift_stop");
		if (!attempt.isLive()) return;
		attempt.control?.terminate("drift_stop");
	};

	const startCheck = (attempt: Attempt, violation: DriftViolation, wasRetry: boolean) => {
			if (!monitor || !attempt.isLive() || attempt.busyCheckId || attempt.stop) return;
			const check = attempt.openCheck();
			attempt.busyCheckId = check.checkId;
			const trail = monitor.trail().slice();
			const observation = snapshotObservation(monitor);
			const elapsedMs = Math.max(0, now() - attempt.startedAt);
			let started = false;
			const settled = { onLlmSettled: undefined as ((value: unknown) => void) | undefined };
			const startLlm = () => {
				if (started) return;
				started = true;
				void options.runDriftJudge({
					agentLabel: options.agentLabel,
					agentKey: options.agentKey,
					task: options.task,
					scopeGlobs: options.scopeGlobs,
					hubOwnedGlobs: options.hubOwnedGlobs,
					trail,
					violation,
					signal: attempt.signal,
					sessionKey: `${attempt.attemptId}-${check.llmAttemptId}`,
					dispatchId: attempt.dispatchId,
					attemptId: attempt.attemptId,
					checkId: check.checkId,
					snapshotId: check.snapshotId,
					llmAttemptId: check.llmAttemptId,
				}, options.ctx).then(value => {
					finishJudge(attempt, check, violation, value, wasRetry);
					try { settled.onLlmSettled?.(value); } catch { /* trace must not change the judge outcome */ }
				}).catch(() => {
					finishJudge(attempt, check, violation, { status: "unavailable" }, wasRetry);
					try { settled.onLlmSettled?.({ status: "unavailable" }); } catch { /* trace must not change the judge outcome */ }
				});
			};
			let deferLlm = false;
			try {
				const hooks = options.launchShadow?.({
					check,
					attemptLive: () => attempt.isLive() && current === attempt,
					violation,
					signal: attempt.signal,
					trail,
					observation,
					elapsedMs,
					retry: wasRetry,
					startLlm,
					onShortcut: () => {
						if (check.settled || !attempt.isLive() || current !== attempt || attempt.busyCheckId !== check.checkId) return;
						check.settled = true;
						attempt.busyCheckId = null;
						cooldownUntil = now() + DRIFT_JUDGE_COOLDOWN_MS;
						if (queued.size) schedule(DRIFT_JUDGE_COOLDOWN_MS);
						attributions.push({ dispatchId: check.dispatchId, attemptId: check.attemptId, checkId: check.checkId,
							snapshotId: check.snapshotId, llmAttemptId: check.llmAttemptId, rule: violation.rule, source: "system1", outcome: "continue", applied: "no" });
					},
				});
				if (hooks && hooks.onLlmSettled) settled.onLlmSettled = hooks.onLlmSettled;
				deferLlm = !!hooks && hooks.deferLlm === true;
			} catch {
				/* a shadow observer must not block the authoritative LLM */
			}
			if (!started && !deferLlm) startLlm();
	};

	return {
		attempts,
		monitor,
		fence: { dispose: disposeAll },
		attemptLifecycle: {
			beforePhysicalSpawn() {
				const attempt = beginAttempt();
				open.push(attempt);
				return { signal: attempt.childSignal };
			},
			afterPhysicalSpawn() {
				const attempt = open.pop() ?? current;
				attempt?.markSettled();
				attempt?.dispose();
			},
		},
		acceptsCallbacks() {
			return current?.isLive() === true;
		},
		bindControl(control) {
			if (!current?.isLive()) return;
			current.attachControl(control);
		},
		escalate(violation) {
			const attempt = current;
			if (!monitor || !attempt?.isLive() || attempt.stop) return;
			if (attempt.busyCheckId || now() < cooldownUntil || retry) {
				queued.set(violation.rule, violation);
				if (!attempt.busyCheckId && !retry) schedule(cooldownUntil - now());
				return;
			}
			startCheck(attempt, violation, false);
		},
		outcomeFor(result) {
			const reconciled = reconcileAppliedDriftStop(current?.stop ?? null, result.termination);
			const driftAdvisories = dispatchAdvisories.slice();
			const stopCheckId = reconciled.applied ? current?.stopCheck?.checkId : undefined;
			const payload = attributions.map((item) => ({
				...item,
				applied: item.outcome === "drift_stop" && item.checkId === stopCheckId && item.attemptId === current?.attemptId ? "yes" as const : "no" as const,
			}));
			const seen = new Set(payload.map((item) => `${item.attemptId}:${item.checkId}`));
			if (current && !reconciled.applied) {
				for (const check of current.checks) {
					if (seen.has(`${check.attemptId}:${check.checkId}`)) continue;
					payload.push({
						dispatchId: check.dispatchId,
						attemptId: check.attemptId,
						checkId: check.checkId,
						snapshotId: check.snapshotId,
						llmAttemptId: check.llmAttemptId,
						outcome: "continue",
						applied: "no",
						source: "none",
					});
				}
			}
			const outcome = {
				driftStop: reconciled.driftStop,
				driftAdvisories,
				applied: reconciled.applied,
			};
			try { options.onOutcome?.({ applied: outcome.applied, driftStop: outcome.driftStop, advisories: outcome.driftAdvisories, attributions: payload }); } catch { /* trace must not change applied attribution */ }
			return outcome;
		},
		dispose() {
			disposeAll();
			try { options.onDispose?.(); } catch { /* disposal must still fence the attempt */ }
		},
	};
}

function snapshotObservation(monitor: DriftMonitorLike): unknown {
	const read = (monitor as DriftMonitorLike & { structuredObservation?: () => unknown }).structuredObservation;
	if (typeof read !== "function") return undefined;
	try {
		return JSON.parse(JSON.stringify(read())) as unknown;
	} catch {
		return undefined;
	}
}
