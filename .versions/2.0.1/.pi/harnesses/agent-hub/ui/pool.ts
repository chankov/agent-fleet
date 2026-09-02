import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { RegistryEntry as ComsRegistryEntry } from "../../lib/coms-core.ts";
import { abbreviateModel, hexFg } from "../../lib/coms-core.ts";
import { buildFleetRows, type PeerInput } from "../../lib/fleet-read-model.ts";

export interface PoolPresentationDeps {
	getIdentity(): { session_id: string; name: string; color: string; project: string } | null;
	getDisplayProject(): string | undefined;
	includeExplicitPeers(): boolean;
	getPeerCards(): ReadonlyMap<string, { name: string; model: string; purpose: string; color: string; staleCount?: number }>;
	readProjectEntries(project: string): ComsRegistryEntry[];
	readAllEntries(): ComsRegistryEntry[];
	isCompact(): boolean;
	truncate(text: string, width: number): string;
}

export interface PoolPresentation {
	peerInputs(formatModel?: (model: string) => string): PeerInput[];
	render(width: number, theme: { fg(color: string, text: string): string }): string[];
	install(ctx: ExtensionContext): void;
}

const scrubFleetText = (text: string) => text.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim();

export function createPoolPresentation(deps: PoolPresentationDeps): PoolPresentation {
	let cachedProject: string | undefined;
	let cachedEntries: ComsRegistryEntry[] = [];
	let cachedAt = 0;

	const peerInputs = (formatModel: (model: string) => string = model => model): PeerInput[] => {
		const identity = deps.getIdentity();
		const project = deps.getDisplayProject() ?? identity?.project ?? "default";
		if (cachedProject !== project || Date.now() - cachedAt > 1000) {
			cachedProject = project;
			cachedEntries = project === "*" ? deps.readAllEntries() : deps.readProjectEntries(project);
			cachedAt = Date.now();
		}
		const peers: PeerInput[] = [];
		const sessions = new Set<string>();
		const names = new Set<string>();
		for (const [sid, card] of deps.getPeerCards()) {
			if (identity && sid === identity.session_id) continue;
			sessions.add(sid); names.add(card.name);
			peers.push({ key: `peer:${sid}`, name: scrubFleetText(card.name), model: formatModel(card.model), lastWork: scrubFleetText(card.purpose), colorHex: card.color, staleCount: card.staleCount });
		}
		for (const entry of cachedEntries) {
			if (identity && entry.session_id === identity.session_id) continue;
			if (!deps.includeExplicitPeers() && entry.explicit) continue;
			if (sessions.has(entry.session_id) || names.has(entry.name)) continue;
			peers.push({ key: `peer:${entry.session_id}`, name: scrubFleetText(entry.name), model: formatModel(entry.model), lastWork: scrubFleetText(entry.purpose), colorHex: entry.color, pending: true });
		}
		return peers;
	};

	const render = (width: number, theme: { fg(color: string, text: string): string }): string[] => {
		if (!deps.isCompact()) return [];
		const rows = buildFleetRows({ specialists: [], research: [], peers: peerInputs() }, { showFinished: true });
		const safeWidth = Math.max(0, width);
		const identity = deps.getIdentity();
		let topBorder: string;
		let bottomBorder: string;
		if (safeWidth < 12) {
			topBorder = theme.fg("dim", "━".repeat(safeWidth));
			bottomBorder = theme.fg("dim", "━".repeat(safeWidth));
		} else {
			const left = theme.fg("dim", "┏━") + theme.fg("border", " coms ");
			const remaining = safeWidth - 9 - (identity ? identity.name.length + 4 : 0) - 1;
			if (identity && remaining >= 1) {
				topBorder = left + theme.fg("dim", "━") + theme.fg("dim", "━".repeat(remaining)) + theme.fg("dim", " ") + hexFg(identity.color, identity.name) + theme.fg("dim", " ━") + theme.fg("dim", "┓");
			} else {
				topBorder = left + theme.fg("dim", "━".repeat(Math.max(0, safeWidth - 9)) + "┓");
			}
			bottomBorder = theme.fg("dim", "┗" + "━".repeat(safeWidth - 2) + "┛");
		}
		if (rows.length === 0) return [topBorder, deps.truncate(theme.fg("dim", " ") + theme.fg("muted", "no peers connected"), width), bottomBorder];
		rows.sort((a, b) => a.name.localeCompare(b.name));
		const out = [topBorder];
		for (const row of rows) {
			const pct = row.contextPct ?? 0;
			const filled = Math.max(0, Math.min(15, Math.round(pct / 100 * 15)));
			const pctLabel = row.contextPct == null ? "--%" : `${row.contextPct}%`;
			if (row.status === "stale") {
				out.push(deps.truncate(" " + theme.fg("dim", `✗ ${row.name.padEnd(12)} ${abbreviateModel(row.model).padEnd(14)} [${"-".repeat(15)}] ${pctLabel.padStart(4)}  —  ${row.lastWork || ""}`), width));
				continue;
			}
			const pending = row.status === "pending";
			const swatch = pending ? theme.fg("dim", "●") : hexFg(row.colorHex ?? "#808080", "●");
			const fill = pending ? theme.fg("dim", "-".repeat(15)) : hexFg(row.colorHex ?? "#808080", "#".repeat(filled)) + theme.fg("dim", "-".repeat(15 - filled));
			const line = " " + swatch + " " + theme.fg("accent", row.name.padEnd(12)) + " " + theme.fg("dim", abbreviateModel(row.model).padEnd(14)) + " " + theme.fg("warning", "[") + fill + theme.fg("warning", "]") + " " + theme.fg("accent", pctLabel.padStart(4)) + theme.fg("dim", "  —  ") + theme.fg("muted", row.lastWork || "");
			out.push(deps.truncate(line, width));
		}
		out.push(bottomBorder);
		return out;
	};

	return {
		peerInputs, render,
		install(ctx) {
			if (!ctx.hasUI) return;
			try { ctx.ui.setWidget("coms-pool", (_tui, theme) => ({ invalidate() {}, render: width => render(width, theme) }), { placement: "belowEditor" }); } catch {}
		},
	};
}
