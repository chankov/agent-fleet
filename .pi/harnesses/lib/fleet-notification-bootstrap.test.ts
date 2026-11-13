import test from 'node:test';
import assert from 'node:assert/strict';
import {NotificationBootstrap,type BootstrapServices,type BootstrapInspection,type BootstrapRight} from './fleet-notification-bootstrap.ts';
import {notificationToolNames} from './fleet-codex-catalog.ts';
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
const namespace={hostProfile:'desktop',principal:'fixture',threadId:A};
const owner={project:'fixture',peer:'orchestrator',sessionId:'fixture-owner',startedAt:'2026-11-01T00:00:00Z'};
const deferred=<T>()=>{let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};};
function fixture(){
 const state={owner:{...owner},now:Date.parse('2026-11-11T00:00:00Z'),mono:100,confirm:true,calls:[] as string[],review:null as any,rights:{revision:0,rights:[] as BootstrapRight[],status:'not_connected'} as any};
 const inspection:BootstrapInspection={hostInstance:'fixture-desktop-instance',identity:'host_context_validated',probeReadCapability:'verified_without_loading',catalog:{identity:'host_context_validated',protocolVersion:'2025-06-18',tools:notificationToolNames.map(name=>({name}))},assessment:{level:'contract_checked',fingerprint:'a'.repeat(64),context:{daemonVersion:'0.167.1',desktopVersion:'0.167.0-alpha.3.2',socketEpoch:'socket:epoch:1'},requiresProbe:true,activation:'not_performed'},rights:state.rights};
 const services:BootstrapServices={owner:()=>state.owner,now:()=>state.now,monotonic:()=>state.mono,
  inspect:async()=>{state.calls.push('inspect');return {...structuredClone(inspection),rights:structuredClone(state.rights)};},
  confirm:async review=>{state.calls.push('confirm');state.review=review;return state.confirm;},
  codexWriteRights:async request=>{state.calls.push('codex-write');assert.equal(request.expected.revision,state.rights.revision);state.rights={revision:state.rights.revision+1,rights:[...request.scope.rights],status:'active',expiresAt:request.scope.until};return structuredClone(state.rights);},
  probe:async request=>{state.calls.push('probe');return {status:'acknowledged',source:'read_only_assistant_transcript',probeId:request.probeId,threadId:request.scope.namespace.threadId,hostInstance:request.scope.binding.hostInstance,...request.assessment.context,notLoadedBefore:true,notLoadedAfter:true,receiptId:'fixture-assistant-item'};},
  activate:async()=>{state.calls.push('activate');return {enabled:true};},
  disable:async()=>{state.calls.push('disable');},
 };
 return {state,inspection,services,make:()=>new NotificationBootstrap(services),until:()=>state.now+12*3600000};
}
const prepared=async(f:ReturnType<typeof fixture>,port:NotificationBootstrap,c=namespace,rights?:BootstrapRight[])=>{const p=await port.prepare(c,f.until(),rights);assert.equal(p.status,'prepared');assert.ok('proposalId'in p);return p as Extract<typeof p,{proposalId:string}>;};

test('read-only prepare/status then exactly one Pi confirm, Codex write, probe and activation',async()=>{
 const f=fixture(),port=f.make(),p=await prepared(f,port,namespace,['read','send','approve']);
 assert.deepEqual(f.state.calls,['inspect']);const before=[...f.state.calls];port.rows();port.rows();assert.deepEqual(f.state.calls,before);
 const [a,b]=await Promise.all([port.commit(p.proposalId),port.commit(p.proposalId)]);
 assert.deepEqual(a,b);assert.equal(a.status,'enabled');assert.equal(a.activation,'enabled');assert.equal(a.grantsApproveAutomatically,false);
 assert.deepEqual(f.state.calls.filter(c=>c!=='inspect'),['confirm','codex-write','probe','activate']);
 assert.equal(f.state.review.probeConsumesModelTurn,true);assert.deepEqual(f.state.review.scope.rights,['read','send','approve']);
 await port.commit(p.proposalId);assert.equal(f.state.calls.filter(c=>c==='probe').length,1);
 assert.equal(port.rows()[0].state,'enabled');
});

test('declined Pi confirmation is not a model flag and never writes rights or probe',async()=>{
 const f=fixture();f.state.confirm=false;const port=f.make(),p=await prepared(f,port);
 assert.equal((await port.commit(p.proposalId)).status,'cancelled');await port.commit(p.proposalId);
 assert.deepEqual(f.state.calls.filter(c=>c!=='inspect'),['confirm']);
 assert.equal(f.state.rights.revision,0);
});

