import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { CommandContext } from "./context.ts";

export function registerWatchdog(pi: ExtensionAPI, commandCtx: CommandContext): void {
	pi.registerCommand("af-watchdog", {
		description: "Drift watchdog: /af-watchdog [on|off|auto] hub-wide, /af-watchdog <agent> [on|off|clear] per agent, no args to show",
		handler: async (args, ctx) => commandCtx.handleWatchdog(args, ctx),
	});
}
