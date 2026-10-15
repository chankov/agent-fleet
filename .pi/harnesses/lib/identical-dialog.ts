import {createHash} from 'node:crypto';

export type DialogDecision='allow'|'deny';
export type DialogOutcome=DialogDecision|'cancel';
const remembered=new Map<string,DialogDecision>(),inflight=new Map<string,Promise<DialogOutcome>>();

/** Stable identity of the human-visible dialog. Callers must omit volatile ids. */
export function identicalDialogKey(parts:readonly unknown[]):string {
 return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}
export function resetIdenticalDialogs():void {
 remembered.clear();inflight.clear();
}
/** A completed identical dialog is not shown again. Cancellation is not a decision. Fresh dialogs ignore memory but still coalesce. */
export function decideIdenticalDialog(key:string,ask:()=>Promise<DialogOutcome>,options?:{fresh?:boolean}):Promise<DialogOutcome> {
 if(!options?.fresh){const prior=remembered.get(key);if(prior)return Promise.resolve(prior);}
 const flight=options?.fresh?`${key}:fresh`:key,existing=inflight.get(flight);if(existing)return existing;
 const pending=(async()=>{const decision=await ask();if(!options?.fresh&&decision!=='cancel')remembered.set(key,decision);return decision;})();
 inflight.set(flight,pending);
 void pending.finally(()=>{if(inflight.get(flight)===pending)inflight.delete(flight);});
 return pending;
}
