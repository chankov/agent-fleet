import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDispatchExecutor,createResearchExecutor,type WriterEntry } from "./dispatch-execution.ts";
import { applyProcessClassification,createProcessState,noteProcessStage,processPreEffectGate,evaluateProcessObligations,processAuditRecord,latestProcessState } from "../process-obligations.ts";
import { applyTaskTriageAdditions } from "../task-triage-obligations.ts";
import { revisionOf,worktreeRevision } from "../scope-gate.js";
import { reviewInput } from "../review-reuse.ts";
import { extractAskUserQuestions } from "../presentation.ts";

import { gitDiagnosticsFixture,nativeCleanLifecycle,highRiskChangedFixture,operatorStateFixture } from "./dispatch-execution.test-support.ts";

test("T4 wide small: optional plan artifact and covered review preserve accounting", async t => {
 const { cwd, d } = await gitDiagnosticsFixture(t);
 const binding = { taskId: d.noProgress.taskId(), evaluationId: "evaluation", inputRevision: "input" };
 const revision = worktreeRevision(cwd, []);
 let process = applyTaskTriageAdditions(
  applyProcessClassification(createProcessState(), { risk: "low", scope: "small", reason: "declared" }).state,
  { status: "applied", reasons: ["wide_change"] }, binding);
 process = noteProcessStage(process, "acceptance", { evidenceRef: "test:verified", revision, changedFiles: ["src/api.ts"] });
 d.state.getProcessState = () => process; d.state.setProcessState = (value: any) => { process = value; };
 d._agents.set("editor", { def: { name: "editor", tools: "read" }, runCount: 0, lastBackend: "native" });
 d._agents.set("reviewer", { def: { name: "reviewer", tools: "read" }, runCount: 0, lastBackend: "native" });
 let output = "Plan: inspect and update src/api.ts, then test and independently review the changed scope.";
 d.dispatchAgent = async () => ({ output, exitCode: 0, elapsed: 1, dispatchId: output.startsWith("Plan") ? "plan-run" : "review-run" });
 const execute = createDispatchExecutor(d as any);
 assert.equal(processPreEffectGate(process, "child", "editor")?.reason, undefined);
 const plan = await execute("plan", { agent: "editor", practices: ["planning"], task: "Produce a plan" }, undefined, undefined, { cwd } as any);
 assert.ok((plan.details as any).returnPath, "the Hub persisted the actual producer response");
 assert.equal(process.plan.evidenceRef, (plan.details as any).returnPath);
 assert.equal((plan.details as any).processVerdict.obligations.review.status, "open");
 assert.equal((plan.details as any).accepted, false, "plan occurrence does not finish the task");
 output = "verdict: APPROVE\nCurrent src/api.ts changed scope inspected.\ntests_run: full regression";
 const review = await execute("review", { agent: "reviewer", task: "Review changed scope", scope: ["src/api.ts"] }, undefined, undefined, { cwd } as any);
 assert.equal(process.review.evidenceRef, (review.details as any).returnPath);
 assert.equal((review.details as any).processVerdict.accepted, true);
 assert.equal(d._task(), 2); assert.equal(d._turn(), 2);
 assert.equal(d.state.getTaskTier(), "small");
 assert.equal(evaluateProcessObligations(process, { writable: true, budgetTier: "small", currentRevision: revision }).obligations.plan.status, "satisfied");
 // Runtime acceptance of an artifact is still not independent semantic review of the plan or approval.
});

test("T4 an empty optional planner result cannot fabricate plan evidence", async t => {
 const { cwd, d } = await gitDiagnosticsFixture(t);
 let process = applyTaskTriageAdditions(createProcessState(), { status: "applied", reasons: ["wide_change"] }, { taskId: "t", evaluationId: "e", inputRevision: "r" });
 d.state.getProcessState = () => process; d.state.setProcessState = (value: any) => { process = value; };
 d._agents.set("editor", { def: { name: "editor", tools: "read" }, runCount: 0, lastBackend: "native" });
 d.dispatchAgent = async () => ({ output: "  ", exitCode: 0, elapsed: 1, dispatchId: "empty-plan" });
 const result = await createDispatchExecutor(d as any)("plan", { agent: "editor", practices: ["planning"], task: "Plan" }, undefined, undefined, { cwd } as any);
 assert.ok((result.details as any).returnPath, "the empty dispatch still has a run artifact");
 assert.equal(process.plan.evidenceRef, null, "artifact existence alone is not plan evidence");
 assert.equal(processPreEffectGate(process, "write")?.reason, undefined);
 assert.equal((result.details as any).accepted, false);
});

test("T4 optional planner refusal and missing artifact cannot fabricate plan evidence", async t => {
 const { cwd, sessionDir, d } = await gitDiagnosticsFixture(t);
 let process = applyTaskTriageAdditions(createProcessState(), { status: "applied", reasons: ["wide_change"] }, { taskId: "t", evaluationId: "e", inputRevision: "r" });
 d.state.getProcessState = () => process; d.state.setProcessState = (value: any) => { process = value; };
 d._agents.set("editor", { def: { name: "editor", tools: "read,write" }, runCount: 0, lastBackend: "native" });
 const planPath = join(sessionDir, "artifacts", "plan", "synthetic-readme-fix.md");
 d.dispatchAgent = async () => ({ output: "I cannot provide a compliant plan handoff.\nrequires_user_decision: [Grant permission to create the plan artifact]", exitCode: 0, elapsed: 1, dispatchId: "refused-plan" });
 const result = await createDispatchExecutor(d as any)("plan", { agent: "editor", practices: ["planning"], task: "Produce a plan", deliverables: [planPath] }, undefined, undefined, { cwd } as any);
 const details = result.details as any;
 assert.ok(details.returnPath, "a nonempty exit-0 refusal still has a retained return");
 assert.equal(details.deliverableReadback[0].status, "missing");
 assert.equal(details.acceptanceStatus, "deliverable_failed");
 assert.deepEqual(details.structuredReturn.requires_user_decision, ["Grant permission to create the plan artifact"]);
 assert.equal(process.plan.evidenceRef, null);
 assert.equal(processPreEffectGate(process, "write")?.reason, undefined);
});

test("T4 planner substantive parsed user decision blocks even without a declared deliverable", async t => {
 const { cwd, d } = await gitDiagnosticsFixture(t);
 let process = applyTaskTriageAdditions(createProcessState(), { status: "applied", reasons: ["wide_change"] }, { taskId: "t", evaluationId: "e", inputRevision: "r" });
 d.state.getProcessState = () => process; d.state.setProcessState = (value: any) => { process = value; };
 d._agents.set("editor", { def: { name: "editor", tools: "read" }, runCount: 0, lastBackend: "native" });
 d.dispatchAgent = async () => ({ output: "Plan pending decision.\nrequires_user_decision: [Which file should be edited?]", exitCode: 0, elapsed: 1, dispatchId: "decision-plan" });
 const result = await createDispatchExecutor(d as any)("plan", { agent: "editor", practices: ["planning"], task: "Plan" }, undefined, undefined, { cwd } as any);
 assert.deepEqual((result.details as any).structuredReturn.requires_user_decision, ["Which file should be edited?"]);
 assert.equal(process.plan.evidenceRef, null);
 assert.equal(processPreEffectGate(process, "write")?.reason, undefined);
});

test("T4 fenced empty planner decision closes only with a readback plan and no real question", async t => {
 for (const scenario of ["empty", "question", "ask", "missing"] as const) {
  const { cwd, sessionDir, d } = await gitDiagnosticsFixture(t);
  let process = applyTaskTriageAdditions(createProcessState(), { status: "applied", reasons: ["wide_change"] }, { taskId: "t", evaluationId: "e", inputRevision: "r" });
  d.state.getProcessState = () => process; d.state.setProcessState = (value: any) => { process = value; };
  d._agents.set("editor", { def: { name: "editor", tools: "read,write" }, runCount: 0, lastBackend: "native" });
  d.extractAskUserQuestions = extractAskUserQuestions;
  const planPath = join(sessionDir, "artifacts", "plans", "synthetic-readme-fix.md");
  d.dispatchAgent = async () => {
   if (scenario !== "missing") {
    mkdirSync(join(sessionDir, "artifacts", "plans"), { recursive: true });
    writeFileSync(planPath, "Correct only the synthetic typo; builder verifies.\n");
   }
   return { output: `Artifact: artifacts/plans/synthetic-readme-fix.md\n\nStructured return:\n\`\`\`text\nchanged_files: [artifacts/plans/synthetic-readme-fix.md — typo-only plan]\nassertions_proven: []\nassertions_unproven: [A1 — builder verifies]\nassertions_failed: []\ntests_run: []\nopen_risks: []\nrequires_user_decision: ${scenario === "question" ? "[Which file should be edited?]" : "[]"}\n\`\`\`${scenario === "ask" ? "\nASK_USER: Which file should be edited?" : ""}`, exitCode: 0, elapsed: 1, dispatchId: `fenced-${scenario}` };
  };
  const result = await createDispatchExecutor(d as any)(scenario, { agent: "editor", practices: ["planning"], task: "Produce a plan", deliverables: [planPath] }, undefined, undefined, { cwd } as any);
  const details = result.details as any;
  assert.equal(details.deliverableReadback[0].status, scenario === "missing" ? "missing" : "read", scenario);
  assert.deepEqual(details.structuredReturn.requires_user_decision, scenario === "question" ? ["Which file should be edited?"] : [], scenario);
  assert.equal(process.plan.evidenceRef, scenario === "empty" ? details.returnPath : null, scenario);
  assert.equal(details.processVerdict.obligations.plan.status, "satisfied", scenario);
  assert.equal(processPreEffectGate(process, "write")?.reason, undefined, scenario);
 }
});

