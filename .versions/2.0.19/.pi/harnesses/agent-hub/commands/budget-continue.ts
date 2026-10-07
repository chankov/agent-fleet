import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { CommandContext } from "./context.ts";

/** Human command only: reopens a declined question, never grants a budget itself. */
export function registerBudgetContinue(pi: ExtensionAPI, commandCtx: CommandContext): void {
	pi.registerCommand("af-budget-continue", {
		description: "Request human budget confirmation again after stopping; never auto-renews or dispatches.",
		handler: async (_args, ctx) => commandCtx.handleBudgetContinue(ctx),
	});
}
