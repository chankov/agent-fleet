import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,chmod,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {createServer,type Socket} from 'node:net';
import {readFileSync} from 'node:fs';
import {NotificationBootstrap} from '../../harnesses/lib/fleet-notification-bootstrap.ts';
import {FleetConnectionControl} from '../../harnesses/lib/fleet-connection-control.ts';
import {codexRightsSnapshot} from '../../harnesses/lib/fleet-codex-policy-snapshot.ts';
import {CodexBootstrapProducer} from './lib/codex-bootstrap-producer.ts';
import {AllowedSessionsStore,StoreError,type StoreOptions} from './lib/fleet-codex-allowlist-store.ts';
import {PermissionTransport} from './lib/fleet-codex-permission-transport.ts';
import {TOOLS} from './lib/fleet-codex-local-mcp.ts';
import {assessQueueCompatibility} from '../../harnesses/lib/fleet-notification-validation.ts';
import {codexNotificationBootstrapPolicy} from '../../harnesses/lib/codex-notification-profile.ts';
import {socketTempBase} from '../../../bin/test/helpers/test-temp.js';
// The bound socket is <root>/r/sockets/<sessionId>.sock, 66 bytes below the base.
const SOCKET_BASE=socketTempBase();
const A={hostProfile:'desktop',principal:'synthetic-only',threadId:'11111111-1111-4111-8111-111111111111'};
const B={...A,threadId:'22222222-2222-4222-8222-222222222222'};
const OWNER={project:'af-test',peer:'synthetic',sessionId:'33333333-3333-4333-8333-333333333333',startedAt:'2026-11-12T00:00:00.000Z'};
const catalog={identity:'host_context_validated',protocolVersion:'2025-06-18',tools:TOOLS.map(t=>({name:t.name}))};
const context={daemonVersion:'0.167.1',desktopVersion:'0.167.0-alpha.3.2',socketEpoch:'SYNTHETIC-NEVER-REAL-SOCKET-EPOCH'};
const reference=JSON.parse(readFileSync(new URL('./fixtures/codex-notification-contracts/bootstrap-profile-0.167.json',import.meta.url),'utf8'));
const assessment=assessQueueCompatibility({...context,contract:{state:'available',...context,documents:reference.referenceDocuments}},codexNotificationBootstrapPolicy(reference.referenceDocuments));
const deferred=()=>{let resolve!:(v?:any)=>void;const promise=new Promise<any>(r=>{resolve=r;});return {promise,resolve};};
async function fixture(t:any,options:{confirm?:(signal:AbortSignal)=>Promise<boolean>;capability?:'verified_without_loading'|'unavailable';storeOptions?:StoreOptions}={}){
 const root=await mkdtemp(join(SOCKET_BASE,'af-boot-')),registry=join(root,'r'),policy=join(root,'p');await mkdir(join(registry,'sockets'),{recursive:true,mode:0o700});await chmod(registry,0o700);
 const calls:string[]=[],sockets=new Set<Socket>();let owner={...OWNER},control:FleetConnectionControl;let producer:CodexBootstrapProducer;
 const state=async(c=A)=>{try{return await new AllowedSessionsStore(policy,c).open();}catch(e){if(e instanceof StoreError&&e.code==='STATE_MISSING')return null;throw e;}};
 const bootstrap=new NotificationBootstrap({owner:()=>owner,
  inspect:async c=>{calls.push('inspect');return {hostInstance:producer.hostInstance,identity:'host_context_validated',catalog,assessment,probeReadCapability:options.capability??'verified_without_loading',rights:codexRightsSnapshot(await state(c),owner)};},
  confirm:async(_review,signal)=>{calls.push('confirm');return options.confirm?options.confirm(signal):true;},
  codexWriteRights:(request,signal)=>{calls.push('request_codex_writer');return control.writeBootstrapRights(request,signal);},
  probe:async request=>{calls.push('synthetic_probe');return {status:'acknowledged',source:'read_only_assistant_transcript',probeId:request.probeId,threadId:request.scope.namespace.threadId,hostInstance:producer.hostInstance,...context,notLoadedBefore:true,notLoadedAfter:true,receiptId:'SYNTHETIC-ACK-NOT-HOST-EVIDENCE'};},
  activate:async()=>{calls.push('synthetic_activate');return {enabled:true};},disable:async()=>{calls.push('synthetic_disable');},
 });
 control=new FleetConnectionControl({owner:()=>owner,session:()=>undefined,defaultNamespace:{hostProfile:A.hostProfile,principal:A.principal},readRights:async c=>codexRightsSnapshot(await state(c),owner),bootstrap});
 const server=createServer(socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));let bytes=Buffer.alloc(0);socket.on('data',(chunk:Buffer)=>{bytes=Buffer.concat([bytes,chunk]);let end;while((end=bytes.indexOf(10))>=0){const line=bytes.subarray(0,end);bytes=bytes.subarray(end+1);if(line.length>32768){socket.destroy();return;}try{control.handle(socket,JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(line)));}catch{socket.destroy();}}if(bytes.length>32768)socket.destroy();});});
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(join(registry,'sockets',OWNER.sessionId+'.sock'),resolve);});await chmod(join(registry,'sockets',OWNER.sessionId+'.sock'),0o600);
 const transport=new PermissionTransport({registryRoot:registry,channel:'connection'});
 const makeProducer=()=>new CodexBootstrapProducer({policyRoot:policy,transport,candidate:async()=>({target:{...owner},current:[{...owner}]}),observation:()=>({protocolVersion:'2025-06-18',clientInfo:{name:'SYNTHETIC-NOT-DESKTOP-ATTESTATION',version:'0.167.0-alpha.3.2'},catalog:TOOLS.map(t=>t.name)}),storeOptions:options.storeOptions});producer=makeProducer();
 t.after(async()=>{producer.stop();control.stop();for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true});});
 return {root,policy,registry,transport,producer,control,bootstrap,state,calls,makeProducer,changeOwner:()=>{owner={...owner,sessionId:'44444444-4444-4444-8444-444444444444'};}};
}

