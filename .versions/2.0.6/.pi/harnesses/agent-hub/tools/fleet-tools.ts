import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { herdr as herdrApi } from "../../lib/herdr-client.ts";
import {
	PEER_READY_TIMEOUT_MS,
	peerReadyDelayMs,
	spawnStaggerSeconds,
} from "../../lib/spawned-peers.js";
import { STAGGER_ENV_VAR, WARMUP_SECONDS, oauthNeedsWarmup } from "../../../../scripts/lib/spawn-stagger.ts";
import type {
	HerdrClosePaneParams,
	HerdrNotifyParams,
	HerdrReadPaneParams,
	HerdrSpawnPaneParams,
	HerdrSpawnPeerParams,
	ToolContext,
} from "./context.ts";

export async function waitForPeerRegistration(
	name: string,
	isComsAvailable: () => boolean,
	peerNamesInScope: () => string[],
	timeoutMs = PEER_READY_TIMEOUT_MS,
): Promise<{ found: boolean; waitedMs: number }> {
	const wanted = String(name).toLowerCase();
	const started = Date.now();
	for (let attempt = 0; ; attempt++) {
		const live = isComsAvailable() ? peerNamesInScope() : [];
		if (live.some(peerName => peerName.toLowerCase() === wanted)) {
			return { found: true, waitedMs: Date.now() - started };
		}
		const remaining = timeoutMs - (Date.now() - started);
		if (remaining <= 0) return { found: false, waitedMs: Date.now() - started };
		await new Promise(resolve => setTimeout(resolve, Math.min(peerReadyDelayMs(attempt), remaining)));
	}
}

export async function paneTail(paneId: string, lines = 12): Promise<string> {
	try {
		const { read } = await herdrApi.paneRead({ pane_id: paneId, lines });
		return read?.text ?? "";
	} catch {
		return "";
	}
}

export function peerManifest(cwd: string): string {
	try {
		return fs.readFileSync(path.join(cwd, ".pi", "agents", "peers.yaml"), "utf-8");
	} catch {
		return "";
	}
}

export function peerPersonaExists(cwd: string, persona: string): boolean {
	return (
		fs.existsSync(path.join(cwd, "agents", `${persona}.md`)) ||
		fs.existsSync(path.join(cwd, ".pi", "agents", `${persona}.md`))
	);
}

export function spawnDelaySeconds(lastHubPiSpawnAt: number | null): number {
	let authRaw: string | undefined;
	try {
		authRaw = fs.readFileSync(path.join(os.homedir(), ".pi", "agent", "auth.json"), "utf-8");
	} catch {
		authRaw = undefined;
	}
	return spawnStaggerSeconds({
		needed: oauthNeedsWarmup(authRaw),
		lastSpawnAt: lastHubPiSpawnAt,
		now: Date.now(),
		warmupSeconds: WARMUP_SECONDS,
	});
}

export { STAGGER_ENV_VAR };

