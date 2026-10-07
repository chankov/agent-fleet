import {createConnection} from 'node:net';
import {randomUUID} from 'node:crypto';
import {TextDecoder} from 'node:util';
import type {DiscoveryAssignment} from './owners.ts';
import {BROKER_LIMITS,type BrokerReply} from './broker.ts';
export function rankDiscovery(assignment:DiscoveryAssignment,input:{paths:readonly string[];discovery:{complete:boolean;reason?:string}},signal?:AbortSignal,timeoutMs:number=BROKER_LIMITS.requestMs):Promise<BrokerReply> {
 return discoveryRequest(assignment,{type:'rank_discovery',paths:input.paths,discovery:input.discovery},signal,timeoutMs);
}
export function registerDescendant(assignment:DiscoveryAssignment,input:{childId:string;task:string;query:string;tools:readonly string[]},signal?:AbortSignal):Promise<BrokerReply> {
 return discoveryRequest(assignment,{type:'register_descendant',...input},signal);
}
export function revokeDiscoveryAttempt(assignment:DiscoveryAssignment):Promise<BrokerReply> {
 return discoveryRequest(assignment,{type:'revoke_attempt'},undefined,1000);
}
async function discoveryRequest(assignment:DiscoveryAssignment,payload:Record<string,unknown>,signal?:AbortSignal,timeoutMs:number=BROKER_LIMITS.requestMs):Promise<BrokerReply> {
 if(signal?.aborted)return {ok:false,error:'cancelled'};
 if(process.platform==='win32')return {ok:false,error:'unsupported_platform'};
 if(!assignment||typeof assignment.endpoint!=='string'||!assignment.endpoint.startsWith('/')||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>BROKER_LIMITS.requestMs)return {ok:false,error:'channel_unavailable'};
 const {endpoint,...identity}=assignment;
 const requestId=randomUUID(),body=JSON.stringify({...payload,...identity,requestId})+'\n';
 const terminal=payload.type==='rank_discovery'?JSON.stringify({type:'rank_deadline',...identity,requestId})+'\n':'';
 // Reserve room for the only allowed terminal control within the existing cap.
 if(Buffer.byteLength(body)+Buffer.byteLength(terminal)>BROKER_LIMITS.frameBytes)return {ok:false,error:'request_too_large'};
 return new Promise(resolve=>{
  const socket=createConnection(endpoint);let buffer=Buffer.alloc(0),done=false,connected=false,awaitingDeadline=false;
  let cleanupTimer:ReturnType<typeof setTimeout>|undefined;
  const settle=(result:BrokerReply)=>{if(done)return;done=true;clearTimeout(timer);clearTimeout(cleanupTimer);signal?.removeEventListener('abort',abort);resolve(result);};
  const finish=(result:BrokerReply)=>{if(done)return;settle(result);socket.destroy();};
  const abort=()=>{if(!awaitingDeadline)finish({ok:false,error:'cancelled'});};
  const timer=setTimeout(()=>{
   if(!terminal){finish({ok:false,error:'deadline'});return;}
   if(!connected||socket.destroyed||!socket.writable){finish({ok:false,error:'channel_unavailable'});return;}
   // The local deadline wins over later caller abort, but delivery needs the
   // broker's reply on this request connection after it latches the typed cause.
   awaitingDeadline=true;
   cleanupTimer=setTimeout(()=>finish({ok:false,error:'channel_unavailable'}),BROKER_LIMITS.partialFrameMs);
   try{socket.end(terminal);}catch{finish({ok:false,error:'channel_unavailable'});}
  },timeoutMs);
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  socket.on('error',()=>finish({ok:false,error:'channel_unavailable'}));socket.on('close',()=>{clearTimeout(cleanupTimer);finish({ok:false,error:'channel_unavailable'});});
  socket.on('end',()=>finish({ok:false,error:'channel_unavailable'}));
  socket.once('connect',()=>{connected=true;if(!done)socket.write(body);});
  socket.on('data',chunk=>{
   if(done)return;
   if(buffer.length+chunk.length>BROKER_LIMITS.responseBytes){finish({ok:false,error:'response_too_large'});return;}
   buffer=Buffer.concat([buffer,chunk]);const newline=buffer.indexOf(10);if(newline<0)return;
   try{
    if(newline!==buffer.length-1)throw Error();
    const reply=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,newline)));
    if(!reply||typeof reply.ok!=='boolean'||reply.ok&&!Object.hasOwn(reply,'result')||!reply.ok&&(typeof reply.error!=='string'||!/^[a-z_]{1,64}$/.test(reply.error)))throw Error();
    if(awaitingDeadline&&(reply.ok||reply.error!=='deadline')){finish({ok:false,error:'channel_unavailable'});return;}
    finish(reply.ok?{ok:true,result:reply.result}:{ok:false,error:reply.error});
   }catch{finish({ok:false,error:'malformed_response'});}
  });
 });
}
