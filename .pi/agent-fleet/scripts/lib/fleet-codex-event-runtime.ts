import {createHash,randomUUID} from 'node:crypto';
import {lstatSync,openSync,fstatSync,readFileSync,closeSync,constants,realpathSync,writeFileSync,fsyncSync,renameSync,unlinkSync} from 'node:fs';
import {isAbsolute,resolve,dirname} from 'node:path';
import {InstructionLedger,targetKey,validInstructionTarget} from './fleet-codex-instruction-store.ts';
import {notificationPreview,parseNotificationConfiguration,type NotificationConfig} from '../../../harnesses/lib/fleet-notification-validation.ts';
export {notificationPreview,parseNotificationConfiguration,type NotificationConfig} from '../../../harnesses/lib/fleet-notification-validation.ts';
import {FleetCodexEventBridge,type AddressedFleetEvent,type CodexEventHost,type CodexEventBinding} from '../../../harnesses/lib/fleet-codex-event-bridge.ts';
import {subscribeFleetSourceEvents,type FleetSourceEvent} from '../../../harnesses/lib/fleet-event-source.ts';
import {encodeQuestionReference,validOpaqueToolCallId} from '../../../harnesses/lib/fleet-question-reference.ts';
import {CodexDesktopQueueHost} from './codex-desktop-queue-host.ts';
import {CodexUnixQueueRpc} from './codex-unix-queue-rpc.ts';
const sha=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const sameOwner=(a:unknown,b:unknown)=>validInstructionTarget(a)&&validInstructionTarget(b)&&targetKey(a)===targetKey(b);
type Stage='ingested'|'attempted'|'terminal'|'unknown';
type Stored={schema:'fleet-event-outbox/v1';event:AddressedFleetEvent;binding:CodexEventBinding;authorityRevision:number;stage:Stage;result?:unknown};
export function readNotificationConfiguration(path:string):NotificationConfig{
 if(!isAbsolute(path)||resolve(path)!==path||realpathSync(dirname(path))!==dirname(path))throw Error('notification_config_path');
 const s=lstatSync(path);if(!s.isFile()||s.isSymbolicLink()||s.uid!==process.getuid?.()||(s.mode&0o077)!==0||s.nlink!==1||s.size>65536)throw Error('notification_config_unsafe');
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const opened=fstatSync(fd);if(opened.ino!==s.ino||opened.dev!==s.dev)throw Error('notification_config_changed');const raw=readFileSync(fd,'utf8'),after=fstatSync(fd);if(after.mtimeMs!==opened.mtimeMs||after.size!==opened.size)throw Error('notification_config_changed');return parseNotificationConfiguration(raw);}finally{closeSync(fd);}
}
export function notificationConfigurationUnchanged(path:string,expected:NotificationConfig){try{return sha(readNotificationConfiguration(path))===sha(expected);}catch{return false;}}
/** Atomic renewal only: same file, namespace, owner, epoch and authority revision. */
export function renewNotificationConfiguration(path:string,expected:NotificationConfig,until:number){
 if(!Number.isSafeInteger(until)||until<=Date.now()||until>Date.now()+30*24*3600000||!notificationConfigurationUnchanged(path,expected))throw Error('notification_renewal_invalid');
 const next=structuredClone(expected);next.approval.confirmedUntil=until;if(!notificationPreview(next,next.approval.target).ready)throw Error('notification_configuration_not_ready');
 const temp=path+'.renew-'+randomUUID();let renamed=false;
 try{const fd=openSync(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{writeFileSync(fd,JSON.stringify(next,null,2)+'\n');fsyncSync(fd);}finally{closeSync(fd);}if(!notificationConfigurationUnchanged(path,expected))throw Error('notification_config_changed');renameSync(temp,path);renamed=true;
 const dir=openSync(dirname(path),constants.O_RDONLY|constants.O_DIRECTORY);try{fsyncSync(dir);}finally{closeSync(dir);}
 }catch(e){if(!renamed)try{unlinkSync(temp);}catch{}throw e;}
 return next;
}
type Host=CodexEventHost&{reconcile(binding:CodexEventBinding,event:AddressedFleetEvent,signal:AbortSignal):Promise<unknown>};
/** Explicit foreground/in-process opt-in runtime. Constructor performs no host I/O.
 * Core receipts are NOT the durable store. Source ingestion is committed before ACK;
 * attempted is persisted before calling the host, conservatively before actual bytes.
 * Restart attempts are read-only reconcile(), NEVER retransmission, even if no remote
 * reservation is found. The stable state root is part of the no-replay contract. */
export class FleetCodexNotificationRuntime {
 private readonly ledger:InstructionLedger;private readonly context;private readonly binding:CodexEventBinding;
 private readonly bridge:FleetCodexEventBridge;private readonly host:Host;private off?:()=>void;private stopped=true;private activated=false;private ready=false;
 constructor(privateConfig:NotificationConfig,owner:()=>unknown,host?:Host,checkpoint?:(stage:string)=>void){
  this.config=structuredClone(privateConfig);this.owner=owner;
  const c=this.config,a=c.approval;
  if(!notificationPreview(c,owner()).ready)throw Error('notification_configuration_not_ready');
  this.binding=structuredClone(a.binding);this.context={hostProfile:'fleet-event-ingress',principal:'fleet_machine',threadId:a.binding.threadId};
  this.ledger=new InstructionLedger(c.stateRoot+'.event-ingress',{checkpoint});
  const currentApproval=()=>!this.stopped&&sameOwner(owner(),a.target)?structuredClone(a):null;
  this.host=host??new CodexDesktopQueueHost({rpc:new CodexUnixQueueRpc({socketPath:c.socketPath}),stateRoot:c.stateRoot,currentApproval});
  this.bridge=new FleetCodexEventBridge({verify:async(b,s)=>this.current(b)&&await this.host.verify(b,s),deliverExternal:async(b,event,signal)=>{
   if(!this.current(b))return {status:'unsupported'};
   this.ledger.markAttempt(this.context,event.id);this.save(event,'attempted');
   try{const result=await this.host.deliverExternal(b,event,signal);this.save(event,result.status==='unknown'?'unknown':'terminal',result);return result;}
   catch{this.save(event,'unknown');return {status:'unknown'};}
  }});
 }
 /** Caller persists the reviewed exact renewal before memory changes. No restart or replay. */
 renewUntil(until:number,persist:()=>void){if(!Number.isSafeInteger(until)||until<=Date.now()||!this.current(this.binding)||!this.ready)throw Error('notification_renewal_invalid');persist();this.config.approval.confirmedUntil=until;return this.status();}
 private lastEvidence(){try{const last=this.entries().at(-1),result=last?.stored?.result as {status?:unknown}|undefined;return last?{eventId:last.receipt.requestId,stage:last.stored?.stage??'unknown',queueStatus:typeof result?.status==='string'&&/^[a-z_]{1,64}$/.test(result.status)?result.status:'not_established'}:null;}catch{return {stage:'evidence_unavailable',queueStatus:'unknown'};}}
 status(){const now=Date.now(),expired=now>=this.config.approval.confirmedUntil,ownerValid=sameOwner(this.owner(),this.config.approval.target);return {threadId:this.binding.threadId,target:this.config.approval.target,bindingId:this.binding.id,enabled:!this.stopped&&this.ready&&!expired&&ownerValid,expiresAt:this.config.approval.confirmedUntil,remainingMs:Math.max(0,this.config.approval.confirmedUntil-now),reason:!ownerValid?'mapping_or_configuration_changed':expired?'notification_expired':this.stopped?'disabled':!this.ready?'recovering':'consumer_active',transportState:'not_probed_by_status',lastNotification:this.lastEvidence(),events:['message','question','permission'],delivery:'queue_ack_is_not_model_delivery'};}
 private readonly config:NotificationConfig;private readonly owner:()=>unknown;
 private current(binding:CodexEventBinding){return !this.stopped&&same(binding,this.binding)&&sameOwner(this.owner(),this.config.approval.target)&&Date.now()<this.config.approval.confirmedUntil;}
 private save(event:AddressedFleetEvent,stage:Stage,result?:unknown){
  const stored:Stored={schema:'fleet-event-outbox/v1',event,binding:this.binding,authorityRevision:this.config.approval.authorityRevision,stage,...(result!==undefined?{result}:{})};
  this.ledger.record(this.context,event.id,{state:'unknown',detail:'event_'+stage,result:JSON.stringify(stored),truncated:false});
 }
 private decode(receipt:any):Stored|null{
  if(receipt.operation!=='instruction')throw Error('notification_state_invalid');if(!receipt.result)return null;
  let stored:Stored;try{stored=JSON.parse(receipt.result);}catch{throw Error('notification_state_invalid');}
  if(!stored||stored.schema!=='fleet-event-outbox/v1'||!['ingested','attempted','terminal','unknown'].includes(stored.stage)||!same(stored.binding,this.binding)||stored.authorityRevision!==this.config.approval.authorityRevision||sha(stored.event)!==receipt.digest||stored.event.id!==receipt.requestId)throw Error('notification_state_invalid');return stored;
 }
 private entries(){return this.ledger.listActions(this.context).map(receipt=>({receipt,stored:this.decode(receipt)}));}
 start(){
  if(this.activated)throw Error('notification_runtime_requires_new_instance');
  if(!sameOwner(this.owner(),this.config.approval.target)||Date.now()>=this.config.approval.confirmedUntil)throw Error('notification_mapping_stale');
  this.entries(); // validate ALL restart state before admitting any producer
  this.activated=true;this.stopped=false;this.bridge.bind(this.binding);
  try{this.off=subscribeFleetSourceEvents(this.config.approval.target,event=>{if(!this.current(this.binding)){this.stop();return {status:'disabled'};}if(!this.ready)throw Error('notification_recovery_in_progress');return this.ingest(event);});}catch{this.stopped=true;this.bridge.unbind(this.binding.id);throw Error('notification_subscription_failed');}
  return this.recover().then(results=>{if(!this.current(this.binding))throw Error('notification_mapping_stale');this.ready=true;return results;}).catch(error=>{this.stop();throw error;});
 }
 stop(){this.ready=false;this.stopped=true;this.off?.();this.off=undefined;this.bridge.unbind(this.binding.id);}
 ingest(source:FleetSourceEvent){
  if(!this.ready||!this.current(this.binding)||!sameOwner(source.owner,this.config.approval.target)||!['message','question','permission'].includes(source.kind)||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(source.sourceId)||!Number.isSafeInteger(source.createdAt)||source.createdAt>Date.now()+1000||!/^[a-f0-9]{64}$/.test(source.contentDigest))throw Error('notification_source_invalid');
  const deadline=source.deadline===null?source.createdAt+this.config.messageBudgetMs:source.deadline;
  if(!Number.isSafeInteger(deadline)||deadline<=source.createdAt)throw Error('notification_deadline_invalid');
  if(source.kind==='question'&&!validOpaqueToolCallId(source.toolCallId))throw Error('notification_question_reference_incomplete');
  const id='fe-'+sha([targetKey(source.owner),source.kind,source.sourceId,this.binding.id,this.binding.epoch]);
  const event:AddressedFleetEvent={id,kind:source.kind,bindingId:this.binding.id,bindingEpoch:this.binding.epoch,fleetOwner:this.binding.fleetOwner,createdAt:source.createdAt,deadline,reference:source.kind==='question'?encodeQuestionReference(source.sourceId,source.toolCallId!):'fleet:'+source.kind+'/'+source.sourceId,contentDigest:source.contentDigest};
  const digest=sha(event),prior=this.ledger.lookup(this.context,id);
  if(prior&&prior.digest!==digest)throw Error('notification_intent_conflict');
  const known=prior??this.ledger.reserve(this.context,{requestId:id,target:source.owner,digest},{alias:this.binding.id,policyRevision:this.config.approval.authorityRevision}).receipt;
  if(known.digest!==digest)throw Error('notification_intent_conflict');
  const stored=this.decode(known);
  if(known.attempted&&!stored)throw Error('notification_attempt_unknown');
  if(known.attempted||stored&&stored.stage!=='ingested')return {status:'historical',eventId:id};
  if(stored){this.bridge.accept(stored.event);return {status:'already_ingested',eventId:id};}
  this.save(event,'ingested'); // stable durable payload exists BEFORE source ACK/cursor advance
  const accepted=this.bridge.accept(event);if(accepted.status!=='recorded'&&accepted.status!=='duplicate')throw Error('notification_admission_failed');
  return {status:'ingested',eventId:id};
 }
 async recover(){
  if(!this.current(this.binding))throw Error('notification_mapping_stale');
  const results=[];
  for(const {receipt,stored} of this.entries()){
   if(!stored){results.push({eventId:receipt.requestId,status:'unknown',reason:'payload_not_committed'});continue;}
   if(stored.stage==='terminal'){results.push({eventId:receipt.requestId,status:'historical',result:stored.result});continue;}
   if(receipt.attempted||stored.stage==='attempted'||stored.stage==='unknown'){
    let result:unknown;try{result=await this.host.reconcile(this.binding,stored.event,AbortSignal.timeout(3000));}catch{result={status:'unknown'};}
    this.save(stored.event,'unknown',result);results.push({eventId:receipt.requestId,status:'unknown',reconciliation:result,remote:'not_replayed'});continue;
   }
   const result=this.bridge.accept(stored.event);results.push({eventId:receipt.requestId,...result});
  }
  return results;
 }
 receipt(id:string){return this.bridge.receipt(id);}
}
