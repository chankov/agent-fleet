import test from "node:test";
import assert from "node:assert/strict";

import {
	BUDGET_CONTINUATION_MARKER,
	budgetContinuationContext,
	budgetContinuationInstruction,
	budgetContinuationKind,
	budgetContinuationOutcome,
	turnBudgetActiveMs,
} from "./budget-continuation.ts";

test("budget continuation contexts carry a machine-readable kind", () => {
	assert.equal(budgetContinuationContext("turn"), `[[${BUDGET_CONTINUATION_MARKER}:turn]]`);
	assert.equal(budgetContinuationContext("task"), `[[${BUDGET_CONTINUATION_MARKER}:task]]`);
	assert.equal(budgetContinuationKind(`Summary. ${budgetContinuationContext("turn")} Continue?`), "turn");
	assert.equal(budgetContinuationKind(budgetContinuationContext("task")), "task");
	assert.equal(budgetContinuationKind("ordinary question"), null);
	assert.equal(budgetContinuationKind(null), null);
});

test("refusal guidance replaces slash commands and typed continue with one ask_user confirmation", () => {
	const instruction = budgetContinuationInstruction("Budget exhausted.", "task", "Bulgarian");
	assert.match(instruction, /ask_user exactly once, in Bulgarian/);
	assert.match(instruction, /\[\[agent-hub-budget-continuation:task\]\]/);
	assert.match(instruction, /first option automatically renews the task budget/);
	assert.match(instruction, /without requesting another message/);
	assert.match(instruction, /Do not ask the human to type continue or run a slash command/);
});

test("the first ask_user option means continue regardless of translation", () => {
	const params = {
		context: budgetContinuationContext("turn"),
		options: [
			{ title: "Да — продължи", description: "Нов прозорец" },
			{ title: "Не — спри", description: "Спиране" },
		],
	};
	const continued = {
		details: {
			cancelled: false,
			response: { kind: "selection", selections: ["Да — продължи"] },
		},
	};
	const stopped = {
		details: {
			cancelled: false,
			response: { kind: "selection", selections: ["Не — спри"] },
		},
	};
	assert.equal(budgetContinuationOutcome(params, continued), "continue");
	assert.equal(budgetContinuationOutcome(params, stopped), "stop");
});

test("cancel, malformed answers, and unmarked questions never renew a budget", () => {
	const marked = {
		context: budgetContinuationContext("task"),
		options: ["Yes — continue", "No — stop"],
	};
	assert.equal(budgetContinuationOutcome(marked, { details: { cancelled: true } }), "stop");
	assert.equal(budgetContinuationOutcome(marked, { details: { response: { selections: ["Something else"] } } }), null);
	assert.equal(budgetContinuationOutcome({ ...marked, context: "ordinary" }, {
		details: { response: { selections: ["Yes — continue"] } },
	}), null);
});

test("turn budget active time excludes completed and in-flight ask_user waits", () => {
	const start = 1_000_000;
	assert.equal(turnBudgetActiveMs(start, start + 20 * 60_000, 12 * 60_000), 8 * 60_000);
	assert.equal(turnBudgetActiveMs(start, start + 20 * 60_000, 10 * 60_000, 2 * 60_000), 8 * 60_000);
	assert.equal(turnBudgetActiveMs(0, start + 20 * 60_000, 10 * 60_000), 0);
});
