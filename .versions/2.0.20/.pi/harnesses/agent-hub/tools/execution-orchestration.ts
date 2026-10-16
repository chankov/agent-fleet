import type { ToolContext } from "./context.ts";
import { createDispatchExecutor, createResearchExecutor, type DispatchExecutorDeps } from "./dispatch-execution.ts";
import { createActionExecutors, type ActionExecutorDeps } from "./action-executors.ts";
import { createHerdrExecutors, type HerdrExecutorDeps } from "./herdr-executors.ts";

/** Explicit Phase 6.3 ports to budget/artifact/research, dispatch, policy and fleet owners. */
export interface DispatchExecutionContext {
	dispatch: DispatchExecutorDeps;
	actions: ActionExecutorDeps;
	herdr: HerdrExecutorDeps;
}

/** Build the compatibility ToolContext consumed by the unchanged Phase-3 registrars. */
export function createToolExecutionOrchestration(ctx: DispatchExecutionContext): ToolContext {
	return {
		executeDispatchAgent: createDispatchExecutor(ctx.dispatch),
		executeSpawnResearch: createResearchExecutor(ctx.dispatch),
		...createActionExecutors(ctx.actions),
		...createHerdrExecutors(ctx.herdr),
		getAssertionCount: () => ctx.actions.getAssertions().length,
	};
}
