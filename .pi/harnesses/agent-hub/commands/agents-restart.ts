import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { CommandContext } from "./context.ts";

export function registerAgentsRestart(pi: ExtensionAPI, commandCtx: CommandContext): void {
	pi.registerCommand("af-agents-restart", {
		description: "Kill and re-run a specialist's (or re-run a finished research helper's) last task fresh: /af-agents-restart <name|rN>",
		getArgumentCompletions: commandCtx.getSubagentTargetCompletions,
		handler: async (args, ctx) => commandCtx.handleAgentsRestart(args, ctx),
	});
}
