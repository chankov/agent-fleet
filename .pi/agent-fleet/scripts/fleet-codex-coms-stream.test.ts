import test,{after,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,access} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {Socket} from 'node:net';
import type {TargetEpoch} from './lib/fleet-codex-allowlist.ts';

// Set the production COMS root before any runtime import. Every endpoint,
// registry entry and policy path in this file is owned synthetic test data.
const root=await mkdtemp(join(process.platform==='darwin'?'/tmp':tmpdir(),'afcs-'));
const oldComs=process.env.PI_COMS_DIR,oldHerdr=process.env.HERDR_ENV;
process.env.PI_COMS_DIR=root;process.env.HERDR_ENV='0';
after(async()=>{if(oldComs===undefined)delete process.env.PI_COMS_DIR;else process.env.PI_COMS_DIR=oldComs;if(oldHerdr===undefined)delete process.env.HERDR_ENV;else process.env.HERDR_ENV=oldHerdr;await rm(root,{recursive:true,force:true});});
const {createComsPeer}=await import('../../harnesses/lib/coms-core.ts');
const {ownerOf}=await import('../../harnesses/lib/coms-instruction-receipts.ts');
const {FleetConnectionControl}=await import('../../harnesses/lib/fleet-connection-control.ts');
const {NotificationBootstrap}=await import('../../harnesses/lib/fleet-notification-bootstrap.ts');
const {CodexBootstrapProducer}=await import('./lib/codex-bootstrap-producer.ts');
const {PermissionTransport}=await import('./lib/fleet-codex-permission-transport.ts');
const {codexRightsSnapshot}=await import('../../harnesses/lib/fleet-codex-policy-snapshot.ts');
const {assessQueueCompatibility}=await import('../../harnesses/lib/fleet-notification-validation.ts');
const {codexNotificationBootstrapPolicy}=await import('../../harnesses/lib/codex-notification-profile.ts');
const {TOOLS}=await import('./lib/fleet-codex-local-mcp.ts');
const namespace={hostProfile:'desktop',principal:'synthetic-only',threadId:'11111111-1111-4111-8111-111111111111'};
const context={daemonVersion:'0.167.2',desktopVersion:'26.1106.51428',socketEpoch:'SYNTHETIC-NOT-A-HOST-EPOCH'};
const reference=JSON.parse(readFileSync(new URL('./fixtures/codex-notification-contracts/bootstrap-profile-0.167.json',import.meta.url),'utf8'));
const assessment=assessQueueCompatibility({...context,contract:{state:'unavailable',...context,reason:'matching_binary_unavailable'}},codexNotificationBootstrapPolicy(reference.referenceDocuments));
assert.equal(assessment.level,'contract_unverified');
let sequence=0;
const tick=()=>new Promise(resolve=>setTimeout(resolve,5));
async function until(check:()=>boolean){const deadline=performance.now()+1500;while(!check()&&performance.now()<deadline)await tick();assert.ok(check(),'owned synthetic operation did not settle');}

