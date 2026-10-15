import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createDamageApproval} from './damage-guard-approval.ts';
import {createDamageState} from './damage-guard-state.ts';
import {resetIdenticalDialogs} from '../lib/identical-dialog.ts';
const input={command:'echo hello'},action={taskId:'task',inputRevision:'rev',operation:'bash' as const,target:createHash('sha256').update(JSON.stringify(input)).digest('hex'),cwd:'/repo',actionId:'call',owner:'hub',attempt:'attempt'};
test('D6 exact human selection produces one-use grant; identical dialog is not repeated',async()=>{
 resetIdenticalDialogs();const records:unknown[]=[],state=createDamageState(row=>records.push(row));let asks=0,current=action;
 const approval=createDamageApproval({state,current:()=>current,baseline:()=>true,ask:async(id)=>{asks++;return {details:{runtimeAsk:{requestId:id},response:{kind:'selection',selections:['Allow once']}}};}});
 const grant=await approval.request(action,input);assert.equal(grant.status,'allowed');if(grant.status==='allowed'){assert.equal(approval.consume(grant.grant,action),true);assert.equal(approval.consume(grant.grant,action),false);}
 current={...action,actionId:'later',attempt:'later'};const again=await approval.request(current,input);assert.equal(again.status,'allowed');assert.equal(asks,1);
 if(again.status==='allowed')assert.equal(approval.consume(again.grant,current),true);
});
test('explicit denial remains durable and still requires a fresh dialog',async()=>{
 resetIdenticalDialogs();const state=createDamageState(()=>{});let selection='Deny',asks=0;
 const approval=createDamageApproval({state,current:()=>action,baseline:()=>true,ask:async(id)=>{asks++;return {details:{runtimeAsk:{requestId:id},response:{kind:'selection',selections:[selection]}}};}});
 assert.equal((await approval.request(action,input)).status,'denied');assert.equal(state.denied(action),true);
 selection='Allow once';const override=await approval.request(action,input);assert.equal(override.status,'allowed');assert.equal(asks,2);assert.equal(state.denied(action),true);
 if(override.status==='allowed')assert.equal(approval.consume(override.grant,action),true);
});
test('later denial invalidates old grants and the same action still coalesces',async()=>{
 resetIdenticalDialogs();const state=createDamageState(()=>{});let calls=0;
 const approval=createDamageApproval({state,current:()=>action,baseline:()=>true,ask:async(id)=>{calls++;return {details:{runtimeAsk:{requestId:id},response:{kind:'selection',selections:['Allow once']}}};}});
 const old=await approval.request(action,input);state.deny(action);
 if(old.status==='allowed')assert.equal(approval.consume(old.grant,action),false);
 const [one,two]=await Promise.all([approval.request(action,input),approval.request(action,input)]);assert.equal(one,two);assert.equal(calls,2);
 if(one.status==='allowed'&&two.status==='allowed'){assert.equal(approval.consume(one.grant,action),true);assert.equal(approval.consume(two.grant,action),false);}
});
test('changed authority/cancellation cannot produce grant',async()=>{
 resetIdenticalDialogs();const state=createDamageState(()=>{});let current=action;
 const approval=createDamageApproval({state,current:()=>current,baseline:()=>true,ask:async(id)=>{current={...action,attempt:'new'};return {details:{runtimeAsk:{requestId:id},response:{kind:'selection',selections:['Allow once']}}};}});
 assert.equal((await approval.request(action,input)).status,'cancelled');
});
