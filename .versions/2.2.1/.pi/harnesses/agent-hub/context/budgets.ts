import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	DEFAULT_TASK_TIER, budgetStatusLine, closeTaskClock, resetTaskClock, resolveTurnBudget, taskClockElapsedMs,
} from "../run-budget.js";
import { buildHubAuditIdentity, buildTaskResetAudit } from "../hub-state-audit.js";
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

export interface BudgetStatePorts {
	getBudgetOverrides(): Record<string, number | null | undefined>;
	getTurnDispatchCount(): number;
	setTurnDispatchCount(value: number): void;
	getTurnResearchCount(): number;
	setTurnResearchCount(value: number): void;
	resetNoProgress(persistTaskIdentity?: boolean): void;
	resetUnknownToolCounter(): void;
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
	resolveIncomingCapabilities(acceptedUserInput?: string): void;
	applyWorkModeTools(): void;
	getTurnReport(): TurnReport;
	setStatus(key: string, value: string): void;
	getAuditContext(): { cwd?: string; sessionId?: string; project?: string };
	appendEntry(type: string, data: unknown): void;
	executionHistory: ExecutionHistoryStore;
}

export interface BudgetContext {
	/** Tier-owned child deadline, session recycling and delegation; no quotas. */
	currentBudget(): ReturnType<typeof resolveTurnBudget>;
	taskCounters(): { dispatches: number; research: number };
	taskActiveElapsedMs(now?: number): number;
	closeTurnActiveTime(now?: number): void;
	resetTaskWindow(label?: string | null, now?: number, persistTaskIdentity?: boolean, acceptedUserInput?: string): void;
	hubAuditIdentity(ctx?: ExtensionContext): ReturnType<typeof buildHubAuditIdentity>;
	hubLocationSuffix(ctx?: ExtensionContext): string;
	taskResetSnapshot(now?: number): { tier: string | null; dispatches: number; research: number; reviewRounds: number; activeMs: number };
	appendTaskResetEntry(source: "tool:set_task_tier", label: string | null, prior: ReturnType<BudgetContext["taskResetSnapshot"]>, ctx?: ExtensionContext): void;
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
	const taskCounters = () => ({ dispatches: state.getTaskDispatchCount(), research: state.getTaskResearchCount() });
	const taskActiveElapsedMs = (now = Date.now()) => taskClockElapsedMs(state.getTaskClock(), now, state.executionHistory.openAskUserWaitMs(now));
	const updateModeStatus = () => {
		const tier = state.getTaskTier();
		const shownTier = tier && state.getTaskTierAssumed() ? `${tier}?` : (tier ?? DEFAULT_TASK_TIER);
		try {
			state.setStatus("hub-tier", budgetStatusLine(
				{ dispatches: state.getTurnDispatchCount(), research: state.getTurnResearchCount() }, shownTier, taskCounters(),
			));
		} catch {}
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
		currentBudget, taskCounters, taskActiveElapsedMs,
		closeTurnActiveTime(now = Date.now()) { state.setTaskClock(closeTaskClock(state.getTaskClock(), now)); },
		resetTaskWindow(label = null, now = Date.now(), persistTaskIdentity = true, acceptedUserInput = "") {
			state.setTaskDispatchCount(0);
			state.setTaskResearchCount(0);
			state.setTaskClock(resetTaskClock(state.getTaskClock(), now));
			state.setTaskReviewRounds(0);
			state.resetNoProgress(persistTaskIdentity);
			state.resetUnknownToolCounter();
			state.setTaskLabel(label);
			state.setTaskTier(null);
			state.setTaskTierAssumed(false);
			state.clearTaskCapabilities();
			state.clearExternalBlockers();
			state.clearTurnDispatchFingerprints();
			// Authorized task changes may rebind the current user request after old
			// packs/confirmations were cleared. Startup/resume supplies no input.
			state.resolveIncomingCapabilities(acceptedUserInput);
			state.applyWorkModeTools();
			updateModeStatus();
		},
		hubAuditIdentity,
		hubLocationSuffix(ctx) {
			const where = hubAuditIdentity(ctx);
			return `\nRepository: ${where.cwd ?? "unknown"}${where.herdr_pane_id ? ` · pane ${where.herdr_pane_id}` : ""}`;
		},
		taskResetSnapshot,
		appendTaskResetEntry(source, label, prior, ctx) {
			try { state.appendEntry("agent-hub-task-reset", buildTaskResetAudit({ source, label, prior, identity: hubAuditIdentity(ctx) })); } catch {}
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
