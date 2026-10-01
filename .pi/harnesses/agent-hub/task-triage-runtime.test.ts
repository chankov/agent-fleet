import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTaskTriageRuntime, restoreTaskTriageCounter, evaluatedTaskTriageInputChanged } from "./task-triage-runtime.ts";
import { createWatchdogSystem1Session } from "./system1-runtime.ts";
import { TASK_TRIAGE_QUESTIONS, TASK_TRIAGE_QUESTION_VERSION } from "./task-triage-contract.ts";
import { createTaskTriageActivity } from "./system1-activity.ts";

test("runtime observer records durable logical calls and real attempts but not cache calls or private task text", async t => {
 const root = mkdtempSync(join(tmpdir(), "triage-observed-")); t.after(() => rmSync(root, { recursive: true, force: true }));
 const activity = createTaskTriageActivity(), entries: unknown[] = [];
 const runtime = createTaskTriageRuntime({ root, observer: activity, persist: value => entries.push(value),
  service: { async evaluate() { const result = fixture(); result.evaluation.metadata.attempts = 2; return result; } } } as any);
 const task = "11111111-1111-4111-8111-111111111111";
 runtime.input("PRIVATE_TASK change installer trust", "interactive");
 const first = await runtime.evaluate(task);
 const events = activity.live().events;
 assert.equal(events.length, 2); assert.equal(events[0].logicalCall, true); assert.equal(events[1].attempts, 2);
 assert.equal(events[1].evaluationId, first?.evaluationId); assert.equal(events[1].inputRevision, first?.revision);
 assert.equal(events[1].providerStatus, "ok"); assert.equal(runtime.calls, 1);
 assert.doesNotMatch(JSON.stringify(events), /PRIVATE_TASK/);
 await runtime.evaluate(task); assert.equal(activity.live().events.length, 2);
 runtime.invalidate(); await runtime.evaluate(task);
 assert.equal(activity.live().events.length, 4); assert.equal(activity.live().events[2].logicalCall, false);
 assert.equal(activity.live().events[3].attempts, null); assert.equal(runtime.calls, 1);
 runtime.dispose(); activity.dispose();
});
test("runtime observer distinguishes reservation refusal and input rejection from actual calls", async t => {
 const root = mkdtempSync(join(tmpdir(), "triage-observer-refused-")); t.after(() => rmSync(root, { recursive: true, force: true }));
 const activity = createTaskTriageActivity(); let physical = 0;
 const runtime = createTaskTriageRuntime({ root, observer: activity, persist() { throw Error("PRIVATE_DISK"); },
  service: { async evaluate() { physical++; return fixture(); } } } as any);
 const task = "11111111-1111-4111-8111-111111111111";
 runtime.input("Change installer", "interactive"); await runtime.evaluate(task);
 assert.equal(activity.live().events[1].reason, "counter_persistence_failed");
 assert.equal(activity.live().events[0].logicalCall, false); assert.equal(physical, 0);
 runtime.input("x".repeat(40961), "interactive"); await runtime.evaluate(task);
 assert.equal(activity.live().events[3].status, "oversized_input"); assert.equal(activity.live().events[2].logicalCall, false);
 assert.equal(runtime.calls, 0); runtime.dispose();
});
test("runtime observer cancellation closes once and observer exceptions cannot alter policy", async t => {
 const root = mkdtempSync(join(tmpdir(), "triage-observer-cancel-")); t.after(() => rmSync(root, { recursive: true, force: true }));
 const activity = createTaskTriageActivity(); let finish!: (v: any) => void;
 const runtime = createTaskTriageRuntime({ root, observer: activity, persist() {},
  service: { evaluate: () => new Promise(resolve => { finish = resolve; }) } } as any);
 runtime.input("Old installer change", "interactive"); const old = runtime.evaluate("11111111-1111-4111-8111-111111111111");
 runtime.input("New installer change", "interactive");
 assert.equal(activity.live().events[1].status, "cancelled");
 finish(fixture()); assert.equal(await old, null); assert.equal(activity.live().events.length, 2);
 const broken = createTaskTriageRuntime({ root, persist() {}, observer: { evaluationStarted() { throw Error("observer"); }, evaluationFinished() { throw Error("observer"); } },
  service: { async evaluate() { return fixture(); } } } as any);
 broken.input("Change installer", "interactive"); assert.equal((await broken.evaluate("task"))?.assessment.status, "applied");
 assert.equal(broken.calls, 1); runtime.dispose(); broken.dispose();
});

