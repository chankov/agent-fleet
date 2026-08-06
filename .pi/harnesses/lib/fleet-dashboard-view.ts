import type { FleetRow } from "./fleet-read-model.ts";
import { moveSelection, type Selection } from "./fleet-selection.ts";

export interface ThemeLike { fg(color: string, text: string): string; bold(text: string): string; bg?(color: string, text: string): string; }
export const FLEET_CHROME_ROWS = 4;
export interface FleetViewModel {
	rows: readonly FleetRow[];
	selection: Selection;
	summary: { running: number; done: number; failed: number; totalTokens: number; intervals: Array<[number, number]>; wallMs: number };
	filterQuery?: string;
	showFinished: boolean;
	scrollOffset?: number;
	confirmation?: string;
}

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const visibleWidth = (text: string) => Array.from(text.replace(ANSI, "")).length;
/** Truncate terminal-styled text without cutting an ANSI sequence; close SGR styling when clipped. */
const ellipsis = (text: string, width: number) => {
	if (visibleWidth(text) <= width) return text;
	if (width <= 0) return "";
	let out = "", visible = 0, i = 0, styled = false;
	const limit = Math.max(0, width - 1);
	while (i < text.length && visible < limit) {
		if (text[i] === "\x1b") {
			const match = text.slice(i).match(/^\x1b\[[0-?]*[ -/]*[@-~]/);
			if (match) { out += match[0]; styled = match[0] !== "\x1b[0m"; i += match[0].length; continue; }
		}
		const char = String.fromCodePoint(text.codePointAt(i)!);
		out += char; visible++; i += char.length;
	}
	return `${out}${width > 1 ? "…" : ""}${styled ? "\x1b[0m" : ""}`;
};
const duration = (ms: number) => ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60_000)}:${String(Math.round(ms / 1000) % 60).padStart(2, "0")}`;
const tokens = (n: number | null) => n == null ? "—" : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
const glyph = (row: FleetRow) => row.status === "running" ? "●" : row.status === "done" ? "✓" : row.status === "error" ? "✗" : row.status === "pending" ? "◌" : row.status === "stale" ? "○" : "▪";
const context = (pct: number | null) => pct == null ? "[automatic]  —" : `[${"#".repeat(Math.max(0, Math.min(10, Math.round(pct / 10))))}${"·".repeat(Math.max(0, 10 - Math.round(pct / 10)))}] ${Math.round(pct)}%`;

/** Render a constant-height, width-bounded fleet list without pi runtime dependencies. */
export function renderFleetDashboard(vm: FleetViewModel, width: number, bodyHeight: number, theme: ThemeLike): string[] {
	const w = Math.max(1, width), body = Math.max(0, bodyHeight);
	const summary = `${vm.summary.running} running · ${vm.summary.done} done${vm.summary.failed ? ` · ${vm.summary.failed} failed` : ""} · ${duration(vm.summary.wallMs)} · ${tokens(vm.summary.totalTokens)} tok`;
	const header = ellipsis(` Fleet ${vm.filterQuery ? `· filter: ${vm.filterQuery}` : ""}`, Math.max(1, w - summary.length - 1));
	const lines: string[] = [ellipsis(theme.bold(header) + " " + theme.fg("dim", summary), w), theme.fg("dim", "╭" + "─".repeat(Math.max(0, w - 2)) + "╮")];
	if (vm.rows.length === 0) {
		const message = "no agents dispatched yet";
		lines.push(...Array.from({ length: body }, (_, i) => i === Math.floor(body / 2) ? ellipsis(theme.fg("dim", message.padStart(Math.floor((w + message.length) / 2))), w) : ""));
	} else {
		const offset = Math.max(0, Math.min(vm.scrollOffset ?? 0, Math.max(0, vm.rows.length - body)));
		for (let i = 0; i < body; i++) {
			const row = vm.rows[offset + i];
			if (!row) { lines.push(""); continue; }
			const selected = offset + i === vm.selection.index;
			const indent = row.depth ? "    " + "└ ".repeat(row.depth) : " ";
			const name = `${selected ? "❯" : " "} ${glyph(row)} ${indent}${row.name}`;
			const parts = [name, row.kind, row.model, context(row.contextPct), tokens(row.contextTokens), duration(row.elapsed), row.toolCount == null ? "—" : String(row.toolCount), row.lastWork];
			const count = w < 80 ? 4 : w < 105 ? 6 : 8;
			const line = ellipsis(parts.slice(0, count).join("  "), w);
			lines.push(selected && theme.bg ? theme.bg("selectedBg", line.padEnd(w)) : line);
		}
	}
	lines.push(theme.fg("dim", "╰" + "─".repeat(Math.max(0, w - 2)) + "╯"));
	lines.push(ellipsis(theme.fg("dim", vm.confirmation ?? "↑↓ select · Enter open · x kill · r restart · c continue · f filter · a all · q close"), w));
	return lines.slice(0, body + FLEET_CHROME_ROWS).concat(Array(Math.max(0, body + FLEET_CHROME_ROWS - lines.length)).fill(""));
}

export type DashboardConfirm = { action: "kill" | "restart"; key: string; until: number } | null;
export interface DashboardControllerState {
	selection: Selection;
	scrollOffset: number;
	filtering: boolean;
	filterQuery: string;
	showFinished: boolean;
	confirm: DashboardConfirm;
}
export type DashboardIntent =
	| null
	| "close"
	| { open: string }
	| { kill: string }
	| { restart: string };

/** Pure keyboard transitions for the fleet list controller (mirrors detailTransition). */
export function dashboardTransition(
	input: string,
	state: DashboardControllerState,
	rows: readonly { key: string }[],
	bodyHeight: number,
	now = Date.now(),
): DashboardIntent {
	if (state.filtering) {
		if (input === "\u001b") {
			state.filterQuery = "";
			state.filtering = false;
		} else if (input === "\r") {
			state.filtering = false;
		} else if (input === "\u007f" || input === "\b") {
			state.filterQuery = Array.from(state.filterQuery).slice(0, -1).join("");
		} else if (input.length === 1) {
			state.filterQuery += input;
		}
		return null;
	}
	const selected = rows[state.selection.index];
	if (input === "\u001b[A" || input === "k" || input === "\u001b[B" || input === "j") {
		moveSelection(state.selection, rows, input === "\u001b[A" || input === "k" ? -1 : 1);
		const viewport = Math.max(1, bodyHeight);
		if (state.selection.index < state.scrollOffset) state.scrollOffset = state.selection.index;
		else if (state.selection.index >= state.scrollOffset + viewport) state.scrollOffset = state.selection.index - viewport + 1;
		state.scrollOffset = Math.max(0, Math.min(state.scrollOffset, Math.max(0, rows.length - viewport)));
		return null;
	}
	if (input === "\u001b[5~" || input === "\u001b[6~") {
		const viewport = Math.max(1, bodyHeight);
		moveSelection(state.selection, rows, (input === "\u001b[5~" ? -1 : 1) * viewport);
		state.scrollOffset = Math.max(0, Math.min(state.selection.index, Math.max(0, rows.length - viewport)));
		return null;
	}
	if (input === "f") {
		state.filtering = true;
		return null;
	}
	if (input === "a") {
		state.showFinished = !state.showFinished;
		return null;
	}
	if (input === "\r" && selected) return { open: selected.key };
	if (input === "x" || input === "r") {
		if (!selected) return null;
		const action = input === "x" ? "kill" : "restart";
		if (state.confirm?.action === action && state.confirm.key === selected.key && state.confirm.until > now) {
			state.confirm = null;
			return action === "kill" ? { kill: selected.key } : { restart: selected.key };
		}
		state.confirm = { action, key: selected.key, until: now + 2000 };
		return null;
	}
	if (input === "\u001b" || input === "q") return "close";
	return null;
}
