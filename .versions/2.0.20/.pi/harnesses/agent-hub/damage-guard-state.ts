import {createHash} from 'node:crypto';
import {isAbsolute} from 'node:path';
export interface DamageAction {taskId:string;inputRevision:string;operation:'bash'|'write'|'edit';target:string;cwd:string;actionId:string;owner:string;attempt:string;legacyTargets?:readonly string[];}
export interface DamageDecisionRecord {schema:'damage-denial/v1';taskId:string;inputRevision:string;operation:'bash'|'write'|'edit';target:string;cwd:string;decision:'deny'|'allow'|'hold'|'consumed'|'recovery';}
export function damageDenyKey(action:Pick<DamageAction,'taskId'|'inputRevision'|'operation'|'target'|'cwd'>){return createHash('sha256').update(JSON.stringify([action.taskId,action.inputRevision,action.operation,action.target,action.cwd])).digest('hex');}
export function validDamageDecision(row:unknown):row is DamageDecisionRecord{
 if(!row||typeof row!=='object'||Array.isArray(row))return false;const v=row as DamageDecisionRecord;
 return Object.keys(v).every(k=>['schema','taskId','inputRevision','operation','target','cwd','decision'].includes(k))&&v.schema==='damage-denial/v1'&&typeof v.taskId==='string'&&!!v.taskId&&v.taskId.length<=256&&typeof v.inputRevision==='string'&&!!v.inputRevision&&v.inputRevision.length<=256&&['bash','write','edit'].includes(v.operation)&&/^[a-f0-9]{64}$/.test(v.target)&&typeof v.cwd==='string'&&isAbsolute(v.cwd)&&['deny','allow','hold','consumed','recovery'].includes(v.decision);
}
/** Restore denials and unresolved fences, never grants. Allow records are human intent, not reusable authority. */
export function createDamageState(persist:(row:DamageDecisionRecord)=>void){
 const denied=new Set<string>(),held=new Set<string>(),durableHeld=new Set<string>(),recovered=new Set<string>(),durableRecovery=new Set<string>(),epochs=new Map<string,number>();
 const keys=(action:DamageAction)=>[...new Set([action.target,...(action.legacyTargets??[])])].map(target=>damageDenyKey({...action,target}));
 const apply=(row:DamageDecisionRecord)=>{
  const key=damageDenyKey(row);
  if(row.decision==='deny'){denied.add(key);epochs.set(key,(epochs.get(key)??0)+1);}
  if(row.decision==='hold')held.add(key);
  if(row.decision==='recovery')recovered.add(key);
  // Neither a receipt nor an Allow once is reusable authority. Known severe fences
  // remain across off/outage; each subsequent matching attempt needs a fresh grant.
  // An explicit denial additionally requires a human-armed new approval dialog.
 };
 const record=(action:DamageAction,decision:DamageDecisionRecord['decision'])=>{
  const row:DamageDecisionRecord={schema:'damage-denial/v1',taskId:action.taskId,inputRevision:action.inputRevision,operation:action.operation,target:action.target,cwd:action.cwd,decision};if(!validDamageDecision(row))throw Error('invalid_damage_action');
  if(decision==='deny'||decision==='hold'){apply(row);persist(row);}else{persist(row);apply(row);}if(decision==='hold')durableHeld.add(damageDenyKey(row));if(decision==='recovery')durableRecovery.add(damageDenyKey(row));
 };
 return {
  denied:(action:DamageAction)=>keys(action).some(key=>denied.has(key)),
  held:(action:DamageAction)=>keys(action).some(key=>held.has(key)),
  needsArm:(action:DamageAction)=>keys(action).some(key=>denied.has(key)||recovered.has(key)),
  denialEpoch:(action:DamageAction)=>keys(action).reduce((sum,key)=>sum+(epochs.get(key)??0),0),
  deny:(action:DamageAction)=>record(action,'deny'),
  hold:(action:DamageAction)=>{if(keys(action).some(key=>recovered.has(key))&&!durableRecovery.has(damageDenyKey(action)))record(action,'recovery');if(!durableHeld.has(damageDenyKey(action)))record(action,'hold');},
  allow:(action:DamageAction)=>record(action,'allow'),
  consumeAllow:(action:DamageAction)=>record(action,'consumed'),
  restore(entries:unknown[]){
   denied.clear();held.clear();durableHeld.clear();recovered.clear();durableRecovery.clear();epochs.clear();const latest=new Map<string,DamageDecisionRecord>();
   for(const row of entries)if(validDamageDecision(row)){const key=damageDenyKey(row);apply(row);latest.set(key,row);if(row.decision==='hold')durableHeld.add(key);if(row.decision==='recovery')durableRecovery.add(key);}
   for(const [key,row] of latest)if(row.decision==='hold'||row.decision==='allow')recovered.add(key);
  },
  clear(){denied.clear();held.clear();durableHeld.clear();recovered.clear();durableRecovery.clear();epochs.clear();},
 };
}
