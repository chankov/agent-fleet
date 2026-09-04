import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import type { ComsAwaitParams, ComsGetParams, ComsListParams, ComsSendParams, ToolContext } from "./context.ts";

export function registerComsTools(pi: ExtensionAPI, toolCtx: ToolContext): void {
	pi.registerTool({
		name: "coms_list",
		label: "Coms List",
		description: "List peers in the human-scoped pool; this tool cannot widen discovery.",
		parameters: Type.Object({
			project: Type.Optional(Type.String({ description: "Narrow to a project WITHIN the current pool scope. Cannot widen beyond what /af-coms displays — a widening request is ignored." })),
			include_explicit: Type.Optional(Type.Boolean({ description: "Only narrows: pass false to hide explicit peers. Cannot reveal them unless the human ran /af-coms --all." })),
		}),
		execute(toolCallId, params, signal, onUpdate, ctx) {
			return toolCtx.executeComsList(toolCallId, params as ComsListParams, signal, onUpdate, ctx);
		},
		renderCall(args, theme) {
			const proj = (args as any).project;
			const filter = proj ? ` ${proj}` : "";
			return new Text(
				theme.fg("toolTitle", theme.bold("coms_list")) + theme.fg("dim", filter),
				0, 0,
			);
		},
		renderResult(result, options, theme) {
			const details = result.details as any;
			const agents: any[] = details?.agents ?? [];
			const header = theme.fg("accent", `📡 ${agents.length} peer(s)`);
			if (!options.expanded || agents.length === 0) {
				return new Text(header, 0, 0);
			}
			const rows = agents.map((a) => {
				const dot = a.alive ? theme.fg("success", "●") : theme.fg("error", "✗");
				const pct = a.context_used_pct != null ? `${a.context_used_pct}%` : "?%";
				const state = a.alive ? (a.status ?? "unknown") : "unreachable";
				const stateFg = state === "idle" ? "success" : state === "working" ? "warning" : "dim";
				return `${dot} ${theme.fg("accent", a.name)} ${theme.fg("dim", a.model)} ${theme.fg("warning", pct)} ` +
					`${theme.fg(stateFg as any, state)}${a.pane_id ? theme.fg("dim", ` ${a.pane_id}`) : ""}`;
			}).join("\n");
			return new Text(header + "\n" + rows, 0, 0);
		},
	});

	pi.registerTool({
		name: "coms_send",
		label: "Coms Send",
		description: "Send to an in-pool peer; use its msg_id with coms_get or coms_await.",
		parameters: Type.Object({
			target: Type.String({ description: "Peer name (preferred) or session_id — must be a peer currently in your coms pool (shown in the widget). Out-of-pool targets are refused; ask the human to widen scope with /af-coms --project or /af-coms --all." }),
			prompt: Type.String({ description: "The prompt to send." }),
			handoff_token: Type.Optional(Type.String({ description: "Internal /af-handoff token. Only include when the /af-handoff follow-up explicitly gives you one; it authorizes the machine-appended ledger/artifact appendix." })),
			conversation_id: Type.Optional(Type.String()),
			response_schema: Type.Optional(Type.Any({ description: "Optional JSON Schema describing the expected response shape." })),
			reply_timeout_ms: Type.Optional(Type.Number({ description: "Receiver-side reply deadline in ms; pass the same budget used for coms_await. Clamped by the receiver." })),
		}),
		execute(toolCallId, params, signal, onUpdate, ctx) {
			return toolCtx.executeComsSend(toolCallId, params as ComsSendParams, signal, onUpdate, ctx);
		},
		renderCall(args, theme) {
			const tgt = (args as any).target ?? "?";
			const prompt = (args as any).prompt ?? "";
			const preview = prompt.length > 60 ? prompt.slice(0, 57) + "..." : prompt;
			return new Text(
				theme.fg("toolTitle", theme.bold("coms_send ")) +
				theme.fg("accent", tgt) +
				theme.fg("dim", " — ") +
				theme.fg("muted", preview),
				0, 0,
			);
		},
		renderResult(result, _options, theme) {
			const d = result.details as any;
			if (!d) {
				const t = result.content[0];
				return new Text(t?.type === "text" ? t.text : "", 0, 0);
			}
			return new Text(
				theme.fg("success", "→ ") +
				theme.fg("accent", d.target) +
				theme.fg("dim", `  msg_id `) +
				theme.fg("warning", d.msg_id),
				0, 0,
			);
		},
	});

	pi.registerTool({
		name: "coms_get",
		label: "Coms Get",
		description:
			"Non-blocking poll of a pending coms_send reply. Returns status pending|complete|error and (when complete) the response.",
		parameters: Type.Object({
			msg_id: Type.String({ description: "msg_id returned by coms_send." }),
		}),
		execute(toolCallId, params, signal, onUpdate, ctx) {
			return toolCtx.executeComsGet(toolCallId, params as ComsGetParams, signal, onUpdate, ctx);
		},
		renderCall(args, theme) {
			const id = (args as any).msg_id ?? "?";
			return new Text(
				theme.fg("toolTitle", theme.bold("coms_get ")) + theme.fg("warning", id),
				0, 0,
			);
		},
		renderResult(result, _options, theme) {
			const d = result.details as any;
			const status = d?.status ?? "?";
			const color = status === "complete" ? "success" : status === "pending" ? "warning" : "error";
			return new Text(theme.fg(color, status), 0, 0);
		},
	});

	pi.registerTool({
		name: "coms_await",
		label: "Coms Await",
		description: "Wait for a pending coms_send reply; timeout leaves it pending.",
		parameters: Type.Object({
			msg_id: Type.String({ description: "msg_id returned by coms_send." }),
			timeout_ms: Type.Optional(Type.Number({ description: "Override the default timeout (ms)." })),
		}),
		execute(toolCallId, params, signal, onUpdate, ctx) {
			return toolCtx.executeComsAwait(toolCallId, params as ComsAwaitParams, signal, onUpdate, ctx);
		},
		renderCall(args, theme) {
			const id = (args as any).msg_id ?? "?";
			return new Text(
				theme.fg("toolTitle", theme.bold("coms_await ")) + theme.fg("warning", id),
				0, 0,
			);
		},
		renderResult(result, _options, theme) {
			const d = result.details as any;
			if (d?.error) return new Text(theme.fg("error", `✗ ${d.error}`), 0, 0);
			if (d?.status === "pending") return new Text(theme.fg("warning", "⏳ pending"), 0, 0);
			return new Text(theme.fg("success", "✓ response received"), 0, 0);
		},
	});
}
