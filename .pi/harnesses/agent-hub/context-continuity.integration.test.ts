import test from "node:test";
import assert from "node:assert/strict";
import {createContextPressureLifecycle,createContextPressureRootState} from "./lifecycle/context-pressure.ts";
function setup(blocked=false) {
 const root=createContextPressureRootState(),sent:any[]=[],entries:any[]=[];let options:any;
 const ctx:any={cwd:process.cwd(),sessionManager:{getSessionId:()=>"s"},hasUI:false,model:{contextWindow:1000},getContextUsage:()=>({tokens:950,contextWindow:1000,percent:95}),ui:{setStatus(){},notify(){}},abort(){},compact:(opts:any)=>{options=opts;},isIdle:()=>false};
 let lifecycle:any;
 lifecycle=createContextPressureLifecycle({getState:()=>root,setPressure:p=>{root.pressure=p;},getCurrentContext:()=>ctx,appendEntry:(type,data)=>entries.push({type,data}),sendUserMessage:(content,opts)=>sent.push({user:content,opts}),resolveCapabilities(){},applyWorkMode(){},modelWorkBlocked:()=>blocked,continuity:{pi:{on(){},sendMessage:(content:any)=>sent.push({custom:content})} as any,runtimeVersion:"1.1.0",taskIdentity:()=>({task:"t",revision:1})}});
 return {root,sent,entries,ctx,lifecycle,complete:(restored=true)=>{lifecycle.sessionCompact(restored);options.onComplete();}};
}
test("Hub lifecycle empty user queue resumes only after successful restoration",async()=>{
 const s=setup();s.lifecycle.messageEnd({message:{role:"toolResult",content:"output"}},s.ctx);const run=s.lifecycle.agentSettled(s.ctx);assert.equal(s.sent.length,0);s.complete();await run;assert.equal(s.sent.length,1);assert.ok(s.sent[0].custom);assert.equal(s.root.automaticRunning,false);
});
test("Hub restore failure, waiting-user and runtime gates suppress continuation",async()=>{
 for(const scenario of ["restore","blocked"]){const s=setup(scenario==="blocked");s.lifecycle.messageEnd({message:{role:"toolResult",content:"output"}},s.ctx);const run=s.lifecycle.agentSettled(s.ctx);s.complete(scenario!=="restore");await run;assert.equal(s.sent.length,0);if(scenario==="restore")assert.equal(s.root.pressure.phase,"failed");}
});
test("queued user text and images replay once with priority; no synthetic continuation",async()=>{
 const s=setup();s.lifecycle.messageEnd({message:{role:"toolResult",content:"output"}},s.ctx);const image={type:"image",data:"fixture",mimeType:"image/png"};s.root.deferredInputs.push({text:"Actual new request",images:[image],streamingBehavior:"steer"});const run=s.lifecycle.agentSettled(s.ctx);s.complete();await run;s.lifecycle.replayDeferred();assert.equal(s.sent.length,1);assert.deepEqual(s.sent[0].user,[{type:"text",text:"Actual new request"},image]);assert.equal(s.sent.filter((x:any)=>x.custom).length,0);
});

// The explicit small-session path is different from pressure recovery: no fake
// success, no poisoned input queue, but the same continuation gates still apply.
import {managedCompaction} from "./context-continuity-registry.ts";
test("empty history never turns mandatory pressure recovery into an explicit skip",async()=>{
 const s=setup();s.ctx.sessionManager.getSessionId=()=>"s";
 s.lifecycle.observe(s.ctx,"session_start");managedCompaction(s.ctx.sessionManager)!.request({instructions:"preserve",nextStep:"next"});
 s.lifecycle.messageEnd({message:{role:"toolResult",content:"output"}},s.ctx);
 const run=s.lifecycle.agentSettled(s.ctx);s.complete(false);await run;
 assert.equal(s.root.pressure.phase,"failed");assert.equal(s.sent.length,0);assert.ok(!s.entries.some((e:any)=>e.data.phase==="skipped"));
});

