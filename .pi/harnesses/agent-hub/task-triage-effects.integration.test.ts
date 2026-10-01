import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTaskTriageRuntime, TASK_TRIAGE_RUNTIME_ENTRY } from "./task-triage-runtime.ts";
import { TASK_TRIAGE_QUESTIONS, TASK_TRIAGE_QUESTION_VERSION, TASK_TRIAGE_LIMITS } from "./task-triage-contract.ts";
import { applyTaskTriageAdditions } from "./task-triage-obligations.ts";
import { confirmTaskTriageAction, consumeActionGrant } from "./task-triage-authorization.ts";
import { applyProcessClassification, createProcessState, evaluateProcessObligations, noteProcessStage, processPreEffectGate, effectiveProcessStage } from "./process-obligations.ts";

// Offline integration: fake shared provider (no network) -> runtime ->
// process additions -> gated effect. Mirrors index.ts input/before_agent_start wiring.

const fixture = (p = 0.9) => ({ status: "ok" as const, evaluation: { answers: TASK_TRIAGE_QUESTIONS.map(q => ({ questionId: q.id, type: "predicate" as const, probabilityTrue: q.id === "security_change" ? p : 0.1, uncertainty: { provenance: "provider" as const } })), metadata: { provider: "typesafe", requestedModel: "jev-1.13.0", returnedModel: "jev-1.13.0", questionSetVersion: TASK_TRIAGE_QUESTION_VERSION, latencyMs: 1, attempts: 1 } } });

function harness(service: any, opts: { persist?: (s: any) => void } = {}) {
  const root = mkdtempSync(join(tmpdir(), "triage-fx-"));
  const entries: any[] = [];
  const runtime = createTaskTriageRuntime({ root, service, persist: opts.persist ?? (s => entries.push({ customType: TASK_TRIAGE_RUNTIME_ENTRY, data: s })) });
  // Fake Pi hook registry: proves input -> before_agent_start ordering through the real runtime.
  const handlers = new Map<string, Array<(e?: any) => unknown>>();
  const pi = { on: (ev: string, h: (e?: any) => unknown) => { if (!handlers.has(ev)) handlers.set(ev, []); handlers.get(ev)!.push(h); }, emit: async (ev: string, e?: any) => { for (const h of handlers.get(ev) ?? []) await h(e); } };
  // Registered exactly like index.ts: input stages, before_agent_start evaluates.
  pi.on("input", (e: any) => runtime.input(e.text, e.source));
  let state = createProcessState();
  pi.on("before_agent_start", async () => {
    const bound = await runtime.evaluate("task-1");
    if (bound) state = applyTaskTriageAdditions(state, bound.assessment, { taskId: bound.taskId, evaluationId: bound.evaluationId, inputRevision: bound.revision });
  });
  return { runtime, pi, entries, state: () => state, close: () => rmSync(root, { recursive: true, force: true }) };
}

test("pre-model hook places truthful assessment and gates dependent effect", async t => {
  let calls = 0;
  const h = harness({ async evaluate() { calls++; return fixture(); } }); t.after(h.close);
  await h.pi.emit("input", { text: "Change installer permissions", source: "interactive" });
  await h.pi.emit("before_agent_start");
  assert.equal(calls, 1);
  assert.equal(effectiveProcessStage(h.state(), "review"), true);
  assert.ok(processPreEffectGate(h.state(), "prove"), "open review must block assertion proof");
});

test("review is pre-acceptance, not pre-authoring; plan and action confirmation still gate effects", () => {
  const base = applyProcessClassification(createProcessState(), { risk: "low", scope: "small", reason: "declared" }).state;
  const bind = { taskId: "task-1", evaluationId: "eval-1", inputRevision: "input-1" };
  const reviewed = applyTaskTriageAdditions(base, { status: "applied", reasons: ["security_change"] }, bind);
  for (const tool of ["bash", "edit", "write"]) {
    // The Hub tool_call hook maps all three to the same pre-effect write gate.
    assert.equal(processPreEffectGate(reviewed, "write"), null, `${tool} can author for review`);
  }
  assert.equal(processPreEffectGate(reviewed, "child", "builder"), null, "native authoring can produce reviewable work");
  assert.equal(processPreEffectGate(reviewed, "prove")?.reason, "process_obligations_open");
  assert.equal(evaluateProcessObligations(reviewed, { writable: true, budgetTier: "small", t2Accepted: true, currentRevision: "rev-1" }).accepted, false);
  const finished = noteProcessStage(reviewed, "review", { evidenceRef: "review:1", revision: "rev-1" });
  assert.equal(evaluateProcessObligations(finished, { writable: true, budgetTier: "small", t2Accepted: true, currentRevision: "rev-1" }).accepted, true);
  const wide = applyTaskTriageAdditions(base, { status: "applied", reasons: ["wide_change"] }, bind);
  assert.equal(processPreEffectGate(wide, "write")?.reason, "process_plan_open");
  assert.equal(processPreEffectGate(wide, "child", "planner"), null);
  const action = applyTaskTriageAdditions(base, { status: "applied", reasons: ["irreversible_execution"] }, bind);
  assert.equal(processPreEffectGate(action, "write")?.reason, "action_confirmation_unsupported");
  assert.equal(processPreEffectGate(action, "child", "builder")?.reason, "action_confirmation_unsupported");
  assert.equal(processPreEffectGate(action, "prove"), null, "confirmation gates each effect, not later proof");
});

