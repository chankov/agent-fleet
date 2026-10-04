import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { CommandContext } from "./context.ts";

export function registerZoom(pi: ExtensionAPI, commandCtx: CommandContext): void {
	pi.registerCommand("af-zoom", {
		description: "Scrollable read-only view of an agent's stream: /af-zoom <name|rN>",
		getArgumentCompletions: prefix => commandCtx.getZoomCompletions(prefix),
		handler: async (args, ctx) => commandCtx.handleZoom(args, ctx),
	});
}
