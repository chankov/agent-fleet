/** Shared pure notification validation. No filesystem, transport, runtime or activation imports. */
import {isAbsolute,resolve} from 'node:path';
import type {CodexEventBinding} from './fleet-codex-event-bridge.ts';
type TargetEpoch = Readonly<{project:string;peer:string;sessionId:string;startedAt:string}>;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, names: string[]) => Object.keys(v).length === names.length && names.every(k => Object.hasOwn(v, k));
const text = (v: unknown, max = 1024): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f]/.test(v);
const date = (v: unknown): v is string => typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v));
export const targetKey = (t: TargetEpoch) => JSON.stringify([t.project, t.peer, t.sessionId, t.startedAt]);
export function validInstructionTarget(v: unknown): v is TargetEpoch { return object(v) && keys(v, ['project', 'peer', 'sessionId', 'startedAt']) && text(v.project, 128) && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(v.project) && !v.project.includes('..') && typeof v.peer === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(v.peer) && typeof v.sessionId === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(v.sessionId) && date(v.startedAt); }
export const desktopQueuePin={daemon:'0.166.0',desktop:'0.166.0-alpha.5.1',addSchema:'60f25b7d3e3357c215bef9d2fe7047200f545e030dca9e00527ac0620cd0c88f',responseSchema:'c11b9772788427b19c9f9decf0765e2b41cbdead1aa9c3d39f42fdd70b339314'} as const;
export interface DesktopQueueApproval {
 binding:CodexEventBinding;target:TargetEpoch;authorityRevision:number;confirmedUntil:number;
 transportOrigin:'user_input';mappingEvidence:'externally_confirmed_loaded_desktop';
 daemonVersion:string;desktopVersion:string;addSchema:string;responseSchema:string;
 desktopAddSchema?:string;desktopResponseSchema?:string;
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
type DesktopQueueTupleEvidence=Pick<DesktopQueueApproval,'daemonVersion'|'desktopVersion'|'addSchema'|'responseSchema'|'desktopAddSchema'|'desktopResponseSchema'>;
export function matchesDesktopQueueTuple(a:DesktopQueueTupleEvidence){
 return desktopQueueTuples.some(p=>
  a.daemonVersion===p.daemon&&a.desktopVersion===p.desktop&&a.addSchema===p.addSchema&&a.responseSchema===p.responseSchema&&
  a.desktopAddSchema===('desktopAddSchema' in p?p.desktopAddSchema:undefined)&&
  a.desktopResponseSchema===('desktopResponseSchema' in p?p.desktopResponseSchema:undefined));
}

const legacyNotificationToolNames = ["fleet_discover", "fleet_binding_prepare", "fleet_binding_commit", "fleet_check_read", "fleet_observe", "fleet_overview", "fleet_resync", "fleet_watch", "fleet_instruction_prepare", "fleet_instruction_commit", "fleet_instruction_receipt", "fleet_answer_prepare", "fleet_answer_commit", "fleet_answer_receipt", "fleet_journal_upgrade_prepare", "fleet_journal_upgrade_commit", "fleet_diagnostics", "fleet_receipts", "fleet_legacy_history", "fleet_snapshot", "fleet_replay", "fleet_permissions", "fleet_permission_decide", "fleet_permission_receipt"];
const connectionTools=['fleet_connect_prepare','fleet_connect_commit','fleet_connection_status'];
export const notificationToolNames=[...legacyNotificationToolNames,...connectionTools];
/** Explicitly support both pinned legacy and connection catalogs; unknown/partial extensions fail closed. */
export function assessLoadedFleetCatalog(observation:unknown,allowLegacy=false){
 const d=observation as {identity?:unknown;nodeVersion?:unknown;protocolVersion?:unknown;tools?:unknown};
 const tools=Array.isArray(d?.tools)?d.tools:[];
 const names=tools.map(t=>t&&typeof t==='object'?(t as {name?:unknown}).name:undefined);
 const valid=tools.length<=128&&names.every(n=>typeof n==='string'&&/^[a-z_]{1,96}$/.test(n))&&new Set(names).size===names.length;
 const expected=allowLegacy&&names.length===legacyNotificationToolNames.length&&!connectionTools.some(n=>names.includes(n))?legacyNotificationToolNames:notificationToolNames;
 const missing=expected.filter(n=>!names.includes(n));
 const unexpected=names.filter(n=>typeof n!=='string'||!expected.some(name=>name===n)).map(()=> 'unexpected_tool_entry');
 const ready=valid&&d?.identity==='host_context_validated'&&d?.protocolVersion==='2025-06-18'&&missing.length===0&&unexpected.length===0;
 return {ready,loadedCount:tools.length,sourceCount:expected.length,missing,unexpected,action:ready?'none':'operator_reload_required_not_performed'};
}

const sameOwner=(a:unknown,b:unknown)=>validInstructionTarget(a)&&validInstructionTarget(b)&&targetKey(a)===targetKey(b);
export type NotificationConfig={optedIn:true;stateRoot:string;socketPath:string;approval:DesktopQueueApproval;loadedCatalog:unknown;messageBudgetMs:number};
/** Pure shape parsing for callers that already opened and bounded private bytes. No I/O or activation. */
export function parseNotificationConfiguration(raw:string):NotificationConfig{
 const value=JSON.parse(raw);if(!value||Object.keys(value).sort().join(',')!=='approval,loadedCatalog,messageBudgetMs,optedIn,socketPath,stateRoot')throw Error('notification_config_invalid');return value;
}
export function notificationPreview(c:NotificationConfig,owner:unknown){
 const catalog=assessLoadedFleetCatalog(c?.loadedCatalog,true),a=c?.approval,b=a?.binding;
 const approvalKeys=a?Object.keys(a).sort().join(','):'';
 const knownApprovalShape=approvalKeys==='addSchema,authorityRevision,binding,confirmedUntil,daemonVersion,desktopVersion,mappingEvidence,responseSchema,target,transportOrigin'||
  approvalKeys==='addSchema,authorityRevision,binding,confirmedUntil,daemonVersion,desktopAddSchema,desktopResponseSchema,desktopVersion,mappingEvidence,responseSchema,target,transportOrigin';
 const mapping=!!a&&!!b&&knownApprovalShape&&Object.keys(b).sort().join(',')==='epoch,fleetOwner,hostInstance,id,threadId'&&Object.values(b).every(v=>typeof v==='string'&&v.length>0&&v.length<=512&&/^[\x20-\x7e]+$/.test(v))&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(b.id)&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(b.threadId)&&validInstructionTarget(a.target)&&sameOwner(owner,a.target)&&b.fleetOwner===targetKey(a.target)&&Number.isSafeInteger(a.authorityRevision)&&a.authorityRevision>0&&Number.isSafeInteger(a.confirmedUntil)&&a.confirmedUntil>Date.now()&&a.transportOrigin==='user_input'&&a.mappingEvidence==='externally_confirmed_loaded_desktop'&&matchesDesktopQueueTuple(a);
 const paths=typeof c?.stateRoot==='string'&&isAbsolute(c.stateRoot)&&resolve(c.stateRoot)===c.stateRoot&&typeof c.socketPath==='string'&&isAbsolute(c.socketPath)&&c.socketPath.length<=100&&!/[:?#%\\\u0000-\u0020]/.test(c.socketPath);
 const ready=c?.optedIn===true&&mapping&&paths&&catalog.ready&&Number.isSafeInteger(c.messageBudgetMs)&&c.messageBudgetMs>10000&&c.messageBudgetMs<=60000;
 return {ready,catalog,mappingValid:mapping,activation:'not_performed',requiresExplicitUserEnable:true,startsDaemon:false,grantsApprove:false};
}