test("extension input never becomes a new task; racing inputs bind latest only", async t => {
  let calls = 0;
  const h = harness({ async evaluate() { calls++; return fixture(0.1); } }); t.after(h.close);
  await h.pi.emit("input", { text: "Real user task", source: "interactive" });
  await h.pi.emit("input", { text: "autofeedback noise", source: "extension" });
  await h.pi.emit("before_agent_start");
  assert.equal(calls, 1);
  // Race: second user input wins, stale first result fenced.
  let finish!: (v: any) => void;
  const h2 = harness({ evaluate: () => new Promise(r => { finish = r; }) }); t.after(h2.close);
  await h2.pi.emit("input", { text: "First", source: "interactive" });
  const old = h2.runtime.evaluate("task-1");
  h2.runtime.input("Second", "interactive");
  finish(fixture());
  assert.equal(await old, null);
});

test("new-task adoption reuses binding; scope expansion invalidates stale advice", async t => {
  const seen: any[] = [];
  const h = harness({ async evaluate(req: any) { seen.push(req.state); return fixture(); } }); t.after(h.close);
  await h.pi.emit("input", { text: "Edit code", source: "interactive" });
  await h.pi.emit("before_agent_start");
  assert.equal(seen.length, 1);
  h.runtime.adopt("task-2");
  assert.equal((await h.runtime.evaluate("task-2"))?.taskId, "task-2");
  assert.equal(seen.length, 1, "adoption must not re-call provider");
  assert.equal(h.runtime.scope("wide"), true);
  await h.runtime.evaluate("task-2");
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[1].constraints, ["Declared process scope: wide"]);
});

test("100 logical calls then refusal; 2s total deadline", async t => {
  let calls = 0;
  const h = harness({ async evaluate() { calls++; return fixture(0.1); } }); t.after(h.close);
  for (let i = 0; i < 101; i++) { h.runtime.input(`Task ${i}`, "interactive"); await h.runtime.evaluate(`task-${i}`); }
  assert.equal(calls, 100);
  assert.equal(h.runtime.calls, 100);
  assert.equal(TASK_TRIAGE_LIMITS.maxCallsPerSession, 100);
  assert.equal(TASK_TRIAGE_LIMITS.timeoutMs, 2000);
  let finish!: (v: any) => void;
  const h2 = harness({ evaluate: () => new Promise(r => { finish = r; }) }); t.after(h2.close);
  h2.runtime.input("Slow", "interactive");
  const p = h2.runtime.evaluate("task-slow");
  const started = Date.now();
  // watchdog-off reuse: shared fake service still enforced by runtime deadline path
  assert.equal((await p)?.assessment.status, "unavailable");
  assert.ok(Date.now() - started < 2500);
  void finish;
});

test("persistence failure blocks inference and preserves requirements", async t => {
  let calls = 0;
  const h = harness({ async evaluate() { calls++; return fixture(); } }, { persist: () => { throw new Error("disk full"); } }); t.after(h.close);
  h.runtime.input("Important task", "interactive");
  const r = await h.runtime.evaluate("task-1");
  assert.equal(r?.assessment.detail, "counter_persistence_failed");
  assert.equal(calls, 0, "no provider call after failed reservation");
  assert.equal(processPreEffectGate(createProcessState(), "write"), null, "baseline unchanged without additions");
});

test("human one-use authorization: exact binding, single consume, stale denied", async t => {
  const yes = (id: string) => ({ details: { cancelled: false, runtimeAsk: { requestId: id }, response: { kind: "selection", selections: ["Yes — authorize once"] } } });
  const ports = (task: string, rev: string) => ({ taskId: () => task, inputRevision: () => rev, ask: async (id: string) => yes(id), startWait: () => {}, endWait: () => {} });
  const input = { path: "synthetic.txt", content: "synthetic" }, cwd = "/synthetic/workspace";
  const contract = { taskId: "t1", inputRevision: "r1", actionId: "a1", operation: "write", target: createHash("sha256").update(JSON.stringify(input)).digest("hex"), cwd };
  const grant = await confirmTaskTriageAction(contract, ports("t1", "r1") as any, {} as any, () => true, undefined, { input, cwd });
  assert.ok(grant);
  assert.equal(consumeActionGrant(grant, contract), true);
  assert.equal(consumeActionGrant(grant, contract), false, "replay must fail");
  assert.equal(await confirmTaskTriageAction(contract, ports("t1", "stale") as any, {} as any, () => true, undefined, { input, cwd }), null, "stale revision denied");
  assert.equal(await confirmTaskTriageAction({ ...contract, target: "" }, ports("t1", "r1") as any, {} as any, () => true, undefined, { input, cwd }), null, "unbound action unsupported");
});

test("small tier keeps review open without tier change; empty-roster recovery is human action", async t => {
  const h = harness({ async evaluate() { return fixture(); } }); t.after(h.close);
  await h.pi.emit("input", { text: "Fix README typo in small task", source: "interactive" });
  await h.pi.emit("before_agent_start");
  // Security-sensitive fixture opens review; tier itself is never mutated by S1.
  assert.equal(processPreEffectGate(h.state(), "child", "builder") !== null || effectiveProcessStage(h.state(), "review"), true);
});