const fixture = (p = .9) => ({ status: "ok" as const, evaluation: { answers: TASK_TRIAGE_QUESTIONS.map(q => ({ questionId: q.id, type: "predicate" as const, probabilityTrue: q.id === "security_change" ? p : .1, uncertainty: { provenance: "provider" as const } })), metadata: { provider: "typesafe", requestedModel: "jev-1.13.0", returnedModel: "jev-1.13.0", questionSetVersion: TASK_TRIAGE_QUESTION_VERSION, latencyMs: 1, attempts: 1 } } });
function setup(service: any, restored?: any) {
 const root = mkdtempSync(join(tmpdir(), "triage-runtime-")); const entries: any[] = [];
 const runtime = createTaskTriageRuntime({ root, service, restored, persist: snapshot => entries.push({ customType: "agent-hub-task-triage-runtime/v1", data: snapshot }) });
 return { runtime, entries, close: () => rmSync(root, { recursive: true, force: true }) };
}
test("runtime observer receives immutable projected metadata and cannot mutate current policy", async t => {
 const root = mkdtempSync(join(tmpdir(), "triage-observer-mutation-")); t.after(() => rmSync(root, { recursive: true, force: true }));
 const runtime = createTaskTriageRuntime({ root, persist() {}, service: { async evaluate() { return fixture(); } }, observer: {
  evaluationStarted(identity) { identity.taskId = "PRIVATE_TASK"; },
  evaluationFinished(_identity, input) { input.assessment.status = "no_additions"; input.assessment.reasons.length = 0; },
 } } as any);
 runtime.input("Change installer", "interactive");
 const current = await runtime.evaluate("11111111-1111-4111-8111-111111111111");
 assert.equal(current?.assessment.status, "applied"); assert.deepEqual(current?.assessment.reasons, ["security_change"]);
 assert.equal(runtime.calls, 1); runtime.dispose();
});

test("runtime projects failed provider metadata before observer and tolerates refused trace writes", async t => {
 const root = mkdtempSync(join(tmpdir(), "triage-observer-metadata-")); t.after(() => rmSync(root, { recursive: true, force: true }));
 const seen: unknown[] = [];
 const runtime = createTaskTriageRuntime({ root, persist() {}, service: { async evaluate() {
  return { status: "unavailable", reason: "network", rawBody: "PRIVATE_PROVIDER_ERROR" } as any;
 } }, observer: { evaluationStarted() {}, evaluationFinished(_identity, input) { seen.push(input); } } });
 runtime.input("PRIVATE_TASK change installer", "interactive");
 assert.equal((await runtime.evaluate("11111111-1111-4111-8111-111111111111"))?.assessment.status, "unavailable");
 assert.doesNotMatch(JSON.stringify(seen), /PRIVATE_PROVIDER_ERROR|PRIVATE_TASK/);
 const activity = createTaskTriageActivity({ write() { throw Error("PRIVATE_DISK_ERROR"); } });
 const healthy = createTaskTriageRuntime({ root, persist() {}, observer: activity, service: { async evaluate() { return fixture(); } } });
 healthy.input("Change installer", "interactive");
 assert.equal((await healthy.evaluate("11111111-1111-4111-8111-111111111111"))?.assessment.status, "applied");
 assert.equal(activity.degraded, true); assert.equal(healthy.calls, 1);
 runtime.dispose(); healthy.dispose(); activity.dispose();
});

