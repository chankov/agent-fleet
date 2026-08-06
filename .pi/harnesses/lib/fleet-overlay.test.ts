import test from "node:test";
import assert from "node:assert/strict";
import { MIN_BODY_ROWS, bodyRows, clampScroll, fitToHeight } from "./fleet-overlay.ts";

test("bodyRows preserves the terminal fixed-height invariant", () => {
	for (const rows of [10, 24, 40, 60, 200]) for (const chrome of [3, 5, 7, 9]) {
		const available = rows - 1 - chrome;
		assert.equal(bodyRows(rows, chrome), Math.max(MIN_BODY_ROWS, available));
		if (available >= MIN_BODY_ROWS) assert.equal(chrome + bodyRows(rows, chrome), rows - 1);
	}
});

test("bodyRows uses the first-measure fallback and never becomes too small", () => {
	assert.equal(bodyRows(0, 5), bodyRows(30, 5));
	assert.equal(bodyRows(undefined, 5), bodyRows(30, 5));
	assert.equal(bodyRows(8, 7), MIN_BODY_ROWS);
});

test("fitToHeight pads, truncates, preserves exact input, and handles zero", () => {
	assert.deepEqual(fitToHeight(["a"], 3), ["a", "", ""]);
	assert.deepEqual(fitToHeight(["a", "b", "c"], 2), ["a", "b"]);
	assert.deepEqual(fitToHeight(["a", "b"], 2), ["a", "b"]);
	assert.deepEqual(fitToHeight(["a"], 0), []);
});

test("clampScroll bounds offsets against content and viewport", () => {
	assert.equal(clampScroll(4, 3, 5), 0);
	assert.equal(clampScroll(99, 10, 4), 6);
	assert.equal(clampScroll(-1, 10, 4), 0);
});
