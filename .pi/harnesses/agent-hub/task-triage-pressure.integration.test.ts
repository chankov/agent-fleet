import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContextPressureLifecycle, createContextPressureRootState } from "./lifecycle/context-pressure.ts";
import { createTaskTriageRuntime, restoreTaskTriageCounter, TASK_TRIAGE_RUNTIME_ENTRY } from "./task-triage-runtime.ts";
import { createWatchdogSystem1Session } from "./system1-runtime.ts";
import { applyTaskTriageAdditions } from "./task-triage-obligations.ts";
import { createProcessState, latestProcessState, processAuditRecord, evaluateProcessObligations } from "./process-obligations.ts";

// Exercise the same pressure/input/before-model/compaction ordering as the
// registered Hub hooks, with the real shared service and Jev adapter behind a
// local wire transport. The real-Pi suite separately exercises index.ts registration.
test("pressure queues two inputs, replays each into its own assessment and restores additions/cache/call count", async t => {
 const root = mkdtempSync(join(tmpdir(), "triage-pressure-")); t.after(() => rmSync(root, { recursive: true, force: true }));
 const journal: any[] = [];
 let transportCalls = 0;
 const session = createWatchdogSystem1Session({ configuredMode: "off", watchdogArmed: false, selected: true,
  config: { version: 2, consumers: {}, mode: "auto", provider: "typesafe", model: "jev-1.13.0", apiKeyEnv: "TYPESAFE_API_KEY" },
  env: { TYPESAFE_API_KEY: "synthetic-key" }, transport: async request => {
   transportCalls++;
   const outbound = JSON.parse(request.body.toString("utf8"));
   return { status: 200, headers: {}, body: JSON.stringify({ model: "jev-1.13.0", answers: Object.fromEntries(
    Object.keys(outbound.questions).map(id => [id, { type: "noul", noul: id === "security_change" ? .95 : .05 }])),
    usage: { input_tokens: 1, output_tokens: 1 } }) };
  } });
 t.after(() => session.dispose());
 assert.equal(session.effectiveMode, "off"); assert.equal(session.hubArmed, false);
 assert.ok(session.sharedService, "shared service is ready even with watchdog off/disarmed");
 const makeRuntime = (restored?: ReturnType<typeof restoreTaskTriageCounter>) => createTaskTriageRuntime({
  root, service: session.sharedService, restored, persist: data => journal.push({ customType: TASK_TRIAGE_RUNTIME_ENTRY, data }),
 });
 let runtime = makeRuntime();
 let state = createProcessState();
 let taskId = "task-1";
 let tokens = 95;
 const replayed: string[] = []; 
 const pressureState = createContextPressureRootState();
 const ctx: any = { hasUI: true, model: { contextWindow: 100 }, getContextUsage: () => ({ tokens, contextWindow: 100, percent: tokens }),
  isIdle: () => false, ui: { notify() {}, setStatus() {} }, compact() {} };
 const handlers: Record<string, Array<(event?: any) => any>> = {};
 const pi = { on(name: string, callback: (event?: any) => any) { (handlers[name] ??= []).push(callback); } };
 const emit = async (name: string, event?: any) => { for (const callback of handlers[name] ?? []) await callback(event); };
 const pressure = createContextPressureLifecycle({ getState: () => pressureState, setPressure: value => { pressureState.pressure = value; },
  getCurrentContext: () => ctx, appendEntry: () => {}, resolveCapabilities: () => {}, applyWorkMode: () => {}, modelWorkBlocked: () => false,
  onAcceptedInput: (text, source, replayed) => { if (source !== "extension" || replayed) runtime.input(text, "interactive"); },
  sendUserMessage: text => { replayed.push(String(text)); },
 });
 pi.on("input", event => pressure.input(event, ctx));
 pi.on("before_agent_start", async () => {
  const bound = await runtime.evaluate(taskId);
  if (bound) {
   state = applyTaskTriageAdditions(state, bound.assessment, { taskId: bound.taskId, evaluationId: bound.evaluationId, inputRevision: bound.revision });
   journal.push({ customType: "agent-hub-process-state", data: processAuditRecord(state, evaluateProcessObligations(state, { writable: true, budgetTier: "small" })) });
  }
 });
 pi.on("session_compact", () => pressure.sessionCompact());
 await emit("input", { source: "interactive", text: "First security change" });
 await emit("input", { source: "interactive", text: "Second security change" });
 assert.equal(pressureState.deferredInputs.length, 2);
 assert.equal(runtime.calls, 0, "deferred input is not assessed as the previous turn");
 await emit("session_compact");
 tokens = 1;
 pressure.replayDeferred();
 assert.deepEqual(replayed, ["First security change", "Second security change"]);
 await emit("input", { source: "extension", text: "automated feedback" });
 assert.equal(pressureState.deferredReplayAllowance, 2, "unrelated extension feedback cannot consume a replay slot");
 // The replayed first input is a separate model turn, not overwritten by the
 // second deferred input; duplicate hooks cannot reserve another call.
 await emit("input", { source: "extension", text: "First security change" });
 await emit("before_agent_start"); await emit("before_agent_start");
 assert.equal(runtime.calls, 1); assert.equal(transportCalls, 1);
 const first = runtime.current;
 assert.ok(first); assert.equal(first.assessment.status, "applied");
 assert.equal(state.additions?.length, 1);
 await emit("input", { source: "extension", text: "Second security change" });
 await emit("before_agent_start");
 assert.equal(runtime.calls, 2); assert.equal(transportCalls, 2);
 assert.equal(state.additions?.length, 2, "the later addition did not erase the earlier one");
 assert.equal(evaluateProcessObligations(state, { writable: true, budgetTier: "small" }).obligations.review.status, "open", "both active security additions require review without changing baseline stage provenance");
 const restored = restoreTaskTriageCounter(journal);
 assert.equal(restored?.calls, 2);
 state = latestProcessState(journal);
 runtime.dispose(); runtime = makeRuntime(restored);
 runtime.input("Second security change", "interactive");
 await emit("before_agent_start");
 assert.equal(runtime.calls, 2); assert.equal(transportCalls, 2, "resume reuses the durable assessment");
 assert.equal(state.additions?.length, 2, "resume and duplicate hook preserve source identity exactly once");
 taskId = "task-2";
 runtime.adopt(taskId);
 assert.equal(runtime.calls, 2, "task transition cannot reset the session cap");
});
