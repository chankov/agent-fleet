import {validDamageResultEvidence,validDamageResultMetadata,damageResultGap,type DamageResultEvent,type DamageResultMetadata} from '../damage-control-continue/result-screen.ts';
import {randomBytes,createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {mkdtemp,chmod,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,isAbsolute} from 'node:path';
import {createServer,type Socket} from 'node:net';
import type {DamageOwnerIdentity,DamageOwnerSpec} from './damage-guard-owners.ts';
import type {DamageCallEvent} from '../lib/damage-guard-port.ts';

export const DAMAGE_FRAME_BYTES=65536;
export interface DamageAssignment {path:string;capability:string;}
export type DamageOutcome='no_hold'|'unavailable'|'blocked'|'granted'|'cancelled'|'revoked'|'indeterminate';
/** This richer port is NOT the F1 terminal call. Production coupling is a later slice.
 * held() must follow durable parent persistence; granted means a matching human grant,
 * not permission to execute. The caller still owes current local baseline validation.
 * Assessment owns consent, outbound screening (16 KiB), denial state and backoff.
 */
export interface DamageBrokerDependencies {
 authority:{register(spec:DamageOwnerSpec,parent?:DamageOwnerIdentity):DamageOwnerIdentity;validate(identity:DamageOwnerIdentity,tool:string,cwd:string):DamageOwnerIdentity|undefined;revoke(identity:DamageOwnerIdentity):void};
 assess(identity:DamageOwnerIdentity,event:DamageCallEvent,context:{remainingMs:number;signal:AbortSignal;held():boolean}):Promise<DamageOutcome>;
 result?(identity:DamageOwnerIdentity,event:DamageResultEvent,context:{remainingMs:number;signal:AbortSignal}):Promise<DamageResultMetadata>;
 diagnostic?(row:{event:'protocol_refused'|'assessment_failed'}):void;
 technicalMs?:number;humanMs?:number;maxConnections?:number;maxPending?:number;maxReplay?:number;maxOwners?:number;
}
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
export const exactKeys=(v:unknown,required:string[],optional:string[]=[]):v is Record<string,unknown>=>object(v)&&required.every(k=>Object.hasOwn(v,k))&&Object.keys(v).every(k=>required.includes(k)||optional.includes(k));
const text=(v:unknown):v is string=>typeof v==='string';
export function validDamageInput(tool:unknown,input:unknown):boolean{
 if(!object(input))return false;
 if(tool==='bash')return exactKeys(input,['command'],['timeout'])&&text(input.command)&&!!input.command.trim()&&(input.timeout===undefined||typeof input.timeout==='number'&&Number.isFinite(input.timeout)&&input.timeout>0);
 if(tool==='write')return exactKeys(input,['path','content'])&&text(input.path)&&!!input.path&&text(input.content);
 if(tool!=='edit'||!text(input.path)||!input.path)return false;
 const edit=(v:unknown)=>exactKeys(v,['oldText','newText'])&&text(v.oldText)&&!!v.oldText&&text(v.newText);
 return input.edits===undefined?exactKeys(input,['path','oldText','newText'])&&edit({oldText:input.oldText,newText:input.newText}):exactKeys(input,['path','edits'])&&Array.isArray(input.edits)&&input.edits.length>0&&input.edits.length<=32&&input.edits.every(edit);
}
export function validDamageAssignment(v:unknown):v is DamageAssignment{return exactKeys(v,['path','capability'])&&text(v.path)&&isAbsolute(v.path)&&!v.path.includes('\0')&&Buffer.byteLength(v.path)<100&&text(v.capability)&&/^[a-f0-9]{64}$/.test(v.capability);}
const capabilityId=(secret:string)=>createHash('sha256').update(secret).digest('hex');
/** Never transmit the secret on assessment requests. Both directions prove possession. */
export function authenticateDamageFrame(row:Record<string,unknown>,secret:string):Record<string,unknown>{return {...row,auth:createHmac('sha256',secret).update(JSON.stringify(row)).digest('hex')};}
export function verifyDamageFrame(row:Record<string,unknown>,secret:string):boolean{
 const {auth,...body}=row;if(typeof auth!=='string'||!/^[a-f0-9]{64}$/.test(auth))return false;
 return timingSafeEqual(Buffer.from(auth,'hex'),Buffer.from(authenticateDamageFrame(body,secret).auth as string,'hex'));
}
/** Epoch-based monotonic timestamp: process-relative performance.now() is not shared. */
export function damageAssessmentFrame(assignment:DamageAssignment,id:string,tool:string,input:unknown,deadline=performance.timeOrigin+performance.now()+2000){return authenticateDamageFrame({v:1,id,capability:capabilityId(assignment.capability),op:'assess_damage',tool,input,deadline},assignment.capability);}
export function damageControlFrame(assignment:DamageAssignment,id:string,op:string,extra:Record<string,unknown>={}){return authenticateDamageFrame({v:1,id,capability:capabilityId(assignment.capability),op,...extra},assignment.capability);}
export const damageRequestId=(v:unknown):v is string=>text(v)&&/^[a-zA-Z0-9_-]{1,128}$/.test(v);
export function decodeDamageFrame(bytes:Buffer):unknown{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
export async function createDamageBroker(deps:DamageBrokerDependencies){
 for(const [value,cap] of [[deps.technicalMs,2000],[deps.humanMs,600000],[deps.maxConnections,32],[deps.maxPending,16],[deps.maxReplay,256],[deps.maxOwners,128]])if(value!==undefined&&(!Number.isSafeInteger(value)||value<=0||value>cap!))throw Error('damage_broker_invalid_limits');
 const technical=deps.technicalMs??2000,human=deps.humanMs??600000;
 const maxConnections=deps.maxConnections??32,maxPending=deps.maxPending??16,maxReplay=deps.maxReplay??256,maxOwners=deps.maxOwners??128;
 const records=new Map<string,{identity:DamageOwnerIdentity;secret:string;seen:Set<string>}>(),sockets=new Set<Socket>();
 let closed=false,pending=0,closePromise:Promise<void>|undefined;
 const directory=await mkdtemp(join(tmpdir(),'af-d6-'));await chmod(directory,0o700);const path=join(directory,'broker.sock');
 if(process.platform==='win32'||Buffer.byteLength(path)>=100){await rm(directory,{recursive:true,force:true});throw Error('damage_local_ipc_unsupported');}
 function diagnostic(event:'protocol_refused'|'assessment_failed'){try{deps.diagnostic?.({event});}catch{/* Metadata sink cannot change admission. */}}
 function issue(spec:DamageOwnerSpec,parent?:DamageOwnerIdentity):DamageAssignment{
  if(closed||records.size>=maxOwners)throw Error('damage_broker_unavailable');
  const identity=deps.authority.register(spec,parent),capability=randomBytes(32).toString('hex');records.set(capabilityId(capability),{identity,secret:capability,seen:new Set()});return Object.freeze({path,capability});
 }
 const server=createServer(socket=>{
  if(closed||sockets.size>=maxConnections){socket.destroy();return;}
  sockets.add(socket);const started=performance.now(),controller=new AbortController();let buffer=Buffer.alloc(DAMAGE_FRAME_BYTES),used=0,humanExpires=0,received=false,settled=false,held=false,resultRequest=false,id='',secret='',identity:DamageOwnerIdentity|undefined,abortOwner:(()=>void)|undefined;
  let deadline=started+technical;
  let timer=setTimeout(()=>finish(held?'blocked':'indeterminate'),technical);
  const send=(row:Record<string,unknown>)=>{if(!socket.destroyed&&secret)socket.write(JSON.stringify(authenticateDamageFrame(row,secret))+'\n');};
  function finish(outcome:DamageOutcome){if(settled)return;settled=true;clearTimeout(timer);controller.abort();if(id)send(resultRequest?{v:1,id,result:damageResultGap(outcome==='cancelled'||outcome==='revoked'?'cancelled':'transport_unavailable')}:{v:1,id,outcome});socket.end(()=>socket.destroy());}
  function refuse(){diagnostic('protocol_refused');finish(held?'blocked':'indeterminate');socket.destroy();}
  socket.on('error',()=>{});
  socket.once('close',()=>{clearTimeout(timer);controller.abort();if(identity&&abortOwner)identity.signal.removeEventListener('abort',abortOwner);sockets.delete(socket);});
  socket.on('data',(chunk:Buffer|string)=>{
   const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
   if(received||settled){refuse();return;}
   if(used+bytes.length>DAMAGE_FRAME_BYTES){refuse();return;}bytes.copy(buffer,used);used+=bytes.length;const newline=buffer.subarray(0,used).indexOf(10);if(newline<0)return;
   // One request per connection. Reject coalesced extra bytes before dispatch.
   if(newline!==used-1){refuse();return;}received=true;
   let row:unknown;try{row=decodeDamageFrame(buffer.subarray(0,newline));}catch{refuse();return;}
   if(!object(row)||row.v!==1||!damageRequestId(row.id)||!text(row.capability)){refuse();return;}
   id=row.id;const record=records.get(row.capability);
   const schema=row.op==='screen_result'?exactKeys(row,['v','id','capability','op','evidence','deadline','auth'])&&typeof row.deadline==='number'&&Number.isFinite(row.deadline)&&row.deadline>0&&validDamageResultEvidence(row.evidence):row.op==='assess_damage'?exactKeys(row,['v','id','capability','op','tool','input','deadline','auth'])&&typeof row.deadline==='number'&&Number.isFinite(row.deadline)&&row.deadline>0&&validDamageInput(row.tool,row.input):row.op==='register_descendant'?exactKeys(row,['v','id','capability','op','tools','auth'])&&Array.isArray(row.tools)&&row.tools.length>0&&row.tools.length<=5&&new Set(row.tools).size===row.tools.length&&row.tools.every(t=>['bash','write','edit','read','filesystem'].includes(t)):row.op==='revoke_self'&&exactKeys(row,['v','id','capability','op','auth']);
   if(!schema||!record||!verifyDamageFrame(row,record.secret)||record.seen.has(id)||record.seen.size>=maxReplay||['assess_damage','screen_result'].includes(row.op as string)&&pending>=maxPending){refuse();return;}
   identity=record.identity;secret=record.secret;resultRequest=row.op==='screen_result';
   try{if(!deps.authority.validate(identity,resultRequest?(row.evidence as any).toolName:row.op==='assess_damage'?row.tool as string:identity.tools[0],identity.cwd)){finish('revoked');return;}}catch{finish('revoked');return;}
   record.seen.add(id); // Never evict while capability remains valid.
   abortOwner=()=>finish('revoked');identity.signal.addEventListener('abort',abortOwner,{once:true});
   if(row.op==='revoke_self'){deps.authority.revoke(identity);finish('revoked');return;}
   if(row.op==='register_descendant'){
    try{const assignment=issue({owner:'descendant',tools:row.tools as string[],cwd:identity.cwd},identity);settled=true;clearTimeout(timer);send({v:1,id,outcome:'registered',assignment});socket.end(()=>socket.destroy());}catch{refuse();}return;
   }
   // The authenticated caller deadline can shorten, never extend, parent authority.
   deadline=Math.min(deadline,(row.deadline as number)-performance.timeOrigin);
   const remainingMs=deadline-performance.now();if(remainingMs<=0){finish('indeterminate');return;}
   clearTimeout(timer);timer=setTimeout(()=>finish(held?'blocked':'indeterminate'),remainingMs);
   if(resultRequest){
    const owner=identity,event={...structuredClone(row.evidence as Omit<DamageResultEvent,'toolCallId'>),toolCallId:id};pending++;
    Promise.resolve().then(()=>controller.signal.aborted?damageResultGap('cancelled'):deps.result?.(owner,event,{remainingMs:Math.max(0,deadline-performance.now()),signal:controller.signal})??damageResultGap('service_unavailable')).then(metadata=>{
     if(settled||controller.signal.aborted)return;
     if(performance.now()>=deadline||!deps.authority.validate(owner,event.toolName,owner.cwd)){finish('revoked');return;}
     if(!validDamageResultMetadata(metadata)){finish('indeterminate');return;}
     settled=true;clearTimeout(timer);send({v:1,id,result:metadata});controller.abort();socket.end(()=>socket.destroy());
    },()=>{diagnostic('assessment_failed');finish('indeterminate');}).catch(()=>finish('indeterminate')).finally(()=>{pending--;});return;
   }
   const owner=identity,event={toolName:row.tool as string,toolCallId:id,input:structuredClone(row.input)};pending++;
   Promise.resolve().then(()=>{
    if(controller.signal.aborted)return 'cancelled' as const;
    const remainingMs=deadline-performance.now();if(remainingMs<=0){finish('indeterminate');return 'indeterminate' as const;}
    return deps.assess(owner,event,{remainingMs,signal:controller.signal,held:()=>{
     if(settled||controller.signal.aborted||held||performance.now()>=deadline)return false;
     held=true;humanExpires=performance.now()+human;clearTimeout(timer);send({v:1,id,outcome:'held'});timer=setTimeout(()=>finish('blocked'),human);return true;
    }});
   }).then(outcome=>{
    if(settled||controller.signal.aborted)return;
    let current=false;try{current=!!deps.authority.validate(owner,event.toolName,owner.cwd);}catch{/* fail closed */}
    if(!current){finish('revoked');return;}
    if(held&&performance.now()>=humanExpires){finish('blocked');return;}
    if(!held&&performance.now()>=deadline){finish('indeterminate');return;}
    if(!['no_hold','unavailable','blocked','granted','cancelled','revoked','indeterminate'].includes(outcome)||outcome==='granted'&&!held){finish('indeterminate');return;}
    finish(held&&['no_hold','unavailable','indeterminate'].includes(outcome)?'blocked':outcome);
   },()=>{diagnostic('assessment_failed');finish(held?'blocked':'indeterminate');}).finally(()=>{pending--;});
  });
 });
 try{await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(path,()=>{server.removeListener('error',reject);resolve();});});await chmod(path,0o600);}catch(error){server.close();await rm(directory,{recursive:true,force:true});throw error;}
 return {register:issue,close(){return closePromise??= (async()=>{closed=true;for(const {identity} of records.values())deps.authority.revoke(identity);for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));records.clear();await rm(directory,{recursive:true,force:true});})();}};
}
