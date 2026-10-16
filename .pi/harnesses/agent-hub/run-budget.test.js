import test from "node:test";
import assert from "node:assert/strict";

import {
	HARD_RECYCLE_CONTEXT_PCT,
	RECYCLE_CONTEXT_PCT,
	contextOverflowDiagnostic,
	TASK_TIERS,
	TIER_BUDGETS,
	normalizeTaskTier,
	resolveTurnBudget,
	shouldRecycleSession,
	budgetStatusLine,
	TIER_RANK,
	HEAVY_PERSONAS,
	DEFAULT_TASK_TIER,
	addTaskClockWait,
	closeTaskClock,
	createTaskClock,
	openTaskClock,
	resetTaskClock,
	taskClockElapsedMs,
	turnActiveMs,
	applyTierChange,
	checkTierPersonaGate,
	blockingFindingCap,
	isReviewPersona,
	reviewBudgetClause,
} from "./run-budget.js";

test("normalizeTaskTier accepts variants and rejects unknowns", () => {
	assert.equal(normalizeTaskTier("small"), "small");
	assert.equal(normalizeTaskTier(" TRIVIAL "), "trivial");
	assert.equal(normalizeTaskTier("Project"), "project");
	assert.equal(normalizeTaskTier("huge"), null);
	assert.equal(normalizeTaskTier(undefined), null);
});

test("resolveTurnBudget returns tier defaults untouched", () => {
	for (const tier of TASK_TIERS) {
		assert.deepEqual(resolveTurnBudget(tier), TIER_BUDGETS[tier]);
	}
});

test("resolveTurnBudget falls back to small on junk or omitted tier", () => {
	assert.deepEqual(resolveTurnBudget("junk"), TIER_BUDGETS[DEFAULT_TASK_TIER]);
	assert.deepEqual(resolveTurnBudget(), TIER_BUDGETS[DEFAULT_TASK_TIER]);
	assert.deepEqual(resolveTurnBudget(null), TIER_BUDGETS[DEFAULT_TASK_TIER]);
});

test("legacy quota overrides are ignored while child deadlines stay bounded", () => {
	const b = resolveTurnBudget("feature", { maxDispatches: 3, agentTurnMs: null });
	assert.deepEqual(Object.keys(b).sort(), ["agentTurnMs", "delegation", "recycleRuns"], "no dispatch, research or wall quota");
	assert.equal(b.agentTurnMs, TIER_BUDGETS.feature.agentTurnMs);
	assert.equal(b.delegation, true);
	assert.equal(resolveTurnBudget("small", { agentTurnMs: 60_000 }).agentTurnMs, 60_000);
});

test("delegation is tier-owned and never overridable", () => {
	assert.equal(resolveTurnBudget("trivial").delegation, false);
	assert.equal(resolveTurnBudget("small").delegation, false);
	assert.equal(resolveTurnBudget("feature").delegation, true);
	assert.equal(resolveTurnBudget("project").delegation, true);
	assert.equal(resolveTurnBudget("feature", { delegation: false }).delegation, true);
});

test("every tier has a child-deadline envelope and no quota axes", () => {
	assert.deepEqual(Object.keys(TIER_BUDGETS).sort(), [...TASK_TIERS].sort());
	for (const tier of TASK_TIERS) assert.deepEqual(Object.keys(TIER_BUDGETS[tier]).sort(), ["agentTurnMs", "delegation", "recycleRuns"]);
});

test("legacy off overrides cannot reintroduce a continuation quota", () => {
 const budget = resolveTurnBudget("small", { maxDispatches: 1, maxResearch: 1, wallMs: 1 });
 assert.equal("maxDispatches" in budget || "maxResearch" in budget || "wallMs" in budget, false);
});

test("shouldRecycleSession triggers on run count or context pressure", () => {
	const budget = resolveTurnBudget("feature"); // recycleRuns 5
	assert.equal(shouldRecycleSession(0, 99, budget), false); // fresh session never recycles
	assert.equal(shouldRecycleSession(4, 10, budget), false);
	assert.equal(shouldRecycleSession(5, 10, budget), true);
	assert.equal(shouldRecycleSession(1, RECYCLE_CONTEXT_PCT, budget), true);
	assert.equal(shouldRecycleSession(1, RECYCLE_CONTEXT_PCT - 1, budget), false);
});

test("shouldRecycleSession with recycleRuns off still respects the tier recycle count", () => {
	const budget = resolveTurnBudget("feature", { recycleRuns: null });
	assert.equal(shouldRecycleSession(4, 10, budget), false);
	assert.equal(shouldRecycleSession(5, 10, budget), true);
	assert.equal(shouldRecycleSession(50, 75, budget), true);
});

