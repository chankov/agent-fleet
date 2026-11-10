import {createRequire} from 'node:module';
import {createConnection} from 'node:net';
import {lstatSync,realpathSync,readlinkSync} from 'node:fs';
import {dirname,isAbsolute,resolve} from 'node:path';
import type {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';

interface WsConnection extends EventEmitter {send(data:string):void;terminate():void;}
const require=createRequire(import.meta.url);
const WebSocket=require('ws') as new(url:string,options:Record<string,unknown>)=>WsConnection;
export type QueueMethod='thread/read'|'thread/loaded/list'|'thread/queue/list'|'thread/queue/add';
export class QueueRpcError extends Error {
 readonly code:string;readonly attempted:boolean;
 constructor(code:string,attempted=false){super(code);this.code=code;this.attempted=attempted;}
}
/** Connect-only WS-over-Unix client. Never CLI queue, daemon start, resume or auth-file discovery. */
export class CodexUnixQueueRpc {
 private readonly path:string;
 private readonly timeout:number;
 constructor(options:{socketPath:string;timeoutMs?:number}){
  if(!isAbsolute(options.socketPath)||options.socketPath.length>100||/[:?#%\\\u0000-\u0020]/.test(options.socketPath))throw new QueueRpcError('INVALID_SOCKET_PATH');
  this.path=resolve(options.socketPath);this.timeout=options.timeoutMs??3000;
  if(!Number.isSafeInteger(this.timeout)||this.timeout<1||this.timeout>10000)throw new QueueRpcError('INVALID_TIMEOUT');
 }
 private endpoint(){
  const uid=process.getuid?.();
  const privateParent=(path:string)=>{
   const parent=dirname(path),directory=lstatSync(parent);
   if(!directory.isDirectory()||directory.isSymbolicLink()||directory.uid!==uid||(directory.mode&0o077)!==0||realpathSync(parent)!==parent)throw new QueueRpcError('UNSAFE_SOCKET');
  };
  privateParent(this.path);
  const alias=lstatSync(this.path);
  if(alias.uid!==uid)throw new QueueRpcError('UNSAFE_SOCKET');
  // The managed daemon's official control path is a user-owned symlink in a
  // private directory. Allow one hop only, to a separately checked private socket.
  const path=alias.isSymbolicLink()?resolve(dirname(this.path),readlinkSync(this.path)):this.path;
  if(path.length>100||/[:?#%\\\u0000-\u0020]/.test(path))throw new QueueRpcError('UNSAFE_SOCKET');
  privateParent(path);
  const socket=lstatSync(path);
  if(!socket.isSocket()||socket.isSymbolicLink()||socket.uid!==uid||(socket.mode&0o022)!==0||realpathSync(path)!==path)throw new QueueRpcError('UNSAFE_SOCKET');
  return {path,epoch:`${alias.dev}:${alias.ino}:${path}:${socket.dev}:${socket.ino}`};
 }
 request(method:QueueMethod,params:unknown,options:{signal?:AbortSignal;beforeWrite?:()=>void}={}):Promise<unknown>{
  if(!['thread/read','thread/loaded/list','thread/queue/list','thread/queue/add'].includes(method))return Promise.reject(new QueueRpcError('METHOD_NOT_ALLOWED'));
  let endpoint:ReturnType<CodexUnixQueueRpc['endpoint']>;
  try{endpoint=this.endpoint();}catch{return Promise.reject(new QueueRpcError('DAEMON_UNAVAILABLE'));}
  if(options.signal?.aborted)return Promise.reject(new QueueRpcError('CANCELLED'));
  return new Promise((resolveRequest,reject)=>{
   let ws:WsConnection|undefined,timer:ReturnType<typeof setTimeout>|undefined,done=false,attempted=false,initialized=false,messages=0;
   const initializeId=randomUUID(),requestId=randomUUID();
   const finish=(error?:string,result?:unknown)=>{
    if(done)return;done=true;clearTimeout(timer);options.signal?.removeEventListener('abort',abort);
    // terminate during CONNECTING may emit an asynchronous error: keep it handled.
    ws?.on('error',()=>{});ws?.removeAllListeners('message');ws?.terminate();
    if(error)reject(new QueueRpcError(error,attempted));else resolveRequest(result);
   };
   const abort=()=>finish('CANCELLED');
   options.signal?.addEventListener('abort',abort,{once:true});
   try{
    ws=new WebSocket('ws+unix://'+endpoint.path+':/',{createConnection:()=>createConnection(endpoint.path),maxPayload:32768,perMessageDeflate:false,followRedirects:false,handshakeTimeout:this.timeout});
    timer=setTimeout(()=>finish('TIMEOUT'),this.timeout);
    ws.on('open',()=>{
     try{if(this.endpoint().epoch!==endpoint.epoch||options.signal?.aborted){finish('SOCKET_CHANGED');return;}
      ws!.send(JSON.stringify({id:initializeId,method:'initialize',params:{clientInfo:{name:'agent_fleet_queue_bridge',title:'Fleet queue bridge',version:'1'},capabilities:{experimentalApi:true}}}));
     }catch{finish('INITIALIZE_FAILED');}
    });
    ws.on('message',(data:Buffer)=>{
     if(done)return;if(++messages>256||data.length>32768){finish('RESPONSE_LIMIT');return;}
     let response:any;try{response=JSON.parse(data.toString('utf8'));}catch{finish('INVALID_JSON');return;}
     if(!initialized&&response.id===initializeId){
      if(response.error||!response.result||typeof response.result.userAgent!=='string'){finish('INITIALIZE_REJECTED');return;}
      initialized=true;
      try{
       ws!.send(JSON.stringify({method:'initialized',params:{}}));
       if(this.endpoint().epoch!==endpoint.epoch||options.signal?.aborted){finish('SOCKET_CHANGED');return;}
       const packet=JSON.stringify({id:requestId,method,params});if(Buffer.byteLength(packet)>16384){finish('REQUEST_LIMIT');return;}
       options.beforeWrite?.();
       if(options.signal?.aborted){finish('CANCELLED');return;}
       if(this.endpoint().epoch!==endpoint.epoch){finish('SOCKET_CHANGED');return;}
       attempted=true;ws!.send(packet);
      }catch{finish('PREWRITE_OR_SEND_FAILED');}
     }else if(initialized&&response.id===requestId){
      if(response.error)finish('RPC_REJECTED');else if(!Object.hasOwn(response,'result'))finish('INVALID_RESPONSE');else finish(undefined,response.result);
     }
     // Notifications/server requests are never answered with automatic approvals.
    });
    ws.on('error',()=>finish('CONNECTION_ERROR'));ws.on('close',()=>finish('CONNECTION_CLOSED'));
   }catch{finish('CONNECTION_ERROR');}
  });
 }
}
