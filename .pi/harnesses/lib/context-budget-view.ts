import { clampScroll, fitToHeight } from "./fleet-overlay.ts";
import { moveSelection, reconcileSelection, type Selection } from "./fleet-selection.ts";
import type { ContextBudgetSnapshot } from "../agent-hub/context-budget-snapshot.ts";

export interface ContextBudgetViewState { selection: Selection; expanded: Set<string>; scrollOffset: number; }
export const CONTEXT_BUDGET_CHROME_ROWS = 5;
const tokens = (n: number | undefined) => n == null ? "—" : Intl.NumberFormat("en").format(Math.round(n));
const pct = (n: number | undefined) => n == null ? "window unknown" : `${n.toFixed(1)}%`;
const ANSI = /\x1B\[[0-?]*[ -\/]*[@-~]/;
/** Truncate by terminal cells while never cutting an ANSI escape sequence. */
export function ansiTruncate(value: string, width: number): string {
	let cells = 0; let out = "";
	for (let i = 0; i < value.length;) {
		const escape = value.slice(i).match(/^\x1B\[[0-?]*[ -\/]*[@-~]/)?.[0];
		if (escape) { out += escape; i += escape.length; continue; }
		const char = String.fromCodePoint(value.codePointAt(i)!); if (cells + 1 > width) break;
		out += char; cells++; i += char.length;
	}
	return out + (ANSI.test(out) ? "\x1b[0m" : "");
}

function groupKey(category: string): string {
	if (category === "tool") return "group/tools";
	if (category === "addon") return "group/addons";
	if (category === "skill") return "group/skills";
	if (category === "conversation") return "group/conversation";
	if (category === "project") return "group/project";
	if (category === "roster" || category === "persona") return "group/roster";
	return "group/system";
}

export interface ContextBudgetRow { key: string; label: string; detail: string; expandable?: boolean; }

export function contextBudgetRows(snapshot: ContextBudgetSnapshot, expanded: Set<string> = new Set()): ContextBudgetRow[] {
	const groups = new Map<string, { key: string; label: string; children: ContextBudgetRow[] }>();
	const order = ["group/system", "group/project", "group/roster", "group/tools", "group/addons", "group/skills", "group/conversation"];
	for (const component of snapshot.components) {
		const key = groupKey(component.category);
		if (!groups.has(key)) groups.set(key, { key, label: key.replace("group/", ""), children: [] });
		groups.get(key)!.children.push({
			key: `hub/${component.id}`,
			label: `  ${component.label}`,
			detail: `${component.visibility} · ${component.confidence} · ${tokens(component.adjustedTokens ?? component.estimatedTokens)} tok`,
		});
	}
	const rows: ContextBudgetRow[] = [];
	for (const key of order) {
		const group = groups.get(key);
		if (!group) continue;
		rows.push({ key: group.key, label: group.label, detail: `${group.children.length} items`, expandable: true });
		if (expanded.has(group.key)) rows.push(...group.children);
	}
	for (const plane of snapshot.planes) {
		const key = `plane/${plane.summary.plane}/${plane.components[0]?.id ?? plane.summary.plane}`;
		rows.push({ key, label: `${plane.summary.plane} plane`, detail: `${tokens(plane.summary.measuredTokens)} / ${tokens(plane.summary.window)} · ${pct(plane.summary.occupancyPercent)}`, expandable: true });
		if (expanded.has(key)) {
			for (const component of plane.components) {
				rows.push({ key: `${key}/${component.id}`, label: `  ${component.label}`, detail: `${component.confidence} · ${tokens(component.adjustedTokens ?? component.estimatedTokens)} tok` });
			}
		}
	}
	return rows;
}

function keepSelectionVisible(state: ContextBudgetViewState, rows: readonly ContextBudgetRow[], bodyHeight: number): void {
	const viewport = Math.max(1, bodyHeight);
	if (state.selection.index < state.scrollOffset) state.scrollOffset = state.selection.index;
	else if (state.selection.index >= state.scrollOffset + viewport) state.scrollOffset = state.selection.index - viewport + 1;
	state.scrollOffset = clampScroll(state.scrollOffset, rows.length, viewport);
}

export function contextBudgetTransition(data: string, state: ContextBudgetViewState, snapshot: ContextBudgetSnapshot, bodyHeight: number): "close" | "refresh" | undefined {
	let rows = contextBudgetRows(snapshot, state.expanded); reconcileSelection(state.selection, rows);
	if (data === "q" || data === "\u001b") return "close";
	if (data === "r") return "refresh";
	if (data === "\u001b[A") moveSelection(state.selection, rows, -1);
	else if (data === "\u001b[B") moveSelection(state.selection, rows, 1);
	else if (data === "\u001b[5~") moveSelection(state.selection, rows, -Math.max(1, bodyHeight));
	else if (data === "\u001b[6~") moveSelection(state.selection, rows, Math.max(1, bodyHeight));
	else if (data === "g") { state.selection.index = 0; state.selection.key = rows[0]?.key; }
	else if (data === "G") { state.selection.index = Math.max(0, rows.length - 1); state.selection.key = rows.at(-1)?.key; }
	else if (data === "\r" && rows[state.selection.index]?.expandable) {
		const key = state.selection.key!;
		state.expanded.has(key) ? state.expanded.delete(key) : state.expanded.add(key);
		rows = contextBudgetRows(snapshot, state.expanded);
		reconcileSelection(state.selection, rows);
	}
	keepSelectionVisible(state, rows, bodyHeight);
	return undefined;
}

/** Fixed-height, metadata-only overlay rendering. */
export function renderContextBudget(snapshot: ContextBudgetSnapshot, state: ContextBudgetViewState, width: number, height: number): string[] {
	const rows = contextBudgetRows(snapshot, state.expanded); reconcileSelection(state.selection, rows);
	keepSelectionVisible(state, rows, Math.max(0, height - 2));
	const hub = snapshot.hub.summary;
	const header = ansiTruncate(`CONTEXT BUDGET  ${snapshot.model ?? "model unknown"} · ${tokens(hub.measuredTokens)} / ${tokens(hub.window)} (${pct(hub.occupancyPercent)}) · ${snapshot.estimator}`, Math.max(1, width));
	const visible = rows.slice(state.scrollOffset, state.scrollOffset + Math.max(0, height - 2));
	const body = visible.map((row) => ansiTruncate(`${state.selection.key === row.key ? ">" : " "} ${row.label} — ${row.detail}`, Math.max(1, width)));
	const footer = ansiTruncate(`Attributed ${tokens(hub.attributedTokens)} · residual ${tokens(hub.residualTokens)} · ↑↓ Enter r q`, Math.max(1, width));
	return fitToHeight([header, ...fitToHeight(body, Math.max(0, height - 2)), footer], height);
}