test("shared fake service, first input, duplicate hooks and new-task adoption without new call", async t => {
 let calls = 0; const x = setup({ async evaluate() { calls++; return fixture(); } }); t.after(x.close);
 x.runtime.input("Update installer trust boundary", "interactive");
 const first = await x.runtime.evaluate("task-1");
 assert.equal(first?.assessment.status, "applied"); assert.deepEqual(first?.assessment.reasons, ["security_change"]);
 x.runtime.input("Update installer trust boundary", "interactive");
 assert.equal(await x.runtime.evaluate("task-1"), first); assert.equal(calls, 1); assert.equal(x.runtime.calls, 1);
 assert.equal(x.runtime.adopt("task-2")?.taskId, "task-2");
 assert.equal((await x.runtime.evaluate("task-2"))?.assessment.status, "applied"); assert.equal(calls, 1);
 x.runtime.input("extension feedback", "extension"); assert.equal((await x.runtime.evaluate("task-2"))?.assessment.status, "applied");
 assert.deepEqual(restoreTaskTriageCounter(x.entries)?.calls, 1);
});
test("identical input reuses durably cached assessment across input revisions and resume", async t => {
 let calls = 0;
 const service = { async evaluate() { calls++; return fixture(); } };
 const x = setup(service); t.after(x.close);
 x.runtime.input("Change installer trust boundary", "interactive");
 const first = await x.runtime.evaluate("old-task");
 x.runtime.input("Other task", "interactive"); await x.runtime.evaluate("old-task");
 x.runtime.input("Change installer trust boundary", "interactive");
 const again = await x.runtime.evaluate("old-task");
 assert.deepEqual(again?.assessment, first?.assessment);
 assert.equal(calls, 2);
 const resumed = setup(service, restoreTaskTriageCounter(x.entries)); t.after(resumed.close);
 resumed.runtime.input("Change installer trust boundary", "interactive");
 assert.deepEqual((await resumed.runtime.evaluate("new-task"))?.assessment, first?.assessment);
 assert.equal(calls, 2);
});

test("identical input keeps byte identity while scoped variants have separate cache keys", async t => {
 let physical = 0; const x = setup({ async evaluate() { physical++; return fixture(); } }); t.after(x.close);
 x.runtime.input("Edit code", "interactive");
 const original = await x.runtime.evaluate("task-1");
 x.runtime.scope("wide"); await x.runtime.evaluate("task-1");
 x.runtime.scope("");
 assert.deepEqual((await x.runtime.evaluate("task-2"))?.assessment, original?.assessment);
 assert.equal(physical, 2, "returning to the exact input and scope reuses the original result");
 x.runtime.input("Edit code ", "interactive"); await x.runtime.evaluate("task-2");
 assert.equal(physical, 3, "trailing space is a distinct user input");
 x.runtime.input("Edit code", "interactive");
 assert.deepEqual((await x.runtime.evaluate("task-2"))?.assessment, original?.assessment);
 assert.equal(physical, 3); assert.equal(x.runtime.calls, 3);
});

test("session restore clears pending input, current binding and scoped context, but keeps durable cache", async t => {
 const seen: any[] = [];
 const x = setup({ async evaluate(request: any) { seen.push(request.state); return fixture(); } }); t.after(x.close);
 x.runtime.input("Edit code", "interactive"); await x.runtime.evaluate("old-task");
 x.runtime.scope("wide"); await x.runtime.evaluate("old-task");
 x.runtime.input("Unfinished prior-session input", "interactive");
 x.runtime.restore(x.entries);
 assert.equal(x.runtime.current, null);
 assert.equal(await x.runtime.evaluate("new-task"), null, "unpersisted pending input does not cross sessions");
 x.runtime.input("Edit code", "interactive");
 assert.equal((await x.runtime.evaluate("new-task"))?.assessment.status, "applied");
 assert.equal(x.runtime.calls, 2); assert.equal(seen.length, 2);
});

