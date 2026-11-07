import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CodexDesktopQueueHost,desktopQueuePin,type DesktopQueueApproval} from './lib/codex-desktop-queue-host.ts';
import {notificationPreview,type NotificationConfig} from './lib/fleet-codex-event-runtime.ts';
import type {CodexUnixQueueRpc} from './lib/codex-unix-queue-rpc.ts';
import {targetKey} from './lib/fleet-codex-instruction-store.ts';
import {TOOLS} from './lib/fleet-codex-local-mcp.ts';

// Synthetic unit data only: no runtime owner, real host mapping, socket or consumer.
const now=Date.UTC(2026,10,6);
const owner={project:'offline-unit',peer:'fixture',sessionId:'synthetic-unit-owner',startedAt:'2026-11-06T00:00:00.000Z'};
const versions=['0.166.0-alpha.5.1','0.166.0-alpha.6'];
const addSchema='60f25b7d3e3357c215bef9d2fe7047200f545e030dca9e00527ac0620cd0c88f';
const responseSchema='c11b9772788427b19c9f9decf0765e2b41cbdead1aa9c3d39f42fdd70b339314';
function fixture(t:TestContext,desktopVersion:string){
 t.mock.method(Date,'now',()=>now);
 const root=mkdtempSync(join(tmpdir(),'desktop-compat-unit-'));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const binding={id:'offline-unit',epoch:'synthetic-unit-epoch',hostInstance:'operator-unit-label',threadId:'11111111-1111-4111-8111-111111111111',fleetOwner:targetKey(owner)};
 const config:NotificationConfig={optedIn:true,stateRoot:join(root,'state'),socketPath:'/offline-unit-unused.sock',messageBudgetMs:30000,
  loadedCatalog:{tools:TOOLS.map(t=>({name:t.name})),identity:'host_context_validated',nodeVersion:'25.2.1',protocolVersion:'2025-06-18'},
  approval:{binding,target:{...owner},authorityRevision:1,confirmedUntil:now+60000,transportOrigin:'user_input',mappingEvidence:'externally_confirmed_loaded_desktop',daemonVersion:'0.166.0',desktopVersion,addSchema,responseSchema}};
 const calls:Array<{method:string;params:Record<string,unknown>}>=[];
 let duringRead=()=>{};
 let result:unknown={thread:{id:binding.threadId,status:{type:'notLoaded'}}};
 const rpc:Pick<CodexUnixQueueRpc,'request'>={async request(method,params,options){
  calls.push({method,params});
  if(method==='thread/queue/add'){
   options?.beforeWrite?.();
   return {queuedSubmission:{id:'offline-text-submission',clientUserMessageId:params.clientUserMessageId,input:params.input}};
  }
  duringRead();
  return result;
 }};
 const host=new CodexDesktopQueueHost({rpc,stateRoot:config.stateRoot,currentApproval:()=>config.approval});
 return {config,binding,calls,host,setDuringRead(fn:()=>void){duringRead=fn;},setResult(value:unknown){result=value;}};
}

