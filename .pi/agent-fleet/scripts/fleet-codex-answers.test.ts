// B3 domain fixtures: synthetic human responses, temp policy/action stores only.
import test from 'node:test';import assert from 'node:assert/strict';import * as fs from 'node:fs';import { join } from 'node:path';import { tmpdir } from 'node:os';
import { AnswerBridge, parseAnswer } from './lib/fleet-codex-answers.ts';
import { ActionLedger } from './lib/fleet-codex-instruction-store.ts';
import { AllowedSessionsStore } from './lib/fleet-codex-allowlist-store.ts';
import type { RegistryReader } from './lib/fleet-codex-readonly.ts';
import type { QuestionSnapshot, QuestionBinding, HumanResponse } from './lib/fleet-codex-answer-transport.ts';
const c={hostProfile:'fixture',principal:'fixture-owner',threadId:'A'},t={project:'fixture',peer:'orchestrator',sessionId:'S1',startedAt:'2026-01-01T00:00:00.000Z'},at=Date.parse('2026-01-01T00:01:00.000Z');
const snapshot:QuestionSnapshot={id:'Q1',toolCallId:'TC1',owner:t,question:'Fixture?',options:[{title:'Yes'},{title:'No'}],allowMultiple:false,allowFreeform:false,allowComment:false,createdAt:t.startedAt,expiresAt:null,state:'pending'};
const input={requestId:'fixture-action',target:t,questionId:'Q1',toolCallId:'TC1',operation:'answer',response:{kind:'selection',selections:['Yes']}};
async function fixture(fn:(f:{bridge:AnswerBridge;store:AllowedSessionsStore;root:string;sends:()=>number;setAfter:(v:()=>Promise<void>)=>void;setFailure:(v:boolean)=>void;setQuestion:(q:QuestionSnapshot)=>void;advance:()=>void})=>Promise<void>){
 const root=fs.mkdtempSync(join(tmpdir(),'s6b-domain-')),policyRoot=join(root,'policy');let sends=0,after=async()=>{},failure=false,mono=0,inspection=structuredClone(snapshot);
 const store=new AllowedSessionsStore(policyRoot,c);await store.initialize();const handle=await store.enroll({alias:'fixture',target:t},[t]);await store.grantSend(handle,[t]);
 const reader:RegistryReader=async()=>({status:'complete',partial:false,reasons:[],observedAt:new Date(at).toISOString(),entriesSeen:1,candidates:[{target:t,heartbeatAt:new Date(at).toISOString(),presence:'fresh'}]});
 const transport={inspect:async()=>structuredClone(inspection),send:async(_t:typeof t,_b:QuestionBinding,_a:HumanResponse,options:{beforeWrite:()=>Promise<void>})=>{await options.beforeWrite();sends++;if(failure)throw Error('fixture ACK lost');await after();return{state:'accepted' as const,detail:null,result:{outcome:_b.operation==='answer'?'answered' as const:'declined' as const,decisionAt:t.startedAt,observedAt:t.startedAt,source:'pi_question_rpc_v2' as const}};},receipt:async()=>null};
 const bridge=new AnswerBridge({policyRoot,registryReader:reader,transport,now:()=>at,monotonic:()=>mono});
 try{await fn({bridge,store,root,sends:()=>sends,setAfter:v=>after=v,setFailure:v=>failure=v,setQuestion:q=>inspection=structuredClone(q),advance:()=>mono=300001});}finally{fs.rmSync(root,{recursive:true,force:true});}
}
const proposal=(p:Record<string,unknown>)=>p.proposalId as string;
test('B3 prepare has full normalized exact preview but no durable attempt; same commit/history only once',()=>fixture(async f=>{
 const p=await f.bridge.prepare(c,input);assert.equal(p.status,'prepared');assert.equal(p.humanProvenance,'unknown');assert.equal(fs.existsSync(join(f.root,'policy.instructions')),false);
 const r=await f.bridge.commit(c,proposal(p));assert.equal((r.receipt as {state:string}).state,'accepted');assert.equal(f.sends(),1);assert.deepEqual(await f.bridge.commit(c,proposal(p)),r);
 assert.equal((await f.bridge.prepare(c,input)).status,'historical');assert.equal(f.sends(),1);
 const state=await f.store.open();await f.store.revoke('fixture',state.revision);assert.equal((await f.bridge.prepare(c,input)).status,'historical');
 assert.throws(()=>new ActionLedger(join(f.root,'policy.instructions')).lookup(c,input.requestId),/INTENT_CONFLICT/);
}));
test('B3 changed operation/payload/owner/toolCall conflicts before I/O; B cannot see A',()=>fixture(async f=>{
 const p=await f.bridge.prepare(c,input);await f.bridge.commit(c,proposal(p));
 for(const delta of [{operation:'refusal',response:null},{response:{kind:'selection',selections:['No']}},{target:{...t,sessionId:'S2'}},{toolCallId:'TC2'}])await assert.rejects(()=>f.bridge.prepare(c,{...input,...delta}),/INTENT_CONFLICT/);
 await assert.rejects(()=>f.bridge.receipt({...c,threadId:'B'},{requestId:input.requestId}),/INTENT_UNAVAILABLE/);assert.equal(f.sends(),1);
}));
test('B3 flags/identity/extra input is rejected and TTL/cancel cannot commit',()=>fixture(async f=>{
 for(const delta of [{response:{kind:'freeform',text:'bad'}},{response:{kind:'selection',selections:['Yes','No']}},{response:{kind:'selection',selections:['Yes'],comment:'bad'}},{toolCallId:'wrong'}])await assert.rejects(()=>f.bridge.prepare(c,{...input,...delta}));
 assert.throws(()=>parseAnswer({...input,threadId:'fake'}),/INVALID_ARGUMENTS/);
 const p=await f.bridge.prepare(c,input);f.advance();await assert.rejects(()=>f.bridge.commit(c,proposal(p)),/PROPOSAL_UNAVAILABLE/);assert.equal(f.sends(),0);
}));
test('B3 after-attempt loss stays unknown and duplicate cannot deliver again',()=>fixture(async f=>{
 const p=await f.bridge.prepare(c,input);f.setFailure(true);await assert.rejects(()=>f.bridge.commit(c,proposal(p)));const r=await f.bridge.prepare(c,input);assert.equal((r.receipt as {state:string}).state,'unknown');assert.equal((r.receipt as {attempted:boolean}).attempted,true);assert.equal(f.sends(),1);
}));
test('B3 post-read revoke withholds new outcome from response AND ledger',()=>fixture(async f=>{
 const p=await f.bridge.prepare(c,input);f.setAfter(async()=>{const s=await f.store.open();await f.store.revoke('fixture',s.revision);});const r=await f.bridge.commit(c,proposal(p));const receipt=r.receipt as {state:string;result:unknown};assert.equal(receipt.state,'unknown');assert.equal(receipt.result,null);
 const local=new ActionLedger(join(f.root,'policy.instructions')).lookupAction(c,input.requestId)!;assert.equal(local.state,'unknown');assert.equal(local.result,null);
}));
test('B3 malformed or secret-bearing inspect payload is never published as a human preview',()=>fixture(async f=>{
 f.setQuestion({...snapshot,question:'password=synthetic_fixture_secret'});await assert.rejects(()=>f.bridge.prepare(c,input),/QUESTION_CHANGED/);assert.equal(f.sends(),0);
}));
test('B3 refusal differs from negative option; synthetic provenance is not human attestation',()=>fixture(async f=>{
 const p=await f.bridge.prepare(c,{...input,operation:'refusal',response:null});const r=await f.bridge.commit(c,proposal(p));assert.equal((r.receipt as {result:{outcome:string}}).result.outcome,'declined');assert.equal(f.sends(),1);
}));
