import {processShared} from './process-shared.ts';
export interface DamageCallEvent {toolName:string;toolCallId:string;input:unknown;}
export interface DamageCallContext {cwd:string;revalidateBaseline?():boolean;}
export interface DamageGuardPort {call(event:DamageCallEvent,ctx:DamageCallContext):Promise<{block:boolean;reason?:string}>;}
// The Hub registers in its module instance while Damage-Control assesses in another.
const state=processShared<{port?:DamageGuardPort;spawned?:{assignment:unknown}}>('agent-fleet.damage-guard-port.v1',()=>({}));
/** Process-owned adapter only. Missing registration preserves standalone baseline, not a second provider. */
export function registerDamageGuard(next:DamageGuardPort){state.port=next;return ()=>{if(state.port===next)state.port=undefined;};}
export function assessDamageCall(event:DamageCallEvent,ctx:DamageCallContext){return state.port?state.port.call(event,ctx):Promise.resolve({block:false});}
export const DAMAGE_ASSIGNMENT_ENV='AF_D6_ASSIGNMENT';
const parsed=(raw:string):unknown=>{try{return JSON.parse(raw);}catch{return null;}};
/** Pi calls an extension factory without dependencies, so a native child's fresh assignment
 * arrives through the trusted spawn environment. Damage-Control takes it before any tool runs:
 * Bash subprocesses (tests, nested pi) never inherit the capability. Malformed transport stays
 * assigned, so the child fails closed instead of silently losing D6. */
export function takeSpawnedDamageAssignment():unknown {
 const raw=process.env[DAMAGE_ASSIGNMENT_ENV];
 if(raw!==undefined){delete process.env[DAMAGE_ASSIGNMENT_ENV];state.spawned={assignment:parsed(raw)};}
 return state.spawned?.assignment;
}
/** Descendant registration: a present transport wins, otherwise the copy Damage-Control took. */
export function spawnedDamageAssignment():unknown {
 const raw=process.env[DAMAGE_ASSIGNMENT_ENV];
 return raw!==undefined?parsed(raw):state.spawned?.assignment;
}
