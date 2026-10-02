import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { CommandContext } from "./context.ts";

export function registerContextCommand(pi: ExtensionAPI, commandCtx: CommandContext): void {
	pi.registerCommand("af-context", {
		description: "Open a read-only full-screen context budget diagnostic",
		handler: async (args, ctx) => commandCtx.handleContext(args, ctx),
	});
}
