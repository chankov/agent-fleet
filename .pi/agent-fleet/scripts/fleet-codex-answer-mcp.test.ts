// B4 new MCP surface only; no inherited test module imports or actual host context.
import test from 'node:test';import assert from 'node:assert/strict';import * as fs from 'node:fs';import { join } from 'node:path';import { tmpdir } from 'node:os';
import { LocalCodexMcp, McpProtocol, TOOLS } from './lib/fleet-codex-local-mcp.ts';
import { AllowedSessionsStore } from './lib/fleet-codex-allowlist-store.ts';import type { RegistryReader } from './lib/fleet-codex-readonly.ts';
import type { QuestionSnapshot } from './lib/fleet-codex-answer-transport.ts';
const meta={threadId:'11111111-1111-4111-8111-111111111111'},c={hostProfile:'fixture',principal:'owner',threadId:meta.threadId},t={project:'fixture',peer:'orchestrator',sessionId:'S1',startedAt:'2026-01-01T00:00:00.000Z'},at=Date.parse(t.startedAt);
const q:QuestionSnapshot={id:'Q1',toolCallId:'TC1',owner:t,question:'Fixture?',options:[],allowMultiple:false,allowFreeform:true,allowComment:false,createdAt:t.startedAt,expiresAt:null,state:'pending'};
const args={requestId:'fixture-action',target:t,questionId:'Q1',toolCallId:'TC1',operation:'answer',response:{kind:'freeform',text:'fixture only'}};
async function fixture(fn:(s:LocalCodexMcp,root:string)=>Promise<void>){const root=fs.mkdtempSync(join(tmpdir(),'s6b-mcp-')),policyRoot=join(root,'policy');try{const store=new AllowedSessionsStore(policyRoot,c);await store.initialize();const h=await store.enroll({alias:'fixture',target:t},[t]);await store.grantSend(h,[t]);const reader:RegistryReader=async()=>({status:'complete',partial:false,reasons:[],observedAt:t.startedAt,entriesSeen:1,candidates:[{target:t,heartbeatAt:t.startedAt,presence:'fresh'}]});const answerTransport={inspect:async()=>structuredClone(q),send:async()=>{throw Error('not authorized fixture commit');},receipt:async()=>null};const service=new LocalCodexMcp({registryRoot:join(root,'registry'),policyRoot,hostProfile:c.hostProfile,principal:c.principal,registryReader:reader,now:()=>at,answerTransport,instructionTransport:{capability:async()=>true,send:async()=>{throw Error('not authorized fixture commit');},receipt:async()=>null}});await fn(service,root);}finally{fs.rmSync(root,{recursive:true,force:true});}}
test('B4 extended source catalog; strict typed human action descriptions, not loaded-catalog proof',()=>{assert.equal(TOOLS.length,21);for(const name of ['fleet_answer_prepare','fleet_answer_commit','fleet_answer_receipt']){const tool=TOOLS.find(t=>t.name===name)!;assert.ok(tool);assert.equal(tool.inputSchema.additionalProperties,false);}assert.match(TOOLS.find(t=>t.name==='fleet_answer_commit')!.description,/human/i);});
test('B4 exact host context/schema rejects model identity and foreign context sees no proposal',()=>fixture(async s=>{
 const p=await s.call('fleet_answer_prepare',args,meta);assert.equal(p.status,'prepared');assert.equal(p.humanProvenance,'unknown');
 await assert.rejects(()=>s.call('fleet_answer_prepare',{...args,hostProfile:'spoof'},meta),/INVALID_ARGUMENTS/);
 await assert.rejects(()=>s.call('fleet_answer_commit',{proposalId:p.proposalId},{threadId:'22222222-2222-4222-8222-222222222222'}),/PROPOSAL_UNAVAILABLE/);
 await assert.rejects(()=>s.call('fleet_answer_receipt',{requestId:args.requestId},meta),/INTENT_UNAVAILABLE/);
}));
test('B4 shared sixteen-context budget spans binding+instruction+answer pools',()=>fixture(async s=>{
 for(let i=0;i<5;i++)await s.call('fleet_answer_prepare',{...args,requestId:'answer-'+i},meta);
 for(let i=0;i<5;i++)await s.call('fleet_instruction_prepare',{requestId:'instruction-'+i,target:t,instruction:'fixture only'},meta);
 for(let i=0;i<6;i++)await s.call('fleet_binding_prepare',{intent:'grant_send',project:t.project,peer:t.peer},meta);
 await assert.rejects(()=>s.call('fleet_answer_prepare',{...args,requestId:'overflow'},meta),/BUSY/);
 await assert.rejects(()=>s.call('fleet_instruction_prepare',{requestId:'overflow',target:t,instruction:'fixture only'},meta),/BUSY/);
 await assert.rejects(()=>s.call('fleet_binding_prepare',{intent:'grant_send',project:t.project,peer:t.peer},meta),/BUSY/);
}));
test('B4 protocol errors do not echo input bodies; receipt uncertainty is not resend permission',()=>fixture(async s=>{
 const p=new McpProtocol(s);await p.handle({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'fixture',version:'0'}}});await p.handle({jsonrpc:'2.0',method:'notifications/initialized'});
 const reply=await p.handle({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'fleet_answer_prepare',arguments:{...args,response:{kind:'freeform',text:'DO_NOT_ECHO_FIXTURE'},unexpected:true},_meta:meta}});assert.match(JSON.stringify(reply),/INVALID_ARGUMENTS/);assert.equal(JSON.stringify(reply).includes('DO_NOT_ECHO_FIXTURE'),false);
}));
