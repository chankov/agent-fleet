import test from "node:test";
import assert from "node:assert/strict";

import {
	HUB_MODES,
	DEFAULT_HUB_MODE,
	HARD_RECYCLE_CONTEXT_PCT,
	MODE_BUDGETS,
	RECYCLE_CONTEXT_PCT,
	contextOverflowDiagnostic,
	TASK_TIERS,
	TIER_CAPS,
	normalizeHubMode,
	normalizeTaskTier,
	resolveTurnBudget,
	checkTurnBudget,
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
	remainingTaskResearch,
	reviewRoundCap,
	checkReviewRoundCap,
	applyTierChange,
	resolveTaskBudget,
	checkTaskBudget,
	checkTierPersonaGate,
	blockingFindingCap,
	isReviewPersona,
	reviewBudgetClause,
} from "./run-budget.js";

test("normalizeHubMode accepts case/whitespace variants and rejects unknowns", () => {
	assert.equal(normalizeHubMode("fast"), "fast");
	assert.equal(normalizeHubMode(" STRICT "), "strict");
	assert.equal(normalizeHubMode("Standard"), "standard");
	assert.equal(normalizeHubMode("turbo"), null);
	assert.equal(normalizeHubMode(""), null);
	assert.equal(normalizeHubMode(undefined), null);
});

test("resolveTurnBudget returns mode defaults untouched", () => {
	for (const mode of HUB_MODES) {
		assert.deepEqual(resolveTurnBudget(mode), MODE_BUDGETS[mode]);
	}
});

test("resolveTurnBudget falls back to the default mode on junk", () => {
	assert.deepEqual(resolveTurnBudget("junk"), MODE_BUDGETS[DEFAULT_HUB_MODE]);
});

test("resolveTurnBudget override precedence: number replaces, null disables, undefined keeps", () => {
	const b = resolveTurnBudget("standard", { maxDispatches: 3, agentTurnMs: null });
	assert.equal(b.maxDispatches, 3);
	assert.equal(b.agentTurnMs, null);
	assert.equal(b.maxResearch, MODE_BUDGETS.standard.maxResearch);
	assert.equal(b.delegation, true); // mode-owned, not overridable
});

test("normalizeTaskTier accepts variants and rejects unknowns", () => {
	assert.equal(normalizeTaskTier("small"), "small");
	assert.equal(normalizeTaskTier(" TRIVIAL "), "trivial");
	assert.equal(normalizeTaskTier("Project"), "project");
	assert.equal(normalizeTaskTier("huge"), null);
	assert.equal(normalizeTaskTier(undefined), null);
});

test("resolveTurnBudget without a tier applies no tier caps", () => {
	for (const mode of HUB_MODES) {
		assert.deepEqual(resolveTurnBudget(mode, {}, null), MODE_BUDGETS[mode]);
	}
});

test("resolveTurnBudget lowers dispatch/research caps to the declared tier", () => {
	const b = resolveTurnBudget("standard", {}, "trivial");
	assert.equal(b.maxDispatches, 1);
	assert.equal(b.maxResearch, 1);
	// Non-dispatch axes stay mode-owned.
	assert.equal(b.wallMs, MODE_BUDGETS.standard.wallMs);
	const strict = resolveTurnBudget("strict", {}, "small");
	assert.equal(strict.maxDispatches, 2);
});

test("resolveTurnBudget tier never raises the mode/override budget", () => {
	// fast allows 2 dispatches; feature tier caps at 6 — min wins.
	assert.equal(resolveTurnBudget("fast", {}, "feature").maxDispatches, 2);
	// project adds no caps at all.
	assert.deepEqual(resolveTurnBudget("standard", {}, "project"), MODE_BUDGETS.standard);
	// An off (null) override is still bounded by the tier cap.
	assert.equal(resolveTurnBudget("standard", { maxDispatches: null }, "small").maxDispatches, 2);
});

test("every tier has caps and TIER_CAPS covers exactly TASK_TIERS", () => {
	assert.deepEqual(Object.keys(TIER_CAPS).sort(), [...TASK_TIERS].sort());
});

test("checkTurnBudget allows calls under every limit", () => {
	const budget = resolveTurnBudget("standard");
	assert.equal(checkTurnBudget("dispatch", { dispatches: 0, research: 0 }, budget, 0), null);
	assert.equal(checkTurnBudget("research", { dispatches: 7, research: 3 }, budget, 1000), null);
});

