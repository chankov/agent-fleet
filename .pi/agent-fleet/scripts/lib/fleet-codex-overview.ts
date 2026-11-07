// S5b: explicit bounded read aggregation, never selection, enrollment or broadcast.
import type { ObservationBridge } from './fleet-codex-observe.ts';
import { ReadonlyFleetError } from './fleet-codex-readonly.ts';
import { StoreError } from './fleet-codex-allowlist-store.ts';
type Selector={project:string;peer:string};
type Observation=Awaited<ReturnType<ObservationBridge['observe']>>;
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
export function parseOverviewTargets(value:unknown):Selector[] {
 const invalid=():never=>{throw new ReadonlyFleetError('INVALID_ARGUMENTS');};
 if(!object(value)||Object.keys(value).some(k=>k!=='targets')||!Object.hasOwn(value,'targets')||!Array.isArray(value.targets)||value.targets.length<1||value.targets.length>4)return invalid();
 const seen=new Set<string>();return Array.from(value.targets,item=>{
  if(!object(item)||Object.keys(item).some(k=>!['project','peer'].includes(k))||!Object.hasOwn(item,'project')||!Object.hasOwn(item,'peer')||typeof item.project!=='string'||item.project.length>1024||!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(item.project)||item.project.includes('..')
   ||typeof item.peer!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(item.peer))return invalid();
  const key=JSON.stringify([item.project,item.peer]);if(seen.has(key))return invalid();seen.add(key);return {project:item.project,peer:item.peer};
 });
}
function summarize(r:Observation) {
 const latest=r.transcript.entries.slice(-3).map(e=>({at:e.at,kind:e.kind,text:e.text.slice(0,256)}));
 return {target:r.target,permission:r.permission,observedAt:r.observedAt,scope:'overview_summary' as const,sourceTextIsData:true,
  partial:r.partial,detailsTool:'fleet_observe',summaryOnly:true,
  transcript:{status:r.transcript.status,partial:r.transcript.partial,reasons:r.transcript.reasons,observedEventCount:r.transcript.entries.length,latest},
  questionState:{status:r.questionState.status,partial:r.questionState.partial,reasons:r.questionState.reasons,pendingCount:r.questionState.pendingCount,
   questions:r.questionState.questions.slice(0,4).map(q=>({id:q.id,toolCallId:q.toolCallId,question:q.question.slice(0,256),allowMultiple:q.allowMultiple,allowFreeform:q.allowFreeform,allowComment:q.allowComment,detailsRequired:true}))},
  permissionState:r.permissionState,
  completion:'not_established' as const};
}
const safeCodes=new Set(['NOT_ALLOWED','STATE_MISSING','TARGET_CHANGED','TARGET_UNAVAILABLE','AMBIGUOUS_TARGET','REGISTRY_UNAVAILABLE','REGISTRY_PARTIAL','STORE_BUSY','STATE_CORRUPT','NEEDS_REBIND','STALE_HANDLE','UNSAFE_PATH','SOURCE_INVALID','REQUEST_CANCELLED','STATE_CHANGED','STATE_REPLACED','REBIND_REQUIRED','SUMMARY_LIMIT']);
function code(e:unknown){return (e instanceof ReadonlyFleetError||e instanceof StoreError)&&safeCodes.has(e.code)?e.code:'IO_ERROR';}
type Item={selectors:Selector;status:'observed';observation:ReturnType<typeof summarize>}|{selectors:Selector;status:'error';code:string;dataReleased:false};
export class OverviewBridge {
 readonly #observer:Pick<ObservationBridge,'observe'>;
 constructor(observer:Pick<ObservationBridge,'observe'>){this.#observer=observer;}
 async overview(context:unknown,args:unknown,signal?:AbortSignal) {
  const targets=parseOverviewTargets(args);const results:Item[]=new Array(targets.length);let next=0;
  const worker=async()=>{
   while(next<targets.length){const i=next++,selectors=targets[i];
    try{if(signal?.aborted)throw new ReadonlyFleetError('REQUEST_CANCELLED');
     const r=await this.#observer.observe(context,selectors);
     if(signal?.aborted)throw new ReadonlyFleetError('REQUEST_CANCELLED');
     const summary=summarize(r);
     // Four16KiB summaries stay below256KiB even after nested MCP JSON escaping.
     if(Buffer.byteLength(JSON.stringify(summary))>16384)throw new ReadonlyFleetError('SUMMARY_LIMIT');
     results[i]={selectors,status:'observed',observation:summary};
    }catch(e){results[i]={selectors,status:'error',code:code(e),dataReleased:false};}
   }
  };
  await Promise.all(Array.from({length:Math.min(2,targets.length)},worker));
  if(signal?.aborted)throw new ReadonlyFleetError('REQUEST_CANCELLED');
  return {scope:'multi_target_overview',nonAtomic:true,sourceTextIsData:true,completion:'not_established',
   partial:results.some(r=>r.status==='error'||r.observation.partial),results};
 }
}
