import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,appendFileSync,chmodSync,rmSync,symlinkSync,readFileSync,readdirSync,existsSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer as createHttpServer} from 'node:http';
import {createServer as createNetServer,type Socket} from 'node:net';
import {createRequire} from 'node:module';
import {FleetCodexBootstrap} from './lib/fleet-codex-bootstrap.ts';
import {FleetConnectionControl} from '../../harnesses/lib/fleet-connection-control.ts';
import {CodexBootstrapProducer} from './lib/codex-bootstrap-producer.ts';
import {NativePresenceDirectory} from './lib/codex-native-presence.ts';
import {AllowedSessionsStore,StoreError} from './lib/fleet-codex-allowlist-store.ts';
import {PermissionTransport} from './lib/fleet-codex-permission-transport.ts';
import {TOOLS} from './lib/fleet-codex-local-mcp.ts';
import {publishFleetSourceEvent,fleetSourceDigest} from '../../harnesses/lib/fleet-event-source.ts';
import {parseNotificationConfiguration,notificationPreview} from './lib/fleet-codex-event-runtime.ts';
import {chatLines} from '../../harnesses/lib/fleet-codex-chat-view.ts';
const require=createRequire(import.meta.url),{WebSocketServer}=require('ws');
const A={hostProfile:'desktop',principal:'synthetic-only',threadId:'11111111-1111-4111-8111-111111111111'};
const OWNER={project:'af-test',peer:'synthetic',sessionId:'33333333-3333-4333-8333-333333333333',startedAt:'2026-11-12T00:00:00.000Z'};
const tick=()=>new Promise(resolve=>setTimeout(resolve,5));
async function until(check:()=>boolean){for(let i=0;i<1000&&!check();i++)await tick();assert.ok(check(),'owned synthetic operation did not settle');}
/** No real Codex, /proc, transcript or existing endpoint is used. Both protocols
 * use owned temp sockets; Desktop executable bytes/proc and model output are
 * explicit fixtures, never production identity/qualification evidence. */
