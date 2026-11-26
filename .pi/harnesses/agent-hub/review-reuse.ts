import { isReviewPersona } from "./run-budget.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { revisionOf, worktreeRevision } from "./scope-gate.js";
import type { ProcessObligationState } from "./process-obligations.ts";
import { isChangeAuthor, selfAuthoredPaths } from "./review-closure.ts";

const digest=(value:string|Uint8Array)=>createHash("sha256").update(value).digest("hex");
export interface ReviewInput { taskId:string; agent:string; scope:string[]; scopeRevision:string; contractHash:string; }
/** `executor` is the review-closure.ts identity that produced the report (absent in older states). */
export interface ReviewEvidence extends ReviewInput { evidenceRef:string; evidenceHash:string; baselineRef?:string; baselineHash?:string; executor?:string; }
export function normalizeReviewEvidence(value:unknown):ReviewEvidence[] {
 if(!Array.isArray(value))return [];
 const valid=new Map<string,ReviewEvidence>();
 for(const row of value){
  if(!row||!isReviewPersona(row.agent)||typeof row.taskId!=="string"||!row.taskId||!Array.isArray(row.scope)||!row.scope.length||!row.scope.every((s:unknown)=>typeof s==="string"&&s.length>0)||typeof row.evidenceRef!=="string"||!row.evidenceRef||![row.scopeRevision,row.contractHash,row.evidenceHash].every(v=>typeof v==="string"&&/^[a-f0-9]{64}$/.test(v)))continue;
  // An unreadable reviewer identity cannot show independence: the record is dropped, never reused.
  if(row.executor!==undefined&&!isChangeAuthor(row.executor))continue;
  valid.set(row.agent,{taskId:row.taskId,agent:row.agent,scope:[...row.scope],scopeRevision:row.scopeRevision,contractHash:row.contractHash,evidenceRef:row.evidenceRef,evidenceHash:row.evidenceHash,...(typeof row.baselineRef==="string" && /^[a-f0-9]{64}$/.test(row.baselineHash) ? {baselineRef:row.baselineRef,baselineHash:row.baselineHash} : {}),...(row.executor!==undefined?{executor:row.executor}:{})});
 }
 return [...valid.values()];
}

/** No model judgment: match complete declared coverage, requirement declarations,
 * source additions, file state and the retained report's bytes. Unknown => rerun.
 */
export function reviewInput(cwd:string,taskId:string,agent:string,scope:string[],state:ProcessObligationState,requirements:readonly {id:string;tag?:string;text?:string;source?:string;reference?:string;criticalConditions?:string[];testCommand?:string;compilerCommand?:string}[],artifacts:{path:string}[],acceptedInput?:string,practices:readonly string[]=[]):ReviewInput|null {
 if(!isReviewPersona(agent)||!scope.length||!state.changedFiles.length)return null;
 try {
  const normalized=[...new Set(scope.map(s=>s.trim()).filter(Boolean))].sort();
  const scopeRevision=worktreeRevision(cwd,normalized,normalized);
  if(scopeRevision==="unavailable")return null;
  const declarations=requirements.map(r=>({id:r.id,tag:r.tag,text:r.text,source:r.source,reference:r.reference,criticalConditions:r.criticalConditions,testCommand:r.testCommand,compilerCommand:r.compilerCommand})).sort((a,b)=>a.id.localeCompare(b.id));
  const inputs=artifacts.map(a=>[a.path,digest(readFileSync(resolve(cwd,a.path)))]).sort(([a],[b])=>a.localeCompare(b));
  // Practices are part of the contract: a security review and a plain review of one scope are different evidence.
  const assignedPractices=[...new Set(practices.map(p=>String(p).trim().toLowerCase()).filter(Boolean))].sort();
  return {taskId,agent,scope:normalized,scopeRevision,contractHash:digest(JSON.stringify({...(assignedPractices.length?{practices:assignedPractices}:{}),acceptedInput:acceptedInput===undefined?undefined:digest(acceptedInput),risk:state.risk,scope:state.scope,...(state.workOrigin?{workOrigin:state.workOrigin}:{}),changedFiles:[...state.changedFiles].sort(),additions:state.additions,requirements:declarations,inputs}))};
 } catch { return null; }
}
export function retainReview(state:ProcessObligationState,input:ReviewInput|null,evidenceRef:string,cwd:string,executor?:string):ProcessObligationState {
 if(!input)return state;
 try {
  const record:ReviewEvidence={...input,evidenceRef,evidenceHash:digest(readFileSync(resolve(cwd,evidenceRef))),...(executor&&isChangeAuthor(executor)?{executor}:{})};
  return {...state,reviews:[...(state.reviews??[]).filter(r=>r.agent!==input.agent),record]};
 } catch { return state; }
}
export function reusableReview(state:ProcessObligationState,input:ReviewInput|null,cwd:string):ReviewEvidence|null {
 const {evidenceRef,revision,revisionScopes}=state.review;
 if(!input||!evidenceRef||!revision||!/^[a-f0-9]{64}$/.test(revision))return null;
 const record=state.reviews?.find(r=>r.agent===input.agent);
 if(!record||record.evidenceRef!==evidenceRef||record.taskId!==input.taskId||record.scopeRevision!==input.scopeRevision||record.contractHash!==input.contractHash||JSON.stringify(record.scope)!==JSON.stringify(input.scope))return null;
 // The reviewer must still be independent of every file it covered (plan task 5).
 if(record.executor&&selfAuthoredPaths(state.changeAuthors,record.executor,record.scope).length)return null;
 try{return revisionOf(cwd,revisionScopes??[])===revision&&digest(readFileSync(resolve(cwd,evidenceRef)))===record.evidenceHash?record:null;}catch{return null;}
}
