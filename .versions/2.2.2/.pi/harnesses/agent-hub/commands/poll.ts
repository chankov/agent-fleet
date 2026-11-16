import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { CommandContext } from "./context.ts";

export function registerPoll(pi: ExtensionAPI, commandCtx: CommandContext): void {
	pi.registerCommand("af-poll", {
		description: "Ask the same question of every voice in a model panel: /af-poll [--panel NAME] [--persona NAME] <question>",
		handler: async (args, ctx) => commandCtx.handlePoll(args, ctx),
	});
}
