import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {mkdtempSync,mkdirSync,writeFileSync,appendFileSync,chmodSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CodexUnixQueueRpc,QueueRpcError} from './lib/codex-unix-queue-rpc.ts';
import {CodexDaemonObserver} from './lib/codex-daemon-observer.ts';
import {CodexProbeTranscript} from './lib/codex-probe-transcript.ts';
import {CodexBootstrapProbe} from './lib/codex-bootstrap-probe.ts';
import {targetKey,type QueueCompatibilityAssessment} from '../../harnesses/lib/fleet-notification-validation.ts';
const require=createRequire(import.meta.url),{WebSocketServer}=require('ws');
const THREAD='11111111-1111-4111-8111-111111111111',NONCE='22222222-2222-4222-8222-222222222222';
const owner={project:'af-test',peer:'synthetic',sessionId:'33333333-3333-4333-8333-333333333333',startedAt:'2026-11-12T00:00:00.000Z'};
async function fixture(t:any,options:{metadata?:(count:number,path:string)=>any;ua?:string;badQueue?:boolean;noAck?:boolean;mutateSocketAt?:'initialize'|'result'}={}){
 const root=mkdtempSync(join(tmpdir(),'af-probe-')),socketPath=join(root,'d.sock'),home=join(root,'home'),sessions=join(home,'sessions');mkdirSync(sessions,{recursive:true,mode:0o700});
 const path=join(sessions,'rollout-SYNTHETIC-'+THREAD+'.jsonl');writeFileSync(path,JSON.stringify({type:'session_meta',payload:{id:THREAD}})+'\n',{mode:0o600});
 const server=createServer(),wss=new WebSocketServer({server}),sockets=new Set<any>(),calls:any[]=[];let reads=0;
 wss.on('connection',(socket:any)=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));socket.on('message',(bytes:Buffer)=>{
  const request=JSON.parse(bytes.toString('utf8'));calls.push(request);
  if(request.method==='initialize'){if(options.mutateSocketAt==='initialize')chmodSync(socketPath,0o640);socket.send(JSON.stringify({id:request.id,result:{userAgent:options.ua??'Codex Desktop/0.167.1'}}));}
  else if(request.method==='thread/read'){
   reads++;const value=options.metadata?options.metadata(reads,path):{thread:{id:THREAD,status:{type:'notLoaded'},path}};
   if(options.mutateSocketAt==='result')chmodSync(socketPath,0o640);socket.send(JSON.stringify({id:request.id,result:value}));
  }else if(request.method==='thread/queue/add'){
   const input=request.params.input,text=input[0].text,envelope=JSON.parse(text.split('\n')[1]);
   socket.send(JSON.stringify({id:request.id,result:{queuedSubmission:{id:'SYNTHETIC-QUEUE-NOT-DELIVERY',clientUserMessageId:options.badQueue?'wrong':request.params.clientUserMessageId,input}}}));
   if(!options.noAck)appendFileSync(path,JSON.stringify({type:'response_item',payload:{type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'FLEET_PROBE_ACK '+envelope.probeId}]}})+'\n');
  }
 });});
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,resolve);});chmodSync(socketPath,0o600);
 const reader=new CodexProbeTranscript({codexHome:home,timeoutMs:500,pollMs:2}),rpc=new CodexUnixQueueRpc({socketPath,timeoutMs:1000});
 const pin={daemonVersion:'0.167.1',socketEpoch:new CodexDaemonObserver({socketPath}).socketEpoch(new AbortController().signal)};
 const assessment:QueueCompatibilityAssessment={level:'contract_checked',fingerprint:'a'.repeat(64),context:{...pin,desktopVersion:'0.167.0-alpha.3.2'},requiresProbe:true,activation:'not_performed'};
 const request={scope:{namespace:{hostProfile:'desktop',principal:'synthetic-only',threadId:THREAD},owner,rights:['read','send','approve'] as const,until:Date.now()+60000,binding:{id:'synthetic-bootstrap',epoch:'synthetic-epoch',hostInstance:'44444444-4444-4444-8444-444444444444',threadId:THREAD,fleetOwner:targetKey(owner)}},assessment,probeId:NONCE};
 t.after(async()=>{await reader.stop();for(const socket of sockets)socket.terminate();await new Promise<void>(resolve=>wss.close(()=>resolve()));await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(root,{recursive:true,force:true});});
 return {root,path,socketPath,reader,rpc,pin,calls,request};
}

