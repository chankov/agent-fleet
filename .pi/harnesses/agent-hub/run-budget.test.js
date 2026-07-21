import test from "node:test";
import assert from "node:assert/strict";

import {
	HUB_MODES,
	DEFAULT_HUB_MODE,
	MODE_BUDGETS,
	RECYCLE_CONTEXT_PCT,
	TASK_TIERS,
	TIER_CAPS,
	normalizeHubMode,
	normalizeTaskTier,
	resolveTurnBudget,
	checkTurnBudget,
	shouldRecycleSession,
	budgetStatusLine,
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

test("checkTurnBudget refuses on dispatch cap with actionable guidance", () => {
	const budget = resolveTurnBudget("fast");
	const r = checkTurnBudget("dispatch", { dispatches: 2, research: 0 }, budget, 0, "fast");
	assert.equal(r.reason, "dispatches");
	assert.match(r.message, /Do NOT retry/);
	assert.match(r.message, /ask the user/);
	assert.match(r.message, /\/hub-mode/);
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
