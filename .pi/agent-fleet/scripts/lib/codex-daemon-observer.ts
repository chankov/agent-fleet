import {createRequire} from 'node:module';
import {createConnection,type Socket} from 'node:net';
import {lstatSync,realpathSync,readlinkSync,type BigIntStats} from 'node:fs';
import {dirname,isAbsolute,resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import type {EventEmitter} from 'node:events';
import type {DaemonObservationRpc} from './codex-measurement.ts';

export interface WsConnection extends EventEmitter {send(data:string):void;terminate():void;}
const require=createRequire(import.meta.url);
type WsConstructor=new(url:string,options:Record<string,unknown>)=>WsConnection;
// Resolved on the first connection, not at import: the Hub imports this module at
// startup, and a workspace without `ws` must still load the Hub.
let WebSocket:WsConstructor|undefined;
export const webSocket=():WsConstructor=>WebSocket??=require('ws') as WsConstructor;
export class CodexObserverError extends Error {
 readonly code:string;
 constructor(code:string){super(code);this.code=code;}
}
const fail=(code:string):never=>{throw new CodexObserverError(code);};
const validPath=(value:unknown):value is string=>typeof value==='string'&&isAbsolute(value)&&Buffer.byteLength(value)<=100&&!/[:?#%\\\u0000-\u0020\u007f]/.test(value);
const identity=(s:BigIntStats)=>[s.dev,s.ino,s.mode,s.uid,s.gid,s.nlink,s.ctimeNs].map(String);
type Observation={result:{userAgent:string};socketEpoch:string};

/** Connect-only initialize observer, NOT a queue client or Desktop attestation.
 * Explicit physical socket path only: no discovery/start/auth/config operations.
 * Kept separate from CodexUnixQueueRpc so its delivery surface stays unchanged.
 */
export class CodexDaemonObserver implements DaemonObservationRpc {
 private readonly path:string;
 private readonly timeout:number;
 constructor(options:{socketPath:string;timeoutMs?:number}){
  if(process.platform==='win32'||process.getuid===undefined)fail('UNSUPPORTED_PLATFORM');
  if(!validPath(options.socketPath))fail('INVALID_SOCKET_PATH');
  this.path=resolve(options.socketPath);this.timeout=options.timeoutMs??3000;
  if(!Number.isSafeInteger(this.timeout)||this.timeout<1||this.timeout>10000)fail('INVALID_TIMEOUT');
 }
 private endpoint(){
  try{
   const uid=BigInt(process.getuid!()),checked=new Set<string>();
   const privateParent=(path:string)=>{
    const parent=dirname(path),s=lstatSync(parent,{bigint:true});
    if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==uid||(Number(s.mode)&0o077)!==0||realpathSync(parent)!==parent)fail('UNSAFE_SOCKET');
    for(let dir=parent;!checked.has(dir);dir=dirname(dir)){
     checked.add(dir);const d=lstatSync(dir,{bigint:true});
     if(!d.isDirectory()||d.isSymbolicLink()||(d.uid!==uid&&d.uid!==0n)||((Number(d.mode)&0o022)!==0&&(Number(d.mode)&0o1000)===0))fail('UNSAFE_SOCKET');
    }
    return s;
   };
   const aliasParent=privateParent(this.path),alias=lstatSync(this.path,{bigint:true});
   if(alias.uid!==uid)fail('UNSAFE_SOCKET');
   const path=alias.isSymbolicLink()?resolve(dirname(this.path),readlinkSync(this.path)):this.path;
   if(!validPath(path))fail('UNSAFE_SOCKET');
   const targetParent=privateParent(path),socket=lstatSync(path,{bigint:true});
   if(!socket.isSocket()||socket.isSymbolicLink()||socket.uid!==uid||(Number(socket.mode)&0o022)!==0||realpathSync(path)!==path)fail('UNSAFE_SOCKET');
   // Capture the exact physical path used by createConnection. Epoch is our
   // metadata, never an initialize result field. ctime detects restored aliases.
   const digest=createHash('sha256').update(JSON.stringify([this.path,path,identity(alias),identity(socket),identity(aliasParent).slice(0,5),identity(targetParent).slice(0,5)])).digest('hex');
   return {path,epoch:'codex-initialize/v1:'+digest};
  }catch(error){if(error instanceof CodexObserverError)throw error;throw new CodexObserverError('DAEMON_UNAVAILABLE');}
 }
 socketEpoch(signal:AbortSignal):string{
  if(signal.aborted)fail('CANCELLED');
  const epoch=this.endpoint().epoch;if(signal.aborted)fail('CANCELLED');return epoch;
 }
 async initialize(signal:AbortSignal,expectedEpoch:string):Promise<Observation>{
  const expires=performance.now()+this.timeout;
  const live=()=>signal.aborted?'CANCELLED':performance.now()>=expires?'TIMEOUT':undefined;
  const early=live();if(early)fail(early);
  if(typeof expectedEpoch!=='string'||!/^codex-initialize\/v1:[a-f0-9]{64}$/.test(expectedEpoch))fail('INVALID_EPOCH');
  const endpoint=this.endpoint();if(endpoint.epoch!==expectedEpoch)fail('SOCKET_CHANGED');
  const id=randomUUID();
  return await new Promise<Observation>((resolveObservation,reject)=>{
   let ws:WsConnection|undefined,raw:Socket|undefined,timer:ReturnType<typeof setTimeout>|undefined;
   let closing=false,settled=false,messages=0,errorCode:string|undefined,result:Observation|undefined;
   const settle=()=>{
    if(settled)return;settled=true;clearTimeout(timer);signal.removeEventListener('abort',abort);
    errorCode??=live();
    if(errorCode)reject(new CodexObserverError(errorCode));else if(result)resolveObservation(result);else reject(new CodexObserverError('INVALID_RESPONSE'));
   };
   const finish=(code?:string,value?:Observation)=>{
    if(closing)return;closing=true;errorCode=code;result=value;
    // Keep cancellation/deadline active until the owned raw connection closes.
    if(raw&&!raw.closed)raw.once('close',settle);else queueMicrotask(settle);
    try{ws?.on('error',()=>{});ws?.removeAllListeners('message');ws?.terminate();}
    finally{raw?.on('error',()=>{});raw?.destroy();}
   };
   const abort=()=>{const code=performance.now()>=expires?'TIMEOUT':'CANCELLED';if(closing)errorCode??=code;else finish(code);};
   const current=()=>{
    const code=live();if(code){finish(code);return false;}
    try{if(this.endpoint().epoch!==endpoint.epoch){finish('SOCKET_CHANGED');return false;}}
    catch{finish('SOCKET_CHANGED');return false;}
    const after=live();if(after){finish(after);return false;}
    return true;
   };
   signal.addEventListener('abort',abort,{once:true});
   timer=setTimeout(()=>{if(closing)errorCode??='TIMEOUT';else finish('TIMEOUT');},Math.max(0,expires-performance.now()));
   try{
    if(!current())return;
    ws=new (webSocket())('ws+unix://'+endpoint.path+':/',{
     createConnection:()=>{
      if(closing)throw new CodexObserverError(errorCode??'CANCELLED');
      const before=live();if(before)throw new CodexObserverError(before);
      if(this.endpoint().epoch!==endpoint.epoch)throw new CodexObserverError('SOCKET_CHANGED');
      const after=live();if(after)throw new CodexObserverError(after);
      raw=createConnection(endpoint.path);raw.on('error',()=>{});return raw;
     },maxPayload:32768,perMessageDeflate:false,followRedirects:false,handshakeTimeout:this.timeout,
    });
    ws.on('open',()=>{
     if(closing||!current())return;
     try{ws!.send(JSON.stringify({id,method:'initialize',params:{clientInfo:{name:'agent_fleet_contract_observer',title:'Fleet contract observer',version:'1'},capabilities:{experimentalApi:false}}}));}
     catch{finish('INITIALIZE_FAILED');}
    });
    ws.on('message',(data:Buffer,isBinary:boolean)=>{
     if(closing||!current())return;
     if(++messages>256||!Buffer.isBuffer(data)||data.length>32768){finish('RESPONSE_LIMIT');return;}
     if(isBinary){finish('INVALID_RESPONSE');return;}
     let packet:unknown;try{packet=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));}catch{finish('INVALID_JSON');return;}
     if(!packet||typeof packet!=='object'||Array.isArray(packet)){finish('INVALID_RESPONSE');return;}
     const p=packet as Record<string,unknown>;
     // Ignore notifications and server requests, even if their id matches ours.
     // Never send initialized, approvals, thread reads, queue calls or replies.
     if(Object.hasOwn(p,'method')||p.id!==id)return;
     const body=p.result;
     if(Object.hasOwn(p,'error')||!body||typeof body!=='object'||Array.isArray(body)){finish('INITIALIZE_REJECTED');return;}
     const ua=(body as {userAgent?:unknown}).userAgent;
     if(typeof ua!=='string'||!ua||ua.length>4096||/[\u0000-\u001f\u007f]/.test(ua)){finish('INITIALIZE_REJECTED');return;}
     if(!current())return;
     finish(undefined,{result:{userAgent:ua},socketEpoch:endpoint.epoch});
    });
    ws.on('error',(error:unknown)=>{if(!closing)finish(error instanceof CodexObserverError?error.code:'CONNECTION_ERROR');});
    ws.on('close',()=>{if(!closing)finish('CONNECTION_CLOSED');});
    if(signal.aborted)abort();
   }catch(error){finish(error instanceof CodexObserverError?error.code:'CONNECTION_ERROR');}
  });
 }
}
