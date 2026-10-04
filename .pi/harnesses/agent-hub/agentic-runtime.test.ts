import test from 'node:test';import assert from 'node:assert/strict';
import {createAgenticRuntime} from './agentic-runtime.ts';import {parseAgenticConfig} from '../lib/system1/config-agentic.js';
const config=parseAgenticConfig({mode:'advisory',remoteContextApproved:true,limits:{maxCallsPerSession:1}});
const input={state:'State',questions:[{id:'q',type:'predicate',instructions:'Is it clear?'}]};
const base={sessionId:'s',context:()=> 'task',persist:()=>{},config};
test('recommended accepts repeated useful batches while preserving advisory authority and session bounds',async()=>{
 const recommended=parseAgenticConfig({mode:'recommended',remoteContextApproved:true,limits:{maxCallsPerSession:3}});
 let calls=0;
 const runtime=createAgenticRuntime({...base,config:recommended,service:{evaluate:async()=>{calls++;return {status:'ok',evaluation:{answers:[],metadata:{provider:'fake',requestedModel:'fake',returnedModel:'fake',questionSetVersion:'agentic-ask/v1',latencyMs:0,attempts:1}}};}}});
 assert.equal(runtime.enabled,true);assert.equal(runtime.mode,'recommended');
 for(let i=0;i<3;i++) {
  const result=await runtime.evaluate({...input,state:`Distinct task context ${i}`});
  assert.equal(result.status,'ok');assert.equal(result.advisory,true);
 }
 assert.equal((await runtime.evaluate(input) as any).reason,'budget_exhausted');assert.equal(calls,3);
 runtime.dispose();assert.equal(runtime.enabled,false);assert.equal(runtime.mode,'off');
 assert.equal(createAgenticRuntime({...base,config:{...recommended,remoteContextApproved:false}}).mode,'off');
 assert.equal(createAgenticRuntime({...base,config:recommended,parent:false}).mode,'off');
});
test('off/unapproved/invalid never collect or evaluate',async()=>{
 let calls=0;const service={evaluate:async()=>{calls++;return {status:'cancelled' as const};}};const collect=async()=>{calls++;throw Error();};
 for(const c of [undefined,{...config,mode:'off' as const},{...config,remoteContextApproved:false}]) {const r=createAgenticRuntime({...base,config:c,service,collect});await r.evaluate({...input,paths:[{path:'x'}]});}
 await createAgenticRuntime({...base,service}).evaluate({...input,command:'true'});assert.equal(calls,0);
});
test('one reservation owns concurrent batches; shared status is preserved',async()=>{
 let calls=0;const r=createAgenticRuntime({...base,service:{evaluate:async()=>{calls++;return {status:'unsupported',missingCapabilities:['predicate']};}}});
 const results=await Promise.all([r.evaluate(input),r.evaluate(input)]);assert.equal(calls,1);assert.equal(results[0].status,'unsupported');assert.equal((results[1] as any).reason,'budget_exhausted');
});
test('abort fences noncooperative late result and task change marks stale',async()=>{
 let resolve:any;const r=createAgenticRuntime({...base,service:{evaluate:()=>new Promise(r=>resolve=r)}});const c=new AbortController();const p=r.evaluate(input,c.signal);await new Promise(r=>setImmediate(r));c.abort();assert.equal((await p).status,'cancelled');resolve({status:'ok'});
 let context='a';const stale=createAgenticRuntime({...base,context:()=>context,service:{evaluate:async()=>{context='b';return {status:'ok',evaluation:{answers:[],metadata:{provider:'fake',requestedModel:'fake',returnedModel:'fake',questionSetVersion:'agentic-ask/v1',latencyMs:0,attempts:1}}};}}});assert.equal((await stale.evaluate(input)).status,'stale');
});
test('shared failures, no budget transfer or authority mutation',async()=>{
 const process={obligations:['review'],permissions:[],accepted:false,budget:2};const before=structuredClone(process);
 for(const status of [{status:'skipped',reason:'missing_key'},{status:'unavailable',reason:'auth'},{status:'cancelled'}] as any[]) {assert.equal((await createAgenticRuntime({...base,service:{evaluate:async()=>status}}).evaluate(input)).status,status.status);}
 assert.deepEqual(process,before);
});
