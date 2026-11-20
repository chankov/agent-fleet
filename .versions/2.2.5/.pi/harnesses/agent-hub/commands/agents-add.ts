import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { CommandContext } from "./context.ts";

export function registerAgentsAdd(pi: ExtensionAPI, commandCtx: CommandContext): void {
	pi.registerCommand("af-agents-add", {
		description: "Add persona(s) to the active team without switching teams: /af-agents-add <name> [<name>…]",
		handler: async (args, ctx) => commandCtx.handleAgentsAdd(args, ctx),
	});
}
