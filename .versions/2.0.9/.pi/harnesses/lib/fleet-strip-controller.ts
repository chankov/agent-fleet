import { confirmFleetAction, type FleetConfirmation } from "./fleet-dashboard-ops.ts";
import type { FleetRow } from "./fleet-read-model.ts";

export interface FleetStripState {
	active: boolean;
	selectedKey?: string;
	index: number;
	offset: number;
	confirmation: FleetConfirmation;
	pendingAction: boolean;
}
export interface FleetStripGate {
	interactiveAvailable: boolean;
	focused: boolean;
	editorEmpty: boolean;
	autocomplete: boolean;
	modal: boolean;
	bodyRows: number;
}
export interface FleetStripInput { data: string; keyRelease?: boolean; paste?: boolean; }
export type FleetStripIntent = { type: "open" | "kill" | "restart"; key: string; runToken?: string };
export interface FleetStripTransition { state: FleetStripState; consume: boolean; intent?: FleetStripIntent; }

export function initialFleetStripState(): FleetStripState {
	return { active: false, index: 0, offset: 0, confirmation: null, pendingAction: false };
}

export function reconcileStripState(state: FleetStripState, rows: readonly FleetRow[], bodyRows: number): FleetStripState {
	const next = { ...state };
	let index = next.selectedKey ? rows.findIndex(row => row.key === next.selectedKey || row.aliasKeys?.includes(next.selectedKey!)) : -1;
	if (index < 0) index = Math.max(0, Math.min(next.index, Math.max(0, rows.length - 1)));
	next.index = index;
	next.selectedKey = rows[index]?.key;
	const body = Math.max(0, bodyRows);
	if (body === 0) {
		next.active = false;
		next.confirmation = null;
		next.offset = 0;
	} else {
		if (index < next.offset) next.offset = index;
		else if (index >= next.offset + body) next.offset = index - body + 1;
		next.offset = Math.max(0, Math.min(next.offset, Math.max(0, rows.length - body)));
	}
	if (!rows.some(row => row.key === next.confirmation?.key && row.runToken === next.confirmation?.runToken)) next.confirmation = null;
	return next;
}

const gateOpen = (gate: FleetStripGate, rows: readonly FleetRow[]) => gate.interactiveAvailable && gate.focused && gate.editorEmpty && !gate.autocomplete && !gate.modal && gate.bodyRows > 0 && rows.length > 0;

/** Pure focused-editor keyboard controller. Unknown input always passes through once. */
export function fleetStripTransition(input: FleetStripInput, state: FleetStripState, rows: readonly FleetRow[], gate: FleetStripGate, now: number): FleetStripTransition {
	let next = reconcileStripState(state, rows, gate.bodyRows);
	if (input.keyRelease || input.paste || !gateOpen(gate, rows)) return { state: { ...next, active: false, confirmation: null }, consume: false };
	const data = input.data;
	if (data === "toggle") return { state: { ...next, active: !next.active, confirmation: null }, consume: true };
	if (!next.active) return { state: next, consume: false };
	if (data === "\u001b") return { state: { ...next, active: false, confirmation: null }, consume: true };
	const direction = data === "k" ? -1 : data === "j" ? 1 : 0;
	if (direction) {
		const index = Math.max(0, Math.min(rows.length - 1, next.index + direction));
		next = reconcileStripState({ ...next, index, selectedKey: rows[index]?.key, confirmation: null }, rows, gate.bodyRows);
		return { state: next, consume: true };
	}
	const selected = rows[next.index];
	if (data === "\r" && selected) return { state: { ...next, active: false, confirmation: null }, consume: true, intent: { type: "open", key: selected.key, runToken: selected.runToken } };
	if ((data === "x" || data === "r") && selected) {
		if (next.pendingAction) return { state: next, consume: true };
		const action = data === "x" ? "kill" : "restart";
		const result = confirmFleetAction(next.confirmation, action, selected, now);
		next = { ...next, confirmation: result.confirmation };
		return result.confirmed ? { state: { ...next, pendingAction: true }, consume: true, intent: { type: action, key: selected.key, runToken: selected.runToken } } : { state: next, consume: true };
	}
	return { state: { ...next, active: false, confirmation: null }, consume: false };
}