test("checkTurnBudget refuses on dispatch cap with one-click continuation guidance", () => {
	const budget = resolveTurnBudget("fast");
	const r = checkTurnBudget("dispatch", { dispatches: 2, research: 0 }, budget, 0, "fast");
	assert.equal(r.reason, "dispatches");
	assert.match(r.message, /Do NOT retry/);
	assert.match(r.message, /one-click budget continuation/);
	assert.match(r.message, /Do not ask for a typed continue message or a slash command/);
	assert.match(r.message, /\/af-hub-mode/);
});

test("checkTurnBudget refuses on research cap only for research calls", () => {
	const budget = resolveTurnBudget("fast");
	const counters = { dispatches: 0, research: 1 };
	assert.equal(checkTurnBudget("research", counters, budget, 0).reason, "research");
	assert.equal(checkTurnBudget("dispatch", counters, budget, 0), null);
});

test("checkTurnBudget wall clock wins over per-kind caps", () => {
	const budget = resolveTurnBudget("standard");
	const r = checkTurnBudget("dispatch", { dispatches: 99, research: 0 }, budget, budget.wallMs);
	assert.equal(r.reason, "wall");
});

test("checkTurnBudget honors off (null) axes", () => {
	const budget = resolveTurnBudget("standard", { maxDispatches: null, wallMs: null });
	assert.equal(checkTurnBudget("dispatch", { dispatches: 500, research: 0 }, budget, 10 ** 9), null);
});

test("shouldRecycleSession triggers on run count or context pressure", () => {
	const budget = resolveTurnBudget("standard"); // recycleRuns 5
	assert.equal(shouldRecycleSession(0, 99, budget), false); // fresh session never recycles
	assert.equal(shouldRecycleSession(4, 10, budget), false);
	assert.equal(shouldRecycleSession(5, 10, budget), true);
	assert.equal(shouldRecycleSession(1, RECYCLE_CONTEXT_PCT, budget), true);
	assert.equal(shouldRecycleSession(1, RECYCLE_CONTEXT_PCT - 1, budget), false);
});

test("shouldRecycleSession with recycleRuns off still respects context threshold", () => {
	const budget = resolveTurnBudget("standard", { recycleRuns: null });
	assert.equal(shouldRecycleSession(50, 10, budget), false);
	assert.equal(shouldRecycleSession(50, 75, budget), true);
});

