import test from "node:test";
import assert from "node:assert/strict";

import { MAX_OPEN_ASSERTIONS, validateAssertionBatch } from "./assertion-ledger.js";

const sourced = (id) => ({ id, tag: "test", text: `${id} holds`, source: `PLAN.md:${id}` });

test("a sourced batch within the cap passes clean", () => {
	const batch = ["A1", "A2", "A3"].map(sourced);
	const res = validateAssertionBatch(batch);
	assert.equal(res.ok, true);
	assert.equal(res.refusal, undefined);
	assert.equal(res.warning, null);
	assert.equal(res.assertions.length, 3);
	assert.deepEqual(res.assertions[0], { id: "A1", tag: "test", text: "A1 holds", source: "PLAN.md:A1" });
});

test("exactly the cap passes without a warning", () => {
	const batch = Array.from({ length: MAX_OPEN_ASSERTIONS }, (_, i) => sourced(`A${i + 1}`));
	const res = validateAssertionBatch(batch);
	assert.equal(res.ok, true);
	assert.equal(res.warning, null);
});

test("a sourceless assertion is refused and named by id", () => {
	const res = validateAssertionBatch([
		sourced("A1"),
		{ id: "A2", tag: "test", text: "A2 holds" },
		{ id: "A3", tag: "test", text: "A3 holds", source: "   " },
	]);
	assert.equal(res.ok, false);
	assert.match(res.refusal, /A2/);
	assert.match(res.refusal, /A3/);
	assert.doesNotMatch(res.refusal, /A1/);
	assert.match(res.refusal, /source/i);
	// Refused batches never produce a ledger.
	assert.deepEqual(res.assertions, []);
});

test("an unidentified sourceless assertion is named by position", () => {
	const res = validateAssertionBatch([{ tag: "test", text: "something" }]);
	assert.equal(res.ok, false);
	assert.match(res.refusal, /#1/);
});

test("more than the cap warns with a split suggestion but still passes", () => {
	const batch = Array.from({ length: 30 }, (_, i) => sourced(`A${i + 1}`));
	const res = validateAssertionBatch(batch);
	assert.equal(res.ok, true);
	assert.equal(res.assertions.length, 30);
	assert.match(res.warning, /30/);
	assert.match(res.warning, new RegExp(String(MAX_OPEN_ASSERTIONS)));
	assert.match(res.warning, /defer/i);
});

test("the source refusal wins over the cap warning", () => {
	const batch = Array.from({ length: 30 }, (_, i) => sourced(`A${i + 1}`));
	delete batch[12].source;
	const res = validateAssertionBatch(batch);
	assert.equal(res.ok, false);
	assert.match(res.refusal, /A13/);
});

test("an empty batch clears the ledger without complaint", () => {
	const res = validateAssertionBatch([]);
	assert.equal(res.ok, true);
	assert.equal(res.warning, null);
	assert.deepEqual(res.assertions, []);
});

test("fields are trimmed and non-array input is treated as empty", () => {
	const res = validateAssertionBatch([{ id: " A1 ", tag: " test ", text: " holds ", source: " PLAN.md:1 " }]);
	assert.deepEqual(res.assertions[0], { id: "A1", tag: "test", text: "holds", source: "PLAN.md:1" });
	assert.equal(validateAssertionBatch(undefined).ok, true);
	assert.deepEqual(validateAssertionBatch(null).assertions, []);
});
