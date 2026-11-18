import {permissionAuditOutcome} from '../lib/exact-permission-port.ts';
export {permissionAuditOutcome,raceExactPermission,registerPermissionRelay,permissionRelayFor} from '../lib/exact-permission-port.ts';
import {createHash} from 'node:crypto';
import {publishFleetSourceEvent,fleetSourceDigest} from '../lib/fleet-event-source.ts';
import type {Socket} from 'node:net';
import {PermissionChannel,type PermissionOwner,type PermissionSnapshot,type PermissionOutcome,type MachinePrincipal} from './permission-channel.ts';
import type {DamageAction} from './damage-guard-state.ts';
import {actionPresentation} from './task-triage-authorization.ts';
import {redactSecrets} from '../lib/fleet-transcript-store.ts';
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const exact=(v:any,fields:string[])=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===fields.length&&fields.every(k=>Object.hasOwn(v,k));
export const permissionCapability={name:'fleet_machine_permissions',version:1,scope:'once',humanAttestation:false,receipt:'volatile_bounded'} as const;
export type PermissionView={snapshot:PermissionSnapshot;action:DamageAction;detail:string};
type Row={view:PermissionView;notificationEventId:string|null;timings:{ingressCommittedAt:number|null;createdAt:number;decisionAt:number|null;appliedAt:number|null;responseQueuedAt:number|null};current():boolean;effect:'pending'|'not_applied'|'consumed'|'response_queued_unconfirmed';winner?:PermissionOutcome};
/** Cooperative same-UID COMS boundary, not authenticated human/host attestation.
 * The native MCP adapter enforces persisted approve; Pi independently checks exact action freshness.
 */
