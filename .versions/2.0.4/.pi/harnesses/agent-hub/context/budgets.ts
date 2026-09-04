import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	DEFAULT_TASK_TIER, budgetStatusLine, closeTaskClock, resetTaskClock,
	resolveTaskBudget, resolveTurnBudget, taskClockElapsedMs,
} from "../run-budget.js";
import { buildBudgetContinuationAudit, buildHubAuditIdentity, buildTaskResetAudit } from "../hub-state-audit.js";
import { turnBudgetActiveMs, type BudgetContinuationKind } from "../budget-continuation.ts";
import type { ExecutionHistoryStore } from "../ui/history-store.ts";

export interface TurnReport {
	startedAt: number;
	tier: string | null;
	dispatches: { agent: string; status: string; elapsed: number; billed: number; out: number }[];
	research: number;
	recycles: number;
	driftStops: number;
	refusals: number;
}

export interface SessionTotals {
	turns: number;
	dispatches: number;
	research: number;
	recycles: number;
	driftStops: number;
	refusals: number;
	billed: number;
	out: number;
}

export interface PendingBudgetContinuation {
	kind: BudgetContinuationKind;
	reason: string;
}

export interface BudgetStatePorts {
	getBudgetOverrides(): Record<string, number | null | undefined>;
	getTurnDispatchCount(): number;
	setTurnDispatchCount(value: number): void;
	getTurnResearchCount(): number;
	setTurnResearchCount(value: number): void;
	getTurnBudgetAskUserWaitMs(): number;
	setTurnBudgetAskUserWaitMs(value: number): void;
	setPendingBudgetContinuation(value: PendingBudgetContinuation | null): void;
	clearBudgetContinuationAsks(): void;
	getTaskContinuationCount(): number;
	setTaskContinuationCount(value: number): void;
	getTurnContinuationCount(): number;
	setTurnContinuationCount(value: number): void;
	getTaskDispatchCount(): number;
	setTaskDispatchCount(value: number): void;
	getTaskResearchCount(): number;
	setTaskResearchCount(value: number): void;
	getTaskLabel(): string | null;
	setTaskLabel(value: string | null): void;
	getTaskClock(): ReturnType<typeof import("../run-budget.js").createTaskClock>;
	setTaskClock(value: ReturnType<typeof import("../run-budget.js").createTaskClock>): void;
	getTaskReviewRounds(): number;
	setTaskReviewRounds(value: number): void;
	getTaskTier(): string | null;
	setTaskTier(value: string | null): void;
	getTaskTierAssumed(): boolean;
	setTaskTierAssumed(value: boolean): void;
	clearTurnDispatchFingerprints(): void;
	clearTaskCapabilities(): void;
	clearExternalBlockers(): void;
	resolveIncomingCapabilities(): void;
	applyWorkModeTools(): void;
	getTurnReport(): TurnReport;
	setStatus(key: string, value: string): void;
	getAuditContext(): { cwd?: string; sessionId?: string; project?: string };
	appendEntry(type: string, data: unknown): void;
	executionHistory: ExecutionHistoryStore;
}

export interface BudgetContext {
	currentBudget(): ReturnType<typeof resolveTurnBudget>;
	currentTaskBudget(): ReturnType<typeof resolveTaskBudget>;
	taskCounters(): { dispatches: number; research: number };
	taskActiveElapsedMs(now?: number): number;
	turnBudgetActiveElapsedMs(now?: number): number;
	armBudgetContinuation(kind: BudgetContinuationKind, reason: string): void;
	renewTurnBudgetWindow(now?: number): void;
	continueTaskBudgetWindow(now?: number): void;
	closeTurnActiveTime(now?: number): void;
	resetTaskWindow(label?: string | null, now?: number): void;
	hubAuditIdentity(ctx?: ExtensionContext): ReturnType<typeof buildHubAuditIdentity>;
	hubLocationSuffix(ctx?: ExtensionContext): string;
	taskResetSnapshot(now?: number): { tier: string | null; dispatches: number; research: number; reviewRounds: number; activeMs: number };
	budgetContinuationSnapshot(kind: BudgetContinuationKind, now?: number): ReturnType<BudgetContext["taskResetSnapshot"]>;
	appendTaskResetEntry(source: "tool:set_task_tier", label: string | null, prior: ReturnType<BudgetContext["taskResetSnapshot"]>, ctx?: ExtensionContext): void;
	appendBudgetContinuationEntry(kind: BudgetContinuationKind, reason: string, prior: ReturnType<BudgetContext["taskResetSnapshot"]>, ctx?: ExtensionContext): void;
	updateModeStatus(): void;
	ensureTaskTier(): void;
}

export function freshTurnReport(now = Date.now()): TurnReport {
	return { startedAt: now, tier: null, dispatches: [], research: 0, recycles: 0, driftStops: 0, refusals: 0 };
}

export function createSessionTotals(): SessionTotals {
	return { turns: 0, dispatches: 0, research: 0, recycles: 0, driftStops: 0, refusals: 0, billed: 0, out: 0 };
}

