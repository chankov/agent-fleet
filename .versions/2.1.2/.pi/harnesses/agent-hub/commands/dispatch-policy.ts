import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { CommandContext } from "./context.ts";

export function registerDispatchPolicy(pi: ExtensionAPI, commandCtx: CommandContext): void {
	pi.registerCommand("af-dispatch-policy", {
		description: "Show dispatch backend routing (dispatch-policy.yaml) for the active team",
		handler: async (args, ctx) => commandCtx.handleDispatchPolicy(args, ctx),
	});
}
