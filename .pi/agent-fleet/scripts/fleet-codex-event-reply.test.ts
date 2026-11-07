import test from 'node:test';import assert from 'node:assert/strict';import {replyFleetEvent as rawReplyFleetEvent} from './lib/fleet-codex-event-reply.ts';import {targetKey} from './lib/fleet-codex-instruction-store.ts';
const target={project:'fixture',peer:'hub',sessionId:'session',startedAt:'2026-11-04T00:00:00Z'},binding={id:'binding',epoch:'epoch',hostInstance:'fixture',threadId:'11111111-1111-4111-8111-111111111111',fleetOwner:targetKey(target)};
function replyFleetEvent(event:any,target:any,reply:any,ports:any){return rawReplyFleetEvent(event,target,reply,{nativeIdentity:()=>({threadId:'11111111-1111-4111-8111-111111111111',identityAssurance:'host_context_validated'}),...ports});}
const event=(kind:'message'|'question'|'permission')=>({id:'event',kind,bindingId:binding.id,bindingEpoch:binding.epoch,fleetOwner:binding.fleetOwner,createdAt:Date.now(),deadline:Date.now()+30000,reference:'fleet:'+kind+'/source'+(kind==='question'?'/tool':'')});
test('question prepares actual human workflow, never auto commits or turns refusal into access denial',async()=>{
 const calls:string[]=[],ports={currentBinding:()=>binding,invoke:async(name:string,args:any)=>{calls.push(name);assert.equal(args.operation,'refusal');return {proposalId:'proposal'};}};
 const result=await replyFleetEvent(event('question'),target,{kind:'question',response:null},ports);assert.equal(result.status,'human_confirmation_required');assert.deepEqual(calls,['fleet_answer_prepare']);
 await assert.rejects(replyFleetEvent(event('permission'),target,{kind:'question',response:null},ports),/wrong_kind/);assert.equal(calls.length,1);
});
test('permission reply re-inspects full action before deciding, binds epoch and never retries unknown',async()=>{
 const calls:string[]=[],snapshot={id:'source',owner:target},ports={currentBinding:()=>binding,invoke:async(name:string,args:any)=>{calls.push(name+':'+(args.operation??''));if(args.operation==='list')return {status:'ok',requests:[{snapshot}]};if(args.operation==='inspect')return {status:'ok',state:{status:'pending'},view:{snapshot}};return {reservation:{state:'unknown'}};}};
 const result=await replyFleetEvent(event('permission'),target,{kind:'permission',decision:'deny',reason:'fixture task does not require this action'},ports);assert.equal(result.status,'machine_decision_returned');assert.equal(result.piEffect,'not_established');assert.deepEqual(calls,['fleet_permissions:list','fleet_permissions:inspect','fleet_permission_decide:']);
 await assert.rejects(replyFleetEvent({...event('permission'),deadline:Date.now()-1},target,{kind:'permission',decision:'deny',reason:'fixture'},ports),/stale/);assert.equal(calls.length,3);
});
test('malformed pending inspection is a structured refusal, not a TypeError or decision',async()=>{
 const snapshot={id:'source',owner:target};let decisions=0;
 await assert.rejects(replyFleetEvent(event('permission'),target,{kind:'permission',decision:'allow_once',reason:'fixture necessary'},{currentBinding:()=>binding,invoke:async(name,args:any)=>{if(args.operation==='list')return {status:'ok',requests:[{snapshot}]};if(args.operation==='inspect')return {status:'ok',state:{status:'pending'}};decisions++;return {};}}),/permission_changed/);assert.equal(decisions,0);
});

test('binding metadata alone cannot impersonate the ACTUAL native chat identity',async()=>{
 let invoked=0;for(const nativeIdentity of [()=>null,()=>({threadId:'22222222-2222-4222-8222-222222222222',identityAssurance:'host_context_validated'})])await assert.rejects(replyFleetEvent(event('permission'),target,{kind:'permission',decision:'deny',reason:'fixture'},{currentBinding:()=>binding,nativeIdentity,invoke:async()=>{invoked++;}}),/stale/);assert.equal(invoked,0);
});

test('message result is machine summary only, not an implicit Pi instruction or human approval',async()=>{
 const result=await replyFleetEvent(event('message'),target,{kind:'message',summary:'fixture result'},{currentBinding:()=>binding,invoke:async()=>assert.fail('no message-to-command conversion')});assert.equal(result.status,'summary_only');assert.equal(result.humanConsent,false);
});
