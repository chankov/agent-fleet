import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { CommandContext } from "./context.ts";

export function registerAgentModelsSubstitute(pi: ExtensionAPI, commandCtx: CommandContext): void {
	pi.registerCommand("af-agent-models-substitute", {
		description: "Save a session-wide model substitution: /af-agent-models-substitute [<source> <target>]",
		getArgumentCompletions: prefix => commandCtx.getSubstituteCompletions(prefix),
		handler: async (args, ctx) => commandCtx.handleAgentModelsSubstitute(args, ctx),
	});
}
