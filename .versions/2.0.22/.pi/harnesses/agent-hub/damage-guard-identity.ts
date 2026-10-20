import {createHash} from 'node:crypto';
export interface DamageIdentityRecord {schema:'damage-input/v1';taskId:string;revision:string;}
export function validDamageIdentity(row:unknown):row is DamageIdentityRecord {
 if(!row||typeof row!=='object'||Array.isArray(row))return false;const v=row as DamageIdentityRecord;
 return Object.keys(v).every(k=>['schema','taskId','revision'].includes(k))&&v.schema==='damage-input/v1'&&typeof v.taskId==='string'&&!!v.taskId&&v.taskId.length<=256&&typeof v.revision==='string'&&/^[a-f0-9]{64}$/.test(v.revision);
}
/** Independent from optional inference consumers. Store only hash, never raw user input. */
export function createDamageIdentity(persist:(row:DamageIdentityRecord)=>void){
 const revisions=new Map<string,string>();let latestRevision='';
 const store=(taskId:string,revision:string)=>{if(!taskId||taskId.length>256||!/^[a-f0-9]{64}$/.test(revision))throw Error('invalid_damage_task');const row:DamageIdentityRecord={schema:'damage-input/v1',taskId,revision};persist(row);revisions.set(taskId,revision);latestRevision=revision;};
 return {accept(taskId:string,input:string){store(taskId,createHash('sha256').update(input).digest('hex'));},bindTask(taskId:string){if(!revisions.has(taskId)&&latestRevision)store(taskId,latestRevision);return revisions.get(taskId)??'';},revision(taskId:string){return revisions.get(taskId)??'';},restore(entries:unknown[]){revisions.clear();latestRevision='';for(const item of entries){if(!item||typeof item!=='object'||Array.isArray(item))continue;const row=item as DamageIdentityRecord;if(!validDamageIdentity(row))continue;revisions.set(row.taskId,row.revision);latestRevision=row.revision;}}};
}
