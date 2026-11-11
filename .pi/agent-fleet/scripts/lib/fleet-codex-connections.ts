import {randomUUID} from 'node:crypto';
import {AllowedSessionsStore,StoreError,type StoreOptions} from './fleet-codex-allowlist-store.ts';
import type {ConversationKey,TargetEpoch,Right} from './fleet-codex-allowlist.ts';
import {PermissionTransport} from './fleet-codex-permission-transport.ts';
import {validInstructionTarget,targetKey} from '../../../harnesses/lib/fleet-notification-validation.ts';
export class ConnectionError extends Error {readonly code:string;constructor(code:string){super(code);this.code=code;}}
function fail(code:string):never{throw new ConnectionError(code);}
const key=(c:ConversationKey)=>JSON.stringify([c.hostProfile,c.principal,c.threadId]);
export function parseConnection(v:any,operation:'prepare'|'commit'|'status'){
 const fields=operation==='prepare'?['target','rights','durationHours','notifications','desktopConfirmed']:operation==='status'?['target']:['proposalId','quiescentWritersConfirmed'];
 if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!fields.includes(k)))fail('INVALID_ARGUMENTS');
 if(operation==='commit'){if(v.quiescentWritersConfirmed!==undefined&&typeof v.quiescentWritersConfirmed!=='boolean')fail('INVALID_ARGUMENTS');if(typeof v.proposalId!=='string'||!/^[a-f0-9-]{36}$/.test(v.proposalId))fail('INVALID_ARGUMENTS');return;}
 if(!validInstructionTarget(v.target))fail('INVALID_ARGUMENTS');
 if(operation==='status')return;
 if(v.rights!==undefined&&(!Array.isArray(v.rights)||JSON.stringify(v.rights)!==JSON.stringify(['read',...(v.rights.includes('send')?['send']:[]),...(v.rights.includes('approve')?['approve']:[])])))fail('READ_REQUIRED_ORDERED_UNIQUE_RIGHTS');
 if(v.durationHours!==undefined&&(!Number.isInteger(v.durationHours)||v.durationHours<1||v.durationHours>720)||v.notifications!==undefined&&typeof v.notifications!=='boolean'||v.desktopConfirmed!==undefined&&typeof v.desktopConfirmed!=='boolean')fail('INVALID_ARGUMENTS');
}
type Candidate={target:TargetEpoch;current:TargetEpoch[]};
type Pending={context:string;target:TargetEpoch;rights:Right[];until:number;revision:number|null;existing:boolean;alias:string;remoteProposal?:string;expires:number;promise?:Promise<any>;outcome?:any};
/** Native UX orchestration. Cooperative explicit-review contract, not human attestation. */
type ConnectionOptions={policyRoot:string;candidate:(c:ConversationKey,t:TargetEpoch)=>Promise<Candidate>;transport:Pick<PermissionTransport,'rpc'>;now?:()=>number;monotonic?:()=>number;storeOptions?:StoreOptions;pendingBudget?:(context:string)=>{total:number;context:number}};
export class ConnectionBridge {
 private pending=new Map<string,Pending>();
 private options:ConnectionOptions;
 constructor(options:ConnectionOptions){this.options=options;}
 private now(){return (this.options.now??Date.now)();}
 private mono(){return (this.options.monotonic??(()=>performance.now()))();}
 private store(c:ConversationKey){return new AllowedSessionsStore(this.options.policyRoot,c,{...this.options.storeOptions,now:this.options.now});}
 private async state(c:ConversationKey){try{return await this.store(c).open();}catch(e){if(e instanceof StoreError&&e.code==='STATE_MISSING')return null;throw e;}}
 private async remote(c:ConversationKey,t:TargetEpoch,operation:string,payload:object,signal?:AbortSignal){return this.options.transport.rpc(t,{operation,payload:{namespace:c,...payload}},async()=>{const selected=await this.options.candidate(c,t);if(targetKey(selected.target)!==targetKey(t))fail('TARGET_CHANGED');},signal);}
 async status(c:ConversationKey,a:any,signal?:AbortSignal){
  const selected=await this.options.candidate(c,a.target);if(targetKey(selected.target)!==targetKey(a.target))fail('TARGET_CHANGED');
  const state=await this.state(c),b=state?.bindings.find(b=>targetKey(b.target)===targetKey(a.target));
  let remote:any;try{remote=await this.remote(c,a.target,'status',{},signal);}catch(e){remote={status:'unavailable',reason:(e as any).code??'control_unavailable'};}
  return {status:'observed',target:a.target,namespace:c,rights:b?{stored:b.rights,effective:b.status==='active'&&(b.expiresAt===undefined||b.expiresAt>this.now()),expiresAt:b.expiresAt??null,reason:b.expiresAt!==undefined&&b.expiresAt<=this.now()?'rights_expired':b.status}:{stored:[],effective:false,reason:'not_connected'},notifications:remote.notifications??{enabled:false,reason:remote.reason??remote.status},delivery:'not_established_by_status'};
 }
 pendingCount(context?:string){for(const [id,p] of this.pending)if(!p.promise&&p.expires<=this.mono())this.pending.delete(id);return context===undefined?this.pending.size:[...this.pending.values()].filter(p=>p.context===context).length;}
 async prepare(c:ConversationKey,a:any,signal?:AbortSignal){
  const other=this.options.pendingBudget?.(key(c))??{total:0,context:0};if(this.pendingCount()+other.total>=64||this.pendingCount(key(c))+other.context>=16)fail('BUSY');
  const selected=await this.options.candidate(c,a.target);if(targetKey(selected.target)!==targetKey(a.target))fail('TARGET_CHANGED');
  const state=await this.state(c),existing=state?.bindings.find(b=>b.target.project===a.target.project&&b.target.peer===a.target.peer);
  if(existing&&(targetKey(existing.target)!==targetKey(a.target)||existing.status!=='active'))fail('REBIND_REQUIRED');
  const rights=(a.rights??existing?.rights??['read']) as Right[],until=this.now()+(a.durationHours??12)*3600000;
  if(existing&&JSON.stringify(existing.rights)!==JSON.stringify(rights))return {status:'blocked',reason:'existing_rights_preserved_use_explicit_binding_transition',storedRights:existing.rights};
  if(existing?.expiresAt!==undefined&&existing.expiresAt<=this.now())return {status:'blocked',reason:'rights_expired_explicit_reenrollment_required'};
  let remote:any;
  if(a.notifications!==false){
   if(a.desktopConfirmed!==true)return {status:'blocked',reason:'loaded_desktop_confirmation_required',noChanges:true};
   try{remote=await this.remote(c,a.target,'prepare',{until,desktopConfirmed:true},signal);}catch(e){return {status:'blocked',reason:(e as any).code??'control_unavailable',noChanges:true};}
   if(remote.status!=='prepared')return {status:'blocked',reason:remote.reason??'host_mapping_required',remote,noChanges:true};
  }
  for(const [id,p] of this.pending)if(!p.promise&&p.expires<=this.mono())this.pending.delete(id);
  const freshBudget=this.options.pendingBudget?.(key(c))??{total:0,context:0};if(this.pending.size+freshBudget.total>=64||[...this.pending.values()].filter(p=>p.context===key(c)).length+freshBudget.context>=16)fail('BUSY');
  const proposalId=randomUUID();this.pending.set(proposalId,{context:key(c),target:selected.target,rights:[...rights],until,revision:state?.revision??null,existing:!!existing,alias:existing?.alias??selected.target.project+':'+selected.target.peer,remoteProposal:remote?.proposalId,expires:this.mono()+300000});
  return {status:'prepared',proposalId,expiresInSeconds:300,target:selected.target,namespace:c,proposedRights:rights,rightsUntil:existing?existing.expiresAt??null:until,existingRightsPreserved:!!existing,notificationsUntil:remote?until:null,eventKinds:remote?['message','question','permission']:[],requiresExplicitConfirmation:true,humanProvenance:'unknown',compatibility:existing?'existing_policy_unchanged':'policy_v3_old_writers_fail_closed',requiresQuiescentWriters:!existing,delivery:'not_attempted'};
 }
 async commit(c:ConversationKey,id:string,signal?:AbortSignal,quiescentWritersConfirmed=false){
  const p=this.pending.get(id);if(!p||p.context!==key(c)||p.expires<=this.mono())fail('PROPOSAL_UNAVAILABLE');if(p.outcome)return structuredClone(p.outcome);if(!p.existing&&!quiescentWritersConfirmed)fail('QUIESCENT_WRITERS_CONFIRMATION_REQUIRED');if(p.promise)return p.promise;
  p.promise=(async()=>{let rightsCommitted=false;try{
   if(signal?.aborted)fail('REQUEST_CANCELLED');
   const selected=await this.options.candidate(c,p.target);if(targetKey(selected.target)!==targetKey(p.target))fail('TARGET_CHANGED');
   const store=this.store(c);let state=await this.state(c);if((state?.revision??null)!==p.revision)fail('STATE_CHANGED');
   if(!p.existing){if(p.until<=this.now())fail('RIGHTS_EXPIRED');if(!state)state=await store.initialize();state=await store.connect({alias:p.target.project+':'+p.target.peer,target:p.target,rights:p.rights,expiresAt:p.until},selected.current,state.revision);rightsCommitted=true;}
   else{const h=await store.resolve(p.alias,selected.current);await store.authorize(h,'read',selected.current);}
   let notifications:any={status:'not_requested'};
   if(p.remoteProposal){if(signal?.aborted)fail('REQUEST_CANCELLED');notifications=await this.remote(c,p.target,'commit',{proposalId:p.remoteProposal},signal);}
   p.outcome={status:['not_requested','renewed'].includes(notifications.status)?'committed':'partially_applied_or_unknown',target:p.target,rightsCommitted,existingRightsPreserved:p.existing,notifications,delivery:'not_established_by_commit'};
  }catch(e){p.outcome={status:'failed_or_unknown',reason:(e as any).code??'IO_ERROR',rightsCommitted,replayAllowed:false};}return structuredClone(p.outcome);})();return p.promise;
 }
}
