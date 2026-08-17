import type { FleetRow } from "./fleet-read-model.ts";
import type { ThemeLike } from "./fleet-dashboard-view.ts";

export interface TimelineEntry { kind: "text" | "tool" | "thinking"; title: string; content: string; timestamp: number; }
export const DETAIL_CHROME_ROWS = 4;
const trim = (s: string, n: number) => Array.from(s).length <= n ? s : n <= 1 ? Array.from(s).slice(0, n).join("") : `${Array.from(s).slice(0, n - 1).join("")}…`;

export function detailContent(timeline: readonly TimelineEntry[], width: number, expandedIndex: number | null): string[] {
	const w = Math.max(1, width);
	return timeline.flatMap((entry, index) => {
		const icon = entry.kind === "tool" ? "▸" : entry.kind === "thinking" ? "·" : "•";
		if (index === expandedIndex && entry.kind === "tool") return [` ${icon} ${entry.title}`, ...entry.content.split(/\r?\n/).map(line => `   ${trim(line, Math.max(0, w - 3))}`)];
		return [` ${icon} ${trim(`${entry.title}  ${entry.content.replace(/\s+/g, " ")}`, Math.max(0, w - 1))}`];
	});
}

/** Render a constant-height transcript detail screen, including the no-local-peer notice. */
export function renderFleetDetail(row: FleetRow, timeline: readonly TimelineEntry[], scrollOffset: number, width: number, bodyHeight: number, theme: ThemeLike, expandedIndex: number | null = null): string[] {
	const w = Math.max(1, width), body = Math.max(0, bodyHeight);
	const header = trim(` ${row.name} · ${row.status} · ${row.kind} · ${row.model} · ${row.backend} · ${row.contextPct == null ? "context automatic" : `${Math.round(row.contextPct)}%`} · ${Math.round(row.elapsed / 1000)}s · ${row.toolCount ?? "—"} tools`, w);
	const lines = [theme.bold(header), theme.fg("dim", "╭" + "─".repeat(Math.max(0, w - 2)) + "╮")];
	if (!row.hasTimeline) lines.push(...Array.from({ length: body }, (_, i) => i === 0 ? theme.fg("dim", " no local transcript for this coms peer") : ""));
	else {
		const content = detailContent(timeline, w, expandedIndex);
		const offset = Math.max(0, Math.min(scrollOffset, Math.max(0, content.length - body)));
		lines.push(...content.slice(offset, offset + body), ...Array(Math.max(0, body - content.slice(offset, offset + body).length)).fill(""));
	}
	lines.push(theme.fg("dim", "╰" + "─".repeat(Math.max(0, w - 2)) + "╯"));
	lines.push(theme.fg("dim", "↑↓ scroll · PgUp/PgDn page · End tail · Enter expand tool · Ctrl+C copy · Esc dashboard"));
	return lines.slice(0, body + DETAIL_CHROME_ROWS).concat(Array(Math.max(0, body + DETAIL_CHROME_ROWS - lines.length)).fill(""));
}

/** Pure state transitions used by the harness detail controller. */
export function detailTransition(input: string, state: { scrollOffset: number; selectedIndex: number; expandedIndex: number | null; followTail: boolean }, timeline: readonly TimelineEntry[], bodyHeight: number, contentLength = timeline.length): "close" | "copy" | null {
	const max = Math.max(0, contentLength - Math.max(1, bodyHeight));
	if (input === "\u001b" || input === "q") return "close";
	if (input === "\u0003") return "copy";
	if (input === "\u001b[F") { state.followTail = true; state.scrollOffset = max; return null; }
	if (input === "\r") { if (timeline[state.selectedIndex]?.kind === "tool") state.expandedIndex = state.expandedIndex === state.selectedIndex ? null : state.selectedIndex; return null; }
	const delta = input === "\u001b[A" || input === "k" ? -1 : input === "\u001b[B" || input === "j" ? 1 : input === "\u001b[5~" ? -bodyHeight : input === "\u001b[6~" ? bodyHeight : 0;
	if (delta) { state.followTail = false; state.selectedIndex = Math.max(0, Math.min(Math.max(0, timeline.length - 1), state.selectedIndex + delta)); state.scrollOffset = Math.max(0, Math.min(max, state.scrollOffset + delta)); }
	return null;
}
