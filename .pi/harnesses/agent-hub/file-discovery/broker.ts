import {mkdtempSync,chmodSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {createServer,type Socket} from 'node:net';
import {TextDecoder} from 'node:util';
import {DISCOVERY_DEADLINE,isDiscoveryDeadline,type DiscoveryRuntime} from './runtime.ts';
import type {DiscoveryResult} from './results.ts';
import type {DiscoveryOwners,OwnerLease} from './owners.ts';
export const BROKER_LIMITS=Object.freeze({frameBytes:65536,responseBytes:65536,connections:16,partialFrameMs:1000,requestMs:20000,maxCandidates:1024});
export interface RankDiscoveryRequest {type:'rank_discovery';capability:string;sessionId:string;taskId:string;ownerId:string;attemptId:string;queryHash:string;requestId:string;paths:string[];discovery:{complete:boolean;reason?:string}}
export interface RankDeadlineRequest extends Omit<RankDiscoveryRequest,'type'|'paths'|'discovery'> {type:'rank_deadline'}
const requestIdentity=['capability','sessionId','taskId','ownerId','attemptId','queryHash','requestId'] as const;
function validRankDeadline(value:any,request:RankDiscoveryRequest):value is RankDeadlineRequest {
 return !!value&&typeof value==='object'&&!Array.isArray(value)&&value.type==='rank_deadline'&&Object.keys(value).length===requestIdentity.length+1&&Object.keys(value).every(k=>k==='type'||requestIdentity.some(field=>field===k))&&requestIdentity.every(k=>value[k]===request[k]);
}
export type BrokerReply={ok:true;result:unknown}|{ok:false;error:string};
export interface DescendantRequest extends Omit<RankDiscoveryRequest,'type'|'paths'|'discovery'> {type:'register_descendant';childId:string;task:string;query:string;tools:string[]}
export interface RevokeDiscoveryRequest extends Omit<RankDiscoveryRequest,'type'|'paths'|'discovery'> {type:'revoke_attempt'}
function validControlRequest(value:any):value is DescendantRequest|RevokeDiscoveryRequest {
 if(!value||typeof value!=='object'||Array.isArray(value)||!['register_descendant','revoke_attempt'].includes(value.type))return false;
 const {type,childId,task,query,tools,...identity}=value;
 if(!validBrokerRequest({...identity,type:'rank_discovery',paths:[],discovery:{complete:true}}))return false;
 if(type==='revoke_attempt')return Object.keys(value).every(k=>['type','capability','sessionId','taskId','ownerId','attemptId','queryHash','requestId'].includes(k));
 return Object.keys(value).every(k=>['type','capability','sessionId','taskId','ownerId','attemptId','queryHash','requestId','childId','task','query','tools'].includes(k))&&typeof childId==='string'&&childId.length<=128&&typeof task==='string'&&task.length<=16384&&typeof query==='string'&&query.length<=32768&&Array.isArray(tools)&&tools.length<=32&&tools.every(t=>typeof t==='string'&&/^[a-z_]{1,64}$/.test(t))&&new Set(tools).size===tools.length;
}
export function validBrokerRequest(value:any):value is RankDiscoveryRequest {
 const record=(v:any)=>v&&typeof v==='object'&&!Array.isArray(v);
 return record(value)&&Object.keys(value).every(k=>['type','capability','sessionId','taskId','ownerId','attemptId','queryHash','requestId','paths','discovery'].includes(k))&&value.type==='rank_discovery'&&typeof value.capability==='string'&&/^[0-9a-f]{64}$/.test(value.capability)&&typeof value.queryHash==='string'&&/^[0-9a-f]{64}$/.test(value.queryHash)&&['sessionId','taskId','ownerId','attemptId','requestId'].every(k=>typeof value[k]==='string'&&/^[A-Za-z0-9._:-]{1,128}$/.test(value[k]))&&Array.isArray(value.paths)&&value.paths.length<=BROKER_LIMITS.maxCandidates&&value.paths.every((p:any)=>typeof p==='string'&&p.length<=1024&&p.length>0&&!/[\\\x00-\x1f\x7f]/.test(p)&&!p.startsWith('/')&&p.split('/').every((s:string)=>s&&s!=='.'&&s!=='..'))&&record(value.discovery)&&Object.keys(value.discovery).every(k=>['complete','reason'].includes(k))&&typeof value.discovery.complete==='boolean'&&(value.discovery.reason===undefined||['candidate_limit','deadline','truncated','unavailable'].includes(value.discovery.reason));
}
export async function createDiscoveryBroker(options:{root:string;runtime:DiscoveryRuntime;owners:DiscoveryOwners;publish?(result:DiscoveryResult,lease:OwnerLease):unknown;limits?:Partial<Record<keyof typeof BROKER_LIMITS,number>>}) {
 if(process.platform==='win32')throw Error('unsupported_platform');
 const limits={...BROKER_LIMITS,...options.limits};
 for(const key of Object.keys(BROKER_LIMITS) as (keyof typeof BROKER_LIMITS)[])if(!Number.isSafeInteger(limits[key])||limits[key]<1||limits[key]>BROKER_LIMITS[key])throw Error('invalid_broker_limits');
 // Short private namespace, unrelated to the session's writable artifact roots.
 const directory=mkdtempSync(join(realpathSync(tmpdir()),'d9-'));chmodSync(directory,0o700);const endpoint=join(directory,'s');
 const root=realpathSync(options.root),sockets=new Set<Socket>();let closed=false;
 const server=createServer({allowHalfOpen:true},socket=>{
  if(closed||sockets.size>=limits.connections){socket.destroy();return;}
  sockets.add(socket);const controller=new AbortController();let buffer=Buffer.alloc(0),bytes=0,handled=false,responded=false,terminalReceived=false,rankRequest:RankDiscoveryRequest|undefined;
  const abort=(reason?:unknown)=>controller.abort(reason);let revoke:(()=>void)|undefined,lease:OwnerLease|undefined;
  let timer=setTimeout(()=>{abort();socket.destroy();},limits.partialFrameMs);let requestTimer:ReturnType<typeof setTimeout>|undefined;
  socket.on('error',()=>{});
  socket.once('close',()=>{abort();clearTimeout(timer);clearTimeout(requestTimer);if(revoke)lease?.signal.removeEventListener('abort',revoke);sockets.delete(socket);});
  // A valid request-bound terminal frame latches its cause before FIN/close.
  // Bare FIN remains cancellation; it is never evidence of a deadline.
  socket.once('end',()=>{if(!isDiscoveryDeadline(controller.signal.reason)){abort();socket.destroy();}});
  const reply=(value:BrokerReply)=>{
   if(responded||socket.destroyed)return;responded=true;
   let body=JSON.stringify(value)+'\n';if(Buffer.byteLength(body)>limits.responseBytes)body=JSON.stringify({ok:false,error:'response_too_large'})+'\n';
   socket.end(body,()=>socket.destroy());clearTimeout(requestTimer);
  };
  const rejectFrame=()=>{abort();socket.destroy();};
  const decode=(frame:Buffer):unknown=>JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(frame));
  const terminal=(value:unknown)=>{
   if(!rankRequest||terminalReceived||responded||!validRankDeadline(value,rankRequest)){rejectFrame();return;}
   terminalReceived=true;clearTimeout(timer);
   if(!controller.signal.aborted){abort(DISCOVERY_DEADLINE);reply({ok:false,error:'deadline'});}
  };
  const handle=(request:RankDiscoveryRequest|DescendantRequest|RevokeDiscoveryRequest)=>{
   // Authenticated self-revocation only may clean up an expired advisory lease.
   // It cannot register descendants or collect any sources.
   lease=options.owners.authorize(request,request.type==='rank_discovery',request.type==='revoke_attempt')??undefined;
   if(!lease){reply({ok:false,error:'unauthorized'});return;}
   const owner=lease;
   if(request.type==='revoke_attempt'){options.owners.revoke(owner.capability);reply({ok:true,result:{revoked:true}});return;}
   if(request.type==='register_descendant'){
    let child:OwnerLease|undefined;
    try{
     child=options.owners.registerDescendant(owner,request);
     const response:BrokerReply={ok:true,result:{assignment:options.owners.assignment(child,endpoint),cwd:child.cwd,readRoots:child.readRoots,exportRoots:child.exportRoots,initialPaths:child.initialPaths,discoveryComplete:child.discoveryComplete??true}};
     if(Buffer.byteLength(JSON.stringify(response)+'\n')>limits.responseBytes){options.owners.revoke(child.capability);reply({ok:false,error:'response_too_large'});}
     else reply(response);
    }catch{if(child)options.owners.revoke(child.capability);reply({ok:false,error:'descendant_registration_denied'});}return;
   }
   // Registry supplies query/cwd/effective permissions. Reject unknown/cross-scope identities BEFORE any source collection, including cache hits.
   const paths=[...new Set(request.paths)];
   if(paths.some(p=>!options.owners.allows(owner,p,false))){reply({ok:false,error:'source_denied'});return;}
   const canonical=paths.map(p=>relative(root,resolve(owner.cwd,p)).split('\\').join('/'));
   if(canonical.some(p=>isAbsolute(p)||p==='..'||p.startsWith('../')||!p)){reply({ok:false,error:'source_denied'});return;}
   const fromWorkspace=(p:string)=>relative(owner.cwd,p).split('\\').join('/');
   const permission=()=>JSON.stringify([owner.effectiveTools,owner.readRoots,owner.exportRoots,owner.permissionIdentity(),paths.map(p=>options.owners.allows(owner,p,true))]);
   revoke=()=>{if(!controller.signal.aborted){abort();reply({ok:false,error:'revoked'});}};owner.signal.addEventListener('abort',revoke,{once:true});if(owner.signal.aborted)revoke();
   if(controller.signal.aborted)return;
   rankRequest=request;
   requestTimer=setTimeout(()=>{if(!controller.signal.aborted){abort(DISCOVERY_DEADLINE);reply({ok:false,error:'deadline'});}},limits.requestMs);
   // A child's immutable bound query survives same-task Hub followups. Authority
   // and permission checks still fence every job before reads and after awaits.
   void options.runtime.rank({owner:owner.ownerId,attempt:owner.attemptId,trigger:'native',task:owner.task,query:owner.query,context:()=>options.owners.current(owner)?owner.taskId+':'+owner.queryHash:'revoked',paths:canonical,discoveryComplete:request.discovery.complete,signal:controller.signal,permissionIdentity:permission,canDisplay:p=>options.owners.allows(owner,fromWorkspace(p),false),canRead:p=>options.owners.allows(owner,fromWorkspace(p),true)}).then(result=>{
    if(controller.signal.aborted){reply({ok:false,error:isDiscoveryDeadline(controller.signal.reason)?'deadline':'revoked'});return;}
    if(!options.owners.current(owner)){reply({ok:false,error:'revoked'});return;}
    reply({ok:true,result:options.publish?.(result,owner)??result});
   }).catch(()=>reply({ok:false,error:'unavailable'}));
  };
  socket.on('data',chunk=>{
   bytes+=chunk.length;if(bytes>limits.frameBytes){rejectFrame();return;}
   // The combined rank + optional terminal input retains the original byte cap.
   if(handled&&!buffer.length){clearTimeout(timer);timer=setTimeout(rejectFrame,limits.partialFrameMs);}
   buffer=Buffer.concat([buffer,chunk]);const newline=buffer.indexOf(10);if(newline<0)return;
   let value:unknown;try{value=decode(buffer.subarray(0,newline));}catch{if(handled)rejectFrame();else reply({ok:false,error:'malformed_request'});return;}
   buffer=buffer.subarray(newline+1);
   if(handled){if(buffer.length)rejectFrame();else terminal(value);return;}
   if(!validBrokerRequest(value)&&!validControlRequest(value)){reply({ok:false,error:'unsupported_request'});return;}
   // Validate a coalesced second frame BEFORE dispatching any rank. A second
   // rank, foreign control or duplicate terminal cannot cause source collection.
   const next=buffer.indexOf(10);let control:unknown;
   if(buffer.length&&value.type!=='rank_discovery'){rejectFrame();return;}
   if(next>=0){
    try{control=decode(buffer.subarray(0,next));}catch{rejectFrame();return;}
    if(next!==buffer.length-1||value.type!=='rank_discovery'||!validRankDeadline(control,value)){rejectFrame();return;}
    buffer=Buffer.alloc(0);
   }
   handled=true;clearTimeout(timer);handle(value);
   if(next>=0)terminal(control);
   else if(buffer.length)timer=setTimeout(rejectFrame,limits.partialFrameMs);
  });
 });
 try{await new Promise<void>((resolveListen,reject)=>{server.once('error',reject);server.listen(endpoint,()=>{server.off('error',reject);chmodSync(endpoint,0o600);resolveListen();});});}
 catch(error){server.close();rmSync(directory,{recursive:true,force:true});throw error;}
 return {endpoint,directory,get connections(){return sockets.size;},async close(){
  if(closed)return;closed=true;options.owners.dispose();
  const connections=[...sockets].map(socket=>new Promise<void>(resolveClose=>{socket.once('close',()=>resolveClose());socket.destroy();}));
  await Promise.all([new Promise<void>(resolveClose=>server.close(()=>resolveClose())),...connections]);rmSync(directory,{recursive:true,force:true});
 }};
}
export type DiscoveryBroker=Awaited<ReturnType<typeof createDiscoveryBroker>>;
