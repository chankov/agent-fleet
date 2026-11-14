/**
 * fleet-config/transition — keyboard intent for the /af-config overlay.
 * Input is the raw terminal sequence (or the normalized aliases below); the
 * host maps pi Key ids onto these before calling.
 */
import { moveSelection, reconcileSelection } from "../fleet-selection.ts";
import type { FleetConfigSnapshot } from "./snapshot.ts";
import { cyclePreset, draftFromSnapshot, sameDraft, toggleFeature } from "./mutations.ts";
import { fleetConfigRows, fleetConfigTabs, keepSelectionVisible, type FleetConfigViewState, type TabId } from "./view.ts";

export type FleetConfigIntent = "close" | "refresh" | "inspect" | "apply" | "configure" | { open: string } | undefined;

export const KEYS = { up: "\u001b[A", down: "\u001b[B", right: "\u001b[C", left: "\u001b[D", pageUp: "\u001b[5~", pageDown: "\u001b[6~", enter: "\r", escape: "\u001b", tab: "\t", shiftTab: "\u001b[Z" } as const;

export function switchTab(state: FleetConfigViewState, tab: TabId): void {
	if (state.tab === tab) return;
	state.tab = tab;
	state.selection = { index: 0 };
	state.scrollOffset = 0;
}

export function fleetConfigTransition(data: string, state: FleetConfigViewState, snapshot: FleetConfigSnapshot, bodyHeight: number): FleetConfigIntent {
	const tabs = fleetConfigTabs(snapshot);
	if (!tabs.includes(state.tab)) switchTab(state, "overview");
	if (data === "q" || data === KEYS.escape) return "close";
	if (data === "r") return "refresh";
	if (data === "i") return "inspect";
	const current = tabs.indexOf(state.tab);
	if (data === KEYS.right || data === KEYS.tab) { switchTab(state, tabs[(current + 1) % tabs.length]); return undefined; }
	if (data === KEYS.left || data === KEYS.shiftTab) { switchTab(state, tabs[(current - 1 + tabs.length) % tabs.length]); return undefined; }
	if (/^[0-9]$/.test(data)) {
		const index = data === "0" ? 9 : Number(data) - 1;
		if (tabs[index]) switchTab(state, tabs[index]);
		return undefined;
	}
	let rows = fleetConfigRows(snapshot, state.tab, state.expanded, state);
	reconcileSelection(state.selection, rows);
	if (state.tab === "setup") {
		const file = draftFromSnapshot(snapshot);
		const draft = state.draft ?? file;
		const presets = snapshot.inspect?.status === "ok" ? snapshot.inspect.report.desired?.presets ?? [] : [];
		const feature = rows[state.selection.index]?.feature;
		if (data === " " && feature) { const next = toggleFeature(draft, feature); state.draft = sameDraft(next, file) ? undefined : next; keepSelectionVisible(state, fleetConfigRows(snapshot, state.tab, state.expanded, state), bodyHeight); return undefined; }
		if (data === "p") { const next = cyclePreset(draft, presets); state.draft = sameDraft(next, file) ? undefined : next; return undefined; }
		if (data === "u") { state.draft = undefined; return undefined; }
		if (data === "a") return "apply";
	}
	if (state.tab === "overrides" && data === "a") return "configure";
	if (data === KEYS.up) moveSelection(state.selection, rows, -1);
	else if (data === KEYS.down) moveSelection(state.selection, rows, 1);
	else if (data === KEYS.pageUp) moveSelection(state.selection, rows, -Math.max(1, bodyHeight));
	else if (data === KEYS.pageDown) moveSelection(state.selection, rows, Math.max(1, bodyHeight));
	else if (data === "g") { state.selection.index = 0; state.selection.key = rows[0]?.key; }
	else if (data === "G") { state.selection.index = Math.max(0, rows.length - 1); state.selection.key = rows.at(-1)?.key; }
	else if (data === KEYS.enter && rows[state.selection.index]?.expandable) {
		const key = rows[state.selection.index].key;
		state.expanded.has(key) ? state.expanded.delete(key) : state.expanded.add(key);
		rows = fleetConfigRows(snapshot, state.tab, state.expanded);
		reconcileSelection(state.selection, rows);
	}
	else if (data === "o") {
		const path = rows[state.selection.index]?.path;
		keepSelectionVisible(state, rows, bodyHeight);
		return path ? { open: path } : undefined;
	}
	keepSelectionVisible(state, rows, bodyHeight);
	return undefined;
}
