import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("./index.ts", import.meta.url), "utf8");

test("dispatch and research refusals arm the same ask_user continuation protocol", () => {
	assert.match(source, /pendingBudgetContinuation/);
	assert.match(source, /armBudgetContinuation\("task",\s*taskRefusal\.reason\)/);
	assert.match(source, /armBudgetContinuation\("turn",\s*budgetRefusal\.reason\)/);
	assert.match(source, /budgetContinuationInstruction\(taskRefusal\.message,\s*"task"/);
	assert.match(source, /budgetContinuationInstruction\(budgetRefusal\.message,\s*"turn"/);
});

test("turn budget checks use active time rather than raw wall time", () => {
	assert.match(source, /turnBudgetActiveElapsedMs\(\)/);
	assert.doesNotMatch(source, /checkTurnBudget\([\s\S]{0,300}Date\.now\(\) - \(currentTurnStartedAt/);
});

test("a confirmed task continuation preserves task identity instead of calling the new-task reset", () => {
	const start = source.indexOf("function continueTaskBudgetWindow");
	const end = source.indexOf("\n\tfunction ", start + 20);
	assert.ok(start >= 0 && end > start, "continueTaskBudgetWindow must exist");
	const body = source.slice(start, end);
	assert.match(body, /taskDispatchCount = 0/);
	assert.match(body, /taskResearchCount = 0/);
	assert.match(body, /taskReviewRounds = 0/);
	assert.match(body, /resetTaskClock/);
	assert.match(body, /renewTurnBudgetWindow/);
	assert.doesNotMatch(body, /resetTaskWindow/);
	assert.doesNotMatch(body, /taskTier\s*=/);
	assert.doesNotMatch(body, /taskCapabilityPacks\s*=/);
	assert.doesNotMatch(body, /assertions\s*=/);
});

test("only a marked first-option ask_user result renews a budget", () => {
	assert.match(source, /budgetContinuationAsks\.set\(event\.toolCallId/);
	assert.match(source, /budgetContinuationOutcome\(confirmation\.params,\s*event\.result\)/);
	assert.match(source, /if \(outcome === "continue"\)/);
	assert.match(source, /continueTaskBudgetWindow/);
	assert.match(source, /renewTurnBudgetWindow/);
});
