import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import type { SetTaskTierParams, ToolContext } from "./context.ts";

export function registerSetTaskTier(pi: ExtensionAPI, toolCtx: ToolContext): void {
	pi.registerTool({
		name: "set_task_tier",
		label: "Set Task Tier",
		description:
			"Classify current task: tier controls spend only; explicit risk and scope control correctness, never inferred from prose. Initial/legacy risk is unknown. Risk changes or scope expansion require reason; expansion also requires risk reassessment. Lower tier never clears acceptance/plan/review. new_task is only for different work, not follow-ups, mode switches, resume or compaction.",
		parameters: Type.Object({
			tier: Type.String({ description: "Spend tier only: trivial | small | feature | project" }),
			risk: Type.Optional(Type.String({ description: "Explicit correctness risk: unknown | low | high. Omitted legacy calls remain unknown." })),
			scope: Type.Optional(Type.String({ description: "Explicit process scope: read-only | small | wide." })),
			reason: Type.Optional(Type.String({ description: "Explain tier increase, risk change or scope expansion/reassessment." })),
			new_task: Type.Optional(Type.Boolean({ description: "Human changed tasks: resets budget, tier and duplicate guard; never for same-task corrections/follow-ups." })),
		}),
		execute(toolCallId, params, signal, onUpdate, ctx) {
			return toolCtx.executeSetTaskTier(toolCallId, params as SetTaskTierParams, signal, onUpdate, ctx);
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("set_task_tier ")) +
				theme.fg("accent", String((args as any).tier || "?")) +
				theme.fg("dim", (args as any).reason ? ` — ${String((args as any).reason).slice(0, 60)}` : ""),
				0, 0,
			);
		},
	});
}
