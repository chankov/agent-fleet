/** Import-free exact Fleet epoch identity for native transport and AF consumers.
 * Keep these historical predicates unchanged; no schema/activation dependencies. */
export type TargetEpoch=Readonly<{project:string;peer:string;sessionId:string;startedAt:string}>;
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const keys=(v:Record<string,unknown>,names:string[])=>Object.keys(v).length===names.length&&names.every(k=>Object.hasOwn(v,k));
const text=(v:unknown,max=1024):v is string=>typeof v==='string'&&v.length>0&&v.length<=max&&!/[\u0000-\u001f]/.test(v);
const date=(v:unknown):v is string=>typeof v==='string'&&v.length<=40&&Number.isFinite(Date.parse(v));
export const targetKey=(t:TargetEpoch)=>JSON.stringify([t.project,t.peer,t.sessionId,t.startedAt]);
export function validInstructionTarget(v:unknown):v is TargetEpoch{return object(v)&&keys(v,['project','peer','sessionId','startedAt'])&&text(v.project,128)&&/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(v.project)&&!v.project.includes('..')&&typeof v.peer==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(v.peer)&&typeof v.sessionId==='string'&&/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(v.sessionId)&&date(v.startedAt);}
