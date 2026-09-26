import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { CommandContext } from "./context.ts";

export function registerHandoff(pi: ExtensionAPI, commandCtx: CommandContext): void {
	pi.registerCommand("af-handoff", {
		description: "Hand the session off to a coms peer (the dispatcher composes a self-contained brief): /af-handoff <peer>",
		getArgumentCompletions: prefix => commandCtx.getComsPeerCompletions(prefix),
		handler: async (args, ctx) => commandCtx.handleHandoff(args, ctx),
	});
}
