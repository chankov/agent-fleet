import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { CommandContext } from "./context.ts";

export function registerHubReport(pi: ExtensionAPI, commandCtx: CommandContext): void {
	pi.registerCommand("af-hub-report", {
		description: "Per-turn cost report: dispatches, research, tokens, recycles, drift stops (last turn + session totals)",
		handler: async (args, ctx) => commandCtx.handleHubReport(args, ctx),
	});
}
