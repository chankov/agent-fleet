import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { CommandContext } from "./context.ts";

export function registerAgentsList(pi: ExtensionAPI, commandCtx: CommandContext): void {
	pi.registerCommand("af-agents-list", {
		description: "Open Fleet Dashboard",
		handler: async (args, ctx) => commandCtx.handleAgentsList(args, ctx),
	});
}
