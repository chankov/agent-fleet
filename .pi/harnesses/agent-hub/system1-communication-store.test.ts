import assert from "node:assert/strict";
import test from "node:test";
import { createCommunicationStore, redactCommunication } from "./system1-communication-store.ts";
import { createWatchdogSystem1Session } from "./system1-runtime.ts";
import type { EvaluateRequest, System1Result } from "../lib/system1/contracts.ts";
import { TASK_TRIAGE_QUESTIONS, TASK_TRIAGE_QUESTION_VERSION, TASK_TRIAGE_STATE_VERSION } from "./task-triage-contract.ts";
import { createTaskTriageRuntime } from "./task-triage-runtime.ts";
const request:EvaluateRequest={state:{task:"password=SENTINEL api_key=HIDDEN /home/person/private",apiKey:"KEYSECRET"},questions:[{id:"p",type:"predicate",instructions:"Check"}],questionSetVersion:"dispatch-triage/v1"};
const service={async evaluate():Promise<System1Result>{return {status:"skipped",reason:"disabled"};}};
test("capture off is passive; enable captures sanitized immutable request/result only",async()=>{
 const store=createCommunicationStore(),wrapped=store.wrap(service,{provider:"fake",model:"fake"});await wrapped.evaluate(request);assert.equal(store.snapshot().length,0);
 store.setEnabled(true);await wrapped.evaluate(request);const p=store.snapshot()[0];assert.equal(p.status,"skipped");assert.ok(p.ended);assert.ok(p.response);
 for(const secret of ["SENTINEL","HIDDEN","KEYSECRET","/home/person"])assert.ok(!JSON.stringify(p).includes(secret));
 p.request="modified";assert.notEqual(store.snapshot()[0].request,"modified");
 store.setEnabled(false);assert.equal(store.snapshot().length,0);
});
test("late completion cannot populate a replaced session",async()=>{
 let finish!:(r:System1Result)=>void;const store=createCommunicationStore();store.setEnabled(true);
 const wrapped=store.wrap({evaluate:()=>new Promise(r=>{finish=r;})},{provider:"fake",model:"fake"});const pending=wrapped.evaluate(request);assert.equal(store.snapshot()[0].status,"pending");
 store.dispose();store.setEnabled(true);finish({status:"cancelled"});await pending;assert.equal(store.snapshot().length,0);
});
test("bounded pair eviction and unknown consumers withhold payload",async()=>{
 const store=createCommunicationStore({pairs:1,bytes:4096,payloadBytes:1024});store.setEnabled(true);const wrapped=store.wrap(service,{provider:"other",model:"other"});await wrapped.evaluate(request);await wrapped.evaluate({...request,questionSetVersion:"unknown"});assert.equal(store.snapshot().length,1);assert.equal(store.evicted,1);assert.equal(store.snapshot()[0].request,null);assert.equal(store.snapshot()[0].response,null);
});
test("observer exceptions do not change results and common service is wrapped once",async()=>{
 const store=createCommunicationStore();store.setEnabled(true);store.subscribe(()=>{throw Error("observer");});
 const session=createWatchdogSystem1Session({configuredMode:"off",watchdogArmed:false,selected:true,config:{model:"fake"},service,wrapService:s=>store.wrap(s,{provider:"fake",model:"fake"})});
 assert.deepEqual(await session.sharedService!.evaluate({...request,questionSetVersion:"proactive-assessment/v1"}),{status:"skipped",reason:"disabled"});assert.equal(store.snapshot().length,1);assert.equal(store.snapshot()[0].consumer,"proactive");session.dispose();
});
test("redaction covers nested credential keys, auth text and terminal controls",()=>{
 const text=JSON.stringify(redactCommunication({nested:{Authorization:"Bearer XYZ",password:"SECRET"},text:"Bearer ABC sk-SENTINEL\u001b[31m"}));for(const key of ["XYZ","SECRET","ABC","SENTINEL","\\u001b"])assert.ok(!text.includes(key));
});

