import test from "node:test";
import assert from "node:assert/strict";
import { applyProcessClassification, createProcessState, evaluateProcessObligations, latestProcessState, noteProcessStage, processAuditRecord, processPreEffectGate, processActionGate, effectiveProcessStage, processTaskIdentityConflicts, activeAdditionRecoveryHints, missingProcessRoleRecoveryHints, taskTransitionRecoveryHint, transitionDiversionDecision, latestPendingTaskTransition, TASK_TRANSITION_ENTRY_TYPE } from "./process-obligations.ts";
import { adoptTaskTriageState, applyTaskTriageAdditions, pendingActionConfirmation, recoverTaskTriageProcessState, waiveTaskTriageAddition } from "./task-triage-obligations.ts";
import { createTaskTriageRuntime } from "./task-triage-runtime.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageProducerToolGate, stageProducerTools } from "./task-triage-stage-guard.ts";
import { TASK_TRIAGE_QUESTIONS, TASK_TRIAGE_QUESTION_VERSION } from "./task-triage-contract.ts";
const binding = { taskId: "task-1", evaluationId: "eval-1", inputRevision: "input-1" };
const assessment = (...reasons: ("security_change" | "wide_change" | "irreversible_execution")[]) => ({ status: "applied" as const, reasons });
test("saved process task identity permits the valid resume but refuses corrupt and ambiguous bindings", () => {
 const valid = applyTaskTriageAdditions(createProcessState(), assessment("security_change"), binding);
 assert.equal(processTaskIdentityConflicts(valid, binding.taskId), false);
 assert.equal(processTaskIdentityConflicts(valid, "startup-generated-task"), true, "a foreign recovered task cannot take ownership of an addition");
 const ambiguous = applyTaskTriageAdditions(valid, assessment("wide_change"), { ...binding, taskId: "other-task", evaluationId: "eval-2" });
 assert.equal(processTaskIdentityConflicts(ambiguous, binding.taskId), true, "two distinct saved task bindings remain blocked");
 assert.throws(() => latestProcessState([{ customType: "agent-hub-process-state", data: { schema: valid.schema,
  state: { ...valid, additions: [{ ...valid.additions![0], taskId: "" }] } } }]), /Invalid process addition/);
});
test("rejected adoption never changes scope/current or reserves a logical call", async t => {
 const root = mkdtempSync(join(tmpdir(), "triage-adopt-")); t.after(() => rmSync(root, { recursive: true, force: true }));
 let physical = 0;
 const runtime = createTaskTriageRuntime({ root, service: { async evaluate() { physical++; return { status: "ok", evaluation: { answers: TASK_TRIAGE_QUESTIONS.map(q => ({ questionId: q.id, type: "predicate", probabilityTrue: .1, uncertainty: { provenance: "provider" } })), metadata: { provider: "typesafe", requestedModel: "jev-1.13.0", returnedModel: "jev-1.13.0", questionSetVersion: TASK_TRIAGE_QUESTION_VERSION, latencyMs: 1, attempts: 1 } } } as any; } }, persist: () => {} });
 runtime.input("Edit code", "interactive");
 const first = await runtime.evaluate("old-task");
 assert.ok(first); assert.equal(runtime.calls, 1);
 const original = createProcessState();
 await assert.rejects(adoptTaskTriageState({ runtime, taskId: "new-task", newTask: false, expandedScope: "wide", pendingTransition: false, state: original, persist: () => { throw Error("disk full"); }, onPostCommitFailure: () => {} }), /disk full/);
 assert.equal(runtime.current, first); assert.equal((await runtime.evaluate("old-task")), first);
 assert.equal(runtime.calls, 1); assert.equal(physical, 1);
 // The current input must still be evaluated for the new scope on a successful retry.
 const persisted: unknown[] = [];
 await adoptTaskTriageState({ runtime, taskId: "new-task", newTask: false, expandedScope: "wide", pendingTransition: false, state: original, persist: s => persisted.push(s), onPostCommitFailure: () => assert.fail("unexpected persistence error") });
 assert.equal(runtime.calls, 2); assert.equal(physical, 2);
 assert.equal(runtime.current?.taskId, "new-task"); assert.equal(persisted.length, 2);
 runtime.input("Later task", "interactive");
 await assert.rejects(adoptTaskTriageState({ runtime, taskId: "later-task", newTask: true, pendingTransition: true, state: original, persist: () => { throw Error("disk full"); }, onPostCommitFailure: () => {} }), /disk full/);
 assert.equal(runtime.current, null); assert.equal(runtime.calls, 2);
 assert.equal(physical, 2, "failed preflight never evaluates queued input");
});
test("cancelled new-task binding retains prior obligations in the persisted journal", async () => {
 const prior = applyTaskTriageAdditions(applyProcessClassification(createProcessState(), { risk: "high", scope: "wide", reason: "baseline" }).state, assessment("security_change"), binding);
 const entries: any[] = [{ customType: "agent-hub-process-state", data: processAuditRecord(prior, evaluateProcessObligations(prior, { writable: true, budgetTier: "small" })) }];
 let cancel!: () => void;
 const runtime = { current: null, bindInput: () => new Promise<null>(resolve => { cancel = () => resolve(null); }), adopt: () => assert.fail("cancelled binding must not adopt") } as unknown as ReturnType<typeof createTaskTriageRuntime>;
 const adoption = adoptTaskTriageState({ runtime, taskId: "new-task", newTask: true, pendingTransition: true, state: prior,
  persist: state => entries.push({ customType: "agent-hub-process-state", data: processAuditRecord(state, evaluateProcessObligations(state, { writable: true, budgetTier: "small" })) }),
  onPostCommitFailure: () => assert.fail("binding cancellation is not a post-commit failure"),
 });
 cancel();
 await assert.rejects(adoption, /pending input was not evaluated/);
 assert.deepEqual(latestProcessState(entries), latestProcessState(entries.slice(0, 1)), "resume must retain both baseline and S1 obligations");
 assert.deepEqual(latestProcessState(entries).additions?.map(a => a.reason), ["security_change"]);
 assert.equal(latestProcessState(entries).plan.required, true);
});
test("new-task persistence failures cannot reset a rejected adoption's durable obligations", async () => {
 const prior = applyTaskTriageAdditions(applyProcessClassification(createProcessState(), { risk: "high", scope: "wide", reason: "baseline" }).state, assessment("security_change"), binding);
 const initial = { customType: "agent-hub-process-state", data: processAuditRecord(prior, evaluateProcessObligations(prior, { writable: true, budgetTier: "small" })) };
 for (const failedWrite of [1, 2]) {
  const entries: any[] = [initial]; let writes = 0, blocked = false, adopted = false;
  const runtime = { current: null, bindInput: async () => ({ ...binding, revision: "input-2", assessment: assessment("wide_change") }), adopt: () => { adopted = true; } } as unknown as ReturnType<typeof createTaskTriageRuntime>;
  await assert.rejects(adoptTaskTriageState({ runtime, taskId: "new-task", newTask: true, pendingTransition: true, state: prior,
   persist: state => { if (++writes === failedWrite) throw Error("disk full"); entries.push({ customType: "agent-hub-process-state", data: processAuditRecord(state, evaluateProcessObligations(state, { writable: true, budgetTier: "small" })) }); },
   onPostCommitFailure: () => { blocked = true; },
  }), /disk full|persist/);
  assert.deepEqual(latestProcessState(entries), latestProcessState([initial]));
  assert.equal(adopted, false);
  assert.equal(blocked, failedWrite === 2);
 }
});
test("post-commit assessment write failure blocks effects without misreporting a rejected adoption", async t => {
 const root = mkdtempSync(join(tmpdir(), "triage-adopt-")); t.after(() => rmSync(root, { recursive: true, force: true }));
 let physical = 0;
 const runtime = createTaskTriageRuntime({ root, service: { async evaluate() { physical++; return { status: "unavailable", reason: "offline" }; } } as any, persist: () => {} });
 runtime.input("Edit code", "interactive"); await runtime.evaluate("old-task");
 const writes: unknown[] = []; let blocked = false;
 const accepted = await adoptTaskTriageState({ runtime, taskId: "new-task", newTask: false, expandedScope: "wide", pendingTransition: false, state: createProcessState(), persist: state => { writes.push(state); if (writes.length === 2) throw Error("disk full"); }, onPostCommitFailure: () => { blocked = true; } });
 assert.deepEqual(accepted, writes[0]); assert.equal(blocked, true);
 assert.equal(runtime.calls, 2); assert.equal(physical, 2);
});
test("in-session recovery persists full baseline/addition union and checks readback before release", () => {
 const base = applyProcessClassification(createProcessState(), { risk: "high", scope: "wide", reason: "baseline" }).state;
 const state = applyTaskTriageAdditions(base, assessment("irreversible_execution", "security_change"), binding);
 const entries: any[] = [{ customType: "agent-hub-process-state", data: processAuditRecord(state, evaluateProcessObligations(state, { writable: true, budgetTier: "small" })) }];
 const opts = { state, current: { ...binding, assessment: assessment("wide_change") }, taskId: binding.taskId, budgetTier: "small", append: (record: any) => entries.push({ customType: "agent-hub-process-state", data: record }), entries: () => entries };
 const next = recoverTaskTriageProcessState(opts);
 assert.equal(next.risk, "high"); assert.equal(next.plan.required, true); assert.equal(next.review.required, true);
 assert.deepEqual(next.additions?.map(a => a.reason), ["irreversible_execution", "security_change", "wide_change"]);
 assert.equal(processPreEffectGate(next, "write")?.reason, "process_plan_open");
 assert.equal(processPreEffectGate(noteProcessStage(next, "plan", { evidenceRef: "plan", revision: "rev" }), "write")?.reason, "action_confirmation_unsupported");
 const count = entries.length;
 assert.throws(() => recoverTaskTriageProcessState({ ...opts, state: next, append: () => { throw Error("full"); } }), /full/);
 assert.equal(entries.length, count);
 assert.throws(() => recoverTaskTriageProcessState({ ...opts, state: next, current: { ...binding, inputRevision: "new-revision", assessment: assessment("wide_change") }, append: () => {} }), /readback differs/);
 entries.push({ customType: "agent-hub-process-state", data: { schema: state.schema, state: { ...state, additions: [{ bad: true }] } } });
 assert.throws(() => recoverTaskTriageProcessState(opts), /Invalid process addition/);
});
test("recovery accepts a monotonic stage-evidence successor after failed append", () => {
 const state = applyTaskTriageAdditions(applyProcessClassification(createProcessState(), { risk: "high", scope: "wide", reason: "baseline" }).state, assessment("irreversible_execution"), binding);
 const entries: any[] = [{ customType: "agent-hub-process-state", data: processAuditRecord(state, evaluateProcessObligations(state, { writable: true, budgetTier: "small" })) }];
 const newer = noteProcessStage(state, "plan", { evidenceRef: "run:plan", revision: "rev" });
 const recovered = recoverTaskTriageProcessState({ state: newer, current: null, taskId: binding.taskId, budgetTier: "small", append: record => entries.push({ customType: "agent-hub-process-state", data: record }), entries: () => entries });
 assert.equal(recovered.plan.evidenceRef, "run:plan"); assert.equal(recovered.plan.required, true);
 assert.equal(processPreEffectGate(recovered, "write")?.reason, "action_confirmation_unsupported");
 assert.throws(() => recoverTaskTriageProcessState({ state: newer, current: null, taskId: "another-task", budgetTier: "small", append: () => assert.fail("must not append"), entries: () => entries }), /different task/);
});
test("recovery refuses stale in-memory union and oversized additions without clearing a gate", () => {
 const base = applyProcessClassification(createProcessState(), { risk: "high", scope: "small", reason: "baseline" }).state;
 const state = applyTaskTriageAdditions(base, assessment("irreversible_execution"), binding);
 const entries: any[] = [{ customType: "agent-hub-process-state", data: processAuditRecord(state, evaluateProcessObligations(state, { writable: true, budgetTier: "small" })) }];
 let writes = 0;
 const opts = { state: base, current: null, taskId: binding.taskId, budgetTier: "small", append: () => { writes++; }, entries: () => entries };
 assert.throws(() => recoverTaskTriageProcessState(opts), /differs from in-memory/);
 assert.equal(writes, 0);
 assert.throws(() => recoverTaskTriageProcessState({ ...opts, state: { ...state, additions: Array.from({ length: 301 }, (_, i) => ({ ...state.additions![0], id: String(i) })) } }), /persistence limit/);
 assert.equal(writes, 0);
});
test("partial roster yields exact missing-role recovery, not a substitute agent", () => {
 const state = applyTaskTriageAdditions(createProcessState(), assessment("wide_change"), binding);
 const hint = missingProcessRoleRecoveryHints(state, new Set(["builder"]));
 assert.match(hint, /\/af-agents-add planner/);
 assert.match(hint, /\/af-agents-add code-reviewer/);
 assert.match(hint, /\/af-agents-team/);
 assert.equal(missingProcessRoleRecoveryHints(state, new Set(["builder", "planner", "security-auditor"])), "");
 assert.match(missingProcessRoleRecoveryHints(state, new Set()), /\/af-agents-add planner/);
});
test("active additions expose exact waiver IDs, plain obligations and transition instructions", () => {
 const state = applyTaskTriageAdditions(createProcessState(), assessment("security_change", "wide_change", "irreversible_execution"), binding);
 const hint = activeAdditionRecoveryHints(state, binding.taskId, binding.inputRevision);
 for (const addition of state.additions!) {
  assert.match(hint, new RegExp(addition.id));
  assert.match(hint, new RegExp(`/af-task-triage-waive ${addition.id} <reason>`));
 }
 assert.match(hint, /security-sensitive change.*review before acceptance/i);
 assert.match(hint, /wide change.*plan before effects.*review before acceptance/i);
 assert.match(hint, /irreversible execution.*exact.*human confirmation before each effect/i);
 assert.match(taskTransitionRecoveryHint, /pending task transition.*set_task_tier.*new_task: true.*human supersession/i);
 const firstDiversion = transitionDiversionDecision(0, taskTransitionRecoveryHint);
 assert.equal(firstDiversion.terminate, undefined);
 assert.equal(firstDiversion.nextCount, 1);
 assert.match(firstDiversion.reason, /set_task_tier/);
 assert.match(firstDiversion.reason, /next tool that is not set_task_tier or ask_user stops the turn/);
 const stopped = transitionDiversionDecision(firstDiversion.nextCount, taskTransitionRecoveryHint);
 assert.equal(stopped.terminate, true);
 assert.equal(stopped.nextCount, 2);
 assert.match(stopped.reason, /Turn stopped/);
 assert.match(stopped.reason, /Do not call another tool in this turn/);
 assert.equal(latestPendingTaskTransition([]), false);
 assert.equal(latestPendingTaskTransition([{ type: "custom", customType: TASK_TRANSITION_ENTRY_TYPE, data: { pending: true } }]), true);
 assert.equal(latestPendingTaskTransition([{ type: "custom", customType: TASK_TRANSITION_ENTRY_TYPE, data: { pending: true } }, { type: "custom", customType: TASK_TRANSITION_ENTRY_TYPE, data: { pending: false } }]), false);
 assert.equal(latestPendingTaskTransition([{ type: "custom", customType: TASK_TRANSITION_ENTRY_TYPE, data: { pending: "bad" } }]), true);
 assert.doesNotMatch(activeAdditionRecoveryHints(state, "another-task", binding.inputRevision), /\/af-task-triage-waive/);
 const stale = activeAdditionRecoveryHints(state, binding.taskId, "new-input");
 assert.match(stale, /Waiver unavailable for this input revision/);
 assert.doesNotMatch(stale, /\/af-task-triage-waive/);
});
test("independent source union, durable provenance, unchanged spend and idempotent evidence", () => {
 const baseline = applyProcessClassification(createProcessState(), { risk: "low", scope: "small", reason: "declared" }).state;
 let s = applyTaskTriageAdditions(baseline, assessment("security_change", "wide_change", "irreversible_execution"), binding);
 assert.equal(s.risk, "low"); assert.equal(s.scope, "small"); assert.equal(s.additions?.length, 3);
 assert.equal(effectiveProcessStage(s, "plan"), true); assert.equal(effectiveProcessStage(s, "review"), true); assert.equal(pendingActionConfirmation(s).length, 1);
 assert.equal(processPreEffectGate(s, "write")?.reason, "process_plan_open");
 assert.equal(processActionGate(s)?.reason, "action_confirmation_unsupported");
 assert.equal(processActionGate(s, { actionId: "a", taskId: "task-1", inputRevision: "input-1", operation: "migration", target: "production" }, true as any)?.reason, "action_confirmation_unsupported");
 const verdict = evaluateProcessObligations(s, { writable: true, budgetTier: "small", t2Accepted: true, currentRevision: "rev-1" });
 assert.equal(verdict.accepted, false); assert.equal(verdict.obligations.plan.status, "open"); assert.equal(verdict.obligations.review.status, "open"); assert.equal(verdict.obligations.confirmation?.status, "open");
 assert.equal(processPreEffectGate(s, "write")?.reason, "process_plan_open");
 s = noteProcessStage(noteProcessStage(s, "plan", { evidenceRef: "plan:1", revision: "rev-1" }), "review", { evidenceRef: "review:1", revision: "rev-1" });
 assert.deepEqual(applyTaskTriageAdditions(s, assessment("security_change", "wide_change"), binding), s, "identical evaluation cannot reopen stages");
 const entry = { type: "custom", customType: "agent-hub-process-state", data: processAuditRecord(s, verdict) };
 assert.deepEqual(latestProcessState([entry, { type: "compaction" }]), s);
 assert.equal(evaluateProcessObligations(s, { writable: true, budgetTier: "trivial", t2Accepted: true, currentRevision: "rev-2" }).obligations.review.status, "open");
 const expanded = applyProcessClassification(s, { risk: "low", scope: "wide", reason: "expanded" });
 assert.equal(expanded.ok, true); assert.equal(expanded.state.plan.evidenceRef, null); assert.equal(expanded.state.review.evidenceRef, null);
});
test("waiver releases exactly one S1 source, never baseline or other S1 sources", () => {
 let s = applyTaskTriageAdditions(createProcessState(), assessment("security_change"), binding);
 s = applyTaskTriageAdditions(s, assessment("security_change"), { ...binding, evaluationId: "eval-2", inputRevision: "input-2" });
 const first = s.additions![0];
 for (const b of [{ ...binding, additionId: first.id, reason: "" }, { ...binding, additionId: first.id, reason: "error", inputRevision: "old" }, { ...binding, additionId: first.id, reason: "human correction" }]) assert.equal(waiveTaskTriageAddition(s, b, true as any), null);
 assert.equal(s.additions![0].status, "active"); assert.equal(s.additions![1].status, "active");
 const high = applyProcessClassification(s, { risk: "high", scope: "wide", reason: "independent baseline" }).state;
 assert.equal(effectiveProcessStage(high, "review"), true); assert.equal(effectiveProcessStage(high, "plan"), true);
 assert.equal(evaluateProcessObligations(high, { writable: true, budgetTier: "small", t2Accepted: true }).accepted, false);
});
test("child dispatch and writes refuse unbound action even after plan; read-only proof cannot satisfy it", () => {
 let s = applyTaskTriageAdditions(createProcessState(), assessment("irreversible_execution"), binding);
 for (const persona of ["builder", ""]) assert.equal(processPreEffectGate(s, "child", persona)?.reason, "action_confirmation_unsupported");
 for (const persona of ["planner", "code-reviewer"]) assert.equal(processPreEffectGate(s, "child", persona)?.reason, "action_confirmation_unsupported", "a role name alone cannot bypass confirmation");
 const withStages = applyTaskTriageAdditions(s, assessment("wide_change"), { ...binding, evaluationId: "eval-2", inputRevision: "input-2" });
 assert.equal(processPreEffectGate(withStages, "child", "planner"), null, "required plan producer remains executable");
 const planned = noteProcessStage(withStages, "plan", { evidenceRef: "plan", revision: "rev-1" });
 assert.equal(processPreEffectGate(planned, "child", "code-reviewer"), null, "required review producer remains executable");
 assert.equal(processPreEffectGate(planned, "child", "planner")?.reason, "action_confirmation_unsupported", "a completed plan cannot become a generic exemption");
 assert.equal(processPreEffectGate(s, "write")?.reason, "action_confirmation_unsupported");
 assert.equal(processPreEffectGate(s, "prove")?.reason, "process_obligations_open");
 assert.equal(processPreEffectGate(s, "child", "builder", "rev-1")?.reason, "action_confirmation_unsupported");
});
test("stage child can inspect for plan/review without shell, writes or delegation", () => {
 assert.equal(stageProducerTools("read,grep,find,ls,bash,write,edit,delegate,filesystem"), "read,grep,find,ls");
 for (const name of ["bash", "edit", "write", "delegate", "filesystem"]) assert.match(stageProducerToolGate(name)!, /refused/);
 for (const name of ["read", "grep", "find", "ls"]) assert.equal(stageProducerToolGate(name), null);
});
test("confirmation is per-effect, not a task-level proof gate or a waiver", () => {
 const s = applyTaskTriageAdditions(applyProcessClassification(createProcessState(), { risk: "low", scope: "small", reason: "declared" }).state, assessment("irreversible_execution"), binding);
 assert.deepEqual(pendingActionConfirmation(s).map(a => a.status), ["active"]);
 assert.equal(processPreEffectGate(s, "write")?.reason, "action_confirmation_unsupported");
 assert.equal(processPreEffectGate(s, "child", "builder")?.reason, "action_confirmation_unsupported");
 assert.equal(processPreEffectGate(s, "prove"), null, "proof is not another unbound action");
 const verdict = evaluateProcessObligations(s, { writable: true, budgetTier: "small", t2Accepted: true });
 assert.equal(verdict.accepted, true, "a previously gated effect can close T2 without waiving future gates");
 assert.equal(verdict.obligations.confirmation?.status, "open", "each future effect still requires a fresh confirmation");
 assert.equal(verdict.additions[0].status, "active", "one confirmation cannot waive the addition");
 assert.equal(processAuditRecord(s, verdict).obligations.confirmation.status, "open");
 assert.equal(processPreEffectGate(s, "write")?.reason, "action_confirmation_unsupported", "a second effect remains gated");
});
test("identical input across evaluation IDs is idempotent; expanded input reopens only affected evidence", () => {
 let s = applyTaskTriageAdditions(createProcessState(), assessment("security_change"), binding);
 s = noteProcessStage(s, "review", { evidenceRef: "review:covered", revision: "rev-1" });
 const repeated = applyTaskTriageAdditions(s, assessment("security_change"), { ...binding, evaluationId: "eval-new" });
 assert.deepEqual(repeated, s);
 const expanded = applyTaskTriageAdditions(s, assessment("security_change"), { ...binding, evaluationId: "eval-new", inputRevision: "input-2" });
 assert.equal(expanded.additions?.length, 2); assert.equal(expanded.review.evidenceRef, null);
});
test("persistence overflow is refused rather than trimming an active final requirement", () => {
 const one = applyTaskTriageAdditions(createProcessState(), assessment("security_change"), binding);
 const full = { ...one, additions: Array.from({ length: 300 }, (_, i) => ({ ...one.additions![0], id: `id-${i}` })) };
 const overflowing = { ...full, additions: [...full.additions!, { ...one.additions![0], id: "last", reason: "irreversible_execution" as const }] };
 assert.throws(() => latestProcessState([{ customType: "agent-hub-process-state", data: { schema: one.schema, state: overflowing } }]), /persistence limit/);
 assert.equal(processPreEffectGate(overflowing, "child", "builder")?.reason, "process_state_corrupt");
 assert.throws(() => applyTaskTriageAdditions(full, assessment("wide_change"), { ...binding, inputRevision: "expanded" }), /persistence limit/);
 const compact = { ...one.additions![0], taskId: "t", evaluationId: "e", inputRevision: "r", policyVersion: "p", questionVersion: "q", provider: "p", model: "m", reason: "wide_change" as const };
 const overCount = { ...one, additions: Array.from({ length: 301 }, (_, i) => ({ ...compact, id: `i${i}` })) };
 assert.ok(Buffer.byteLength(JSON.stringify(overCount.additions)) <= 64 * 1024, "count alone must trigger refusal");
 assert.throws(() => latestProcessState([{ customType: "agent-hub-process-state", data: { schema: one.schema, state: overCount } }]), /persistence limit/);
 const tooLarge = { ...one, additions: [{ ...one.additions![0], waiverReason: "x".repeat(65 * 1024) }] };
 assert.throws(() => processActionGate(tooLarge), /persistence limit/);
});
test("large baseline acceptance evidence without additions still evaluates, gates and restores", () => {
 const files = Array.from({ length: 2000 }, (_, i) => `src/large-baseline-change/component-${String(i).padStart(4, "0")}.ts`);
 let state = applyProcessClassification(createProcessState(), { risk: "low", scope: "small", reason: "declared" }).state;
 state = noteProcessStage(state, "acceptance", { evidenceRef: "test:2000", revision: "rev-1", changedFiles: files });
 assert.ok(Buffer.byteLength(JSON.stringify(state)) > 64 * 1024);
 for (const legacy of [false, true]) {
  const persisted: any = JSON.parse(JSON.stringify(state));
  if (legacy) delete persisted.additions;
  else persisted.additions = [];
  const restored = latestProcessState([{ type: "custom", customType: "agent-hub-process-state", data: { schema: state.schema, state: persisted } }]);
  assert.deepEqual(restored.changedFiles, files);
  assert.deepEqual(restored.additions, []);
  const verdict = evaluateProcessObligations(restored, { writable: true, budgetTier: "small", currentRevision: "rev-1" });
  assert.equal(verdict.accepted, true);
  assert.equal(verdict.obligations.acceptance.status, "satisfied");
  assert.deepEqual(verdict.auditScope, files);
  assert.equal(processPreEffectGate(restored, "write"), null);
  assert.equal(processPreEffectGate(restored, "child", "builder"), null);
  assert.equal(processPreEffectGate(restored, "prove", "", "rev-1"), null);
  assert.deepEqual(applyTaskTriageAdditions(restored, assessment(), binding), restored);
  assert.deepEqual(latestProcessState([{ customType: "agent-hub-process-state", data: processAuditRecord(restored, verdict) }]), restored);
 }
});
test("legacy booleans cannot drop checks on normalization or a S1 waiver", () => {
 const legacy: any = { ...createProcessState(), risk: "high", scope: "wide", plan: { required: false, evidenceRef: null, revision: null }, review: { required: false, evidenceRef: null, revision: null }, acceptance: { required: false, evidenceRef: null, revision: null } };
 const s = latestProcessState([{ customType: "agent-hub-process-state", data: { schema: legacy.schema, state: legacy } }]);
 assert.equal(s.acceptance.required, true); assert.equal(s.review.required, true); assert.equal(s.plan.required, true);
});
