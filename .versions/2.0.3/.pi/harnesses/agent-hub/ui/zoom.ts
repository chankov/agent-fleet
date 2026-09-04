import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { DynamicBorder, getMarkdownTheme as getPiMdTheme, copyToClipboard } from "@mariozechner/pi-coding-agent";
import { Text, Box, Container, Spacer, Markdown, matchesKey, Key, truncateToWidth } from "@mariozechner/pi-tui";
import { FULLSCREEN_OVERLAY, bodyRows, fitToHeight } from "../../lib/fleet-overlay.ts";
import { createPanelResources } from "../../lib/fleet-panel.ts";

export interface TimelineEntry {
	kind: "text" | "tool" | "thinking" | "tool-start" | "tool-result";
	title: string;
	content: string;
	timestamp: number;
	callId?: string;
	status?: "success" | "error";
	durationMs?: number;
}

export interface Zoomable {
	def: { name: string };
	status: string;
	timeline: TimelineEntry[];
	zoomRender?: (force?: boolean) => void;
}

function displayName(name: string): string {
	return name.split("-").map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

export const ZOOM_CHROME_ROWS = 5;

export class ZoomUI {
	private selectedIndex = 0;
	private expandedIndex: number | null = null;
	private scrollOffset = 0;
	private followTail = true;
	private autoExpandedTailIndex: number | null = null;

	constructor(
		private state: Zoomable,
		private onDone: () => void,
		private notify: (message: string, type?: "info" | "success" | "warning" | "error") => void,
	) {}

	handleInput(data: string, tui: any): void {
		const n = this.state.timeline.length;
		if (matchesKey(data, Key.up)) {
			this.followTail = false;
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
		} else if (matchesKey(data, Key.down)) {
			this.selectedIndex = Math.min(n - 1, this.selectedIndex + 1);
			if (this.selectedIndex >= n - 1) this.followTail = true;
		} else if (matchesKey(data, Key.enter)) {
			this.expandedIndex = this.expandedIndex === this.selectedIndex ? null : this.selectedIndex;
			if (this.followTail && this.selectedIndex >= n - 1) this.autoExpandedTailIndex = this.selectedIndex;
		} else if (matchesKey(data, Key.space) || matchesKey(data, Key.ctrl("c"))) {
			void this.copySelected();
		} else if (matchesKey(data, Key.escape) || matchesKey(data, "q") || matchesKey(data, Key.shift("q"))) {
			this.onDone();
			return;
		}
		tui.requestRender();
	}

	private async copySelected(): Promise<void> {
		const item = this.state.timeline[this.selectedIndex];
		if (!item) return;
		try {
			await copyToClipboard(item.content);
			this.notify("Copied selected zoom row", "success");
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.notify(`Failed to copy selected zoom row: ${message}`, "error");
		}
	}

	// Render one timeline entry (card + trailing spacer) to its exact lines, so the
	// scroll math and viewport capping can use real heights — an expanded markdown
	// entry is many lines, a collapsed one is two. Mirrors the old inline card build.
	private renderItemBlock(item: TimelineEntry, absoluteIndex: number, width: number, theme: any, mdTheme: any): string[] {
		const isSelected = absoluteIndex === this.selectedIndex;
		const isExpanded = isSelected && absoluteIndex === this.expandedIndex;

		const cardBox = new Box(1, 0, (s: string) => isSelected ? theme.bg("selectedBg", s) : s);

		let icon = "○", color = "dim";
		if (item.kind === "text") { icon = "🤖"; color = "accent"; }
		else if (item.kind === "tool") { icon = "🛠️"; color = "warning"; }
		else if (item.kind === "thinking") { icon = "💭"; color = "dim"; }

		cardBox.addChild(new Text(`${theme.fg(color, icon)} ${theme.bold(item.title)}`, 0, 0));

		if (isExpanded) {
			cardBox.addChild(new Spacer(1));
			cardBox.addChild(new Markdown(item.content || "(empty)", 2, 0, mdTheme));
		} else {
			const flat = (item.content || "").replace(/\s+/g, " ").trim();
			const preview = truncateToWidth(flat, Math.max(0, width - 8));
			cardBox.addChild(new Text(theme.fg("dim", "  " + (preview || "…")), 0, 0));
		}

		const block = new Container();
		block.addChild(cardBox);
		block.addChild(new Spacer(1));
		return block.render(width);
	}

	// Height-aware scroll: scroll the viewport so the selected entry's FULL height
	// fits in the content budget. Entries above the selection may be tall (expanded
	// markdown), so a per-entry-is-one-line assumption clipped the last/expanded
	// entry below the fold — this counts real line heights instead.
	private ensureVisible(heights: number[], contentHeight: number) {
		if (this.selectedIndex < this.scrollOffset) this.scrollOffset = this.selectedIndex;
		const sumToSelected = (from: number): number => {
			let s = 0;
			for (let i = from; i <= this.selectedIndex; i++) s += heights[i] ?? 0;
			return s;
		};
		// Push the top of the window down until the selected entry fits (or it is
		// the only entry shown, in which case the overlay clips a too-tall entry).
		while (this.scrollOffset < this.selectedIndex && sumToSelected(this.scrollOffset) > contentHeight) {
			this.scrollOffset++;
		}
		if (this.scrollOffset < 0) this.scrollOffset = 0;
	}

	render(width: number, contentHeight: number, theme: any): string[] {
		const items = this.state.timeline;
		// Live tail-follow: keep the selection pinned to the newest entry as the
		// stream grows, until the user scrolls up. Auto-expand each new tail entry
		// once so the latest message opens full, while still allowing Enter to collapse it.
		if (this.followTail && items.length > 0) {
			this.selectedIndex = items.length - 1;
			if (this.autoExpandedTailIndex !== this.selectedIndex) {
				this.expandedIndex = this.selectedIndex;
				this.autoExpandedTailIndex = this.selectedIndex;
			}
		}
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, items.length - 1));

		const mdTheme = getPiMdTheme();
		const st = this.state.status;
		const statusColor = st === "error" ? "error" : st === "running" ? "warning" : "success";

		// Chrome (border + header + footer) is rendered separately from the body so
		// the body can be windowed to an exact line budget — header and footer always
		// stay visible no matter how tall the expanded entries are.
		const top = new Container();
		top.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		top.addChild(new Text(
			`${theme.fg("accent", theme.bold(" ZOOM"))} ${theme.fg("dim", "|")} ${theme.bold(displayName(this.state.def.name))} ${theme.fg("dim", "|")} ${theme.fg(statusColor, st)} ${theme.fg("dim", "|")} ${theme.fg("success", String(items.length))} events`,
			1, 0,
		));
		top.addChild(new Spacer(1));
		const topLines = top.render(width);

		const bottom = new Container();
		bottom.addChild(new Text(theme.fg("dim", " ↑/↓ Navigate • Enter Collapse/Expand • Space/Ctrl+C Copy • Q/Esc Close • live"), 1, 0));
		bottom.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		const bottomLines = bottom.render(width);
		const bodyHeight = Math.max(0, contentHeight + ZOOM_CHROME_ROWS - topLines.length - bottomLines.length);

		let bodyLines: string[];
		if (items.length === 0) {
			bodyLines = [theme.fg("dim", "  No activity captured yet.")];
		} else {
			const blocks = items.map((item, i) => this.renderItemBlock(item, i, width, theme, mdTheme));
			const heights = blocks.map(b => b.length);
			this.ensureVisible(heights, bodyHeight);
			bodyLines = [];
			for (let i = this.scrollOffset; i < blocks.length; i++) {
				// Always show the first windowed entry (the selected one fits by
				// construction); stop before a later entry would overflow the budget.
				if (bodyLines.length > 0 && bodyLines.length + heights[i] > bodyHeight) break;
				bodyLines.push(...blocks[i]);
			}
		}

		return fitToHeight([...topLines, ...fitToHeight(bodyLines, bodyHeight), ...bottomLines], contentHeight + ZOOM_CHROME_ROWS);
	}
}


export async function openZoom(target: Zoomable, ctx: ExtensionContext): Promise<void> {
	const resources = createPanelResources();
	let lastRender = 0;
	try {
		await ctx.ui.custom((tui: any, theme: any, _kb: any, done: (result: unknown) => void) => {
			const ui = new ZoomUI(target, () => done(undefined), (message, type) => ctx.ui.notify(message, type));
			target.zoomRender = (force?: boolean) => {
				const now = Date.now();
				if (force || now - lastRender > 80) { lastRender = now; tui.requestRender(); }
			};
			resources.onDispose(() => { target.zoomRender = undefined; });
			return {
				render: (w: number) => ui.render(w, bodyRows(tui.terminal?.rows, ZOOM_CHROME_ROWS), theme),
				handleInput: (data: string) => ui.handleInput(data, tui),
				invalidate: () => {},
				dispose: () => resources.dispose(),
			};
		}, FULLSCREEN_OVERLAY);
	} finally {
		resources.dispose();
		target.zoomRender = undefined;
	}
}
