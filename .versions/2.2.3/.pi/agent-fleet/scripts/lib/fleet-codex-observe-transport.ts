// Narrow transport: exactly one addressed snapshot request; no prompt/answer/cancel API.
import { lstat } from 'node:fs/promises';
import { isAbsolute,join,resolve } from 'node:path';
import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';
import type { TargetEpoch } from './fleet-codex-allowlist.ts';
import type { ObservationReader } from './fleet-codex-observe.ts';
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const same=(a:unknown,b:TargetEpoch)=>object(a)&&['project','peer','sessionId','startedAt'].every(k=>a[k]===b[k as keyof TargetEpoch]);
class SourceError extends Error { readonly code:string;constructor(code:string){super(code);this.code=code;} }
function gap(target:TargetEpoch,at:string,reason:string) {
 const c={status:reason==='RPC_UNSUPPORTED'?'unsupported':'unavailable',partial:true,reasons:[reason]};
 return {target:{...target},observedAt:at,transcript:{...c,entries:[]},questionState:{...c,questions:[],resolved:[],nextCursor:null}};
}
async function request(endpoint:string,target:TargetEpoch):Promise<Record<string,unknown>> {
 return new Promise((resolveReply,reject)=>{
  const msgId=randomUUID();let done=false,buffer=Buffer.alloc(0);const socket=createConnection({path:endpoint});
  const finish=(code?:string,value?:Record<string,unknown>)=>{if(done)return;done=true;clearTimeout(deadline);socket.destroy();if(code)reject(new SourceError(code));else resolveReply(value!);};
  const deadline=setTimeout(()=>finish('RPC_UNAVAILABLE'),1500);deadline.unref();
  socket.setTimeout(1500,()=>finish('RPC_UNAVAILABLE'));
  socket.once('connect',()=>socket.write(JSON.stringify({type:'observation_request',version:1,msg_id:msgId,sender_session:'local-codex-read',sender_endpoint:'',operation:'snapshot',owner:target})+'\n'));
  socket.on('data',(chunk:Buffer)=>{
   if(buffer.length+chunk.length>131072){finish('RPC_INVALID');return;}buffer=Buffer.concat([buffer,chunk]);const end=buffer.indexOf(10);if(end<0)return;
   try {
    const r:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,end)));
    if(!object(r)||r.msg_id!==msgId){finish('RPC_INVALID');return;}
    if(r.type==='nack'||r.type==='observation_response'&&r.status==='unsupported'){finish('RPC_UNSUPPORTED');return;}
    if(r.type!=='observation_response'||r.version!==1||r.status!=='available'||!same(r.owner,target)){finish('RPC_INVALID');return;}
    finish(undefined,r);
   }catch{finish('RPC_INVALID');}
  });
  socket.once('error',()=>finish('RPC_UNAVAILABLE'));
  socket.once('close',()=>finish(buffer.length?'RPC_INVALID':'RPC_UNAVAILABLE'));
 });
}
export function createObservationReader(options:{registryRoot:string;now?:()=>number}):ObservationReader {
 if(!isAbsolute(options.registryRoot)||resolve(options.registryRoot)!==options.registryRoot)throw new SourceError('UNSAFE_PATH');
 const now=options.now??Date.now;
 return async target=>{
  try {
   if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(target.sessionId)||target.sessionId.includes('..'))throw new SourceError('UNSAFE_PATH');
   for(const dir of [options.registryRoot,join(options.registryRoot,'sockets')]){const s=await lstat(dir);if(!s.isDirectory()||s.isSymbolicLink())throw new SourceError('UNSAFE_PATH');}
   const endpoint=join(options.registryRoot,'sockets',target.sessionId+'.sock'),s=await lstat(endpoint);
   if(!s.isSocket()||s.isSymbolicLink()||process.getuid&&s.uid!==process.getuid())throw new SourceError('UNSAFE_PATH');
   const response=await request(endpoint,target);
   return {target:{...target},observedAt:response.observedAt,transcript:response.transcript,questionState:response.questionState,permissionState:response.permissionState};
  }catch(e){return gap(target,new Date(now()).toISOString(),e instanceof SourceError?e.code:'RPC_UNAVAILABLE');}
 };
}
