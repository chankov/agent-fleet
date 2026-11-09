import {createHash} from 'node:crypto';
import {withinFleetReferenceLimit} from './fleet-question-reference.ts';
export type CodexEventBinding=Readonly<{id:string;epoch:string;hostInstance:string;threadId:string;fleetOwner:string}>;
export type AddressedFleetEvent=Readonly<{id:string;kind:'message'|'question'|'permission';bindingId:string;bindingEpoch:string;fleetOwner:string;createdAt:number;deadline:number;reference:string;contentDigest?:string}>;
export type EventDelivery={status:'host_accepted';turnId:string}|{status:'queue_accepted';submissionId:string;transportOrigin:'user_input';historical?:boolean}|{status:'rejected'|'unsupported'|'unknown'};
export interface CodexEventHost {
 /** Validate explicitly approved mapping/adapter eligibility. True alone does not prove
  * the Desktop is currently loaded or guarantee wake; receipts must state their actual evidence. */
 verify(binding:CodexEventBinding,signal:AbortSignal):Promise<boolean>;
 deliverExternal(binding:CodexEventBinding,event:AddressedFleetEvent,signal:AbortSignal):Promise<EventDelivery>;
}
type Receipt={eventId:string;digest:string;binding:CodexEventBinding;status:'queued'|'delivering'|'expired'|'stale'|'unsupported'|'rejected'|'unknown'|'host_accepted'|'queue_accepted';turnId?:string;submissionId?:string;transportOrigin?:'user_input';historical?:boolean;deadline:number;emittedAt:number;startedAt?:number;finishedAt?:number};
const key=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)??'undefined').digest('hex');
/** Event-driven bounded pump; no schedule/Voice/watch and no default host implementation.
 * host_accepted is NEVER model observation, reply, approval or effect completion.
 * Lost ACK is unknown and is not automatically redelivered, including after reconnect.
 */
export class FleetCodexEventBridge {
 private bindings=new Map<string,CodexEventBinding>();
 private receipts=new Map<string,Receipt>();
 private running=new Set<string>();private controllers=new Map<string,AbortController>();
 private queues=new Map<string,AddressedFleetEvent[]>();
 constructor(host:CodexEventHost,limit=256){this.host=host;this.limit=limit;}
 private readonly host:CodexEventHost;
 private readonly limit:number;
 bind(binding:CodexEventBinding){
  if(Object.values(binding).some(v=>typeof v!=='string'||!v||v.length>512))throw Error('invalid_event_binding');
  const previous=this.bindings.get(binding.id);if(previous&&key(previous)!==key(binding))this.controllers.get(binding.id)?.abort();
  this.bindings.set(binding.id,structuredClone(binding));
 }
 unbind(id:string){this.bindings.delete(id);this.controllers.get(id)?.abort();}
 accept(event:AddressedFleetEvent){
  const digest=key(event),prior=this.receipts.get(event.id);
  if(prior)return {status:prior.digest===digest?'duplicate':'conflict',receipt:structuredClone(prior)};
  const binding=this.bindings.get(event.bindingId);
  if(!binding||binding.epoch!==event.bindingEpoch||binding.fleetOwner!==event.fleetOwner)return {status:'stale'};
  if(!event.id||event.id.length>96||!['message','question','permission'].includes(event.kind)||!Number.isSafeInteger(event.createdAt)||!Number.isSafeInteger(event.deadline)||event.deadline<=event.createdAt||!withinFleetReferenceLimit(event.kind,event.reference))return {status:'invalid'};
  if(this.receipts.size>=this.limit)return {status:'full'};
  const receipt:Receipt={eventId:event.id,digest,binding:structuredClone(binding),status:event.deadline<=Date.now()?'expired':'queued',emittedAt:event.createdAt,deadline:event.deadline};
  this.receipts.set(event.id,receipt);
  if(receipt.status==='queued'){
   const q=this.queues.get(binding.id)??[];q.push(structuredClone(event));this.queues.set(binding.id,q);
   queueMicrotask(()=>{void this.pump(binding.id);});
  }
  return {status:'recorded',receipt:structuredClone(receipt)};
 }
 receipt(id:string){const r=this.receipts.get(id);return r?structuredClone(r):{status:'unknown'};}
 private async pump(id:string){
  if(this.running.has(id))return;this.running.add(id);
  try{
   const q=this.queues.get(id);while(q?.length){
    const event=q.shift()!,r=this.receipts.get(event.id)!;
    const current=()=>key(this.bindings.get(id))===key(r.binding);
    if(!current()){r.status='stale';continue;}
    if(event.deadline<=Date.now()){r.status='expired';continue;}
    r.status='delivering';r.startedAt=Date.now();
    const controller=new AbortController();this.controllers.set(id,controller);
    let timeout:ReturnType<typeof setTimeout>|undefined;
    const expired=new Promise<never>((_,reject)=>{controller.signal.addEventListener('abort',()=>reject(Error('delivery_cancelled')),{once:true});timeout=setTimeout(()=>{controller.abort();reject(Error('delivery_deadline'));},Math.max(1,event.deadline-Date.now()));});
    const bounded=<T>(work:Promise<T>)=>Promise.race([work,expired]);
    let attempted=false;
    try{
     if(!await bounded(this.host.verify(structuredClone(r.binding),controller.signal))){r.status='unsupported';continue;}
     if(!current()){r.status='stale';continue;}
     if(event.deadline<=Date.now()){r.status='expired';continue;}
     attempted=true;
     const result=await bounded(this.host.deliverExternal(structuredClone(r.binding),event,controller.signal));
     // A rebound epoch cannot inherit an old response, even if the host accepted it.
     if(!current()||event.deadline<=Date.now())r.status='unknown';
     else if(result.status==='queue_accepted'){
      if(!result.submissionId||result.submissionId.length>256||result.transportOrigin!=='user_input')r.status='unknown';
      else {r.status='queue_accepted';r.submissionId=result.submissionId;r.transportOrigin='user_input';r.historical=result.historical===true;}
     }
     else if(result.status==='host_accepted'){
      if(!result.turnId||result.turnId.length>256)r.status='unknown';
      else {r.status='host_accepted';r.turnId=result.turnId;}
     }else r.status=result.status;
    }catch{r.status=!attempted&&!current()?'stale':controller.signal.aborted&&!attempted?'expired':'unknown';}finally{clearTimeout(timeout);if(this.controllers.get(id)===controller)this.controllers.delete(id);r.finishedAt=Date.now();}
   }
  }finally{this.running.delete(id);if(!this.queues.get(id)?.length)this.queues.delete(id);}
 }
}