async function fixture(t:any,options:{confirm?:boolean;loaded?:boolean;missingPath?:boolean;cancelProbe?:AbortController;contract?:boolean;holdProbeAfter?:number;legacyRoot?:boolean;badEventEcho?:boolean;automatic?:boolean;confirmEffect?:(root:string)=>void}={}){
 const root=mkdtempSync(join(tmpdir(),'af-full-')),policyRoot=join(root,'policy'),registryRoot=join(root,'r'),procRoot=join(root,'fake-proc'),home=join(root,'home');
 mkdirSync(join(registryRoot,'sockets'),{recursive:true,mode:0o700});mkdirSync(join(procRoot,'123'),{recursive:true,mode:0o700});mkdirSync(join(home,'sessions'),{recursive:true,mode:0o700});mkdirSync(join(root,'d'),{mode:0o700});
 const desktop=join(root,'SYNTHETIC-NOT-EXECUTED');writeFileSync(desktop,'OWNED FAKE DESKTOP BYTES',{mode:0o700});writeFileSync(join(procRoot,'123','stat'),'123 (synthetic) '+['S',...Array(18).fill('0'),'55555',...Array(5).fill('0')].join(' ')+'\n',{mode:0o600});symlinkSync(desktop,join(procRoot,'123','exe'));
 if(options.automatic){mkdirSync(join(root,'resources'),{mode:0o700});const body=Buffer.from(JSON.stringify({name:'openai-codex-electron',version:'0.167.0-alpha.3.2'})),json=Buffer.from(JSON.stringify({files:{'package.json':{size:body.length,offset:'0'}}})),header=Buffer.alloc(8+json.length),size=Buffer.alloc(8);header.writeUInt32LE(json.length+4,0);header.writeUInt32LE(json.length,4);json.copy(header,8);size.writeUInt32LE(4,0);size.writeUInt32LE(header.length,4);writeFileSync(join(root,'resources','app.asar'),Buffer.concat([size,header,body]),{mode:0o600});}
 const rollout=join(home,'sessions','rollout-SYNTHETIC-'+A.threadId+'.jsonl');writeFileSync(rollout,JSON.stringify({type:'session_meta',payload:{id:A.threadId}})+'\n',{mode:0o600});
 const socketPath=join(root,'d','daemon.sock'),daemon=createHttpServer(),wss=new WebSocketServer({server:daemon}),wsSockets=new Set<any>(),calls:any[]=[];let version='0.167.1',confirmations=0,preflightConfirmations=0,probes=0,badProbeEcho=false,ua:string|undefined,ownerFailure:{message:string;remaining:number}|undefined;
 const binaryPath=join(root,'owned-fake-cli'),writeBinary=(v:string)=>{const docs=JSON.parse(readFileSync(new URL('./fixtures/codex-notification-contracts/bootstrap-profile-0.167.json',import.meta.url),'utf8')).referenceDocuments;docs['v2/ThreadLoadedListResponse.json']={type:'object'};writeFileSync(binaryPath,`#!${process.execPath}\nconst fs=require('node:fs'),path=require('node:path');if(process.argv[2]==='--version'){console.log('codex-cli ${v}');process.exit(0);}const out=process.argv[process.argv.indexOf('--out')+1],docs=${JSON.stringify(docs)};for(const [p,v]of Object.entries(docs)){const target=path.join(out,p);fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700});fs.writeFileSync(target,JSON.stringify(v),{mode:0o600});}\n`,{mode:0o700});};if(options.contract)writeBinary(version);
 wss.on('connection',(socket:any)=>{wsSockets.add(socket);socket.once('close',()=>wsSockets.delete(socket));socket.on('message',(raw:Buffer)=>{const request=JSON.parse(raw.toString('utf8'));calls.push(request);const answer=(result:unknown)=>socket.send(JSON.stringify({id:request.id,result}));
  if(request.method==='initialize')answer({userAgent:ua==='role'?request.params.clientInfo.name+'/'+version+' (Ubuntu 25.10.0; x86_64) herdr/0.9.5 ('+request.params.clientInfo.name+'; '+request.params.clientInfo.version+')':ua??'Codex Desktop/'+version});
  if(request.method==='thread/read')answer({thread:{id:A.threadId,status:{type:options.loaded?'idle':'notLoaded'},path:options.missingPath?null:rollout}});
  if(request.method==='thread/queue/add'){const input=request.params.input,packet=JSON.parse(input[0].text.split('\n')[1]);answer({queuedSubmission:{id:'SYNTHETIC-'+calls.length,clientUserMessageId:request.params.clientUserMessageId,input:badProbeEcho&&packet.probeId||options.badEventEcho&&!packet.probeId?[]:input}});
   if(packet.probeId){probes++;if(options.holdProbeAfter!==undefined&&probes>options.holdProbeAfter)return;if(options.cancelProbe)setTimeout(()=>options.cancelProbe!.abort(),5);else appendFileSync(rollout,JSON.stringify({type:'response_item',payload:{type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'FLEET_PROBE_ACK '+packet.probeId}]}})+'\n');}
  }
  if(request.method==='thread/queue/list')answer({items:[],nextCursor:null});
 });});
 await new Promise<void>((resolve,reject)=>{daemon.once('error',reject);daemon.listen(socketPath,resolve);});chmodSync(socketPath,0o600);
 const reviews:any[]=[];let control:FleetConnectionControl;const backendOptions:ConstructorParameters<typeof FleetCodexBootstrap>[0]={policyRoot,namespace:{hostProfile:A.hostProfile,principal:A.principal},owner:()=>{if(ownerFailure&&ownerFailure.remaining-->0)throw Error(ownerFailure.message);return OWNER;},procRoot,
  presence:(c,lease)=>lease?control.bootstrapChannel.leaseObservation(c):control.bootstrapChannel.observation(c),writeRights:(r,s)=>control.writeBootstrapRights(r,s),confirm:async review=>{reviews.push(structuredClone(review));confirmations++;options.confirmEffect?.(root);return options.confirm!==false;},confirmPreflight:async()=>{preflightConfirmations++;return true;},...(options.automatic?{discoverDesktop:async()=>({desktopPid:123,desktopVersion:'0.167.0-alpha.3.2',socketPath,codexHome:home,...(options.contract?{binaryPath}:{})})}:{}),...(options.legacyRoot?{legacy:()=>({config:{stateRoot:join(root,'retained-legacy-journal'),approval:{target:OWNER,binding:{threadId:A.threadId}}} as any,release(){}})}:{})};let backend=new FleetCodexBootstrap(backendOptions);
 const bootstrapStatus=()=>{const row=backend.rows()[0];return row?{enabled:row.notification==='enabled',reason:row.reason??row.notification}:{enabled:false,reason:'cached_runtime_unavailable'};};
 control=new FleetConnectionControl({owner:()=>OWNER,session:()=>undefined,defaultNamespace:{hostProfile:A.hostProfile,principal:A.principal},readRights:async()=>({status:'not_connected',rights:[],revision:0}),bootstrap:backend.coordinator,bootstrapStatus});
 const netSockets=new Set<Socket>(),server=createNetServer(socket=>{netSockets.add(socket);socket.once('close',()=>netSockets.delete(socket));let pending='';socket.on('data',bytes=>{pending+=bytes.toString('utf8');let end;while((end=pending.indexOf('\n'))>=0){const line=pending.slice(0,end);pending=pending.slice(end+1);try{control.handle(socket,JSON.parse(line));}catch{socket.destroy();}}});});
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(join(registryRoot,'sockets',OWNER.sessionId+'.sock'),resolve);});chmodSync(join(registryRoot,'sockets',OWNER.sessionId+'.sock'),0o600);
 const producer=new CodexBootstrapProducer({policyRoot,transport:new PermissionTransport({registryRoot,channel:'connection'}),presence:new NativePresenceDirectory(policyRoot+'.presence'),candidate:async()=>({target:{...OWNER},current:[{...OWNER}]}),observation:()=>({protocolVersion:'2025-06-18',clientInfo:{name:'SYNTHETIC SDK NOT DESKTOP',version:'client-sdk-not-desktop-version'},catalog:TOOLS.map(t=>t.name)})});
 t.after(async()=>{producer.stop();backend.stop();control.stop();for(const socket of netSockets)socket.destroy();for(const socket of wsSockets)socket.terminate();await new Promise<void>(resolve=>server.close(()=>resolve()));await new Promise<void>(resolve=>wss.close(()=>resolve()));await new Promise<void>(resolve=>daemon.close(()=>resolve()));await new Promise(resolve=>setTimeout(resolve,15));rmSync(root,{recursive:true,force:true});});
 producer.observe(A);for(let i=0;i<200;i++){if((await backend.native.list()).length)break;await tick();}
 const capture=()=>backend.capturePreflight(A,{desktopPid:123,desktopVersion:'0.167.0-alpha.3.2',socketPath,codexHome:home,...(options.contract?{binaryPath}:{})});
 const state=async()=>{try{return await new AllowedSessionsStore(policyRoot,A).open();}catch(e){if(e instanceof StoreError&&e.code==='STATE_MISSING')return null;throw e;}};
 const source={kind:'message' as const,owner:OWNER,sourceId:'SYNTHETIC-SOURCE',createdAt:Date.now(),deadline:null,contentDigest:fleetSourceDigest('SYNTHETIC-BODY-NEVER-IN-QUEUE')};
 const configFile=()=>{const dir=join(policyRoot+'.bootstrap','configs');return join(dir,readdirSync(dir)[0]);};
 const config=()=>JSON.parse(readFileSync(configFile(),'utf8'));
 const restart=async()=>{backend.stop();control.stop();backend=new FleetCodexBootstrap({...backendOptions,legacy:undefined});control=new FleetConnectionControl({owner:()=>OWNER,session:()=>undefined,defaultNamespace:{hostProfile:A.hostProfile,principal:A.principal},readRights:async()=>({status:'not_connected',rights:[],revision:0}),bootstrap:backend.coordinator,bootstrapStatus});for(let i=0;i<8;i++)await tick();};
 const restartDaemon=async(nextUa='role')=>{for(const socket of wsSockets)socket.terminate();await new Promise<void>(resolve=>daemon.close(()=>resolve()));ua=nextUa;await new Promise<void>((resolve,reject)=>{daemon.once('error',reject);daemon.listen(socketPath,resolve);});chmodSync(socketPath,0o600);};
 return {root,reviews,get backend(){return backend;},restart,restartDaemon,failProbeEcho:()=>{badProbeEcho=true;},failOwner:(message:string)=>{ownerFailure={message,remaining:2};},producer,calls,state,capture,source,config,configFile,rollout,desktop,get confirmations(){return confirmations;},get preflightConfirmations(){return preflightConfirmations;},get probes(){return probes;},changeVersion:()=>{version='0.167.0';if(options.contract)writeBinary(version);}};
}

