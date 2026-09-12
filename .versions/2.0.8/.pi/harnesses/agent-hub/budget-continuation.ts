import { turnActiveMs } from "./run-budget.js";

export type BudgetContinuationKind = "turn" | "task";

/** Active turn-budget time excludes both completed and currently-open asks. */
export function turnBudgetActiveMs(
	turnStartedAt: number,
	now: number,
	completedAskWaitMs = 0,
	openAskWaitMs = 0,
): number {
	return turnActiveMs(turnStartedAt, now, Math.max(0, completedAskWaitMs) + Math.max(0, openAskWaitMs));
}
