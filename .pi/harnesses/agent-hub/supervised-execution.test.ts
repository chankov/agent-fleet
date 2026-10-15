import assert from "node:assert/strict";
import test from "node:test";
import { classifyOrchestrationRoute, selectSpecialists } from "./orchestration-route.ts";
import { applyProcessClassification, createProcessState, effectiveProcessStage, evaluateProcessObligations, normalizeProcessState, noteProcessStage, processPreEffectGate } from "./process-obligations.ts";
import { applyTaskTriageAdditions } from "./task-triage-obligations.ts";
import { TASK_TIERS, resolveTurnBudget, resolveTaskBudget, checkTurnBudget, checkTaskBudget, checkReviewRoundCap, budgetStatusLine } from "./run-budget.js";

test("supervised execution: usage stays visible without count, elapsed-time or review renewal quotas", () => {
 for (const tier of TASK_TIERS) {
  const budget = resolveTurnBudget(tier, { maxDispatches: 1, maxResearch: 1, wallMs: 1 });
  const taskBudget = resolveTaskBudget(budget);
  for (const kind of ["dispatch", "research"]) {
   assert.equal(checkTurnBudget(kind, { dispatches: 999, research: 999 }, budget, 99_000_000, tier), null);
   assert.equal(checkTaskBudget(kind, { dispatches: 999, research: 999 }, taskBudget, 99_000_000, tier), null);
  }
  assert.equal(checkReviewRoundCap(tier, "code-reviewer", 999), null);
  assert.ok(budget.agentTurnMs > 0, "single-process deadline is preserved");
  assert.match(budgetStatusLine({ dispatches: 999, research: 999 }, budget, tier), /999\/∞/);
 }
});

test("supervised execution: size risk missing plan and sensitive signals never mandate Planner", () => {
 for (const risk of ["low", "high", "secret", "cloud"] as const) for (const approvedPlan of [false, true]) {
  const input = { scopeBreadth: "wide" as const, risk, approvedPlan, reversible: false, unresolvedForks: ["requires research and user decision"] };
  assert.equal(classifyOrchestrationRoute(input).route, "builder-reviewer");
  const route = selectSpecialists(input, { secret: true, cloud: true, contradiction: true });
  assert.deepEqual(route.stages, ["builder", "reviewer"]);
  assert.match(route.reason, /research.*ask_user/i);
 }
});

test("supervised execution: wide-change current and restored obligations require review without a plan gate", () => {
 const classified = applyProcessClassification(createProcessState(), { scope: "wide", risk: "high", reason: "authorized implementation" }).state;
 const state = applyTaskTriageAdditions(classified, { status: "applied", reasons: ["wide_change", "security_change"] }, { taskId: "task", evaluationId: "evaluation", inputRevision: "revision" });
 for (const current of [state, normalizeProcessState({ ...state, plan: { required: true, evidenceRef: null, revision: null } })]) {
  assert.equal(effectiveProcessStage(current, "plan"), false);
  assert.equal(processPreEffectGate(current, "write"), null);
  assert.equal(processPreEffectGate(current, "child", "builder"), null);
  const verdict = evaluateProcessObligations(current, { writable: true, budgetTier: "project" });
  assert.equal(verdict.obligations.review.status, "open");
  assert.equal(verdict.obligations.acceptance.status, "open");
  assert.equal(verdict.accepted, false);
  assert.equal(current.additions?.length, 2, "source history is retained");
 }
 const irreversible = applyTaskTriageAdditions(state, { status: "applied", reasons: ["irreversible_execution"] }, { taskId: "task", evaluationId: "evaluation", inputRevision: "revision" });
 assert.equal(processPreEffectGate(irreversible, "write")?.reason, "action_confirmation_unsupported");
});

test("supervised execution: broad-change advice retains an existing optional plan and migrates its old rule", () => {
 const planned = noteProcessStage(createProcessState(), "plan", { evidenceRef: "existing-plan.md", revision: "approved" });
 const state = applyTaskTriageAdditions(planned, { status: "applied", reasons: ["wide_change"] }, { taskId: "task", evaluationId: "new-evaluation", inputRevision: "expanded" });
 assert.equal(state.plan.evidenceRef, "existing-plan.md");
 const restored = normalizeProcessState({ ...state, appliedRuleIds: ["scope-wide-plan-review"] });
 assert.deepEqual(restored.appliedRuleIds, ["scope-wide-independent-review"]);
 assert.equal(effectiveProcessStage(restored, "review"), true);
});
