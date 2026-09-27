import assert from "node:assert/strict";
import test from "node:test";
import { createCommunicationStore, redactCommunication } from "./system1-communication-store.ts";
import { createWatchdogSystem1Session } from "./system1-runtime.ts";
import type { EvaluateRequest, System1Result } from "../lib/system1/contracts.ts";
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
