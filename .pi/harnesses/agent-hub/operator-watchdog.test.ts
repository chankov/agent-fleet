import assert from "node:assert/strict";
import test from "node:test";
import { registerOperatorWatchdog } from "./operator-watchdog.ts";

const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture(judge: (input: any) => Promise<unknown>, setting = "auto") {
 const handlers = new Map<string, Function[]>(); const records: any[] = []; let aborts = 0; let taskId = "task";
 const pi = { on(name: string, fn: Function) { handlers.set(name, [...handlers.get(name) ?? [], fn]); }, appendEntry(type: string, data: unknown) { records.push({ type, data }); } };
 const ctx = { abort() { aborts++; }, ui: { notify() {} } };
 const watchdog = registerOperatorWatchdog(pi as any, { setting: () => setting, taskId: () => taskId, runDriftJudge: judge });
 const emit = async (name: string, event: any = {}) => { for (const fn of handlers.get(name) ?? []) await fn(event, ctx); };
 const start = async () => { await emit("before_agent_start", { prompt: "Implement the approved plan" }); await emit("agent_start"); };
 const call = async (args: any, isError = false) => { await emit("tool_execution_start", { toolName: "bash", toolCallId: String(args.command), args }); await emit("tool_execution_end", { toolName: "bash", toolCallId: String(args.command), isError }); };
 return { emit, start, call, records, watchdog, setTaskId: (value: string) => { taskId = value; }, get aborts() { return aborts; } };
}

test("operator watchdog observes direct tools and stops a judged loop without a continuation prompt", async () => {
 let calls = 0; const f = fixture(async input => { calls++; assert.equal(input.task, "Implement the approved plan"); return { verdict: "stuck", reason: "repeating without progress" }; });
 await f.start(); for (let i=0; i<4; i++) await f.call({ command: "same command" }); await flush();
 assert.equal(calls, 1); assert.equal(f.aborts, 1);
 await f.emit("agent_end"); assert.equal(f.records.at(-1).data.abortRequested, true);
 assert.equal(f.records.at(-1).data.attributions[0].outcome, "drift_stop");
 f.watchdog.dispose();
});

test("productive operator volume never triggers a call quota", async () => {
 let calls=0; const f=fixture(async () => { calls++; return { verdict: "stuck" }; });
 await f.start(); for (let i=0;i<250;i++) await f.call({ command: `work ${i}` }); await flush();
 assert.equal(calls,0); assert.equal(f.aborts,0); f.watchdog.dispose();
});

test("on-track and unavailable judges cannot abort; failures are supervised", async () => {
 for (const outcome of [{ verdict: "on_track" }, { status: "unavailable" }]) {
  let calls=0; const f=fixture(async () => { calls++; return outcome; });
  await f.start(); for(let i=0;i<5;i++) await f.call({ command:`failed ${i}` },true); await flush();
  assert.equal(calls,1); assert.equal(f.aborts,0); f.watchdog.dispose();
 }
});

test("late judge completion cannot cancel a later turn or session", async () => {
 for (const boundary of ["agent_end", "session_start", "session_before_switch", "session_shutdown", "input"]) {
  let resolve!: (value: unknown) => void; const f=fixture(() => new Promise(r => { resolve=r; }));
  await f.start(); for(let i=0;i<4;i++) await f.call({ command:"same" });
  await f.emit(boundary, { source: "interactive", text: "changed request" }); await f.start(); resolve({ verdict:"stuck",reason:"stale" }); await flush();
  assert.equal(f.aborts,0,boundary); f.watchdog.dispose();
 }
});

test("watchdog off is respected without affecting direct work", async () => {
 let calls=0; const f=fixture(async () => { calls++; return { verdict:"stuck" }; },"off");
 await f.start(); for(let i=0;i<5;i++) await f.call({ command:"same" },true); await flush();
 assert.equal(calls,0); assert.equal(f.aborts,0); f.watchdog.dispose();
});


test("a task adopted in the same operator turn gets a new fence and supervision", async () => {
 let oldJudge!: (result: unknown) => void; let calls=0;
 const f=fixture(async () => ++calls===1 ? new Promise(resolve => { oldJudge=resolve; }) : { verdict:"stuck",reason:"new task loop" });
 await f.start(); for(let i=0;i<4;i++) await f.call({ command:"old" });
 f.setTaskId("new-task");
 for(let i=0;i<4;i++) await f.call({ command:"new" });
 await flush(); assert.equal(f.aborts,1,"new task is supervised without waiting for another user turn");
 oldJudge({ verdict:"stuck",reason:"stale old task" }); await flush();
 assert.equal(f.aborts,1,"retired task cannot issue a second cancellation"); f.watchdog.dispose();
});

test("a pending judge cannot stop new productive work or an active human decision", async () => {
 for (const next of ["progress", "ask_user"]) {
  let resolve!: (result: unknown) => void;
  const f=fixture(() => new Promise(r => { resolve=r; }));
  await f.start(); for(let i=0;i<4;i++) await f.call({ command:"repeat" });
  if(next==="progress") await f.call({ command:"new successful work" });
  else await f.emit("tool_execution_start", { toolName:"ask_user",toolCallId:"decision",args:{question:"Choose the required behavior"} });
  resolve({ verdict:"stuck",reason:"old loop" }); await flush(); assert.equal(f.aborts,0,next); f.watchdog.dispose();
 }
});
