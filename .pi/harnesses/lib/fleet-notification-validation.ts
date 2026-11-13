/** Shared pure notification validation. No filesystem, transport, runtime or activation imports. */
import {isAbsolute,resolve} from 'node:path';
import type {CodexEventBinding} from './fleet-codex-event-bridge.ts';
import {assessCodexVersion} from './codex-compat.ts';
import {projectSchema,compareProjection,fingerprint,ContractProjectionError,type ContractProjection,type UsedSurface} from './codex-contract.ts';
import {assessLoadedFleetCatalog} from './fleet-codex-catalog.ts';
import {matchesBootstrapAdmission,type BootstrapCompatibility} from './fleet-notification-admission.ts';
export {assessLoadedFleetCatalog,notificationToolNames,fleetCatalogProtocolVersions} from './fleet-codex-catalog.ts';
import {targetKey,validInstructionTarget,type TargetEpoch} from './fleet-target-identity.ts';
export {targetKey,validInstructionTarget};
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, names: string[]) => Object.keys(v).length === names.length && names.every(k => Object.hasOwn(v, k));
const text = (v: unknown, max = 1024): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f]/.test(v);
const date = (v: unknown): v is string => typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v));
export const desktopQueuePin={daemon:'0.166.0',desktop:'0.166.0-alpha.5.1',addSchema:'60f25b7d3e3357c215bef9d2fe7047200f545e030dca9e00527ac0620cd0c88f',responseSchema:'c11b9772788427b19c9f9decf0765e2b41cbdead1aa9c3d39f42fdd70b339314'} as const;
export interface DesktopQueueApproval {
 binding:CodexEventBinding;target:TargetEpoch;authorityRevision:number;confirmedUntil:number;
 transportOrigin:'user_input';mappingEvidence:'externally_confirmed_loaded_desktop';
 daemonVersion:string;desktopVersion:string;addSchema:string;responseSchema:string;
 desktopAddSchema?:string;desktopResponseSchema?:string;
}
/** New bootstrap approval has no invented historical wire-schema hashes. Only
 * an in-memory admission issued after native confirmation/probe can admit it. */
export interface NotificationQueueApproval extends Omit<DesktopQueueApproval,'addSchema'|'responseSchema'|'mappingEvidence'> {
 addSchema?:string;responseSchema?:string;
 mappingEvidence:DesktopQueueApproval['mappingEvidence']|'validated_native_host_context_and_read_only_probe';
}
// The original two schema fields describe the daemon wire. Older Desktop
// releases share those schemas; a measured asymmetric tuple pins both endpoints.
const desktopQueueTuples=[
 desktopQueuePin,
 {...desktopQueuePin,desktop:'0.166.0-alpha.6'},
 {...desktopQueuePin,desktop:'0.167.0-alpha.3.2',
  desktopAddSchema:'f6466a8f06cd4e68ec1999d06a0d70a1ddc339c0cb1baf12ee966a999fead17c',
  desktopResponseSchema:'896a82716b432a8aa4d190591bcfa86adacdacb91ec5ec2c9c75ff6562561256'},
] as const;
type DesktopQueueTupleEvidence=Pick<NotificationQueueApproval,'daemonVersion'|'desktopVersion'|'addSchema'|'responseSchema'|'desktopAddSchema'|'desktopResponseSchema'>;
export function matchesDesktopQueueTuple(a:DesktopQueueTupleEvidence){
 return desktopQueueTuples.some(p=>
  a.daemonVersion===p.daemon&&a.desktopVersion===p.desktop&&a.addSchema===p.addSchema&&a.responseSchema===p.responseSchema&&
  a.desktopAddSchema===('desktopAddSchema' in p?p.desktopAddSchema:undefined)&&
  a.desktopResponseSchema===('desktopResponseSchema' in p?p.desktopResponseSchema:undefined));
}