test("T4 planner with a real declared plan and literal none decision still closes plan", async t => {
 const { cwd, sessionDir, d } = await gitDiagnosticsFixture(t);
 let process = applyTaskTriageAdditions(createProcessState(), { status: "applied", reasons: ["wide_change"] }, { taskId: "t", evaluationId: "e", inputRevision: "r" });
 d.state.getProcessState = () => process; d.state.setProcessState = (value: any) => { process = value; };
 d._agents.set("editor", { def: { name: "editor", tools: "read,write" }, runCount: 0, lastBackend: "native" });
 const planPath = join(sessionDir, "artifacts", "plan", "synthetic-readme-fix.md");
 d.dispatchAgent = async () => {
  mkdirSync(join(sessionDir, "artifacts", "plan"), { recursive: true });
  writeFileSync(planPath, "Inspect README, correct the typo, run the declared check.\n");
  return { output: "Plan: correct only the README typo and check.\nrequires_user_decision: [none]", exitCode: 0, elapsed: 1, dispatchId: "valid-plan" };
 };
 const result = await createDispatchExecutor(d as any)("plan", { agent: "editor", practices: ["planning"], task: "Produce a plan", deliverables: [planPath] }, undefined, undefined, { cwd } as any);
 const details = result.details as any;
 assert.equal(details.deliverableReadback[0].status, "read");
 assert.equal(details.deliverableReadback[0].changed, true);
 assert.deepEqual(details.structuredReturn.requires_user_decision, ["none"]);
 assert.equal(process.plan.evidenceRef, details.returnPath);
 assert.equal(details.processVerdict.obligations.plan.status, "satisfied");
});

async function runtimeEvidenceReviewFixture(t: any, unrelated = false, protectEvidence = false) {
 const { cwd, sessionDir, d } = await gitDiagnosticsFixture(t);
 let process = applyProcessClassification(createProcessState(), { risk: "low", scope: "wide", reason: "review task change" }).state;
 process = noteProcessStage(process, "plan", { evidenceRef: "test:plan", revision: worktreeRevision(cwd, []) });
 d.state.getProcessState = () => process; d.state.setProcessState = (value: any) => { process = value; };
 d._agents.set("reviewer", { def: { name: "reviewer", tools: "read" }, runCount: 0, lastBackend: "native" });
 d.budget.currentBudget = () => ({ maxDispatches: 8, maxResearch: 2 });
 const command = "node --test README.test.js";
 if (protectEvidence) {
  mkdirSync(join(sessionDir, "artifacts", "watchdog"), { recursive: true });
  writeFileSync(join(sessionDir, "artifacts", "watchdog", "events.jsonl"), "");
 }
 d.state.getAssertions = () => [{ id: "A1", tag: "test", text: "README edit", source: "fixture", testCommand: command, status: "open" }];
 d.dispatchAgent = async () => {
  writeFileSync(join(cwd, "README.md"), "fixed fixture\n");
  mkdirSync(join(sessionDir, "artifacts", "watchdog"), { recursive: true });
  mkdirSync(join(sessionDir, "dispatches", "run"), { recursive: true });
  writeFileSync(join(sessionDir, "artifacts", "watchdog", "events.jsonl"), "event\n");
  writeFileSync(join(sessionDir, "dispatches", "run", "result.json"), "{}\n");
  if (unrelated) writeFileSync(join(cwd, "src", "new-source.js"), "unrelated\n");
  const revision = worktreeRevision(cwd, []);
  return { output: "README fixed", exitCode: 0, elapsed: 1, dispatchId: "build-evidence", lifecycle: nativeCleanLifecycle, runtimeTests: [{ command, exitCode: 0, beforeRevision: revision, afterRevision: revision }] };
 };
 const execute = createDispatchExecutor(d as any);
 const build = await execute("build", { agent: "editor", task: "A1 README change", scope: ["README.md", ...(protectEvidence ? [".pi/agent-sessions/sessions/test/artifacts/watchdog/events.jsonl"] : [])] }, undefined, undefined, { cwd } as any);
 assert.equal((build.details as any).verificationResult.status, "passed");
 assert.equal(process.acceptance.evidenceRef != null, true);
 return { cwd, sessionDir, d, execute, process: () => process };
}

test("T11 approved README review closes over generated current-session runtime evidence", async t => {
 const { cwd, d, execute, process } = await runtimeEvidenceReviewFixture(t);
 assert.deepEqual(process().changedFiles, ["README.md"]);
 d.dispatchAgent = async () => ({ output: "VERDICT: APPROVE\ntests_run: full regression", exitCode: 0, elapsed: 1, dispatchId: "review-evidence" });
 const result = await execute("review", { agent: "reviewer", task: "review README", scope: ["README.md"] }, undefined, undefined, { cwd } as any);
 assert.equal((result.details as any).processVerdict.obligations.review.status, "satisfied");
 assert.equal((result.details as any).processVerdict.accepted, true);
 assert.deepEqual((result.details as any).processVerdict.auditScope, ["README.md"]);
});

test("T11 explicitly scoped edits to runtime-path evidence still require review coverage", async t => {
 const { cwd, d, execute, process } = await runtimeEvidenceReviewFixture(t, false, true);
 assert.deepEqual(process().changedFiles, [".pi/agent-sessions/sessions/test/artifacts/watchdog/events.jsonl", "README.md"]);
 d.dispatchAgent = async () => ({ output: "VERDICT: APPROVE", exitCode: 0, elapsed: 1, dispatchId: "review-task-evidence" });
 const result = await execute("review", { agent: "reviewer", task: "review README only", scope: ["README.md"] }, undefined, undefined, { cwd } as any);
 assert.equal((result.details as any).processVerdict.obligations.review.status, "open");
 assert.equal(process().review.evidenceRef, null);
});

test("T11 runtime evidence exclusion does not hide unrelated user source or bypass verdict/scope/staleness", async t => {
 // Separate task fixtures prevent an earlier review's guard/budget state from deciding a later case.
 const partialFixture = await runtimeEvidenceReviewFixture(t, true);
 assert.deepEqual(partialFixture.process().changedFiles, ["README.md", "src/new-source.js"]);
 partialFixture.d.dispatchAgent = async () => ({ output: "VERDICT: APPROVE", exitCode: 0, elapsed: 1, dispatchId: "review-partial" });
 const partial = await partialFixture.execute("partial", { agent: "reviewer", task: "partial", scope: ["README.md"] }, undefined, undefined, { cwd: partialFixture.cwd } as any);
 assert.equal((partial.details as any).executionStatus, "completed", "partial review must reach the reviewer");
 assert.deepEqual((partial.details as any).processVerdict.auditScope, ["README.md", "src/new-source.js"]);
 assert.equal((partial.details as any).processVerdict.obligations.review.status, "open");
 assert.equal((partial.details as any).processVerdict.accepted, false);
 assert.equal(partialFixture.process().review.evidenceRef, null);

 const rejectFixture = await runtimeEvidenceReviewFixture(t, true);
 assert.deepEqual(rejectFixture.process().changedFiles, ["README.md", "src/new-source.js"]);
 rejectFixture.d.dispatchAgent = async () => ({ output: "VERDICT: REJECT", exitCode: 0, elapsed: 1, dispatchId: "review-reject" });
 const rejected = await rejectFixture.execute("reject", { agent: "reviewer", task: "reject", scope: ["README.md", "src/new-source.js"] }, undefined, undefined, { cwd: rejectFixture.cwd } as any);
 assert.equal((rejected.details as any).executionStatus, "completed", "REJECT must reach the reviewer");
 assert.deepEqual((rejected.details as any).processVerdict.auditScope, ["README.md", "src/new-source.js"]);
 assert.equal((rejected.details as any).processVerdict.obligations.review.status, "open");
 assert.equal((rejected.details as any).processVerdict.accepted, false);
 assert.equal(rejectFixture.process().review.evidenceRef, null);

 const staleFixture = await runtimeEvidenceReviewFixture(t, true);
 assert.deepEqual(staleFixture.process().changedFiles, ["README.md", "src/new-source.js"]);
 const verifiedRevision = staleFixture.process().acceptance.revision;
 writeFileSync(join(staleFixture.cwd, "README.md"), "changed after verified revision\n");
 staleFixture.d.dispatchAgent = async () => ({ output: "VERDICT: APPROVE\ntests_run: full regression", exitCode: 0, elapsed: 1, dispatchId: "review-stale" });
 const stale = await staleFixture.execute("stale", { agent: "reviewer", task: "stale", scope: ["README.md", "src/new-source.js"] }, undefined, undefined, { cwd: staleFixture.cwd } as any);
 assert.equal((stale.details as any).executionStatus, "completed", "stale review must reach the reviewer");
 assert.deepEqual((stale.details as any).processVerdict.auditScope, ["README.md", "src/new-source.js"]);
 assert.notEqual(worktreeRevision(staleFixture.cwd, []), verifiedRevision);
 assert.equal(staleFixture.process().acceptance.revision, verifiedRevision);
 assert.equal((stale.details as any).processVerdict.obligations.review.status, "satisfied");
 assert.equal(staleFixture.process().review.revision, worktreeRevision(staleFixture.cwd, []));
 assert.equal((stale.details as any).processVerdict.obligations.acceptance.status, "open");
 assert.equal((stale.details as any).processVerdict.accepted, false);
});

