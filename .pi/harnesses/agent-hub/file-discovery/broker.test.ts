import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,statSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createConnection,createServer,Socket} from 'node:net';
import {parseFileDiscoveryConfig,FILE_DISCOVERY_LIMITS} from '../../lib/system1/config-file-discovery.js';
import {createCommunicationStore} from '../system1-communication-store.ts';
import {createDiscoveryRuntime} from './runtime.ts';
import {createDiscoveryOwners} from './owners.ts';
import {createDiscoveryBroker,BROKER_LIMITS} from './broker.ts';
import {rankDiscovery} from './broker-client.ts';
const delay=(ms=20)=>new Promise(r=>setTimeout(r,ms));
const answer=(r:any):any=>({status:'ok',evaluation:{answers:r.questions.map((q:any)=>({questionId:q.id,type:q.type,uncertainty:{provenance:'provider'},...(q.type==='ordinal'?{value:0,levels:q.levels}:{value:'implementation'})})),metadata:{}}});
async function fixture(t:any,service?:any,limits?:any){
 const root=mkdtempSync(join(tmpdir(),'d9-broker-files-'));mkdirSync(join(root,'docs'));for(const p of ['a','b'])writeFileSync(join(root,'docs',p),'safe content '+p);
 let taskId='task',read=true,permission='v1',calls=0,rankCalls=0;
 const runtime=createDiscoveryRuntime({root,sessionId:'session',config:parseFileDiscoveryConfig({mode:'active',remoteContextApproved:true,include:['docs']}),service:service??{evaluate:async(r:any)=>{calls++;return answer(r);}},context:()=>taskId,persist(){}});
 const rank=runtime.rank.bind(runtime);runtime.rank=async job=>{rankCalls++;return rank(job);};
 const owners=createDiscoveryOwners('session',()=>taskId);
 const broker=await createDiscoveryBroker({root,runtime,owners,limits});
 const owner=(extra={})=>({taskId,ownerId:'worker',attemptId:'attempt',cwd:root,task:'rounding',query:'search docs',effectiveTools:['find','read'],readRoots:['docs'],exportRoots:['docs'],canRead:()=>read,canDisplay:()=>true,permissionIdentity:()=>permission,...extra});
 const lease=owners.register(owner());const assignment=owners.assignment(lease,broker.endpoint);
 t.after(async()=>{runtime.dispose();await broker.close();rmSync(root,{recursive:true,force:true});});
 return {root,runtime,owners,broker,lease,assignment,owner,calls:()=>calls,rankCalls:()=>rankCalls,setTask:()=>taskId='other',setRead:()=>{read=false;permission='v2';}};
}
function request(f:any,extra={}){const {endpoint:_endpoint,...identity}=f.assignment;return {type:'rank_discovery',...identity,requestId:'r1',paths:['docs/a','docs/b'],discovery:{complete:true},...extra};}
async function raw(endpoint:string,body:string|Buffer):Promise<any>{return new Promise(resolve=>{
 const socket=createConnection(endpoint);let text='';socket.on('error',()=>resolve(null));socket.on('data',chunk=>text+=chunk);socket.on('close',()=>{try{resolve(JSON.parse(text));}catch{resolve(null);}});socket.on('connect',()=>socket.write(body));
 });}
