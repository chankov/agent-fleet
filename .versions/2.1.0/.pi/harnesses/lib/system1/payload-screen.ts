import {resolve,relative,isAbsolute,dirname} from 'node:path';
import {lstatSync,realpathSync} from 'node:fs';
import {checkedSourcePath} from '../safe-source-read.js';
import {exportPathAllowed,trackedPaths} from '../../agent-hub/agentic-sources.ts';
import {containsCommunicationSecret} from '../../agent-hub/system1-communication-store.ts';
import {parseDamageGuardConfig} from './config-damage-guard.js';
export type DamagePayload={kind:'command';input:Record<string,unknown>}|{kind:'edit';input:Record<string,unknown>}|{kind:'result';path?:string;text:string;complete:boolean};
export type ScreenedDamagePayload={status:'ready';payload:string;bytes:number;scope:'commands'|'edits'|'results';coverage:'complete'}|{status:'not_evaluated';reason:'consumer_off'|'scope_off'|'source_denied'|'secret'|'oversized'|'incomplete'|'unsupported'|'cancelled'};
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
function supportedAction(kind:'command'|'edit',row:Record<string,unknown>):boolean{
 const keys=(allowed:string[])=>Object.keys(row).every(k=>allowed.includes(k));
 const str=(v:unknown)=>typeof v==='string';
 if(kind==='command')return keys(['command','timeout'])&&str(row.command)&&!!String(row.command).trim()&&(row.timeout===undefined||typeof row.timeout==='number'&&Number.isFinite(row.timeout)&&row.timeout>0);
 if(!str(row.path)||!row.path)return false;
 if(row.content!==undefined)return keys(['path','content'])&&str(row.content);
 const pair=(v:unknown)=>record(v)&&Object.keys(v).every(k=>['oldText','newText'].includes(k))&&str(v.oldText)&&!!v.oldText&&str(v.newText);
 if(row.edits!==undefined)return keys(['path','edits'])&&Array.isArray(row.edits)&&row.edits.length>0&&row.edits.length<=32&&row.edits.every(pair);
 return keys(['path','oldText','newText'])&&pair({oldText:row.oldText,newText:row.newText});
}
function proposedPathCheck(root:string,full:string):string{
 const realRoot=realpathSync(root);let cursor=full;
 while(cursor!==realRoot){
  try{if(lstatSync(cursor).isSymbolicLink())throw Error('source_denied');if(realpathSync(cursor)!==cursor)throw Error('source_denied');}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const parent=dirname(cursor);if(parent===cursor)throw Error('source_denied');cursor=parent;
 }
 return full;
}
function secretText(text:string):boolean{
 // Examine original textual fields before JSON framing escapes quotes; never redact and call complete.
 const decoded=text.replace(/\\u([a-f0-9]{4})/gi,(_match,code:string)=>String.fromCharCode(parseInt(code,16))).replace(/\\["']/g,'"');
 return containsCommunicationSecret(text)||containsCommunicationSecret(decoded)||/["']?(?:authorization|api[_ -]?key|password|passwd|secret|(?:access[_ -]?|refresh[_ -]?)?token|cookies?|credentials?|private[_ -]?key)["']?\s*[:=]/i.test(decoded);
}
/** Inputs originate only from harness-owned events; this helper grants no execution authority. */
export async function screenDamagePayload(input:DamagePayload,options:{root:string;config:ReturnType<typeof parseDamageGuardConfig>;canRead(path:string):boolean;signal?:AbortSignal;pathCheck?:typeof checkedSourcePath;tracked?:typeof trackedPaths}):Promise<ScreenedDamagePayload>{
 const refuse=(reason:Extract<ScreenedDamagePayload,{status:'not_evaluated'}>['reason']):ScreenedDamagePayload=>({status:'not_evaluated',reason});
 const {config}=options;const scope=input.kind==='command'?'commands':input.kind==='edit'?'edits':'results';
 if(options.signal?.aborted)return refuse('cancelled');
 if(config.mode!=='active')return refuse('consumer_off');
 if(!config.remoteScopes[scope])return refuse('scope_off');
 const path=input.kind==='edit'?input.input.path:input.kind==='result'?input.path:undefined;
 if(input.kind!=='result'&&(!record(input.input)||!supportedAction(input.kind,input.input)))return refuse('unsupported');
 const strings=(v:unknown):string[]=>typeof v==='string'?[v]:Array.isArray(v)?v.flatMap(strings):record(v)?Object.values(v).flatMap(strings):[];
 if(strings(input.kind==='result'?input.text:input.input).some(secretText))return refuse('secret');
 if(input.kind==='result'&&(!input.complete||typeof input.text!=='string'))return refuse('incomplete');
 if(input.kind!=='command'){
  if(typeof path!=='string')return refuse('source_denied');
  const rel=relative(resolve(options.root),resolve(options.root,path));
  if(!rel||isAbsolute(rel)||rel.startsWith('..')||!exportPathAllowed(rel,config.include,config.include.includes('git:tracked')))return refuse('source_denied');
  const full=resolve(options.root,rel);
  try{
   if(!options.canRead(full))return refuse('source_denied');
   (options.pathCheck??(input.kind==='edit'?proposedPathCheck:checkedSourcePath))(options.root,full);
   if(!exportPathAllowed(rel,config.include)){
    const controller=new AbortController(),abort=()=>controller.abort();options.signal?.addEventListener('abort',abort,{once:true});
    try{const members=await (options.tracked??trackedPaths)(options.root,[rel],controller.signal,config.limits.hookTimeoutMs);if(!members.has(rel))return refuse('source_denied');}finally{options.signal?.removeEventListener('abort',abort);}
   }
  }catch{return refuse(options.signal?.aborted?'cancelled':'source_denied');}
 }
 let payload:string;try{payload=JSON.stringify(input.kind==='result'?{path,text:input.text}:input.input);}catch{return refuse('unsupported');}
 if(containsCommunicationSecret(payload))return refuse('secret');
 const bytes=Buffer.byteLength(payload);if(bytes>config.limits.maxPayloadBytes)return refuse('oversized');
 if(options.signal?.aborted)return refuse('cancelled');
 return {status:'ready',payload,bytes,scope,coverage:'complete'};
}