export class PermissionRelay {
 private rows=new Map<string,Row>();
 private readonly owner:()=>PermissionOwner|null;
 available(){return this.owner()!==null;}
 readonly actionIdentity?:()=>{taskId:string;inputRevision:string};
 constructor(owner:()=>PermissionOwner|null,actionIdentity?:()=>{taskId:string;inputRevision:string}){this.owner=owner;this.actionIdentity=actionIdentity;}
 open(action:DamageAction,input:unknown,current:()=>boolean,expiresAt:number){
  const owner=this.owner(),detail=actionPresentation(action,{input,cwd:action.cwd});
  if(!owner||!detail||Buffer.byteLength(detail)>20000||!current()||this.rows.size>=256)return null;
  const target={owner,taskId:action.taskId,inputRevision:action.inputRevision,actionDigest:digest(action)};
  const fresh=()=>same(owner,this.owner())&&current();
  const provisional=new PermissionChannel(fresh);
  // Every row owns its latch: no temporary global freshness exception or cross-open race.
  const request=provisional.open(target,expiresAt);if(!request)return null;
  const row:Row={view:{snapshot:request.snapshot,action:structuredClone(action),detail},notificationEventId:null,timings:{ingressCommittedAt:null,createdAt:Date.now(),decisionAt:null,appliedAt:null,responseQueuedAt:null},current:fresh,effect:'pending'};
  this.rows.set(request.snapshot.id,row);
  const result=request.result.then(outcome=>{row.winner=outcome;if(outcome.status==='decided')row.timings.decisionAt??=Date.now();if(outcome.status!=='decided'||outcome.decision==='deny')row.effect='not_applied';return outcome;});
  this.latches.set(request.snapshot.id,provisional);
  try{const ingress=publishFleetSourceEvent({kind:'permission',owner,sourceId:request.snapshot.id,createdAt:row.timings.createdAt,deadline:expiresAt,contentDigest:fleetSourceDigest({action,detail})});if(ingress.status==='durably_ingested'){row.notificationEventId=ingress.eventId;row.timings.ingressCommittedAt=Date.now();}}
  catch{request.cancel();this.rows.delete(request.snapshot.id);this.latches.delete(request.snapshot.id);return null;}
  return {result,human:request.human,cancel:request.cancel,id:request.snapshot.id,actionDigest:request.snapshot.actionDigest,valid:()=>this.rows.get(request.snapshot.id)===row&&fresh()&&Date.now()<expiresAt&&row.winner?.status==='decided'&&row.winner.decision==='allow_once',
   responseWritten:()=>{if(row.effect==='pending'){row.effect='response_queued_unconfirmed';row.timings.responseQueuedAt=Date.now();}},
   applied:(consumed:boolean)=>{if(row.effect==='pending'){row.effect=consumed?'consumed':'not_applied';if(consumed)row.timings.appliedAt=Date.now();}}};
 }
 private latches=new Map<string,PermissionChannel>();
 reset(){for(const latch of this.latches.values())latch.reset();this.latches.clear();this.rows.clear();}
 summary(){
  const pending=[...this.rows.values()].filter(r=>this.latches.get(r.view.snapshot.id)?.inspect(r.view.snapshot).status==='pending');
  const closed=[...this.rows.values()].filter(r=>same(r.view.snapshot.owner,this.owner())).flatMap(r=>{const state=this.latches.get(r.view.snapshot.id)?.inspect(r.view.snapshot);return state&&state.status!=='pending'?[{id:r.view.snapshot.id,state:state.status,effect:r.effect,detailsRequired:true}]:[];});
  return {status:'available',partial:pending.length>32||closed.length>32,pendingCount:pending.length,nextCursor:pending.length>32?pending[31].view.snapshot.id:null,
   requests:pending.slice(0,32).map(r=>({...r.view.snapshot,operation:r.view.action.operation,detailsRequired:true})),resolved:closed.slice(-32)};
 }
 handle(socket:Socket,envelope:any){
  if(envelope?.type!=='permission_request')return false;
  const send=(body:Record<string,unknown>)=>{try{socket.end(JSON.stringify({type:'permission_response',version:1,msg_id:envelope.msg_id,owner:this.owner(),effectScope:'one_use_authority_not_tool_completion',identityAssurance:'cooperative_native_thread_no_host_or_turn_attestation',...body})+'\n');}catch{}};
  if(!exact(envelope,['type','version','msg_id','owner','operation','payload','sender_session','sender_endpoint','hops','timestamp'])||envelope.version!==1||typeof envelope.msg_id!=='string'||envelope.msg_id.length>96||Buffer.byteLength(JSON.stringify(envelope))>32768||!same(envelope.owner,this.owner())){send({status:'rejected'});return true;}
  const p=envelope.payload;
  if(envelope.operation==='list'){
   if(!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).some(k=>!['limit','cursor'].includes(k))||p.limit!==undefined&&(!Number.isSafeInteger(p.limit)||p.limit<1||p.limit>32)||p.cursor!==undefined&&p.cursor!==null&&(typeof p.cursor!=='string'||!/^[A-Za-z0-9._-]{1,96}$/.test(p.cursor))){send({status:'rejected'});return true;}
   const pending=[...this.rows.values()].filter(r=>this.latches.get(r.view.snapshot.id)?.inspect(r.view.snapshot).status==='pending');
   const index=p.cursor?pending.findIndex(r=>r.view.snapshot.id===p.cursor):-1;if(p.cursor&&index<0){send({status:'stale'});return true;}
   const page=pending.slice(index+1,index+1+(p.limit??32)),partial=index+1+page.length<pending.length;
   send({status:'ok',capability:permissionCapability,requests:page.map(r=>({snapshot:r.view.snapshot,operation:r.view.action.operation})),truncated:partial,partial,pendingCount:pending.length,nextCursor:partial?page.at(-1)!.view.snapshot.id:null});return true;
  }
  if(!p||!p.snapshot||!exact(p.snapshot,['owner','taskId','inputRevision','actionDigest','id','epoch','expiresAt'])){send({status:'rejected'});return true;}
  if(!same(p.snapshot.owner,envelope.owner)){send({status:'stale'});return true;}
  const row=this.rows.get(p.snapshot.id),latch=this.latches.get(p.snapshot.id);
  if(!row||!latch||!same(row.view.snapshot,p.snapshot)){send({status:'unknown'});return true;}
  if(envelope.operation==='inspect'||envelope.operation==='receipt'){
   if(!exact(p,['snapshot'])){send({status:'rejected'});return true;}
   const state=latch.inspect(p.snapshot);
   send({status:'ok',capability:permissionCapability,state,effect:row.effect,notificationEventId:row.notificationEventId,timings:{...row.timings},...(envelope.operation==='inspect'&&state.status==='pending'?{view:row.view}:{})});return true;
  }
  if(envelope.operation!=='decide'||!exact(p,['snapshot','decision','reason','principal'])||!exact(p.principal,['actor','bindingId','bindingEpoch','threadId','turnId','approve'])||p.principal.approve!==true||typeof p.reason!=='string'||!['allow_once','deny'].includes(p.decision)||redactSecrets(p.reason)!==p.reason){send({status:'rejected'});return true;}
  const principal:MachinePrincipal={...p.principal,current:()=>same(envelope.owner,this.owner())&&row.current()};
  const outcome=latch.machine(p.snapshot,p.decision,p.reason,principal);
  if(outcome.status==='accepted_by_latch')row.timings.decisionAt??=Date.now();
  send({...outcome,capability:permissionCapability,effect:row.effect,timings:{...row.timings}});return true;
 }
}
export function handlePermissionEnvelope(socket:Socket,envelope:any,relay:PermissionRelay|undefined,owner:PermissionOwner|null){
 if(envelope?.type!=='permission_request')return false;
 if(relay)return relay.handle(socket,envelope);
 try{socket.end(JSON.stringify({type:'permission_response',version:1,msg_id:envelope.msg_id,owner,status:same(owner,envelope.owner)?'unsupported':'stale'})+'\n');}catch{}
 return true;
}
