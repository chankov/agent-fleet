import test from 'node:test';
import assert from 'node:assert/strict';
import {resetIdenticalDialogs} from '../lib/identical-dialog.ts';
test.beforeEach(()=>resetIdenticalDialogs());
import {createDamageState} from './damage-guard-state.ts';
import {createDamageApproval} from './damage-guard-approval.ts';
import {createDamageGuard} from '../damage-control-continue/system1-guard.ts';
import {createHash} from 'node:crypto';
import {parseDamageGuardConfig} from '../lib/system1/config-damage-guard.js';
test('matching override is one attempt, not durable erasure of an explicit deny during off/outage',async()=>{
 const rows:unknown[]=[],state=createDamageState(row=>rows.push(row)),event={toolName:'bash',toolCallId:'held',input:{command:'echo hello'}},ctx={cwd:process.cwd(),revalidateBaseline:()=>true};
 const guard=createDamageGuard({root:process.cwd(),config:parseDamageGuardConfig({mode:'off'}),state,binding:()=>({taskId:'task',inputRevision:'rev',owner:'hub',attempt:'attempt'}),canRead:()=>true,approve:async()=>false});
 const action=guard.action(event,ctx);state.deny(action);
 const approval=createDamageApproval({state,current:()=>action,baseline:()=>true,ask:async id=>({details:{runtimeAsk:{requestId:id},response:{kind:'selection',selections:['Allow once']}}})});
 const result=await approval.request(action,event.input);assert.equal(result.status,'allowed');if(result.status!=='allowed')throw Error('expected correlated grant');
 assert.equal(approval.consume(result.grant,action),true);assert.equal(approval.consume(result.grant,action),false);
 assert.equal(state.denied(action),true,'one human override must not erase the original durable deny');
 const restored=createDamageState(()=>{});restored.restore(rows);assert.equal(restored.denied(action),true);
 assert.equal((await guard.call({...event,toolCallId:'retry'},ctx)).block,true);guard.dispose();
});
test('a newer denial invalidates grants across independent owners and factories even after a later override',async()=>{
 // A different owner asks a distinct question; identical same-owner dialogs reuse by policy.
 const state=createDamageState(()=>{}),input={command:'echo hello'},base={taskId:'task',inputRevision:'rev',operation:'bash' as const,target:createHash('sha256').update(JSON.stringify(input)).digest('hex'),cwd:process.cwd(),owner:'hub',attempt:'run'},a={...base,actionId:'a'},b={...base,actionId:'b',owner:'second-owner'};
 const make=(action:typeof a,selection:string)=>createDamageApproval({state,current:()=>action,baseline:()=>true,ask:async id=>({details:{runtimeAsk:{requestId:id},response:{kind:'selection',selections:[selection]}}})});
 const first=make(a,'Allow once'),old=await first.request(a,input);assert.equal(old.status,'allowed');assert.equal((await make(b,'Deny').request(b,input)).status,'denied');
 const second=make(b,'Allow once'),next=await second.request(b,input);assert.equal(next.status,'allowed');if(next.status==='allowed')assert.equal(second.consume(next.grant,b),true);
 if(old.status==='allowed')assert.equal(first.consume(old.grant,a),false);assert.equal(state.denied(a),true);
});
test('object-key order cannot bypass a denial, including old raw JSON fingerprints',async()=>{
 const input={path:'docs/a.txt',content:'public fixture'},state=createDamageState(()=>{}),guard=createDamageGuard({root:process.cwd(),config:parseDamageGuardConfig({mode:'off'}),state,binding:()=>({taskId:'task',inputRevision:'rev',owner:'hub',attempt:'run'}),canRead:()=>true,approve:async()=>false}),ctx={cwd:process.cwd(),revalidateBaseline:()=>true};
 const first={toolName:'write',toolCallId:'a',input},action=guard.action(first,ctx),reordered={...first,toolCallId:'b',input:{content:input.content,path:input.path}};
 state.deny(action);assert.equal((await guard.call(reordered,ctx)).block,true);
 state.restore([{schema:'damage-denial/v1',taskId:action.taskId,inputRevision:action.inputRevision,operation:action.operation,target:createHash('sha256').update(JSON.stringify(input)).digest('hex'),cwd:action.cwd,decision:'deny'}]);
 assert.equal((await guard.call(reordered,ctx)).block,true);guard.dispose();
});
