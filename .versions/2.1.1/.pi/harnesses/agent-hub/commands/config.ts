import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { CommandContext } from "./context.ts";

export function registerConfig(pi: ExtensionAPI, commandCtx: CommandContext): void {
	pi.registerCommand("af-config", {
		description: "Read-only Fleet configuration screen: desired state, install record, overrides, AI state, System 1, STT, fleet YAML, safety (also Alt+,); /af-config <tab> jumps to a tab",
		handler: async (args, ctx) => commandCtx.handleConfig(args, ctx),
	});
}
