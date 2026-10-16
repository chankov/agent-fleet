import {randomUUID} from 'node:crypto';
import {realpathSync} from 'node:fs';
import {validDamageAssignment, type DamageAssignment} from './damage-guard-broker.ts';
import {DAMAGE_ASSIGNMENT_ENV} from '../lib/damage-guard-port.ts';

/** Trusted parent factory. Each open owns partial-registration cleanup on failure. */
export interface DamageSpawnRegistration {
 tools: readonly string[];
 validate(): boolean;
 open(physical: {tools: readonly string[];cwd: string}): DamagePhysicalLease | Promise<DamagePhysicalLease>;
}
export interface DamagePhysicalLease {
 assignment: DamageAssignment;
 identity: DamagePhysicalIdentity;
 validate(): boolean;
 /** Idempotent; revokes the owner and every descendant capability. */
 revoke(): void;
}
export {DAMAGE_ASSIGNMENT_ENV};
/** Transport only; the child reader is takeSpawnedDamageAssignment, not inference/admission authority. */
export function damageAssignmentEnv(assignment: DamageAssignment): Record<string,string> {
 if (!validDamageAssignment(assignment)) throw Error('damage_physical_assignment_invalid');
 return {[DAMAGE_ASSIGNMENT_ENV]: JSON.stringify(assignment)};
}

export interface DamageOwnerAuthority {session:string;taskToken:string;taskId:string;inputRevision:string;}
export interface DamageOwnerSpec {owner:string;tools:readonly string[];cwd:string;}
export type DamagePhysicalIdentity=Readonly<{owner:string;attempt:string;tools:readonly string[];cwd:string;signal:AbortSignal}>;
export type DamageOwnerIdentity=Readonly<DamageOwnerAuthority & DamagePhysicalIdentity>;
/** In-process parent capabilities, not launch permission or serializable credentials. */
export function createDamageOwners(deps:{current():DamageOwnerAuthority;admit(identity:DamageOwnerIdentity):boolean}){
 const records=new Map<DamageOwnerIdentity,{controller:AbortController;parent?:DamageOwnerIdentity}>();let disposed=false;
 const valid=(identity:DamageOwnerIdentity):boolean=>{
  const row=records.get(identity);if(disposed||!row||identity.signal.aborted)return false;
  try {
   const current=deps.current();
   if(['session','taskToken','taskId','inputRevision'].some(k=>identity[k as keyof DamageOwnerAuthority]!==current[k as keyof DamageOwnerAuthority])||row.parent&&!valid(row.parent)||deps.admit(identity)!==true){revoke(identity);return false;}
   return true;
  } catch {revoke(identity);return false;}
 };
 function revoke(identity:DamageOwnerIdentity){const row=records.get(identity);if(!row||row.controller.signal.aborted)return;row.controller.abort();for(const [child,entry] of records)if(entry.parent===identity)revoke(child);}
 return {
  register(spec:DamageOwnerSpec,parent?:DamageOwnerIdentity):DamageOwnerIdentity{
   const current=deps.current(),cwd=realpathSync(spec.cwd);
   if(disposed||!spec.owner||spec.owner==='hub'||!spec.tools.length||spec.tools.some(t=>!['bash','write','edit','read','filesystem'].includes(t))||Object.values(current).some(v=>typeof v!=='string'||!v))throw Error('damage_owner_authority_unavailable');
   if(parent&&(!valid(parent)||parent.cwd!==cwd||spec.tools.some(t=>!parent.tools.includes(t))))throw Error('damage_owner_scope_widening');
   const controller=new AbortController(),identity=Object.freeze({...current,owner:`${spec.owner}:${randomUUID()}`,attempt:randomUUID(),tools:Object.freeze([...new Set(spec.tools)]),cwd,signal:controller.signal});
   records.set(identity,{controller,parent});if(!valid(identity)){revoke(identity);records.delete(identity);throw Error('damage_owner_admission_denied');}return identity;
  },
  validate(identity:DamageOwnerIdentity,tool:string,cwd:string){try{return valid(identity)&&identity.tools.includes(tool)&&identity.cwd===realpathSync(cwd)?identity:undefined;}catch{return undefined;}},
  revoke,invalidate(){for(const identity of records.keys())if(!valid(identity))revoke(identity);},
  dispose(){disposed=true;for(const identity of records.keys())revoke(identity);records.clear();},
 };
}
