import test from 'node:test';import assert from 'node:assert/strict';import {replyFleetEvent as rawReplyFleetEvent} from './lib/fleet-codex-event-reply.ts';import {targetKey} from './lib/fleet-codex-instruction-store.ts';
const target={project:'fixture',peer:'hub',sessionId:'session',startedAt:'2026-11-04T00:00:00Z'},binding={id:'binding',epoch:'epoch',hostInstance:'fixture',threadId:'11111111-1111-4111-8111-111111111111',fleetOwner:targetKey(target)};
function replyFleetEvent(event:any,target:any,reply:any,ports:any){return rawReplyFleetEvent(event,target,reply,{nativeIdentity:()=>({threadId:'11111111-1111-4111-8111-111111111111',identityAssurance:'host_context_validated'}),...ports});}
const event=(kind:'message'|'question'|'permission')=>({id:'event',kind,bindingId:binding.id,bindingEpoch:binding.epoch,fleetOwner:binding.fleetOwner,createdAt:Date.now(),deadline:Date.now()+30000,reference:'fleet:'+kind+'/source'+(kind==='question'?'/tool':'')});
test('question prepares actual human workflow, never auto commits or turns refusal into access denial',async()=>{
 const calls:string[]=[],ports={currentBinding:()=>binding,invoke:async(name:string,args:any)=>{calls.push(name);assert.equal(args.operation,'refusal');return {proposalId:'proposal'};}};
 const result=await replyFleetEvent(event('question'),target,{kind:'question',response:null},ports);assert.equal(result.status,'human_confirmation_required');assert.deepEqual(calls,['fleet_answer_prepare']);
 await assert.rejects(replyFleetEvent(event('permission'),target,{kind:'question',response:null},ports),/wrong_kind/);assert.equal(calls.length,1);
});
test('versioned question replies preserve the exact opaque ID and still require fresh human confirmation',async()=>{
 for(const toolCallId of ['call_x|fc_y','call/x:y%2Fz',' въпрос 🧪 ','\ud800','\uffff'.repeat(256)]){
  const e={...event('question'),reference:'fleet:question:v2/source/'+Buffer.from(toolCallId,'utf16le').toString('base64url')};
  const calls:any[]=[];const ports={currentBinding:()=>binding,invoke:async(name:string,args:any)=>{calls.push({name,args});return {proposalId:'actual-proposal'};}};
  const prepared=await replyFleetEvent(e,target,{kind:'question',response:null},ports);
  assert.equal(prepared.status,'human_confirmation_required');assert.equal(calls.length,1);
  assert.equal(calls[0].name,'fleet_answer_prepare');assert.equal(calls[0].args.questionId,'source');assert.equal(calls[0].args.toolCallId,toolCallId);
  calls.length=0;
  const committed=await replyFleetEvent(e,target,{kind:'question',response:null},{...ports,confirmHuman:async()=>true});
  assert.equal(committed.status,'question_commit_returned');assert.deepEqual(calls.map(c=>c.name),['fleet_answer_prepare','fleet_answer_commit']);
 }
});
test('malformed v2 question references never invoke a native action or human callback',async()=>{
 let invoked=0,confirmed=0;
 const encoded=(id:string)=>'fleet:question:v2/source/'+Buffer.from(id,'utf16le').toString('base64url');
 for(const reference of [encoded('\n'),encoded('x'.repeat(257)),encoded('|')+'=',encoded('|')+'/extra','fleet:question:v2/source/fAB']){
  await assert.rejects(replyFleetEvent({...event('question'),reference},target,{kind:'question',response:null},{currentBinding:()=>binding,invoke:async()=>{invoked++;},confirmHuman:async()=>{confirmed++;return true;}}),/reference_invalid/);
 }
 assert.equal(invoked,0);assert.equal(confirmed,0);
});
test('v2 question reply still rechecks deadline and binding after prepare and human confirmation',async()=>{
 const reference='fleet:question:v2/source/'+Buffer.from('call|fc','utf16le').toString('base64url');
 const e={...event('question'),reference};let committed=0,confirmed=0;
 await assert.rejects(replyFleetEvent(e,target,{kind:'question',response:null},{currentBinding:()=>binding,invoke:async(name:string)=>{if(name==='fleet_answer_prepare'){e.deadline=Date.now()-1;return {proposalId:'p'};}committed++;},confirmHuman:async()=>{confirmed++;return true;}}),/event_reply_expired/);
 assert.equal(committed,0);assert.equal(confirmed,0);
 let current={...binding};
 await assert.rejects(replyFleetEvent({...event('question'),reference},target,{kind:'question',response:null},{currentBinding:()=>current,invoke:async(name:string)=>{if(name==='fleet_answer_prepare')return {proposalId:'p'};committed++;},confirmHuman:async()=>{current={...binding,epoch:'rebound'};return true;}}),/event_reply_expired/);
 assert.equal(committed,0);
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
