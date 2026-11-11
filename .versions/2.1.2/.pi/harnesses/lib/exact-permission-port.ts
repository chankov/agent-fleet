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
/** Shared baseline/triage one-winner path. Local UI produces values, never side effects
 * before winner selection. Machine answers never enter identical-dialog/semantic memory. */
export async function raceExactPermission<T>(relay:PermissionRelay,action:DamageAction,input:unknown,current:()=>boolean,expiresAt:number,local:(signal:AbortSignal)=>Promise<{decision:'allow_once'|'deny';value:T}|null>,audit:(record:unknown)=>void){
 const request=relay.open(action,input,current,expiresAt);if(!request)return null;
 const controller=new AbortController();let localValue:T|undefined;
 void local(controller.signal).then(answer=>{if(answer){if(request.human(answer.decision,'local-ui'))localValue=answer.value;}else request.cancel();},()=>request.cancel());
 const outcome=await request.result;controller.abort();
 if(outcome.status!=='decided')return null;
 try{audit({schema:'permission-surface-decision/v1',permissionId:request.id,actionDigest:request.actionDigest,taskId:action.taskId,inputRevision:action.inputRevision,...permissionAuditOutcome(outcome)});}catch{request.applied(false);return null;}
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
