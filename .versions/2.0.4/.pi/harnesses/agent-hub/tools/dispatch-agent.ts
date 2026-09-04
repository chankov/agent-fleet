import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import type { DispatchAgentParams, ToolContext } from "./context.ts";

export function registerDispatchAgent(pi: ExtensionAPI, toolCtx: ToolContext): void {
	pi.registerTool({
		name: "dispatch_agent",
		label: "Dispatch Agent",
		description: "Dispatch one focused task to a listed specialist; it returns evidence.",
		parameters: Type.Object({
			agent: Type.String({ description: "Agent name (case-insensitive)" }),
			task: Type.String({ description: "Task description for the agent to execute" }),
			artifacts: Type.Optional(Type.Array(Type.String({ description: "Input artifact path; the specialist reads it." }))),
			scope: Type.Optional(Type.Array(Type.String({ description: "Advisory writable-file globs; violations are reported, never reverted." }))),
			watchdog: Type.Optional(Type.Boolean({ description: "Override this dispatch's drift watchdog." })),
			review_reason: Type.Optional(Type.String({ description: "Why a docs-only review is needed." })),
			backend: Type.Optional(Type.Union([
				Type.Literal("auto"),
				Type.Literal("native"),
				Type.Literal("coms"),
			], { description: "auto policy; native local; coms requires its live peer (no fallback)." })),
		}),

		execute(toolCallId, params, signal, onUpdate, ctx) {
			return toolCtx.executeDispatchAgent(toolCallId, params as DispatchAgentParams, signal, onUpdate, ctx);
		},

		renderCall(args, theme) {
			const agentName = (args as any).agent || "?";
			const task = (args as any).task || "";
			const preview = task.length > 60 ? task.slice(0, 57) + "..." : task;
			return new Text(
				theme.fg("toolTitle", theme.bold("dispatch_agent ")) +
				theme.fg("accent", agentName) +
				theme.fg("dim", " — ") +
				theme.fg("muted", preview),
				0, 0,
			);
		},

		renderResult(result, options, theme) {
			const details = result.details as any;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			// Streaming/partial result while agent is still running
			if (options.isPartial || details.status === "dispatching") {
				return new Text(
					theme.fg("accent", `● ${details.agent || "?"}`) +
					theme.fg("dim", " working..."),
					0, 0,
				);
			}

			const icon = details.status === "done" ? "✓" : "✗";
			const color = details.status === "done" ? "success" : "error";
			const elapsed = typeof details.elapsed === "number" ? Math.round(details.elapsed / 1000) : 0;
			const header = theme.fg(color, `${icon} ${details.agent}`) +
				theme.fg("dim", ` ${elapsed}s`);

			const questions: string[] = Array.isArray(details.questions) ? details.questions : [];
			const questionsBlock = questions.length > 0
				? "\n" + theme.fg("warning", `⚠ ${questions.length} ASK_USER question(s) raised — surface via ask_user`)
				: "";

			if (options.expanded && details.fullOutput) {
				const output = details.fullOutput.length > 4000
					? details.fullOutput.slice(0, 4000) + "\n... [truncated]"
					: details.fullOutput;
				return new Text(header + questionsBlock + "\n" + theme.fg("muted", output), 0, 0);
			}

			return new Text(header + questionsBlock, 0, 0);
		},
	});
}
