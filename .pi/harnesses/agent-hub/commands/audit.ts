import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { CommandContext } from "./context.ts";

export function registerAudit(pi: ExtensionAPI, commandCtx: CommandContext): void {
	pi.registerCommand("af-audit", {
		description: "Show a read-only sanitized audit of this Hub session",
		handler: async (_args, ctx) => commandCtx.handleAudit(ctx),
	});
}
