import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import type { SpawnResearchParams, ToolContext } from "./context.ts";

export function registerSpawnResearch(pi: ExtensionAPI, toolCtx: ToolContext): void {
	pi.registerTool({
		name: "spawn_research",
		label: "Spawn Research",
		description: "Run a read-only (read/grep/find/ls) helper and return findings.",
		parameters: Type.Object({
			task: Type.String({ description: "Investigation and expected findings." }),
			persona: Type.Optional(Type.String({ description: "Research persona; omit for ad-hoc." })),
			model: Type.Optional(Type.String({ description: "Anonymous-helper model; ignored with persona." })),
			artifacts: Type.Optional(Type.Array(Type.String({ description: "Input artifact path." }))),
		}),

		execute(toolCallId, params, signal, onUpdate, ctx) {
			return toolCtx.executeSpawnResearch(toolCallId, params as SpawnResearchParams, signal, onUpdate, ctx);
		},

		renderCall(args, theme) {
			const persona = (args as any).persona;
			const task = (args as any).task || "";
			const preview = task.length > 60 ? task.slice(0, 57) + "..." : task;
			return new Text(
				theme.fg("toolTitle", theme.bold("spawn_research ")) +
				theme.fg("accent", persona ? `@${persona}` : "ad-hoc") +
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
			if (options.isPartial || details.status === "spawning") {
				return new Text(
					theme.fg("accent", `● ${details.handle || "research"}`) +
					theme.fg("dim", " researching..."),
					0, 0,
				);
			}
			const icon = details.status === "done" ? "✓" : "✗";
			const color = details.status === "done" ? "success" : "error";
			const elapsed = typeof details.elapsed === "number" ? Math.round(details.elapsed / 1000) : 0;
			const header = theme.fg(color, `${icon} ${details.handle || "research"}`) +
				theme.fg("dim", ` read-only ${elapsed}s`);
			if (options.expanded && details.fullOutput) {
				const output = details.fullOutput.length > 4000
					? details.fullOutput.slice(0, 4000) + "\n... [truncated]"
					: details.fullOutput;
				return new Text(header + "\n" + theme.fg("muted", output), 0, 0);
			}
			return new Text(header, 0, 0);
		},
	});
}