test("T11 reviewer REJECT cannot satisfy the open review obligation", async t => {
 const { cwd, d, process } = await highRiskChangedFixture(t);
 d.dispatchAgent = async () => ({ output: "verdict: REJECT\nfindings remain", exitCode: 0, elapsed: 1, dispatchId: "rev-reject" });
 await createDispatchExecutor(d as any)("rev", { agent: "reviewer", task: "review", scope: ["src/api.ts"] }, undefined, undefined, { cwd } as any);
 assert.equal(process().review.evidenceRef, null);
 assert.equal(process().review.required, true);
});

test("T11 reviewer APPROVE with partial changed-file overlap cannot satisfy review", async t => {
 const { cwd, d, process } = await highRiskChangedFixture(t);
 d.dispatchAgent = async () => ({ output: "verdict: APPROVE", exitCode: 0, elapsed: 1, dispatchId: "rev-partial" });
 await createDispatchExecutor(d as any)("rev", { agent: "reviewer", task: "review", scope: ["README.md"] }, undefined, undefined, { cwd } as any);
 assert.equal(process().review.evidenceRef, null);
});

test("an area review beside a running parallel writer never closes the task review; the final one does", async t => {
 const { cwd, d, process } = await highRiskChangedFixture(t);
 const writers: any[] = [{ agent: "editor", scope: ["src/other"], isolated: true }];
 (d.state as any).getActiveWriters = () => writers;
 (d.state as any).beginWriter = (entry: any) => { writers.push(entry); return () => { writers.splice(writers.indexOf(entry), 1); }; };
 d.dispatchAgent = async () => ({ output: "verdict: APPROVE", exitCode: 0, elapsed: 1, dispatchId: "rev-area" });
 const area = await createDispatchExecutor(d as any)("rev-a", { agent: "reviewer", task: "review the api area", scope: ["src/api.ts"], parallel: true }, undefined, undefined, { cwd } as any) as any;
 assert.ok(!process().review.evidenceRef, "an area review is not the task's review");
 assert.match(area.content[0].text, /Area review: editor was still writing/);
 assert.deepEqual(writers.map(w => w.agent), ["editor"], "the reviewer's own registration was released");

 writers.length = 0;
 d.dispatchAgent = async () => ({ output: "verdict: APPROVE", exitCode: 0, elapsed: 1, dispatchId: "rev-final" });
 const final = await createDispatchExecutor(d as any)("rev-f", { agent: "reviewer", task: "final review of the whole change", scope: ["src/api.ts"] }, undefined, undefined, { cwd } as any) as any;
 assert.ok(process().review.evidenceRef, "the final review with no writer active closes it");
 assert.doesNotMatch(final.content[0].text, /Area review/);
});

test("declared audit and research can start beside an unisolated builder without reserving writer slots", async t => {
 const { cwd, d } = await highRiskChangedFixture(t);
 const reviewer = d._agents.get("reviewer")!;
 Object.assign(reviewer.def, { tools: "read,bash,grep", readOnly: true });
 const securityAuditor = { ...reviewer, def: { name: "reviewer--p2", tools: "read,bash,find", readOnly: true } };
 d._agents.set("reviewer--p2", securityAuditor);
 const writers: WriterEntry[] = [];
 Object.assign(d.state, {
  getActiveWriters: () => writers,
  beginWriter(entry: WriterEntry) {
   assert.equal(entry.agent, "editor", "inspection must not register a writer");
   writers.push(entry);
   return () => { writers.splice(writers.indexOf(entry), 1); };
  },
 });
 const builderStarted = Promise.withResolvers<void>();
 const releaseBuilder = Promise.withResolvers<void>();
 const launched: string[] = [];
 d.dispatchAgent = async (agent: string) => {
  if (agent === "editor") {
   builderStarted.resolve();
   await releaseBuilder.promise;
  } else {
   assert.deepEqual(writers, [{ agent: "editor", scope: [], isolated: false }]);
   assert.equal(d.state.getActiveWritableDispatches(), 1);
  }
  launched.push(agent);
  return { output: "verdict: APPROVE", exitCode: 0, elapsed: 1, dispatchId: agent };
 };
 Object.assign(d.research, {
  anonymousDef: () => ({ name: "researcher" }),
  resolveModel: () => "test/model",
  createState: () => ({ id: 7 }),
  async spawn() {
   assert.equal(d.state.getActiveWritableDispatches(), 1);
   launched.push("research");
   return { output: "notes", exitCode: 0, elapsed: 1 };
  },
 });
 const dispatch = createDispatchExecutor(d as any);
 const research = createResearchExecutor(d as any);
 const ctx = { cwd } as any;
 const build = dispatch("active-builder", { agent: "editor", task: "continue the build" }, undefined, undefined, ctx);
 try {
  assert.equal(await Promise.race([builderStarted.promise.then(() => "started"), build.then(() => "settled")]), "started");
  const results = await Promise.all([
   dispatch("code", { agent: "reviewer", task: "inspect the implementation" }, undefined, undefined, ctx),
   dispatch("security", { agent: "reviewer--p2", practices: ["independent-review", "security"], task: "inspect input validation" }, undefined, undefined, ctx),
   research("research", { task: "trace callers" }, undefined, undefined, ctx),
  ]);
  assert.deepEqual(launched.sort(), ["research", "reviewer", "reviewer--p2"]);
  for (const result of results) assert.equal((result.details as any).exitCode, 0);
  const refused = await dispatch("verify", { agent: "reviewer", task: "run the test suite", review_mode: "run-checks" }, undefined, undefined, ctx);
  assert.equal((refused.details as any).status, "writer_active");
 } finally {
  releaseBuilder.resolve();
  await build;
 }
});

test("T11 reviewer APPROVE covering current changed files records review at current revision", async t => {
 const { cwd, d, process } = await highRiskChangedFixture(t);
 d.dispatchAgent = async () => ({ output: "verdict: APPROVE", exitCode: 0, elapsed: 1, dispatchId: "rev-ok" });
 await createDispatchExecutor(d as any)("rev", { agent: "reviewer", task: "review", scope: ["src/api.ts"] }, undefined, undefined, { cwd } as any);
 assert.ok(process().review.evidenceRef);
 assert.equal(process().review.revision, process().acceptance.revision);
});

test("a policy-selected coms reviewer owns a writer slot and can approve a stable revision after builders finish", async t => {
 const { cwd, d, process } = await highRiskChangedFixture(t);
 const writers: WriterEntry[] = [];
 let generation = 0;
 Object.assign(d.state, {
  mayRouteToComs: () => true,
  getActiveWriters: () => writers,
  getWriterGeneration: () => generation,
  beginWriter(entry: WriterEntry) { generation++; writers.push(entry); return () => { writers.splice(writers.indexOf(entry), 1); }; },
 });
 d._agents.get("reviewer")!.lastBackend = "coms";
 d.dispatchAgent = async () => {
  assert.deepEqual(writers.map(w => [w.agent, w.isolated]), [["reviewer", false]]);
  assert.equal(d.state.getActiveWritableDispatches(), 1);
  return { output: "verdict: APPROVE", exitCode: 0, elapsed: 1, dispatchId: "peer-review" };
 };
 const result = await createDispatchExecutor(d as any)("peer-review", { agent: "reviewer", task: "review", scope: ["src/api.ts"] }, undefined, undefined, { cwd } as any);
 assert.ok(process().review.evidenceRef, JSON.stringify(result.details));
 assert.equal(process().review.revision, process().acceptance.revision);
 assert.equal(writers.length, 0);
});

