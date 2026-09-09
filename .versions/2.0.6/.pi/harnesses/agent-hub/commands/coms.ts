import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { CommandContext } from "./context.ts";

export function registerComs(pi: ExtensionAPI, commandCtx: CommandContext): void {
	pi.registerCommand("af-coms", {
		description: "Force-refresh the coms pool widget (or filter with --all / --project <name>)",
		handler: async (args, ctx) => commandCtx.handleComs(args, ctx),
	});
}
