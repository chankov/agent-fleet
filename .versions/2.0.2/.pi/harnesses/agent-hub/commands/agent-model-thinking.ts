import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { CommandContext } from "./context.ts";

export function registerAgentModelThinking(pi: ExtensionAPI, commandCtx: CommandContext): void {
	pi.registerCommand("af-agent-model-thinking", {
		description: "Switch a persona's thinking level from pi's --thinking levels: /af-agent-model-thinking <persona>",
		getArgumentCompletions: prefix => commandCtx.getAgentModelThinkingCompletions(prefix),
		handler: async (args, ctx) => commandCtx.handleAgentModelThinking(args, ctx),
	});
}