test('native channel prepares read-only, confirms once in Pi, asks only Codex writer, probes then activates without replay',async t=>{
 const f=await fixture(t),p=await f.producer.prepare(A,{target:OWNER,rights:['read','send','approve']});assert.equal(p.status,'prepared');assert.equal(await f.state(),null);assert.equal(f.calls.includes('confirm'),false);
 const observations=f.control.bootstrapChannel.observations();assert.equal(observations.length,1);assert.equal('identity'in observations[0],false);assert.equal('ready'in observations[0],false);
 const a=await f.producer.commit(A,p.proposalId),b=await f.producer.commit(A,p.proposalId);assert.deepEqual(a,b);assert.equal(a.activation,'enabled');assert.equal(f.calls.filter(c=>c==='confirm').length,1);assert.equal(f.calls.filter(c=>c==='request_codex_writer').length,1);
 const state=await f.state();assert.equal(state!.revision,1);assert.deepEqual(state!.bindings[0].rights,['read','send','approve']);assert.equal(state!.bindings[0].expiresAt,p.expiresAt);
 assert.ok(f.calls.indexOf('request_codex_writer')<f.calls.indexOf('synthetic_probe'));assert.ok(f.calls.indexOf('synthetic_probe')<f.calls.indexOf('synthetic_activate'));
 const count=f.calls.filter(c=>c==='inspect').length;await f.producer.status(A,OWNER);f.bootstrap.rows();f.control.bootstrapRows();assert.equal(f.calls.filter(c=>c==='inspect').length,count);
});

test('Pi decline and missing no-load capability cannot write rights, probe or activate regardless of model confirmation flags',async t=>{
 for(const [confirm,capability]of [[async()=>false,'verified_without_loading'],[async()=>true,'unavailable']]as const){
  const f=await fixture(t,{confirm,capability}),p=await f.producer.prepare(A,{target:OWNER,rights:['read','send','approve'],desktopConfirmed:true});
  if(p.status==='prepared'){const r=await f.producer.commit(A,p.proposalId);assert.notEqual(r.activation,'enabled');}else assert.equal(p.status,'blocked');
  assert.equal(await f.state(),null);assert.equal(f.calls.includes('request_codex_writer'),false);assert.equal(f.calls.includes('synthetic_probe'),false);assert.equal(f.calls.includes('synthetic_activate'),false);
 }
});

