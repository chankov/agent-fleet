import {createHash} from 'node:crypto';
import type {BootstrapServices} from './fleet-notification-bootstrap.ts';
import type {NotificationConfig,NotificationQueueApproval} from './fleet-notification-validation.ts';
export type BootstrapCompatibility={schema:'fleet-codex-bootstrap-compat/v1';namespace:{hostProfile:string;principal:string;threadId:string};level:'verified'|'contract_checked'|'contract_unverified';daemonVersion:string;desktopVersion:string;socketEpoch:string;fingerprint?:string;probe:{id:string;receiptId:string;readerVersion:'codex-local-rollout-ack/v1';source:'read_only_assistant_transcript'}};
export type BootstrapAdmission=Readonly<{kind:'fleet-bootstrap-admission/v1'}>;
type Entry={seal:string;configSeal:string;stateRoot:string;claimed:boolean;revoked:boolean;guard:()=>boolean};
const entries=new WeakMap<BootstrapAdmission,Entry>();
const seal=(approval:NotificationQueueApproval,compat:BootstrapCompatibility)=>createHash('sha256').update(JSON.stringify([approval,compat])).digest('hex');
/** Trusted AF activation adapter ONLY. JSON/file/model input cannot construct
 * this in-memory authority, and a saved config never restores consent by itself.
 * A native Pi confirmation and actual probe evidence must precede this call. */
export function issueBootstrapAdmission(request:Parameters<BootstrapServices['activate']>[0],settings:Pick<NotificationConfig,'stateRoot'|'socketPath'|'messageBudgetMs'>,guard:()=>boolean){
 const {scope,assessment,rights,receipt:probe,catalog}=structuredClone(request);
 if(!['verified','contract_checked','contract_unverified'].includes(assessment.level)||!('context'in assessment)||probe.status!=='acknowledged'||probe.source!=='read_only_assistant_transcript'
  ||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(probe.probeId)||probe.threadId!==scope.namespace.threadId||probe.hostInstance!==scope.binding.hostInstance||!probe.notLoadedBefore||!probe.notLoadedAfter
  ||probe.daemonVersion!==assessment.context.daemonVersion||probe.desktopVersion!==assessment.context.desktopVersion||probe.socketEpoch!==assessment.context.socketEpoch||!/^rollout:[a-f0-9]{64}$/.test(probe.receiptId)
  ||rights.status!=='active'||!Number.isSafeInteger(rights.revision)||rights.revision<1||rights.expiresAt!==scope.until||JSON.stringify(rights.rights)!==JSON.stringify(scope.rights))throw Error('bootstrap_admission_invalid');
 const approval:NotificationQueueApproval={binding:scope.binding,target:scope.owner,authorityRevision:rights.revision,confirmedUntil:scope.until,transportOrigin:'user_input',mappingEvidence:'validated_native_host_context_and_read_only_probe',daemonVersion:assessment.context.daemonVersion,desktopVersion:assessment.context.desktopVersion};
 const compat:BootstrapCompatibility={schema:'fleet-codex-bootstrap-compat/v1',namespace:scope.namespace,level:assessment.level,...assessment.context,...('fingerprint'in assessment?{fingerprint:assessment.fingerprint}:{}),probe:{id:probe.probeId,receiptId:probe.receiptId,readerVersion:'codex-local-rollout-ack/v1',source:probe.source}};
 const config:NotificationConfig={optedIn:true,...structuredClone(settings),approval,loadedCatalog:catalog,compat};
 const admission:BootstrapAdmission=Object.freeze({kind:'fleet-bootstrap-admission/v1'});entries.set(admission,{seal:seal(approval,compat),configSeal:createHash('sha256').update(JSON.stringify(config)).digest('hex'),stateRoot:config.stateRoot,claimed:false,revoked:false,guard});
 return {config,admission};
}
/** Pure memory/shape check; intentionally does NOT invoke a filesystem/daemon
 * guard during previews/status/UI rendering. Runtime checks current separately. */
type AdmissionView=Pick<NotificationConfig,'approval'|'compat'>&Partial<NotificationConfig>;
export function matchesBootstrapAdmission(token:unknown,config:AdmissionView){
 if(!token||typeof token!=='object'||!config.compat)return false;const e=entries.get(token as BootstrapAdmission);return !!e&&!e.revoked&&e.seal===seal(config.approval,config.compat)&&(config.stateRoot===undefined||config.stateRoot===e.stateRoot)&&(!('optedIn'in config)||e.configSeal===createHash('sha256').update(JSON.stringify(config)).digest('hex'));
}
export function claimBootstrapAdmission(token:unknown,config:NotificationConfig){if(!matchesBootstrapAdmission(token,config))throw Error('bootstrap_admission_required');const e=entries.get(token as BootstrapAdmission)!;if(e.claimed)throw Error('bootstrap_admission_already_used');e.claimed=true;}
export function bootstrapAdmissionCurrent(token:unknown,config:AdmissionView){if(!matchesBootstrapAdmission(token,config))return false;const e=entries.get(token as BootstrapAdmission)!;try{return e.claimed&&e.guard()===true;}catch{return false;}}
export function revokeBootstrapAdmission(token:unknown){if(token&&typeof token==='object'){const e=entries.get(token as BootstrapAdmission);if(e)e.revoked=true;}}
