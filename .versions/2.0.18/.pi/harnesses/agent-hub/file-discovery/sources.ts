import {realpathSync} from 'node:fs';
import {resolve} from 'node:path';
import {checkedSourcePath} from '../../lib/safe-source-read.js';
import {currentFileAccessAllowed} from '../../lib/damage-control-shared.ts';
import {exportPathAllowed, readSourcesWorker, sourceHash} from '../agentic-sources.ts';
import {containsCommunicationSecret} from '../system1-communication-store.ts';
import {evaluateFile, type FileDiscoveryConfig, type ReadySource, type FileEvaluation} from './evaluate.ts';
import type {System1Service} from '../../lib/system1/contracts.ts';
import type {ResultRow} from './results.ts';

export function createDiscoverySources(options:{root:string; config:FileDiscoveryConfig; canRead?(path:string):boolean; read?:typeof readSourcesWorker}) {
 const root=realpathSync(options.root), read=options.read??readSourcesWorker;
 const access=options.canRead??(path=>currentFileAccessAllowed(root,path));
 const approved=(path:string)=>{
  if(!exportPathAllowed(path,options.config.include))throw Error('source_denied');
  const full=resolve(root,path);if(!access(full))throw Error('source_denied');
  return checkedSourcePath(root,full);
 };
 return async(path:string,signal:AbortSignal):Promise<ReadySource>=>{
  const full=approved(path);
  const bytes=(await read(root,[full],options.config.limits.maxFileBytes,signal,options.config.limits.discoveryMs))[0];
  if(containsCommunicationSecret(bytes.toString('utf8')))throw Error('source_denied');
  const hash=sourceHash(bytes);
  return {path,text:bytes.toString('utf8'),hash,async current(currentSignal=signal){
   try {const full=approved(path);const current=(await read(root,[full],options.config.limits.maxFileBytes,currentSignal,options.config.limits.discoveryMs))[0];return sourceHash(current)===hash;}catch{return false;}
  }};
 };
}
const failure=(error:unknown)=>{
 const reason=error instanceof Error?error.message:'';
 return ({source_denied:'denied',state_too_large:'oversized',source_changed:'changed',cancelled:'cancelled'} as Record<string,string>)[reason]??'unavailable';
};
// Metadata permission is distinct from content/export permission. Hidden paths contribute only an aggregate.
export async function rankCandidates(options:{root:string;config:FileDiscoveryConfig;paths:readonly string[];task:string;service:System1Service;signal:AbortSignal;canDisplay(path:string):boolean;canRead?(path:string):boolean;hidden?:number;customQuestions?:unknown;read?:typeof readSourcesWorker;evaluate?(source:ReadySource):Promise<FileEvaluation & {cached?:boolean}>}) {
 const collect=createDiscoverySources(options),rows:ResultRow[]=[];
 let hidden=options.hidden??0,sourceBytes=0,evaluations=0;
 const paths=[...new Set(options.paths)].sort();
 for(const path of paths){
  // Only canonical relative identities enter the result. Do not disclose arbitrary caller payload.
  if(!path||path.startsWith('/')||/[\\\0]/.test(path)||path.split('/').some(p=>!p||p==='.'||p==='..')){hidden++;continue;}
  if(!options.canDisplay(resolve(options.root,path))){hidden++;continue;}
  const row:ResultRow={path,status:'unscored',reason:'not_evaluated'};rows.push(row);
  if(options.signal.aborted){row.reason='cancelled';continue;}
  if(options.config.mode!=='active'||!options.config.remoteContextApproved){row.reason=options.config.mode==='active'?'not_approved':'consumer_off';continue;}
  if(evaluations>=options.config.limits.maxEvaluationsPerJob||sourceBytes>=options.config.limits.maxSourceBytesPerJob)continue;
  try {
   const source=await collect(path,options.signal);row.hash=source.hash;
   sourceBytes+=Buffer.byteLength(source.text);if(sourceBytes>options.config.limits.maxSourceBytesPerJob)continue;
   evaluations++;
   const result=options.evaluate?await options.evaluate(source):await evaluateFile({...options,source});
   if(result.status==='scored'){
    row.status='cached' in result&&result.cached?'cached':'scored';delete row.reason;row.relevance=result.relevance;row.role=result.role;
    const answer=result.answers.find(a=>a.questionId==='d9_relevance');
    if(answer)row.uncertainty={provenance:answer.uncertainty.provenance,confidence:answer.uncertainty.confidence};
   }else row.reason=result.reason;
  }catch(error){row.reason=failure(error);}
 }
 const visible=rows.filter(row=>{
  const full=resolve(options.root,row.path);
  if(!options.canDisplay(full)){hidden++;return false;}
  // Later evaluations can revoke an earlier row's read/export permission.
  if((row.status!=='unscored'||row.hash)&&(!exportPathAllowed(row.path,options.config.include)||!(options.canRead??(path=>currentFileAccessAllowed(options.root,path)))(full))){
   for(const key of ['hash','relevance','role','uncertainty'] as const)delete row[key];
   row.status='unscored';row.reason='denied';
  }
  return true;
 });
 return {rows:visible,hidden};
}