test("shouldRecycleSession hard-recycles at or above a full context window", () => {
	// A raised threshold must not defeat the hard limit: past 100% the session
	// no longer fits, so resuming it cannot be the cheaper option.
	const budget = resolveTurnBudget("feature", { recycleRuns: null });
	assert.equal(shouldRecycleSession(1, HARD_RECYCLE_CONTEXT_PCT, budget, 999), true);
	assert.equal(shouldRecycleSession(1, 315, budget, 999), true);
	assert.equal(shouldRecycleSession(1, 99, budget, 999), false);
	// Nothing to recycle on a fresh session, whatever the reading says.
	assert.equal(shouldRecycleSession(0, 315, budget), false);
});

test("contextOverflowDiagnostic fires only for a fresh session over the window", () => {
	assert.equal(contextOverflowDiagnostic(1, 315), null); // recycling handles it
	assert.equal(contextOverflowDiagnostic(0, 99), null);
	const diag = contextOverflowDiagnostic(0, 315, { agent: "planner", model: "custom/Qwen3.8-27B-Uncensored-MLX-4bit" });
	assert.ok(diag);
	assert.match(diag, /planner/);
	assert.match(diag, /315%/);
	assert.match(diag, /custom\/Qwen3\.8-27B-Uncensored-MLX-4bit/);
	// Names the actual cause: one run cannot be split by recycling.
	assert.match(diag, /contextWindow/);
	assert.equal(contextOverflowDiagnostic(0, 100), contextOverflowDiagnostic(0, 100));
});

test("budgetStatusLine renders usage counts and assumed-tier markers, never caps", () => {
	assert.equal(budgetStatusLine({ dispatches: 3, research: 1 }, "project"), "Tier: project · 3 disp · 1 res");
	assert.equal(budgetStatusLine({ dispatches: 1, research: 0 }, "small?"), "Tier: small? · 1 disp · 0 res");
	assert.equal(budgetStatusLine({ dispatches: 1, research: 0 }), "Tier: small · 1 disp · 0 res");
});

// ── Tier ratchet (B1) ────────────────────────────────────────────────────────

test("applyTierChange accepts the first classification without a reason", () => {
	const r = applyTierChange(null, "small");
	assert.equal(r.ok, true);
	assert.equal(r.tier, "small");
	assert.equal(r.escalated, false);
	assert.equal(r.reason, "initial");
});

test("applyTierChange lets the tier fall freely", () => {
	const r = applyTierChange("project", "trivial");
	assert.equal(r.ok, true);
	assert.equal(r.tier, "trivial");
	assert.equal(r.escalated, false);
	assert.equal(r.reason, "lowered");
});

test("applyTierChange refuses a silent escalation and keeps the old tier", () => {
	const r = applyTierChange("small", "project");
	assert.equal(r.ok, false);
	assert.equal(r.tier, "small", "a refused escalation must not move the tier");
	assert.equal(r.reason, "raise_without_reason");
	assert.match(r.message, /reason/i);
	// Whitespace is not a reason.
	assert.equal(applyTierChange("small", "feature", "   ").ok, false);
});

test("applyTierChange allows escalation with a reason and flags it", () => {
	const r = applyTierChange("trivial", "feature", "the config key is read in 4 services");
	assert.equal(r.ok, true);
	assert.equal(r.tier, "feature");
	assert.equal(r.escalated, true);
	assert.match(r.message, /the config key is read in 4 services/);
});

test("applyTierChange treats a same-tier re-declaration as a no-op, not an escalation", () => {
	const r = applyTierChange("feature", "feature");
	assert.equal(r.ok, true);
	assert.equal(r.escalated, false);
	assert.equal(r.reason, "unchanged");
});

test("applyTierChange rejects an unknown tier without disturbing the current one", () => {
	const r = applyTierChange("small", "gigantic", "because");
	assert.equal(r.ok, false);
	assert.equal(r.tier, "small");
	assert.equal(r.reason, "unknown_tier");
});

test("TIER_RANK orders every declared tier", () => {
	assert.deepEqual(Object.keys(TIER_RANK).sort(), [...TASK_TIERS].sort());
});

// ── Task-scoped budget (B2) ──────────────────────────────────────────────────

// ── Tier persona gate (B3) ───────────────────────────────────────────────────

