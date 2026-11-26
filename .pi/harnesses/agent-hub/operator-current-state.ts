import { lstatSync, realpathSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { ScopeDiagnostic } from './scope-diagnostic.ts';

export class OperatorScopeObservationError extends Error {
 readonly diagnostic: ScopeDiagnostic;
 constructor(code: 'operator_state_scope_unobserved' | 'operator_state_scope_unavailable', diagnostic: ScopeDiagnostic) {
  super(code);
  this.diagnostic = diagnostic;
 }
}

export function unknownOperatorScope(): ScopeDiagnostic {
 return {kind:'unknown',checkedPaths:'unknown',nextStep:'The runtime could not establish comparable observed paths. Check the current Git status locally in each relevant repository, declare exact changed files relative to the workspace, then re-run the review and its targeted checks.'};
}
export interface OperatorStateCandidate { origin:'operator-current-state'; revision:string; paths:string[]; historicalAttribution:'not_claimed' }
export const OPERATOR_SCOPE_MAX=128;
export function operatorScopeSyntax(scope:unknown):string[] {
 if(!Array.isArray(scope)||!scope.length||scope.length>OPERATOR_SCOPE_MAX)throw Error('operator_state_invalid_scope');
 const seen=new Set<string>();
 for(const path of scope){
  if(typeof path!=='string'||!path||path.length>1024||isAbsolute(path)||/[\x00-\x1f\x7f\\*?\[\]{}()!]/.test(path)||path.split('/').some(p=>!p||p==='.'||p==='..')||seen.has(path))throw Error('operator_state_invalid_scope');
  seen.add(path);
 }
 return [...seen];
}
// Runtime-owned snapshots only. Never reconstruct historical effects from prose/logs.
// A workspace folder that holds nested repositories (rin-docs/, ringithub/) is
// observed per declared file's own repository, with workspace-relative paths; any
// file outside an observed repository is a gap, and a gap makes the revision
// unavailable, so partial coverage never becomes a candidate.
export function captureOperatorState(input:{scope:unknown;cwd:string;snapshot:any;revision:string}):OperatorStateCandidate {
 const {cwd,snapshot,revision}=input,scope=operatorScopeSyntax(input.scope);
 if(snapshot?.skipped||snapshot?.gaps?.length||!snapshot?.fingerprints||revision==='unavailable'||!revision)throw new OperatorScopeObservationError('operator_state_scope_unavailable',unknownOperatorScope());
 const root=realpathSync(cwd),seen=new Set<string>();
 for(const [index,path] of scope.entries()){
  // Existing Git observation is the boundary: ignored/clean/session output paths
  // are not silently adopted or read through a new filesystem surface.
  if(path.startsWith('.pi/agent-sessions/')||!snapshot.paths?.has(path)||!snapshot.fingerprints.has(path)||snapshot.fingerprints.get(path)==='missing'){
   const scopeEntry=index+1;
   const diagnostic: ScopeDiagnostic = snapshot.paths instanceof Set && snapshot.fingerprints instanceof Map ? {
    kind:'observation_gap',checkedPaths:'unknown',scopeEntry,
    nextStep:`Scope entry #${scopeEntry} was not eligible in the current Git observation. Compare that entry with local Git status and use the exact workspace-relative changed file before re-running its targeted verification.`,
   } : unknownOperatorScope();
   throw new OperatorScopeObservationError('operator_state_scope_unobserved',diagnostic);
  }
  const file=resolve(root,path);if(relative(root,file).replace(/\\/g,'/')!==path||!lstatSync(file).isFile()||realpathSync(file)!==file)throw Error('operator_state_invalid_file');
  seen.add(path);
 }
 return {origin:'operator-current-state',revision,paths:[...seen].sort(),historicalAttribution:'not_claimed'};
}
export function operatorReviewState<T extends {changedFiles:string[];workOrigin?:'operator-current-state'}>(state:T,candidate?:OperatorStateCandidate) {
 return candidate ? {...state,changedFiles:[...new Set([...state.changedFiles,...candidate.paths])].sort(),workOrigin:'operator-current-state' as const} : state;
}
export type OperatorEvidenceWriter=(agentKey:string,runCount:number,output:string,kind?:'returns'|'failures'|'evidence',dispatchId?:string,sessionDir?:string)=>string;
export function persistOperatorStateProof(input:{writer:OperatorEvidenceWriter;sessionDir:string;runCount:number;dispatchId:string;record:unknown}):string {
 const base=realpathSync(input.sessionDir),root=resolve(input.sessionDir,'artifacts','evidence');
 for(const [path,expected] of [[resolve(input.sessionDir,'artifacts'),resolve(base,'artifacts')],[root,resolve(base,'artifacts','evidence')]]){
  try{if(!lstatSync(path).isDirectory()||realpathSync(path)!==expected)throw Error('operator_state_evidence_root');}
  catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 }
 const serialized=JSON.stringify(input.record,null,2);if(typeof serialized!=='string')throw Error('operator_state_evidence_payload');
 const file=input.writer('operator-state',input.runCount,serialized,'evidence',input.dispatchId,input.sessionDir);
 const rel=relative(root,resolve(file));if(!rel||rel.startsWith('..')||isAbsolute(rel))throw Error('operator_state_evidence_readback');
 const expected=Buffer.from(serialized,'utf8'),stat=lstatSync(file);
 if(!stat.isFile()||stat.size!==expected.length||realpathSync(file)!==resolve(base,'artifacts','evidence',rel)||!readFileSync(file).equals(expected))throw Error('operator_state_evidence_readback');
 return file;
}
/** The first refused current-state check qualifier, or null when every one holds. Diagnostic only: it never relaxes a check. */
export function operatorStateChecksDiagnostic(input:{candidate:OperatorStateCandidate;revision:string;sameTask:boolean;native:boolean;exclusive:boolean;verification:any}):string|null {
 if(!input.sameTask)return 'not_same_task';
 if(!input.native)return 'not_native';
 if(!input.exclusive)return 'non_exclusive_capture';
 if(input.revision==='unavailable')return 'revision_unavailable';
 if(input.revision!==input.candidate.revision)return 'revision_changed';
 const requirements=input.verification?.requirements;
 if(!Array.isArray(requirements))return 'no_runtime_requirements';
 const automated=requirements.filter((r:any)=>r.tag==='test'||r.tag==='code-grep');
 if(!automated.some((r:any)=>r.id!=='AF-MIN-CHANGE'))return 'no_automated_requirement';
 if(!automated.some((r:any)=>r.id==='AF-MIN-CHANGE'))return 'missing_min_change';
 const notPassed=automated.filter((r:any)=>!(r.status==='passed'&&Array.isArray(r.evidenceRefs)&&r.evidenceRefs.length>0)).map((r:any)=>r.id);
 if(notPassed.length)return `automated_not_passed:${notPassed.join(',')}`;
 const checks=Array.isArray(input.verification.checks)?input.verification.checks:[];
 const unanchored=automated.filter((r:any)=>!checks.some((c:any)=>c.producer==='runtime'&&c.status==='passed'&&Array.isArray(c.requirementIds)&&c.requirementIds.includes(r.id)&&r.evidenceRefs.includes(c.evidenceRef))).map((r:any)=>r.id);
 if(unanchored.length)return `runtime_check_missing:${unanchored.join(',')}`;
 return null;
}
export function operatorStateChecksPassed(input:{candidate:OperatorStateCandidate;revision:string;sameTask:boolean;native:boolean;exclusive:boolean;verification:any}):boolean {
 return operatorStateChecksDiagnostic(input)===null;
}
/** Plain-language next step for a refused current-state qualifier; never an acceptance shortcut. */
export function operatorStateNextStep(reason:string):string {
 const code=reason.split(':')[0];
 const steps:Record<string,string>={
  not_same_task:'The task changed during the review; re-run it for the current task.',
  not_native:'Re-run with backend: native.',
  non_exclusive_capture:'Another writer or capture overlapped; re-run when no writer is active.',
  revision_unavailable:'The scope revision could not be observed; check the declared files are tracked and re-run.',
  revision_changed:'The scoped files changed during the review; re-run on the settled state.',
  no_runtime_requirements:'No runtime verification was produced; re-run and let the reviewer run the declared commands.',
  no_automated_requirement:'The ledger has no automated (test/code-grep) assertion for this scope; declare the sourced automated checks with set_assertions for this same task.',
  missing_min_change:'The runtime minimal-change check was not produced; re-run the review.',
  automated_not_passed:'These automated assertions did not pass with runtime evidence; fix or re-run their exact declared commands.',
  runtime_check_missing:'These automated assertions lack an anchored runtime check; the reviewer must run their exact declared commands through approved bash.',
  tool_protocol_error:'The reviewer broke the result protocol; inspect the protocol evidence and re-run.',
  deliverable_failed:'A declared deliverable failed readback; fix it before re-running.',
  blocking_findings:'The reviewer reported blocking findings; fix them, then re-run the review.',
  assertions_failed:'The reviewer reported failed assertions; fix them, then re-run the review.',
  unresolved_questions:'The reviewer raised ASK_USER questions; resolve them (operator first, then the human if needed) before re-running.',
  needs_research:'The reviewer requested research; run it and re-run the review with the findings.',
  requires_user_decision:'The reviewer returned a decision that belongs to the human; obtain it explicitly before re-running. It is never ignored automatically.',
  review_input_missing:'The review input could not be recorded at dispatch; re-run the review.',
  not_review_stage:'Only a reviewer can register a current-state candidate; dispatch the reviewer role.',
  review_input_changed:'The review input changed during the review; re-run it.',
  not_delivered:'The review did not complete and deliver; re-run it.',
  submission_incomplete:'The reviewer did not submit a completed structured result; re-run it.',
  verdict_not_affirmative:'The reviewer did not return an unambiguous APPROVE.',
  regression_not_closed:'The review did not report the required full-regression coverage for this scope.',
  evidence_readback_failed:'The verification record could not be written and read back; check the session evidence directory and re-run.',
 };
 return steps[code]??'Re-run the current-state review after resolving the refusal.';
}
