import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { CommandContext } from "./context.ts";

export function registerAgentModelsSubstitute(pi: ExtensionAPI, commandCtx: CommandContext): void {
	pi.registerCommand("af-agent-models-substitute", {
		description: "Save a session-wide model substitution: /af-agent-models-substitute [<source> <target>]",
		getArgumentCompletions: prefix => commandCtx.getSubstituteCompletions(prefix),
		handler: async (args, ctx) => {
			commandCtx.setWidgetContext(ctx);
			const { policy, openSubstitutions, applySubstitution } = commandCtx.modelCommands;
			const tokens = (args || "").trim().split(/\s+/).filter(Boolean);
			if (tokens.length === 0) {
				if (policy.allKnownModels().length === 0) {
					ctx.ui.notify("No configured persona or sub-role models are available as substitution sources.", "warning");
					return;
				}
				await openSubstitutions(ctx);
				return;
			}
			if (tokens.length !== 2) {
				ctx.ui.notify("Usage: /af-agent-models-substitute [<source> <target>]", "error");
				return;
			}
			await applySubstitution(tokens[0], tokens[1], ctx);
		},
	});
}
