/**
 * coms — Peer-to-peer messaging between Pi agents on the same machine.
 *
 * Transport, registry, presence, and correlation state live in the shared
 * harness core. This entry point owns only Pi registrations and presentation.
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { Text, truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

import {
	abbreviateModel,
	ComsConnectError,
	createComsPeer,
	hexFg,
	readAllRegistryEntries,
	readAllRegistryEntriesAcrossProjects,
	type ComsIdentity,
	TIMEOUT_MS,
} from "../lib/coms-core.ts";
import { registerVersionStatus } from "./version.ts";

export default function (pi: ExtensionAPI) {
	pi.registerFlag("name", { description: "Override agent name (otherwise from frontmatter or auto-generated)", type: "string", default: undefined });
	pi.registerFlag("purpose", { description: "Override agent purpose (otherwise from frontmatter description)", type: "string", default: undefined });
	pi.registerFlag("project", { description: "Project namespace for peer discovery", type: "string", default: "default" });
	pi.registerFlag("color", { description: "Hex color #RRGGBB (otherwise from frontmatter or palette fallback)", type: "string", default: undefined });
	pi.registerFlag("explicit", { description: "Hide this agent from auto-discovery; only addressable by exact name", type: "boolean", default: false });

	let currentCtx: ExtensionContext | null = null;
	const peer = createComsPeer({
		pi,
		getContext: () => currentCtx,
		onPeersChanged: () => { if (currentCtx?.hasUI) installPoolWidget(currentCtx); },
	});

	function renderPool(width: number, theme: Theme): string[] {
		const identity = peer.identity;
		const projectFilter = peer.scope.displayProject ?? identity?.project ?? "default";
		const registryEntries = projectFilter === "*"
			? readAllRegistryEntriesAcrossProjects()
			: readAllRegistryEntries(projectFilter);
		const rows: Array<{
			name: string; model: string; color: string; purpose: string;
			pct: number | null; pending: boolean; stale: boolean;
		}> = [];
		const seenSessions = new Set<string>();
		for (const [sessionId, card] of peer.peerCards) {
			if (identity && sessionId === identity.session_id) continue;
			seenSessions.add(sessionId);
			rows.push({
				name: card.name, model: card.model, color: card.color, purpose: card.purpose,
				pct: card.context_used_pct, pending: false, stale: card.staleCount >= 3,
			});
		}
		const seenNames = new Set(rows.map(row => row.name));
		for (const entry of registryEntries) {
			if (identity && entry.session_id === identity.session_id) continue;
			if (!peer.scope.includeExplicit && entry.explicit) continue;
			if (seenSessions.has(entry.session_id) || seenNames.has(entry.name)) continue;
			rows.push({
				name: entry.name, model: entry.model, color: entry.color, purpose: entry.purpose,
				pct: null, pending: true, stale: false,
			});
		}

		const safeWidth = Math.max(0, width);
		let topBorder: string;
		let bottomBorder: string;
		if (safeWidth < 12) {
			topBorder = theme.fg("dim", "━".repeat(safeWidth));
			bottomBorder = theme.fg("dim", "━".repeat(safeWidth));
		} else {
			const left = theme.fg("dim", "┏━") + theme.fg("border", " coms ");
			const nameLength = identity?.name.length ?? 0;
			const rightTagLength = identity ? nameLength + 4 : 0;
			const remaining = safeWidth - 9 - rightTagLength - 1;
			if (identity && remaining >= 1) {
				topBorder = left + theme.fg("dim", "━" + "━".repeat(remaining)) +
					theme.fg("dim", " ") + hexFg(identity.color, identity.name) + theme.fg("dim", " ━┓");
			} else {
				topBorder = left + theme.fg("dim", "━".repeat(Math.max(0, safeWidth - 9)) + "┓");
			}
			bottomBorder = theme.fg("dim", `┗${"━".repeat(safeWidth - 2)}┛`);
		}
		if (rows.length === 0) {
			return [topBorder, truncateToWidth(theme.fg("dim", " ") + theme.fg("muted", "no peers connected"), width), bottomBorder];
		}
		rows.sort((a, b) => a.name.localeCompare(b.name));
		const output = [topBorder];
		for (const row of rows) {
			const percent = row.pct ?? 0;
			const filled = Math.max(0, Math.min(15, Math.round(percent / 100 * 15)));
			const percentLabel = row.pct == null ? "--%" : `${row.pct}%`;
			if (row.stale) {
				output.push(truncateToWidth(` ${theme.fg("dim", `✗ ${row.name.padEnd(12)} ${abbreviateModel(row.model).padEnd(14)} [${"-".repeat(15)}] ${percentLabel.padStart(4)}  —  ${row.purpose}`)}`, width));
				continue;
			}
			const swatch = row.pending ? theme.fg("dim", "●") : hexFg(row.color, "●");
			const barFill = row.pending
				? theme.fg("dim", "-".repeat(15))
				: hexFg(row.color, "#".repeat(filled)) + theme.fg("dim", "-".repeat(15 - filled));
			const line = ` ${swatch} ${theme.fg("accent", row.name.padEnd(12))} ${theme.fg("dim", abbreviateModel(row.model).padEnd(14))} ` +
				theme.fg("warning", "[") + barFill + theme.fg("warning", "]") +
				` ${theme.fg("accent", percentLabel.padStart(4))}${theme.fg("dim", "  —  ")}${theme.fg("muted", row.purpose)}`;
			output.push(truncateToWidth(line, width));
		}
		output.push(bottomBorder);
		return output;
	}

	function installPoolWidget(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		try {
			ctx.ui.setWidget("coms-pool", (_tui, theme) => ({ invalidate() {}, render: (width: number) => renderPool(width, theme) }), { placement: "belowEditor" });
		} catch { /* non-fatal */ }
	}

	pi.registerTool({
		name: "coms_list",
		label: "Coms List",
		description:
			"List the peer agents in your current coms pool — the ones shown in the pool widget. Returns " +
			"names, models, live context-window usage, the herdr pane_id, and status (idle | working | " +
			"booting). CHECK STATUS BEFORE SENDING: `working` means the peer is mid-turn and your send " +
			"will wait for it; `booting` means it registered but is not addressable yet. Use this instead " +
			"of reading the peer's pane to guess whether it is busy. Discovery is scoped to what the human " +
			"displays via /af-coms; you CANNOT widen it to other projects or reveal --explicit peers yourself.",
		parameters: Type.Object({
			project: Type.Optional(Type.String({ description: "Narrow to a project WITHIN the current pool scope. Cannot widen beyond what /af-coms displays — a widening request is ignored." })),
			include_explicit: Type.Optional(Type.Boolean({ description: "Only narrows: pass false to hide explicit peers. Cannot reveal them unless the human ran /af-coms --all." })),
		}),
		async execute(_callId, params) {
			if (!peer.identity) return { content: [{ type: "text" as const, text: "coms not initialised." }], details: { agents: [], project: null } };
			const result = await peer.list(params);
			const notice = result.widenRequested
				? `\n\n(Discovery is scoped to "${result.project}"${peer.scope.includeExplicit ? "" : ", explicit peers hidden"}. ` +
				  `Widening to other projects or revealing --explicit peers is a human action via ` +
				  `/af-coms --project <name> or /af-coms --all.)`
				: "";
			const lines = result.agents.length === 0
				? "No peer agents in your pool."
				: result.agents.map(agent => {
					const context = agent.context_used_pct != null ? ` ${agent.context_used_pct}%` : " ?%";
					const state = ` [${agent.alive ? (agent.status ?? "unknown") : "unreachable"}${agent.pane_id ? ` pane ${agent.pane_id}` : ""}]`;
					return `${agent.alive ? "●" : "✗"} ${agent.name} (${agent.model})${context}${state}${agent.purpose ? ` — ${agent.purpose}` : ""}`;
				}).join("\n");
			return { content: [{ type: "text" as const, text: `${result.agents.length} peer(s) in pool (project ${result.project}):\n${lines}${notice}` }], details: result };
		},
		renderCall(args, theme) {
			const project = (args as any).project;
			return new Text(theme.fg("toolTitle", theme.bold("coms_list")) + theme.fg("dim", project ? ` ${project}` : ""), 0, 0);
		},
		renderResult(result, options, theme) {
			const agents: any[] = (result.details as any)?.agents ?? [];
			const header = theme.fg("accent", `📡 ${agents.length} peer(s)`);
			if (!options.expanded || agents.length === 0) return new Text(header, 0, 0);
			const rows = agents.map(agent => {
				const dot = agent.alive ? theme.fg("success", "●") : theme.fg("error", "✗");
				const percent = agent.context_used_pct != null ? `${agent.context_used_pct}%` : "?%";
				const state = agent.alive ? (agent.status ?? "unknown") : "unreachable";
				const stateColor = state === "idle" ? "success" : state === "working" ? "warning" : "dim";
				return `${dot} ${theme.fg("accent", agent.name)} ${theme.fg("dim", agent.model)} ${theme.fg("warning", percent)} ` +
					`${theme.fg(stateColor as any, state)}${agent.pane_id ? theme.fg("dim", ` ${agent.pane_id}`) : ""}`;
			}).join("\n");
			return new Text(header + "\n" + rows, 0, 0);
		},
	});

	pi.registerTool({
		name: "coms_send",
		label: "Coms Send",
		description:
			"Send a prompt to a peer agent. Returns synchronously with a msg_id once the receiver acks. " +
			"Use coms_get (non-blocking) or coms_await (blocking) with the msg_id to retrieve the response. " +
			"Throws if the receiver is unreachable or rejects the envelope.",
		parameters: Type.Object({
			target: Type.String({ description: "Peer name (preferred) or session_id — must be a peer currently in your coms pool (shown in the widget). Out-of-pool targets are refused; ask the human to widen scope with /af-coms --project or /af-coms --all." }),
			prompt: Type.String({ description: "The prompt to send." }),
			conversation_id: Type.Optional(Type.String()),
			response_schema: Type.Optional(Type.Any({ description: "Optional JSON Schema describing the expected response shape." })),
			reply_timeout_ms: Type.Optional(Type.Number({ description: "How long you will wait for the reply (ms). Pass the same value you intend to give coms_await: a receiver that drives an interactive agent (e.g. a Claude Code pane) uses this instead of its own default, so long reviews are not cut short. Clamped to 1 hour." })),
		}),
		async execute(_callId, params) {
			const sent = await peer.send(params);
			return { content: [{ type: "text" as const, text: `coms_send → ${sent.target}\nmsg_id ${sent.msg_id}\nhops ${sent.hops}` }], details: { msg_id: sent.msg_id, target: sent.target, target_session: sent.target_session, hops: sent.hops } };
		},
		renderCall(args, theme) {
			const target = (args as any).target ?? "?";
			const prompt = (args as any).prompt ?? "";
			const preview = prompt.length > 60 ? prompt.slice(0, 57) + "..." : prompt;
			return new Text(theme.fg("toolTitle", theme.bold("coms_send ")) + theme.fg("accent", target) +
				theme.fg("dim", " — ") + theme.fg("muted", preview), 0, 0);
		},
		renderResult(result, _options, theme) {
			const details = result.details as any;
			if (!details) {
				const content = result.content[0];
				return new Text(content?.type === "text" ? content.text : "", 0, 0);
			}
			return new Text(theme.fg("success", "→ ") + theme.fg("accent", details.target) +
				theme.fg("dim", "  msg_id ") + theme.fg("warning", details.msg_id), 0, 0);
		},
	});

	pi.registerTool({
		name: "coms_get",
		label: "Coms Get",
		description: "Non-blocking poll of a pending coms_send reply. Returns status pending|complete|error and (when complete) the response.",
		parameters: Type.Object({ msg_id: Type.String({ description: "msg_id returned by coms_send." }) }),
		async execute(_callId, params) {
			const result = peer.get(params.msg_id);
			const text = result.status === "error" ? `coms_get: unknown msg_id ${params.msg_id}` : result.status === "pending" ? "coms_get: pending" : result.error ? `coms_get: error — ${result.error}` : `coms_get: complete\n${typeof result.response === "string" ? result.response : JSON.stringify(result.response, null, 2)}`;
			return { content: [{ type: "text" as const, text }], details: result };
		},
		renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("coms_get ")) + theme.fg("warning", (args as any).msg_id ?? "?"), 0, 0); },
		renderResult(result, _options, theme) { const status = (result.details as any)?.status ?? "?"; return new Text(theme.fg(status === "complete" ? "success" : status === "pending" ? "warning" : "error", status), 0, 0); },
	});

	pi.registerTool({
		name: "coms_await",
		label: "Coms Await",
		description: "Block until a pending coms_send reply lands or the timeout fires. Default timeout 30 minutes (PI_COMS_TIMEOUT_MS).",
		parameters: Type.Object({
			msg_id: Type.String({ description: "msg_id returned by coms_send." }),
			timeout_ms: Type.Optional(Type.Number({ description: "Override the default timeout (ms)." })),
		}),
		async execute(_callId, params) {
			const result = await peer.await(params.msg_id, typeof params.timeout_ms === "number" && params.timeout_ms > 0 ? params.timeout_ms : TIMEOUT_MS);
			if (result.status === "pending") return { content: [{ type: "text" as const, text: "coms_await: pending — wait budget exhausted; the peer may still complete" }], details: { status: "pending" } };
			if (result.status === "error") {
				const unknown = result.error === "unknown msg_id";
				return {
					content: [{ type: "text" as const, text: unknown ? `coms_await: unknown msg_id ${params.msg_id}` : `coms_await: error — ${result.error}` }],
					details: unknown ? { error: "unknown msg_id" } : { status: "error", error: result.error },
				};
			}
			return {
				content: [{ type: "text" as const, text: typeof result.response === "string" ? result.response : JSON.stringify(result.response, null, 2) }],
				details: { response: result.response },
			};
		},
		renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("coms_await ")) + theme.fg("warning", (args as any).msg_id ?? "?"), 0, 0); },
		renderResult(result, _options, theme) { const details = result.details as any; return new Text(theme.fg(details?.status === "pending" ? "warning" : details?.status === "error" ? "error" : "success", details?.status === "pending" ? "⏳ pending" : details?.status === "error" ? `✗ ${details.error}` : "✓ response received"), 0, 0); },
	});

	pi.registerCommand("af-coms", {
		description: "Force-refresh the coms pool widget (or filter with --all / --project <name>)",
		handler: async (args, ctx) => { await peer.updateScope((args ?? "").trim(), ctx); },
	});

	pi.on("session_start", async (_event, ctx) => {
		registerVersionStatus(ctx);
		currentCtx = ctx;
		let identity: ComsIdentity;
		try {
			identity = await peer.connect({ ctx, defaultNamePrefix: "agent", defaultPurpose: "" });
		} catch (error) {
			if (!(error instanceof ComsConnectError)) throw error;
			const label = error.stage === "dirs" ? "failed to create dirs" : error.stage === "registry" ? "registry write failed" : "bind failed";
			ctx.ui?.notify?.(`📡 coms: ${label} — ${error instanceof Error ? error.message : String(error)}`, "error");
			return;
		}
		try {
			ctx.ui.setStatus("coms", `📡 ${identity.name}@${identity.project}`);
			installPoolWidget(ctx);
			ctx.ui.notify(`📡 coms ready · ${identity.name}@${identity.project} · ${peer.scope.displayProject ?? identity.project} pool`, "info");
		} catch { /* UI is optional */ }
	});
	pi.on("before_agent_start", async () => { await peer.setTurnState("working"); });
	pi.on("agent_end", async (_event, ctx) => { await peer.setTurnState("idle"); await peer.respond(ctx); });
	pi.on("session_shutdown", async () => { await peer.shutdown(); if (currentCtx?.hasUI) currentCtx.ui.setWidget("coms-pool", undefined); });
	process.on("SIGINT", () => { void peer.shutdown(); });
	process.on("SIGTERM", () => { void peer.shutdown(); });
}
