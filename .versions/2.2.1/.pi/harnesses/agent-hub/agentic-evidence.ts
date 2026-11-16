import {randomUUID} from 'node:crypto';
import {mkdirSync,rmSync,realpathSync,lstatSync} from 'node:fs';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {deterministicHandlePath} from '../lib/deterministic-handle-path.ts';
import {boundOutput} from './deterministic-fs.ts';
import {safeSourceRead,checkedSourcePath} from '../lib/safe-source-read.js';
import {containsCommunicationSecret} from './system1-communication-store.ts';
import {sourceHash} from './agentic-sources.ts';
import type {AgenticConfig,SourceSummary} from './agentic-contract.ts';
import type {AgenticSources} from './agentic-runtime.ts';
interface RecordOutput {ref:string;sessionId:string;context:string;taskId:string;cwd:string;toolCallId:string;path:string;handle:string;hash:string;bytes:number;sourcePaths:string[];summary:SourceSummary;}
export function createAgenticEvidence(options:{config?:AgenticConfig;sessionId:string;sessionDir:string;context():string;taskId?():string;canRead(path:string):boolean;parent?:boolean}) {
 const records=new Map<string,RecordOutput>();let total=0,disposed=false;
 const enabled=()=>!disposed&&options.parent!==false&&(options.config?.mode==='advisory'||options.config?.mode==='recommended')&&options.config.remoteContextApproved&&options.config.allowToolOutputs;
 const dir=join(options.sessionDir,'artifacts/evidence/agentic');
 const remove=(r:RecordOutput)=>{records.delete(r.ref);total-=r.bytes;try{checkedSourcePath(options.sessionDir,r.path);rmSync(r.path);}catch{/* never follow a replaced parent */}};
 const check=(r:RecordOutput)=>{
  if(!enabled()||r.sessionId!==options.sessionId||r.context!==options.context()||r.taskId!==(options.taskId?.()??options.context()))throw Error('evidence_unavailable');
  if(!options.canRead(r.path)||r.sourcePaths.some(p=>!options.canRead(p)))throw Error('source_denied');
  const bytes=safeSourceRead(options.sessionDir,r.path,options.config!.limits.maxSourceBytes);
  if(sourceHash(bytes)!==r.hash)throw Error('source_changed');
  if(containsCommunicationSecret(bytes.toString('utf8')))throw Error('source_denied');
  return bytes;
 };
 return {
  get size(){return records.size;},get retainedBytes(){return total;},
  capture(event:{toolName:string;toolCallId:string;content?:unknown[];details?:any;isError?:boolean},cwd:string,sourcePaths:string[]=[]):SourceSummary|null {
   if(!enabled()||event.toolName!=='bash'||!event.toolCallId||typeof event.isError!=='boolean')return null;
   const content=event.content??[];if(content.some((x:any)=>x?.type!=='text'||typeof x.text!=='string'))return null;
   const text=content.map((x:any)=>x.text).join('\n'),bytes=Buffer.byteLength(text),limits=options.config!.limits;
   if(bytes>limits.maxSourceBytes||bytes>limits.maxRetainedBytes||containsCommunicationSecret(text))return null;
   if(sourcePaths.some(p=>!options.canRead(resolve(cwd,p))))return null;
   try {
    const root=realpathSync(options.sessionDir);let cursor=root;
    for(const part of ['artifacts','evidence','agentic']) {cursor=join(cursor,part);mkdirSync(cursor,{recursive:true,mode:0o700});checkedSourcePath(root,cursor);}
   }catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')return null;}
   try {
    const root=realpathSync(options.sessionDir),target=realpathSync(dir),rel=relative(root,target);
    if(rel.startsWith('..')||isAbsolute(rel)||target!==resolve(dir)||lstatSync(dir).isSymbolicLink()||!options.canRead(dir))return null;
    // Verify every ancestor, including already-existing directories, before artifact writes.
    checkedSourcePath(root,dir);
    const bounded=boundOutput({content:text,retentionDir:dir,label:'ask-output'});
    const ref=`ask1:${randomUUID()}`;
    const truncation=event.details?.truncation?.truncated===true||event.details?.boundedOutput?.truncated===true||event.details?.fullOutputPath?'partial':event.isError&&event.details?.complete!==true?'unknown':'complete';
    const summary:SourceSummary={kind:'output',ref,hash:bounded.hash,bytes,complete:truncation==='complete',toolCallId:event.toolCallId,isError:event.isError,truncation,readbackHandle:bounded.handle,sourcePathsKnown:sourcePaths.length>0,...(Number.isSafeInteger(event.details?.exitCode)?{exitCode:event.details.exitCode}:{})};
    const r:RecordOutput={ref,sessionId:options.sessionId,context:options.context(),taskId:options.taskId?.()??options.context(),cwd,toolCallId:event.toolCallId,path:bounded.contentPath,handle:bounded.handle,hash:bounded.hash,bytes,sourcePaths:sourcePaths.map(p=>resolve(cwd,p)),summary};
    records.set(ref,r);total+=bytes;
    while(records.size>limits.maxHandles||total>limits.maxRetainedBytes)remove(records.values().next().value!);
    return summary;
   }catch{return null;}
  },
  async resolve(refs:string[],signal:AbortSignal):Promise<AgenticSources>{
   if(signal.aborted)throw Error('cancelled');
   const selected=refs.map(ref=>{const r=records.get(ref);if(!r)throw Error('evidence_unavailable');return r;});
   const sources=selected.map(r=>{const b=check(r);if(!r.summary.complete)throw Error('evidence_incomplete');return {summary:{...r.summary},text:b.toString('utf8')};});
   return {sources,current:async()=>{try{for(const r of selected){if(signal.aborted||records.get(r.ref)!==r)return false;check(r);}return true;}catch{return false;}}};
  },
  readback(ref:string):string {const r=records.get(ref);if(!r)throw Error('evidence_unavailable');return check(r).toString('utf8');},
  canReadTarget(path:string):boolean {const target=resolve(path),r=[...records.values()].find(r=>r.path===target);if(!r)return !target.startsWith(resolve(dir)+'/');try{check(r);return true;}catch{return false;}},
  canReadHandle(handle:string):boolean {try{return this.canReadTarget(deterministicHandlePath(handle));}catch{return false;}}, 
  dispose(){for(const r of [...records.values()])remove(r);disposed=true;},
 };
}
export type AgenticEvidence=ReturnType<typeof createAgenticEvidence>;