test("concurrent identical before-model hooks wait for the same result instead of seeing a reserved stale assessment", async t => {
 let complete!: (result: any) => void;
 let calls = 0;
 const x = setup({ evaluate: () => { calls++; return new Promise(resolve => { complete = resolve; }); } }); t.after(x.close);
 x.runtime.input("Review the installer trust boundary", "interactive");
 const first = x.runtime.evaluate("task");
 const second = x.runtime.evaluate("task");
 assert.equal(calls, 1); assert.equal(x.runtime.calls, 1);
 complete(fixture());
 assert.equal((await first)?.assessment.status, "applied");
 assert.equal((await second)?.assessment.status, "applied");
 assert.equal(x.runtime.current?.assessment.status, "applied");
});
test("session restore cancels a pending evaluation and retains only durable call accounting", async t => {
 let complete!: (result: any) => void;
 const x = setup({ evaluate: () => new Promise(resolve => { complete = resolve; }) }); t.after(x.close);
 x.runtime.input("First", "interactive");
 const old = x.runtime.evaluate("old-task");
 x.runtime.restore(x.entries);
 complete(fixture()); assert.equal(await old, null);
 assert.equal(x.runtime.current, null);
 assert.equal(x.runtime.calls, 1);
});

test("watchdog off/disarmed shares the service; active consumer reports unavailable service before and after input", async t => {
 const session = createWatchdogSystem1Session({ configuredMode: "off", watchdogArmed: false, selected: true,
  config: { version: 1, mode: "auto", provider: "typesafe", model: "jev-1.13.0", apiKeyEnv: "TYPESAFE_API_KEY" },
  env: {}, service: { async evaluate() { return fixture(); } } as any });
 t.after(() => session.dispose());
 assert.ok(session.sharedService, "watchdog mode/arming does not own shared-service activation");
 const active = setup(session.sharedService); t.after(active.close);
 active.runtime.input("Change installer trust boundary", "interactive");
 assert.deepEqual((await active.runtime.evaluate("task"))?.assessment.reasons, ["security_change"]);
 // The production composition passes watchdogSystem1.readiness.reason when its service is missing.
 const missing = createTaskTriageRuntime({ root: "", serviceUnavailableReason: "missing_key", persist: () => { throw Error("must not reserve"); } });
 assert.deepEqual(missing.status, { status: "unavailable", reasons: [], detail: "shared_service_missing_key" });
 missing.input("Change installer trust boundary", "interactive");
 assert.deepEqual((await missing.evaluate("task"))?.assessment, { status: "unavailable", reasons: [], detail: "shared_service_missing_key" });
 assert.equal(missing.calls, 0, "missing service never makes or reserves a call");
});
test("100 logical calls across task adoptions and restored ambiguous history fails closed", async t => {
 let calls = 0; const x = setup({ async evaluate() { calls++; return fixture(.1); } }); t.after(x.close);
 for (let i = 0; i < 101; i++) { x.runtime.input(`Task ${i}`, "interactive"); const result = await x.runtime.evaluate(`task-${i}`); assert.equal(result?.assessment.status, i === 100 ? "skipped" : "no_additions"); }
 assert.equal(calls, 100); assert.equal(x.runtime.calls, 100);
 const restored = setup({ async evaluate() { throw Error("unexpected call"); } }, restoreTaskTriageCounter([{ type: "message", message: { role: "user" } }])); t.after(restored.close);
 restored.runtime.input("A new request", "interactive"); assert.equal((await restored.runtime.evaluate("task"))?.assessment.detail, "counter_restore_ambiguous");
});
test("compaction/resume retains 99 reservations and allows exactly one final call after new-task adoption", async t => {
 let calls = 0;
 const service = { async evaluate() { calls++; return fixture(.1); } };
 const x = setup(service); t.after(x.close);
 for (let i = 0; i < 99; i++) {
  x.runtime.input(`Bounded task ${i}`, "interactive"); await x.runtime.evaluate(`task-${i}`);
 }
 const resumed = setup(service, restoreTaskTriageCounter(x.entries)); t.after(resumed.close);
 resumed.runtime.input("Final bounded task", "interactive");
 assert.equal((await resumed.runtime.evaluate("new-task"))?.assessment.status, "no_additions");
 resumed.runtime.adopt("adopted-task");
 resumed.runtime.input("Over cap", "interactive");
 assert.equal((await resumed.runtime.evaluate("adopted-task"))?.assessment.detail, "session_call_cap");
 assert.equal(calls, 100); assert.equal(resumed.runtime.calls, 100);
 assert.equal(restoreTaskTriageCounter(resumed.entries)?.calls, 100);
});
test("declared scope expansion changes the bounded request and cannot reuse stale assessment", async t => {
 const seen: any[] = []; const x = setup({ async evaluate(request: any) { seen.push(request.state); return fixture(); } }); t.after(x.close);
 x.runtime.input("Edit code", "interactive"); await x.runtime.evaluate("task");
 assert.equal(x.runtime.scope("wide"), true);
 assert.equal((await x.runtime.evaluate("task"))?.assessment.status, "applied");
 assert.equal(seen.length, 2); assert.deepEqual(seen[1].constraints, ["Declared process scope: wide"]);
 assert.equal(x.runtime.scope("wide"), false); await x.runtime.evaluate("task"); assert.equal(seen.length, 2);
});
test("only a different evaluated input fences a transition; unavailable service adds no fence", async t => {
 const x = setup({ async evaluate() { return fixture(.1); } }); t.after(x.close);
 x.runtime.input("First", "interactive");
 assert.equal(evaluatedTaskTriageInputChanged(x.runtime.current, "Second"), false);
 await x.runtime.evaluate("old-task");
 assert.equal(evaluatedTaskTriageInputChanged(x.runtime.current, "First"), false);
 assert.equal(evaluatedTaskTriageInputChanged(x.runtime.current, "Second"), true);
 const missing = createTaskTriageRuntime({ root: "", serviceUnavailableReason: "missing_key", persist: () => { throw Error("must not reserve"); } });
 missing.input("First", "interactive"); await missing.evaluate("old-task");
 assert.equal(evaluatedTaskTriageInputChanged(missing.current, "Second"), false);
 assert.equal(missing.calls, 0);
});