test("checkTierPersonaGate blocks heavy personas at trivial and small", () => {
	for (const tier of ["trivial", "small"]) {
		for (const persona of HEAVY_PERSONAS) {
			const gate = checkTierPersonaGate(tier, persona);
			assert.ok(gate, `${persona} should be gated at ${tier}`);
			assert.equal(gate.reason, "tier_persona_gate");
			assert.match(gate.message, /NOT counted against any budget/);
		}
	}
});

test("checkTierPersonaGate lets the working personas through at every tier", () => {
	for (const tier of [...TASK_TIERS, null, "nonsense"]) {
		for (const persona of ["builder", "test-engineer", "code-reviewer", "documenter", "researcher", "web-debugger"]) {
			assert.equal(checkTierPersonaGate(tier, persona), null);
		}
	}
});

test("checkTierPersonaGate does not gate feature/project or an unset tier", () => {
	assert.equal(checkTierPersonaGate("feature", "planner"), null);
	assert.equal(checkTierPersonaGate("project", "security-auditor"), null);
	assert.equal(checkTierPersonaGate(null, "planner"), null, "the function itself does not assume; the harness does");
});

test("checkTierPersonaGate is case- and whitespace-insensitive", () => {
	assert.ok(checkTierPersonaGate("small", " Architect "));
});

test("the gate names the escape hatch instead of just refusing", () => {
	const gate = checkTierPersonaGate("trivial", "architect");
	assert.match(gate.message, /set_task_tier/);
	assert.match(gate.message, /reason/);
	assert.match(gate.message, /Do not raise the tier merely to unlock a persona/);
});

// ── Review finding budget (B6) ───────────────────────────────────────────────

test("blockingFindingCap tightens with the tier and lifts for project/unset", () => {
	assert.equal(blockingFindingCap("trivial"), 1);
	assert.equal(blockingFindingCap("small"), 2);
	assert.equal(blockingFindingCap("feature"), 5);
	assert.equal(blockingFindingCap("project"), null);
	assert.equal(blockingFindingCap(null), null);
});

test("reviewBudgetClause is emitted only for review personas at a capped tier", () => {
	assert.equal(reviewBudgetClause("small", "builder"), null);
	assert.equal(reviewBudgetClause("project", "code-reviewer"), null);
	assert.equal(reviewBudgetClause(null, "code-reviewer"), null);
	const clause = reviewBudgetClause("small", "code-reviewer");
	assert.ok(clause);
	assert.match(clause, /at most 2 BLOCKING findings/);
	assert.match(clause, /Non-blocking \(optional\)/);
});

test("reviewBudgetClause forbids a finding that invents a new invariant", () => {
	const clause = reviewBudgetClause("feature", "plan-reviewer");
	assert.match(clause, /may NOT introduce a new invariant/);
	assert.match(clause, /manifest\/fixture/);
});

test("reviewBudgetClause uses the singular for a one-finding cap", () => {
	assert.match(reviewBudgetClause("trivial", "security-auditor"), /at most 1 BLOCKING finding\./);
});

test("isReviewPersona covers exactly the gate personas", () => {
	assert.equal(isReviewPersona("code-reviewer"), true);
	assert.equal(isReviewPersona("Plan-Reviewer"), true);
	assert.equal(isReviewPersona("builder"), false);
});

test("budgetStatusLine appends whole-task usage", () => {
	assert.equal(budgetStatusLine({ dispatches: 1, research: 0 }, "small", { dispatches: 4, research: 1 }), "Tier: small · 1 disp · 0 res · task 4 disp");
});

// ── Task clock charges ACTIVE time only (finding 2) ──────────────────────────

test("turnActiveMs subtracts the time the human was away", () => {
	const start = 1_000_000;
	assert.equal(turnActiveMs(start, start + 600_000, 0), 600_000);
	assert.equal(turnActiveMs(start, start + 600_000, 540_000), 60_000);
});

test("turnActiveMs never goes negative and tolerates junk", () => {
	const start = 1_000_000;
	assert.equal(turnActiveMs(start, start + 1000, 5000), 0);
	assert.equal(turnActiveMs(start, start + 1000, -5000), 1000);
	assert.equal(turnActiveMs(start, start + 1000, undefined), 1000);
	assert.equal(turnActiveMs(0, Date.now()), 0, "no open turn means no active time");
});

test("an overnight pause on one task costs no task clock", () => {
	// Turn 1: 5 min of work. Then 14 hours idle (no turn open). Turn 2: 5 min.
	const t1 = 1_000_000;
	let accumulated = turnActiveMs(t1, t1 + 5 * 60_000);
	const t2 = t1 + 14 * 60 * 60_000;
	accumulated += turnActiveMs(t2, t2 + 5 * 60_000);
	assert.equal(accumulated, 10 * 60_000);
});

