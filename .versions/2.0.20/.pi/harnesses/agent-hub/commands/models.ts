import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { CommandContext } from "./context.ts";

export function registerModels(pi: ExtensionAPI, commandCtx: CommandContext): void {
	pi.registerCommand("af-models", {
		description: "Apply a model profile to the team: /af-models [profile]",
		getArgumentCompletions: prefix => commandCtx.getModelProfileCompletions(prefix),
		handler: async (args, ctx) => commandCtx.handleModels(args, ctx),
	});
}
