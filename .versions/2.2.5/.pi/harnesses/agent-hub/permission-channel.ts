import {randomUUID} from 'node:crypto';

export type PermissionOwner = Readonly<{project:string;peer:string;sessionId:string;startedAt:string}>;
export type PermissionTarget = Readonly<{
 owner:PermissionOwner;taskId:string;inputRevision:string;actionDigest:string;
}>;
export type PermissionSnapshot = PermissionTarget & Readonly<{id:string;epoch:string;expiresAt:number}>;
export type PermissionOutcome =
 | {status:'decided';decision:'allow_once'|'deny';source:'local_human';actor:string}
 | {status:'decided';decision:'allow_once'|'deny';source:'codex_machine';actor:string;bindingId:string;bindingEpoch:string;threadId:string;turnId:string|null;reason:string}
 | {status:'expired'|'cancelled'|'stale'};
/** Injected by authenticated host integration, never deserialized from a model payload. */
export type MachinePrincipal = Readonly<{
 actor:string;bindingId:string;bindingEpoch:string;threadId:string;turnId:string|null;
 approve:boolean;current():boolean;
}>;
type Entry={snapshot:PermissionSnapshot;result?:PermissionOutcome;resolve(value:PermissionOutcome):void;timer:ReturnType<typeof setTimeout>};
const hash=/^[a-f0-9]{64}$/;
const plain=(value:string,max:number)=>typeof value==='string'&&value.trim().length>0&&value.length<=max&&!/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(value);
const same=(a:PermissionTarget,b:PermissionTarget)=>a.taskId===b.taskId&&a.inputRevision===b.inputRevision&&a.actionDigest===b.actionDigest&&
 ['project','peer','sessionId','startedAt'].every(k=>a.owner[k as keyof PermissionOwner]===b.owner[k as keyof PermissionOwner]);

/** Process-local one-winner latch. This is NOT a transport, grant or applied-effect receipt.
 * Machine authority defaults off; adapters must independently authenticate the principal,
 * inspect the full action, and revalidate again at the existing one-use enforcement point.
 */
export class PermissionChannel {
 private epoch=randomUUID();
 private entries=new Map<string,Entry>();
 private readonly current:(snapshot:PermissionSnapshot)=>boolean;
 private readonly limit:number;
 constructor(current:(snapshot:PermissionSnapshot)=>boolean,limit=256){this.current=current;this.limit=limit;}
 open(target:PermissionTarget,expiresAt:number){
  if(!target.owner||!Object.values(target.owner).every(v=>plain(v,256))||!plain(target.taskId,256)||!plain(target.inputRevision,256)||!hash.test(target.actionDigest)||!Number.isSafeInteger(expiresAt)||expiresAt<=Date.now()||expiresAt>Date.now()+600_000||this.entries.size>=this.limit)return null;
  const snapshot:PermissionSnapshot={...structuredClone(target),id:randomUUID(),epoch:this.epoch,expiresAt};
  if(!this.isCurrent(snapshot))return null;
  let resolve!:(value:PermissionOutcome)=>void;
  const result=new Promise<PermissionOutcome>(r=>{resolve=r;});
  const entry:Entry={snapshot,resolve,timer:setTimeout(()=>this.close(entry,{status:'expired'}),Math.min(2_147_483_647,expiresAt-Date.now()))};
  this.entries.set(snapshot.id,entry);
  return {snapshot:structuredClone(snapshot),result,
   human:(decision:'allow_once'|'deny',actor:string)=>this.human(snapshot,decision,actor),
   cancel:()=>this.close(entry,{status:'cancelled'})};
 }
 inspect(target:PermissionSnapshot){
  const entry=this.lookup(target);
  if(!entry)return {status:'unknown'} as const;
  this.refresh(entry);
  return entry.result ? structuredClone(entry.result) : {status:'pending' as const,snapshot:structuredClone(entry.snapshot)};
 }
 machine(target:PermissionSnapshot,decision:'allow_once'|'deny',reason:string,principal:MachinePrincipal){
  const entry=this.lookup(target);if(!entry)return {status:'unknown'} as const;
  this.refresh(entry);
  // A repeated submission never returns authority again. Inspect is the receipt query.
  if(entry.result)return {status:'late'} as const;
  if(!principal.approve||!plain(reason,2000)||!['allow_once','deny'].includes(decision)||
   ![principal.actor,principal.bindingId,principal.bindingEpoch,principal.threadId].every(v=>plain(v,256))||principal.turnId!==null&&!plain(principal.turnId,256))return {status:'rejected'} as const;
  try {if(!principal.current())return {status:'stale'} as const;}catch{return {status:'stale'} as const;}
  // No await between final freshness checks and winner selection.
  this.refresh(entry);if(entry.result)return {status:'late'} as const;
  this.close(entry,{status:'decided',decision,source:'codex_machine',actor:principal.actor,bindingId:principal.bindingId,bindingEpoch:principal.bindingEpoch,threadId:principal.threadId,turnId:principal.turnId,reason});
  return {status:'accepted_by_latch'} as const;
 }
 reset(){
  for(const entry of this.entries.values())this.close(entry,{status:'stale'});
  this.entries.clear();this.epoch=randomUUID();
 }
 private human(target:PermissionSnapshot,decision:'allow_once'|'deny',actor:string){
  const entry=this.lookup(target);if(!entry)return false;
  this.refresh(entry);if(entry.result||!['allow_once','deny'].includes(decision)||!plain(actor,256))return false;
  return this.close(entry,{status:'decided',decision,source:'local_human',actor});
 }
 private lookup(target:PermissionSnapshot){
  const entry=this.entries.get(target.id);
  return entry&&target.epoch===this.epoch&&target.epoch===entry.snapshot.epoch&&target.expiresAt===entry.snapshot.expiresAt&&same(target,entry.snapshot)?entry:undefined;
 }
 private isCurrent(snapshot:PermissionSnapshot){try{return this.current(structuredClone(snapshot));}catch{return false;}}
 private refresh(entry:Entry){
  if(entry.result)return;
  if(entry.snapshot.expiresAt<=Date.now())this.close(entry,{status:'expired'});
  else if(entry.snapshot.epoch!==this.epoch||!this.isCurrent(entry.snapshot))this.close(entry,{status:'stale'});
 }
 private close(entry:Entry,outcome:PermissionOutcome){
  if(entry.result)return false;
  clearTimeout(entry.timer);entry.result=structuredClone(outcome);entry.resolve(structuredClone(outcome));return true;
 }
}
