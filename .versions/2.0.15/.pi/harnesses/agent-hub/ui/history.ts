import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Text, Container, Spacer, matchesKey, Key, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { FULLSCREEN_OVERLAY, bodyRows, fitToHeight } from "../../lib/fleet-overlay.ts";
import { createPanelResources } from "../../lib/fleet-panel.ts";
import { unionMs } from "../../lib/fleet-read-model.ts";
import type { ExecutionHistoryStore, HistoryEntry } from "./history-store.ts";

function fmtDuration(ms: number): string {
	const totalSec = Math.max(0, Math.round(ms / 1000));
	if (totalSec < 60) return `${totalSec}sec`;
	const m = Math.floor(totalSec / 60);
	const s = totalSec % 60;
	return `${m}:${String(s).padStart(2, "0")}min`;
}

export const HISTORY_CHROME_ROWS = 6;

export class HistoryUI {
	private scrollOffset = 0;
	private followTail = true;

	constructor(
		private getEntries: () => HistoryEntry[],
		private getLabel: () => string,
		private onDone: () => void,
	) {}

	handleInput(data: string, tui: any): void {
		if (matchesKey(data, Key.up)) {
			this.followTail = false;
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
		} else if (matchesKey(data, Key.down)) {
			this.followTail = false;
			this.scrollOffset++;
		} else if (matchesKey(data, "g") || matchesKey(data, Key.shift("g"))) {
			this.followTail = true; // jump back to the live tail
		} else if (matchesKey(data, Key.escape) || matchesKey(data, "q") || matchesKey(data, Key.shift("q"))) {
			this.onDone();
			return;
		}
		tui.requestRender();
	}

	private statusGlyph(e: HistoryEntry, theme: any): string {
		if (e.status === "running") return theme.fg("warning", "●");
		if (e.status === "done") return theme.fg("success", "✓");
		if (e.status === "error") return theme.fg("error", "✗");
		return theme.fg("dim", "⊘");
	}

	// Pad a styled left segment to the full width with a right-aligned duration.
	// Width math uses visibleWidth (ANSI-aware); the styled string is only truncated
	// when it would actually overflow, so colors stay intact in the common case.
	private rowLine(styledLeft: string, dur: string, width: number, theme: any): string {
		const budget = Math.max(0, width - dur.length - 2);
		let left = styledLeft;
		let w = visibleWidth(styledLeft);
		if (w > budget) {
			left = truncateToWidth(styledLeft, budget);
			w = visibleWidth(left);
		}
		const gap = Math.max(1, width - w - dur.length - 1);
		return ` ${left}${" ".repeat(gap)}${dur ? theme.fg("dim", dur) : ""}`;
	}

	// A node's *real work*: its own span minus the time it spent awaiting — both its
	// children (the union of their runs) and, for a dispatcher, any `ask_user` waits
	// (`awaitIntervals`). All clipped to the node's own window and unioned together,
	// so overlapping awaits are never subtracted twice. A leaf with no awaits returns
	// its full span; a dispatcher blocked on six concurrent agents (or on the human)
	// is credited only for the time it was actually working between/around the awaits.
	private realWorkMs(entry: HistoryEntry, kids: HistoryEntry[], now: number): number {
		const start = entry.startedAt;
		const end = entry.endedAt ?? now;
		const span = end - start;
		const intervals: Array<[number, number]> = [];
		for (const k of kids) {
			const s = Math.max(k.startedAt, start);
			const e = Math.min(k.endedAt ?? now, end);
			if (e > s) intervals.push([s, e]);
		}
		for (const [s0, e0] of entry.awaitIntervals ?? []) {
			const s = Math.max(s0, start);
			const e = Math.min(e0, end);
			if (e > s) intervals.push([s, e]);
		}
		if (intervals.length === 0) return Math.max(0, span);
		return Math.max(0, span - unionMs(intervals));
	}

	// Group entries by parent (children sorted by start time). Shared by buildRows
	// (tree walk) and render (footer total), so the tree is built once per frame.
	private groupByParent(entries: HistoryEntry[]): Map<HistoryEntry | null, HistoryEntry[]> {
		const childrenOf = new Map<HistoryEntry | null, HistoryEntry[]>();
		for (const e of entries) {
			const arr = childrenOf.get(e.parent) ?? [];
			arr.push(e);
			childrenOf.set(e.parent, arr);
		}
		for (const arr of childrenOf.values()) arr.sort((a, b) => a.startedAt - b.startedAt);
		return childrenOf;
	}

