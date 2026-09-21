import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import type { SetTaskTierParams, ToolContext } from "./context.ts";

export function registerSetTaskTier(pi: ExtensionAPI, toolCtx: ToolContext): void {
	pi.registerTool({
		name: "set_task_tier",
		label: "Set Task Tier",
		description:
			"Classify the CURRENT TASK on independent axes. `tier` controls spend only. `risk` (unknown|low|high) and `scope` (read-only|small|wide) control correctness obligations; risk is explicit and is never inferred from prose. Initial/legacy risk is unknown. Any risk change and any scope expansion requires `reason`; scope expansion also requires explicit risk reassessment. Lowering tier cannot erase open acceptance, plan, or review obligations. Pass `new_task: true` only for genuinely different work; same-task follow-ups, mode switches, resume, and compaction preserve obligations.",
		parameters: Type.Object({
			tier: Type.String({ description: "Spend tier only: trivial | small | feature | project" }),
			risk: Type.Optional(Type.String({ description: "Explicit correctness risk: unknown | low | high. Omitted legacy calls remain unknown." })),
			scope: Type.Optional(Type.String({ description: "Explicit process scope: read-only | small | wide." })),
			reason: Type.Optional(Type.String({ description: "Required when raising budget tier, changing risk, or expanding scope; explain the observed change/reassessment." })),
			new_task: Type.Optional(Type.Boolean({ description: "The human moved on to a different piece of work: clears the task budget, the tier, and the duplicate guard. Not for a correction or a follow-up on the same work." })),
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