export function registerFleetTools(pi: ExtensionAPI, toolCtx: ToolContext): void {
	pi.registerTool({
		name: "herdr_spawn_peer",
		label: "Herdr Spawn Peer",
		description: "Spawn a reusable sibling coms peer from its declared or compatible override settings; wait for peer_ready.",
		parameters: Type.Object({
			name: Type.String({ description: "Peer and pane name." }),
			runner: Type.Optional(Type.Union([Type.Literal("pi"), Type.Literal("claude-code")], { description: "Runner override." })),
			persona: Type.Optional(Type.String({ description: "Pi persona override." })),
			no_persona: Type.Optional(Type.Boolean({ description: "Use persona-less Fleet Core." })),
			model: Type.Optional(Type.String({ description: "Model override." })),
			extensions: Type.Optional(Type.String({ description: "Pi extensions." })),
			browser: Type.Optional(Type.Boolean({ description: "Enable browser." })),
			all_extensions: Type.Optional(Type.Boolean({ description: "All extensions (Fleet Core only)." })),
			direction: Type.Optional(Type.Union([Type.Literal("right"), Type.Literal("down")], { description: "Split direction." })),
		}),
		execute(toolCallId, params, signal, onUpdate, ctx) {
			return toolCtx.executeHerdrSpawnPeer(toolCallId, params as HerdrSpawnPeerParams, signal, onUpdate, ctx);
		},
		renderCall(args, theme) {
			const a = args as any;
			return new Text(
				theme.fg("toolTitle", theme.bold("herdr_spawn_peer ")) + theme.fg("accent", a.name ?? "?") + theme.fg("dim", a.runner ? ` (${a.runner})` : ""),
				0, 0,
			);
		},
		renderResult(result, _options, theme) {
			const d = result.details as any;
			if (d?.error) return new Text(theme.fg("error", `✗ ${d.error}`), 0, 0);
			if (d?.peer_ready === false) return new Text(theme.fg("error", `✗ ${d?.pane_id ?? "peer failed"}`), 0, 0);
			return new Text(theme.fg("success", `✓ ${d?.pane_id ?? "spawned"}`), 0, 0);
		},
	});

	pi.registerTool({
		name: "herdr_spawn_pane",
		label: "Herdr Spawn Pane",
		description: "Spawn a raw auxiliary command in a sibling pane, not a coms peer.",
		parameters: Type.Object({
			name: Type.String({ description: "Human-visible pane label." }),
			command: Type.String({ description: "Raw shell command executed with bash -lc." }),
			direction: Type.Optional(Type.Union([Type.Literal("right"), Type.Literal("down")], { description: "Split direction (default right)." })),
		}),
		execute(toolCallId, params, signal, onUpdate, ctx) {
			return toolCtx.executeHerdrSpawnPane(toolCallId, params as HerdrSpawnPaneParams, signal, onUpdate, ctx);
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("herdr_spawn_pane ")) + theme.fg("accent", (args as any).name ?? "?"), 0, 0);
		},
		renderResult(result, _options, theme) {
			const d = result.details as any;
			if (d?.error) return new Text(theme.fg("error", `✗ ${d.error}`), 0, 0);
			return new Text(theme.fg("success", `✓ ${d?.pane_id ?? "spawned"}`), 0, 0);
		},
	});

	pi.registerTool({
		name: "herdr_read_pane",
		label: "Herdr Read Pane",
		description: "Read up to 200 recent pane lines; use coms for bridged peers.",
		parameters: Type.Object({
			pane_id: Type.String({ description: "Pane id, e.g. w3:p2 (see herdr_spawn_peer result or the sidebar)." }),
			lines: Type.Optional(Type.Number({ description: "Line cap, default 60, max 200." })),
		}),
		execute(toolCallId, params, signal, onUpdate, ctx) {
			return toolCtx.executeHerdrReadPane(toolCallId, params as HerdrReadPaneParams, signal, onUpdate, ctx);
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("herdr_read_pane ")) + theme.fg("warning", (args as any).pane_id ?? "?"), 0, 0);
		},
		renderResult(result, _options, theme) {
			const d = result.details as any;
			if (d?.error) return new Text(theme.fg("error", `✗ ${d.error}`), 0, 0);
			return new Text(theme.fg("success", `✓ read ${d?.pane_id}`), 0, 0);
		},
	});

	pi.registerTool({
		name: "herdr_close_pane",
		label: "Herdr Close Pane",
		description: "Close a Hub-spawned pane. Destructive: always asks the human.",
		parameters: Type.Object({
			pane_id: Type.String({ description: "Pane id to close." }),
			reason: Type.String({ description: "One line shown to the human: why this pane can die." }),
		}),
		execute(toolCallId, params, signal, onUpdate, ctx) {
			return toolCtx.executeHerdrClosePane(toolCallId, params as HerdrClosePaneParams, signal, onUpdate, ctx);
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("herdr_close_pane ")) + theme.fg("error", (args as any).pane_id ?? "?"), 0, 0);
		},
		renderResult(result, _options, theme) {
			const d = result.details as any;
			if (d?.error) return new Text(theme.fg("error", `✗ ${d.error}`), 0, 0);
			if (d?.declined) return new Text(theme.fg("warning", "✗ declined by human"), 0, 0);
			return new Text(theme.fg("success", `✓ closed`), 0, 0);
		},
	});

	pi.registerTool({
		name: "herdr_notify",
		label: "Herdr Notify",
		description: "Notify an away human; never replaces ask_user.",
		parameters: Type.Object({
			title: Type.String({ description: "Notification title." }),
			body: Type.Optional(Type.String({ description: "Notification body." })),
		}),
		execute(toolCallId, params, signal, onUpdate, ctx) {
			return toolCtx.executeHerdrNotify(toolCallId, params as HerdrNotifyParams, signal, onUpdate, ctx);
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("herdr_notify ")) + theme.fg("accent", (args as any).title ?? ""), 0, 0);
		},
		renderResult(result, _options, theme) {
			const d = result.details as any;
			if (d?.error) return new Text(theme.fg("error", `✗ ${d.error}`), 0, 0);
			return new Text(theme.fg("success", "✓ notified"), 0, 0);
		},
	});
}
