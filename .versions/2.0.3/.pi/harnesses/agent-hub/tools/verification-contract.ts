import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import { MAX_OPEN_ASSERTIONS } from "../assertion-ledger.js";
import type { SetAssertionsParams, UpdateAssertionParams, ToolContext } from "./context.ts";

export function registerVerificationContract(pi: ExtensionAPI, toolCtx: ToolContext): void {
	pi.registerTool({
		name: "set_assertions",
		label: "Set Assertions",
		description: `Replace this task's checkable assertion ledger (max ${MAX_OPEN_ASSERTIONS}); dispatch only evidence-gated work.`,
		parameters: Type.Object({
			assertions: Type.Array(
				Type.Object({
					id: Type.String({ description: "Stable id (A1, A2)." }),
					tag: Type.String({ description: "test | runtime-ui | code-grep | manual." }),
					text: Type.String({ description: "One pass condition." }),
					source: Type.String({ description: "Requirement origin." }),
				}),
				{ description: `Replacement list; soft cap ${MAX_OPEN_ASSERTIONS}.` },
			),
		}),
		execute(toolCallId, params, signal, onUpdate, ctx) {
			return toolCtx.executeSetAssertions(toolCallId, params as SetAssertionsParams, signal, onUpdate, ctx);
		},
		renderCall(args, theme) {
			const n = Array.isArray((args as any).assertions) ? (args as any).assertions.length : 0;
			return new Text(
				theme.fg("toolTitle", theme.bold("set_assertions ")) +
				theme.fg("muted", `${n} assertion(s)`),
				0, 0,
			);
		},
	});

	pi.registerTool({
		name: "update_assertion",
		label: "Update Assertion",
		description: "Record a verification result. proven requires named evidence; unproven/failed are not done.",
		parameters: Type.Object({
			id: Type.String({ description: "Assertion id to update, e.g. A2." }),
			status: Type.String({ description: "One of: proven | unproven | failed." }),
			evidence: Type.Optional(Type.String({ description: "Named evidence for proven/failed — test name, command output, file:line, or runtime observation." })),
		}),
		execute(toolCallId, params, signal, onUpdate, ctx) {
			return toolCtx.executeUpdateAssertion(toolCallId, params as UpdateAssertionParams, signal, onUpdate, ctx);
		},
		renderCall(args, theme) {
			const id = (args as any).id || "";
			const status = (args as any).status || "";
			return new Text(
				theme.fg("toolTitle", theme.bold("update_assertion ")) +
				theme.fg("accent", id) +
				theme.fg("dim", " → ") +
				theme.fg("muted", status),
				0, 0,
			);
		},
	});

	pi.registerTool({
		name: "get_assertions",
		label: "Get Assertions",
		description: "Read the full assertion ledger, especially after compaction. Read-only.",
		parameters: Type.Object({}),
		execute(toolCallId, params, signal, onUpdate, ctx) {
			return toolCtx.executeGetAssertions(toolCallId, params as Record<string, never>, signal, onUpdate, ctx);
		},
		renderCall(_args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("get_assertions ")) +
				theme.fg("muted", `${toolCtx.getAssertionCount()} assertion(s)`),
				0, 0,
			);
		},
	});
}
