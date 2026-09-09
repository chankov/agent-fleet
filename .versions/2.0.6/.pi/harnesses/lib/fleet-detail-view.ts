import type { FleetRow } from "./fleet-read-model.ts";
import type { ThemeLike } from "./fleet-dashboard-view.ts";

export interface TimelineEntry {
	kind: "text" | "tool" | "thinking" | "tool-start" | "tool-result";
	title: string;
	content: string;
	timestamp: number;
	callId?: string;
	status?: "success" | "error";
	durationMs?: number;
}
export interface PiModelSummary { provider?: unknown; id?: unknown; name?: unknown; }
export interface FleetModelChoice { spec: string; label: string; }
export interface FleetModelPickerState { index: number; scrollOffset: number; }
export const DETAIL_CHROME_ROWS = 4;
const trim = (s: string, n: number) => Array.from(s).length <= n ? s : n <= 1 ? Array.from(s).slice(0, n).join("") : `${Array.from(s).slice(0, n - 1).join("")}…`;

/** Convert Pi's available model registry into stable, deduplicated picker rows. */
export function fleetModelChoices(models: readonly PiModelSummary[], current?: string): FleetModelChoice[] {
	const bySpec = new Map<string, FleetModelChoice>();
	for (const model of models) {
		const provider = typeof model?.provider === "string" ? model.provider.trim() : "";
		const id = typeof model?.id === "string" ? model.id.trim() : "";
		if (!provider || !id) continue;
		const spec = `${provider}/${id}`;
		if (bySpec.has(spec)) continue;
		const name = typeof model.name === "string" ? model.name.trim() : "";
		const detail = name && name !== id ? ` — ${name}` : "";
		bySpec.set(spec, { spec, label: `${spec}${detail}${spec === current ? " (current)" : ""}` });
	}
	return Array.from(bySpec.values()).sort((a, b) => a.spec.localeCompare(b.spec));
}

/** Render the model picker in the same full-screen layer as Fleet Detail. */
function renderChoicePicker(
	heading: string,
	footer: string,
	choices: readonly FleetModelChoice[],
	state: FleetModelPickerState,
	width: number,
	bodyHeight: number,
	theme: ThemeLike,
): string[] {
	const w = Math.max(1, width), body = Math.max(0, bodyHeight);
	const maxOffset = Math.max(0, choices.length - body);
	const offset = Math.max(0, Math.min(state.scrollOffset, maxOffset));
	const rows = choices.slice(offset, offset + body).map((choice, visibleIndex) => {
		const selected = offset + visibleIndex === state.index;
		const line = trim(`${selected ? " ›" : "  "} ${choice.label}`, w);
		return selected ? theme.fg("accent", theme.bold(line)) : line;
	});
	const lines = [
		theme.bold(trim(heading, w)),
		theme.fg("dim", "╭" + "─".repeat(Math.max(0, w - 2)) + "╮"),
		...rows,
		...Array(Math.max(0, body - rows.length)).fill(""),
		theme.fg("dim", "╰" + "─".repeat(Math.max(0, w - 2)) + "╯"),
		theme.fg("dim", footer),
	];
	return lines.slice(0, body + DETAIL_CHROME_ROWS).concat(Array(Math.max(0, body + DETAIL_CHROME_ROWS - lines.length)).fill(""));
}

export function renderFleetModelPicker(
	title: string,
	choices: readonly FleetModelChoice[],
	state: FleetModelPickerState,
	width: number,
	bodyHeight: number,
	theme: ThemeLike,
): string[] {
	return renderChoicePicker(
		` Model for ${title} · next run · ${choices.length} available`,
		"↑↓ select · PgUp/PgDn page · Home/End · Enter apply · Esc cancel",
		choices, state, width, bodyHeight, theme,
	);
}

/** Render either step of the session-wide source → target substitution flow. */
export function renderFleetSubstitutionPicker(
	stage: "source" | "target",
	source: string | undefined,
	choices: readonly FleetModelChoice[],
	state: FleetModelPickerState,
	width: number,
	bodyHeight: number,
	theme: ThemeLike,
): string[] {
	const heading = stage === "source"
		? ` Substitute model · 1/2 choose configured source · ${choices.length} known`
		: ` Substitute ${source ?? "model"} · 2/2 choose available target · ${choices.length} available`;
	const footer = stage === "source"
		? "↑↓ select · PgUp/PgDn page · Home/End · Enter next · Esc cancel"
		: "↑↓ select · PgUp/PgDn page · Home/End · Enter apply · Esc back";
	return renderChoicePicker(heading, footer, choices, state, width, bodyHeight, theme);
}

export type FleetDetailKey = "up" | "down" | "pageUp" | "pageDown" | "home" | "end" | "enter" | "escape" | "copy";

