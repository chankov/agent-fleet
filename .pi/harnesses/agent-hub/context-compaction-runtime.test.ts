import test from "node:test";
import assert from "node:assert/strict";
import {ContextCompactionRuntime,compactionResponseReserve} from "./context-compaction-runtime.ts";
import {CONTEXT_COMPACTION_QUESTION_VERSION} from "./context-compaction.ts";
const config={mode:"automatic",remoteContextApproved:true,earlyOpportunityPercent:60,limits:{timeoutMs:20,maxStateBytes:8192}};
const input={identity:"s:t",task:"Finish the approved task",revision:1,turn:1,tokens:60000,window:100000,historyTokens:40000,keepRecentTokens:16000,responseTokens:8000,unsafe:false};
function service(confidence=0.8) {let calls=0;return {get calls(){return calls;},evaluate:async()=>{calls++;return {status:"ok" as const,evaluation:{answers:[{questionId:"boundary",type:"choice" as const,value:"safe",uncertainty:{provenance:"provider" as const,confidence}},{questionId:"retention",type:"choice" as const,value:"active_step",uncertainty:{provenance:"provider" as const,confidence}}],metadata:{provider:"typesafe",requestedModel:"jev-1.13.0",returnedModel:"jev-1.13.0",questionSetVersion:CONTEXT_COMPACTION_QUESTION_VERSION,latencyMs:1,attempts:1}}};}};}
test("272k window / 128k output model uses Pi reserve and has eligible early opportunities",async()=>{
 const reserve=compactionResponseReserve({reserveTokens:16384},128000);
 assert.equal(reserve,16384);assert.equal(compactionResponseReserve({reserveTokens:16384},8000),8000);
 assert.equal(compactionResponseReserve({reserveTokens:16384},undefined),16384);
 for(const tokens of [163200,166532,223218,232385]) {
  const s=service();const result=await new ContextCompactionRuntime().assess({...input,tokens,window:272000,historyTokens:40000,keepRecentTokens:20000,responseTokens:reserve},s,config);
  assert.equal(s.calls,1);assert.equal(result.compact,true);
 }
});
test("metadata-only eligibility distinguishes insufficient headroom and low confidence",async()=>{
 const s=service();const result=await new ContextCompactionRuntime().assess({...input,responseTokens:41000},s,config);
 assert.equal(result.reason,"insufficient_headroom");assert.equal(result.inferenceRequested,false);assert.equal(s.calls,0);
 const uncertain=await new ContextCompactionRuntime().assess(input,service(0.79),config);
 assert.equal(uncertain.reason,"low_confidence");assert.equal(uncertain.inferenceRequested,true);
});

test("bounded eligible runtime call uses approved 0.80 confidence and fixed retention instructions",async()=>{const s=service();const r=await new ContextCompactionRuntime().assess(input,s,config);assert.equal(r.compact,true);assert.match(r.instructions!,/pending child/);assert.equal(s.calls,1);});
test("off, missing, no consent, unsafe, unknown usage, empty history and no headroom never call",async()=>{
 for(const change of [{unsafe:true},{tokens:null},{window:null},{historyTokens:16000},{tokens:59000},{responseTokens:41000},{task:"password=private"}]){const s=service();assert.equal((await new ContextCompactionRuntime().assess({...input,...change},s,config)).compact,false);assert.equal(s.calls,0);}
 for(const c of [undefined,{...config,mode:"off"},{...config,remoteContextApproved:false}]){const s=service();await new ContextCompactionRuntime().assess(input,s,c);assert.equal(s.calls,0);}
});
test("unchanged snapshot dedup and actual growth after compact rearm",async()=>{const r=new ContextCompactionRuntime(),s=service();await r.assess(input,s,config);await r.assess({...input,turn:2},s,config);assert.equal(s.calls,1);r.compacted(50000);await r.assess({...input,tokens:65000},s,config);assert.equal(s.calls,1);assert.equal((await r.assess({...input,tokens:67000},s,config)).compact,true);});
test("low confidence, stale response, outage and timeout leave deterministic baseline",async()=>{
 assert.equal((await new ContextCompactionRuntime().assess(input,service(0.79),config)).compact,false);
 const r=new ContextCompactionRuntime();let finish:any;const pending=r.assess(input,{evaluate:()=>new Promise(resolve=>{finish=resolve;})},config);r.fence();finish(await service().evaluate());assert.equal((await pending).status,"stale");
 assert.equal((await new ContextCompactionRuntime().assess(input,{evaluate:async()=>{throw Error("outage");}},config)).compact,false);
 assert.equal((await new ContextCompactionRuntime().assess(input,{evaluate:()=>new Promise(()=>{})},config)).compact,false);
});

test("uncertain retention uses standard summary only when boundary is confidently safe",async()=>{
 const s={evaluate:async()=>{const r=await service().evaluate();r.evaluation.answers[1].uncertainty.confidence=0.3;return r;}};
 const result=await new ContextCompactionRuntime().assess(input,s,config);
 assert.equal(result.compact,true);assert.match(result.instructions!,/goal, requirements/);
 assert.equal(result.reason,"safe_boundary_default_retention");
});

test("unknown usage immediately after compaction rearms only after measured growth",async()=>{
 const r=new ContextCompactionRuntime(),s=service();r.compacted(null);
 assert.equal((await r.assess(input,s,config)).reason,"growth_not_rearmed");
 assert.equal(s.calls,0);
 assert.equal((await r.assess({...input,tokens:input.tokens+1000},s,config)).reason,"growth_not_rearmed");
 assert.equal((await r.assess({...input,tokens:input.tokens+17000},s,config)).compact,true);
});

test("automatic semantic evaluation cannot start below 50 even with an unchecked legacy threshold",async()=>{
 const s=service();const result=await new ContextCompactionRuntime().assess({...input,tokens:49999},s,{...config,earlyOpportunityPercent:10});
 assert.equal(result.reason,"below_early_threshold");assert.equal(s.calls,0);
});

test("retention fallback does not accept a malformed duplicate-answer response",async()=>{
 const malformed={evaluate:async()=>{const r=await service().evaluate();r.evaluation.answers[1]=r.evaluation.answers[0];return r;}};
 const result=await new ContextCompactionRuntime().assess(input,malformed,config);
 assert.equal(result.compact,false);assert.equal(result.reason,"invalid_response");
});