async function untilCached(f:Awaited<ReturnType<typeof fixture>>,check:()=>boolean){for(let i=0;i<1000;i++){await f.backend.refreshCached();if(check())return;await tick();}assert.ok(check(),'owned cached state did not settle');}
async function expectRecheckFailure(f:Awaited<ReturnType<typeof fixture>>,reason:string){
 await untilCached(f,()=>f.backend.rows()[0]?.reason===reason&&f.backend.rows()[0]?.notification==='context_changed_reprobe_required');
 const row=f.backend.rows()[0];assert.equal(row.reason,reason);assert.equal(row.notification,'context_changed_reprobe_required');
 const before=f.calls.length;for(let i=0;i<5;i++){f.backend.checkContexts();await f.backend.refreshCached();f.backend.rows();}const native=await f.producer.status(A,OWNER);assert.equal(native.notifications.reason,reason);assert.equal(native.notifications.enabled,false);assert.ok(chatLines({detail:true,offset:0},f.backend.rows()).some(line=>line.includes(reason)));assert.equal(f.calls.length,before,'failed recheck/status/render are cached, never an automatic retry');
}

test('full production adapters: read-only mapping/prepare, one bootstrap confirmation, Codex CAS, real owned probe, private admission and event queue',async t=>{
 const f=await fixture(t);await f.capture();assert.equal(f.preflightConfirmations,1);assert.equal(await f.state(),null);assert.equal(f.calls.length,0);
 const prepared=await f.producer.prepare(A,{target:OWNER,rights:['read','send','approve']});assert.equal(prepared.status,'prepared',JSON.stringify(prepared));assert.equal(f.confirmations,0);assert.equal(await f.state(),null);assert.equal(f.calls.some(c=>c.method==='thread/queue/add'),false);
 const result=await f.producer.commit(A,prepared.proposalId);assert.equal(result.activation,'enabled',JSON.stringify(result));assert.equal(f.confirmations,1);assert.deepEqual((await f.state())!.bindings[0].rights,['read','send','approve']);assert.equal((await f.state())!.revision,1);
 const config=f.config();assert.equal(config.compat.level,'contract_unverified');assert.equal(config.approval.daemonVersion,'0.167.1');assert.equal(config.approval.desktopVersion,'0.167.0-alpha.3.2');assert.equal(config.approval.addSchema,undefined);assert.equal(notificationPreview(parseNotificationConfiguration(JSON.stringify(config)),OWNER).ready,false,'serialized config cannot recreate authority');
 assert.equal(publishFleetSourceEvent(f.source).status,'durably_ingested');await until(()=>f.calls.filter(c=>c.method==='thread/queue/add').length===2);await f.backend.refreshCached();const [row]=f.backend.rows();assert.equal(row.notification,'enabled');assert.equal(row.compatibility,'contract_unverified');assert.ok(row.lastProbe);assert.equal(JSON.stringify(f.calls).includes('SYNTHETIC-BODY-NEVER-IN-QUEUE'),false);for(let i=0;i<40&&(f.backend.rows()[0].lastNotification as any)?.queueStatus!=='queue_accepted';i++){await tick();await f.backend.refreshCached();}assert.equal((f.backend.rows()[0].lastNotification as any)?.queueStatus,'queue_accepted');assert.equal('modelDelivered'in (f.backend.rows()[0].lastNotification as any),false);
 const before=f.calls.length;f.backend.rows();f.backend.coordinator.rows();await f.producer.status(A,OWNER);assert.equal(f.calls.length,before,'cached status must not inspect daemon or run a probe');
 await f.backend.disable(A);assert.equal(f.config().optedIn,false);assert.equal((await f.state())!.revision,1,'AF disable never mutates Codex grants');assert.equal(publishFleetSourceEvent({...f.source,sourceId:'AFTER-DISABLE'}).status,'disabled');
});

