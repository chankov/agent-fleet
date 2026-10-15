import assert from "node:assert/strict";
import test from "node:test";
import { createExecutionTrace, projectExecutionTrace, registerExecutionTrace } from "./execution-trace.ts";
import { beginRuntimeTrace, emitRuntimeTrace } from "../lib/execution-trace.ts";

function fixture() {
 let time=0,task="first-task",input="first-input",fail=false;
 const entries:any[]=[];
 const trace=createExecutionTrace({ now:()=>time,identity:()=>({taskId:task,inputRevision:input}),persist:row=>{if(fail)throw Error("disk unavailable");entries.push({customType:"agent-hub-execution-trace",data:row});} });
 return {trace,entries,at:(v:number)=>{time=v;},identity:()=>{task="second-task";input="second-input";},fail:()=>{fail=true;}};
}

test("trace joins tool, rule, overlapping human waits and actual execution without exposing payloads",()=>{
 const f=fixture();f.trace.start({kind:"tool",id:"call",tool:"bash",fingerprint:"SECRET_COMMAND"});
 f.at(20);const policy=f.trace.start({kind:"policy",id:"policy",parentId:"call",source:"damage-control",rule:"SECRET_PATH"});
 const first=f.trace.start({kind:"approval",id:"question-one",parentId:"call"});
 f.at(30);const second=f.trace.start({kind:"approval",id:"question-two",parentId:"call"});
 f.at(45);first({status:"allowed"});f.at(50);second({status:"allowed"});policy({status:"allowed"});
 f.at(100);f.trace.endTool("call",{status:"completed",durationMs:60});
 const view=projectExecutionTrace(f.entries),tool=view.spans.find(s=>s.kind==="tool")!;
 assert.equal(tool.elapsedMs,100);assert.equal(tool.executionMs,60);assert.equal(tool.humanWaitMs,30);
 assert.equal(tool.executionWithoutHumanMs,50,"wait before tool execution is not subtracted twice");
 assert.equal(view.totals.humanWaitMs,30,"overlapping waits are a union");
 assert.equal(view.spans.filter(s=>s.kind==="approval").every(s=>s.parentSpanId===tool.spanId),true);
 assert.doesNotMatch(JSON.stringify(view),/SECRET|question-one|first-task|first-input/);
});

test("a pre-effect denial is a blocked request, never fabricated tool execution",()=>{
 const f=fixture();f.trace.start({kind:"tool",id:"call",tool:"bash"});f.at(5);
 const decision=f.trace.start({kind:"policy",id:"gate",parentId:"call",source:"process",rule:"risk_required"});
 decision({status:"blocked"});f.at(7);f.trace.endTool("call",{status:"failed"});
 const tool=projectExecutionTrace(f.entries).spans.find(s=>s.kind==="tool")!;
 assert.equal(tool.status,"blocked");assert.equal(tool.executionMs,null);assert.equal(tool.executionWithoutHumanMs,null);
});

test("late completions retain their original task and cannot enter a new session instance",()=>{
 const f=fixture();const old=f.trace.start({kind:"approval",id:"question"});
 f.identity();f.at(10);old({status:"allowed"});
 const first=projectExecutionTrace(f.entries).spans[0];assert.equal(first.taskIdHash,f.entries[0].data.taskIdHash);
 const late=f.trace.start({kind:"approval",id:"late"});f.at(20);f.trace.reset();
 const length=f.entries.length;late({status:"allowed"});assert.equal(f.entries.length,length);
 assert.equal(projectExecutionTrace(f.entries).spans.find(s=>s.status==="interrupted")?.kind,"approval");
});

test("audit exposes legacy, corrupt, interrupted and failed persistence coverage honestly",()=>{
 assert.equal(projectExecutionTrace([]).coverage.availability,"not_recorded");
 assert.equal(projectExecutionTrace([]).totals.humanWaitMs,null,"missing legacy trace is not zero measured human wait");
 const f=fixture();f.trace.start({kind:"tool",id:"open",tool:"read"});
 f.entries.push({customType:"agent-hub-execution-trace",data:{schema:"invalid",payload:"SECRET"}});
 const view=projectExecutionTrace(f.entries);assert.equal(view.coverage.invalidRecords,1);assert.equal(view.spans[0].status,"open");
 f.fail();f.at(4);f.trace.endTool("open",{status:"completed",durationMs:2});
 const fallback=projectExecutionTrace(f.entries,f.trace.snapshot());
 assert.equal(fallback.coverage.availability,"live_degraded");assert.ok(fallback.coverage.persistenceFailures>0);
 assert.equal(fallback.spans.find(s=>s.kind==="tool")?.status,"completed");assert.doesNotMatch(JSON.stringify(fallback),/SECRET/);
});

test("journal and live retention losses are reported separately without double counting",()=>{
 const f=fixture();
 for(let i=0;i<2501;i++)f.trace.input(String(i));
 const view=projectExecutionTrace(f.entries,f.trace.snapshot());
 assert.equal(view.events.length,5000);assert.equal(view.coverage.droppedRows,2);
 assert.equal(view.coverage.liveDroppedRows,2);
 assert.equal(view.coverage.incompleteSpans,0);
});

test("child activity correlates with the root dispatch using the runtime child identity",()=>{
 const f=fixture();f.trace.start({kind:"tool",id:"dispatch",tool:"dispatch_agent"});
 f.trace.start({kind:"child",id:"child-id",owner:"child-id",source:"native"});
 f.trace.start({kind:"tool",id:"read",owner:"child-id",parentId:"child-id",parentKind:"child",tool:"read",source:"native"});
 f.at(10);f.trace.endTool("read",{status:"completed",durationMs:6},"child-id");
 f.trace.endTool("dispatch",{status:"completed",childId:"child-id",durationMs:10});
 const spans=projectExecutionTrace(f.entries).spans,root=spans.find(s=>s.tool==="dispatch_agent")!,child=spans.find(s=>s.kind==="child")!;
 assert.equal(child.parentSpanId,root.spanId);assert.equal(spans.find(s=>s.tool==="read")?.parentSpanId,child.spanId);
});

