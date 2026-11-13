import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,chmod,rm,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {getEventListeners} from 'node:events';
import {symlinkSync,unlinkSync,renameSync,writeFileSync} from 'node:fs';
import {CodexDaemonObserver,CodexObserverError} from './lib/codex-daemon-observer.ts';
import {measureDaemon,CodexMeasurementError} from './lib/codex-measurement.ts';
const require=createRequire(import.meta.url),{WebSocketServer}=require('ws');
const posixTest=process.platform==='win32'?test.skip:test;
const ua='Codex Desktop/0.167.1 (fixture observer;1)';
const code=(expected:string)=>(error:unknown)=>error instanceof CodexObserverError&&error.code===expected;
const signal=()=>new AbortController().signal;
async function fixture(t:TestContext){
 const root=await realpath(await mkdtemp(join(tmpdir(),'co-'))),directory=join(root,'c');await mkdir(directory,{mode:0o700});
 const path=join(directory,'s'),server=createServer(),wss=new WebSocketServer({noServer:true,maxPayload:32768});
 const methods:string[]=[],packets:any[]=[];let upgrades=0,deny=false;let beforeUpgrade=()=>{};
 let respond=(ws:any,packet:any)=>ws.send(JSON.stringify({id:packet.id,result:{userAgent:ua,codexHome:'/must-not-return',socketEpoch:'remote-forged'}}));
 server.on('upgrade',(request,socket,head)=>{upgrades++;assert.equal(request.headers.authorization,undefined);if(deny){socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');return;}beforeUpgrade();wss.handleUpgrade(request,socket,head,(ws:any)=>wss.emit('connection',ws));});
 wss.on('connection',(ws:any)=>{ws.on('error',()=>{});ws.on('message',(raw:Buffer)=>{
  const packet=JSON.parse(raw.toString('utf8'));packets.push(packet);methods.push(packet.method??'unexpected-response');
  assert.equal(packet.method,'initialize','observer must never send another method or approval reply');respond(ws,packet);
 });});
 await new Promise<void>(resolve=>server.listen(path,resolve));await chmod(path,0o600);
 t.after(async()=>{for(const ws of wss.clients)ws.terminate();await new Promise<void>(resolve=>server.close(()=>resolve()));wss.close();await rm(root,{recursive:true,force:true});});
 const make=(timeoutMs=300)=>new CodexDaemonObserver({socketPath:path,timeoutMs});
 return {root,directory,path,methods,packets,make,connections:()=>wss.clients.size,upgrades:()=>upgrades,setResponder:(handler:typeof respond)=>{respond=handler;},changeOnUpgrade:(callback:()=>void)=>{beforeUpgrade=callback;},denyUpgrade:()=>{deny=true;}};
}

posixTest('connect-only adapter measures initialization, returns own epoch and sends no initialized/queue/approval messages',async t=>{
 const f=await fixture(t),observer=f.make(),epoch=observer.socketEpoch(signal());
 assert.equal('request' in observer,false);
 assert.deepEqual(await measureDaemon(observer),{kind:'initialize_version_observation',version:'0.167.1',socketEpoch:epoch});
 assert.deepEqual(f.methods,['initialize']);assert.equal(f.upgrades(),1);
 assert.deepEqual(f.packets[0].params.capabilities,{experimentalApi:false});
 const initialized=await observer.initialize(signal(),epoch);
 assert.deepEqual(initialized,{socketEpoch:epoch,result:{userAgent:ua}});
 assert.ok(!JSON.stringify(initialized).includes('must-not-return'));assert.ok(!JSON.stringify(initialized).includes('remote-forged'));
});

posixTest('deadline expiring during HTTP request construction is TIMEOUT, not a fabricated cancellation',async t=>{
 const f=await fixture(t),observer=f.make(),epoch=observer.socketEpoch(signal());
 const http=require('node:http') as typeof import('node:http'),request=http.request;let now=0;
 const clock=t.mock.method(performance,'now',()=>now);
 const construction=t.mock.method(http,'request',(...args:any[])=>{now=1000;return Reflect.apply(request,http,args);});
 try {
  await assert.rejects(observer.initialize(signal(),epoch),code('TIMEOUT'));
  assert.equal(f.upgrades(),0);assert.deepEqual(f.methods,[]);
 } finally {construction.mock.restore();clock.mock.restore();}
});

posixTest('mismatched epoch, missing daemon and pre-aborted call never connect',async t=>{
 const f=await fixture(t),observer=f.make(),controller=new AbortController();controller.abort();
 await assert.rejects(observer.initialize(signal(),'codex-initialize/v1:'+'0'.repeat(64)),code('SOCKET_CHANGED'));
 await assert.rejects(observer.initialize(controller.signal,observer.socketEpoch(signal())),code('CANCELLED'));
 const missing=new CodexDaemonObserver({socketPath:join(f.directory,'missing')});
 assert.throws(()=>missing.socketEpoch(signal()),code('DAEMON_UNAVAILABLE'));
 assert.equal(f.upgrades(),0);assert.deepEqual(f.methods,[]);
});

posixTest('notifications, server requests with matching ids and unrelated responses are ignored without any reply',async t=>{
 const f=await fixture(t);f.setResponder((ws,packet)=>{
  ws.send(JSON.stringify({id:packet.id,method:'item/commandExecution/requestApproval',result:{userAgent:'Codex Desktop/999.0.0'}}));
  ws.send(JSON.stringify({method:'thread/started',params:{}}));
  ws.send(JSON.stringify({id:'not-ours',result:{userAgent:'Codex Desktop/999.0.0'}}));
  ws.send(JSON.stringify({id:packet.id,result:{userAgent:ua,socketEpoch:'forged'}}));
 });
 const observer=f.make(),controller=new AbortController();
 assert.equal((await measureDaemon(observer,{signal:controller.signal})).version,'0.167.1');
 assert.deepEqual(f.methods,['initialize']);assert.equal(getEventListeners(controller.signal,'abort').length,0);
});

posixTest('invalid constructor inputs and unsafe socket/alias/ancestor cases fail before connection',async t=>{
 for(const socketPath of ['relative','/tmp/bad:socket','/tmp/bad?socket','/tmp/bad\u0000socket','/'+ 'x'.repeat(100)])assert.throws(()=>new CodexDaemonObserver({socketPath}),code('INVALID_SOCKET_PATH'));
 for(const timeoutMs of [0,10001,NaN])assert.throws(()=>new CodexDaemonObserver({socketPath:'/tmp/fixture',timeoutMs}),code('INVALID_TIMEOUT'));
 for(const kind of ['directory','socket','ancestor','chain','regular']){
  const f=await fixture(t);let path=f.path;
  if(kind==='directory')await chmod(f.directory,0o755);
  if(kind==='socket')await chmod(f.path,0o666);
  if(kind==='ancestor')await chmod(f.root,0o777);
  if(kind==='chain'){const alias=join(f.directory,'a');symlinkSync(f.path,alias);path=join(f.directory,'b');symlinkSync(alias,path);}
  if(kind==='regular'){path=join(f.directory,'file');writeFileSync(path,'not a socket',{mode:0o600});}
  assert.throws(()=>new CodexDaemonObserver({socketPath:path}).socketEpoch(signal()),code('UNSAFE_SOCKET'));
  assert.equal(f.upgrades(),0);
 }
});

posixTest('alias changes before upgrade/response and restored alias inode cannot relabel a connection',async t=>{
 for(const phase of ['before-open','response','restored']){
  const f=await fixture(t),other=await fixture(t),alias=join(f.directory,'a');symlinkSync(f.path,alias);
  const observer=new CodexDaemonObserver({socketPath:alias,timeoutMs:1000}),epoch=observer.socketEpoch(signal());
  const change=()=>{
   if(phase==='restored'){const saved=join(f.directory,'saved');renameSync(alias,saved);symlinkSync(other.path,alias);unlinkSync(alias);renameSync(saved,alias);}
   else {unlinkSync(alias);symlinkSync(other.path,alias);}
  };
  if(phase==='before-open')f.changeOnUpgrade(change);
  else f.setResponder((ws,packet)=>{change();ws.send(JSON.stringify({id:packet.id,result:{userAgent:ua,socketEpoch:epoch}}));});
  await assert.rejects(observer.initialize(signal(),epoch),code('SOCKET_CHANGED'));
  assert.deepEqual(f.methods,phase==='before-open'?[]:['initialize']);assert.equal(other.upgrades(),0);
 }
});

posixTest('malformed/nonresponse/error/binary frames reject with coded errors and never echo remote details',async t=>{
 for(const kind of ['json','array','error','missing-ua','control-ua','binary']){
  const f=await fixture(t);f.setResponder((ws,packet)=>{
   if(kind==='json')ws.send('{');
   if(kind==='array')ws.send('[]');
   if(kind==='error')ws.send(JSON.stringify({id:packet.id,error:{message:'private-remote-detail'}}));
   if(kind==='missing-ua')ws.send(JSON.stringify({id:packet.id,result:{clientInfo:{version:'0.167.1'}}}));
   if(kind==='control-ua')ws.send(JSON.stringify({id:packet.id,result:{userAgent:'Codex Desktop/0.167.1\nunsafe'}}));
   if(kind==='binary')ws.send(Buffer.from(JSON.stringify({id:packet.id,result:{userAgent:ua}})));
  });
  const observer=f.make(1000),expected=kind==='json'?'INVALID_JSON':kind==='array'||kind==='binary'?'INVALID_RESPONSE':'INITIALIZE_REJECTED';
  await assert.rejects(observer.initialize(signal(),observer.socketEpoch(signal())),error=>code(expected)(error)&&!(error as Error).message.includes('private-remote-detail'));
  assert.deepEqual(f.methods,['initialize']);
 }
});

posixTest('payload and message-count limits reject bounded traffic without approval replies',async t=>{
 for(const kind of ['payload','count']){
  const f=await fixture(t);f.setResponder((ws,packet)=>{
   if(kind==='payload')ws.send(JSON.stringify({id:packet.id,result:{userAgent:ua},padding:'x'.repeat(32768)}));
   else for(let i=0;i<257;i++)ws.send(JSON.stringify({id:i,method:'item/commandExecution/requestApproval'}));
  });
  const observer=f.make(1000);
  await assert.rejects(observer.initialize(signal(),observer.socketEpoch(signal())),code(kind==='payload'?'CONNECTION_ERROR':'RESPONSE_LIMIT'));
  assert.deepEqual(f.methods,['initialize']);
 }
});

posixTest('timeout and active cancellation close owned transport and remove caller listeners',async t=>{
 for(const kind of ['timeout','cancel']){
  const f=await fixture(t),controller=new AbortController();f.setResponder(()=>{if(kind==='cancel')controller.abort();});
  const observer=f.make(kind==='timeout'?50:1000);
  await assert.rejects(observer.initialize(controller.signal,observer.socketEpoch(signal())),code(kind==='timeout'?'TIMEOUT':'CANCELLED'));
  assert.equal(getEventListeners(controller.signal,'abort').length,0);
  for(let i=0;i<100&&f.connections();i++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(f.connections(),0);assert.ok(f.methods.length<=1);
 }
 const f=await fixture(t);f.setResponder(()=>{});
 await assert.rejects(measureDaemon(f.make(1000),{timeoutMs:30}),error=>error instanceof CodexMeasurementError&&error.code==='measurement_timeout');
});

posixTest('auth rejection and remote close have no fallback connection or authentication discovery',async t=>{
 for(const kind of ['auth','close']){
  const f=await fixture(t);if(kind==='auth')f.denyUpgrade();else f.setResponder((ws)=>ws.terminate());
  const observer=f.make(1000);
  await assert.rejects(observer.initialize(signal(),observer.socketEpoch(signal())),code(kind==='auth'?'CONNECTION_ERROR':'CONNECTION_CLOSED'));
  assert.equal(f.upgrades(),1);assert.deepEqual(f.methods,kind==='auth'?[]:['initialize']);
 }
});

posixTest('unknown UA grammar stays unavailable through the real adapter rather than using clientInfo',async t=>{
 const f=await fixture(t);f.setResponder((ws,packet)=>ws.send(JSON.stringify({id:packet.id,result:{userAgent:'codex-cli/0.167.1',clientInfo:{version:'0.167.1'}}})));
 await assert.rejects(measureDaemon(f.make()),error=>error instanceof CodexMeasurementError&&error.code==='daemon_version_unavailable');
 assert.deepEqual(f.methods,['initialize']);
});

posixTest('concurrent observations on one adapter retain separate ids, signals and cleanup',async t=>{
 const f=await fixture(t),observer=f.make(1000),a=new AbortController(),b=new AbortController();let first!:()=>void;
 const received=new Promise<void>(resolve=>{first=resolve;});
 f.setResponder((ws,packet)=>{if(f.packets.length===1)first();else {a.abort();ws.send(JSON.stringify({id:packet.id,result:{userAgent:ua}}));}});
 const epoch=observer.socketEpoch(signal()),pending=observer.initialize(a.signal,epoch).catch(error=>error);
 await received;const result=await observer.initialize(b.signal,epoch);
 assert.ok(code('CANCELLED')(await pending));assert.equal(result.socketEpoch,epoch);assert.equal(result.result.userAgent,ua);
 assert.notEqual(f.packets[0].id,f.packets[1].id);assert.deepEqual(f.methods,['initialize','initialize']);
 assert.equal(getEventListeners(a.signal,'abort').length,0);assert.equal(getEventListeners(b.signal,'abort').length,0);
});
