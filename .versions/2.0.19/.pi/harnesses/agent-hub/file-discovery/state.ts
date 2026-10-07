export const DISCOVERY_COUNTER='agent-hub-file-discovery-counter/v1';
export interface DiscoveryCounter {schema:typeof DISCOVERY_COUNTER;sessionId:string;calls:number}
export function restoreDiscoveryCounter(entries:readonly unknown[],sessionId:string):DiscoveryCounter|null {
 let calls=0,found=false;
 for(const row of entries as any[]){
  if((row?.customType??row?.type)!==DISCOVERY_COUNTER)continue;
  const s=row.data;
  if(!s||s.schema!==DISCOVERY_COUNTER||s.sessionId!==sessionId||!Number.isSafeInteger(s.calls)||s.calls<0||s.calls>10000)return null;
  calls=Math.max(calls,s.calls);found=true;
 }
 if(!found&&entries.some((r:any)=>r?.type==='message'&&r.message?.role==='user'))return null;
 return {schema:DISCOVERY_COUNTER,sessionId,calls};
}
export function createDiscoveryBudget(sessionId:string,persist:(s:DiscoveryCounter)=>void,restored:DiscoveryCounter|null=restoreDiscoveryCounter([],sessionId)) {
 let state=restored;
 return {get calls(){return state?.calls??null;},reserve(max:number){
  if(!state)return 'counter_restore_ambiguous';
  if(state.calls>=max)return 'budget_exhausted';
  const next={...state,calls:state.calls+1};
  try{persist(next);state=next;return 'ok';}catch{return 'persistence_failed';}
 }};
}
