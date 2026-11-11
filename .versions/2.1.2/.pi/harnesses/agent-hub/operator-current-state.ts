import { lstatSync, realpathSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
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
export function captureOperatorState(input:{scope:unknown;cwd:string;snapshot:any;revision:string}):OperatorStateCandidate {
 const {cwd,snapshot,revision}=input,scope=operatorScopeSyntax(input.scope);
 if(snapshot?.skipped||snapshot?.nested||!snapshot?.fingerprints||revision==='unavailable'||!revision)throw Error('operator_state_scope_unavailable');
 const root=realpathSync(cwd),seen=new Set<string>();
 for(const path of scope){
  // Existing Git observation is the boundary: ignored/clean/session output paths
  // are not silently adopted or read through a new filesystem surface.
  if(path.startsWith('.pi/agent-sessions/')||!snapshot.paths?.has(path)||!snapshot.fingerprints.has(path)||snapshot.fingerprints.get(path)==='missing')throw Error('operator_state_scope_unobserved');
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
export function operatorStateChecksPassed(input:{candidate:OperatorStateCandidate;revision:string;sameTask:boolean;native:boolean;exclusive:boolean;verification:any}):boolean {
 if(!input.sameTask||!input.native||!input.exclusive||input.revision==='unavailable'||input.revision!==input.candidate.revision)return false;
 const requirements=input.verification?.requirements;
 if(!Array.isArray(requirements))return false;
 const automated=requirements.filter((r:any)=>r.tag==='test'||r.tag==='code-grep');
 return automated.some((r:any)=>r.id!=='AF-MIN-CHANGE')&&automated.some((r:any)=>r.id==='AF-MIN-CHANGE')
  &&automated.every((r:any)=>r.status==='passed'&&Array.isArray(r.evidenceRefs)&&r.evidenceRefs.length>0)
  &&Array.isArray(input.verification.checks)&&automated.every((r:any)=>input.verification.checks.some((c:any)=>c.producer==='runtime'&&c.status==='passed'&&Array.isArray(c.requirementIds)&&c.requirementIds.includes(r.id)&&r.evidenceRefs.includes(c.evidenceRef)));
}
