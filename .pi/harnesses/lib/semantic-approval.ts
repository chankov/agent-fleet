export type SemanticDecision='allow'|'deny';
interface SemanticState { decisions: Map<string,SemanticDecision>; scope: {taskId:string;revision:string}|null; }
// Pi's isolated extension loaders share a JS runtime, not module-local bindings.
const storeKey=Symbol.for('agent-fleet.semantic-approval.v1');
const runtime=globalThis as typeof globalThis & {[key:symbol]:SemanticState|undefined};
const state=runtime[storeKey]??= {decisions:new Map(),scope:null};
const decisions=state.decisions;
export const semanticScope=()=>state.scope;
const key=(taskId:string,revision:string,path:string)=>JSON.stringify([taskId,revision,path]);

export function resetSemanticApprovals():void {
 decisions.clear();state.scope=null;
}
export function bindSemanticScope(taskId:string,revision:string):void {
 if(!taskId||!revision){resetSemanticApprovals();return;}
 if(state.scope?.taskId===taskId&&state.scope.revision===revision)return;
 decisions.clear();state.scope={taskId,revision};
}
export function noteSemanticDecision(taskId:string,revision:string,path:string,decision:SemanticDecision):void {
 const normalized=normalizeDecisionPath(path);
 if(!taskId||!revision||!normalized)return;
 decisions.set(key(taskId,revision,normalized),decision);
}
export function semanticDecision(taskId:string,revision:string,path:string):SemanticDecision|undefined {
 const normalized=normalizeDecisionPath(path);
 return normalized?decisions.get(key(taskId,revision,normalized)):undefined;
}
export function normalizeDecisionPath(value:string):string|null {
 const trimmed=value.trim().replace(/^['"`]|['"`]$/g, '');
 if(!trimmed||trimmed.length>512||trimmed.includes('\0')||trimmed.includes('..')||trimmed.startsWith('/')||trimmed.startsWith('~')||trimmed.endsWith('/'))return null;
 const normalized=trimmed.replace(/^\.\//, '').replace(/\/+/g, '/');
 return /^[A-Za-z0-9._@+-][A-Za-z0-9._@+/-]*$/.test(normalized)?normalized:null;
}
function tokens(command:string):string[] {
 const out:string[]=[];const re=/"([^"]*)"|'([^']*)'|(\S+)/g;let match:RegExpExecArray|null;
 while((match=re.exec(command)))out.push(match[1]??match[2]??match[3]);
 return out;
}
// An inner newline separates Bash commands just like `;`, so no control character may hide a second command.
const controlText=/[\x00-\x1f\x7f-\x9f]/;
export function inspectionBash(command:string):boolean {
 const segments=command.split(/&&|\|\||;/).map(segment=>segment.trim()).filter(Boolean);
 if(!segments.length||controlText.test(command.trim())||/[|`$<>]/.test(command.replace(/\s+2>\s*\/dev\/null\b/g, ''))||command.includes('$('))return false;
 return segments.every(segment=>{
  const argv=tokens(segment.replace(/\s+2>\s*\/dev\/null\b/g, ''));
  return ['pwd','ls','test','stat','wc','file'].includes(argv[0]??'')&&argv.every(token=>!/[|&`;<>]/.test(token));
 });
}
export function exactDeletePath(command:string):string|null {
 const trimmed=command.trim();
 if(!trimmed||controlText.test(trimmed)||/[;&|`$<>]/.test(trimmed)||trimmed.includes('$('))return null;
 const argv=tokens(trimmed);
 if(argv[0]!=='rm')return null;
 const paths:string[]=[];
 for(const token of argv.slice(1)){
  if(token==='--'||token==='-f'||token==='--force')continue;
  if(token.startsWith('-'))return null;
  paths.push(token);
 }
 return paths.length===1?normalizeDecisionPath(paths[0]):null;
}
/** One exact delete plus inspection checks is still the same delete, not a new command. */
export function coveredDeletePath(command:string):string|null {
 if(!command.trim()||controlText.test(command.trim())||/[|`$<>]/.test(command)||command.includes('$('))return null;
 const segments=command.split(/&&|\|\||;/).map(segment=>segment.trim()).filter(Boolean);
 const deletes=new Set<string>();
 for(const segment of segments){
  if(inspectionBash(segment))continue;
  const path=exactDeletePath(segment);
  if(!path)return null;
  deletes.add(path);
 }
 return deletes.size===1?[...deletes][0]:null;
}
/**
 * Only an exact-action dialog that showed the human the command records a decision.
 * Free-form ask_user prose cannot: its polarity and target are not machine-checkable.
 */
export function noteBashDecision(taskId:string,revision:string,command:string,decision:SemanticDecision):void {
 const path=coveredDeletePath(command);
 if(path)noteSemanticDecision(taskId,revision,path,decision);
}
