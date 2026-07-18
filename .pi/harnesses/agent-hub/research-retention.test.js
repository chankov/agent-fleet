import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_RESEARCH_KEEP, parseResearchKeep, selectResearchPrunable } from "./research-retention.js";

const helper = (id, status, finishedAt, ephemeral = false) => ({ id, status, finishedAt, ephemeral });

test("parseResearchKeep accepts non-negative integers, 'all', rejects the rest", () => {
	assert.equal(parseResearchKeep("0"), 0);
	assert.equal(parseResearchKeep("4"), 4);
	assert.equal(parseResearchKeep(" 12 "), 12);
	assert.equal(parseResearchKeep("all"), Infinity);
	assert.equal(parseResearchKeep("All"), Infinity);
	assert.equal(parseResearchKeep("-1"), null);
	assert.equal(parseResearchKeep("many"), null);
	assert.equal(parseResearchKeep("4.5"), null);
	assert.equal(parseResearchKeep(""), null);
	assert.equal(parseResearchKeep(undefined), null);
});

test("running helpers are never pruned", () => {
	const states = [helper(1, "running", undefined, true), helper(2, "running")];
	assert.deepEqual(selectResearchPrunable(states, 0), []);
});

test("finished ephemeral helpers are always pruned, even under the keep cap", () => {
	const states = [
		helper(1, "done", 100, true),
		helper(2, "error", 200, true),
		helper(3, "idle", 300, true),
		helper(4, "done", 400),
	];
	assert.deepEqual(selectResearchPrunable(states, 4).sort(), [1, 2, 3]);
});

test("durable helpers beyond the keep cap are pruned oldest-first", () => {
	const states = [
		helper(1, "done", 100),
		helper(2, "done", 400),
		helper(3, "error", 200),
		helper(4, "done", 300),
		helper(5, "running", undefined),
	];
	// keep=2 → keep the two most recently finished (r2 @400, r4 @300).
	assert.deepEqual(selectResearchPrunable(states, 2), [3, 1]);
	// keep=0 → every finished durable helper goes.
	assert.deepEqual(selectResearchPrunable(states, 0), [2, 4, 3, 1]);
});

test("keep=Infinity ('all') never prunes durable helpers but still drops ephemeral ones", () => {
	const states = [
		helper(1, "done", 100),
		helper(2, "done", 200, true),
		helper(3, "done", 300),
	];
	assert.deepEqual(selectResearchPrunable(states, Infinity), [2]);
});

test("invalid keep falls back to the default cap", () => {
	const states = Array.from({ length: DEFAULT_RESEARCH_KEEP + 2 }, (_, i) => helper(i + 1, "done", i + 1));
	const pruned = selectResearchPrunable(states, NaN);
	// The two oldest beyond the default cap go, newest stay.
	assert.deepEqual(pruned, [2, 1]);
});

test("missing finishedAt sorts as oldest", () => {
	const states = [helper(1, "done", undefined), helper(2, "done", 100), helper(3, "done", 200)];
	assert.deepEqual(selectResearchPrunable(states, 2), [1]);
});
