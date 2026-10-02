import assert from "node:assert/strict";
import test from "node:test";
import { TRIAGE_VERSION, TRIAGE_LEVELS, parseTriageConfig, triageQuestions, type TriageConfig, type TriageInput, type TriageProfile } from "./dispatch-triage-contract.ts";
import { buildTriageState } from "./dispatch-triage-state.ts";
import { triageAdvice } from "./dispatch-triage-policy.ts";
import { createTriageRuntime } from "./dispatch-triage-runtime.ts";
import { evaluateCorpus, validateCorpus, type TriageExample } from "./dispatch-triage-eval.ts";
import type { System1Result } from "../lib/system1/contracts.ts";
// Test-only thresholds and budgets, not shipped calibration or production defaults.
const profile:TriageProfile={version:TRIAGE_VERSION,approved:true,evidence:"synthetic test only",provider:"fake",model:"fake",languages:["en"],domains:["test"],minConfidence:.8,minMargin:.2,securityThreshold:.7,destructiveThreshold:.7};
const config:TriageConfig={version:1,mode:"advisory",remoteContextApproved:true,maxCalls:2,maxStateBytes:10000,maxTaskBytes:1000,maxRoleBytes:1000,profile};
const input:TriageInput={taskId:"t",task:"Review login",scope:["src"],language:"en",domain:"test",candidates:[{name:"reviewer",description:"Review code"}],constraints:"",complete:true};
function result(persona="reviewer"):System1Result {return {status:"ok",evaluation:{answers:[{questionId:"persona",type:"choice",value:persona,uncertainty:{provenance:"provider",confidence:.95,distribution:{reviewer:persona==="none"?.05:.95,none:persona==="none"?.95:.05}}},{questionId:"complexity",type:"ordinal",value:2,levels:TRIAGE_LEVELS,uncertainty:{provenance:"provider"}},{questionId:"touches_security",type:"predicate",probabilityTrue:.9,uncertainty:{provenance:"provider"}},{questionId:"is_destructive",type:"predicate",probabilityTrue:.1,uncertainty:{provenance:"provider"}}],metadata:{provider:"fake",requestedModel:"fake",returnedModel:"fake",questionSetVersion:TRIAGE_VERSION,latencyMs:3,attempts:1}}};}
test("state rejects empty, reserved, duplicate and oversized candidates without truncating",()=>{
 assert.equal(buildTriageState({...input,candidates:[]},config).ok,false);
 for(const candidates of [[{name:"none",description:"x"}],[...input.candidates,...input.candidates]])assert.equal(buildTriageState({...input,candidates},config).ok,false);
 assert.equal(buildTriageState(input,{...config,maxTaskBytes:1}).ok,false);
 assert.equal(buildTriageState(input,config).ok,true);
 assert.equal(triageQuestions(input.candidates).length,4);
});
test("profile is mandatory; additive warnings independent of none",()=>{
 assert.equal(triageAdvice(result(),input).status,"uncalibrated");
 assert.equal(triageAdvice(result(),input,{...profile,model:"other"}).status,"uncalibrated");
 const advice=triageAdvice(result(),input,profile);assert.equal(advice.persona,"reviewer");assert.deepEqual(advice.warnings,["consider_security_review","consider_decomposition"]);
 assert.equal(triageAdvice(result("none"),input,profile).status,"abstain");assert.equal(triageAdvice(result("none"),input,profile).warnings.length,2);
 assert.equal(triageAdvice(result(),input,{...profile,minMargin:1}).status,"needs_judgment");
 assert.equal(parseTriageConfig({...config,maxCalls:0}),null);
});
test("malformed distributions and answers never become advice",()=>{
 const r=result();if(r.status!=="ok")throw Error();r.evaluation.answers.push(r.evaluation.answers[0]);assert.equal(triageAdvice(r,input,profile).status,"insufficient_evidence");
 const q=result();if(q.status!=="ok")throw Error();q.evaluation.answers[0].uncertainty.distribution={reviewer:1,none:1};assert.equal(triageAdvice(q,input,profile).status,"insufficient_evidence");
});
test("off and no candidates call nothing; enabled budget is separate and bounded",async()=>{
 let calls=0;const service={async evaluate(){calls++;return result();}};
 const off=createTriageRuntime({config:{...config,mode:"off"},service,current:i=>i});await off.evaluate(input);assert.equal(calls,0);
 const runtime=createTriageRuntime({config,service,current:i=>i});await runtime.evaluate({...input,candidates:[]});assert.equal(calls,0);
 await runtime.evaluate(input);await runtime.evaluate(input);assert.equal((await runtime.evaluate(input)).reason,"session_call_budget");assert.equal(calls,2);
});
test("stale, cancellation and shadow cannot leak actionable advice",async()=>{
 const stale=createTriageRuntime({config,service:{async evaluate(){return result();}},current:i=>({...i,taskId:"new"})});assert.equal((await stale.evaluate(input)).status,"stale");
 const shadow=createTriageRuntime({config:{...config,mode:"shadow"},service:{async evaluate(){return result();}},current:i=>i});assert.deepEqual(Object.keys(await shadow.evaluate(input)).sort(),["id","reason","status"]);
 const controller=new AbortController();controller.abort();assert.equal((await shadow.evaluate(input,controller.signal)).status,"cancelled");shadow.dispose();assert.equal((await shadow.evaluate(input)).reason,"disposed");
});
test("offline evaluator separates provenance and failures, refuses split leakage and live without consent",async()=>{
 const e:TriageExample={id:"one",group:"g",split:"calibration",origin:"synthetic",labelRevision:"fixture-v1",rationale:"test only",remoteApproved:false,input,labels:{personas:["reviewer"],touches_security:true,is_destructive:false,decomposition:true},replay:result()};
 const corpus=validateCorpus([e]);const report=await evaluateCorpus(corpus,config);assert.equal(report.correct,1);assert.equal(report.calls,0);assert.equal(report.calibrationAccepted,false);assert.equal(report.cost,null);
 assert.throws(()=>validateCorpus([e,{...e,id:"two",split:"held-out"}]));
 await assert.rejects(()=>evaluateCorpus(corpus,config,{service:{async evaluate(){throw Error("must not call");}},maxCalls:1,maxMs:1000}));
 assert.equal((await evaluateCorpus([{...e,replay:undefined}],config)).unknown,1);
});