test('send grant/revoke preserves active notification lease and real message delivery without another probe or config write',async t=>{
 const f=await fixture(t);await f.capture();const p=await f.producer.prepare(A,{target:OWNER,rights:['read']});assert.equal((await f.producer.commit(A,p.proposalId)).activation,'enabled');
 const original=f.config(),pin=statSync(f.configFile()),store=new AllowedSessionsStore(join(f.root,'policy'),A),handle=await store.resolve(OWNER.project+':'+OWNER.peer,[OWNER]);
 await store.grantSend(handle,[OWNER]);f.backend.checkContexts();await f.backend.refreshCached();assert.equal(f.backend.rows()[0].notification,'enabled');
 assert.equal(publishFleetSourceEvent(f.source).status,'durably_ingested');await until(()=>f.calls.filter(c=>c.method==='thread/queue/add').length===2);
 const state=(await f.state())!;await store.revokeSend(state.bindings[0].alias,state.revision);f.backend.checkContexts();await f.backend.refreshCached();assert.equal(f.backend.rows()[0].notification,'enabled');
 assert.equal(publishFleetSourceEvent({...f.source,sourceId:'AFTER-REVOKE'}).status,'durably_ingested');await until(()=>f.calls.filter(c=>c.method==='thread/queue/add').length===3);
 assert.equal(f.probes,1);assert.equal(f.confirmations,1);assert.deepEqual((await f.state())!.bindings[0].rights,['read']);assert.deepEqual(f.config(),original);
 const after=statSync(f.configFile());assert.deepEqual([after.ino,after.mtimeMs,after.ctimeMs],[pin.ino,pin.mtimeMs,pin.ctimeMs]);
});

test('rapid explicit send grant/revoke between watcher samples preserves the same notification lease',async t=>{
 const f=await fixture(t);await f.capture();const p=await f.producer.prepare(A,{target:OWNER,rights:['read']});assert.equal((await f.producer.commit(A,p.proposalId)).activation,'enabled');
 const store=new AllowedSessionsStore(join(f.root,'policy'),A),handle=await store.resolve(OWNER.project+':'+OWNER.peer,[OWNER]);await store.grantSend(handle,[OWNER]);const state=await store.open();await store.revokeSend(state.bindings[0].alias,state.revision);
 f.backend.checkContexts();await f.backend.refreshCached();assert.equal(f.backend.rows()[0].notification,'enabled');assert.equal(f.probes,1);assert.equal(f.confirmations,1);
});

test('send transitions preserve durable unknown message dedup without requeue',async t=>{
 const f=await fixture(t,{badEventEcho:true});await f.capture();const p=await f.producer.prepare(A,{target:OWNER,rights:['read']});assert.equal((await f.producer.commit(A,p.proposalId)).activation,'enabled');
 const store=new AllowedSessionsStore(join(f.root,'policy'),A);await store.grantSend(await store.resolve(OWNER.project+':'+OWNER.peer,[OWNER]),[OWNER]);
 publishFleetSourceEvent(f.source);await until(()=>f.calls.filter(c=>c.method==='thread/queue/add').length===2);for(let i=0;i<20;i++)await tick();
 const s=await store.open();await store.revokeSend(s.bindings[0].alias,s.revision);f.backend.checkContexts();publishFleetSourceEvent(f.source);for(let i=0;i<20;i++)await tick();
 assert.equal(f.calls.filter(c=>c.method==='thread/queue/add').length,2);assert.equal(f.probes,1);await f.backend.refreshCached();assert.equal(f.backend.rows()[0].notification,'enabled');
});

test('D7 uses fresh actual rights after proved send lineage and preserves the existing probe budget',async t=>{
 const f=await fixture(t,{contract:true});await f.capture();const p=await f.producer.prepare(A,{target:OWNER,rights:['read']});assert.equal((await f.producer.commit(A,p.proposalId)).activation,'enabled');
 const original=f.config(),store=new AllowedSessionsStore(join(f.root,'policy'),A);await store.grantSend(await store.resolve(OWNER.project+':'+OWNER.peer,[OWNER]),[OWNER]);f.backend.checkContexts();assert.equal(f.probes,1);
 f.changeVersion();publishFleetSourceEvent({...f.source,sourceId:'TRIGGER-DAEMON-DRIFT'});await until(()=>f.probes===2);await until(()=>f.config().compat.daemonVersion==='0.167.0');for(let i=0;i<20;i++)await tick();
 assert.equal(f.config().approval.confirmedUntil,original.approval.confirmedUntil);assert.equal(f.config().stateRoot,original.stateRoot);assert.equal(f.confirmations,1);
 const s=await store.open();await store.revokeSend(s.bindings[0].alias,s.revision);f.backend.checkContexts();await f.backend.refreshCached();assert.equal(f.backend.rows()[0].notification,'enabled');assert.equal(f.probes,2);
});