const taskRequest: EvaluateRequest = {
 state: { schema: TASK_TRIAGE_STATE_VERSION, task: "Промени installer trust boundary", clarifications: ["Only the installer"],
  paths: [{ path: "bin/cli.js", kind: "file", body: "PRIVATE_FILE_BODY" }], constraints: ["No deployment"], gaps: [],
  transcript: "PRIVATE_TRANSCRIPT", owner: "UNTRUSTED_OWNER" },
 questions: TASK_TRIAGE_QUESTIONS, questionSetVersion: TASK_TRIAGE_QUESTION_VERSION, timeoutMs: 2000,
};
function taskResult(): System1Result {
 return { status: "ok", evaluation: { answers: TASK_TRIAGE_QUESTIONS.map(q => ({ questionId: q.id, type: "predicate",
  probabilityTrue: q.id === "security_change" ? 0.9 : 0.1, uncertainty: { provenance: "provider" } })),
  metadata: { provider: "typesafe", requestedModel: "jev-1.13.0", returnedModel: "jev-1.13.0",
   questionSetVersion: TASK_TRIAGE_QUESTION_VERSION, latencyMs: 12, attempts: 2 } } };
}
test("task-triage capture projects its schema and nested metadata without provider extras", async () => {
 const store = createCommunicationStore();
 const result = taskResult();
 Object.assign(result, { rawBody: "PRIVATE_PROVIDER_BODY" });
 if (result.status === "ok") {
  Object.assign(result.evaluation.metadata, { rawError: "PRIVATE_ERROR" });
  Object.assign(result.evaluation.metadata, { usage: { inputTokens: 4, outputTokens: 2, raw: "PRIVATE_USAGE" } });
  Object.assign(result.evaluation.answers[0], { explanation: "PRIVATE_EXPLANATION" });
  Object.assign(result.evaluation.answers[0].uncertainty, { distribution: { PRIVATE_LABEL: 1 } });
 }
 const wrapped = store.wrap({ async evaluate() { return result; } }, { provider: "typesafe", model: "jev-1.13.0" });
 await wrapped.evaluate(taskRequest);
 assert.deepEqual(store.snapshot(), [], "task triage does not enable capture implicitly");
 store.setEnabled(true);
 assert.equal(await wrapped.evaluate(taskRequest), result, "capture cannot change the provider return");
 const pair = store.snapshot()[0];
 assert.equal(pair.consumer, "task-triage");
 assert.equal(pair.owner, "hub");
 assert.deepEqual(JSON.parse(pair.request!).state, { schema: TASK_TRIAGE_STATE_VERSION, task: "Промени installer trust boundary",
  clarifications: ["Only the installer"], paths: [{ path: "bin/cli.js", kind: "file" }], constraints: ["No deployment"], gaps: [] });
 const response = JSON.parse(pair.response!);
 assert.equal(response.evaluation.answers.find((a: any) => a.questionId === "security_change").probabilityTrue, 0.9);
 assert.equal(response.evaluation.metadata.attempts, 2);
 assert.deepEqual(response.evaluation.metadata.usage, { inputTokens: 4, outputTokens: 2 });
 for (const secret of ["PRIVATE_", "UNTRUSTED_OWNER"]) assert.ok(!JSON.stringify(pair).includes(secret));
 store.setEnabled(false);
 assert.deepEqual(store.snapshot(), []);
});
test("task-triage unknown schema and malformed nested fields are withheld", async () => {
 const store = createCommunicationStore(); store.setEnabled(true);
 const wrapped = store.wrap(service, { provider: "typesafe", model: "jev-1.13.0" });
 for (const state of [ { ...(taskRequest.state as object), schema: "task-triage/state/v2" },
  { ...(taskRequest.state as object), clarifications: [{ body: "PRIVATE_CLARIFICATION" }] },
  { ...(taskRequest.state as object), paths: [{ path: "bin/cli.js", kind: "unknown", body: "PRIVATE_PATH" }] } ]) {
  await wrapped.evaluate({ ...taskRequest, state });
  const pair = store.snapshot().at(-1)!;
  assert.equal(pair.consumer, "task-triage");
  assert.equal(pair.request, null);
  assert.match(pair.requestOmitted!, /withheld/);
  assert.ok(!JSON.stringify(pair).includes("PRIVATE_"));
 }
});
test("valid task input above the viewer cap stays withheld rather than truncated", async () => {
 const store = createCommunicationStore(); store.setEnabled(true);
 const wrapped = store.wrap({ async evaluate() { return taskResult(); } }, { provider: "typesafe", model: "jev-1.13.0" });
 await wrapped.evaluate({ ...taskRequest, state: { ...(taskRequest.state as object), task: "x".repeat(33 * 1024) } });
 const pair = store.snapshot()[0];
 assert.equal(pair.consumer, "task-triage");
 assert.equal(pair.request, null);
 assert.match(pair.requestOmitted!, /too large/);
 assert.ok(pair.response, "small result is independent of the withheld request");
});
test("task-triage altered question contract is withheld rather than replaced with invented capture", async () => {
 const store = createCommunicationStore(); store.setEnabled(true);
 const wrapped = store.wrap(service, { provider: "typesafe", model: "jev-1.13.0" });
 const questions = TASK_TRIAGE_QUESTIONS.map((q, i) => i === 0 ? { ...q, instructions: "PRIVATE_UNREVIEWED_INSTRUCTIONS" } : q);
 await wrapped.evaluate({ ...taskRequest, questions });
 assert.equal(store.snapshot()[0].request, null);
 assert.ok(!JSON.stringify(store.snapshot()).includes("PRIVATE_UNREVIEWED_INSTRUCTIONS"));
});
test("task-triage capture keeps unknown usage distinct from zero and clears in-flight data", async () => {
 const store = createCommunicationStore(); store.setEnabled(true);
 let finish!: (result: System1Result) => void;
 const wrapped = store.wrap({ evaluate: () => new Promise<System1Result>(resolve => { finish = resolve; }) },
  { provider: "typesafe", model: "jev-1.13.0" });
 const pending = wrapped.evaluate(taskRequest);
 assert.equal(store.snapshot()[0].status, "pending");
 store.setEnabled(false); store.setEnabled(true);
 finish(taskResult()); await pending;
 assert.deepEqual(store.snapshot(), [], "completion from the cleared generation cannot reappear");
 await store.wrap({ async evaluate() { return taskResult(); } }, { provider: "typesafe", model: "jev-1.13.0" }).evaluate(taskRequest);
 assert.equal(JSON.parse(store.snapshot()[0].response!).evaluation.metadata.usage, null);
});

test("task-triage observer failure leaves real policy assessment and call budget unchanged", async () => {
 const store = createCommunicationStore(); store.setEnabled(true);
 store.subscribe(() => { throw new Error("observer render refused"); });
 const runtime = createTaskTriageRuntime({ root: process.cwd(), persist() {},
  service: store.wrap({ async evaluate() { return taskResult(); } }, { provider: "typesafe", model: "jev-1.13.0" }) });
 runtime.input("Change the installer trust boundary", "interactive");
 const evaluated = await runtime.evaluate("synthetic-task");
 assert.equal(evaluated?.assessment.status, "applied");
 assert.deepEqual(evaluated?.assessment.reasons, ["security_change"]);
 assert.equal(runtime.calls, 1);
 assert.equal(store.snapshot()[0].consumer, "task-triage");
 runtime.dispose();
});
