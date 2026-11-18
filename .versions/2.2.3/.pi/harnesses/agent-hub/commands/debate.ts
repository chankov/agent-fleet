import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { CommandContext } from "./context.ts";

export function registerDebate(pi: ExtensionAPI, commandCtx: CommandContext): void {
	pi.registerCommand("af-debate", {
		description: "Cross-examine every voice in a model panel: /af-debate [--panel NAME] [--persona NAME] [--rounds N] <question>",
		handler: async (args, ctx) => commandCtx.handleDebate(args, ctx),
	});
}