test("an inspection cannot close review after a writer starts and exits during the inspection", async t => {
 const { cwd, d, process } = await highRiskChangedFixture(t);
 let writerGeneration = 1;
 Object.assign(d.state, { getWriterGeneration: () => writerGeneration });
 d.dispatchAgent = async () => {
  writerGeneration++;
  return { output: "verdict: APPROVE", exitCode: 0, elapsed: 1, dispatchId: "interleaved-review" };
 };
 const result = await createDispatchExecutor(d as any)("review", {
  agent: "reviewer", task: "review current changes", scope: ["src/api.ts"],
 }, undefined, undefined, { cwd } as any);
 assert.equal(process().review.evidenceRef, null);
 assert.match((result.content[0] as any).text, /Area review: a writer overlapped this inspection/);
 assert.ok((result.details as any).returnPath);
});

for (const builderAlreadyRunning of [true, false]) test(`review retains preliminary evidence when a builder changes code ${builderAlreadyRunning ? "after starting first" : "and exits during review"}`, async t => {
 const { cwd, d, process } = await highRiskChangedFixture(t);
 d.budget.currentBudget = () => ({ maxDispatches: null, maxResearch: null }) as any;
 const fingerprints = new Set<string>();
 d.state.getTurnDispatchFingerprints = () => fingerprints;
 let writerGeneration = 0;
 const writers: WriterEntry[] = [];
 Object.assign(d.state, {
  getWriterGeneration: () => writerGeneration,
  getActiveWriters: () => writers,
  beginWriter(entry: WriterEntry) {
   writerGeneration++;
   writers.push(entry);
   return () => { writers.splice(writers.indexOf(entry), 1); };
  },
 });
 const builderStarted = Promise.withResolvers<void>();
 const reviewStarted = Promise.withResolvers<void>();
 const edit = Promise.withResolvers<void>();
 const edited = Promise.withResolvers<void>();
 const finishBuilder = Promise.withResolvers<void>();
 const finishReview = Promise.withResolvers<void>();
 let reviewerRuns = 0;
 d.dispatchAgent = async agent => {
  if (agent === "editor") {
   builderStarted.resolve();
   await edit.promise;
   writeFileSync(join(cwd, "src", "api.ts"), "export const value = 10;\n");
   edited.resolve();
   await finishBuilder.promise;
   return { output: "done", exitCode: 0, elapsed: 1, dispatchId: "overlap-builder" };
  }
  const run = ++reviewerRuns;
  if (run === 1) {
   reviewStarted.resolve();
   await finishReview.promise;
  }
  return { output: "verdict: APPROVE\nReviewed the API change.", exitCode: 0, elapsed: 1, dispatchId: `review-${run}` };
 };
 const execute = createDispatchExecutor(d as any);
 const ctx = { cwd } as any;
 const startBuilder = () => execute("builder", { agent: "editor", task: "Adjust the API" }, undefined, undefined, ctx);
 const scope = ["src/api.ts"];
 const before = worktreeRevision(cwd, []);
 let build: ReturnType<typeof startBuilder> | undefined;
 if (builderAlreadyRunning) {
  build = startBuilder();
  assert.equal(await Promise.race([builderStarted.promise.then(() => true), build.then(() => false)]), true);
 }
 const review = execute("inspection", { agent: "reviewer", task: "Inspect the API", scope }, undefined, undefined, ctx);
 try {
  assert.equal(await Promise.race([reviewStarted.promise.then(() => true), review.then(() => false)]), true);
  build ??= startBuilder();
  edit.resolve();
  assert.equal(await Promise.race([edited.promise.then(() => true), build.then(() => false)]), true);
  if (!builderAlreadyRunning) {
   finishBuilder.resolve();
   await build;
   assert.equal(writers.length, 0);
  }
  finishReview.resolve();
  const result: any = await review;
  assert.equal(result.details.orchestration.closure.status, "unproven");
  assert.equal(result.details.orchestration.manifest.stale, true);
  assert.equal(process().review.evidenceRef, null);
  assert.deepEqual(result.details.reviewEvidence, {
   status: "preliminary", scope, beforeRevision: before, afterRevision: worktreeRevision(cwd, []),
   revisionScopes: [], evidenceRef: result.details.returnPath, reasons: ["writer_overlap", "revision_changed", "review_input_changed"],
  });
  const assessment = JSON.parse(readFileSync(result.details.assessmentPath, "utf8"));
  assert.deepEqual(assessment.reviewEvidence, result.details.reviewEvidence);
  assert.match(readFileSync(result.details.returnPath, "utf8"), /Reviewed the API change/);
 } finally {
  edit.resolve();
  finishReview.resolve();
  finishBuilder.resolve();
  await Promise.all([review, build]);
 }
 const final: any = await execute("final", { agent: "reviewer", task: "Inspect the API", scope }, undefined, undefined, ctx);
 assert.equal(final.details.reviewEvidence.status, "final");
 assert.equal(final.details.orchestration.closure.status, "closed");
 assert.equal(process().review.revision, worktreeRevision(cwd, []));
 assert.equal(process().review.evidenceRef, final.details.returnPath);
});

test("a source change outside the declared review scope prevents final approval", async t => {
 const { cwd, d, process } = await highRiskChangedFixture(t);
 d.dispatchAgent = async () => {
  writeFileSync(join(cwd, "README.md"), "changed during the review\n");
  return { output: "verdict: APPROVE", exitCode: 0, elapsed: 1, dispatchId: "changed-during-review" };
 };
 const result: any = await createDispatchExecutor(d as any)("review", {
  agent: "reviewer", task: "Review changed code", scope: ["src/api.ts"],
 }, undefined, undefined, { cwd } as any);
 assert.equal(process().review.evidenceRef, null);
 assert.deepEqual(result.details.reviewEvidence.reasons, ["revision_changed"]);
 assert.notEqual(result.details.reviewEvidence.beforeRevision, result.details.reviewEvidence.afterRevision);
});

test("a writable review rechecks the repository after asynchronous return extraction", async t => {
 const { cwd, d, process } = await highRiskChangedFixture(t);
 const reviewer = d._agents.get("reviewer")!;
 Object.assign(reviewer.def, { tools: "read,bash", readOnly: true });
 d.state.getAssertions = () => [{ id: "A1", tag: "test", text: "Check the API", source: "user", status: "open" }] as any;
 d.dispatchAgent = async () => ({ output: "verdict: APPROVE", exitCode: 0, elapsed: 1, dispatchId: "review-before-extraction", lifecycle: nativeCleanLifecycle });
 let extracted = false;
 d.runReturnExtraction = async () => {
  await Promise.resolve();
  writeFileSync(join(cwd, "README.md"), "changed while the report was being processed\n");
  extracted = true;
  return null;
 };
 const result: any = await createDispatchExecutor(d as any)("review", {
  agent: "reviewer", task: "Recheck A1", scope: ["src/api.ts"], review_mode: "run-checks",
 }, undefined, undefined, { cwd } as any);
 assert.equal(extracted, true);
 assert.deepEqual(result.details.reviewEvidence.reasons, ["revision_changed"]);
 assert.equal(process().review.evidenceRef, null);
});