test('pinned real synthetic WS connection measures initialize version, exact epoch and detached pin without changing legacy request',async t=>{
 const f=await fixture(t),options={pin:{...f.pin},beforeWrite:()=>{options.pin.socketEpoch='caller-mutated';options.pin.daemonVersion='0.0.0';}};
 const result:any=await f.rpc.request('thread/read',{threadId:THREAD,includeTurns:false},options);assert.equal(result.thread.id,THREAD);
 assert.equal(f.calls.filter(c=>c.method==='initialize').length,1);assert.equal(f.calls.filter(c=>c.method==='thread/read').length,1);
 assert.equal((await f.rpc.request('thread/read',{threadId:THREAD,includeTurns:false})as any).thread.id,THREAD);
});

test('changed or malformed initialize version fails before a method write; build metadata equality is exact',async t=>{
 for(const ua of ['Codex Desktop/0.167.0','Codex Desktop/0.167.1+different','Codex Desktop/01.167.1','not-a-daemon','Codex Desktop/0.167.1(trailing)']){
  const f=await fixture(t,{ua});await assert.rejects(f.rpc.request('thread/read',{threadId:THREAD},{pin:f.pin}),e=>e instanceof QueueRpcError&&e.code==='VERSION_CHANGED'&&!e.attempted);
  assert.equal(f.calls.some(c=>c.method==='thread/read'),false);assert.equal(f.calls.some(c=>c.method==='initialized'),false);
 }
});

test('pinned and measurement UA parsers share the measured optional suffix grammar, never clientInfo aliases',async t=>{
 const f=await fixture(t,{ua:'Codex Desktop/0.167.1 (SYNTHETIC-PLATFORM)'});assert.equal((await f.rpc.request('thread/read',{threadId:THREAD},{pin:f.pin})as any).thread.id,THREAD);
});

test('pinned queue accepts exact Fleet originators while pinning the first daemon build token',async t=>{
 for(const originator of ['agent_fleet_contract_observer','agent_fleet_queue_bridge']){
  const f=await fixture(t,{ua:originator+'/0.167.1 (Ubuntu 25.10.0; x86_64) herdr/0.9.5 ('+originator+'; 1)'});
  assert.equal((await f.rpc.request('thread/read',{threadId:THREAD},{pin:f.pin})as any).thread.id,THREAD);
 }
});

test('pinned queue rejects another first daemon version even when suffix contains the expected version',async t=>{
 const f=await fixture(t,{ua:'agent_fleet_queue_bridge/0.169.0 (client; 0.167.1) Codex Desktop/0.167.1'});
 await assert.rejects(f.rpc.request('thread/read',{threadId:THREAD},{pin:f.pin}),e=>e instanceof QueueRpcError&&e.code==='VERSION_CHANGED'&&!e.attempted);
 assert.equal(f.calls.some(c=>c.method==='thread/read'),false);
});

test('observer epoch is checked before connect and at initialize/result, not just the old inode-only epoch',async t=>{
 const early=await fixture(t);await assert.rejects(early.rpc.request('thread/read',{}, {pin:{...early.pin,socketEpoch:'codex-initialize/v1:'+'0'.repeat(64)}}),/SOCKET_CHANGED/);assert.equal(early.calls.length,0);
 for(const stage of ['initialize','result']as const){const f=await fixture(t,{mutateSocketAt:stage});await assert.rejects(f.rpc.request('thread/read',{threadId:THREAD},{pin:f.pin}),e=>e instanceof QueueRpcError&&e.code==='SOCKET_CHANGED'&&e.attempted===(stage==='result'));}
});

