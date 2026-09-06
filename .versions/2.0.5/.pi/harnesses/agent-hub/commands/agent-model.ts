import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { CommandContext } from "./context.ts";

export function registerAgentModel(pi: ExtensionAPI, commandCtx: CommandContext): void {
	pi.registerCommand("af-agent-model", {
		description: "Switch a persona's or sub-role's model from its declared candidates: /af-agent-model <persona>[.<role>]",
		getArgumentCompletions: prefix => commandCtx.getAgentModelCompletions(prefix),
		handler: async (args, ctx) => commandCtx.handleAgentModel(args, ctx),
	});
}