test("final review distinguishes declared CLI/server scope from actual checked paths", async t => {
 const { cwd, d, process } = await highRiskChangedFixture(t);
 d.budget.currentBudget = () => ({ maxDispatches: null, maxResearch: null }) as any;
 const execute = createDispatchExecutor(d as any);
 const ctx = { cwd } as any;
 d.dispatchAgent = async () => {
  writeFileSync(join(cwd, "src", "cli.ts"), "export const cli = 1;\n");
  writeFileSync(join(cwd, "src", "server-private.ts"), "export const server = 1;\n");
  return { output: "done", exitCode: 0, elapsed: 1, dispatchId: "caller-build" };
 };
 await execute("builder", { agent: "editor", task: "Update the caller" }, undefined, undefined, ctx);
 assert.deepEqual(process().changedFiles, ["src/api.ts", "src/cli.ts", "src/server-private.ts"]);
 let reviewRun = 0;
 const approve = async () => ({ output: "I checked every file.\nVerdict: APPROVE", exitCode: 0, elapsed: 1, dispatchId: `review-scope-${++reviewRun}` });
 d.dispatchAgent = approve;
 const scope = ["src/api.ts", "src/cli.ts"];
 const partial: any = await execute("partial", { agent: "reviewer", task: "Inspect the CLI", scope }, undefined, undefined, ctx);
 assert.deepEqual(partial.details.reviewEvidence.reasons, ["incomplete_scope"]);
 const diagnostic = partial.details.reviewEvidence.scopeDiagnostic;
 assert.equal(diagnostic.kind, "declared_scope_gap");
 assert.equal(diagnostic.checkedPaths, "unknown");
 assert.equal(diagnostic.omittedCount, 1);
 assert.match(partial.content[0].text, /Actual checked paths are unknown.*Add the omitted task files/s);
 assert.doesNotMatch(JSON.stringify(diagnostic), /src\/api\.ts|src\/cli\.ts|server-private/);
 assert.doesNotMatch(partial.content[0].text, /server-private/);
 assert.deepEqual(JSON.parse(readFileSync(partial.details.assessmentPath, "utf8")).reviewEvidence.scopeDiagnostic, diagnostic);
 assert.equal(partial.details.accepted, false);
 assert.equal(process().review.evidenceRef, null);
 d.dispatchAgent = async () => {
  writeFileSync(join(cwd, "src", "server-private.ts"), "export const server = 2;\n");
  return approve();
 };
 const stale: any = await execute("stale", { agent: "reviewer", task: "Recheck CLI scope", scope }, undefined, undefined, ctx);
 assert.deepEqual(stale.details.reviewEvidence.reasons, ["revision_changed", "incomplete_scope"]);
 assert.equal(stale.details.reviewEvidence.scopeDiagnostic.kind, "unknown");
 assert.equal(stale.details.reviewEvidence.scopeDiagnostic.omittedCount, undefined);
 assert.match(stale.content[0].text, /Actual checked paths are unknown.*Re-establish the changed-file list/s);
 assert.equal(process().review.evidenceRef, null);
 d.dispatchAgent = approve;
 const full: any = await execute("full", { agent: "reviewer", task: "Review API, CLI and server", scope: process().changedFiles }, undefined, undefined, ctx);
 assert.equal(full.details.reviewEvidence?.status, "final", full.content[0].text);
 assert.equal(process().review.revision, worktreeRevision(cwd, []));
});

test("process-required reviewer is not refused by docs-lane hint", async t => {
 const { cwd, d } = await highRiskChangedFixture(t);
 const blocked = await createDispatchExecutor(d as any)("docs", { agent: "reviewer", task: "review docs", scope: ["README.md"] }, undefined, undefined, { cwd } as any);
 assert.notEqual((blocked.details as any).status, "docs_only_lane");
 const allowed = await createDispatchExecutor(d as any)("docs-ok", { agent: "reviewer", task: "review docs", scope: ["README.md"], review_reason: "docs-only closeout" }, undefined, undefined, { cwd } as any);
 assert.notEqual((allowed.details as any).status, (blocked.details as any).status);
});

test("T11 unknown risk still allows research and still refuses changed-task acceptance", async t => {
 const { cwd, d } = await gitDiagnosticsFixture(t);
 let process = createProcessState();
 d.state.getProcessState = () => process; d.state.setProcessState = (value: any) => { process = value; };
 (d.research as any).anonymousDef = () => ({ name: "researcher" });
 (d.research as any).resolveModel = () => "test/model";
 (d.research as any).createState = () => ({ id: 7 });
 let spawned = 0;
 (d.research as any).spawn = async () => { spawned++; return { output: "notes", exitCode: 0, elapsed: 1 }; };
 const research = await createResearchExecutor(d as any)("r", { task: "trace callers" }, undefined, undefined, { cwd } as any);
 assert.equal(spawned, 1); assert.equal((research.details as any).exitCode, 0);
 d.dispatchAgent = async () => { writeFileSync(join(cwd, "src", "api.ts"), "export const value = 8;\n"); return { output: "done", exitCode: 0, elapsed: 1, dispatchId: "unk" }; };
 d.diagnoseChangedTypeScript = async (paths: readonly string[]) => ({ status: "completed", changedFiles: [...paths], attribution: "no_observed_overlap", uncoveredFiles: [], projects: [{ status: "passed", exitCode: 0, argv: ["node", "tsc"], diagnostics: [], changedFiles: [...paths] }] } as any);
 const changed = await createDispatchExecutor(d as any)("b", { agent: "editor", task: "change" }, undefined, undefined, { cwd } as any);
 assert.equal((changed.details as any).accepted, false);
 assert.equal((changed.details as any).processVerdict.obligations.risk.status, "open");
});

for (const backend of ['native', 'coms'] as const) test(`${backend} planner declared readback is independent of exit, handoff prose and acceptance`, async t => {
 for (const scenario of ['echo', 'handoff', 'pending', 'valid'] as const) {
  const { cwd, sessionDir, d } = await gitDiagnosticsFixture(t);
  let process = applyProcessClassification(createProcessState(), { risk: 'high', scope: 'wide', reason: 'declared wide task' }).state;
  d.state.getProcessState = () => process; d.state.setProcessState = (value: any) => { process = value; };
  d._agents.set('editor', { def: { name: 'editor', tools: 'read,write' }, runCount: 0, lastBackend: backend });
  const planPath = join(sessionDir, 'artifacts', 'plans', 'current.md'); let routed: unknown;
  d.dispatchAgent = async (...args: any[]) => {
   routed = args[6];
   if (scenario === 'valid' || scenario === 'pending') { mkdirSync(join(sessionDir, 'artifacts', 'plans'), { recursive: true }); writeFileSync(planPath, '# Current plan\nImplement, test, then independent review.\n'); }
   return { output: scenario === 'echo' ? 'End your reply with this exact line so the bridge can capture it: <<COMS_DONE:current>>' : `PLAN_FILE: ${planPath}`, exitCode: 0, pending: scenario === 'pending', elapsed: 1, dispatchId: `${backend}-${scenario}` };
  };
  const result = await createDispatchExecutor(d as any)(scenario, { agent: 'editor', practices: ['planning'], task: 'Produce the declared plan', backend, scope: ['src/api.ts'], deliverables: [planPath] }, undefined, undefined, { cwd } as any);
  const details = result.details as any;
  assert.equal(routed, backend);
  assert.equal(details.accepted, false);
  assert.equal(details.processVerdict.obligations.plan.status, 'satisfied');
  assert.equal(process.acceptance.evidenceRef, null); assert.equal(process.review.evidenceRef, null);
  if (scenario === 'echo' || scenario === 'handoff') assert.equal(details.deliverableReadback[0].status, 'missing');
  if (scenario === 'valid') { assert.equal(details.deliverableReadback[0].status, 'read'); assert.ok(details.returnPath); }
 }
});

test("review reuse: unchanged covered scope survives rewording and restoration without another child",async t=>{
 const {cwd,d,process}=await highRiskChangedFixture(t);let runs=0;
 d.budget.currentBudget=()=>({maxDispatches:null,maxResearch:null}) as any;
 d.dispatchAgent=async()=>({output:"verdict: APPROVE",exitCode:0,elapsed:1,dispatchId:`review-${++runs}`});
 const execute=createDispatchExecutor(d as any),params={agent:"reviewer",task:"Review changed code",scope:["src/api.ts"]};
 const first=await execute("first",params,undefined,undefined,{cwd} as any);assert.ok(process().review.evidenceRef);
 const charged=d._task();
 d.state.setProcessState(latestProcessState([{customType:"agent-hub-process-state",data:processAuditRecord(process(),evaluateProcessObligations(process(),{writable:true,budgetTier:"small"}))}]));
 const second=await execute("second",{...params,task:"Independently check the completed change again"},undefined,undefined,{cwd} as any);
 assert.equal((second.details as any).status,"review_reused");assert.equal(runs,1);assert.equal(d._task(),charged);
 assert.equal((second.details as any).returnPath,(first.details as any).returnPath);
 assert.equal((second.details as any).started,false);
});

for(const change of ["source","outside-scope-source","requirements","accepted-input","evidence","new-task","explicit-reason","new-scope"] as const) test(`review reuse: ${change} requires fresh review`,async t=>{
 const {cwd,d,process}=await highRiskChangedFixture(t);let runs=0;
 d.budget.currentBudget=()=>({maxDispatches:null,maxResearch:null}) as any;
 d.dispatchAgent=async()=>({output:"verdict: APPROVE",exitCode:0,elapsed:1,dispatchId:`review-${++runs}`});
 const execute=createDispatchExecutor(d as any),params:any={agent:"reviewer",task:"Review code",scope:["src/api.ts"]};
 await execute("first",params,undefined,undefined,{cwd} as any);
 if(change==="source")writeFileSync(join(cwd,"src/api.ts"),"export const value = 10;\n");
 if(change==="outside-scope-source") {
  const approvedRevision=process().review.revision;
  writeFileSync(join(cwd,"README.md"),"changed after review\n");
  const currentRevision=revisionOf(cwd);
  assert.notEqual(currentRevision,approvedRevision);
  assert.equal(evaluateProcessObligations(process(),{writable:true,budgetTier:"small",currentRevision}).obligations.review.status,"open");
 }
 if(change==="requirements")d.state.getAssertions=()=>[{id:"NEW",tag:"test",text:"New security requirement",source:"user",status:"open"}] as any;
 if(change==="accepted-input")(d.state as any).getAcceptedUserInput=()=>"Also inspect the newly requested concurrency behavior";
 if(change==="evidence")writeFileSync(process().review.evidenceRef!,"changed review artifact");
 if(change==="new-task")d.noProgress.reset();
 if(change==="explicit-reason")params.review_reason="Inspect a new concurrency concern";
 if(change==="new-scope")params.scope=["src/api.ts","README.md"];
 const second=await execute("second",{...params,task:"Fresh independent review"},undefined,undefined,{cwd} as any);
 assert.notEqual((second.details as any).status,"review_reused",change);assert.equal(runs,2,change);
});