test('Desktop executable replacement still pauses the lease after a safe send transition',async t=>{
 const f=await fixture(t);await f.capture();const p=await f.producer.prepare(A,{target:OWNER,rights:['read']});assert.equal((await f.producer.commit(A,p.proposalId)).activation,'enabled');
 const store=new AllowedSessionsStore(join(f.root,'policy'),A);await store.grantSend(await store.resolve(OWNER.project+':'+OWNER.peer,[OWNER]),[OWNER]);f.backend.checkContexts();writeFileSync(f.desktop,'REPLACED SYNTHETIC DESKTOP');
 f.backend.checkContexts();await f.backend.refreshCached();assert.notEqual(f.backend.rows()[0].notification,'enabled');assert.equal(f.probes,1);
});

test('send witness never preserves a lease across approve, read revocation, owner, expiry or renewal changes',async t=>{
 for(const change of ['approve','read','owner','renewal','expired']){
  const f=await fixture(t);await f.capture();const p=await f.producer.prepare(A,{target:OWNER,rights:['read']});assert.equal((await f.producer.commit(A,p.proposalId)).activation,'enabled');
  const store=new AllowedSessionsStore(join(f.root,'policy'),A),handle=await store.resolve(OWNER.project+':'+OWNER.peer,[OWNER]);await store.grantSend(handle,[OWNER]);f.backend.checkContexts();const state=await store.open(),b=state.bindings[0];
  if(change==='approve')await store.grantApprove(await store.resolve(b.alias,[OWNER]),[OWNER]);
  if(change==='read')await store.revoke(b.alias,state.revision);
  if(change==='owner'||change==='renewal'){const target=change==='owner'?{...OWNER,sessionId:'44444444-4444-4444-8444-444444444444'}:OWNER;await store.reconnect({alias:b.alias,previousTarget:OWNER,target,rights:b.rights,expiresAt:b.expiresAt!+(change==='renewal'?1000:0)},[target],state.revision,new AbortController().signal);}
  const now=Date.now;if(change==='expired')Date.now=()=>f.config().approval.confirmedUntil+1;
  try{f.backend.checkContexts();await f.backend.refreshCached();assert.notEqual(f.backend.rows()[0].notification,'enabled',change);assert.equal(f.probes,1,change);}finally{Date.now=now;}
 }
});

test('missing explicit Desktop mapping blocks native prepare without confirmation, daemon access, policy or activation',async t=>{
 const f=await fixture(t),p=await f.producer.prepare(A,{target:OWNER,rights:['read','send','approve']});assert.equal(p.status,'blocked');assert.equal(f.confirmations,0);assert.equal(f.calls.length,0);assert.equal(await f.state(),null);assert.equal(existsSync(join(f.root,'policy.bootstrap','configs')),false);
});

test('unavailable no-load path or already-loaded target blocks before confirmation and any grant',async t=>{
 for(const options of [{missingPath:true},{loaded:true}]){const f=await fixture(t,options);await f.capture();const p=await f.producer.prepare(A,{target:OWNER,rights:['read','send']});assert.equal(p.status,'blocked');assert.equal(f.confirmations,0);assert.equal(await f.state(),null);assert.equal(f.calls.some(c=>c.method==='thread/queue/add'),false);}
});

test('Pi decline creates no grants/config/queue even with successful explicit mapping and capability inspection',async t=>{
 const f=await fixture(t,{confirm:false});await f.capture();const p=await f.producer.prepare(A,{target:OWNER,rights:['read','send','approve']});assert.equal(p.status,'prepared',JSON.stringify(p));const result=await f.producer.commit(A,p.proposalId);assert.equal(result.status,'cancelled');assert.equal(result.reason,'pi_confirmation_declined');assert.equal(f.confirmations,1);assert.equal(await f.state(),null);assert.equal(f.calls.some(c=>c.method==='thread/queue/add'),false);assert.equal(existsSync(join(f.root,'policy.bootstrap','configs')),false);
});

test('cancelled attempted probe remains unknown/no replay and never publishes an active config',async t=>{
 const controller=new AbortController(),f=await fixture(t,{cancelProbe:controller});await f.capture();const p=await f.producer.prepare(A,{target:OWNER,rights:['read','send','approve']});const result=await f.producer.commit(A,p.proposalId,controller.signal);assert.notEqual(result.activation,'enabled');assert.equal(f.calls.filter(c=>c.method==='thread/queue/add').length,1);assert.equal(existsSync(join(f.root,'policy.bootstrap','configs')),false);await f.producer.commit(A,p.proposalId);assert.equal(f.calls.filter(c=>c.method==='thread/queue/add').length,1);
});

test('native handoff returns pending before ACK so the initiating model turn is not held open by its own probe',async t=>{
 const f=await fixture(t,{holdProbeAfter:0});await f.capture();const p=await f.producer.prepare(A,{target:OWNER,rights:['read','send','approve']});const handed=await f.producer.beginCommit(A,p.proposalId);assert.equal(handed.status,'pending');assert.equal(handed.activation,'not_established_by_handoff');assert.equal(handed.humanProvenance,'not_established_by_handoff');assert.equal((await f.producer.beginCommit(A,p.proposalId)).status,'pending');await until(()=>f.probes===1);assert.equal(f.confirmations,1);assert.equal(existsSync(join(f.root,'policy.bootstrap','configs')),false);
 const packet=JSON.parse(f.calls.find(c=>c.method==='thread/queue/add').params.input[0].text.split('\n')[1]);appendFileSync(f.rollout,JSON.stringify({type:'response_item',payload:{type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'FLEET_PROBE_ACK '+packet.probeId}]}})+'\n');
 assert.equal((await f.producer.commit(A,p.proposalId)).activation,'enabled');const cached=await f.producer.beginCommit(A,p.proposalId);assert.equal(cached.cachedPreviousCommit,true);assert.equal(f.probes,1);assert.equal((await f.state())!.revision,1);
});

