import assert from "node:assert/strict";
import test from "node:test";
import { createTaskClock } from "../run-budget.js";
import { createExecutionHistoryStore } from "../ui/history-store.ts";
import { createBudgetContext, freshTurnReport } from "./budgets.ts";

function fixture() {
	const values: any = {
		turnDispatch: 3, turnResearch: 2, turnWait: 50, pending: { kind: "task", reason: "cap" },
		taskContinuation: 4, turnContinuation: 1, taskDispatch: 7, taskResearch: 5,
		label: "task", clock: createTaskClock(), reviews: 2, tier: "large", assumed: false,
		report: freshTurnReport(0),
	};
	const events: string[] = [];
	const executionHistory = createExecutionHistoryStore(() => 100);
	executionHistory.startTurn(100);
	const context = createBudgetContext({
		getBudgetOverrides: () => ({}),
		getTurnDispatchCount: () => values.turnDispatch, setTurnDispatchCount: value => { values.turnDispatch = value; events.push("turn-dispatch"); },
		getTurnResearchCount: () => values.turnResearch, setTurnResearchCount: value => { values.turnResearch = value; events.push("turn-research"); },
		getTurnBudgetAskUserWaitMs: () => values.turnWait, setTurnBudgetAskUserWaitMs: value => { values.turnWait = value; events.push("turn-wait"); },
		setPendingBudgetContinuation: value => { values.pending = value; events.push("pending"); }, clearBudgetContinuationAsks: () => events.push("asks"),
		getTaskContinuationCount: () => values.taskContinuation, setTaskContinuationCount: value => { values.taskContinuation = value; events.push("task-continuation"); },
		getTurnContinuationCount: () => values.turnContinuation, setTurnContinuationCount: value => { values.turnContinuation = value; events.push("turn-continuation"); },
		getTaskDispatchCount: () => values.taskDispatch, setTaskDispatchCount: value => { values.taskDispatch = value; events.push("task-dispatch"); },
		getTaskResearchCount: () => values.taskResearch, setTaskResearchCount: value => { values.taskResearch = value; events.push("task-research"); },
		getTaskLabel: () => values.label, setTaskLabel: value => { values.label = value; events.push("label"); },
		getTaskClock: () => values.clock, setTaskClock: value => { values.clock = value; events.push("clock"); },
		getTaskReviewRounds: () => values.reviews, setTaskReviewRounds: value => { values.reviews = value; events.push("reviews"); },
		getTaskTier: () => values.tier, setTaskTier: value => { values.tier = value; events.push("tier"); },
		getTaskTierAssumed: () => values.assumed, setTaskTierAssumed: value => { values.assumed = value; events.push("assumed"); },
		clearTurnDispatchFingerprints: () => events.push("fingerprints"),
		clearTaskCapabilities: () => events.push("capabilities"),
		clearExternalBlockers: () => events.push("blockers"),
		resolveIncomingCapabilities: () => events.push("resolve-capabilities"),
		applyWorkModeTools: () => events.push("work-mode-tools"),
		getTurnReport: () => values.report,
		setStatus: () => events.push("status"),
		getAuditContext: () => ({ cwd: "/repo" }), appendEntry: () => {}, executionHistory,
	});
	return { context, values, events };
}

test("task continuation renews counters while preserving task identity and blockers", () => {
	const { context, values, events } = fixture();
	context.continueTaskBudgetWindow(200);
	assert.equal(values.taskDispatch, 0);
	assert.equal(values.taskResearch, 0);
	assert.equal(values.reviews, 0);
	assert.equal(values.taskContinuation, 5);
	assert.equal(values.tier, "large");
	assert.equal(values.label, "task");
	assert.equal(values.pending.kind, "task");
	assert.ok(!events.includes("capabilities"));
	assert.ok(!events.includes("blockers"));
});

test("new-task reset preserves the capability, blocker, and status side-effect order", () => {
	const { context, values, events } = fixture();
	context.resetTaskWindow("next", 300);
	assert.equal(values.label, "next");
	assert.equal(values.tier, null);
	assert.equal(values.pending, null);
	const ordered = ["capabilities", "blockers", "fingerprints", "resolve-capabilities", "work-mode-tools", "status"];
	assert.deepEqual(events.filter(event => ordered.includes(event)), ordered);
});