test("review reuse: security audit is reused only as security coverage, and a fresh rejection invalidates it",async t=>{
 const {cwd,d,process}=await highRiskChangedFixture(t);let runs=0,reject=false;
 d.budget.currentBudget=()=>({maxDispatches:null,maxResearch:null}) as any;
 d._agents.set("reviewer--p2",{def:{name:"reviewer--p2",tools:"read"},runCount:0,lastBackend:"native"});
 d.dispatchAgent=async()=>({output:`verdict: ${reject?"REJECT":"APPROVE"}`,exitCode:0,elapsed:1,dispatchId:`audit-${++runs}`});
 const execute=createDispatchExecutor(d as any),params={agent:"reviewer--p2",practices:["independent-review","security"],task:"Audit security",scope:["src/api.ts"]};
 await execute("audit",params,undefined,undefined,{cwd} as any);
 const cached=await execute("cached",{...params,task:"Check security once more"},undefined,undefined,{cwd} as any);
 assert.equal((cached.details as any).status,"review_reused");assert.equal(runs,1);
 await execute("code",{agent:"reviewer",task:"Review code",scope:params.scope},undefined,undefined,{cwd} as any);assert.equal(runs,2,"a security audit does not replace a different review role");
 reject=true;
 await execute("reject",{...params,task:"Fresh audit",review_reason:"New concern"},undefined,undefined,{cwd} as any);
 assert.equal(process().review.evidenceRef,null,"fresh rejection cannot leave old approval active");
 assert.equal(process().reviews?.some(r=>r.agent==="reviewer--p2"),false);
});

test("review reuse: a retained record whose contract lacks independent-review is never reused",async t=>{
 const {cwd,d,process}=await highRiskChangedFixture(t);let runs=0;
 d.budget.currentBudget=()=>({maxDispatches:null,maxResearch:null}) as any;
 d.dispatchAgent=async()=>({output:"verdict: APPROVE",exitCode:0,elapsed:1,dispatchId:`review-${++runs}`});
 const execute=createDispatchExecutor(d as any),params={agent:"reviewer",task:"Review changed code",scope:["src/api.ts"]};
 await execute("first",params,undefined,undefined,{cwd} as any);assert.ok(process().review.evidenceRef);
 // A state saved before the practice qualifier: the same evidence retained under a testing-only contract.
 const legacy=reviewInput(cwd,d.noProgress.taskId(),"reviewer",params.scope,process(),d.state.getAssertions(),[],(d.state as any).getAcceptedUserInput?.(),["testing"])!;
 d.state.setProcessState({...process(),reviews:process().reviews!.map(r=>({...r,contractHash:legacy.contractHash}))});
 const consulted=await execute("consult",{...params,practices:["testing"]},undefined,undefined,{cwd} as any);
 assert.notEqual((consulted.details as any).status,"review_reused","only independent-review evidence is reusable");assert.equal(runs,2);
});

test("review reuse: a reviewer consulted with another practice keeps the final review it cannot replace",async t=>{
 const {cwd,d,process}=await highRiskChangedFixture(t);let runs=0;
 d.budget.currentBudget=()=>({maxDispatches:null,maxResearch:null}) as any;
 d.dispatchAgent=async()=>({output:"verdict: APPROVE",exitCode:0,elapsed:1,dispatchId:`review-${++runs}`});
 const execute=createDispatchExecutor(d as any),params={agent:"reviewer",task:"Review changed code",scope:["src/api.ts"]};
 const first=await execute("first",params,undefined,undefined,{cwd} as any);const evidence=(first.details as any).returnPath;
 assert.equal(process().review.evidenceRef,evidence);
 const consulted=await execute("coverage",{...params,task:"Check the test coverage",practices:["testing"]},undefined,undefined,{cwd} as any);
 assert.equal(runs,2,"the consultation runs");
 assert.deepEqual((consulted.details as any).reviewEvidence.reasons,["review_practice_missing"]);
 assert.equal(process().review.evidenceRef,evidence,"advice never clears the independent review");
 assert.equal(process().reviews?.find(r=>r.agent==="reviewer")?.evidenceRef,evidence);
 const again=await execute("again",{...params,task:"Independently check the change again"},undefined,undefined,{cwd} as any);
 assert.equal((again.details as any).status,"review_reused","the kept review still covers the unchanged scope");assert.equal(runs,2);
});

for(const condition of ["question","blocking-finding","source-changed-during-review"] as const) test(`review reuse: ${condition} never records reusable approval`,async t=>{
 const {cwd,d,process}=await highRiskChangedFixture(t);
 if(condition==="question")d.extractAskUserQuestions=()=>["Which behavior is required?"];
 d.dispatchAgent=async()=>{if(condition==="source-changed-during-review")writeFileSync(join(cwd,"src/api.ts"),"export const value=42;\n");return {output:"verdict: APPROVE"+(condition==="blocking-finding"?"\n### Blocking findings\n- An unresolved correctness defect remains.":""),exitCode:0,elapsed:1,dispatchId:"review"};};
 await createDispatchExecutor(d as any)("review",{agent:"reviewer",task:"Review code",scope:["src/api.ts"]},undefined,undefined,{cwd} as any);
 assert.equal(process().review.evidenceRef,null);assert.equal(process().reviews?.length??0,0);
});

test("fresh review receives prior rejection and actual delta without inheriting approval",async t=>{
 const {cwd,d,process}=await highRiskChangedFixture(t);const prompts:string[]=[];
 d.budget.currentBudget=()=>({maxDispatches:null,maxResearch:null}) as any;
 d.dispatchAgent=async(_agent:string,task:string)=>{prompts.push(task);return {output:"verdict: REJECT\nBlocking finding: wrong constant",exitCode:0,elapsed:1,dispatchId:"history-"+prompts.length};};
 const execute=createDispatchExecutor(d as any),params={agent:"reviewer",task:"Review current code",scope:["src/api.ts"]};
 await execute("first",params,undefined,undefined,{cwd} as any);
 assert.equal(process().review.evidenceRef,null);
 writeFileSync(join(cwd,"src/api.ts"),"export const value=123;\n");
 await execute("second",{...params,task:"Review the fixed constant"},undefined,undefined,{cwd} as any);
 assert.match(prompts[1],/Incremental review context/);
 assert.match(prompts[1],/Previous findings\/report/);
 assert.match(prompts[1],/\+export const value=123/);
 assert.equal(process().review.evidenceRef,null);
});