test('namespace, owner and revision remain exact across native/AF prepare and commit',async t=>{
 const f=await fixture(t),p=await f.producer.prepare(A,{target:OWNER,rights:['read','send']});
 await assert.rejects(f.producer.commit(B,p.proposalId),/proposal_unavailable/);assert.equal((await f.bootstrap.commit(p.proposalId,B)).status,'rejected');assert.equal(await f.state(),null);
 f.changeOwner();const r=await f.producer.commit(A,p.proposalId);assert.notEqual(r.activation,'enabled');assert.equal(await f.state(),null);assert.equal(f.calls.includes('confirm'),false);
});

test('rights drift after prepare is rejected before the Pi confirmation and never migrated implicitly',async t=>{
 const f=await fixture(t),p=await f.producer.prepare(A,{target:OWNER,rights:['read','send']});const store=new AllowedSessionsStore(f.policy,A);await store.initialize();await store.enroll({alias:'existing',target:OWNER},[OWNER],0);
 const r=await f.producer.commit(A,p.proposalId);assert.notEqual(r.activation,'enabled');assert.equal(f.calls.includes('confirm'),false);assert.deepEqual((await f.state())!.bindings[0].rights,['read']);
});

test('one live writer per owner/namespace; second native process cannot replace it or confirm',async t=>{
 const f=await fixture(t),p=await f.producer.prepare(A,{target:OWNER});assert.equal(p.status,'prepared');const other=f.makeProducer();t.after(()=>other.stop());
 const r=await other.prepare(A,{target:OWNER});assert.equal(r.status,'blocked');assert.equal(f.control.bootstrapChannel.observations().length,1);assert.equal(await f.state(),null);
});

test('disconnect/cancel while Pi confirmation waits aborts the job and ignores late consent',async t=>{
 const entered=deferred(),answer=deferred();let signal:AbortSignal|undefined;
 const f=await fixture(t,{confirm:async s=>{signal=s;entered.resolve();return answer.promise;}}),p=await f.producer.prepare(A,{target:OWNER,rights:['read','send','approve']}),controller=new AbortController();
 const work=f.producer.commit(A,p.proposalId,controller.signal);await entered.promise;controller.abort();const result=await work;
 await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('synthetic cancellation was not propagated')),1000);const done=()=>{clearTimeout(timer);resolve();};if(signal!.aborted)done();else signal!.addEventListener('abort',done,{once:true});});
 answer.resolve(true);await new Promise(r=>setTimeout(r,5));
 assert.notEqual(result.activation,'enabled');assert.equal(signal?.aborted,true);assert.equal(await f.state(),null);assert.equal(f.calls.includes('request_codex_writer'),false);assert.equal(f.calls.includes('synthetic_activate'),false);
});

test('cancel at Codex beforeRename cannot publish first rights or activate, and is never retried',async t=>{
 const entered=deferred(),release=deferred();let renames=0;
 const f=await fixture(t,{storeOptions:{checkpoint:async stage=>{if(stage==='beforeRename'&&++renames===2){entered.resolve();await release.promise;}}}}),p=await f.producer.prepare(A,{target:OWNER,rights:['read','send','approve']}),controller=new AbortController();
 const work=f.producer.commit(A,p.proposalId,controller.signal);await entered.promise;controller.abort();release.resolve();const r=await work;await new Promise(resolve=>setTimeout(resolve,15));
 assert.notEqual(r.activation,'enabled');assert.deepEqual((await f.state())?.bindings??[],[]);assert.equal(f.calls.includes('synthetic_activate'),false);const before=f.calls.filter(c=>c==='request_codex_writer').length;await f.producer.commit(A,p.proposalId);assert.equal(f.calls.filter(c=>c==='request_codex_writer').length,before);
});

test('wire retains detached identity observations and rejects concurrent namespace takeover; status does not synthesize Desktop evidence',async t=>{
 const f=await fixture(t),p=await f.producer.prepare(A,{target:OWNER});assert.equal(p.status,'prepared');const first=f.control.bootstrapChannel.observations();first[0].clientInfo!.version='mutated';first[0].catalog.length=0;
 const next=f.control.bootstrapChannel.observations();assert.equal(next[0].clientInfo!.version,'0.167.0-alpha.3.2');assert.equal(next[0].catalog.length,TOOLS.length);assert.equal(next[0].hostInstance,f.producer.hostInstance);
 const status=await f.producer.status(A,OWNER);assert.equal(status.status,'cached');assert.equal(status.delivery,'not_established_by_status');assert.equal('identity'in status,false);assert.equal('probeReadCapability'in status,false);
});