test("shouldRecycleSession hard-recycles at or above a full context window", () => {
	// A raised threshold must not defeat the hard limit: past 100% the session
	// no longer fits, so resuming it cannot be the cheaper option.
	const budget = resolveTurnBudget("standard", { recycleRuns: null });
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

test("budgetStatusLine renders caps and infinities", () => {
	const budget = resolveTurnBudget("strict", { maxResearch: null });
	assert.equal(
		budgetStatusLine("strict", { dispatches: 3, research: 1 }, budget),
		"Mode: strict · 3/24 disp · 1/∞ res",
	);
	assert.equal(
		budgetStatusLine("standard", { dispatches: 1, research: 0 }, resolveTurnBudget("standard", {}, "small"), "small"),
		"Mode: standard·small · 1/2 disp · 0/2 res",
	);
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

test("resolveTaskBudget multiplies each axis and keeps disabled axes off", () => {
	const turn = resolveTurnBudget("standard");
	const task = resolveTaskBudget(turn);
	assert.equal(task.maxDispatches, 24);
	assert.equal(task.maxResearch, 12);
	assert.equal(task.wallMs, 3 * 60 * 60_000);
	const offAxis = resolveTaskBudget({ maxDispatches: null, maxResearch: 4, wallMs: null });
	assert.equal(offAxis.maxDispatches, null);
	assert.equal(offAxis.wallMs, null);
	assert.equal(offAxis.maxResearch, 12);
});

test("resolveTaskBudget respects a custom multiplier and never rounds an axis to zero", () => {
	assert.equal(resolveTaskBudget({ maxDispatches: 2, maxResearch: 1, wallMs: 1000 }, 1).maxDispatches, 2);
	assert.equal(resolveTaskBudget({ maxDispatches: 1, maxResearch: 1, wallMs: 1000 }, 0.1).maxDispatches, 1);
});

test("checkTaskBudget allows calls inside the envelope", () => {
	const task = resolveTaskBudget(resolveTurnBudget("standard", {}, "small"));
	assert.equal(checkTaskBudget("dispatch", { dispatches: 5, research: 0 }, task, 0, "small"), null);
});

test("checkTaskBudget stops the task on dispatches, research and wall clock", () => {
	const task = resolveTaskBudget(resolveTurnBudget("standard", {}, "small")); // 6 / 6 / 180min
	const disp = checkTaskBudget("dispatch", { dispatches: 6, research: 0 }, task, 0, "small");
	assert.equal(disp.reason, "task_dispatches");
	const res = checkTaskBudget("research", { dispatches: 0, research: 6 }, task, 0, "small");
	assert.equal(res.reason, "task_research");
	const wall = checkTaskBudget("dispatch", { dispatches: 0, research: 0 }, task, 200 * 60_000, "small");
	assert.equal(wall.reason, "task_wall");
});

test("a task-budget refusal requires one-click continuation rather than a fake new task", () => {
	const task = resolveTaskBudget(resolveTurnBudget("fast"));
	const refusal = checkTaskBudget("dispatch", { dispatches: 99, research: 0 }, task, 0, "trivial");
	assert.match(refusal.message, /HARD STOP/);
	assert.match(refusal.message, /does\s+NOT reopen it/);
	assert.match(refusal.message, /one-click task-budget continuation/);
	assert.match(refusal.message, /preserving task state/);
	assert.match(refusal.message, /set_task_tier.*new_task: true.*only when/);
});

test("the task envelope is strictly wider than one turn — the turn gate still fires first", () => {
	for (const mode of HUB_MODES) {
		const turn = resolveTurnBudget(mode);
		const task = resolveTaskBudget(turn);
		if (turn.maxDispatches != null) assert.ok(task.maxDispatches > turn.maxDispatches);
		if (turn.wallMs != null) assert.ok(task.wallMs > turn.wallMs);
	}
});

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
	assert.equal(checkTierPersonaGate(null, "planner"), null, "strict mode leaves the tier unset on purpose");
});

test("checkTierPersonaGate is case- and whitespace-insensitive", () => {
	assert.ok(checkTierPersonaGate("small", " Plan-Reviewer "));
});

test("the gate names the escape hatch instead of just refusing", () => {
	const gate = checkTierPersonaGate("trivial", "planner");
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

test("budgetStatusLine appends task usage when a task envelope is passed", () => {
	const turn = resolveTurnBudget("standard", {}, "small");
	const line = budgetStatusLine("standard", { dispatches: 1, research: 0 }, turn, "small", {
		counters: { dispatches: 4, research: 1 },
		budget: resolveTaskBudget(turn),
	});
	assert.equal(line, "Mode: standard·small · 1/2 disp · 0/2 res · task 4/6");
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
	// Well inside even fast mode's 45-minute task envelope.
	const task = resolveTaskBudget(resolveTurnBudget("fast"));
	assert.equal(checkTaskBudget("dispatch", { dispatches: 0, research: 0 }, task, accumulated, "small"), null);
});

test("a long ask_user answer inside one turn costs no task clock", () => {
	const start = 1_000_000;
	// 50 minutes elapsed, 48 of them waiting on the human.
	const active = turnActiveMs(start, start + 50 * 60_000, 48 * 60_000);
	const task = resolveTaskBudget(resolveTurnBudget("fast")); // 45 min envelope
	assert.equal(checkTaskBudget("dispatch", { dispatches: 0, research: 0 }, task, active, "small"), null);
});

test("the task clock still stops a genuinely long-running task", () => {
	const task = resolveTaskBudget(resolveTurnBudget("fast"));
	const refusal = checkTaskBudget("dispatch", { dispatches: 0, research: 0 }, task, 46 * 60_000, "small");
	assert.equal(refusal.reason, "task_wall");
	assert.match(refusal.message, /ACTIVE time/);
	assert.match(refusal.message, /human was away is not charged/);
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

test("PLAN38-shaped wall time stays below the fast task gate when active work is short", () => {
	const start = 1_000_000;
	let clock = openTaskClock(createTaskClock(), start);
	clock = closeTaskClock(clock, start + 4 * 60_000);
	clock = openTaskClock(clock, start + 44 * 60_000);
	clock = closeTaskClock(clock, start + 48 * 60_000);
	const active = taskClockElapsedMs(clock, start + 48 * 60_000);
	assert.equal(active, 8 * 60_000);
	const task = resolveTaskBudget(resolveTurnBudget("fast"));
	assert.equal(checkTaskBudget("dispatch", { dispatches: 0, research: 0 }, task, active, "small"), null);
});

test("the lifecycle clock still trips the fast task gate after genuine active work", () => {
	const start = 1_000_000;
	let clock = openTaskClock(createTaskClock(), start);
	clock = closeTaskClock(clock, start + 46 * 60_000);
	const task = resolveTaskBudget(resolveTurnBudget("fast"));
	assert.equal(
		checkTaskBudget("dispatch", { dispatches: 0, research: 0 }, task, taskClockElapsedMs(clock, start + 2 * 60 * 60_000), "small")?.reason,
		"task_wall",
	);
});

// ── Auto-research counts against the task envelope (finding 3) ───────────────

test("remainingTaskResearch reports what the task envelope still allows", () => {
	const task = resolveTaskBudget(resolveTurnBudget("standard", {}, "small")); // 6
	assert.equal(remainingTaskResearch(task, { research: 0 }), 6);
	assert.equal(remainingTaskResearch(task, { research: 4 }), 2);
	assert.equal(remainingTaskResearch(task, { research: 6 }), 0);
	assert.equal(remainingTaskResearch(task, { research: 99 }), 0, "never negative");
});

test("remainingTaskResearch is unlimited when the axis is off", () => {
	assert.equal(remainingTaskResearch({ maxResearch: null }, { research: 12 }), null);
	assert.equal(remainingTaskResearch({ maxResearch: 3 }, undefined), 3);
});

// ── Skipped triage assumes the cheap tier (finding 4) ───────────────────────

test("the assumed tier is small, so a skipped triage cannot unlock the apparatus", () => {
	assert.equal(DEFAULT_TASK_TIER, "small");
	for (const persona of HEAVY_PERSONAS) {
		assert.ok(checkTierPersonaGate(DEFAULT_TASK_TIER, persona), `${persona} must stay gated on a skipped triage`);
	}
	const budget = resolveTurnBudget("standard", {}, DEFAULT_TASK_TIER);
	assert.equal(budget.maxDispatches, 2);
	assert.equal(blockingFindingCap(DEFAULT_TASK_TIER), 2);
});

test("escalating from the assumed tier is a normal ratchet raise (needs a reason)", () => {
	assert.equal(applyTierChange(DEFAULT_TASK_TIER, "feature").ok, false);
	assert.equal(applyTierChange(DEFAULT_TASK_TIER, "feature", "touches 4 services").ok, true);
	// But a FIRST declaration is never an escalation: the hub passes null while the
	// tier is only assumed, so the dispatcher's own triage call is free.
	assert.equal(applyTierChange(null, "feature").ok, true);
});

// ── Review round cap (finding 1) ────────────────────────────────────────────

test("reviewRoundCap tightens with the tier", () => {
	assert.equal(reviewRoundCap("trivial"), 1);
	assert.equal(reviewRoundCap("small"), 1);
	assert.equal(reviewRoundCap("feature"), 2);
	assert.equal(reviewRoundCap("project"), null);
	assert.equal(reviewRoundCap(null), null);
});

test("checkReviewRoundCap refuses the round after the cap", () => {
	assert.equal(checkReviewRoundCap("feature", "code-reviewer", 0), null);
	assert.equal(checkReviewRoundCap("feature", "code-reviewer", 1), null);
	const gate = checkReviewRoundCap("feature", "code-reviewer", 2);
	assert.equal(gate.reason, "review_round_cap");
	assert.match(gate.message, /NOT counted against any budget/);
	assert.match(gate.message, /A review is a GATE, not a loop/);
	assert.match(gate.message, /set_task_tier.*new_task: true/);
});

test("checkReviewRoundCap only applies to review personas and capped tiers", () => {
	assert.equal(checkReviewRoundCap("small", "builder", 99), null);
	assert.equal(checkReviewRoundCap("project", "code-reviewer", 99), null);
	assert.equal(checkReviewRoundCap(null, "code-reviewer", 99), null);
});

test("at trivial/small one review round is the whole gate", () => {
	for (const tier of ["trivial", "small"]) {
		assert.equal(checkReviewRoundCap(tier, "code-reviewer", 0), null);
		assert.ok(checkReviewRoundCap(tier, "code-reviewer", 1));
	}
});
