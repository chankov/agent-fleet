import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNoProgressGuard, canonicalExecutor } from "./no-progress.ts";
import { recoveryCategoryFromDetails } from "./recovery-contract.ts";
import { createResearchExecutor, createDispatchExecutor } from "./tools/dispatch-execution.ts";
import { applyProcessClassification, createProcessState, processPreEffectGate, readOnlyInspectionRoute } from "./process-obligations.ts";
import { resolveWorkModeTools } from "./work-mode.ts";

function researchDeps(tierRef: { current: string }) {
  const agents = new Map([["builder", { def: { name: "builder", tools: "read" }, runCount: 0, contextPct: 0, lastBackend: null }]]);
  const turnReport: any = { refusals: 0, dispatches: [], research: 0, tier: tierRef.current };
  const sessionTotals: any = { refusals: 0, dispatches: 0, research: 0, billed: 0, out: 0 };
  let turnResearch = 0, taskResearch = 0;
  const processState = applyProcessClassification(createProcessState(), { risk: "low", scope: "small", reason: "fixture" }).state;
  return {
    noProgress: createNoProgressGuard(),
    state: {
      getTurnDispatchCount: () => 0, setTurnDispatchCount() {},
      getTurnResearchCount: () => turnResearch, setTurnResearchCount: (v: number) => { turnResearch = v; },
      getTaskDispatchCount: () => 0, setTaskDispatchCount() {},
      getTaskResearchCount: () => taskResearch, setTaskResearchCount: (v: number) => { taskResearch = v; },
      getTaskReviewRounds: () => 0, setTaskReviewRounds() {},
      getTaskTier: () => tierRef.current,
      getProcessState: () => processState, setProcessState() {}, persistProcessVerdict() {},
      getTurnReport: () => turnReport, getSessionTotals: () => sessionTotals,
      getTurnDispatchFingerprints: () => new Set<string>(),
      getExternalBlockers: () => [], getExternalBlockerAcknowledged: () => false,
      setExternalBlockerAcknowledged() {}, getExternalBlockerRefusedOnce: () => false,
      setExternalBlockerRefusedOnce() {}, isAskUserAvailable: () => true,
      getUserLanguage: () => "English", getSessionDir: () => "/tmp",
      getAgentStates: () => agents, getAssertions: () => [],
      getResearchPersonas: () => [{ name: "deep-researcher" }],
      getActiveWritableDispatches: () => 0, setActiveWritableDispatches() {},
      getWritableOverlapCounter: () => 0, setWritableOverlapCounter() {},
    },
    budget: {
      ensureTaskTier() {},
      taskCounters: () => ({ dispatches: 0, research: taskResearch, reviewRounds: 0 }),
      currentTaskBudget: () => ({ maxDispatches: 8, maxResearch: 8, maxReviewRounds: 4 }),
      taskActiveElapsedMs: () => 0,
      currentBudget: () => ({ maxDispatches: 2, maxResearch: 8 }),
      turnBudgetActiveElapsedMs: () => 0,
      updateModeStatus() {},
    },
    artifacts: { writeRunArtifact: () => "/tmp/tool-result.md", loadInputArtifacts: () => [] },
    research: {
      anonymousDef: () => ({ name: "research", tools: "read,grep,find,ls" }),
      resolveModel: () => "test/model",
      createState: () => ({ id: 1 }),
      spawn: async () => ({ output: "safe findings", exitCode: 0, elapsed: 1, dispatchId: "research-launch-1", lifecycle: { launched: true, closeSeen: true } }),
    },
    budgetRecovery: { ensure: async () => null },
    provisionalCapabilityRefusal: () => null,
    dispatchAgent: async () => ({ output: "", exitCode: 0, elapsed: 0 }),
    runReturnExtraction: async () => null,
    extractNeedsResearch: () => [], extractAskUserQuestions: () => [],
    contextPressure: () => false, displayName: (n: string) => n,
    _report: turnReport,
  };
}