async function fixture(t:TestContext,holdInspection=false){
 const id=++sequence,policyRoot=join(root,'policy-'+id),project='synthetic-stream-'+id;
 let owner:TargetEpoch|null=null;
 const calls={inspect:0,aborted:0,confirm:0,writeRights:0,probe:0,activate:0,deliveries:0};
 const bootstrap=new NotificationBootstrap({owner:()=>owner,
  inspect:async(_c,signal)=>{calls.inspect++;if(holdInspection)await new Promise<never>((_resolve,reject)=>{const abort=()=>{calls.aborted++;reject(Error('synthetic_cancel'));};signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});return {hostInstance:producer.hostInstance,identity:'host_context_validated',catalog:{identity:'host_context_validated',protocolVersion:'2025-06-18',tools:TOOLS.map(t=>({name:t.name}))},assessment,probeReadCapability:'verified_without_loading',rights:codexRightsSnapshot(null,owner!)};},
  confirm:async()=>{calls.confirm++;return false;},codexWriteRights:async()=>{calls.writeRights++;throw Error('unexpected writer');},
  probe:async()=>{calls.probe++;throw Error('unexpected probe');},activate:async()=>{calls.activate++;throw Error('unexpected activation');},disable:async()=>{},
 });
 const control=new FleetConnectionControl({owner:()=>owner,session:()=>undefined,defaultNamespace:{hostProfile:namespace.hostProfile,principal:namespace.principal},readRights:async()=>({rights:[],status:'not_connected'}),bootstrap});
 const ctx:any={cwd:root,model:{id:'synthetic'},hasUI:false,getContextUsage:()=>null,sessionManager:{getBranch:()=>[]},ui:{notify(){},setWidget(){},setStatus(){}}};
 const pi:any={getFlag:(f:string)=>f==='name'?'synthetic-peer':f==='project'?project:undefined,getSessionName:()=>undefined,appendEntry(){},sendMessage(){calls.deliveries++;}};
 const peer=createComsPeer({pi,getContext:()=>ctx,
  handleCustomStream:(socket:Socket,envelope:unknown,buffered:Buffer)=>control.handleStream(socket,envelope,buffered),
  handleCustomEnvelope:(socket,envelope)=>control.handle(socket,envelope),
 });
 const transport=new PermissionTransport({registryRoot:root,channel:'connection'});
 const producer=new CodexBootstrapProducer({policyRoot,transport,candidate:async()=>({target:owner!,current:[owner!]}),observation:()=>({protocolVersion:'2025-06-18',clientInfo:{name:'Синтетичен-клиент',version:'not-desktop-identity'},catalog:TOOLS.map(t=>t.name)})});
 const sockets=new Set<Socket>();
 t.after(async()=>{producer.stop();control.stop();for(const s of sockets)s.destroy();await peer.shutdown();});
 await peer.connect({ctx,defaultNamePrefix:'synthetic',defaultPurpose:'owned COMS stream regression'});owner=ownerOf(peer.identity!);
 assert.ok(peer.identity!.endpoint.startsWith(root+'/'));
 return {peer,control,producer,transport,calls,policyRoot,sockets,owner,
  observation:{namespace,hostInstance:producer.hostInstance,protocolVersion:'2025-06-18',clientInfo:{name:'Синтетичен-клиент',version:'not-desktop-identity'},catalog:TOOLS.map(t=>t.name)},
 };
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
async function raw(f:Fixture){
 const socket=await f.transport.open(f.owner);f.sockets.add(socket);socket.once('close',()=>f.sockets.delete(socket));
 const frames:any[]=[];let bytes=Buffer.alloc(0),closed=false;socket.once('close',()=>{closed=true;});
 socket.on('data',(chunk:Buffer)=>{bytes=Buffer.concat([bytes,chunk]);let end;while((end=bytes.indexOf(10))>=0){frames.push(JSON.parse(bytes.subarray(0,end).toString('utf8')));bytes=bytes.subarray(end+1);}});
 const envelope=(payload:unknown)=>({type:'connection_request',version:1,msg_id:randomUUID(),owner:f.owner,operation:'bootstrap_channel',payload,sender_session:'synthetic',sender_endpoint:'',hops:0,timestamp:new Date().toISOString()});
 const encode=(value:unknown)=>Buffer.from(JSON.stringify(value)+'\n');
 const take=async()=>{await until(()=>frames.length>0||closed);assert.ok(frames.length,'owned synthetic stream closed before response');return frames.shift();};
 const attach=async()=>{socket.write(encode(envelope({kind:'attach',observation:f.observation,observedAt:Date.now()})));const reply=await take();assert.equal(reply.bootstrap.kind,'attached');return reply.bootstrap.token as string;};
 return {socket,frames,envelope,encode,take,attach,closed:()=>closed};
}

test('production COMS carries native prepare and repeated cached status after the bootstrap attach, with no effects',async t=>{
 const f=await fixture(t),signal=AbortSignal.timeout(1500);
 const prepared=await f.producer.prepare(namespace,{target:f.owner,rights:['read']},signal);
 assert.equal(prepared.status,'prepared');assert.equal(prepared.activation,'not_performed');assert.equal(f.calls.inspect,1);
 for(let i=0;i<3;i++){const status=await f.producer.status(namespace,f.owner,AbortSignal.timeout(1500));assert.equal(status.status,'cached');assert.equal(status.delivery,'not_established_by_status');}
 assert.equal(f.calls.inspect,1);assert.equal(f.calls.confirm+f.calls.writeRights+f.calls.probe+f.calls.activate+f.calls.deliveries,0);
 await assert.rejects(access(f.policyRoot),{code:'ENOENT'});
});

test('production stream preserves fragmented UTF-8 and dispatches coalesced complete frames plus a partial tail',async t=>{
 const f=await fixture(t),r=await raw(f),attach=r.encode(r.envelope({kind:'attach',observation:f.observation,observedAt:Date.now()}));
 const split=attach.indexOf(Buffer.from('С'))+1;assert.ok(split>0);r.socket.write(attach.subarray(0,split));await tick();r.socket.write(attach.subarray(split));
 const token=(await r.take()).bootstrap.token;assert.equal(f.control.bootstrapChannel.observation(namespace)!.clientInfo!.name,'Синтетичен-клиент');
 const requests=Array.from({length:3},()=>r.envelope({kind:'request',token,operation:'status',payload:{}})),encoded=requests.map(r.encode),cut=Math.floor(encoded[2].length/2);
 r.socket.write(Buffer.concat([encoded[0],encoded[1],encoded[2].subarray(0,cut)]));
 const first=await r.take(),second=await r.take();assert.deepEqual(new Set([first.msg_id,second.msg_id]),new Set(requests.slice(0,2).map(v=>v.msg_id)));
 r.socket.write(encoded[2].subarray(cut));const third=await r.take();assert.equal(third.msg_id,requests[2].msg_id);assert.equal(third.bootstrap.result.status,'cached');
 assert.equal(f.calls.inspect+f.calls.confirm+f.calls.writeRights+f.calls.probe+f.calls.activate+f.calls.deliveries,0);
});

test('production handoff retains bytes coalesced after the first attach and refuses non-bootstrap continuation',async t=>{
 const f=await fixture(t),r=await raw(f);
 r.socket.write(Buffer.concat([r.encode(r.envelope({kind:'attach',observation:f.observation,observedAt:Date.now()})),Buffer.from('not-json\n')]));
 await until(r.closed);assert.equal(f.calls.deliveries,0);
 const g=await fixture(t),s=await raw(g);await s.attach();
 s.socket.write(s.encode({type:'prompt',msg_id:'synthetic-smuggled-prompt',sender_session:'synthetic',sender_endpoint:'',prompt:'must not create a turn'}));
 await until(s.closed);assert.equal(g.calls.deliveries,0);
});

test('production bootstrap stream rejects oversized lines/tails and malformed UTF-8, detaching its live link',async t=>{
 for(const kind of ['line','tail','utf8']){
  const f=await fixture(t),r=await raw(f);await r.attach();
  if(kind==='utf8')r.socket.write(Buffer.from([0xff,10]));else r.socket.write(Buffer.alloc(32769,32));
  if(kind==='line')r.socket.write('\n');await until(r.closed);await until(()=>f.control.bootstrapChannel.observations().length===0);
  assert.equal(f.calls.inspect+f.calls.confirm+f.calls.writeRights+f.calls.probe+f.calls.activate+f.calls.deliveries,0);
 }
});

test('production COMS refuses malformed initial UTF-8 and keeps ordinary ping connections one-shot',async t=>{
 const f=await fixture(t),r=await raw(f),attach=r.encode(r.envelope({kind:'attach',observation:f.observation,observedAt:Date.now()}));
 const at=attach.indexOf(Buffer.from('С'));assert.ok(at>=0);attach[at]=0xff;r.socket.write(attach);
 assert.equal((await r.take()).type,'nack');await until(r.closed);assert.equal(f.control.bootstrapChannel.observations().length,0);
 const g=await fixture(t),s=await raw(g);
 s.socket.write(Buffer.concat([s.encode({type:'ping',msg_id:'synthetic-ping',sender_session:'synthetic',sender_endpoint:'',hops:0,timestamp:new Date().toISOString()}),s.encode(s.envelope({kind:'attach',observation:g.observation,observedAt:Date.now()}))]));
 assert.equal((await s.take()).type,'pong');await until(s.closed);assert.equal(g.control.bootstrapChannel.observations().length,0);
 assert.equal(g.calls.inspect+g.calls.confirm+g.calls.writeRights+g.calls.probe+g.calls.activate+g.calls.deliveries,0);
});

test('production stream forwards cancellation and shutdown to pending read-only inspection without a late effect',async t=>{
 for(const shutdown of [false,true]){
  const f=await fixture(t,true),controller=new AbortController(),work=f.producer.prepare(namespace,{target:f.owner,rights:['read']},controller.signal);
  await until(()=>f.calls.inspect===1);if(shutdown)f.control.stop();else controller.abort();
  const result=await work;assert.equal(result.status,'blocked');await until(()=>f.calls.aborted===1);
  assert.equal(f.calls.confirm+f.calls.writeRights+f.calls.probe+f.calls.activate+f.calls.deliveries,0);
 }
});
