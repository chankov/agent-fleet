export type SemanticDecision='allow'|'deny';
const decisions=new Map<string,SemanticDecision>();
let scope:{taskId:string;revision:string}|null=null;
const key=(taskId:string,revision:string,path:string)=>JSON.stringify([taskId,revision,path]);

export function resetSemanticApprovals():void {
 decisions.clear();scope=null;
}
export function bindSemanticScope(taskId:string,revision:string):void {
 if(!taskId||!revision){scope=null;return;}
 if(scope?.taskId===taskId&&scope.revision===revision)return;
 scope={taskId,revision};
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
export function inspectionBash(command:string):boolean {
 const segments=command.split(/&&|\|\||;/).map(segment=>segment.trim()).filter(Boolean);
 if(!segments.length||/[|`$<>]/.test(command.replace(/\s+2>\s*\/dev\/null\b/g, ''))||command.includes('$('))return false;
 return segments.every(segment=>{
  const argv=tokens(segment.replace(/\s+2>\s*\/dev\/null\b/g, ''));
  return ['pwd','ls','test','stat','wc','file'].includes(argv[0]??'')&&argv.every(token=>!/[|&`;<>]/.test(token));
 });
}
export function exactDeletePath(command:string):string|null {
 const trimmed=command.trim();
 if(!trimmed||/[;&|`$<>\n]/.test(trimmed)||trimmed.includes('$('))return null;
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
 if(!command.trim()||/[|`$<>\n]/.test(command)||command.includes('$('))return null;
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
const word=(value:string,words:string[])=>new RegExp(`^(?:${words.join('|')})(?=$|[^\\p{L}\\p{N}_])`,'iu').test(value.trim());
const affirmative=(value:string)=>word(value,['да','yes','allow'])&&!word(value,['не','no','deny']);
const negative=(value:string)=>word(value,['не','no','deny']);
const deletion=(value:string)=>/изтри|delete|remove|\brm\b/i.test(value);
function pathsIn(value:string):string[] {
 const found=new Set<string>();
 for(const match of value.matchAll(/`([^`]+)`|"([^"]+)"|'([^']+)'|(\S+)/g)){
  const normalized=normalizeDecisionPath(match[1]??match[2]??match[3]??match[4]??'');
  if(normalized)found.add(normalized);
 }
 return [...found];
}
export function deleteConfirmation(question:string,context:string|undefined,selection:string):{path:string;decision:SemanticDecision}|null {
 const decision=affirmative(selection)?'allow':negative(selection)?'deny':null;
 if(!decision)return null;
 const text=`${question}\n${context??''}\n${selection}`;
 if(!deletion(text))return null;
 const paths=pathsIn(`${question}\n${context??''}`);
 return paths.length===1?{path:paths[0],decision}:null;
}
export function semanticAskUserAnswer(params:{question?:unknown;context?:unknown;options?:unknown}):string|null {
 if(!scope||typeof params.question!=='string')return null;
 const options=Array.isArray(params.options)?params.options.filter((option):option is string=>typeof option==='string'):[];
 const paths=pathsIn(`${params.question}\n${typeof params.context==='string'?params.context:''}`);
 if(paths.length!==1||!deletion(`${params.question}\n${typeof params.context==='string'?params.context:''}`))return null;
 const decision=semanticDecision(scope.taskId,scope.revision,paths[0]);
 if(!decision)return null;
 return options.find(option=>decision==='allow'?affirmative(option):negative(option))??null;
}
export function noteAskUserDecision(params:{question?:unknown;context?:unknown},selection:string):void {
 if(!scope||typeof params.question!=='string')return;
 const decision=deleteConfirmation(params.question,typeof params.context==='string'?params.context:undefined,selection);
 if(decision)noteSemanticDecision(scope.taskId,scope.revision,decision.path,decision.decision);
}
export function noteBashDecision(taskId:string,revision:string,command:string,decision:SemanticDecision):void {
 const path=coveredDeletePath(command);
 if(path)noteSemanticDecision(taskId,revision,path,decision);
}