test('explicit native current-state review closes scope-bound process without historical changes or manual proof',async t=>{
 const f=await operatorStateFixture(t);const r=await f.run('current',{agent:'reviewer',task:'A2 current state, not authorship',scope:['a.ts'],backend:'native',review_mode:'operator-current-state'},undefined,undefined,{cwd:f.cwd} as any);
 const details=r.details as any;assert.ok(details.processVerdict,JSON.stringify(r));assert.equal(details.processVerdict.obligations.review.status,'satisfied',JSON.stringify({operator:details.operatorStateVerification,verification:details.verificationResult,process:details.processVerdict}));assert.equal(details.processVerdict.obligations.acceptance.status,'satisfied');
 assert.equal(details.processVerdict.path,'operator-current-state');assert.deepEqual(details.processVerdict.auditScope,['a.ts']);
 assert.equal(details.resultProtocol,'submit_result');assert.equal(details.structuredReturn.status,'completed');
 assert.equal(details.operatorStateVerification.status,'accepted');assert.equal(details.operatorStateVerification.historicalAttribution,'not_claimed');
 assert.equal(details.taskAccepted,false);assert.equal(details.changeResult.status,'unchanged');assert.equal(f.d.state.getAssertions()[1].status,'open');
 assert.equal(details.operatorStateVerification.reason,undefined);assert.equal(details.operatorStateVerification.failedQualifiers,undefined);
 assert.doesNotMatch(r.content[0].text as string,/did not register the candidate/);
});
test('current-state review fails closed on missing/failed/stale checks, reject, source mutation and overlap',async t=>{
 for(const scenario of ['no-checks','failed','stale','reject','modified','overlap','partial','blocked','missing-submission','assertion-failed','question','tainted','no-integrity']){
  const f=await operatorStateFixture(t,scenario);const r=await f.run(scenario,{agent:'reviewer',task:'A2 inspect '+scenario,scope:['a.ts'],backend:'native',review_mode:'operator-current-state'},undefined,undefined,{cwd:f.cwd} as any);
  assert.equal((r.details as any).operatorStateVerification.status,'unproven',scenario);assert.equal(f.state().review.evidenceRef,null,scenario);assert.equal(f.state().acceptance.evidenceRef,null,scenario);
  // The refusal names its qualifier instead of only "no task change is registered".
  const expected:Record<string,string[]>={'no-checks':['automated_not_passed:A2,AF-MIN-CHANGE'],failed:['automated_not_passed:A2,AF-MIN-CHANGE'],stale:['automated_not_passed:A2,AF-MIN-CHANGE'],
   reject:['verdict_not_affirmative','regression_not_closed'],modified:['review_input_changed','revision_changed'],overlap:['non_exclusive_capture'],
   partial:['submission_incomplete'],blocked:['submission_incomplete'],'missing-submission':['submission_incomplete'],'assertion-failed':['assertions_failed'],
   question:['requires_user_decision'],tainted:['non_exclusive_capture'],'no-integrity':['non_exclusive_capture']};
  const proof=(r.details as any).operatorStateVerification;
  assert.deepEqual(proof.failedQualifiers,expected[scenario],scenario);assert.equal(proof.reason,expected[scenario][0],scenario);assert.ok(proof.nextStep,scenario);
  assert.match(r.content[0].text as string,new RegExp(`Current-state review did not register the candidate: ${expected[scenario][0]}`),scenario);
  assert.match(r.content[0].text as string,/Manual assertions stay open; nothing was marked proven/,scenario);
  assert.equal(f.d.state.getAssertions()[1].status,'open',`${scenario}: the manual assertion is never proven`);
 }
});
test('current-state mode is explicit, native-only, exact observed files and never a normal builder bypass',async t=>{
 for(const patch of [{backend:'coms'},{backend:'auto'},{review_mode:'invented'},{scope:['*.ts']},{scope:['a.ts','a.ts']},{scope:['clean.ts']},{scope_mode:'create'}]){
  const f=await operatorStateFixture(t);const r=await f.run('invalid',{agent:'reviewer',task:'A2 invalid current state',scope:['a.ts'],backend:'native',review_mode:'operator-current-state',...patch} as any,undefined,undefined,{cwd:f.cwd} as any);
  assert.equal((r.details as any).started,false);assert.equal(f.d._task(),0);
 }
 const f=await operatorStateFixture(t);const normal=await f.run('default',{agent:'reviewer',task:'A2 ordinary review',scope:['a.ts'],backend:'native'},undefined,undefined,{cwd:f.cwd} as any);
 assert.equal((normal.details as any).operatorStateVerification,undefined);assert.equal(f.state().acceptance.evidenceRef,null);
});

test('current-state review closes operator edits in a nested repository under a plain workspace folder',async t=>{
 const scope=['rin-docs/prd.md'];
 const f=await operatorStateFixture(t,'pass','nested',scope);
 const r=await f.run('nested',{agent:'reviewer',task:'A2 current state of the operator PRD edit',scope,backend:'native',review_mode:'operator-current-state'},undefined,undefined,{cwd:f.cwd} as any);
 const details=r.details as any;assert.ok(details.processVerdict,JSON.stringify(r));
 assert.equal(details.operatorStateVerification.status,'accepted',JSON.stringify(details.operatorStateVerification));
 assert.equal(details.processVerdict.obligations.review.status,'satisfied');assert.equal(details.processVerdict.obligations.acceptance.status,'satisfied');
 assert.deepEqual(details.processVerdict.auditScope,scope);assert.deepEqual(f.state().changedFiles,scope);
 // update_assertion's gate (rankedin, 2026-11-12): the root has no revision, so the
 // review must be checked over the repository it covered.
 const current=(scopes:readonly string[])=>revisionOf(f.cwd,scopes);
 assert.equal(processPreEffectGate(f.state(),'prove','',current),null,'the reviewed operator edit can be proven');
 writeFileSync(join(f.cwd,'ringithub/app.ts'),'export const app=2;\n');
 assert.equal(processPreEffectGate(f.state(),'prove','',current),null,'a change in another nested repository leaves the review current');
 writeFileSync(join(f.cwd,'rin-docs/clean.md'),'edited after the review\n');
 assert.match(processPreEffectGate(f.state(),'prove','',current)?.message??'',/open: review/,'a later change in the reviewed repository makes the review stale');
});

