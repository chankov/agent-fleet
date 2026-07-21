import test from "node:test";
import assert from "node:assert/strict";
import { MonitorStore } from "../../../scripts/lib/hermes-monitor-store.ts";
import { MonitorPublisher } from "./monitor-publisher.ts";
import { createMonitorSessionBridge } from "./monitor-session-bridge.ts";

test("duplicate startChild returns the same pending/resolved task", async () => {
 const store=new MonitorStore(); const publisher=new MonitorPublisher(store); let calls=0;
 const bridge:any=createMonitorSessionBridge({store,publisher:{publishParent:publisher.publishParent.bind(publisher),publishChildForHub:async(input:any)=>{calls++;return publisher.publishChild(input);}}});
 bridge.startParent({id:"parent",generation:1,hubInstanceId:"hub",checkoutId:"checkout"}); const input={key:"run",id:"child",generation:1,parentId:"parent",specialist:"qa"}; const first=bridge.startChild(input,{}), second=bridge.startChild(input,{}); assert.equal(first,second); assert.equal((await second).id,"child"); assert.equal(calls,1);
});

test("delayed generation one callbacks cannot mutate generation two",async()=>{const b:any=createMonitorSessionBridge();b.startParent({id:"p",hubInstanceId:"h",checkoutId:"c"});const one=await b.startChild({key:"same",id:"x",generation:1,parentId:"p",parentGeneration:1,specialist:"s"},{});await b.finalizeChildFor(one,"one","completed");const two=await b.startChild({key:"same",id:"x",generation:1,parentId:"p",parentGeneration:1,specialist:"s"},{});await b.appendOutputFor(one,"late");await b.finalizeChildFor(one,"late","failed");assert.equal(b.readOutput({taskId:"x",generation:2,afterSequence:0}).text,"");assert.equal(b.snapshot().tasks.find((t:any)=>t.id==="x"&&t.generation===2).state,"starting");await b.finalizeChildFor(two,"two","completed");assert.equal(b.snapshot().tasks.find((t:any)=>t.id==="x"&&t.generation===2).state,"completed");});
test('late gen1 output is persisted under gen1 history after gen2 starts',async()=>{let saved:any={tasks:[]};const runtime={load:()=>saved,save:(v:any)=>saved=structuredClone(v)};const b:any=createMonitorSessionBridge({runtime});b.startParent({id:'p',hubInstanceId:'h',checkoutId:'c'});const one=await b.startChild({key:'same',id:'x',generation:1,parentId:'p',parentGeneration:1,specialist:'s'},{});await b.finalizeChildFor(one,'','completed');await b.startChild({key:'same',id:'x',generation:1,parentId:'p',parentGeneration:1,specialist:'s'},{});await b.appendOutputFor(one,'late-one');assert.deepEqual(saved.tasks.find((t:any)=>t.id==='x'&&t.generation===1).lateHistory,[{kind:'late_output',text:'late-one'}]);assert.deepEqual(saved.tasks.find((t:any)=>t.id==='x'&&t.generation===2).lateHistory,[]);});
test("queued output finish and cancel wait for async correlation; cancelled task keeps bounded late history", async () => {
 const store=new MonitorStore(); const publisher=new MonitorPublisher(store); let release!:()=>void; const gate=new Promise<void>(resolve=>release=resolve);
 const bridge:any=createMonitorSessionBridge({store,publisher:{publishParent:publisher.publishParent.bind(publisher),publishChildForHub:async(input:any)=>{await gate;return publisher.publishChild(input);},publishPublicOutput:publisher.publishPublicOutput.bind(publisher),transition:publisher.transition.bind(publisher)},cancelOwnedProcess:async()=>({cancelled:true,state:"cancelled"})});
 bridge.startParent({id:"parent",generation:1,hubInstanceId:"hub",checkoutId:"checkout"}); const start=bridge.startChild({key:"run",id:"child",generation:1,parentId:"parent",specialist:"qa"},{});
 const output=bridge.appendOutput("run","before-cancel"); const cancel=bridge.cancelOwnedProcess("run"); const finish=bridge.finishChild("run","completed"); release(); await start; await output; await cancel; await finish;
 const child=bridge.snapshot().tasks.find((task:any)=>task.id==="child"); assert.equal(child.state,"cancelled");
 const late=await bridge.appendOutput("run","after-cancel"); assert.equal(late.state,"cancelled"); assert.equal(late.history.at(-1).kind,"late_output");
});
