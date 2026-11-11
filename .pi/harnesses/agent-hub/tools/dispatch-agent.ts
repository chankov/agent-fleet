import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import type { DispatchAgentParams, ToolContext } from "./context.ts";

export function registerDispatchAgent(pi: ExtensionAPI, toolCtx: ToolContext, triage?: { disposition(id: string, persona: string, reason: string): boolean; submitted(id: string, persona: string, status: string): void }): void {
	pi.registerTool({
		name: "dispatch_agent",
		label: "Dispatch Agent",
		description: "Dispatch one specialist task for evidence.",
		parameters: Type.Object({
   triage_id: Type.Optional(Type.String({ description: "Triage trace ID; not authorization." })),
   triage_reason: Type.Optional(Type.Union([Type.Literal("used"), Type.Literal("better_fit"), Type.Literal("changed_scope"), Type.Literal("independent_judgment")])),
			agent: Type.String({ description: "Agent, case-insensitive" }),
			task: Type.String({ description: "English task; paths, not bodies." }),
			artifacts: Type.Optional(Type.Array(Type.String({ description: "Input path." }))),
			scope: Type.Optional(Type.Array(Type.String({ description: "Globs advisory; isolation: exact existing relative files/dirs." }))),
			deliverables: Type.Optional(Type.Array(Type.String({ description: "Output path; existence is not acceptance." }))),
			scope_mode: Type.Optional(Type.Union([Type.Literal("existing"), Type.Literal("create")], { description: "existing (default) refuses missing roots; create permits." })),
			watchdog: Type.Optional(Type.Boolean({ description: "Drift watchdog override." })),
			review_reason: Type.Optional(Type.String({ description: "Focus/docs reason; no review reuse." })),
   private_config_files: Type.Optional(Type.Array(Type.String(), {description:"Private: 1–4 canonical notification JSONs; never artifacts."})),
   verifier_sources: Type.Optional(Type.Array(Type.String(), {description:"Private: 1–32 repo-relative sources, all ignored helpers."})),
   review_mode: Type.Optional(Type.Union([Type.Literal("changes"),Type.Literal("operator-current-state"),Type.Literal("private-config-current-state")],{description:"Default changes. Current-state native only; no authorship, activation, manual proof."})),

			parallel: Type.Optional(Type.Boolean({ description: "Writer beside others; sandboxed to exact scope paths." })),
			backend: Type.Optional(Type.Union([
				Type.Literal("auto"),
				Type.Literal("native"),
				Type.Literal("coms"),
			], { description: "auto policy; native local; coms live, no fallback." })),
		}),

		async execute(toolCallId, params, signal, onUpdate, ctx) {
   let correlated = false;
   try { if (params.triage_id && params.triage_reason) correlated = triage?.disposition(params.triage_id, params.agent, params.triage_reason) === true; } catch { /* trace cannot affect dispatch */ }
   const result = await toolCtx.executeDispatchAgent(toolCallId, params as DispatchAgentParams, signal, onUpdate, ctx);
   try { if (correlated) triage?.submitted(params.triage_id!, params.agent, "submitted; outcome remains in dispatch evidence"); } catch { /* observational */ }
   return result;
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

			const completed = details.executionStatus === "completed";
			const icon = details.accepted === true ? "✓" : completed || details.pending ? "○" : "✗";
			const color = details.accepted === true ? "success" : completed || details.pending ? "warning" : "error";
			const elapsed = typeof details.elapsed === "number" ? Math.round(details.elapsed / 1000) : 0;
			const header = theme.fg(color, `${icon} ${details.agent}${completed && !details.accepted ? " — completed; acceptance unproven" : ""}`) +
				theme.fg("dim", ` ${elapsed}s`);

			const questions: string[] = Array.isArray(details.questions) ? details.questions : [];
			const questionsBlock = questions.length > 0
				? "\n" + theme.fg("warning", `⚠ ${questions.length} ASK_USER question(s) raised — operator resolves first; escalate unresolved decisions`)
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