test('legacy exported pin is preserved; support is additive',()=>{
 assert.equal(desktopQueuePin.desktop,'0.166.0-alpha.5.1');
 assert.equal(desktopQueuePin.daemon,'0.166.0');
 assert.equal(desktopQueuePin.addSchema,addSchema);
 assert.equal(desktopQueuePin.responseSchema,responseSchema);
});
for(const version of versions){
 test(`${version}: preview admits exact tuple without granting or activating`,t=>{
  const f=fixture(t,version),p=notificationPreview(f.config,owner);
  assert.equal(p.ready,true);assert.equal(p.mappingValid,true);
  assert.equal(p.activation,'not_performed');assert.equal(p.startsDaemon,false);
  assert.equal(p.grantsApprove,false);assert.equal(p.requiresExplicitUserEnable,true);
  assert.equal(f.calls.length,0);
 });
 test(`${version}: host verify accepts exact tuple using only an in-memory stub`,async t=>{
  const f=fixture(t,version);
  assert.equal(await f.host.verify(f.binding,new AbortController().signal),true);
  assert.deepEqual(f.calls,[{method:'thread/read',params:{threadId:f.binding.threadId,includeTurns:false}}]);
 });
 const invalid:Array<[string,(c:NotificationConfig)=>void]>=[
  ['wrong daemon',c=>{c.approval.daemonVersion='0.166.1';}],
  ['unlisted Desktop',c=>{c.approval.desktopVersion='0.166.0-alpha.7';}],
  ['Desktop suffix is not normalized',c=>{c.approval.desktopVersion='0.166.0-alpha.6+local';}],
  ['Desktop prefix is not a range',c=>{c.approval.desktopVersion='0.166.0-alpha.6.1';}],
  ['wrong add schema',c=>{c.approval.addSchema='0'.repeat(64);}],
  ['wrong response schema',c=>{c.approval.responseSchema='0'.repeat(64);}],
  ['missing add schema',c=>{c.approval.addSchema='';}],
  // Deliberately corrupt private synthetic snapshots to exercise runtime validation.
  ['wrong target owner',c=>{Object.assign(c.approval.target,{sessionId:'different-owner'});}],
  ['wrong binding owner',c=>{Object.assign(c.approval.binding,{fleetOwner:'different-owner'});}],
  ['expired approval',c=>{c.approval.confirmedUntil=now-1;}],
  ['expiry equality is closed',c=>{c.approval.confirmedUntil=now;}],
  ['missing mapping confirmation',c=>{c.approval.mappingEvidence='unconfirmed' as DesktopQueueApproval['mappingEvidence'];}],
  ['wrong transport origin',c=>{c.approval.transportOrigin='tool_output' as DesktopQueueApproval['transportOrigin'];}],
  ['invalid authority revision',c=>{c.approval.authorityRevision=0;}],
 ];
 for(const [name,mutate] of invalid)test(`${version}: rejects ${name} before any stub request`,async t=>{
  const f=fixture(t,version);mutate(f.config);
  assert.equal(notificationPreview(f.config,owner).ready,false);
  assert.equal(await f.host.verify(f.binding,new AbortController().signal),false);
  assert.equal(f.calls.length,0);
 });
 test(`${version}: preview rejects a different current owner`,t=>{
  const f=fixture(t,version);
  assert.equal(notificationPreview(f.config,{...owner,sessionId:'different-current-owner'}).ready,false);
  assert.equal(f.calls.length,0);
 });
 test(`${version}: stale binding epoch fails closed`,async t=>{
  const f=fixture(t,version);
  assert.equal(await f.host.verify({...f.binding,epoch:'stale-epoch'},new AbortController().signal),false);
  assert.equal(f.calls.length,0);
 });
 test(`${version}: aborted verification does not call the stub`,async t=>{
  const f=fixture(t,version),abort=new AbortController();abort.abort();
  assert.equal(await f.host.verify(f.binding,abort.signal),false);
  assert.equal(f.calls.length,0);
 });
 test(`${version}: expiry during mocked metadata read is rechecked`,async t=>{
  const f=fixture(t,version);f.setDuringRead(()=>{f.config.approval.confirmedUntil=now;});
  assert.equal(await f.host.verify(f.binding,new AbortController().signal),false);
  assert.equal(f.calls.length,1);
 });
 test(`${version}: owner change during mocked metadata read is rechecked`,async t=>{
  const f=fixture(t,version);f.setDuringRead(()=>{Object.assign(f.config.approval.target,{sessionId:'changed-after-read'});});
  assert.equal(await f.host.verify(f.binding,new AbortController().signal),false);
  assert.equal(f.calls.length,1);
 });
}
for(const [name,result] of [
 ['daemon-loaded',{thread:{id:'11111111-1111-4111-8111-111111111111',status:{type:'idle'}}}],
 ['wrong thread',{thread:{id:'22222222-2222-4222-8222-222222222222',status:{type:'notLoaded'}}}],
 ['unknown response',null],
] as const)test(`metadata remains fail-closed: ${name}`,async t=>{
 const f=fixture(t,'0.166.0-alpha.5.1');f.setResult(result);
 assert.equal(await f.host.verify(f.binding,new AbortController().signal),false);
 assert.equal(f.calls.length,1);
});