test("pending new-task binding evaluates latest input before adoption, not a cancelled older result", async t => {
 const completions: Array<(value: any) => void> = [];
 const x = setup({ evaluate: () => new Promise(resolve => completions.push(resolve)) }); t.after(x.close);
 x.runtime.input("First", "interactive");
 const old = x.runtime.evaluate("old-task");
 x.runtime.input("Second", "interactive");
 assert.equal(x.runtime.current, null);
 const binding = x.runtime.bindInput("new-task");
 assert.equal(completions.length, 2);
 completions[0](fixture());
 assert.equal(await old, null);
 assert.equal(x.runtime.current, null, "old result never binds to new task");
 completions[1](fixture());
 const latest = await binding;
 assert.equal(latest?.taskId, "new-task");
 assert.equal(latest?.assessment.status, "applied");
 assert.equal(x.runtime.calls, 2, "no extra inference on adoption");
 assert.equal(x.runtime.adopt("new-task")?.revision, latest?.revision);
 assert.deepEqual(await x.runtime.bindInput("new-task"), latest, "evaluated input is reused");
 assert.equal(x.runtime.calls, 2);
});

test("a newer input during pending binding leaves it unbound and refuses the transition", async t => {
 let complete!: (value: any) => void;
 const x = setup({ evaluate: () => new Promise(resolve => { complete = resolve; }) }); t.after(x.close);
 x.runtime.input("First", "interactive");
 const binding = x.runtime.bindInput("new-task");
 x.runtime.input("Second", "interactive");
 complete(fixture());
 assert.equal(await binding, null);
 assert.equal(x.runtime.current, null);
 assert.equal(x.runtime.adopt("new-task"), null);
});

test("hard 2s deadline, late callback fenced and cancellation on new user input", async t => {
 let finish!: (value: any) => void;
 const x = setup({ evaluate: () => new Promise(resolve => { finish = resolve; }) }); t.after(x.close);
 x.runtime.input("Original task", "interactive"); const old = x.runtime.evaluate("task-old");
 x.runtime.input("New task", "interactive"); finish(fixture());
 assert.equal(await old, null); assert.equal(x.runtime.current, null);
 const next = x.runtime.evaluate("task-new");
 const started = Date.now(); assert.equal((await next)?.assessment.status, "unavailable");
 assert.ok(Date.now() - started < 2500); assert.equal(x.runtime.calls, 2);
});
