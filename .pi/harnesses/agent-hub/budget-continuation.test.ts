import test from "node:test";
import assert from "node:assert/strict";
import { turnBudgetActiveMs } from "./budget-continuation.ts";

test("turn budget active time excludes completed and in-flight ask_user waits", () => {
	const start = 1_000_000;
	assert.equal(turnBudgetActiveMs(start, start + 20 * 60_000, 12 * 60_000), 8 * 60_000);
	assert.equal(turnBudgetActiveMs(start, start + 20 * 60_000, 10 * 60_000, 2 * 60_000), 8 * 60_000);
	assert.equal(turnBudgetActiveMs(0, start + 20 * 60_000, 10 * 60_000), 0);
});