const mixedDesktopVersion='0.167.0-alpha.3.2';
const desktopAddSchema='f6466a8f06cd4e68ec1999d06a0d70a1ddc339c0cb1baf12ee966a999fead17c';
const desktopResponseSchema='896a82716b432a8aa4d190591bcfa86adacdacb91ec5ec2c9c75ff6562561256';
test('measured mixed-version tuple admits text with exact schemas from both endpoints',async t=>{
 const f=fixture(t,mixedDesktopVersion);
 Object.assign(f.config.approval,{desktopAddSchema,desktopResponseSchema});
 assert.equal(notificationPreview(f.config,owner).ready,true);
 assert.equal(await f.host.verify(f.binding,new AbortController().signal),true);
 assert.deepEqual(f.calls,[{method:'thread/read',params:{threadId:f.binding.threadId,includeTurns:false}}]);
});
test('mixed-version tuple emits one text probe and deduplicates its acknowledgement',async t=>{
 const f=fixture(t,mixedDesktopVersion);
 Object.assign(f.config.approval,{desktopAddSchema,desktopResponseSchema});
 const event={
  id:'offline-mixed-probe',kind:'message' as const,bindingId:f.binding.id,bindingEpoch:f.binding.epoch,
  fleetOwner:f.binding.fleetOwner,createdAt:now,deadline:now+30_000,reference:'fleet:probe/offline-mixed-probe',
 };
 const signal=new AbortController().signal;
 const sent=await f.host.deliverExternal(f.binding,event,signal);
 assert.deepEqual(sent,{status:'queue_accepted',submissionId:'offline-text-submission',transportOrigin:'user_input',historical:false});
 assert.deepEqual(await f.host.deliverExternal(f.binding,event,signal),{...sent,historical:true});
 assert.deepEqual(f.calls.map(({method})=>method),['thread/read','thread/queue/add']);
 const input=f.calls[1].params.input as Array<{type:string;text:string;text_elements:unknown[]}>;
 assert.deepEqual(input.map(({type,text_elements})=>({type,text_elements})),[{type:'text',text_elements:[]}]);
 const envelope=JSON.parse(input[0].text.split('\n')[1]);
 assert.equal(envelope.expectedReply,'FLEET_PROBE_ACK offline-mixed-probe');
 assert.equal(envelope.humanApproval,false);
});
for(const [label,version,pins] of [
 ['absent Desktop evidence',mixedDesktopVersion,{}],
 ['partial Desktop evidence',mixedDesktopVersion,{desktopAddSchema}],
 ['wrong Desktop add hash',mixedDesktopVersion,{desktopAddSchema:addSchema,desktopResponseSchema}],
 ['wrong Desktop response hash',mixedDesktopVersion,{desktopAddSchema,desktopResponseSchema:responseSchema}],
 ['wrong daemon add hash',mixedDesktopVersion,{desktopAddSchema,desktopResponseSchema,addSchema:desktopAddSchema}],
 ['wrong daemon response hash',mixedDesktopVersion,{desktopAddSchema,desktopResponseSchema,responseSchema:desktopResponseSchema}],
 ['unlisted newer Desktop','0.167.0-alpha.3.3',{desktopAddSchema,desktopResponseSchema}],
 ['extraneous Desktop evidence on legacy tuple','0.166.0-alpha.6',{desktopAddSchema,desktopResponseSchema}],
 ['unexpected approval field',mixedDesktopVersion,{desktopAddSchema,desktopResponseSchema,unexpected:true}],
] as const)test(`mixed schema gate rejects ${label}`,async t=>{
 const f=fixture(t,version);
 Object.assign(f.config.approval,pins);
 assert.equal(notificationPreview(f.config,owner).ready,false);
 if(label!=='unexpected approval field'){
  assert.equal(await f.host.verify(f.binding,new AbortController().signal),false);
  assert.deepEqual(f.calls,[]);
 }
});