test('cancelled handoff cannot create a late Pi confirmation, grant, probe or activation',async t=>{
 const f=await fixture(t);await f.capture();const p=await f.producer.prepare(A,{target:OWNER,rights:['read','send','approve']}),controller=new AbortController();await f.producer.beginCommit(A,p.proposalId,controller.signal);controller.abort();const result=await f.producer.commit(A,p.proposalId);assert.notEqual(result.activation,'enabled');assert.equal(await f.state(),null);assert.equal(f.confirmations,0);assert.equal(f.probes,0);
});

test('explicit disable still stops a known runtime after control-cache loss, without owner renewal or new rights',async t=>{
 const f=await fixture(t);await f.capture();const p=await f.producer.prepare(A,{target:OWNER,rights:['read','send','approve']});assert.equal((await f.producer.commit(A,p.proposalId)).activation,'enabled');f.backend.coordinator.reset();assert.equal(f.backend.hasRuntimeFor(A.threadId),true);await f.backend.disable(A);assert.equal(f.backend.hasRuntimeFor(A.threadId),false);assert.equal(f.config().optedIn,false);assert.equal((await f.state())!.revision,1);assert.equal(publishFleetSourceEvent(f.source).status,'disabled');
});

test('cold same-owner bootstrap reuses the persisted non-default journal and never replays an old unknown source',async t=>{
 const f=await fixture(t,{legacyRoot:true,badEventEcho:true});await f.capture();const first=await f.producer.prepare(A,{target:OWNER,rights:['read','send','approve']});assert.equal((await f.producer.commit(A,first.proposalId)).activation,'enabled');const before=f.config();assert.equal(before.stateRoot,join(f.root,'retained-legacy-journal'));
 publishFleetSourceEvent(f.source);await until(()=>f.calls.filter(c=>c.method==='thread/queue/add').length===2);for(let i=0;i<30;i++)await tick();await f.backend.refreshCached();assert.equal((f.backend.rows()[0].lastNotification as any)?.queueStatus,'unknown');
 await f.restart();assert.equal(publishFleetSourceEvent({...f.source,sourceId:'WHILE-OFF'}).status,'disabled');const second=await f.producer.prepare(A,{target:OWNER,rights:['read','send','approve']});assert.equal(second.status,'prepared',JSON.stringify(second));assert.equal((await f.producer.commit(A,second.proposalId)).activation,'enabled');assert.equal(f.config().stateRoot,before.stateRoot);assert.equal(f.confirmations,2);assert.equal((await f.state())!.revision,2);
 const count=f.calls.filter(c=>c.method==='thread/queue/add').length;assert.equal(count,3);publishFleetSourceEvent(f.source);for(let i=0;i<20;i++)await tick();assert.equal(f.calls.filter(c=>c.method==='thread/queue/add').length,count);assert.equal(f.calls.some(c=>c.method==='thread/queue/list'),false,'retired unknown is historical evidence, not current-scope reconcile/replay');
});

test('D7 same used contract automatically rechecks once within old consent, preserving common lease, journal and rights',async t=>{
 const f=await fixture(t,{contract:true});await f.capture();const p=await f.producer.prepare(A,{target:OWNER,rights:['read','send','approve']});assert.equal(p.status,'prepared',JSON.stringify(p));const enabled=await f.producer.commit(A,p.proposalId);assert.equal(enabled.activation,'enabled',JSON.stringify(enabled));const original=f.config();assert.equal(original.compat.level,'contract_checked');assert.ok(original.compat.fingerprint);
 publishFleetSourceEvent(f.source);await until(()=>f.calls.filter(c=>c.method==='thread/queue/add').length===2);for(let i=0;i<20;i++)await tick();
 f.changeVersion();publishFleetSourceEvent({...f.source,sourceId:'INTERRUPTED-SOURCE'});await until(()=>f.probes===2);await until(()=>f.config().compat.daemonVersion==='0.167.0');for(let i=0;i<20;i++)await tick();await f.backend.refreshCached();
 const current=f.config();assert.equal(current.stateRoot,original.stateRoot);assert.equal(current.approval.confirmedUntil,original.approval.confirmedUntil);assert.equal(current.approval.authorityRevision,original.approval.authorityRevision);assert.equal(current.compat.fingerprint,original.compat.fingerprint);assert.notEqual(current.approval.binding.epoch,original.approval.binding.epoch);assert.equal((await f.state())!.revision,1);assert.equal(f.confirmations,1);assert.equal(f.backend.rows()[0].notification,'enabled');
 const queued=f.calls.filter(c=>c.method==='thread/queue/add').length;assert.equal(queued,3);publishFleetSourceEvent(f.source);for(let i=0;i<20;i++)await tick();assert.equal(f.calls.filter(c=>c.method==='thread/queue/add').length,queued,'old source evidence must not be reset or re-enqueued');
 const before=f.calls.length;for(let i=0;i<5;i++){await f.backend.refreshCached();f.backend.rows();}assert.equal(f.calls.length,before,'cached/UI refresh cannot trigger a probe or active daemon inspection');
});

