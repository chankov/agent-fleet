import {createHash} from 'node:crypto';
import type {PermissionRelay} from '../agent-hub/permission-relay.ts';
import type {PermissionOutcome} from '../agent-hub/permission-channel.ts';
import type {DamageAction} from '../agent-hub/damage-guard-state.ts';
export function permissionAuditOutcome(outcome:PermissionOutcome){
 const {reason,...metadata}=outcome as PermissionOutcome&{reason?:string};
 return {...metadata,...(reason?{reasonDigest:createHash('sha256').update(reason).digest('hex'),reasonBytes:Buffer.byteLength(reason)}:{})};
}
const relayKey=Symbol.for('fleet.permission-relays.v1');
const relays:WeakMap<object,PermissionRelay>=(globalThis as any)[relayKey]??((globalThis as any)[relayKey]=new WeakMap());
/** Tools whose exact action can be presented through, and decided by, the permission relay. */
export const RELAY_OPERATIONS=['bash','write','edit','read','grep','find','ls','filesystem','submit_result'] as const;
export type DamageOperation=typeof RELAY_OPERATIONS[number];
export const isRelayOperation=(tool:unknown):tool is DamageOperation=>typeof tool==='string'&&(RELAY_OPERATIONS as readonly string[]).includes(tool);
export type PermissionFailure = 'expired'|'cancelled'|'stale'|'unavailable'|'audit_failed';
/** Shared baseline/triage one-winner path. Local UI produces values, never side effects
 * before winner selection. Machine answers never enter identical-dialog/semantic memory. */
/** `onFailure` receives the relay's refusal reason when no request could be opened
 * (`unavailable`); the local dialog has not been shown in that case. */
export async function raceExactPermission<T>(relay:PermissionRelay,action:DamageAction,input:unknown,current:()=>boolean,expiresAt:number,local:(signal:AbortSignal)=>Promise<{decision:'allow_once'|'deny';value:T}|null>,audit:(record:unknown)=>void,onFailure?:(reason:PermissionFailure,detail?:string)=>void){
 const fail=(reason:PermissionFailure,detail?:string)=>{try{onFailure?.(reason,detail);}catch{}return null;};
 let refusal:string|undefined;
 const request=relay.open(action,input,current,expiresAt,reason=>{refusal=reason;});if(!request)return fail('unavailable',refusal);
 const controller=new AbortController();let localValue:T|undefined;
 void local(controller.signal).then(answer=>{if(answer){if(request.human(answer.decision,'local-ui'))localValue=answer.value;}else request.cancel();},()=>request.cancel());
 const outcome=await request.result;controller.abort();
 if(outcome.status!=='decided')return fail(outcome.status);
 try{audit({schema:'permission-surface-decision/v1',permissionId:request.id,actionDigest:request.actionDigest,taskId:action.taskId,inputRevision:action.inputRevision,...permissionAuditOutcome(outcome)});}catch{request.applied(false);return fail('audit_failed');}
 let used=false;
 return {decision:outcome.decision,source:outcome.source,localValue:outcome.source==='local_human'?localValue:undefined,consume(){
  if(used)return false;used=true;let valid=false;try{valid=outcome.decision==='allow_once'&&request.valid()&&current();}catch{}request.applied(valid);return valid;
 }};
}

export function registerPermissionRelay(key:object|undefined|null,relay:PermissionRelay){
 if(!key||typeof key!=='object')return ()=>{};
 relays.set(key,relay);const events=key as {emit?:unknown;on?:(channel:string,listener:(data:any)=>void)=>()=>void};
 const off=typeof events.emit==='function'?events.on?.('fleet:permission-relay:resolve',data=>{if(typeof data?.reply==='function')data.reply(relay);}):undefined;
 return ()=>{off?.();if(relays.get(key)===relay)relays.delete(key);};
}
export function permissionRelayFor(key:object|undefined|null){
 if(!key||typeof key!=='object')return undefined;
 const direct=relays.get(key);if(direct)return direct;
 // Pi extensions have different facades over the same in-process event bus.
 const found=new Set<PermissionRelay>();(key as {emit?:(channel:string,data:unknown)=>void}).emit?.('fleet:permission-relay:resolve',{reply:(relay:PermissionRelay)=>found.add(relay)});
 return found.size===1?[...found][0]:undefined;
}
