import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { CommandContext } from "./context.ts";

export function registerTaskTriageWaiver(pi: ExtensionAPI, commandCtx: CommandContext): void {
	pi.registerCommand("af-task-triage-waive", {
		description: "Request a human-authorized, source-scoped task-triage waiver: <additionId> <reason>",
		handler: async (args, ctx) => {
			const applied = await commandCtx.handleTaskTriageWaive(args, ctx);
			ctx.ui.notify(applied ? "Exact addition waived; baseline and other additions remain." : "Waiver denied, stale or could not persist.", applied ? "info" : "warning");
		},
	});
}