test('D7 same-version socket restart accepts real Fleet UA originators and retains read+send lease without another writer',async t=>{
 const f=await fixture(t,{contract:true});await f.capture();const p=await f.producer.prepare(A,{target:OWNER,rights:['read','send']});assert.equal((await f.producer.commit(A,p.proposalId)).activation,'enabled');
 const original=f.config(),policy=await f.state();await f.restartDaemon();f.backend.checkContexts();
 await until(()=>f.probes===2);await untilCached(f,()=>f.backend.rows()[0]?.notification==='enabled'&&f.backend.rows()[0]?.bindingEpoch!==original.approval.binding.epoch);const current=f.config();
 assert.equal(f.backend.rows()[0].notification,'enabled');assert.equal(current.compat.daemonVersion,original.compat.daemonVersion);assert.equal(current.compat.fingerprint,original.compat.fingerprint);assert.notEqual(current.compat.socketEpoch,original.compat.socketEpoch);
 assert.equal(current.approval.confirmedUntil,original.approval.confirmedUntil);assert.equal(current.approval.authorityRevision,original.approval.authorityRevision);assert.equal(current.stateRoot,original.stateRoot);assert.deepEqual(await f.state(),policy);assert.equal(f.confirmations,1);assert.equal(f.probes,2);
 assert.equal(publishFleetSourceEvent(f.source).status,'durably_ingested');await until(()=>f.calls.filter(c=>c.method==='thread/queue/add').length===3);assert.deepEqual([...new Set(f.calls.filter(c=>c.method==='initialize').map(c=>c.params.clientInfo.name))].sort(),['agent_fleet_contract_observer','agent_fleet_queue_bridge']);
});

test('D7 rejected daemon UA retains a safe inspection reason after pausing and never probes or retries',async t=>{
 const f=await fixture(t,{contract:true});await f.capture();const p=await f.producer.prepare(A,{target:OWNER,rights:['read','send']});assert.equal((await f.producer.commit(A,p.proposalId)).activation,'enabled');const original=f.config(),policy=await f.state();
 await f.restartDaemon('Unsupported/0.167.1 (private-path=/secret/should-not-be-visible)');f.backend.checkContexts();await expectRecheckFailure(f,'d7_inspect_daemon_version_unavailable');
 assert.deepEqual(f.config(),original);assert.deepEqual(await f.state(),policy);assert.equal(f.probes,1);assert.equal(f.confirmations,1);assert.equal(JSON.stringify(f.backend.rows()).includes('/secret/'),false);
});

test('D7 unknown failures expose only stage plus fixed fallback, never arbitrary exception text',async t=>{
 const f=await fixture(t,{contract:true});await f.capture();const p=await f.producer.prepare(A,{target:OWNER,rights:['read','send']});assert.equal((await f.producer.commit(A,p.proposalId)).activation,'enabled');
 f.failOwner('private /secret/path token=do-not-expose\nstack');f.backend.checkContexts();await expectRecheckFailure(f,'d7_inspect_failed');assert.equal(f.probes,1);assert.equal(JSON.stringify(f.backend.rows()).includes('do-not-expose'),false);
});

test('D7 unknown probe publication retains the safe probe-stage reason without another attempt',async t=>{
 const f=await fixture(t,{contract:true});await f.capture();const p=await f.producer.prepare(A,{target:OWNER,rights:['read','send']});assert.equal((await f.producer.commit(A,p.proposalId)).activation,'enabled');const original=f.config(),policy=await f.state();
 f.failProbeEcho();await f.restartDaemon();f.backend.checkContexts();await expectRecheckFailure(f,'d7_probe_bootstrap_probe_unknown_no_replay');assert.equal(f.probes,2);assert.equal(f.confirmations,1);assert.deepEqual(f.config(),original);assert.deepEqual(await f.state(),policy);
});

test('disable cancels an automatic attempted probe without late activation, grant change or automatic replay',async t=>{
 const f=await fixture(t,{contract:true,holdProbeAfter:1});await f.capture();const p=await f.producer.prepare(A,{target:OWNER,rights:['read','send','approve']});assert.equal((await f.producer.commit(A,p.proposalId)).activation,'enabled');f.changeVersion();publishFleetSourceEvent(f.source);await until(()=>f.probes===2);await f.backend.disable(A);for(let i=0;i<20;i++)await tick();assert.equal(f.config().optedIn,false);assert.equal((await f.state())!.revision,1);assert.equal(f.confirmations,1);assert.equal(f.probes,2);assert.equal(publishFleetSourceEvent({...f.source,sourceId:'NO-LATE-RESUME'}).status,'disabled');
});

test('version drift on unchanged socket pauses runtime before addressed bytes, without reprobe or rights renewal',async t=>{
 const f=await fixture(t);await f.capture();const p=await f.producer.prepare(A,{target:OWNER,rights:['read','send','approve']});const result=await f.producer.commit(A,p.proposalId);assert.equal(result.activation,'enabled',JSON.stringify(result));const count=f.calls.filter(c=>c.method==='thread/queue/add').length;
 f.changeVersion();publishFleetSourceEvent(f.source);await until(()=>f.calls.filter(c=>c.method==='initialize').length>0);for(let i=0;i<20;i++)await tick();await f.backend.refreshCached();assert.equal(f.calls.filter(c=>c.method==='thread/queue/add').length,count);assert.equal(f.backend.rows()[0].notification,'context_changed_reprobe_required');assert.equal((await f.state())!.revision,1);assert.equal(f.confirmations,1);
});

