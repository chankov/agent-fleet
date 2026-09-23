import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { CommandContext } from "./context.ts";

export function registerAgentsTeam(pi: ExtensionAPI, commandCtx: CommandContext): void {
	pi.registerCommand("af-agents-team", {
		description: "Select a team to work with",
		handler: async (args, ctx) => commandCtx.handleAgentsTeam(args, ctx),
	});
}
