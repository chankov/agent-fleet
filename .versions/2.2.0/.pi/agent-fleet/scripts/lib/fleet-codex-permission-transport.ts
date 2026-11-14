// Bounded exact-owner cooperative permission transport; no retries or daemon discovery.
import {randomUUID} from 'node:crypto';
import {lstat} from 'node:fs/promises';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import {createConnection} from 'node:net';
import {validInstructionTarget,targetKey} from './fleet-codex-instruction-store.ts';
import type {TargetEpoch} from './fleet-codex-allowlist.ts';
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
export class PermissionTransportError extends Error {readonly code:string;constructor(code:string){super(code);this.code=code;}}
function fail(code:string):never{throw new PermissionTransportError(code);}
export class PermissionTransport {
 readonly #root:string;readonly #timeout:number;readonly #channel: 'permission' | 'connection';
 constructor(options:{registryRoot:string;timeoutMs?:number;channel?:'permission'|'connection'}){if(!isAbsolute(options.registryRoot)||resolve(options.registryRoot)!==options.registryRoot)fail('UNSAFE_PATH');this.#root=options.registryRoot;this.#channel=options.channel??'permission';this.#timeout=options.timeoutMs??1500;if(!Number.isInteger(this.#timeout)||this.#timeout<1||this.#timeout>1500)fail('INVALID_TRANSPORT_OPTIONS');}
 async #endpoint(t:TargetEpoch){if(!validInstructionTarget(t))fail('INVALID_TARGET');for(let p=this.#root;;p=dirname(p)){const s=await lstat(p);if(s.isSymbolicLink()||!s.isDirectory())fail('UNSAFE_PATH');if(p===dirname(p))break;}const dir=await lstat(join(this.#root,'sockets'));if(!dir.isDirectory()||dir.isSymbolicLink())fail('UNSAFE_PATH');const path=join(this.#root,'sockets',t.sessionId+'.sock'),s=await lstat(path);if(!s.isSocket()||s.isSymbolicLink()||process.getuid&&s.uid!==process.getuid())fail('UNSAFE_PATH');return{path,dev:s.dev,ino:s.ino};}
 /** Opens the separately bounded bootstrap stream, never extends legacy RPC
  * deadlines. No frame is sent before exact endpoint/fresh-owner checks. */
 async open(t:TargetEpoch,beforeWrite?:()=>Promise<void>,signal?:AbortSignal){
  if(this.#channel!=='connection'||signal?.aborted)fail('CANCELLED');
  const target=structuredClone(t),ep=await this.#endpoint(target);
  return new Promise<import('node:net').Socket>((resolve,reject)=>{
   let done=false;const socket=createConnection(ep.path);
   const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);socket.removeListener('error',error);socket.removeListener('close',closed);};
   const refuse=(code:string)=>{if(done)return;done=true;cleanup();socket.destroy();reject(new PermissionTransportError(code));};
   const abort=()=>refuse('CANCELLED'),error=()=>refuse('RPC_UNAVAILABLE'),closed=()=>refuse('RPC_UNAVAILABLE');
   const deadline=performance.now()+this.#timeout,timer=setTimeout(()=>refuse('RPC_TIMEOUT'),this.#timeout);
   signal?.addEventListener('abort',abort,{once:true});socket.once('error',error);socket.once('close',closed);
   socket.once('connect',()=>{void(async()=>{try{
    if(done)return;await beforeWrite?.();const at=await this.#endpoint(target);
    if(at.dev!==ep.dev||at.ino!==ep.ino)fail('TARGET_CHANGED');
    if(done||signal?.aborted){abort();return;}if(performance.now()>=deadline){refuse('RPC_TIMEOUT');return;}
    done=true;cleanup();socket.on('error',()=>{});resolve(socket);
   }catch(e){refuse(e instanceof PermissionTransportError?e.code:'RPC_UNAVAILABLE');}})();});
   if(signal?.aborted)abort();
  });
 }
 async rpc(t:TargetEpoch,fields:Record<string,unknown>,beforeWrite?:()=>Promise<void>,signal?:AbortSignal):Promise<Record<string,unknown>>{
  const ep=await this.#endpoint(t),msg_id=typeof fields.msg_id==='string'?fields.msg_id:randomUUID();
  const envelope={type:this.#channel+'_request',version:1,msg_id,owner:t,operation:fields.operation,payload:fields.payload,sender_session:'local-codex-permission',sender_endpoint:'',hops:0,timestamp:new Date().toISOString()},frame=JSON.stringify(envelope)+'\n';if(Buffer.byteLength(frame)>32768)fail('FRAME_TOO_LARGE');
  return new Promise((yes,no)=>{let done=false,b=Buffer.alloc(0);const socket=createConnection(ep.path);const finish=(error?:unknown,r?:Record<string,unknown>)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);socket.destroy();error?no(error):yes(r!);};const abort=()=>finish(new PermissionTransportError('CANCELLED'));const timer=setTimeout(()=>finish(new PermissionTransportError('RPC_TIMEOUT')),this.#timeout);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted){abort();return;}
   socket.once('connect',()=>{void(async()=>{try{const now=await this.#endpoint(t);if(now.dev!==ep.dev||now.ino!==ep.ino)fail('TARGET_CHANGED');if(done||signal?.aborted)return;await beforeWrite?.();if(!done&&!signal?.aborted)socket.write(frame);}catch(e){finish(e);}})();});
   socket.on('data',(chunk:Buffer)=>{if(b.length+chunk.length>32768){finish(new PermissionTransportError('RPC_INVALID'));return;}b=Buffer.concat([b,chunk]);const end=b.indexOf(10);if(end<0)return;try{const r:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(b.subarray(0,end)));if(!object(r)||r.type!==this.#channel+'_response'||r.version!==1||r.msg_id!==msg_id||!validInstructionTarget(r.owner)||targetKey(r.owner)!==targetKey(t))fail('RPC_INVALID');finish(undefined,r);}catch(e){finish(e);}});socket.once('error',()=>finish(new PermissionTransportError('RPC_UNAVAILABLE')));socket.once('close',()=>finish(new PermissionTransportError('RPC_UNAVAILABLE')));
  });
 }
}