test("a long ask_user answer inside one turn costs no task clock", () => {
	const start = 1_000_000;
	// 50 minutes elapsed, 48 of them waiting on the human.
	assert.equal(turnActiveMs(start, start + 50 * 60_000, 48 * 60_000), 2 * 60_000);
});

// ── Task clock lifecycle wiring ──────────────────────────────────────────────

test("a closed task turn does not charge inter-turn idle time", () => {
	const start = 1_000_000;
	let clock = openTaskClock(createTaskClock(), start);
	clock = closeTaskClock(clock, start + 5 * 60_000);
	assert.equal(taskClockElapsedMs(clock, start + 65 * 60_000), 5 * 60_000);

	clock = openTaskClock(clock, start + 65 * 60_000);
	clock = closeTaskClock(clock, start + 70 * 60_000);
	assert.equal(taskClockElapsedMs(clock, start + 10 * 60 * 60_000), 10 * 60_000);
});

test("task clock excludes completed and in-flight ask_user waits", () => {
	const start = 1_000_000;
	let clock = openTaskClock(createTaskClock(), start);
	clock = addTaskClockWait(clock, 8 * 60_000);
	assert.equal(taskClockElapsedMs(clock, start + 10 * 60_000), 2 * 60_000);
	assert.equal(taskClockElapsedMs(clock, start + 12 * 60_000, 2 * 60_000), 2 * 60_000);
});

test("reset between turns clears time and carries no stale interval", () => {
	const start = 1_000_000;
	let clock = openTaskClock(createTaskClock(), start);
	clock = closeTaskClock(clock, start + 5 * 60_000);
	clock = resetTaskClock(clock, start + 10 * 60_000);
	assert.deepEqual(clock, createTaskClock());
	assert.equal(taskClockElapsedMs(clock, start + 60 * 60_000), 0);
});

test("reset during an active turn rebases the clock for the new task", () => {
	const start = 1_000_000;
	let clock = openTaskClock(createTaskClock(), start);
	clock = resetTaskClock(clock, start + 3 * 60_000);
	assert.equal(taskClockElapsedMs(clock, start + 5 * 60_000), 2 * 60_000);
	clock = closeTaskClock(clock, start + 5 * 60_000);
	assert.equal(taskClockElapsedMs(clock, start + 50 * 60_000), 2 * 60_000);
});

test("closing a task turn is idempotent", () => {
	const start = 1_000_000;
	let clock = openTaskClock(createTaskClock(), start);
	clock = closeTaskClock(clock, start + 5 * 60_000);
	clock = closeTaskClock(clock, start + 65 * 60_000);
	assert.equal(taskClockElapsedMs(clock, start + 24 * 60 * 60_000), 5 * 60_000);
});

test("PLAN38-shaped wall time reports only the active work", () => {
	const start = 1_000_000;
	let clock = openTaskClock(createTaskClock(), start);
	clock = closeTaskClock(clock, start + 4 * 60_000);
	clock = openTaskClock(clock, start + 44 * 60_000);
	clock = closeTaskClock(clock, start + 48 * 60_000);
	assert.equal(taskClockElapsedMs(clock, start + 48 * 60_000), 8 * 60_000);
});

// ── Skipped triage assumes the cheap tier (finding 4) ───────────────────────

test("the assumed tier is small, so a skipped triage cannot unlock the apparatus", () => {
	assert.equal(DEFAULT_TASK_TIER, "small");
	for (const persona of HEAVY_PERSONAS) {
		assert.ok(checkTierPersonaGate(DEFAULT_TASK_TIER, persona), `${persona} must stay gated on a skipped triage`);
	}
	assert.equal(resolveTurnBudget(DEFAULT_TASK_TIER).delegation, false);
	assert.equal(blockingFindingCap(DEFAULT_TASK_TIER), 2);
});

test("escalating from the assumed tier is a normal ratchet raise (needs a reason)", () => {
	assert.equal(applyTierChange(DEFAULT_TASK_TIER, "feature").ok, false);
	assert.equal(applyTierChange(DEFAULT_TASK_TIER, "feature", "touches 4 services").ok, true);
	// But a FIRST declaration is never an escalation: the hub passes null while the
	// tier is only assumed, so the dispatcher's own triage call is free.
	assert.equal(applyTierChange(null, "feature").ok, true);
});