test('concrete probe reads exact metadata path, checkpoints before single enqueue, accepts new local final ACK then rechecks notLoaded',async t=>{
 const f=await fixture(t);let guards=0;const probe=new CodexBootstrapProbe({rpc:f.rpc,reader:f.reader,guard:()=>{guards++;}});
 const ack=await probe.run(f.request,new AbortController().signal);assert.equal(ack.status,'acknowledged');assert.equal(ack.source,'read_only_assistant_transcript');assert.equal(ack.notLoadedBefore,true);assert.equal(ack.notLoadedAfter,true);assert.equal(ack.threadId,THREAD);assert.equal(ack.probeId,NONCE);assert.equal(ack.socketEpoch,f.pin.socketEpoch);assert.match(ack.receiptId,/^rollout:[a-f0-9]{64}$/);
 assert.equal(f.calls.filter(c=>c.method==='thread/queue/add').length,1);assert.equal(f.calls.filter(c=>c.method==='thread/read').length,3);assert.ok(f.calls.filter(c=>c.method==='thread/read').every(c=>c.params.includeTurns===false));assert.ok(guards>=9);
 await assert.rejects(probe.run(f.request,new AbortController().signal),/not_replayable/);assert.equal(f.calls.filter(c=>c.method==='thread/queue/add').length,1);
});

test('missing/null/unsafe path, wrong thread, loaded target or missing trusted guard blocks before enqueue',async t=>{
 for(const value of [null,undefined,'/outside-rollout.jsonl']){
  const f=await fixture(t,{metadata:()=>({thread:{id:THREAD,status:{type:'notLoaded'},path:value}})}),probe=new CodexBootstrapProbe({rpc:f.rpc,reader:f.reader,guard:()=>{}});
  await assert.rejects(probe.run(f.request,new AbortController().signal),/not_sent/);assert.equal(f.calls.some(c=>c.method==='thread/queue/add'),false);
 }
 for(const thread of [{id:NONCE,status:{type:'notLoaded'}},{id:THREAD,status:{type:'idle'}}]){const f=await fixture(t,{metadata:(_n,path)=>({thread:{...thread,path}})}),probe=new CodexBootstrapProbe({rpc:f.rpc,reader:f.reader,guard:()=>{}});await assert.rejects(probe.run(f.request,new AbortController().signal),/not_sent/);assert.equal(f.calls.some(c=>c.method==='thread/queue/add'),false);}
 const f=await fixture(t),probe=new CodexBootstrapProbe({rpc:f.rpc,reader:f.reader,guard:()=>{throw Error('synthetic missing identity or no-load capability');}});await assert.rejects(probe.run(f.request,new AbortController().signal),/not_sent/);assert.equal(f.calls.length,0);
});

test('enqueue echo mismatch, absent ACK or target/path changed after ACK are unknown, never success or retransmission',async t=>{
 for(const options of [{badQueue:true},{noAck:true},{metadata:(n:number,path:string)=>({thread:{id:THREAD,status:{type:n>=3?'idle':'notLoaded'},path}})},{metadata:(n:number,path:string)=>({thread:{id:THREAD,status:{type:'notLoaded'},path:n>=3?path+'.changed':path}})}]){
  const f=await fixture(t,options),probe=new CodexBootstrapProbe({rpc:f.rpc,reader:f.reader,guard:()=>{}});await assert.rejects(probe.run(f.request,new AbortController().signal),/unknown_no_replay/);
  await assert.rejects(probe.run(f.request,new AbortController().signal),/not_replayable/);assert.equal(f.calls.filter(c=>c.method==='thread/queue/add').length,1);
 }
});

test('checkpoint ignores a preexisting matching ACK and cancellation never returns a delivery proof',async t=>{
 const f=await fixture(t,{noAck:true});appendFileSync(f.path,JSON.stringify({type:'response_item',payload:{type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'FLEET_PROBE_ACK '+NONCE}]}})+'\n');
 const controller=new AbortController(),probe=new CodexBootstrapProbe({rpc:f.rpc,reader:f.reader,guard:()=>{}}),work=probe.run(f.request,controller.signal);
 const timer=setInterval(()=>{if(f.calls.some(c=>c.method==='thread/queue/add'))controller.abort();},2);
 try{await assert.rejects(work,/unknown_no_replay/);}finally{clearInterval(timer);}
 assert.equal(f.calls.filter(c=>c.method==='thread/queue/add').length,1);
});
