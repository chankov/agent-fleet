import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { CommandContext } from "./context.ts";

export function registerAgentsDrop(pi: ExtensionAPI, commandCtx: CommandContext): void {
	pi.registerCommand("af-agents-drop", {
		description: "Drop persona(s) from the active team: /af-agents-drop <name> [<name>…]",
		handler: async (args, ctx) => commandCtx.handleAgentsDrop(args, ctx),
	});
}