/** Convert a key identified by Pi's matcher into the detail controller's stable input. */
export function normalizeFleetDetailInput(data: string, key?: FleetDetailKey): string {
	if (key === "up") return "\u001b[A";
	if (key === "down") return "\u001b[B";
	if (key === "pageUp") return "\u001b[5~";
	if (key === "pageDown") return "\u001b[6~";
	if (key === "home") return "\u001b[H";
	if (key === "end") return "\u001b[F";
	if (key === "enter") return "\r";
	if (key === "escape") return "\u001b";
	if (key === "copy") return "\u0003";
	return data;
}

/** Pure navigation for the inline model picker. */
export function modelPickerTransition(
	input: string,
	state: FleetModelPickerState,
	choiceCount: number,
	bodyHeight: number,
): "cancel" | "select" | null {
	if (input === "\u001b" || input === "q" || input === "m") return "cancel";
	if (input === "\r") return choiceCount > 0 ? "select" : null;
	const page = Math.max(1, bodyHeight);
	let next = state.index;
	if (input === "\u001b[A" || input === "k") next--;
	else if (input === "\u001b[B" || input === "j") next++;
	else if (input === "\u001b[5~") next -= page;
	else if (input === "\u001b[6~") next += page;
	else if (input === "\u001b[H") next = 0;
	else if (input === "\u001b[F") next = Math.max(0, choiceCount - 1);
	else return null;
	state.index = Math.max(0, Math.min(Math.max(0, choiceCount - 1), next));
	if (state.index < state.scrollOffset) state.scrollOffset = state.index;
	else if (state.index >= state.scrollOffset + page) state.scrollOffset = state.index - page + 1;
	state.scrollOffset = Math.max(0, Math.min(state.scrollOffset, Math.max(0, choiceCount - page)));
	return null;
}

const isToolEntry = (entry: TimelineEntry | undefined) => entry?.kind === "tool" || entry?.kind === "tool-start" || entry?.kind === "tool-result";

function wrapPlainText(value: string, width: number): string[] {
	const max = Math.max(1, width);
	const output: string[] = [];
	for (const sourceLine of value.split(/\r?\n/)) {
		if (!sourceLine) { output.push(""); continue; }
		let rest = sourceLine;
		while (Array.from(rest).length > max) {
			const chars = Array.from(rest);
			let cut = max;
			for (let i = max; i > Math.floor(max / 2); i--) if (/\s/.test(chars[i] ?? "")) { cut = i; break; }
			output.push(chars.slice(0, cut).join("").trimEnd());
			rest = chars.slice(cut).join("").trimStart();
		}
		output.push(rest);
	}
	return output;
}

function durationLabel(ms: number | undefined): string {
	if (ms == null || !Number.isFinite(ms)) return "";
	return ms < 1000 ? `${Math.max(0, Math.round(ms))}ms` : `${(Math.max(0, ms) / 1000).toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}s`;
}

function detailEntryLines(entry: TimelineEntry, index: number, width: number, expandedIndex: number | null, verbose: boolean, selectedIndex?: number): string[] {
	const w = Math.max(1, width);
	const icon = isToolEntry(entry) ? (entry.kind === "tool-result" ? "◂" : "▸") : entry.kind === "thinking" ? "·" : "•";
	const selected = index === selectedIndex ? "›" : " ";
	const meta = entry.kind === "tool-result"
		? ` [${[entry.status, durationLabel(entry.durationMs)].filter(Boolean).join(" · ")}]`
		: "";
	if (!verbose) {
		if (index === expandedIndex && isToolEntry(entry)) return [trim(`${selected}${icon} ${entry.title}${meta}`, w), ...entry.content.split(/\r?\n/).map(line => `   ${trim(line, Math.max(0, w - 3))}`)];
		return [trim(`${selected}${icon} ${entry.title}${meta}  ${entry.content.replace(/\s+/g, " ")}`, w)];
	}
	const heading = trim(`${selected}${icon} ${entry.title}`, w);
	const metadata = meta ? wrapPlainText(meta.trim(), Math.max(1, w - 3)).map(line => trim(`   ${line}`, w)) : [];
	const payload = wrapPlainText(entry.content, Math.max(1, w - 3)).map(line => trim(`   ${line}`, w));
	return [heading, ...metadata, ...payload];
}

export interface DetailEntryOffset { index: number; start: number; end: number; }

