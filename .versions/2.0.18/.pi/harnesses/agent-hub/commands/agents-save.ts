import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { CommandContext } from "./context.ts";

export function registerAgentsSave(pi: ExtensionAPI, commandCtx: CommandContext): void {
	pi.registerCommand("af-agents-save", {
		description: "Persist the CURRENT roster as a named team in .pi/agents/teams.yaml: /af-agents-save <team-name>",
		handler: async (args, ctx) => commandCtx.handleAgentsSave(args, ctx),
	});
}