test('early current-state refusal names the omitted cli/server task entry only with prior same-task display provenance',async t=>{
 const cli='packages/cli', server='packages/server';
 const cliFile=`${cli}/internal-cli-fixture.ts`, serverFile=`${server}/private-server-fixture.ts`;
 const cases=[
  {name:'server omitted',declared:cliFile,omitted:serverFile,entries:[cli,server],entry:server},
  {name:'cli omitted',declared:serverFile,omitted:cliFile,entries:[cli,server],entry:cli},
  {name:'unknown',declared:cliFile,omitted:serverFile},
  {name:'private work has no prior label',declared:cliFile,omitted:serverFile,entries:[cli,'private-server-fixture.ts']},
  {name:'stale task history',declared:cliFile,omitted:serverFile,entries:[server],stale:true},
  {name:'malicious markup',declared:cliFile,omitted:`${server}\`injected/private-server-fixture.ts`,entries:[`${server}\`injected`]},
  {name:'neighbor is not a match',declared:cliFile,omitted:`${server}-old/private-server-fixture.ts`,entries:[server]},
  {name:'included entry is not omitted',declared:cliFile,omitted:`${cli}/private-server-fixture.ts`,entries:[cli]},
 ];
 for(const c of cases){
  // Independent recovery history so each case reaches the actual early refusal.
  const f=await operatorStateFixture(t);
  for (const file of [cliFile,serverFile]) {
   mkdirSync(join(f.cwd,file,'..'),{recursive:true});
   writeFileSync(join(f.cwd,file),'current work\n');
  }
  let launches=0;
  f.d.dispatchAgent=async()=>{launches++;throw Error('must refuse before launch');};
  const entries=c.entries;
  f.d.state.getTaskDisplayScope=entries ? ()=>({taskId:c.stale?'previous-task':f.d.noProgress.taskId(),entries}) : undefined;
  f.d.state.setProcessState!({...f.state(),changedFiles:[c.declared,c.omitted]});
  const before=f.state();
  const r=await f.run(c.name,{agent:'reviewer',task:'Review registered task work',scope:[c.declared],backend:'native',review_mode:'operator-current-state'},undefined,undefined,{cwd:f.cwd} as any);
  const details=r.details as any, text=r.content[0].text as string;
  assert.match(text,/operator_state_incomplete_scope\nActual checked paths are unknown\./,c.name);
  assert.match(text,/local Git status.*exact workspace-relative changed files.*targeted checks/,c.name);
  assert.equal(details.scopeDiagnostic.checkedPaths,'unknown',c.name);
  assert.equal(details.scopeDiagnostic.kind,c.entry?'omitted_task_entry':'unknown',c.name);
  assert.equal(details.scopeDiagnostic.entry,c.entry,c.name);
  if(c.entry) assert.ok(text.includes(`\`${c.entry}\``),c.name);
  else assert.doesNotMatch(JSON.stringify(r),/packages\//,c.name);
  assert.doesNotMatch(JSON.stringify(r),/internal-cli-fixture|private-server-fixture|injected/,c.name);
  assert.equal(details.status,'operator_state_preflight_failed');
  assert.equal(details.started,false);
  assert.equal(details.effects,'none');
  assert.equal(f.state(),before);
  assert.equal(launches,0);
  assert.equal(f.d._task(),0);
 }
});

test('nested current-state still refuses files outside a nested repository, clean files and a changed file during review',async t=>{
 for(const scope of [['loose.md'],['rin-docs/clean.md'],['rin-docs/prd.md','loose.md']]){
  const f=await operatorStateFixture(t,'pass','nested',scope);
  const r=await f.run('nested-invalid',{agent:'reviewer',task:'A2 nested invalid '+scope.join(','),scope,backend:'native',review_mode:'operator-current-state'},undefined,undefined,{cwd:f.cwd} as any);
  const details=r.details as any;
  assert.equal(details.started,false,scope.join(','));assert.equal(f.d._task(),0);
  const observed=scope[0]==='rin-docs/clean.md';
  assert.equal(details.scopeDiagnostic.kind,observed?'observation_gap':'unknown');
  assert.match(r.content[0].text as string,/Actual checked paths are unknown/);
  assert.match(r.content[0].text as string,observed?/operator_state_scope_unobserved.*entry #1/s:/operator_state_scope_unavailable.*Check the current Git status/s);
  assert.doesNotMatch(r.content[0].text as string,/clean\.md|loose\.md|prd\.md/);
 }
 const scope=['rin-docs/prd.md'];
 const f=await operatorStateFixture(t,'modified-nested','nested',scope);
 f.d.dispatchAgent=(original=>async(...args:any[])=>{writeFileSync(join(f.cwd,'rin-docs/prd.md'),'# PRD\n\nChanged during the review.\n');return original(...args);})(f.d.dispatchAgent);
 const r=await f.run('nested-modified',{agent:'reviewer',task:'A2 nested modified',scope,backend:'native',review_mode:'operator-current-state'},undefined,undefined,{cwd:f.cwd} as any);
 assert.equal((r.details as any).operatorStateVerification.status,'unproven');assert.equal(f.state().review.evidenceRef,null);assert.equal(f.state().acceptance.evidenceRef,null);
});

test('current-state mode cannot omit an active automated assertion by naming only another ID',async t=>{
 const f=await operatorStateFixture(t),prior=f.d.state.getAssertions();f.d.state.getAssertions=()=>[...prior,{id:'A3',tag:'test',text:'second required check',source:'fixture',testCommand:'node --test second.test.js',status:'open'}];
 const r=await f.run('all-tests',{agent:'reviewer',task:'A2 only in prose',scope:['a.ts'],backend:'native',review_mode:'operator-current-state'},undefined,undefined,{cwd:f.cwd} as any);
 assert.equal((r.details as any).operatorStateVerification.status,'unproven');assert.equal(f.state().acceptance.evidenceRef,null);
});

test('current-state acceptance persists real evidence payload in captured session namespace',async t=>{
 const f=await operatorStateFixture(t);const own=mkdtempSync(join(tmpdir(),'operator-owner-')),foreign=mkdtempSync(join(tmpdir(),'operator-foreign-'));
 t.after(()=>{rmSync(own,{recursive:true,force:true});rmSync(foreign,{recursive:true,force:true});});f.d.state.getSessionDir=()=>own;
 const {createAssertionsArtifactsContext}=await import('../context/assertions-artifacts.ts');
 const artifacts=createAssertionsArtifactsContext({getAssertions:()=>[],getSessionDir:()=>foreign,getRunHistoryKeep:()=>null,setStatus:()=>{}});
 let proofCall:any[]=[];f.d.artifacts.writeRunArtifact=(...args:any[])=>{
  if(String(args[0]).startsWith('operator-state')){proofCall=args;assert.equal(typeof args[1],'number');assert.equal(args[3],'evidence');assert.equal(args[5],own);}
  return (artifacts.writeRunArtifact as any)(...args);
 };
 const r=await f.run('real-evidence',{agent:'reviewer',task:'A2 current state with real writer',scope:['a.ts'],backend:'native',review_mode:'operator-current-state'},undefined,undefined,{cwd:f.cwd} as any);
 const proof=(r.details as any).operatorStateVerification;assert.equal(proof?.status,'accepted',JSON.stringify(r));
 assert.ok(proof.evidenceRef.startsWith(join(own,'artifacts','evidence')));assert.equal(proofCall.length,6);
 const persisted=JSON.parse(readFileSync(proof.evidenceRef,'utf8'));assert.equal(persisted.schema,'agent-fleet.operator-state-verification/v1');assert.equal(persisted.historicalAttribution,'not_claimed');
 assert.deepEqual(persisted.paths,['a.ts']);assert.equal(persisted.revision,worktreeRevision(f.cwd,[]));assert.ok(persisted.checks.some((c:any)=>c.producer==='runtime'&&c.status==='passed'));
});

test('missing or hollow current-state evidence cannot register acceptance or review',async t=>{
 for(const failure of ['hollow','missing','wrong-kind']){
  const f=await operatorStateFixture(t),writer=f.d.artifacts.writeRunArtifact;
  f.d.artifacts.writeRunArtifact=(...args:any[])=>{
   if(args[0]==='operator-state'){
    if(failure==='missing')return join(f.d.state.getSessionDir(),'artifacts','evidence','absent.md');
    if(failure==='hollow')args[2]='evidence';else args[3]='returns';
   }
   return (writer as any)(...args);
  };
  const r=await f.run(failure,{agent:'reviewer',task:'A2 bad evidence '+failure,scope:['a.ts'],backend:'native',review_mode:'operator-current-state'},undefined,undefined,{cwd:f.cwd} as any);
  assert.equal((r.details as any).operatorStateVerification.status,'unproven');assert.equal((r.details as any).operatorStateVerification.reason,'evidence_readback_failed');
  assert.equal(f.state().acceptance.evidenceRef,null);assert.equal(f.state().review.evidenceRef,null);
 }
});

test('current-state preflight rejects inspection-only or source-writing reviewer tool sets',async t=>{
 for(const tools of ['read,grep','read,bash,edit','read,bash,write']){
  const f=await operatorStateFixture(t);f.d._agents.get('reviewer')!.def.tools=tools;
  const r=await f.run('tools',{agent:'reviewer',task:'A2 invalid tool set',scope:['a.ts'],backend:'native',review_mode:'operator-current-state'},undefined,undefined,{cwd:f.cwd} as any);
  assert.equal((r.details as any).started,false);assert.equal(f.d._task(),0);
 }
});

test('current-state legacy return compatibility still requires actual checks and independent approval',async t=>{
 const f=await operatorStateFixture(t,'legacy');
 const r=await f.run('legacy',{agent:'reviewer',task:'A2 legacy current state',scope:['a.ts'],backend:'native',review_mode:'operator-current-state'},undefined,undefined,{cwd:f.cwd} as any);
 assert.equal((r.details as any).operatorStateVerification.status,'accepted');
 assert.notEqual((r.details as any).resultProtocol,'submit_result');
 assert.equal(f.d.state.getAssertions()[1].status,'open');
});

test('regression marker cannot replace evidence or approve a partial regression', async () => {
 const { reviewMayClose } = await import('../orchestration-activation.ts');
 const input = { revision: 'a'.repeat(64), scope: ['a.ts'], output: '**Verdict:** APPROVE\nFull-regression marker: passed', declared: true, wide: true };
 assert.equal(reviewMayClose(input), false);
 for (const marker of ['partial regression', 'full regressionish', 'tests_run: fullish']) {
  assert.equal(reviewMayClose({ ...input, output: '**Verdict:** APPROVE\n' + marker, evidenceRef: 'evidence:current' }), false);
 }
});

// A reviewer appended `; echo ...:$?` in the reported incident. That is a different
// shell command whose success can mask a failed test; prose cannot repair it.
test('current-state review explains wrapped check rejection and recovers only with an exact check', async t => {
 const f=await operatorStateFixture(t);
 const dispatch=f.d.dispatchAgent; let wrapped=true; let childTask='';
 f.d.dispatchAgent=async(...args:any[])=>{
  childTask=JSON.stringify(args);
  const result=await (dispatch as any)(...args);
  result.dispatchId=wrapped?'wrapped-check':'exact-check';
  if(wrapped)result.runtimeTests=result.runtimeTests.map((record:any)=>({...record,command:record.command+'; echo TEST_EXIT:$?'}));
  return result;
 };
 const params={agent:'reviewer',task:'A2 current-state verification',scope:['a.ts'],backend:'native' as const,review_mode:'operator-current-state' as const};
 const first=await f.run('wrapped',params,undefined,undefined,{cwd:f.cwd} as any);
 const detail=first.details as any;
 assert.equal(detail.operatorStateVerification.status,'unproven');
 assert.deepEqual(detail.verificationResult.checks,[]);
 assert.equal(f.state().review.evidenceRef,null);
 assert.deepEqual(detail.verificationDiagnostics.missingExactCommands,[{command:'node --test candidate.test.js',requirementIds:['A2']}]);
 assert.equal(detail.verificationDiagnostics.observedCommandCount,1);
 assert.deepEqual(JSON.parse(readFileSync(detail.assessmentPath,'utf8')).verificationDiagnostics,detail.verificationDiagnostics);
 assert.match(first.content.map((part:any)=>part.text??'').join('\n'),/Exact declared verification commands were not observed/);
 assert.match(childTask,/unchanged, one bash call per command/);
 assert.match(childTask,/Do not append.*echo/);
 wrapped=false;
 const second=await f.run('exact',{...params,task:'A2 recover with exact declared checks after wrapped command was rejected'},undefined,undefined,{cwd:f.cwd} as any);
 assert.equal((second.details as any).operatorStateVerification?.status,'accepted',JSON.stringify(second));
 assert.equal(f.state().review.evidenceRef!==null,true);
 assert.deepEqual((second.details as any).verificationDiagnostics.missingExactCommands,[]);
 assert.equal(f.d.state.getAssertions()[1].status,'open','manual requirement is never promoted by recovery');
});