/** Locate each logical event inside its wrapped visual lines. */
export function detailEntryOffsets(timeline: readonly TimelineEntry[], width: number, expandedIndex: number | null, verbose: boolean): DetailEntryOffset[] {
	const offsets: DetailEntryOffset[] = [];
	let cursor = 0;
	for (let index = 0; index < timeline.length; index++) {
		const length = detailEntryLines(timeline[index], index, width, expandedIndex, verbose).length;
		offsets.push({ index, start: cursor, end: cursor + length });
		cursor += length;
	}
	return offsets;
}

export function detailContent(timeline: readonly TimelineEntry[], width: number, expandedIndex: number | null, verbose = false, selectedIndex?: number): string[] {
	return timeline.flatMap((entry, index) => detailEntryLines(entry, index, width, expandedIndex, verbose, selectedIndex));
}

/** Render a constant-height transcript detail screen, including the no-local-peer notice. */
export function renderFleetDetail(row: FleetRow, timeline: readonly TimelineEntry[], scrollOffset: number, width: number, bodyHeight: number, theme: ThemeLike, expandedIndex: number | null = null, verbose = false, selectedIndex?: number): string[] {
	const w = Math.max(1, width), body = Math.max(0, bodyHeight);
	const mode = verbose ? "Verbose" : "Compact";
	const header = trim(` ${row.name} · ${mode} · ${row.status} · ${row.kind} · ${row.model} · ${row.backend} · ${row.contextPct == null ? "context automatic" : `${Math.round(row.contextPct)}%`} · ${Math.round(row.elapsed / 1000)}s · ${row.toolCount ?? "—"} tools`, w);
	const lines = [theme.bold(header), theme.fg("dim", "╭" + "─".repeat(Math.max(0, w - 2)) + "╮")];
	if (!row.hasTimeline) lines.push(...Array.from({ length: body }, (_, i) => i === 0 ? theme.fg("dim", " no local transcript for this coms peer") : ""));
	else {
		const content = detailContent(timeline, w, expandedIndex, verbose, selectedIndex);
		const offset = Math.max(0, Math.min(scrollOffset, Math.max(0, content.length - body)));
		lines.push(...content.slice(offset, offset + body), ...Array(Math.max(0, body - content.slice(offset, offset + body).length)).fill(""));
	}
	lines.push(theme.fg("dim", "╰" + "─".repeat(Math.max(0, w - 2)) + "╯"));
	const modelHint = row.kind === "peer" ? "" : " · m model";
	lines.push(theme.fg("dim", `↑↓ scroll · PgUp/PgDn page · End tail · Enter expand tool · v ${verbose ? "compact" : "verbose"} · Ctrl+C copy${modelHint} · Esc dashboard`));
	return lines.slice(0, body + DETAIL_CHROME_ROWS).concat(Array(Math.max(0, body + DETAIL_CHROME_ROWS - lines.length)).fill(""));
}

/** Pure state transitions used by the harness detail controller. */
export function detailTransition(
	input: string,
	state: { scrollOffset: number; selectedIndex: number; expandedIndex: number | null; followTail: boolean; verbose?: boolean },
	timeline: readonly TimelineEntry[],
	bodyHeight: number,
	contentLength = timeline.length,
	offsets?: readonly DetailEntryOffset[],
): "close" | "copy" | "model" | null {
	const viewport = Math.max(1, bodyHeight);
	const max = Math.max(0, contentLength - viewport);
	if (input === "\u001b" || input === "q") return "close";
	if (input === "\u0003") return "copy";
	if (input === "m") return "model";
	if (input === "v") { state.verbose = !state.verbose; state.followTail = true; return null; }
	if (input === "\u001b[F") { state.followTail = true; state.scrollOffset = max; state.selectedIndex = Math.max(0, timeline.length - 1); return null; }
	if (input === "\u001b[H") { state.followTail = false; state.scrollOffset = 0; state.selectedIndex = 0; return null; }
	if (input === "\r") { if (isToolEntry(timeline[state.selectedIndex])) state.expandedIndex = state.expandedIndex === state.selectedIndex ? null : state.selectedIndex; return null; }
	const delta = input === "\u001b[A" || input === "k" ? -1 : input === "\u001b[B" || input === "j" ? 1 : input === "\u001b[5~" ? -bodyHeight : input === "\u001b[6~" ? bodyHeight : 0;
	if (delta) {
		state.followTail = false;
		state.selectedIndex = Math.max(0, Math.min(Math.max(0, timeline.length - 1), state.selectedIndex + delta));
		const selected = offsets?.[state.selectedIndex];
		if (selected) {
			if (selected.start < state.scrollOffset) state.scrollOffset = selected.start;
			else if (selected.start >= state.scrollOffset + viewport) state.scrollOffset = selected.start - viewport + 1;
		} else state.scrollOffset += delta;
		state.scrollOffset = Math.max(0, Math.min(max, state.scrollOffset));
	}
	return null;
}
