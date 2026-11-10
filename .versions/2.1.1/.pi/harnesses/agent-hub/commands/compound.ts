import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { CommandContext } from "./context.ts";

export function registerCompound(pi: ExtensionAPI, commandCtx: CommandContext): void {
	pi.registerCommand("af-compound", {
		description: "Capture this session's lessons into the project's rules/docs via the documenter: /af-compound [focus]",
		handler: async (args, ctx) => commandCtx.handleCompound(args, ctx),
	});
}