for(const blocked of [false,true])test(`small explicit session skips without compact/restore or failed pressure; blocked=${blocked}`,async()=>{
 const root=createContextPressureRootState(),sent:any[]=[],entries:any[]=[],notices:string[]=[];let compactCalls=0;
 const ctx:any={cwd:process.cwd(),sessionManager:{getSessionId:()=>"s"},hasUI:true,model:{contextWindow:64000},getContextUsage:()=>({tokens:1000,contextWindow:64000}),ui:{setStatus(){},notify:(text:string)=>notices.push(text)},compact(){compactCalls++;},isIdle:()=>true};
 const lifecycle=createContextPressureLifecycle({getState:()=>root,setPressure:p=>{root.pressure=p;},getCurrentContext:()=>ctx,appendEntry:(type,data)=>entries.push({type,data}),sendUserMessage:()=>sent.push("user"),resolveCapabilities(){},applyWorkMode(){},modelWorkBlocked:()=>blocked,continuity:{pi:{on(){},sendMessage:(message:any)=>sent.push(message)} as any,runtimeVersion:"1.1.0",taskIdentity:()=>({task:"t",revision:1}),preflight:async()=>"no-history"}});
 lifecycle.observe(ctx,"session_start");managedCompaction(ctx.sessionManager)!.request({instructions:"preserve",nextStep:"Read package.json once"});
 await lifecycle.agentSettled(ctx);await lifecycle.agentSettled(ctx);
 assert.equal(compactCalls,0);assert.equal(root.pressure.phase,"normal");assert.equal(root.pressure.lastRecoveryOutcome,"none");assert.equal(root.automaticRunning,false);assert.equal(root.automaticPending,false);
 assert.equal(sent.length,blocked?0:1);if(!blocked)assert.match(sent[0].content,/skipped/);
 assert.ok(entries.some(e=>e.data.phase==="skipped"));assert.ok(!notices.some(n=>n.includes("started") || n.includes("completed")));
 assert.equal(lifecycle.input({source:"interactive",text:"Next ordinary request"},ctx).action,blocked?"handled":"continue");
});

test("80% ceiling blocks work after insufficient recovery without starting a compaction loop",async()=>{
 const s=setup();let aborts=0;s.ctx.abort=()=>{aborts++;};
 s.lifecycle.messageEnd({message:{role:"toolResult",content:"output"}},s.ctx);
 const run=s.lifecycle.agentSettled(s.ctx);s.complete();await run;
 const before=aborts;s.lifecycle.context(s.ctx);
 assert.equal(aborts,before+1);
 assert.ok(s.entries.some((e:any)=>e.type==="agent-hub-compaction-monitor" && e.data.phase==="ceiling_blocked"));
 assert.equal(s.root.automaticPending,false);
});

test("a compacted baseline between target and ceiling keeps working until growth re-arms compaction",async()=>{
 const s=setup();let aborts=0,tokens=950;s.ctx.abort=()=>{aborts++;};s.ctx.getContextUsage=()=>({tokens,contextWindow:1000,percent:tokens/10});
 s.lifecycle.messageEnd({message:{role:"toolResult",content:"output"}},s.ctx);
 const run=s.lifecycle.agentSettled(s.ctx);s.complete();await run;
 tokens=750;s.lifecycle.observe(s.ctx,"turn_end");
 tokens=820;const before=aborts;s.lifecycle.context(s.ctx);s.lifecycle.context(s.ctx);
 assert.equal(aborts,before,"less than one band of growth does not stall work");
 assert.equal(s.entries.filter((e:any)=>e.data.phase==="ceiling_exceeded").length,1);
 assert.ok(!s.entries.some((e:any)=>e.data.phase==="ceiling_blocked"));
 tokens=860;s.lifecycle.context(s.ctx);
 assert.equal(s.root.automaticPending,true,"one band of growth re-arms compaction");
});