const sameOwner=(a:unknown,b:unknown)=>validInstructionTarget(a)&&validInstructionTarget(b)&&targetKey(a)===targetKey(b);
export type NotificationConfig={optedIn:true;stateRoot:string;socketPath:string;approval:NotificationQueueApproval;loadedCatalog:unknown;messageBudgetMs:number;compat?:BootstrapCompatibility};
/** Pure shape parsing for callers that already opened and bounded private bytes. No I/O or activation. */
export function parseNotificationConfiguration(raw:string):NotificationConfig{
 const value=JSON.parse(raw),shape=value&&Object.keys(value).sort().join(',');if(shape!=='approval,loadedCatalog,messageBudgetMs,optedIn,socketPath,stateRoot'&&shape!=='approval,compat,loadedCatalog,messageBudgetMs,optedIn,socketPath,stateRoot')throw Error('notification_config_invalid');return value;
}
export function notificationPreview(c:NotificationConfig,owner:unknown,bootstrapAdmission?:unknown){
 const catalog=assessLoadedFleetCatalog(c?.loadedCatalog,true),a=c?.approval,b=a?.binding;
 const approvalKeys=a?Object.keys(a).sort().join(','):'';
 const knownApprovalShape=approvalKeys==='addSchema,authorityRevision,binding,confirmedUntil,daemonVersion,desktopVersion,mappingEvidence,responseSchema,target,transportOrigin'||
  approvalKeys==='addSchema,authorityRevision,binding,confirmedUntil,daemonVersion,desktopAddSchema,desktopResponseSchema,desktopVersion,mappingEvidence,responseSchema,target,transportOrigin';
 const bootstrapShape=approvalKeys==='authorityRevision,binding,confirmedUntil,daemonVersion,desktopVersion,mappingEvidence,target,transportOrigin';
 const legacy=!c?.compat&&knownApprovalShape&&a?.mappingEvidence==='externally_confirmed_loaded_desktop'&&matchesDesktopQueueTuple(a);
 const bootstrap=!!c?.compat&&bootstrapShape&&a?.mappingEvidence==='validated_native_host_context_and_read_only_probe'&&matchesBootstrapAdmission(bootstrapAdmission,c);
 const mapping=!!a&&!!b&&(legacy||bootstrap)&&Object.keys(b).sort().join(',')==='epoch,fleetOwner,hostInstance,id,threadId'&&Object.values(b).every(v=>typeof v==='string'&&v.length>0&&v.length<=512&&/^[\x20-\x7e]+$/.test(v))&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(b.id)&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(b.threadId)&&validInstructionTarget(a.target)&&sameOwner(owner,a.target)&&b.fleetOwner===targetKey(a.target)&&Number.isSafeInteger(a.authorityRevision)&&a.authorityRevision>0&&Number.isSafeInteger(a.confirmedUntil)&&a.confirmedUntil>Date.now()&&a.transportOrigin==='user_input';
 const paths=typeof c?.stateRoot==='string'&&isAbsolute(c.stateRoot)&&resolve(c.stateRoot)===c.stateRoot&&typeof c.socketPath==='string'&&isAbsolute(c.socketPath)&&c.socketPath.length<=100&&!/[:?#%\\\u0000-\u0020]/.test(c.socketPath);
 const ready=c?.optedIn===true&&mapping&&paths&&catalog.ready&&Number.isSafeInteger(c.messageBudgetMs)&&c.messageBudgetMs>10000&&c.messageBudgetMs<=60000;
 return {ready,catalog,mappingValid:mapping,activation:'not_performed',requiresExplicitUserEnable:true,startsDaemon:false,grantsApprove:false};
}

export type QueueCompatibilityContext={daemonVersion:string;desktopVersion:string;socketEpoch:string};
type ExportUnavailableReason='matching_binary_unavailable'|'schema_export_unavailable'|'schema_export_timeout';
export type QueueCompatibilityAssessment=
 | {level:'blocked';reason:string;activation:'not_performed'}
 | {level:'verified'|'contract_checked';fingerprint:string;context:QueueCompatibilityContext;requiresProbe:true;activation:'not_performed'}
 | {level:'contract_unverified';reason:ExportUnavailableReason;warning:'schema_not_verified';context:QueueCompatibilityContext;requiresProbe:true;activation:'not_performed'};

/** Version/schema PREFLIGHT, not identity, freshness, consumer, probe or authority
 * qualification. No ready/enable result and no probe execution. Existing legacy
 * tuple/preview admission is deliberately untouched.
 *
 * Both arguments are already bounded inert JSON. policy is TRUSTED server-owned
 * configuration, NEVER model/tool input: explicit daemon/Desktop version policies
 * and optional {surface,referenceDocuments,verifiedFingerprints} profile. The
 * profile must cover the complete consumed daemon/Desktop wire surface; no new
 * production profile or qualified fingerprint is installed by this function.
 * This is not an exception boundary for arbitrary getters/Proxies.
 */
export function assessQueueCompatibility(evidence:unknown,policy:unknown):QueueCompatibilityAssessment{
 const blocked=(reason:string):QueueCompatibilityAssessment=>({level:'blocked',reason,activation:'not_performed'});
 if(!object(policy)||(!keys(policy,['daemon','desktop'])&&!keys(policy,['daemon','desktop','profile'])))return blocked('invalid_policy');
 for(const role of ['daemon','desktop'])if(assessCodexVersion('0.0.0',policy[role]).reason==='invalid_policy')return blocked('invalid_policy');
 let profile:{surface:UsedSurface;reference:ContractProjection;qualified:readonly string[]}|undefined;
 if(Object.hasOwn(policy,'profile')){
  const p=policy.profile;
  if(!object(p)||!keys(p,['surface','referenceDocuments','verifiedFingerprints']))return blocked('invalid_policy');
  const hashes=p.verifiedFingerprints;
  if(!Array.isArray(hashes)||hashes.length>128||Array.from(hashes).some(h=>typeof h!=='string'||!/^[a-f0-9]{64}$/.test(h))||new Set(hashes).size!==hashes.length)return blocked('invalid_policy');
  try{profile={surface:p.surface as UsedSurface,reference:projectSchema(p.referenceDocuments,p.surface as UsedSurface),qualified:hashes};}
  catch(error){if(error instanceof ContractProjectionError)return blocked('invalid_policy');throw error;}
 }
 if(!object(evidence)||!keys(evidence,['daemonVersion','desktopVersion','socketEpoch','contract']))return blocked('invalid_evidence');
 for(const role of ['daemon','desktop']){
  const assessed=assessCodexVersion(evidence[role+'Version'],policy[role]);
  if(!assessed.eligible)return blocked(role+'_'+assessed.reason);
 }
 if(!text(evidence.socketEpoch,1024)||/[\u0020\u007f]/.test(evidence.socketEpoch))return blocked('invalid_evidence');
 const context={daemonVersion:evidence.daemonVersion as string,desktopVersion:evidence.desktopVersion as string,socketEpoch:evidence.socketEpoch};
 const contract=evidence.contract;
 if(!object(contract))return blocked('invalid_evidence');
 const available=contract.state==='available',unavailable=contract.state==='unavailable';
 if((!available&&!unavailable)||!keys(contract,['state','daemonVersion','desktopVersion','socketEpoch',available?'documents':'reason']))return blocked('invalid_evidence');
 if(contract.daemonVersion!==context.daemonVersion||contract.desktopVersion!==context.desktopVersion||contract.socketEpoch!==context.socketEpoch)return blocked('measurement_changed');
 if(unavailable){
  const reason=contract.reason;
  if(reason!=='matching_binary_unavailable'&&reason!=='schema_export_unavailable'&&reason!=='schema_export_timeout')return blocked('invalid_evidence');
  return {level:'contract_unverified',reason,warning:'schema_not_verified',context,requiresProbe:true,activation:'not_performed'};
 }
 if(!profile)return blocked('profile_unavailable');
 try{
  const observed=projectSchema(contract.documents,profile.surface),hash=fingerprint(observed);
  // Qualified hashes are trusted policy facts, not automatic promotions of a
  // structurally compatible export. Projection validity is checked even here.
  const known=profile.qualified.includes(hash);
  if(!known&&!compareProjection(profile.reference,observed).compatible)return blocked('used_contract_changed');
  return {level:known?'verified':'contract_checked',fingerprint:hash,context,requiresProbe:true,activation:'not_performed'};
 }catch(error){if(error instanceof ContractProjectionError)return blocked('projection_'+error.code);throw error;}
}
