// Machine permission adapter. Not human consent, not a Desktop wake mechanism.
import {createHash} from 'node:crypto';
import {AllowedSessionsStore} from './fleet-codex-allowlist-store.ts';
import type {ConversationKey,TargetEpoch} from './fleet-codex-allowlist.ts';
import {ReadonlyFleetBridge,type RegistryReader} from './fleet-codex-readonly.ts';
import {InstructionLedger,targetKey,validInstructionTarget} from './fleet-codex-instruction-store.ts';
import {PermissionTransport} from './fleet-codex-permission-transport.ts';
import type {PermissionSnapshot} from '../../../harnesses/agent-hub/permission-channel.ts';
const sha=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const exact=(v:any,keys:string[])=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
export class PermissionError extends Error {readonly code:string;constructor(code:string){super(code);this.code=code;}}
const fail=(code:string):never=>{throw new PermissionError(code);};
const id=(v:unknown)=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(v);
function snapshot(v:any):v is PermissionSnapshot{return exact(v,['owner','taskId','inputRevision','actionDigest','id','epoch','expiresAt'])&&validInstructionTarget(v.owner)&&id(v.id)&&id(v.epoch)&&typeof v.taskId==='string'&&v.taskId.length>0&&v.taskId.length<=256&&typeof v.inputRevision==='string'&&v.inputRevision.length>0&&v.inputRevision.length<=256&&/^[a-f0-9]{64}$/.test(v.actionDigest)&&Number.isSafeInteger(v.expiresAt);}
export class PermissionBridge {
 private auth:ReadonlyFleetBridge;
 private ledger:InstructionLedger;
 private policyRoot:string;
 private wire:Pick<PermissionTransport,'rpc'>;
 private now:()=>number;
 constructor(options:{now?:()=>number;policyRoot:string;registryReader:RegistryReader;transport:Pick<PermissionTransport,'rpc'>}){
  this.now=options.now??Date.now;
  this.policyRoot=options.policyRoot;this.auth=new ReadonlyFleetBridge({registryReader:options.registryReader,policyBaseDir:options.policyRoot,now:options.now});
  // Isolated reservation journal using the proven atomic/locking engine. Its internal
  // generic instruction record is never presented as an instruction or permission grant.
  this.ledger=new InstructionLedger(options.policyRoot+'.permissions',{now:options.now});this.wire=options.transport;
 }
 private async access(c:ConversationKey,target:TargetEpoch,right:'read'|'approve'){
  const registry=await this.auth.discoverCandidates(c,{project:target.project});
  if(registry.status!=='complete'||registry.partial)fail('REGISTRY_UNAVAILABLE');
  const matches=registry.candidates.filter(v=>v.target.peer===target.peer);
  if(matches.length!==1||matches[0].presence!=='fresh'||targetKey(matches[0].target)!==targetKey(target))fail('TARGET_CHANGED');
  const current=registry.candidates.filter(v=>v.presence==='fresh').map(v=>v.target);
  const store=new AllowedSessionsStore(this.policyRoot,c,{now:this.now}),state=await store.list(current);
  const bindings=state.bindings.filter(b=>targetKey(b.target)===targetKey(target));if(bindings.length!==1)fail('NOT_ALLOWED');
  const handle=await store.resolve(bindings[0].alias,current);
  await store.authorize(handle,right,current);
  return {store,handle,alias:bindings[0].alias};
 }
 localReceipt(c:ConversationKey,input:any){
  if(!exact(input,['requestId'])||!id(input.requestId))fail('INVALID_ARGUMENTS');
  const receipt=this.ledger.lookup(c,input.requestId);return receipt?this.history(receipt):{status:'unknown',operation:'permission',source:'codex_machine',remote:'not_checked'};
 }
 async query(c:ConversationKey,input:any,signal?:AbortSignal){
  if(!input||typeof input!=='object'||Array.isArray(input)||!['target','operation','snapshot'].every(k=>Object.hasOwn(input,k))||Object.keys(input).some(k=>!['target','operation','snapshot','cursor'].includes(k))||input.cursor!==undefined&&(input.operation!=='list'||input.cursor!==null&&!id(input.cursor))||!validInstructionTarget(input.target)||!['list','inspect','receipt'].includes(input.operation)||input.operation!=='list'&&!snapshot(input.snapshot)||input.operation==='list'&&input.snapshot!==null)fail('INVALID_ARGUMENTS');
  if(input.snapshot&&targetKey(input.snapshot.owner)!==targetKey(input.target))fail('INVALID_ARGUMENTS');
  await this.access(c,input.target,'read');if(signal?.aborted)fail('REQUEST_CANCELLED');
  const result=await this.wire.rpc(input.target,{operation:input.operation,payload:input.snapshot?{snapshot:input.snapshot}:input.cursor!==undefined?{cursor:input.cursor}:{}},undefined,signal);
  await this.access(c,input.target,'read');return result;
 }
 async decide(c:ConversationKey,input:any,signal?:AbortSignal){
  if(!exact(input,['requestId','snapshot','decision','reason'])||!id(input.requestId)||!snapshot(input.snapshot)||!['allow_once','deny'].includes(input.decision)||typeof input.reason!=='string'||!input.reason.trim()||input.reason.length>2000||/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(input.reason))fail('INVALID_ARGUMENTS');
  const s:PermissionSnapshot=input.snapshot,target=s.owner,digest=sha(input);
  const history=this.ledger.lookup(c,input.requestId);
  if(history){if(history.digest!==digest||targetKey(history.target)!==targetKey(target))fail('INTENT_CONFLICT');return this.history(history);}
  if(signal?.aborted)fail('REQUEST_CANCELLED');if(Date.now()>=s.expiresAt)fail('PERMISSION_EXPIRED');
  const access=await this.access(c,target,'approve');
  const inspected:any=await this.wire.rpc(target,{operation:'inspect',payload:{snapshot:s}},undefined,signal);
  if(inspected.status!=='ok'||inspected.capability?.name!=='fleet_machine_permissions'||inspected.capability.version!==1||inspected.state?.status!=='pending'||!inspected.view||JSON.stringify(inspected.view.snapshot)!==JSON.stringify(s)||sha(inspected.view.action)!==s.actionDigest||inspected.view.action.taskId!==s.taskId||inspected.view.action.inputRevision!==s.inputRevision)fail('PERMISSION_NOT_PENDING');
  // Preserve the exact policy revision across inspection/reservation. Any unrelated
  // authority change also invalidates this attempt rather than silently retargeting.
  const before=await this.access(c,target,'approve');if(before.handle.revision!==access.handle.revision)fail('AUTHORIZATION_CHANGED');
  const reserved=this.ledger.reserve(c,{requestId:input.requestId,target,digest},{alias:access.alias,policyRevision:access.handle.revision});
  if(!reserved.created)return this.history(reserved.receipt);
  try{
   const recheck=await this.access(c,target,'approve');
   if(recheck.handle.revision!==access.handle.revision||signal?.aborted||Date.now()>=s.expiresAt){this.ledger.record(c,input.requestId,{state:'not_sent',detail:'permission_prewrite_fence',result:null,truncated:false});return this.history(this.ledger.lookup(c,input.requestId)!);}
   const result:any=await this.wire.rpc(target,{operation:'decide',payload:{snapshot:s,decision:input.decision,reason:input.reason,principal:{actor:`${c.hostProfile}/${c.principal}`,bindingId:access.alias,bindingEpoch:String(access.handle.revision),threadId:c.threadId,turnId:null,approve:true}}},async()=>{
    const fresh=await this.access(c,target,'approve');if(fresh.handle.revision!==access.handle.revision||Date.now()>=s.expiresAt||signal?.aborted)fail('AUTHORIZATION_CHANGED');
    this.ledger.markAttempt(c,input.requestId);
   },signal);
   const allowed=['accepted_by_latch','late','rejected','stale','unknown'].includes(result.status);
   const body=allowed?JSON.stringify({source:'codex_machine',status:result.status,permissionId:s.id,effect:result.effect??'unknown'}):null;
   this.ledger.record(c,input.requestId,{state:allowed&&result.status!=='unknown'?'result':'unknown',detail:'permission_remote_receipt',result:body,truncated:false});
  }catch{
   // Once a reservation exists, failure is historical uncertainty, never blind replay.
   const r=this.ledger.lookup(c,input.requestId)!;
   this.ledger.record(c,input.requestId,{state:r.attempted?'unknown':'not_sent',detail:'permission_transport_uncertain',result:null,truncated:false});
  }
  return this.history(this.ledger.lookup(c,input.requestId)!);
 }
 private history(r:any){return {status:'historical',operation:'permission',source:'codex_machine',humanProvenance:'not_human',completion:'not_established',identityAssurance:'cooperative_native_thread_no_host_or_turn_attestation',reservation:{requestId:r.requestId,target:r.target,digest:r.digest,attempted:r.attempted,state:r.state,result:r.result?JSON.parse(r.result):null},remote:'not_replayed'};}
}
