import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { CommandContext } from "./context.ts";

export function registerAgentsHistory(pi: ExtensionAPI, commandCtx: CommandContext): void {
	pi.registerCommand("af-agents-history", {
		description: "Timeline of agent execution — orchestrator turns, dispatches, research helpers, durations, and a grand total",
		handler: async (args, ctx) => commandCtx.handleAgentsHistory(args, ctx),
	});
}