test("T1/T7: tier refusal is not_started with 0 launches and 0 indeterminate; feature correction launches once without reset/grant/reconcile", async t => {
  const cwd = mkdtempSync(join(tmpdir(), "autonomous-tier-")); t.after(() => rmSync(cwd, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", cwd]);
  const tierRef = { current: "small" };
  const d: any = researchDeps(tierRef);
  let launches = 0;
  d.research.spawn = async () => { launches++; return { output: "safe findings", exitCode: 0, elapsed: 1, dispatchId: "research-launch-1", lifecycle: { launched: true, closeSeen: true } }; };
  const run = createResearchExecutor(d);
  const refused: any = await run("one", { task: "trace paths", persona: "deep-researcher", read_scope: ["src"] } as any, undefined, undefined, { cwd } as any);
  assert.equal(refused.details.recoveryCategory, "not_started");
  assert.equal(refused.details.started, false);
  assert.equal(launches, 0);
  // No indeterminate attempt was recorded for the preflight refusal.
  const guard: any = d.noProgress;
  const ledgerOps = [guard.byDispatch("research-launch-1")].filter(Boolean);
  assert.equal(ledgerOps.length, 0);
  assert.match(refused.content[0].text, /tier "small"/);
  assert.match(refused.content[0].text, /Prompt prose did not change state/);
  // Operator corrects the prerequisite (small -> feature) in the same task; no reset.
  tierRef.current = "feature";
  const launched: any = await run("two", { task: "trace paths", persona: "deep-researcher", read_scope: ["src"] } as any, undefined, undefined, { cwd } as any);
  assert.equal(launched.details.status, "done");
  assert.equal(launches, 1);
  assert.equal(launched.details.lifecycle?.launched, true);
  assert.equal(launched.details.lifecycle?.closeSeen, true);
});

test("T2/T4: production canonical identity flows from wrapper to evidence to reconcile", async t => {
  const cwd = mkdtempSync(join(tmpdir(), "autonomous-identity-")); t.after(() => rmSync(cwd, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", cwd]);
  writeFileSync(join(cwd, "partial.ts"), "partial result");
  const { worktreeRevision } = await import("./scope-gate.js");
  const { createHash } = await import("node:crypto");
  const guard = createNoProgressGuard();
  const actor = "Builder";
  const executorKey = canonicalExecutor(cwd, actor);
  assert.match(executorKey, /builder/);
  assert.notEqual(executorKey, "builder");
  // Production evidence uses the same canonical helper (dispatch-execution.ts), so reconcile matches.
  const revision = worktreeRevision(cwd, []);
  const sha256 = createHash("sha256").update("partial result").digest("hex");
  const ticket = guard.begin("contract", "fp", executorKey);
  assert.equal(ticket.allowed, true);
  guard.recordInvocation(ticket.operationId!, "contract", { tool: "dispatch_agent", params: { agent: "builder", task: "work", scope: [], deliverables: [] } as any });
  guard.finish(ticket, "fp", { dispatchId: "dispatch-1", reason: "failed", category: "verification_failed" });
  assert.equal(guard.recordDispatchEvidence({
    dispatchId: "dispatch-1", taskId: guard.taskId(), executor: canonicalExecutor(cwd, "builder"),
    revision, changedScope: ["partial.ts"],
    readback: [{ path: join(cwd, "partial.ts"), status: "read", changed: true, sha256, retainedPath: "evidence/original" } as any],
    concurrentWriters: false, completed: false, blockingFindings: 0, coveredScope: [],
    edited: false, evidenceRef: "evidence/failed", openRequirements: ["AF-MIN-CHANGE"],
  }), true);
  assert.equal(guard.recordDispatchEvidence({
    dispatchId: "review-1", taskId: guard.taskId(), executor: canonicalExecutor(cwd, "code-reviewer"),
    revision, changedScope: [], readback: [], concurrentWriters: false, completed: true,
    blockingFindings: 0, coveredScope: ["partial.ts"], edited: false,
    evidenceRef: "evidence/review", openRequirements: [],
  }), true);
  const outcome: any = guard.reconcile(ticket.operationId!, ticket.attemptId!, revision, { cwd, sessionDir: cwd });
  assert.equal(outcome.cleared, true);
  assert.equal(outcome.acceptance, "not_accepted");
});

test("T3: safety refusal, spawn failure, and timeout-without-close stay distinct; exit alone never settles", () => {
  assert.equal(recoveryCategoryFromDetails({ status: "error", exitCode: 1, lifecycle: { launched: false, closeSeen: false } }), "not_started");
  assert.equal(recoveryCategoryFromDetails({ status: "error", exitCode: 1, spawnError: "boom", lifecycle: { launched: false, closeSeen: false } }), "not_started");
  // Launched but no close stays uncertain: integer exit must not fabricate settlement.
  assert.equal(recoveryCategoryFromDetails({ status: "error", exitCode: 1, dispatchId: "d", lifecycle: { launched: true, closeSeen: false } }), "indeterminate");
  assert.equal(recoveryCategoryFromDetails({ status: "tier_persona_gate", exitCode: 1, started: false }), "not_started");
});

test("T5: wide/low operator keeps read inspection without planner; arbitrary shell stays refused with a usable route", () => {
  const wide = applyProcessClassification(createProcessState(), { risk: "low", scope: "wide", reason: "planning task" }).state;
  // Planner may pass the child gate while the plan is open; other children may not.
  assert.equal(processPreEffectGate(wide, "child", "planner"), null);
  const refused = processPreEffectGate(wide, "child", "builder");
  assert.equal(refused?.reason, "process_plan_open");
  assert.match(refused!.message, /read\/grep\/find\/ls/);
  // Arbitrary shell is a write effect even in operator mode: no exemption, but inspection needs no planner.
  const shell = processPreEffectGate(wide, "write");
  assert.ok(shell);
  assert.match(shell!.message, new RegExp(readOnlyInspectionRoute().slice(0, 24)));
  // Orchestrator never receives generic direct tools.
  const orchestrator = resolveWorkModeTools({ workMode: "orchestrator" as any, baselineTools: ["read", "bash", "edit"], comsReady: false, herdrReady: false, askUserAvailable: true } as any);
  assert.ok(!orchestrator.includes("bash") && !orchestrator.includes("edit"));
});

test("T6/T8: missing/invalid/abandoned/unknown-process have distinct reasons; legacy preflight needs positive no-launch proof", () => {
  const guard: any = createNoProgressGuard();
  assert.equal(guard.invocationStatus("nope").status, "missing");
  const ticket = guard.begin("contract", "fp", "builder");
  guard.recordInvocation(ticket.operationId, "contract", { tool: "dispatch_agent", params: { agent: "builder", task: "work" } as any });
  guard.finish(ticket, "fp", { dispatchId: "d1", reason: "x", category: "not_started" });
  assert.equal(guard.invocationStatus(ticket.operationId).status, "available");
  const abandoned = guard.begin("other", "fp2", "other-exec");
  guard.recordInvocation(abandoned.operationId, "other", { tool: "dispatch_agent", params: { agent: "builder", task: "work" } as any });
  guard.finish(abandoned, "fp2", { dispatchId: "d2", reason: "x", category: "indeterminate" });
  guard.settle(abandoned.operationId, abandoned.attemptId, "exit");
  assert.equal(guard.abandon(abandoned.operationId, abandoned.attemptId, "n1"), true);
  assert.equal(guard.invocationStatus(abandoned.operationId).status, "abandoned");
  // Legacy phantom is fail-closed without positive evidence.
  assert.equal(guard.establishNoLaunch("d1", guard.taskToken(), ""), false);
  assert.equal(guard.establishNoLaunch("d1", guard.taskToken(), "proc-table:no-pid"), true);
  // Unknown-write fences are never freed by the no-launch port.
  const unknown = guard.begin("u", "fpu", "u-exec");
  guard.finish(unknown, "fpu", { dispatchId: "du", reason: "x", category: "tool_protocol_error" });
  assert.equal(guard.establishNoLaunch("du", guard.taskToken(), "proc-table:clean"), false);
});

test("T7: refusals are never presented as child launches and carry the authoritative snapshot", async t => {
  const cwd = mkdtempSync(join(tmpdir(), "autonomous-snapshot-")); t.after(() => rmSync(cwd, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", cwd]);
  const tierRef = { current: "small" };
  const d: any = researchDeps(tierRef);
  const run = createResearchExecutor(d);
  const refused: any = await run("one", { task: "trace", persona: "deep-researcher" } as any, undefined, undefined, { cwd } as any);
  assert.equal(refused.details.started, false);
  assert.equal(refused.details.notStarted, true);
  assert.equal(refused.details.effects, "none");
  assert.ok(!("backendUsed" in refused.details) || refused.details.backendUsed == null);
});
