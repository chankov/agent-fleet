import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import type { SetTaskTierParams, ToolContext } from "./context.ts";

export function registerSetTaskTier(pi: ExtensionAPI, toolCtx: ToolContext): void {
	pi.registerTool({
		name: "set_task_tier",
		label: "Set Task Tier",
		description:
			"Classify the CURRENT TASK before your first dispatch: trivial (one obvious, low-risk change — 1 dispatch), small (a contained change, no planning pipeline — 2 dispatches), feature (a normal multi-step feature — 8 dispatches), project (a large effort — 12 dispatches). Nested delegation is off at trivial/small. The tier persists across user messages and moves by ratchet: LOWERING it is always free, RAISING it requires `reason` naming what the ask turned out to contain. Pass `new_task: true` only when the human has moved on to a genuinely different piece of work — it also resets the task budget.",
		parameters: Type.Object({
			tier: Type.String({ description: "One of: trivial | small | feature | project" }),
			reason: Type.Optional(Type.String({ description: "One line on why this tier fits the ask. REQUIRED when raising the tier above the current one." })),
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