	// Build the display rows by walking the parent→child tree. Siblings are sorted by
	// start time; those whose runs overlap form a "wave" and are marked parallel
	// (a "│→" connector). Indentation tracks tree depth, so delegate sub-sub-agents
	// nest under the specialist that spawned them.
	private buildRows(childrenOf: Map<HistoryEntry | null, HistoryEntry[]>, width: number, theme: any, now: number): string[] {
		// Mark parallel waves within each sibling group.
		const parallel = new Set<HistoryEntry>();
		for (const arr of childrenOf.values()) {
			let waveStart = 0;
			let waveMaxEnd = -Infinity;
			const flush = (endIdx: number) => {
				if (endIdx - waveStart >= 2) {
					for (let i = waveStart; i < endIdx; i++) parallel.add(arr[i]);
				}
			};
			for (let i = 0; i < arr.length; i++) {
				const end = arr[i].endedAt ?? now;
				if (i === waveStart) {
					waveMaxEnd = end;
				} else if (arr[i].startedAt < waveMaxEnd) {
					waveMaxEnd = Math.max(waveMaxEnd, end);
				} else {
					flush(i);
					waveStart = i;
					waveMaxEnd = end;
				}
			}
			flush(arr.length);
		}

		const rows: string[] = [];
		const walk = (entry: HistoryEntry, depth: number) => {
			const kids = childrenOf.get(entry) ?? [];
			const dur = fmtDuration(this.realWorkMs(entry, kids, now));
			const glyph = this.statusGlyph(entry, theme);
			const isPar = parallel.has(entry);
			const pad = "  ".repeat(depth);
			const connector = isPar ? theme.fg("accent", "│→ ") : "";
			let label: string;
			if (entry.kind === "orchestrator") {
				label = `${theme.bold(theme.fg("accent", entry.name))} ${theme.fg("dim", "(dispatcher)")}`;
			} else if (entry.kind === "delegate") {
				label = `${theme.fg("dim", entry.name)} ${theme.fg("dim", "(delegate)")}`;
			} else {
				label = isPar ? theme.fg("muted", entry.name) : entry.name;
			}
			rows.push(this.rowLine(`${pad}${connector}${glyph} ${label}`, dur, width, theme));
			for (const child of kids) walk(child, depth + 1);
		};
		for (const top of childrenOf.get(null) ?? []) walk(top, 0);
		return rows;
	}

	render(width: number, contentHeight: number, theme: any): string[] {
		const entries = this.getEntries();
		const now = Date.now();
		const runningCount = entries.filter(e => e.status === "running" && e.kind !== "orchestrator").length;

		const top = new Container();
		top.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		top.addChild(new Text(
			`${theme.fg("accent", theme.bold(" AGENTS HISTORY"))} ${theme.fg("dim", "|")} ${theme.bold(this.getLabel())} ${theme.fg("dim", "|")} ${theme.fg("warning", String(runningCount))} running`,
			1, 0,
		));
		top.addChild(new Spacer(1));
		const topLines = top.render(width);

		const childrenOf = this.groupByParent(entries);

		// Footer total = the real work of everyone: the dispatched specialists' and
		// research helpers' full runtime PLUS each dispatcher turn's own work (its span
		// minus the time it awaited agents and the human via ask_user). Wall-clock is
		// intentionally NOT shown — it would fold in the idle gaps between turns.
		const runEntries = entries.filter(e => e.kind === "agent" || e.kind === "research");
		const dispatchers = entries.filter(e => e.kind === "orchestrator");
		let summaryLine = theme.fg("dim", " No agent activity yet.");
		if (runEntries.length > 0 || dispatchers.length > 0) {
			const agentMs = runEntries.reduce((n, e) => n + ((e.endedAt ?? now) - e.startedAt), 0);
			const dispatcherMs = dispatchers.reduce((n, e) => n + this.realWorkMs(e, childrenOf.get(e) ?? [], now), 0);
			summaryLine =
				theme.fg("success", theme.bold(` Σ real work ${fmtDuration(agentMs + dispatcherMs)}`)) +
				theme.fg("dim", ` · ${runEntries.length} runs  (agents ${fmtDuration(agentMs)} + dispatchers ${fmtDuration(dispatcherMs)})`);
		}

		const bottom = new Container();
		bottom.addChild(new Text(summaryLine, 1, 0));
		bottom.addChild(new Text(theme.fg("dim", " ↑/↓ Scroll • G Live tail • Q/Esc Close"), 1, 0));
		bottom.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		const bottomLines = bottom.render(width);

		const rows = this.buildRows(childrenOf, width, theme, now);
		const bodyHeight = Math.max(0, contentHeight + HISTORY_CHROME_ROWS - topLines.length - bottomLines.length);

		let bodyLines: string[];
		if (rows.length === 0) {
			bodyLines = [theme.fg("dim", "  No dispatches yet — history fills as agents run.")];
		} else {
			const maxOffset = Math.max(0, rows.length - bodyHeight);
			if (this.followTail) this.scrollOffset = maxOffset;
			this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxOffset));
			bodyLines = rows.slice(this.scrollOffset, this.scrollOffset + bodyHeight);
		}

		return fitToHeight([...topLines, ...fitToHeight(bodyLines, bodyHeight), ...bottomLines], contentHeight + HISTORY_CHROME_ROWS);
	}
}


export async function openHistory(
	ctx: ExtensionContext,
	store: ExecutionHistoryStore,
	getLabel: () => string,
): Promise<void> {
	const resources = createPanelResources();
	try {
		await ctx.ui.custom((tui: any, theme: any, _kb: any, done: (result: unknown) => void) => {
			const ui = new HistoryUI(() => [...store.entries()], getLabel, () => done(undefined));
			resources.onDispose(store.onChange(() => tui.requestRender()));
			resources.every(1000, () => tui.requestRender());
			return {
				render: (w: number) => ui.render(w, bodyRows(tui.terminal?.rows, HISTORY_CHROME_ROWS), theme),
				handleInput: (data: string) => ui.handleInput(data, tui),
				invalidate: () => {},
				dispose: () => resources.dispose(),
			};
		}, FULLSCREEN_OVERLAY);
	} finally {
		resources.dispose();
	}
}
