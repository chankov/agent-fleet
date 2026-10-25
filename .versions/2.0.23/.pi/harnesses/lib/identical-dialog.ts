import {createHash} from 'node:crypto';
import {processShared} from './process-shared.ts';

export type DialogDecision='allow'|'deny';
export type DialogOutcome=DialogDecision|'cancel';
interface DialogState { remembered:Map<string,DialogDecision>; inflight:Map<string,Promise<DialogOutcome>>; generation:number; }
const state=processShared<DialogState>('agent-fleet.identical-dialog.v1',()=>({remembered:new Map(),inflight:new Map(),generation:0}));
const {remembered,inflight}=state;

/** Stable identity of the human-visible dialog. Callers must omit volatile ids. */
export function identicalDialogKey(parts:readonly unknown[]):string {
 return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}
export function resetIdenticalDialogs():void {
 state.generation++;remembered.clear();inflight.clear();
}
/** A completed identical dialog is not shown again. Cancellation is not a decision. Fresh dialogs ignore memory but still coalesce. */
export function decideIdenticalDialog(key:string,ask:()=>Promise<DialogOutcome>,options?:{fresh?:boolean}):Promise<DialogOutcome> {
 if(!options?.fresh){const prior=remembered.get(key);if(prior)return Promise.resolve(prior);}
 const flight=options?.fresh?`${key}:fresh`:key,existing=inflight.get(flight);if(existing)return existing;
 const generation=state.generation;
 const pending=(async()=>{const decision=await ask();if(generation!==state.generation)return 'cancel' as const;if(!options?.fresh&&decision!=='cancel')remembered.set(key,decision);return decision;})();
 inflight.set(flight,pending);
 const cleanup=()=>{if(inflight.get(flight)===pending)inflight.delete(flight);};
 void pending.then(cleanup,cleanup);
 return pending;
}