test('real offline UDS private 0700/0600, authoritative parent query/service, full rows and guarded cache reuse',async t=>{
 const f=await fixture(t);assert.equal(statSync(f.broker.directory).mode&0o777,0o700);assert.equal(statSync(f.broker.endpoint).mode&0o777,0o600);assert.ok(Buffer.byteLength(f.broker.endpoint)<100);
 const result=await rankDiscovery(f.assignment,{paths:['docs/a','docs/b'],discovery:{complete:true}});assert.equal(result.ok,true);assert.equal((result as any).result.rows.length,2);assert.equal(f.calls(),2);
 const cached=await rankDiscovery(f.assignment,{paths:['docs/a','docs/b'],discovery:{complete:true}});assert.equal((cached as any).result.counts.cached,2);assert.equal(f.calls(),2);
 assert.ok(!JSON.stringify(result).includes('safe content'));assert.ok(!JSON.stringify(result).includes(f.assignment.capability));assert.ok(!JSON.stringify(result).includes('TYPESAFE_API_KEY'));
 f.setRead();const denied=await rankDiscovery(f.assignment,{paths:['docs/a'],discovery:{complete:true}});assert.equal((denied as any).result.rows[0].reason,'denied');assert.equal((denied as any).result.rows[0].hash,undefined);assert.equal(f.calls(),2);
 await f.broker.close();assert.equal(existsSync(f.broker.directory),false);assert.equal((await rankDiscovery(f.assignment,{paths:['docs/a'],discovery:{complete:true}}) as any).error,'channel_unavailable');
});
test('unknown/malformed/forged/cross-session-owner-attempt-query/cross-scope and find-only refuse BEFORE source collection, no provider/source/state freedom',async t=>{
 const f=await fixture(t);
 for(const extra of [{type:'evaluate'},{capability:'f'.repeat(64)},{sessionId:'foreign'},{taskId:'foreign'},{ownerId:'other'},{attemptId:'other'},{queryHash:'a'.repeat(64)},{cwd:'/tmp'},{model:'other'},{provider:'other'},{state:'body'},{sourceBodies:['body']},{questions:[]},{paths:['../escape']},{paths:['/etc/passwd']},{paths:['other/file']},{discovery:{complete:true,body:'secret'}}]){
  const response=await raw(f.broker.endpoint,JSON.stringify(request(f,extra))+'\n');assert.equal(response?.ok,false);
 }
 assert.equal((await raw(f.broker.endpoint,'not-json\n')).error,'malformed_request');assert.equal(f.rankCalls(),0);assert.equal(f.calls(),0);
 let reads=0;const lease=f.owners.register(f.owner({ownerId:'find-only',attemptId:'2',effectiveTools:['find'],canRead:()=>{reads++;return true;}}));
 const only=f.owners.assignment(lease,f.broker.endpoint);assert.equal((await rankDiscovery(only,{paths:['docs/a'],discovery:{complete:true}}) as any).error,'unauthorized');assert.equal(reads,0);assert.equal(f.rankCalls(),0);
 // Export-denied but display-permitted candidates stay denied rows, never indirect source reads.
 const exportDenied=f.owners.register(f.owner({ownerId:'no-export',attemptId:'3',exportRoots:['docs/a']}));
 const denied=await rankDiscovery(f.owners.assignment(exportDenied,f.broker.endpoint),{paths:['docs/b'],discovery:{complete:true}});
 assert.deepEqual((denied as any).result.rows,[{path:'docs/b',status:'unscored',reason:'denied'}]);assert.equal(f.calls(),0);
});
test('replay, expiry, task switch, separate attempts and registry bounds are enforced',async t=>{
 const f=await fixture(t);const body=JSON.stringify(request(f))+'\n';assert.equal((await raw(f.broker.endpoint,body)).ok,true);
 assert.equal((await raw(f.broker.endpoint,body)).error,'unauthorized');assert.equal(f.calls(),2);
 assert.throws(()=>f.owners.register(f.owner()),/attempt_already/);
 const second=f.owners.register(f.owner({attemptId:'fallback'}));assert.notEqual(second.capability,f.lease.capability);
 f.owners.revoke(f.lease.capability);assert.equal((await rankDiscovery(f.assignment,{paths:['docs/a'],discovery:{complete:true}}) as any).error,'unauthorized');
 const exp=f.owners.register(f.owner({ownerId:'expires',attemptId:'exp'}),30);const expAssignment=f.owners.assignment(exp,f.broker.endpoint);await delay(50);assert.equal((await rankDiscovery(expAssignment,{paths:['docs/a'],discovery:{complete:true}}) as any).error,'unauthorized');
 f.setTask();f.owners.syncTask();assert.equal(f.owners.size,0);assert.equal(second.signal.aborted,true);
 const small=createDiscoveryOwners('s',()=> 't',{maxOwners:1});const owner={...f.owner(),taskId:'t'};small.register(owner);assert.throws(()=>small.register({...owner,attemptId:'2'}),/registration_denied/);small.dispose();
});
test('bounded frames, connections, incomplete frames and multiple frames release without collection',async t=>{
 const f=await fixture(t,undefined,{connections:1,partialFrameMs:80});
 assert.equal(await raw(f.broker.endpoint,'x'.repeat(BROKER_LIMITS.frameBytes+1)),null);
 assert.equal(await raw(f.broker.endpoint,JSON.stringify(request(f))+'\n'+JSON.stringify(request(f))+'\n'),null);
 const socket=createConnection(f.broker.endpoint);await new Promise<void>(r=>socket.once('connect',r));socket.write('{');await delay(20);
 assert.equal(await raw(f.broker.endpoint,JSON.stringify(request(f))+'\n'),null);
 await new Promise<void>(r=>socket.once('close',r));await delay();assert.equal(f.broker.connections,0);assert.equal(f.rankCalls(),0);
});
test('client abort/disconnect, lease revoke and parent shutdown abort active shared work and never publish late results',async t=>{
 let requests:any[]=[];let aborted=0;
 const f=await fixture(t,{evaluate(r:any){requests.push(r);r.signal.addEventListener('abort',()=>aborted++);return new Promise(()=>{});}});
 const controller=new AbortController();const one=rankDiscovery(f.assignment,{paths:['docs/a'],discovery:{complete:true}},controller.signal);
 while(requests.length<1)await delay();controller.abort();assert.equal((await one as any).error,'cancelled');while(aborted<1)await delay();
 const two=rankDiscovery(f.assignment,{paths:['docs/b'],discovery:{complete:true}});while(requests.length<2)await delay();f.owners.revoke(f.lease.capability);assert.equal((await two as any).error,'revoked');while(aborted<2)await delay();
 const lease=f.owners.register(f.owner({attemptId:'new'}));const three=rankDiscovery(f.owners.assignment(lease,f.broker.endpoint),{paths:['docs/a'],discovery:{complete:true}});while(requests.length<3)await delay();await f.broker.close();assert.equal((await three).ok,false);while(aborted<3)await delay();
 assert.equal(f.owners.size,0);assert.equal(f.broker.connections,0);
});
test('bounded server/client deadline and response frames, unavailable channel does not retry',async t=>{
 const f=await fixture(t,{evaluate:()=>new Promise(()=>{})},{requestMs:200});
 assert.equal((await rankDiscovery(f.assignment,{paths:['docs/a'],discovery:{complete:true}}) as any).error,'deadline');
 const dir=mkdtempSync(join(tmpdir(),'d9-client-')),endpoint=join(dir,'s');
 const sockets:any[]=[];const server=createServer(s=>{sockets.push(s);s.on('data',()=>s.end('x'.repeat(BROKER_LIMITS.responseBytes+1)));});await new Promise<void>(r=>server.listen(endpoint,r));
 assert.equal((await rankDiscovery({...f.assignment,endpoint},{paths:['docs/a'],discovery:{complete:true}}) as any).error,'response_too_large');
 for(const socket of sockets)socket.destroy();await new Promise<void>(r=>server.close(()=>r()));rmSync(dir,{recursive:true,force:true});
 assert.equal((await rankDiscovery(f.assignment,{paths:['x'.repeat(BROKER_LIMITS.frameBytes)],discovery:{complete:true}}) as any).error,'request_too_large');
});
test('B1 advisory expiry aborts active broker inference and fences late advice without cancelling physical lifecycle',async t=>{
 let started!:()=>void;const ready=new Promise<void>(r=>started=r);let aborted=false,release!:()=>void;
 const f=await fixture(t,{evaluate(r:any){started();r.signal.addEventListener('abort',()=>aborted=true);return new Promise(resolve=>{release=()=>resolve(answer(r));});}});
 const lease=f.owners.register(f.owner({ownerId:'expiring',attemptId:'active-expiry'}),3000);
 const assignment=f.owners.assignment(lease,f.broker.endpoint);
 const pending=rankDiscovery(assignment,{paths:['docs/a'],discovery:{complete:true}});await ready;
 assert.equal((await pending as any).error,'revoked');assert.equal(aborted,true);assert.equal(lease.signal.aborted,true);assert.equal(lease.attemptSignal.aborted,false);
 release();assert.equal((await rankDiscovery(assignment,{paths:['docs/b'],discovery:{complete:true}}) as any).error,'unauthorized');assert.equal(f.rankCalls(),1);
 f.owners.dispose();assert.equal(lease.attemptSignal.aborted,true);
});
function until<T>(promise:Promise<T>,ms=5000):Promise<T>{
 return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('barrier timeout')),ms);promise.then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});});
}
function deadlineFrame(f:any,patch={}){const {endpoint:_endpoint,...identity}=f.assignment;return JSON.stringify({type:'rank_deadline',...identity,requestId:'r1',...patch})+'\n';}
async function causalFixture(t:any,brokerLimits:Record<string,number>={}){
 const root=mkdtempSync(join(tmpdir(),'d9-causal-'));mkdirSync(join(root,'docs'));for(const p of ['a','b'])writeFileSync(join(root,'docs',p),'safe content '+p);
 const store=createCommunicationStore();store.setEnabled(true);let entered!:()=>void;let ready=new Promise<void>(r=>entered=r);let hold=true,calls=0,ranks=0,scheduled=0,fired=0;
 const results:any[]=[],waiters:Array<(value:any)=>void>=[];
 const clock={setTimeout:((fn:any)=>{scheduled++;return scheduled;}) as any,clearTimeout:((()=>{}) as any)};
 const runtime=createDiscoveryRuntime({root,sessionId:'session',config:parseFileDiscoveryConfig({mode:'active',remoteContextApproved:true,include:['docs']}),service:{evaluate(r:any){calls++;entered();if(!hold)return answer(r);return new Promise(()=>{});}},context:()=>'task',persist(){},observe:m=>store.beginDiscovery(m),clock});
 const realRank=runtime.rank.bind(runtime);runtime.rank=async(job:any)=>{const result=await realRank(job);ranks++;const waiter=waiters.shift();if(waiter)waiter(result);else results.push(result);return result;};
 const owners=createDiscoveryOwners('session',()=>'task');const broker=await createDiscoveryBroker({root,runtime,owners,limits:brokerLimits});
 const lease=owners.register({taskId:'task',ownerId:'worker',attemptId:'attempt',cwd:root,task:'rounding',query:'search docs',effectiveTools:['find','read'],readRoots:['docs'],exportRoots:['docs'],canRead:()=>true,canDisplay:()=>true,permissionIdentity:()=>'v1'});
 const assignment=owners.assignment(lease,broker.endpoint);const sockets=new Set<any>();
 t.after(async()=>{for(const socket of sockets)socket.destroy();runtime.dispose();await broker.close();rmSync(root,{recursive:true,force:true});});
 return {assignment,owners,lease,store,broker,calls:()=>calls,ranks:()=>ranks,clock:()=>({scheduled,fired}),entered:()=>ready,arm(){ready=new Promise<void>(r=>entered=r);return ready;},nextRank(){if(results.length)return Promise.resolve(results.shift());return new Promise(resolve=>waiters.push(resolve));},setHold(value:boolean){hold=value;},track(socket:any){sockets.add(socket);return socket;}};
}
async function connect(f:any){const socket=f.track(createConnection(f.broker.endpoint));await new Promise<void>(r=>socket.once('connect',r));return socket;}
function assertDeadlineResult(ranked:any,store:any){
 assert.equal(ranked.status,'unavailable');assert.equal(ranked.rows.length,2);assert.ok(ranked.rows.every((row:any)=>row.reason==='deadline'));
 assert.equal(store.snapshot().at(-1).status,'unavailable');assert.ok(!JSON.stringify(ranked).includes('safe content'));assert.ok(!JSON.stringify(store.snapshot()).includes('safe content'));
}
test('broker timer reaches production runtime as unavailable deadline before the job timer and leaves the owner healthy',async t=>{
 assert.equal(BROKER_LIMITS.requestMs,20000);assert.equal(BROKER_LIMITS.partialFrameMs,1000);assert.equal(FILE_DISCOVERY_LIMITS.jobTimeoutMs,20000);assert.equal(FILE_DISCOVERY_LIMITS.discoveryMs,1000);
 const f=await causalFixture(t,{requestMs:3000});
 const pending=rankDiscovery(f.assignment,{paths:['docs/a','docs/b'],discovery:{complete:true}},undefined,8000);
 assert.equal(await Promise.race([f.entered().then(()=>'entered'),pending.then(()=>'early')]),'entered');
 const client=await until(pending) as any,ranked=await until(f.nextRank());
 assert.equal(client.error,'deadline');assertDeadlineResult(ranked,f.store);assert.equal(f.clock().fired,0);assert.equal(f.clock().scheduled,1);
 assert.equal(f.lease.signal.aborted,false);assert.equal(f.lease.attemptSignal.aborted,false);assert.equal(f.owners.size,1);assert.equal(f.store.snapshot().length,1);
 f.setHold(false);const again=await rankDiscovery(f.assignment,{paths:['docs/a'],discovery:{complete:true}},undefined,8000) as any;
 assert.equal(again.ok,true);assert.equal(again.result.rows[0].status,'scored');assert.equal(f.lease.attemptSignal.aborted,false);assert.equal(f.clock().fired,0);
});
test('client timer sends a request-bound deadline before socket close and before the runtime job timer',async t=>{
 const f=await causalFixture(t,{requestMs:8000});
 const pending=rankDiscovery(f.assignment,{paths:['docs/a','docs/b'],discovery:{complete:true}},undefined,4000);
 assert.equal(await Promise.race([f.entered().then(()=>'entered'),pending.then(()=>'early')]),'entered');
 const client=await until(pending) as any,ranked=await until(f.nextRank());
 assert.equal(client.error,'deadline');assertDeadlineResult(ranked,f.store);assert.equal(f.clock().fired,0);assert.equal(f.lease.signal.aborted,false);assert.equal(f.lease.attemptSignal.aborted,false);
});
test('deadline frame then socket end stays deadline, while a bare end stays cancelled, both before the job timer',async t=>{
 const deadline=await causalFixture(t,{requestMs:8000});const socket=await connect(deadline);
 socket.write(JSON.stringify(request(deadline))+'\n');
 await until(deadline.entered());
 socket.end(deadlineFrame(deadline));const ranked=await until(deadline.nextRank());
 assertDeadlineResult(ranked,deadline.store);assert.equal(deadline.clock().fired,0);assert.equal(deadline.lease.attemptSignal.aborted,false);
 const bare=await causalFixture(t,{requestMs:8000});const closed=await connect(bare);
 closed.write(JSON.stringify(request(bare))+'\n');
 await until(bare.entered());
 closed.end();const cancelled=await until(bare.nextRank());
 assert.equal(cancelled.status,'cancelled');assert.ok(cancelled.rows.every((row:any)=>row.reason==='cancelled'));
 assert.equal(bare.store.snapshot().at(-1).status,'cancelled');assert.equal(bare.clock().fired,0);assert.equal(bare.lease.signal.aborted,false);assert.equal(bare.lease.attemptSignal.aborted,false);
});
test('malformed, foreign and duplicate terminal frames cannot collect sources or start another rank',async t=>{
 const f=await fixture(t);const rank=JSON.stringify(request(f))+'\n';
 assert.equal(await raw(f.broker.endpoint,rank+'{"type":"rank_deadline"}\n'),null);
 assert.equal(await raw(f.broker.endpoint,rank+deadlineFrame(f,{requestId:'r2'})),null);
 assert.equal(await raw(f.broker.endpoint,rank+deadlineFrame(f,{paths:['docs/a']})),null);
 assert.equal(await raw(f.broker.endpoint,rank+JSON.stringify(request(f,{requestId:'r2'}))+'\n'),null);
 assert.equal(f.rankCalls(),0);assert.equal(f.calls(),0);assert.equal(f.owners.size,1);
 const foreign=await causalFixture(t,{requestMs:8000});const socket=await connect(foreign);
 socket.write(JSON.stringify(request(foreign))+'\n');
 await until(foreign.entered());
 const calls=foreign.calls();socket.write(deadlineFrame(foreign,{requestId:'r2'}));
 const rejected=await until(foreign.nextRank());assert.equal(rejected.status,'cancelled');assert.ok(rejected.rows.every((row:any)=>row.reason==='cancelled'));
 await delay(40);assert.equal(foreign.calls(),calls);assert.equal(foreign.ranks(),1);assert.equal(foreign.clock().fired,0);
 const duplicate=await causalFixture(t,{requestMs:8000});const again=await connect(duplicate);
 again.write(JSON.stringify(request(duplicate))+'\n');
 await until(duplicate.entered());
 again.write(deadlineFrame(duplicate));const first=await until(duplicate.nextRank());
 assert.equal(first.status,'unavailable');assert.ok(first.rows.every((row:any)=>row.reason==='deadline'));
 const after=duplicate.calls();again.write(deadlineFrame(duplicate));await delay(40);
 assert.equal(duplicate.ranks(),1);assert.equal(duplicate.calls(),after);assert.equal(duplicate.lease.attemptSignal.aborted,false);assert.equal(duplicate.clock().fired,0);
});
test('explicit caller abort and owner revoke stay cancelled or revoked and do not revoke a healthy attempt on advisory deadline',async t=>{
 const aborted=await causalFixture(t,{requestMs:8000});const controller=new AbortController();
 const pending=rankDiscovery(aborted.assignment,{paths:['docs/a'],discovery:{complete:true}},controller.signal,8000);
 assert.equal(await Promise.race([aborted.entered().then(()=>'entered'),pending.then(()=>'early')]),'entered');
 controller.abort();assert.equal((await until(pending) as any).error,'cancelled');const cancelled=await until(aborted.nextRank());
 assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.rows[0].reason,'cancelled');assert.equal(aborted.lease.attemptSignal.aborted,false);assert.equal(aborted.clock().fired,0);
 const revoked=await causalFixture(t,{requestMs:8000});
 const active=rankDiscovery(revoked.assignment,{paths:['docs/a'],discovery:{complete:true}},undefined,8000);
 assert.equal(await Promise.race([revoked.entered().then(()=>'entered'),active.then(()=>'early')]),'entered');
 revoked.owners.revoke(revoked.lease.capability);assert.equal((await until(active) as any).error,'revoked');assert.equal(revoked.lease.attemptSignal.aborted,true);
 const fenced=await until(revoked.nextRank());assert.ok(!JSON.stringify(fenced).includes('deadline'));assert.equal(revoked.clock().fired,0);
});
async function writeSplit(socket:any,frame:string){
 const body=frame.endsWith('\n')?frame.slice(0,-1):frame;
 for(let i=0;i<body.length;i+=16){socket.write(body.slice(i,i+16));await delay(2);}
 await delay(2);socket.write('\n');
}
test('split authenticated terminal JSON and newline project a real deadline before the runtime job timer',async t=>{
 assert.equal(BROKER_LIMITS.partialFrameMs,1000);assert.equal(BROKER_LIMITS.requestMs,20000);assert.equal(FILE_DISCOVERY_LIMITS.jobTimeoutMs,20000);assert.equal(FILE_DISCOVERY_LIMITS.discoveryMs,1000);
 const f=await causalFixture(t,{requestMs:8000,partialFrameMs:1000});const socket=await connect(f);
 socket.write(JSON.stringify(request(f))+'\n');await until(f.entered());
 await writeSplit(socket,deadlineFrame(f));const ranked=await until(f.nextRank());
 assertDeadlineResult(ranked,f.store);assert.equal(f.ranks(),1);assert.equal(f.clock().fired,0);assert.equal(f.clock().scheduled,1);
 assert.equal(f.lease.signal.aborted,false);assert.equal(f.lease.attemptSignal.aborted,false);assert.equal(f.owners.size,1);
 const calls=f.calls();await delay(40);assert.equal(f.ranks(),1);assert.equal(f.calls(),calls);assert.ok(!JSON.stringify(ranked).includes(f.assignment.capability));
});
test('a valid coalesced rank and authenticated deadline frame projects deadline without another rank',async t=>{
 assert.equal(BROKER_LIMITS.frameBytes,65536);assert.equal(FILE_DISCOVERY_LIMITS.jobTimeoutMs,20000);
 const f=await causalFixture(t,{requestMs:8000});const socket=await connect(f);
 socket.write(JSON.stringify(request(f))+'\n'+deadlineFrame(f));const ranked=await until(f.nextRank());
 assertDeadlineResult(ranked,f.store);assert.equal(f.ranks(),1);await delay(40);assert.equal(f.ranks(),1);assert.equal(f.calls(),0);
 assert.equal(f.clock().fired,0);assert.equal(f.lease.signal.aborted,false);assert.equal(f.lease.attemptSignal.aborted,false);assert.equal(f.owners.size,1);
 assert.ok(!JSON.stringify(ranked).includes(f.assignment.capability));assert.ok(!JSON.stringify(f.store.snapshot()).includes(f.assignment.capability));
});
test('caller abort after the local deadline cannot replace a pending causal ACK',async t=>{
 assert.equal(BROKER_LIMITS.requestMs,20000);assert.equal(BROKER_LIMITS.partialFrameMs,1000);assert.equal(FILE_DISCOVERY_LIMITS.jobTimeoutMs,20000);
 const f=await causalFixture(t,{requestMs:8000});const controller=new AbortController();const original=Socket.prototype.end;let delayed=0;
 Socket.prototype.end=function(this:any,...args:any[]){const chunk=args[0];if(typeof chunk==='string'&&chunk.includes('"error":"deadline"')&&this.server){delayed++;controller.abort();const self=this;setTimeout(()=>original.apply(self,args),50);return this;}return original.apply(this,args);} as any;
 try{
  const pending=rankDiscovery(f.assignment,{paths:['docs/a','docs/b'],discovery:{complete:true}},controller.signal,4000);
  assert.equal(await Promise.race([f.entered().then(()=>'entered'),pending.then(()=>'early')]),'entered');
  const client=await until(pending,8000) as any,ranked=await until(f.nextRank(),8000);
  assert.equal(delayed,1);assert.equal(controller.signal.aborted,true);assert.equal(client.error,'deadline');assertDeadlineResult(ranked,f.store);
  assert.equal(f.clock().fired,0);assert.equal(f.lease.signal.aborted,false);assert.equal(f.lease.attemptSignal.aborted,false);assert.equal(f.owners.size,1);
 }finally{Socket.prototype.end=original;}
});
