import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { worktreeRevision } from "./scope-gate.js";
import type { ProcessObligationState } from "./process-obligations.ts";

const reviewers=new Set(["code-reviewer","plan-reviewer","security-auditor"]);
const digest=(value:string|Uint8Array)=>createHash("sha256").update(value).digest("hex");
export interface ReviewInput { taskId:string; agent:string; scope:string[]; scopeRevision:string; contractHash:string; }
export interface ReviewEvidence extends ReviewInput { evidenceRef:string; evidenceHash:string; baselineRef?:string; baselineHash?:string; }
export function normalizeReviewEvidence(value:unknown):ReviewEvidence[] {
 if(!Array.isArray(value))return [];
 const valid=new Map<string,ReviewEvidence>();
 for(const row of value){
  if(!row||!reviewers.has(row.agent)||typeof row.taskId!=="string"||!row.taskId||!Array.isArray(row.scope)||!row.scope.length||!row.scope.every((s:unknown)=>typeof s==="string"&&s.length>0)||typeof row.evidenceRef!=="string"||!row.evidenceRef||![row.scopeRevision,row.contractHash,row.evidenceHash].every(v=>typeof v==="string"&&/^[a-f0-9]{64}$/.test(v)))continue;
  valid.set(row.agent,{taskId:row.taskId,agent:row.agent,scope:[...row.scope],scopeRevision:row.scopeRevision,contractHash:row.contractHash,evidenceRef:row.evidenceRef,evidenceHash:row.evidenceHash,...(typeof row.baselineRef==="string" && /^[a-f0-9]{64}$/.test(row.baselineHash) ? {baselineRef:row.baselineRef,baselineHash:row.baselineHash} : {})});
 }
 return [...valid.values()];
}

/** No model judgment: match complete declared coverage, requirement declarations,
 * source additions, file state and the retained report's bytes. Unknown => rerun.
 */
export function reviewInput(cwd:string,taskId:string,agent:string,scope:string[],state:ProcessObligationState,requirements:readonly {id:string;tag?:string;text?:string;source?:string;reference?:string;criticalConditions?:string[];testCommand?:string}[],artifacts:{path:string}[],acceptedInput?:string):ReviewInput|null {
 if(!reviewers.has(agent)||!scope.length||!state.changedFiles.length)return null;
 try {
  const normalized=[...new Set(scope.map(s=>s.trim()).filter(Boolean))].sort();
  const scopeRevision=worktreeRevision(cwd,normalized,normalized);
  if(scopeRevision==="unavailable")return null;
  const declarations=requirements.map(r=>({id:r.id,tag:r.tag,text:r.text,source:r.source,reference:r.reference,criticalConditions:r.criticalConditions,testCommand:r.testCommand})).sort((a,b)=>a.id.localeCompare(b.id));
  const inputs=artifacts.map(a=>[a.path,digest(readFileSync(resolve(cwd,a.path)))]).sort(([a],[b])=>a.localeCompare(b));
  return {taskId,agent,scope:normalized,scopeRevision,contractHash:digest(JSON.stringify({acceptedInput:acceptedInput===undefined?undefined:digest(acceptedInput),risk:state.risk,scope:state.scope,changedFiles:[...state.changedFiles].sort(),additions:state.additions,requirements:declarations,inputs}))};
 } catch { return null; }
}
export function retainReview(state:ProcessObligationState,input:ReviewInput|null,evidenceRef:string,cwd:string):ProcessObligationState {
 if(!input)return state;
 try {
  const record={...input,evidenceRef,evidenceHash:digest(readFileSync(resolve(cwd,evidenceRef)))};
  return {...state,reviews:[...(state.reviews??[]).filter(r=>r.agent!==input.agent),record]};
 } catch { return state; }
}
export function reusableReview(state:ProcessObligationState,input:ReviewInput|null,cwd:string):ReviewEvidence|null {
 if(!input||!state.review.evidenceRef)return null;
 const record=state.reviews?.find(r=>r.agent===input.agent);
 if(!record||record.taskId!==input.taskId||record.scopeRevision!==input.scopeRevision||record.contractHash!==input.contractHash||JSON.stringify(record.scope)!==JSON.stringify(input.scope))return null;
 try{return digest(readFileSync(resolve(cwd,record.evidenceRef)))===record.evidenceHash?record:null;}catch{return null;}
}
