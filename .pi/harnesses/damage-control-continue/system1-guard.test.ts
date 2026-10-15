import test from 'node:test';
import assert from 'node:assert/strict';
import {createDamageGuard} from './system1-guard.ts';
import {parseDamageGuardConfig} from '../lib/system1/config-damage-guard.js';
import {createDamageState} from '../agent-hub/damage-guard-state.ts';
import type {System1Result} from '../lib/system1/contracts.ts';
const verdict=(effect:string):System1Result=>({status:'ok',evaluation:{answers:[{questionId:'effect',type:'choice',value:effect,uncertainty:{provenance:'provider'}},{questionId:'evidence',type:'choice',value:'sufficient',uncertainty:{provenance:'provider'}}],metadata:{provider:'typesafe',requestedModel:'jev-1.13.0',returnedModel:'jev-1.13.0',questionSetVersion:'damage-guard/v1',latencyMs:1,attempts:1}}});
const config=parseDamageGuardConfig({mode:'active',remoteScopes:{commands:true},include:['docs']});
test('unresolved hold persists across new-call outage retry without a second evaluation',async()=>{
 let calls=0;const guard=createDamageGuard({root:process.cwd(),config,state:createDamageState(()=>{}),binding:()=>({taskId:'task',inputRevision:'rev',owner:'hub',attempt:'attempt'}),canRead:()=>true,approve:async()=>false,service:{evaluate:async()=>{calls++;return {status:'ok',evaluation:{answers:[{questionId:'effect',type:'choice',value:'severe',uncertainty:{provenance:'provider'}},{questionId:'evidence',type:'choice',value:'sufficient',uncertainty:{provenance:'provider'}}],metadata:{provider:'typesafe',requestedModel:'jev-1.13.0',returnedModel:'jev-1.13.0',questionSetVersion:'damage-guard/v1',latencyMs:1,attempts:1}}};}}});
 const event={toolName:'bash',toolCallId:'first',input:{command:'echo hello'}},ctx={cwd:process.cwd()};
 assert.equal((await guard.call(event,ctx)).block,true);assert.equal((await guard.call({...event,toolCallId:'retry'},ctx)).block,true);assert.equal(calls,1);
});
test('old completed non-block decision cannot bypass a newer hold',async()=>{
 let calls=0;const guard=createDamageGuard({root:process.cwd(),config,state:createDamageState(()=>{}),binding:()=>({taskId:'task',inputRevision:'rev',owner:'hub',attempt:'attempt'}),canRead:()=>true,approve:async()=>false,service:{evaluate:async()=>verdict(++calls===1?'not_severe':'severe')}});
 const event={toolName:'bash',toolCallId:'first',input:{command:'echo hello'}},ctx={cwd:process.cwd()};
 assert.equal((await guard.call(event,ctx)).block,false);assert.equal((await guard.call({...event,toolCallId:'held'},ctx)).block,true);assert.equal((await guard.call(event,ctx)).block,true);
});
test('dispose revokes held approval and future calls',async()=>{
 let finish!:(allowed:boolean)=>void,entered!:()=>void;const ready=new Promise<void>(r=>entered=r);
 const guard=createDamageGuard({root:process.cwd(),config,state:createDamageState(()=>{}),binding:()=>({taskId:'task',inputRevision:'rev',owner:'hub',attempt:'attempt'}),canRead:()=>true,service:{evaluate:async()=>verdict('severe')},approve:async()=>{entered();return new Promise<boolean>(r=>finish=r);}});
 const event={toolName:'bash',toolCallId:'call',input:{command:'echo hello'}},ctx={cwd:process.cwd()},pending=guard.call(event,ctx);
 await ready;guard.dispose();finish(true);assert.equal((await pending).block,true);assert.equal((await guard.call(event,ctx)).block,true);
});
test('D6 call outage falls back; explicit deny persists independently of off/outage/new call',async()=>{
 let calls=0;const state=createDamageState(()=>{}),binding={taskId:'task',inputRevision:'rev',owner:'hub',attempt:'attempt'};
 const guard=createDamageGuard({root:process.cwd(),config,state,binding:()=>binding,canRead:()=>true,service:{evaluate:async()=>{calls++;return {status:'unavailable',reason:'network'};}},approve:async()=>false});
 const event={toolName:'bash',toolCallId:'call',input:{command:'echo hello'}},ctx={cwd:process.cwd()};
 assert.equal((await guard.call(event,ctx)).block,false);assert.equal(calls,1);
 state.deny(guard.action(event,ctx));assert.equal((await guard.call({...event,toolCallId:'new'},ctx)).block,true);
});
test('dispose aborts in-flight evaluation and blocks before an uncooperative provider settles',async()=>{
 let entered!:()=>void,finish!:(value:System1Result)=>void,signal:AbortSignal|undefined;const ready=new Promise<void>(r=>entered=r);
 const guard=createDamageGuard({root:process.cwd(),config,state:createDamageState(()=>{}),binding:()=>({taskId:'task',inputRevision:'rev',owner:'hub',attempt:'attempt'}),canRead:()=>true,approve:async()=>false,service:{evaluate:async(request)=>{signal=request.signal;entered();return new Promise<System1Result>(r=>finish=r);}}});
 const event={toolName:'bash',toolCallId:'call',input:{command:'echo hello'}},ctx={cwd:process.cwd()},pending=guard.call(event,ctx);
 await ready;guard.dispose();assert.equal(signal?.aborted,true);assert.equal((await pending).block,true);finish(verdict('not_severe'));assert.equal((await guard.call(event,ctx)).block,true);
});
for(const outcome of ['not-severe','unavailable','throw','held'])test(`baseline revoked during ${outcome} cannot allow stale effect`,async()=>{
 let baseline=true,entered!:()=>void,finish!:(result:System1Result)=>void,fail!:(error:Error)=>void;const ready=new Promise<void>(r=>entered=r);
 const guard=createDamageGuard({root:process.cwd(),config,state:createDamageState(()=>{}),binding:()=>({taskId:'task',inputRevision:'rev',owner:'hub',attempt:'attempt'}),canRead:()=>true,approve:async()=>true,service:{evaluate:async()=>{entered();return new Promise<System1Result>((resolve,reject)=>{finish=resolve;fail=reject;});}}});
 const event={toolName:'bash',toolCallId:'call',input:{command:'echo hello'}},ctx={cwd:process.cwd(),revalidateBaseline:()=>baseline},pending=guard.call(event,ctx);
 await ready;baseline=false;if(outcome==='throw')fail(Error('outage'));else finish(outcome==='unavailable'?{status:'unavailable',reason:'network'}:verdict(outcome==='held'?'severe':'not_severe'));
 assert.equal((await pending).block,true);guard.dispose();
});
