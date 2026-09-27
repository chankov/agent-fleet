import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { CommandContext } from "./context.ts";

export function registerAgentsKill(pi: ExtensionAPI, commandCtx: CommandContext): void {
	pi.registerCommand("af-agents-kill", {
		description: "Kill a running specialist, or kill & remove research helper(s): /af-agents-kill <name|rN|all>",
		getArgumentCompletions: commandCtx.getAgentsKillCompletions,
		handler: async (args, ctx) => commandCtx.handleAgentsKill(args, ctx),
	});
}