test("policy boundary independently rejects case-variant candidates",()=>{
 assert.equal(triageAdvice(result(),{...input,candidates:[...input.candidates,{name:"Reviewer",description:"duplicate"}]},profile).status,"insufficient_evidence");
});
test("sensitive context is refused before remote inference",async()=>{
 const runtime=createTriageRuntime({config,service:{async evaluate(){throw Error("must not call");}},current:i=>i});
 assert.equal((await runtime.evaluate({...input,task:"password=SENTINEL"})).reason,"sensitive_context_withheld");assert.equal(runtime.calls,0);
});
test("ordinary nested repository paths remain usable while absolute paths are withheld",()=>{
 const relativeScope=".pi/harnesses/agent-hub/task-triage-runtime.ts";
 const relative=buildTriageState({...input,scope:[relativeScope]},config);
 assert.equal(relative.ok,true);
 if(relative.ok)assert.deepEqual(relative.state.scope,[relativeScope]);
 const absolute=buildTriageState({
  ...input,
  task:"Review /home/nick/agent-fleet/.pi/harnesses/agent-hub/task-triage-runtime.ts",
  scope:[relativeScope,"/home/nick/agent-fleet/src/index.ts"],
  candidates:[{name:"reviewer",description:"Review /Users/nick/agent-fleet/docs/README.md"}],
 },config);
 assert.equal(absolute.ok,true);
 if(absolute.ok){
  assert.doesNotMatch(JSON.stringify(absolute.state),/\/(?:home|Users)\/nick\/agent-fleet/);
  assert.equal(absolute.state.scope[0],relativeScope);
  assert.equal(absolute.state.scope[1],"[PATH]");
  assert.match(absolute.candidates[0].description,/\[PATH\]/);
 }
 const windows=buildTriageState({...input,task:"Review C:\\Users\\nick\\agent-fleet\\src\\index.ts"},config);
 assert.equal(windows.ok,true);
 if(windows.ok)assert.doesNotMatch(windows.state.task,/C:\\Users\\nick/);
});
test("runtime sends relative paths but not absolute paths to the triage service",async()=>{
 const requests:any[]=[];
 const runtime=createTriageRuntime({config,service:{async evaluate(request:any){requests.push(request);return result();}},current:i=>i});
 const relativeScope=".pi/harnesses/agent-hub/task-triage-runtime.ts";
 const outcome=await runtime.evaluate({
  ...input,
  task:"Review /home/nick/agent-fleet/src/index.ts",
  scope:[relativeScope],
  candidates:[{name:"reviewer",description:"Review /home/nick/agent-fleet/docs/README.md"}],
 });
 assert.equal(outcome.status,"suggest_persona");
 assert.equal(runtime.calls,1);
 assert.equal(requests.length,1);
 assert.equal(requests[0].state.scope[0],relativeScope);
 assert.doesNotMatch(JSON.stringify(requests[0]),/\/home\/nick\/agent-fleet/);
});
test("explicit disposition correlates only current evaluations and never authorizes dispatch",async()=>{
 const events:any[]=[];let current=input;const runtime=createTriageRuntime({config,service:{async evaluate(){return result();}},current:()=>current,trace:e=>events.push(e)});
 const r=await runtime.evaluate(input);assert.ok("id" in r);const id=(r as any).id;
 assert.equal(runtime.disposition(id,"reviewer","used"),true);runtime.submitted(id,"reviewer","submitted");assert.equal(events.at(-1).event,"dispatch_observed");
 current={...input,taskId:"new"};assert.equal(runtime.disposition(id,"reviewer","used"),false);
});

test("orchestrator pre-dispatch advice requires explicit consent, readiness, mode and remaining budget", async()=>{
 const service={async evaluate(){return result();}};
 for (const c of [config,{...config,orchestratorBeforeDispatch:true,mode:"off" as const},{...config,orchestratorBeforeDispatch:true,mode:"shadow" as const},{...config,orchestratorBeforeDispatch:true,remoteContextApproved:false}]) {
  assert.equal(createTriageRuntime({config:c,service,current:i=>i}).orchestratorBeforeDispatch,false);
 }
 assert.equal(parseTriageConfig({...config,orchestratorBeforeDispatch:"yes"}),null);
 const enabled={...config,orchestratorBeforeDispatch:true,maxCalls:1};
 assert.equal(createTriageRuntime({config:enabled,current:i=>i}).orchestratorBeforeDispatch,false);
 assert.equal(createTriageRuntime({config,service,current:i=>i}).available,true);
 assert.equal(createTriageRuntime({config:{...config,mode:"shadow"},service,current:i=>i}).available,true);
 assert.equal(createTriageRuntime({config:{...config,mode:"off"},service,current:i=>i}).available,false);
 assert.equal(createTriageRuntime({config,current:i=>i}).available,false);
 const runtime=createTriageRuntime({config:enabled,service,current:i=>i});
 assert.equal(runtime.orchestratorBeforeDispatch,true);
 await runtime.evaluate(input);assert.equal(runtime.orchestratorBeforeDispatch,false);
 runtime.dispose();assert.equal(runtime.orchestratorBeforeDispatch,false);
});
