import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import type { TeamAdjustParams, ToolContext } from "./context.ts";

export function registerTeamAdjust(pi: ExtensionAPI, toolCtx: ToolContext): void {
	pi.registerTool({
		name: "team_adjust",
		label: "Team Adjust",
		description:
			"Add or drop a specialist persona in the ACTIVE team (the roster you can dispatch to). Use sparingly, when the current roster genuinely cannot serve the task (e.g. add security-auditor for a security-sensitive change, drop an unused specialist). Not available at trivial/small tiers. The human sees every change and can revert with /af-agents-add /af-agents-drop.",
		parameters: Type.Object({
			action: Type.String({ description: "add | drop" }),
			agent: Type.String({ description: "Persona name (case-insensitive), e.g. security-auditor" }),
			reason: Type.String({ description: "One line on why the roster must change for this task." }),
		}),
		execute(toolCallId, params, signal, onUpdate, ctx) {
			return toolCtx.executeTeamAdjust(toolCallId, params as TeamAdjustParams, signal, onUpdate, ctx);
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("team_adjust ")) +
				theme.fg("accent", `${String((args as any).action || "?")} ${String((args as any).agent || "?")}`) +
				theme.fg("dim", (args as any).reason ? ` — ${String((args as any).reason).slice(0, 50)}` : ""),
				0, 0,
			);
		},
	});
}
