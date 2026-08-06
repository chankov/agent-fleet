import test from "node:test";
import assert from "node:assert/strict";
import { moveSelection, reconcileSelection, type Selection } from "./fleet-selection.ts";

const rows = (...keys: string[]) => keys.map((key) => ({ key }));

test("reconcileSelection follows a stable key through reordering and insertions", () => {
	const sel: Selection = { key: "b", index: 1 };
	reconcileSelection(sel, rows("b", "a", "c"));
	assert.deepEqual(sel, { key: "b", index: 0 });
	reconcileSelection(sel, rows("new", "b", "a", "c"));
	assert.deepEqual(sel, { key: "b", index: 1 });
});

test("reconcileSelection clamps a removed selection to its neighbour", () => {
	const sel: Selection = { key: "c", index: 2 };
	reconcileSelection(sel, rows("a", "b"));
	assert.deepEqual(sel, { key: "b", index: 1 });
});

test("reconcileSelection resets an empty list", () => {
	const sel: Selection = { key: "a", index: 4 };
	reconcileSelection(sel, []);
	assert.deepEqual(sel, { key: undefined, index: 0 });
});

test("moveSelection clamps at both ends and is inert for empty rows", () => {
	const sel: Selection = { key: "b", index: 1 };
	moveSelection(sel, rows("a", "b", "c"), 99);
	assert.deepEqual(sel, { key: "c", index: 2 });
	moveSelection(sel, rows("a", "b", "c"), -99);
	assert.deepEqual(sel, { key: "a", index: 0 });
	moveSelection(sel, [], 1);
	assert.deepEqual(sel, { key: undefined, index: 0 });
});
