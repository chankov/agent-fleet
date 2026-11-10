import type { System1Question } from "../lib/system1/contracts.ts";
export const CONTEXT_COMPACTION_QUESTION_VERSION="context-compaction/questions/v1";
export const CONTEXT_COMPACTION_QUESTIONS: readonly System1Question[] = Object.freeze<System1Question[]>([
 {id:"boundary",type:"choice",instructions:"Is the completed turn a safe summarization boundary? Advice only; runtime unsafe flags override.",options:{safe:"A completed step; summary can preserve pending work",unsafe:"An unfinished operation needs detailed continuity",unknown:"Insufficient evidence"}},
 {id:"retention",type:"choice",instructions:"Which summary detail should Pi emphasize? Never delete transcript or change task state.",options:{standard:"Standard goal, decisions, evidence and next step",active_step:"Preserve the active step and pending operations in detail",decisions:"Preserve requirements, user decisions and evidence in detail",unknown:"Insufficient evidence"}},
]);
export const RETENTION_INSTRUCTIONS: Record<string,string>={
 standard:"Preserve the goal, requirements, decisions, evidence and next permitted step.",
 active_step:"Preserve the interrupted active step, its inputs/results and pending child identities in detail. Do not repeat effects or redispatch children.",
 decisions:"Preserve user requirements, approvals/refusals and supporting evidence in detail. Compaction grants no authority and does not reset budgets.",
};
export const CONTEXT_ASSESSMENT_REASONS = Object.freeze([
 "consumer_off","not_approved","service_unavailable","runtime_unsupported","recovery_pending","cancelled","unsafe_boundary","usage_unknown","below_early_threshold","no_compactable_history","insufficient_headroom","growth_not_rearmed","source_denied","state_too_large","unchanged_snapshot","evaluation_failed","snapshot_changed","timeout","network","auth","rate_limit","overloaded","invalid_response","invalid_request","invalid_config","migration_required","disabled","missing_config","missing_key","unsupported","low_confidence","boundary_not_safe","retention_unknown","safe_boundary","safe_boundary_default_retention",
]);
/** Local lifecycle diagnostics are independently allowlisted; never copy state,
 * task, instructions, provider extras or free-form failure messages. */
export function contextAssessmentMetadata(result:any,measurement:any={}) {
 const number=(v:unknown)=>typeof v==="number" && Number.isFinite(v) && v>=0?v:null;
 const tokens=number(measurement.tokens),window=number(measurement.window);
 return {version:1,owner:"runtime",status:["off","ineligible","denied","oversized","duplicate","stale","unavailable","unsupported","cancelled","skipped","invalid","no_advice","accepted"].includes(result?.status)?result.status:"unavailable",reason:CONTEXT_ASSESSMENT_REASONS.includes(result?.reason)?result.reason:"evaluation_failed",inferenceRequested:result?.inferenceRequested===true,boundaryConfidence:typeof result?.boundaryConfidence==="number" && result.boundaryConfidence<=1?number(result.boundaryConfidence):null,retentionConfidence:typeof result?.retentionConfidence==="number" && result.retentionConfidence<=1?number(result.retentionConfidence):null,tokens,contextWindow:window,percent:tokens!==null && window!==null && window>0?tokens/window*100:null,responseReservedTokens:number(measurement.responseTokens),historyTokens:number(measurement.historyTokens),keepRecentTokens:number(measurement.keepRecentTokens),turn:number(measurement.turn)};
}
/** Dedicated projection: never call generic redaction on a D7 body. */
export function contextRequestMetadata(request: any) {
 return {version:1,questionVersion:CONTEXT_COMPACTION_QUESTION_VERSION,questionIds:CONTEXT_COMPACTION_QUESTIONS.map(q=>q.id),questionCount:Array.isArray(request.questions)?request.questions.length:0,stateBytes:Buffer.byteLength(JSON.stringify(request.state ?? null)),requestBytes:Buffer.byteLength(JSON.stringify({state:request.state,questions:request.questions}))};
}
export function contextResponseMetadata(result: any) {
 const status=["ok","skipped","unavailable","unsupported","cancelled"].includes(result?.status)?result.status:"unavailable";
 const decisions: Record<string,string>={};
 if(status==="ok" && Array.isArray(result?.evaluation?.answers)) for(const a of result.evaluation.answers) {
  const q=CONTEXT_COMPACTION_QUESTIONS.find(q=>q.id===a?.questionId);
  if(q?.type==="choice" && a.type==="choice" && typeof a.value==="string" && Object.hasOwn(q.options,a.value)) decisions[q.id]=a.value;
 }
 return {version:1,status,decisions};
}
