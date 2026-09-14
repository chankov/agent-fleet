import assert from "node:assert/strict";
import test from "node:test";
import { fleetStripTransition, initialFleetStripState, reconcileStripState } from "./fleet-strip-controller.ts";
import type { FleetRow } from "./fleet-read-model.ts";

const row = (key: string, runToken = `${key}:1`): FleetRow => ({ key, runToken, kind: "specialist", name: key, depth: 0, status: "running", model: "m", backend: "native", contextPct: null, contextTokens: null, elapsed: 0, timingKind: "unknown", toolCount: null, lastWork: "", hasTimeline: true });
const rows = [row("a"), row("b")];
const gate = { interactiveAvailable: true, focused: true, editorEmpty: true, autocomplete: false, modal: false, bodyRows: 1 };

test("only an eligible registered toggle transition opens and closes the widget", () => {
	for (const blocked of [{ focused: false }, { editorEmpty: false }, { autocomplete: true }, { modal: true }, { bodyRows: 0 }, { interactiveAvailable: false }]) {
		const result = fleetStripTransition({ data: "toggle" }, initialFleetStripState(), rows, { ...gate, ...blocked }, 0);
		assert.equal(result.consume, false); assert.equal(result.state.active, false);
	}
	const active = fleetStripTransition({ data: "toggle" }, initialFleetStripState(), rows, gate, 0);
	assert.equal(active.consume, true); assert.equal(active.state.active, true);
	const withConfirmation = { ...active.state, confirmation: { action: "kill" as const, key: "a", runToken: "a:1", until: 100 } };
	const collapsed = fleetStripTransition({ data: "toggle" }, withConfirmation, rows, gate, 1);
	assert.equal(collapsed.consume, true); assert.equal(collapsed.state.active, false); assert.equal(collapsed.state.confirmation, null);
});

test("plain and Alt arrows pass through while j/k navigation remains supported", () => {
	let state = fleetStripTransition({ data: "toggle" }, initialFleetStripState(), rows, gate, 0).state;
	state = fleetStripTransition({ data: "j" }, state, rows, gate, 1).state;
	assert.equal(state.selectedKey, "b"); assert.equal(state.offset, 1);
	state = fleetStripTransition({ data: "k" }, state, rows, gate, 2).state;
	assert.equal(state.selectedKey, "a");
	for (const arrow of ["\u001b[A", "\u001b[B", "\u001b[D", "\u001b[1;3A", "\u001b[1;3B", "\u001b[1;3D", "\u001b[1;3C"]) {
		const pass = fleetStripTransition({ data: arrow }, { ...state, active: true }, rows, gate, 4);
		assert.equal(pass.consume, false); assert.equal(pass.state.active, false);
	}
});

test("confirmation is same key, same run, two seconds and pending guarded", () => {
	let state = { ...initialFleetStripState(), active: true };
	let result = fleetStripTransition({ data: "x" }, state, rows, gate, 1000); state = result.state;
	assert.equal(result.intent, undefined);
	result = fleetStripTransition({ data: "x" }, state, [row("a", "a:2"), row("b")], gate, 1100); state = result.state;
	assert.equal(result.intent, undefined, "new run must not reuse confirmation");
	result = fleetStripTransition({ data: "x" }, state, [row("a", "a:2"), row("b")], gate, 1200); state = result.state;
	assert.deepEqual(result.intent, { type: "kill", key: "a", runToken: "a:2" });
	assert.equal(state.pendingAction, true);
	assert.equal(fleetStripTransition({ data: "x" }, state, rows, gate, 1300).intent, undefined);
});

test("key release and paste never act and force pass-through collapse", () => {
	const active = { ...initialFleetStripState(), active: true };
	for (const input of [{ data: "x", keyRelease: true }, { data: "x", paste: true }, { data: "j", paste: true }]) {
		const result = fleetStripTransition(input, active, rows, gate, 0);
		assert.equal(result.consume, false); assert.equal(result.intent, undefined); assert.equal(result.state.active, false);
	}
});

test("zero-body reconciliation collapses active state and clears confirmation", () => {
	const state = { ...initialFleetStripState(), active: true, confirmation: { action: "kill" as const, key: "a", runToken: "a:1", until: 10 } };
	const next = reconcileStripState(state, rows, 0);
	assert.equal(next.active, false); assert.equal(next.confirmation, null); assert.equal(next.offset, 0);
});

test("selection reconciles synthetic peer alias to the real key", () => {
	const state = { ...initialFleetStripState(), selectedKey: "peer-pending:alice" };
	const real = row("peer:s1"); real.aliasKeys = ["peer-pending:alice"];
	assert.equal(reconcileStripState(state, [real], 1).selectedKey, "peer:s1");
});
