// One addressed, bounded read. No prompt, retry, archive or identity from environment.
import {lstat} from 'node:fs/promises';
import {isAbsolute,join,resolve} from 'node:path';
import {createConnection} from 'node:net';
import {randomUUID} from 'node:crypto';
import {validOwner,validWire,sameOwner} from '../../../harnesses/lib/coms-instruction-receipts.ts';
import {ResponseReadError,RESPONSE_FRAME_BYTES,responseCodes,validReference} from '../../../harnesses/lib/coms-response-read.ts';
import type {TargetEpoch} from './fleet-codex-allowlist.ts';
function fail(code:string):never{throw new ResponseReadError(code);}
export type ResponseTransport={read:(target:TargetEpoch,request:{reference:string;scope:string;cursor?:string},beforeWrite:()=>Promise<void>,signal?:AbortSignal)=>Promise<unknown>};
export function createResponseReader(options:{registryRoot:string;timeoutMs?:number}):ResponseTransport{
 const root=options.registryRoot,timeout=options.timeoutMs??1500;if(!isAbsolute(root)||resolve(root)!==root)fail('UNSAFE_PATH');if(!Number.isInteger(timeout)||timeout<1||timeout>1500)fail('INVALID_ARGUMENTS');
 async function endpoint(target:TargetEpoch){
  if(!validOwner(target)||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(target.sessionId)||target.sessionId.includes('..'))fail('UNSAFE_PATH');
  for(const dir of [root,join(root,'sockets')]){const s=await lstat(dir);if(!s.isDirectory()||s.isSymbolicLink())fail('UNSAFE_PATH');}
  const path=join(root,'sockets',target.sessionId+'.sock'),s=await lstat(path);if(!s.isSocket()||s.isSymbolicLink()||process.getuid&&s.uid!==process.getuid())fail('UNSAFE_PATH');return {path,dev:s.dev,ino:s.ino};
 }
 return {async read(target,request,beforeWrite,signal){
  if(!validReference(request.reference)||!validWire(request.scope)||request.cursor!==undefined&&(typeof request.cursor!=='string'||request.cursor.length>2048))fail('INVALID_ARGUMENTS');if(signal?.aborted)fail('REQUEST_CANCELLED');
  let ep:Awaited<ReturnType<typeof endpoint>>;try{ep=await endpoint(target);}catch(e){if(e instanceof ResponseReadError)throw e;return fail('RPC_UNAVAILABLE');}
  return new Promise((yes,no)=>{
   let done=false,buffer=Buffer.alloc(0);const socket=createConnection({path:ep.path}),msg_id=randomUUID();
   const finish=(error?:unknown,value?:unknown)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);socket.destroy();error?no(error):yes(value);};
   const abort=()=>finish(new ResponseReadError('REQUEST_CANCELLED'));
   const timer=setTimeout(()=>finish(new ResponseReadError('RPC_UNAVAILABLE')),timeout);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted){abort();return;}
   socket.once('connect',()=>{void(async()=>{try{await beforeWrite();const now=await endpoint(target);if(now.dev!==ep.dev||now.ino!==ep.ino)fail('TARGET_CHANGED');if(done||signal?.aborted)return;socket.write(JSON.stringify({type:'response_read_request',version:1,msg_id,sender_session:'local-codex-response',sender_endpoint:'',owner:target,...request})+'\n');}catch(e){finish(e instanceof ResponseReadError||e instanceof Error&&'code' in e?e:new ResponseReadError('RPC_UNAVAILABLE'));}})();});
   socket.on('data',(b:Buffer)=>{
    if(buffer.length+b.length>RESPONSE_FRAME_BYTES){finish(new ResponseReadError('RPC_INVALID'));return;}buffer=Buffer.concat([buffer,b]);const end=buffer.indexOf(10);if(end<0)return;
    try{const r=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,end)));if(!r||typeof r!=='object'||Array.isArray(r)||r.msg_id!==msg_id||end!==buffer.length-1)fail('RPC_INVALID');if(r.type==='nack')fail('RPC_UNSUPPORTED');
     if(r.type!=='response_read_response'||r.version!==1||!validOwner(r.owner)||!sameOwner(r.owner,target))fail('TARGET_CHANGED');
     if(r.status==='error'){if(Object.keys(r).sort().join(',')!==['type','version','msg_id','owner','status','code'].sort().join(',')||!responseCodes.includes(r.code))fail('RPC_INVALID');fail(r.code);}
     if(r.status!=='available'||Object.keys(r).sort().join(',')!==['type','version','msg_id','owner','status','page'].sort().join(','))fail('RPC_INVALID');finish(undefined,r.page);
    }catch(e){finish(e instanceof ResponseReadError?e:new ResponseReadError('RPC_INVALID'));}
   });
   socket.once('error',()=>finish(new ResponseReadError('RPC_UNAVAILABLE')));socket.once('close',()=>finish(new ResponseReadError(buffer.length?'RPC_INVALID':'RPC_UNAVAILABLE')));
  });
 }};
}