test('missing no-load reader, invalid identity/catalog or incompatible evidence is blocked before UI',async()=>{
 for(const change of [
  (v:any)=>{v.probeReadCapability='unavailable';},(v:any)=>{v.identity='model_claim';},
  (v:any)=>{v.catalog.protocolVersion='unknown';},(v:any)=>{v.assessment={level:'blocked',reason:'used_contract_changed',activation:'not_performed'};},
  (v:any)=>{v.assessment.level='ready';},
 ]){const f=fixture();change(f.inspection);const p=await f.make().prepare(namespace,f.until());assert.equal(p.status,'blocked');assert.deepEqual(f.state.calls,['inspect']);}
});

test('post-confirm owner/socket/rights drift cannot proceed to a Codex write',async()=>{
 for(const drift of ['owner','socket','rights']){
  const f=fixture();f.services.confirm=async()=>{f.state.calls.push('confirm');if(drift==='owner')f.state.owner={...owner,sessionId:'new-owner'};else if(drift==='rights')f.state.rights={...f.state.rights,revision:9};else (f.inspection.assessment as any).context.socketEpoch='socket:changed';return true;};
  const port=f.make(),p=await prepared(f,port);assert.equal((await port.commit(p.proposalId)).status,'rejected');assert.equal(f.state.calls.includes('codex-write'),false);
 }
});

test('disable aborts an ignored probe promptly and cannot resurrect activation',async()=>{
 const f=fixture(),entered=deferred<void>(),release=deferred<void>(),base=f.services.probe;
 f.services.probe=async(request,signal)=>{entered.resolve();await release.promise;return base(request,signal);};
 const port=f.make(),p=await prepared(f,port),work=port.commit(p.proposalId);await entered.promise;
 assert.equal((await port.disable(namespace)).status,'disabled');
 const result=await Promise.race([work,new Promise<never>((_,reject)=>setTimeout(()=>reject(Error('disable did not cancel')),250))]);
 assert.equal(result.status,'partially_applied_or_unknown');assert.equal(result.rightsCommitted,true);assert.equal(result.activation,'not_performed');
 release.resolve();await new Promise(r=>setImmediate(r));assert.equal(f.state.calls.includes('activate'),false);assert.equal(port.rows()[0].state,'disabled');
});

test('wrong probe receipt has no activation and no automatic retry',async()=>{
 const f=fixture(),base=f.services.probe;f.services.probe=async(request,signal)=>({...await base(request,signal),threadId:B} as any);
 const port=f.make(),p=await prepared(f,port),a=await port.commit(p.proposalId);assert.equal(a.status,'partially_applied_or_unknown');assert.equal(a.reason,'probe_context_mismatch');
 assert.equal(a.activation,'not_performed');await port.commit(p.proposalId);assert.equal(f.state.calls.filter(c=>c==='probe').length,1);assert.equal(f.state.calls.includes('activate'),false);
});

test('uncertain effects are reported unknown rather than fabricated commit/activation success',async()=>{
 const f=fixture();f.services.codexWriteRights=async()=>{f.state.calls.push('codex-write');throw Error('write_uncertain');};
 const port=f.make(),p=await prepared(f,port),result=await port.commit(p.proposalId);
 assert.equal(result.rightsCommitted,'unknown');assert.equal(result.activation,'not_performed');assert.equal(f.state.calls.includes('probe'),false);
 const g=fixture();g.services.activate=async()=>{throw Error('publish_uncertain');};
 const second=g.make(),q=await prepared(g,second),unknown=await second.commit(q.proposalId);
 assert.equal(unknown.rightsCommitted,true);assert.equal(unknown.activation,'unknown');assert.equal(unknown.status,'partially_applied_or_unknown');
});

test('prepare captures mutable input/returned-owner aliases and constructor callbacks',async()=>{
 const f=fixture(),hold=deferred<void>(),base=f.services.inspect;
 f.services.inspect=async(c,s)=>{await hold.promise;assert.equal(c.threadId,A);return base(c,s);};
 f.state.confirm=false;const port=f.make();f.services.confirm=async()=>true;
 const c={...namespace},requested:BootstrapRight[]=['read'],work=port.prepare(c,f.until(),requested);
 c.threadId=B;requested.push('approve');hold.resolve();const p=await work;assert.equal(p.status,'prepared');assert.ok('proposalId'in p&&'owner'in p);
 if(!('proposalId'in p&&'owner'in p))return;(p.owner as {sessionId:string}).sessionId='mutated-result';
 const result=await port.commit(p.proposalId);assert.equal(result.status,'cancelled');assert.deepEqual(f.state.review.scope.rights,['read']);assert.equal(f.state.review.scope.owner.sessionId,owner.sessionId);
});