test("Pi hooks and the shared bus record asks without changing results or accepting late answers",async()=>{
 const f=fixture(),handlers=new Map<string,Function[]>(),listeners=new Map<string,Set<Function>>();
 const bus={emit:(n:string,v:unknown)=>{for(const fn of listeners.get(n)??[])fn(v);},on:(n:string,fn:Function)=>{const set=listeners.get(n)??new Set();set.add(fn);listeners.set(n,set);return()=>set.delete(fn);}};
 const api={events:bus,on:(n:string,fn:Function)=>{const list=handlers.get(n)??[];list.push(fn);handlers.set(n,list);}};
 registerExecutionTrace(api as any,f.trace);
 const fire=async(name:string,event:any={})=>{for(const fn of handlers.get(name)??[])assert.equal(await fn(event,{}),undefined);};
 await fire("session_start");await fire("tool_execution_start",{toolCallId:"call",toolName:"bash",args:{command:"SECRET"}});
 const end=beginRuntimeTrace(bus,{kind:"approval",id:"runtime-question",parentId:"call",source:"task-triage"});
 f.at(20);end({status:"denied"});emitRuntimeTrace(bus,{kind:"policy",id:"policy",parentId:"call",source:"task-triage",status:"blocked"});
 await fire("tool_execution_end",{toolCallId:"call",toolName:"bash",isError:true,result:{content:[{type:"text",text:"SECRET"}],details:{}}});
 const view=projectExecutionTrace(f.entries);assert.equal(view.spans.find(s=>s.kind==="tool")?.status,"blocked");
 assert.equal(view.spans.find(s=>s.kind==="approval")?.status,"denied");assert.doesNotMatch(JSON.stringify(view),/SECRET/);
});

test("broker questions join only one exact child call and ambiguous inputs remain visibly unlinked",()=>{
 const f=fixture();const child=f.trace.forOwner('child');
 child.start({kind:'child',id:'child'});
 child.start({kind:'tool',id:'call',parentId:'child',parentKind:'child',tool:'bash',fingerprint:'{"command":"hello"}'});
 f.at(10);const policy=child.start({kind:'policy',id:'broker-id',source:'damage-guard',tool:'bash',fingerprint:'{"command":"hello"}'});
 const question=child.start({kind:'approval',id:'human',parentId:'broker-id',parentKind:'policy'});
 f.at(20);question({status:'denied'});policy({status:'blocked'});child.endTool('call',{status:'failed'});
 let view=projectExecutionTrace(f.entries),gate=view.spans.find(s=>s.kind==='policy')!,tool=view.spans.find(s=>s.kind==='tool')!;
 assert.equal(gate.parentSpanId,tool.spanId);assert.equal(gate.correlation,'exact_input_unique');assert.equal(tool.humanWaitMs,10);
 child.start({kind:'tool',id:'concurrent-one',tool:'bash',fingerprint:'same'});child.start({kind:'tool',id:'concurrent-two',tool:'bash',fingerprint:'same'});
 f.at(30);child.start({kind:'policy',id:'ambiguous',source:'damage-guard',tool:'bash',fingerprint:'same'})({status:'blocked'});
 view=projectExecutionTrace(f.entries);assert.equal(view.spans.filter(s=>s.kind==='policy').at(-1)?.parentSpanId,null);
});

test("child observations keep their captured input identity and late callbacks cannot reopen a finished child",async()=>{
 const {createNativeExecutionTrace}=await import('./execution-trace.ts');
 const f=fixture(),child=createNativeExecutionTrace(f.trace,'child');const original=f.entries[0].data.inputRevisionHash;
 f.identity();child.toolStart('read','{}','one');child.toolEnd('read','one',false,'private',1);child.finish({exitCode:0});
 const count=f.entries.length;child.toolStart('read','{}','late');assert.equal(f.entries.length,count);
 assert.equal(projectExecutionTrace(f.entries).spans.find(s=>s.kind==='tool')?.inputRevisionHash,original);
});

test("trace survives a cancelled session switch and releases its bus listener on shutdown",async()=>{
 const f=fixture(),handlers=new Map<string,Function[]>(),listeners=new Set<Function>();
 const bus={emit:(_n:string,v:unknown)=>{for(const fn of listeners)fn(v);},on:(_n:string,fn:Function)=>{listeners.add(fn);return()=>listeners.delete(fn);}};
 registerExecutionTrace({events:bus,on:(name:string,fn:Function)=>{const list=handlers.get(name)??[];list.push(fn);handlers.set(name,list);}} as any,f.trace);
 const fire=async(name:string)=>{for(const fn of handlers.get(name)??[])await fn({},{});};
 await fire('session_start');assert.equal(listeners.size,1);
 const finish=beginRuntimeTrace(bus,{kind:'approval',id:'pending'});
 await fire('session_before_switch');f.at(10);finish({status:'allowed'});
 assert.equal(projectExecutionTrace(f.entries).spans[0].status,'allowed','a switch proposal can be cancelled by another extension');
 await fire('session_shutdown');assert.equal(listeners.size,0);
 const count=f.entries.length;beginRuntimeTrace(bus,{kind:'approval',id:'stale'})({status:'allowed'});assert.equal(f.entries.length,count);
 await fire('session_start');await fire('session_start');assert.equal(listeners.size,1,'session restart subscribes exactly once');
});
