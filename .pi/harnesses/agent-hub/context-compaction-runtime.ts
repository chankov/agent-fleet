import { COMPACTION_MIN_PERCENT, COMPACTION_EARLY_PERCENT, COMPACTION_TARGET_PERCENT } from "../lib/context-compaction-policy.js";
import {createHash} from "node:crypto";
import type {System1Service, System1Result} from "../lib/system1/contracts.ts";
import {CONTEXT_COMPACTION_QUESTIONS,CONTEXT_COMPACTION_QUESTION_VERSION,RETENTION_INSTRUCTIONS} from "./context-compaction.ts";
import {containsCommunicationSecret} from "./system1-communication-store.ts";
export const CONTEXT_COMPACTION_MIN_CONFIDENCE=0.80; // Explicit operator decision, 2026-10-09.
/** Pi owns headroom policy. A model's theoretical maximum output is only a cap,
 * not a reservation that could make every >=60% opportunity impossible. */
export function compactionResponseReserve(settings:{reserveTokens:number},modelMaxTokens?:number):number {
 const reserve=Number.isFinite(settings.reserveTokens) && settings.reserveTokens>0?settings.reserveTokens:Infinity;
 return typeof modelMaxTokens==="number" && Number.isFinite(modelMaxTokens) && modelMaxTokens>0 ? Math.min(reserve,modelMaxTokens) : reserve;
}
export interface CompactionOpportunity {
 identity:string; task:string; revision:number; turn:number; tokens:number|null; window:number|null;
 historyTokens:number; keepRecentTokens:number; responseTokens:number; unsafe:boolean;
}
export interface CompactionAssessment {
 compact:boolean;instructions?:string;status:string;reason:string;inferenceRequested:boolean;
 boundaryConfidence?:number|null;retentionConfidence?:number|null;
}
export class ContextCompactionRuntime {
 private seen=new Set<string>();
 private compactedTokens:number|null=null;
 private generation=0;
 private awaitingPostCompactionUsage=false;
 fence() {this.generation++;this.seen.clear();this.compactedTokens=null;this.awaitingPostCompactionUsage=false;}
 compacted(tokens:number|null){this.compactedTokens=tokens;this.awaitingPostCompactionUsage=tokens===null;}
 async assess(input:CompactionOpportunity, service:System1Service|undefined, config:any):Promise<CompactionAssessment> {
  let confidence:Pick<CompactionAssessment,"boundaryConfidence"|"retentionConfidence">={};
  const no=(status:string,reason:string,inferenceRequested=false):CompactionAssessment=>({compact:false,status,reason,inferenceRequested,...confidence});
  if(!config || config.mode!=="automatic")return no("off","consumer_off");
  if(!config.remoteContextApproved)return no("off","not_approved");
  if(!service)return no("off","service_unavailable");
  if(input.unsafe)return no("ineligible","unsafe_boundary");
  if(input.tokens===null || input.window===null || !Number.isFinite(input.tokens) || !Number.isFinite(input.window) || input.tokens<0 || input.window<=0)return no("ineligible","usage_unknown");
  if(this.awaitingPostCompactionUsage){this.compactedTokens=input.tokens;this.awaitingPostCompactionUsage=false;return no("ineligible","growth_not_rearmed");}
  if(input.tokens/input.window*100<Math.max(COMPACTION_MIN_PERCENT,Math.min(COMPACTION_TARGET_PERCENT,config.earlyOpportunityPercent ?? COMPACTION_EARLY_PERCENT)))return no("ineligible","below_early_threshold");
  if(input.historyTokens<=input.keepRecentTokens)return no("ineligible","no_compactable_history");
  if(!Number.isFinite(input.responseTokens) || input.responseTokens<0 || input.window-input.tokens<input.responseTokens)return no("ineligible","insufficient_headroom");
  if(this.compactedTokens!==null && input.tokens<=this.compactedTokens+input.keepRecentTokens)return no("ineligible","growth_not_rearmed");
  if(containsCommunicationSecret(input.task))return no("denied","source_denied");
  const state={schema:"context-compaction/state/v1",owner:"hub",identity:createHash("sha256").update(input.identity).digest("hex"),task:input.task,revision:input.revision,turn:input.turn,tokens:input.tokens,contextWindow:input.window,compactableHistoryTokens:input.historyTokens-input.keepRecentTokens,unsafe:false};
  const raw=JSON.stringify(state);
  if(Buffer.byteLength(raw)>config.limits.maxStateBytes)return no("oversized","state_too_large");
  const hash=createHash("sha256").update(JSON.stringify({...state,turn:0})).digest("hex");if(this.seen.has(hash))return no("duplicate","unchanged_snapshot");
  this.seen.add(hash);if(this.seen.size>128)this.seen.delete(this.seen.values().next().value!);
  const generation=this.generation;
  const abort=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  let result:System1Result;
  try {
   // Jev's choice decoder already supplies provider confidence; it does not
   // advertise the separate optional provider_confidence capability. Validate
   // provenance/threshold below instead of rejecting the provider before I/O.
   result=await Promise.race([service.evaluate({state,questions:CONTEXT_COMPACTION_QUESTIONS,questionSetVersion:CONTEXT_COMPACTION_QUESTION_VERSION,timeoutMs:config.limits.timeoutMs,signal:abort.signal,requiredCapabilities:["choice"]}),new Promise<System1Result>(resolve=>{timer=setTimeout(()=>{abort.abort();resolve({status:"unavailable",reason:"timeout"});},config.limits.timeoutMs);})]);
  }catch{return no("unavailable","evaluation_failed",true);}finally{if(timer)clearTimeout(timer);}
  if(generation!==this.generation)return no("stale","snapshot_changed",true);
  if(result.status!=="ok")return no(result.status,"reason" in result?result.reason:result.status,true);
  const answers=result.evaluation?.answers;
  if(!Array.isArray(answers) || result.evaluation?.metadata?.questionSetVersion!==CONTEXT_COMPACTION_QUESTION_VERSION || answers.length!==2 || new Set(answers.map(a=>a.questionId)).size!==2 || !answers.every(a=>["boundary","retention"].includes(a.questionId) && a.type==="choice"))return no("invalid","invalid_response",true);
  const confidenceFor=(id:string)=>{const a=answers.find(a=>a.questionId===id);const c=a?.uncertainty?.confidence;return a?.uncertainty?.provenance==="provider" && typeof c==="number" && Number.isFinite(c) && c>=0 && c<=1?c:null;};
  confidence={boundaryConfidence:confidenceFor("boundary"),retentionConfidence:confidenceFor("retention")};
  const validated=(id:string)=>{const a=answers.find(a=>a.questionId===id);return a?.type==="choice" && a.uncertainty?.provenance==="provider" && typeof a.uncertainty.confidence==="number" && a.uncertainty.confidence>=CONTEXT_COMPACTION_MIN_CONFIDENCE && a.uncertainty.confidence<=1 ? a.value : null;};
  const boundary=validated("boundary"), retention=validated("retention");
  if(boundary===null)return no("no_advice","low_confidence",true);
  if(boundary!=="safe")return no("no_advice","boundary_not_safe",true);
  if(retention===null || !Object.hasOwn(RETENTION_INSTRUCTIONS,retention))return {compact:true,instructions:RETENTION_INSTRUCTIONS.standard,status:"accepted",reason:"safe_boundary_default_retention",inferenceRequested:true,...confidence};
  return {compact:true,instructions:RETENTION_INSTRUCTIONS[retention],status:"accepted",reason:"safe_boundary",inferenceRequested:true,...confidence};
 }
}