test('concurrent preparation reserves capacity before yielding and one namespace has one active proposal',async()=>{
 const f=fixture(),hold=deferred<void>(),base=f.services.inspect;f.services.inspect=async(c,s)=>{await hold.promise;return base(c,s);};
 const port=f.make(),jobs=Array.from({length:20},(_,i)=>port.prepare({...namespace,threadId:`${(i+1).toString(16).padStart(8,'0')}-1111-4111-8111-111111111111`},f.until()));
 hold.resolve();const results=await Promise.all(jobs);assert.equal(results.filter(r=>r.status==='prepared').length,16);assert.equal(results.filter(r=>r.status==='blocked').length,4);
 const g=fixture(),second=g.make();await prepared(g,second);assert.equal((await second.prepare(namespace,g.until())).status,'blocked');
});

test('restart, proposal expiry, backwards clocks and owner changes never restore consent',async()=>{
 for(const drift of ['expiry','wall_back','mono_back','owner']){
  const f=fixture(),port=f.make(),p=await prepared(f,port);
  if(drift==='expiry'){f.state.now+=300001;f.state.mono+=300001;}else if(drift==='wall_back')f.state.now--;else if(drift==='mono_back')f.state.mono--;else f.state.owner={...owner,sessionId:'restarted'};
  assert.equal((await port.commit(p.proposalId)).status,'rejected');assert.equal(f.state.calls.includes('confirm'),false);
  assert.equal((await f.make().commit(p.proposalId)).status,'rejected');
 }
});

test('overdue synchronous inspection cannot publish success while its timeout callback is pending',async()=>{
 const f=fixture(),base=f.services.inspect;f.services.operationTimeoutMs=5;
 f.services.inspect=async(c,s)=>{const start=performance.now();while(performance.now()-start<15){}return base(c,s);};
 const result=await f.make().prepare(namespace,f.until());assert.equal(result.status,'blocked');assert.equal(result.reason,'bootstrap_timeout');assert.equal(f.state.calls.includes('confirm'),false);
});

test('AF shutdown aborts pending confirmation and never restores consent from old proposals',async()=>{
 const f=fixture(),entered=deferred<void>(),release=deferred<boolean>();f.services.confirm=async()=>{entered.resolve();return release.promise;};
 const port=f.make(),p=await prepared(f,port),work=port.commit(p.proposalId);await entered.promise;port.stop();
 assert.equal((await work).status,'rejected');release.resolve(true);await new Promise(r=>setImmediate(r));
 assert.equal(f.state.calls.includes('codex-write'),false);assert.equal((await port.prepare(namespace,f.until())).status,'blocked');assert.equal((await port.commit(p.proposalId)).status,'rejected');assert.equal(port.rows()[0].state,'disabled');
});

test('missing current AF owner is blocked without any adapter activity',async()=>{
 const f=fixture();f.services.owner=()=>null;const port=f.make(),result=await port.prepare(namespace,f.until());assert.equal(result.status,'blocked');assert.equal(result.reason,'owner_unavailable');assert.deepEqual(f.state.calls,[]);
});

test('provider diagnostics cannot leak raw command output or private paths',async()=>{
 const f=fixture();f.services.inspect=async()=>{throw Error('/private/secret.sock raw command output\nTOKEN=hidden');};
 const port=f.make(),result=await port.prepare(namespace,f.until());assert.equal(result.status,'blocked');assert.equal(result.reason,'inspection_failed');assert.doesNotMatch(JSON.stringify([result,port.rows()]),/secret|TOKEN|hidden/);
});

test('D6 warning is explicit in the one Pi review; absent transcript proof still cannot enable',async()=>{
 const f=fixture();(f.inspection as any).assessment={level:'contract_unverified',reason:'matching_binary_unavailable',warning:'schema_not_verified',context:(f.inspection.assessment as any).context,requiresProbe:true,activation:'not_performed'};
 f.services.probe=async()=>({status:'unknown',reason:'no_receipt'});
 const port=f.make(),p=await prepared(f,port);assert.equal((p as any).warning,'schema_not_verified');
 assert.equal((await port.commit(p.proposalId)).status,'partially_applied_or_unknown');assert.equal(f.state.review.warning,'schema_not_verified');assert.equal(f.state.calls.includes('activate'),false);
});