export function createBudgetContext(state: BudgetStatePorts): BudgetContext {
	const currentBudget = () => resolveTurnBudget(state.getTaskTier() ?? DEFAULT_TASK_TIER, state.getBudgetOverrides());
	const currentTaskBudget = () => resolveTaskBudget(currentBudget());
	const taskCounters = () => ({ dispatches: state.getTaskDispatchCount(), research: state.getTaskResearchCount() });
	const taskActiveElapsedMs = (now = Date.now()) => taskClockElapsedMs(state.getTaskClock(), now, state.executionHistory.openAskUserWaitMs(now));
	const turnBudgetActiveElapsedMs = (now = Date.now()) => turnBudgetActiveMs(
		state.executionHistory.turnStartedAt(), now, state.getTurnBudgetAskUserWaitMs(), state.executionHistory.openAskUserWaitMs(now),
	);
	const updateModeStatus = () => {
		const tier = state.getTaskTier();
		const shownTier = tier && state.getTaskTierAssumed() ? `${tier}?` : (tier ?? DEFAULT_TASK_TIER);
		try {
			state.setStatus("hub-tier", budgetStatusLine(
				{ dispatches: state.getTurnDispatchCount(), research: state.getTurnResearchCount() },
				currentBudget(), shownTier, { counters: taskCounters(), budget: currentTaskBudget() },
			));
		} catch {}
	};
	const renewTurnBudgetWindow = (now = Date.now()) => {
		state.setTurnDispatchCount(0);
		state.setTurnResearchCount(0);
		state.executionHistory.renewTurnStartedAt(now);
		state.setTurnBudgetAskUserWaitMs(0);
		state.clearTurnDispatchFingerprints();
		state.setTurnContinuationCount(state.getTurnContinuationCount() + 1);
		updateModeStatus();
	};
	const taskResetSnapshot = (now = Date.now()) => ({
		tier: state.getTaskTier(), dispatches: state.getTaskDispatchCount(), research: state.getTaskResearchCount(),
		reviewRounds: state.getTaskReviewRounds(), activeMs: taskActiveElapsedMs(now),
	});
	const hubAuditIdentity = (ctx?: ExtensionContext) => {
		const audit = state.getAuditContext();
		return buildHubAuditIdentity({
			cwd: ctx?.cwd ?? audit.cwd ?? process.cwd(), pid: process.pid,
			sessionId: audit.sessionId, project: audit.project,
			workspaceId: process.env.HERDR_WORKSPACE_ID, paneId: process.env.HERDR_PANE_ID,
		});
	};

	return {
		currentBudget, currentTaskBudget, taskCounters, taskActiveElapsedMs, turnBudgetActiveElapsedMs,
		armBudgetContinuation(kind, reason) { state.setPendingBudgetContinuation({ kind, reason }); },
		renewTurnBudgetWindow,
		continueTaskBudgetWindow(now = Date.now()) {
			state.setTaskDispatchCount(0);
			state.setTaskResearchCount(0);
			state.setTaskClock(resetTaskClock(state.getTaskClock(), now));
			state.setTaskReviewRounds(0);
			state.setTaskContinuationCount(state.getTaskContinuationCount() + 1);
			renewTurnBudgetWindow(now);
		},
		closeTurnActiveTime(now = Date.now()) { state.setTaskClock(closeTaskClock(state.getTaskClock(), now)); },
		resetTaskWindow(label = null, now = Date.now()) {
			state.setTaskDispatchCount(0);
			state.setTaskResearchCount(0);
			state.setTaskClock(resetTaskClock(state.getTaskClock(), now));
			state.setTaskReviewRounds(0);
			state.setTaskContinuationCount(0);
			state.setPendingBudgetContinuation(null);
			state.clearBudgetContinuationAsks();
			state.setTaskLabel(label);
			state.setTaskTier(null);
			state.setTaskTierAssumed(false);
			state.clearTaskCapabilities();
			state.clearExternalBlockers();
			state.clearTurnDispatchFingerprints();
			state.resolveIncomingCapabilities();
			state.applyWorkModeTools();
			updateModeStatus();
		},
		hubAuditIdentity,
		hubLocationSuffix(ctx) {
			const where = hubAuditIdentity(ctx);
			return `\nRepository: ${where.cwd ?? "unknown"}${where.herdr_pane_id ? ` · pane ${where.herdr_pane_id}` : ""}`;
		},
		taskResetSnapshot,
		budgetContinuationSnapshot(kind, now = Date.now()) {
			return kind === "task" ? taskResetSnapshot(now) : {
				tier: state.getTaskTier(), dispatches: state.getTurnDispatchCount(), research: state.getTurnResearchCount(),
				reviewRounds: 0, activeMs: turnBudgetActiveElapsedMs(now),
			};
		},
		appendTaskResetEntry(source, label, prior, ctx) {
			try { state.appendEntry("agent-hub-task-reset", buildTaskResetAudit({ source, label, prior, identity: hubAuditIdentity(ctx) })); } catch {}
		},
		appendBudgetContinuationEntry(kind, reason, prior, ctx) {
			try {
				state.appendEntry("agent-hub-budget-continuation", buildBudgetContinuationAudit({
					kind, continuation: kind === "task" ? state.getTaskContinuationCount() : state.getTurnContinuationCount(),
					reason, prior, identity: hubAuditIdentity(ctx),
				}));
			} catch {}
		},
		updateModeStatus,
		ensureTaskTier() {
			if (state.getTaskTier() !== null) return;
			state.setTaskTier(DEFAULT_TASK_TIER);
			state.setTaskTierAssumed(true);
			state.getTurnReport().tier = DEFAULT_TASK_TIER;
			updateModeStatus();
		},
	};
}