test('automatic missing mapping is readonly until one combined Pi approval, then preserves Codex-only rights/probe path',async t=>{
 const f=await fixture(t,{automatic:true,contract:true});const prepared=await f.producer.prepare(A,{target:OWNER,rights:['read','send','approve']});assert.equal(prepared.status,'prepared');
 assert.equal(existsSync(join(f.root,'policy.bootstrap','desktop-mappings')),false);assert.equal(await f.state(),null);assert.equal(f.confirmations,0);assert.equal(f.preflightConfirmations,0);assert.equal(f.probes,0);
 await f.producer.commit(A,prepared.proposalId);await untilCached(f,()=>f.backend.rows()[0]?.notification==='enabled');
 assert.equal(f.confirmations,1);assert.equal(f.preflightConfirmations,0);assert.equal(f.probes,1);assert.equal(f.reviews[0].desktopMapping.desktop.pid,123);assert.equal(f.reviews[0].desktopMapping.desktopVersion,'0.167.0-alpha.3.2');
 assert.deepEqual((await f.state())!.bindings[0].rights,['read','send','approve']);const dir=join(f.root,'policy.bootstrap','desktop-mappings');assert.equal(readdirSync(dir).length,1);assert.equal(statSync(join(dir,readdirSync(dir)[0])).mode&0o777,0o600);
});
test('declining combined automatic approval publishes neither mapping nor rights and does not probe',async t=>{
 const f=await fixture(t,{automatic:true,confirm:false}),p=await f.producer.prepare(A,{target:OWNER,rights:['read']});assert.equal(p.status,'prepared');await f.producer.commit(A,p.proposalId);
 await untilCached(f,()=>f.backend.rows()[0]?.proposalState==='cancelled');assert.equal(f.confirmations,1);assert.equal(f.preflightConfirmations,0);assert.equal(f.probes,0);assert.equal(await f.state(),null);assert.equal(existsSync(join(f.root,'policy.bootstrap','desktop-mappings')),false);
});
test('a current singleton writer is selected over fresh metadata left by a disconnected old MCP',async t=>{
 const f=await fixture(t,{automatic:true}),record=(await f.backend.native.list())[0];await f.backend.native.publish({...record.observation,hostInstance:'55555555-5555-4555-8555-555555555555'});
 const p=await f.producer.prepare(A,{target:OWNER,rights:['read']});assert.equal(p.status,'prepared');assert.equal((await f.backend.native.list()).filter(r=>r.fresh).length,2);assert.equal(f.probes,0);
});
test('automatic package identity drift before Pi confirmation rejects the original proposal without rights or probe',async t=>{
 const f=await fixture(t,{automatic:true}),p=await f.producer.prepare(A,{target:OWNER,rights:['read']});assert.equal(p.status,'prepared');appendFileSync(join(f.root,'resources','app.asar'),'changed');await f.producer.commit(A,p.proposalId);
 await untilCached(f,()=>['rejected','blocked'].includes(f.backend.rows()[0]?.proposalState??''));assert.equal(f.confirmations,0);assert.equal(f.probes,0);assert.equal(await f.state(),null);assert.equal(existsSync(join(f.root,'policy.bootstrap','desktop-mappings')),false);
});

test('automatic identity drift inside the single Pi confirmation cannot publish mapping or grant rights',async t=>{
 const f=await fixture(t,{automatic:true,confirmEffect:root=>appendFileSync(join(root,'resources','app.asar'),'changed while approving')}),p=await f.producer.prepare(A,{target:OWNER,rights:['read']});assert.equal(p.status,'prepared');await f.producer.commit(A,p.proposalId);
 await untilCached(f,()=>f.backend.rows()[0]?.proposalState==='rejected');assert.equal(f.confirmations,1);assert.equal(f.preflightConfirmations,0);assert.equal(f.probes,0);assert.equal(await f.state(),null);assert.equal(existsSync(join(f.root,'policy.bootstrap','desktop-mappings')),false);
});

test('production new-chat umask 0002 permissions change only after one Pi approval, then ACK and activation succeed',async t=>{
 for(const accept of [false,true]){
  const f=await fixture(t,{automatic:true,confirm:accept});
  const actualDir=f.rollout.slice(0,f.rollout.lastIndexOf('/'));chmodSync(actualDir,0o775);chmodSync(f.rollout,0o664);
  const p=await f.producer.prepare(A,{target:OWNER,rights:['read','send','approve']});assert.equal(p.status,'prepared',JSON.stringify(p));
  assert.equal(statSync(actualDir).mode&0o777,0o775);assert.equal(statSync(f.rollout).mode&0o777,0o664);
  const result=await f.producer.commit(A,p.proposalId);assert.equal(f.confirmations,1);
  assert.equal(statSync(actualDir).mode&0o777,accept?0o755:0o775);assert.equal(statSync(f.rollout).mode&0o777,accept?0o644:0o664);
  if(accept){assert.equal(result.activation,'enabled',JSON.stringify(result));assert.equal(f.probes,1);assert.deepEqual((await f.state())!.bindings[0].rights,['read','send','approve']);}
  else{assert.equal(await f.state(),null);assert.equal(f.probes,0);}
 }
});
