import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const indexSource = fs.readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const budgetSource = fs.readFileSync(new URL("./context/budgets.ts", import.meta.url), "utf8");
const dispatchExecutionSource = fs.readFileSync(new URL("./tools/dispatch-execution.ts", import.meta.url), "utf8");
const turnLifecycleSource = fs.readFileSync(new URL("./lifecycle/turn-handlers.ts", import.meta.url), "utf8");
const source = `${indexSource}\n${budgetSource}\n${dispatchExecutionSource}`;

test("dispatch and research refusals arm the same ask_user continuation protocol", () => {
	assert.match(source, /pendingBudgetContinuation/);
	assert.match(dispatchExecutionSource, /armBudgetContinuation\("task", taskRefusal\.reason\)/);
	assert.match(dispatchExecutionSource, /armBudgetContinuation\("turn", turnRefusal\.reason\)/);
	assert.match(dispatchExecutionSource, /budgetContinuationInstruction\(taskRefusal\.message, "task"/);
	assert.match(dispatchExecutionSource, /budgetContinuationInstruction\(turnRefusal\.message, "turn"/);
});

test("turn budget checks use active time rather than raw wall time", () => {
	assert.match(dispatchExecutionSource, /turnBudgetActiveElapsedMs\(\)/);
	assert.doesNotMatch(dispatchExecutionSource, /checkTurnBudget\([\s\S]{0,300}Date\.now\(\) - \(currentTurnStartedAt/);
});

test("a confirmed task continuation preserves task identity instead of calling the new-task reset", () => {
	const start = budgetSource.lastIndexOf("continueTaskBudgetWindow(now");
	const end = budgetSource.indexOf("\n\t\tcloseTurnActiveTime", start + 20);
	assert.ok(start >= 0 && end > start, "continueTaskBudgetWindow must exist in the budget context");
	const body = budgetSource.slice(start, end);
	assert.match(body, /setTaskDispatchCount\(0\)/);
	assert.match(body, /setTaskResearchCount\(0\)/);
	assert.match(body, /setTaskReviewRounds\(0\)/);
	assert.match(body, /resetTaskClock/);
	assert.match(body, /renewTurnBudgetWindow/);
	assert.doesNotMatch(body, /resetTaskWindow/);
	assert.doesNotMatch(body, /setTaskTier/);
	assert.doesNotMatch(body, /clearTaskCapabilities/);
	assert.doesNotMatch(body, /assertions/);
});

test("only a marked first-option ask_user result renews a budget", () => {
	assert.match(turnLifecycleSource, /ports\.setContinuationAsk\(event\.toolCallId/);
	assert.match(turnLifecycleSource, /ports\.continuationOutcome\(confirmation\.params, event\.result\)/);
	assert.match(turnLifecycleSource, /if \(outcome !== "continue"\) return/);
	assert.match(indexSource, /continueBudget: \(kind, at\)[\s\S]*?continueTaskBudgetWindow\(at\)[\s\S]*?renewTurnBudgetWindow\(at\)/);
});

test("prompt turn reset clears only the turn continuation window", () => {
	const start = indexSource.indexOf("resetTurnBudgetState: () => {");
	const end = indexSource.indexOf("\n\t\tupdateModeStatus", start);
	assert.ok(start >= 0 && end > start, "turn budget reset must remain root-state owned");
	const body = indexSource.slice(start, end);
	assert.match(body, /budgetContinuationAsks\.clear\(\)/);
	assert.match(body, /pendingBudgetContinuation\?\.kind === "turn"/);
	assert.doesNotMatch(body, /pendingBudgetContinuation\?\.kind === "task"/);
	assert.doesNotMatch(body, /resetTaskWindow|taskDispatchCount\s*=|taskResearchCount\s*=|taskReviewRounds\s*=/);
});
