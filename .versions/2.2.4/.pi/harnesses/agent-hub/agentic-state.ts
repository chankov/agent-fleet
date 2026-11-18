import { AGENTIC_LIMITS } from '../lib/system1/config-agentic.js';
export const AGENTIC_COUNTER = 'agent-hub-agentic-counter/v1';
export interface AgenticCounter { schema: typeof AGENTIC_COUNTER; sessionId: string; calls: number; }
export function restoreAgenticCounter(entries: readonly unknown[], sessionId: string): AgenticCounter | null {
 let calls=0, found=false;
 for(const row of entries as any[]) {
  if ((row?.customType??row?.type)!==AGENTIC_COUNTER) continue;
  const s=row.data;
  if (!s || s.schema!==AGENTIC_COUNTER || s.sessionId!==sessionId || !Number.isSafeInteger(s.calls) || s.calls<0 || s.calls>AGENTIC_LIMITS.maxCallsPerSession) return null;
  calls=Math.max(calls,s.calls);found=true;
 }
 if(!found && entries.some((r:any)=>r?.type==='message'&&r.message?.role==='user')) return null;
 return {schema:AGENTIC_COUNTER,sessionId,calls};
}
export function createAgenticBudget(sessionId: string, persist: (s:AgenticCounter)=>void, restored:AgenticCounter|null=restoreAgenticCounter([],sessionId)) {
 let snapshot=restored;
 return { get calls(){return snapshot?.calls??null;}, reserve(max:number): 'ok'|'budget_exhausted'|'counter_restore_ambiguous'|'persistence_failed' {
  if(!snapshot)return 'counter_restore_ambiguous';
  if(snapshot.calls>=max)return 'budget_exhausted';
  const next={...snapshot,calls:snapshot.calls+1};
  try{persist(next);snapshot=next;return 'ok';}catch{return 'persistence_failed';}
 }};
}
