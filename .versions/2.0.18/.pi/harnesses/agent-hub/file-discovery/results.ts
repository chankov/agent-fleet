import {randomUUID} from 'node:crypto';
import {mkdirSync,realpathSync,writeFileSync,lstatSync} from 'node:fs';
import {join} from 'node:path';
import {safeSourceRead} from '../../lib/safe-source-read.js';
import {sourceHash} from '../agentic-sources.ts';
import {POLICY_VERSION,QUESTION_VERSION} from './evaluate.ts';
export interface ResultRow {path:string;status:'scored'|'cached'|'unscored';hash?:string;relevance?:number;role?:string;reason?:string;uncertainty?:{provenance:string;confidence?:number}}
export interface PageLocator {path:string;hash:string;resultId:string;pageIndex:number;handle?:string}
export interface ResultIdentity {taskHash:string;queryHash:string;model:string}
export function sortRows(rows:readonly ResultRow[]):ResultRow[] {
 return [...rows].sort((a,b)=>((b.status==='unscored'?-1:b.relevance??-1)-(a.status==='unscored'?-1:a.relevance??-1))||(a.path<b.path?-1:a.path>b.path?1:0));
}
export function resultCounts(rows:readonly ResultRow[]){return {discovered:rows.length,evaluated:rows.filter(r=>r.status==='scored').length,cached:rows.filter(r=>r.status==='cached').length,failed:rows.filter(r=>r.status==='unscored'&&r.reason!=='not_evaluated').length,unscored:rows.filter(r=>r.status==='unscored').length};}
export function createResult(options:{rows:readonly ResultRow[];identity:ResultIdentity;discoveryComplete:boolean;evaluationComplete?:boolean;cancelled?:boolean;hidden?:number}){
 // Explicit allowlist: caller objects, answers, source bodies and raw tasks never survive projection.
 const rows=sortRows(options.rows.map(r=>({path:r.path,status:r.status,...(r.hash?{hash:r.hash}:{}),...(r.status==='unscored'?{reason:r.reason??'not_evaluated'}:{relevance:r.relevance,role:r.role,...(r.uncertainty?{uncertainty:{provenance:r.uncertainty.provenance,confidence:r.uncertainty.confidence}}:{})})})));
 if(new Set(rows.map(r=>r.path)).size!==rows.length)throw Error('duplicate_identity');
 const counts=resultCounts(rows),evaluationComplete=options.evaluationComplete??counts.unscored===0;
 const skipped=rows.length>0&&rows.every(r=>r.status==='unscored'&&['consumer_off','not_approved'].includes(r.reason??''));
 const status=options.cancelled?'cancelled':skipped?'skipped':!counts.evaluated&&!counts.cached&&counts.failed?'unavailable':options.discoveryComplete&&evaluationComplete?'complete':'partial';
 return {resultId:randomUUID(),taskHash:options.identity.taskHash,queryHash:options.identity.queryHash,model:options.identity.model,policyVersion:POLICY_VERSION,questionVersion:QUESTION_VERSION,status,discoveryComplete:options.discoveryComplete,evaluationComplete,remaining:options.discoveryComplete?0:'unknown',hidden:options.hidden??0,counts,rows};
}
export type DiscoveryResult=ReturnType<typeof createResult>;
// Each managed page is a separate file under a fresh runtime-owned directory. Only the first locator is returned.
export function writeResultPages(artifactRoot:string,result:DiscoveryResult,maxBytes:number,readbackHandles=false):PageLocator {
 const root=realpathSync(artifactRoot);if(lstatSync(artifactRoot).isSymbolicLink()||! /^[0-9a-f-]{36}$/.test(result.resultId))throw Error('artifact_denied');
 const dir=join(root,'file-discovery-'+result.resultId);mkdirSync(dir,{mode:0o700});
 const {rows,...metadata}=result;
 const envelope=(pageIndex:number,offset:number,pageRows:ResultRow[],next:PageLocator|null)=>({schema:'file-discovery/page/v1',...metadata,pageIndex,total:rows.length,offset,rows:pageRows,next});
 // Reserve the largest next locator/envelope up front, so no page can overflow after chaining.
 const handle=(path:string,hash:string)=>'t5:'+Buffer.from(JSON.stringify({v:1,kind:'file',path,hash,offset:0})).toString('base64url');
 const reservePath=join(dir,'page-999999.json');
 const reserve:PageLocator={path:reservePath,hash:'0'.repeat(64),resultId:result.resultId,pageIndex:999999,...(readbackHandles?{handle:handle(reservePath,'0'.repeat(64))}:{})};
 const chunks:{offset:number;rows:ResultRow[]}[]=[];let chunk:ResultRow[]=[],offset=0;
 for(const row of rows){
  if(Buffer.byteLength(JSON.stringify(envelope(999999,999999,[...chunk,row],reserve)))>maxBytes){
   if(!chunk.length)throw Error('result_page_too_small');chunks.push({offset,rows:chunk});offset+=chunk.length;chunk=[];
   if(Buffer.byteLength(JSON.stringify(envelope(999999,999999,[row],reserve)))>maxBytes)throw Error('result_page_too_small');
  }chunk.push(row);
 }
 if(chunk.length||!chunks.length)chunks.push({offset,rows:chunk});
 let next:PageLocator|null=null;
 for(let i=chunks.length-1;i>=0;i--){
  const body:string=JSON.stringify(envelope(i,chunks[i].offset,chunks[i].rows,next));if(Buffer.byteLength(body)>maxBytes)throw Error('result_page_too_small');
  const path=join(dir,`page-${i}.json`);writeFileSync(path,body,{flag:'wx',mode:0o600});const hash=sourceHash(body);next={path,hash,resultId:result.resultId,pageIndex:i,...(readbackHandles?{handle:handle(path,hash)}:{})};
 }
 return next!;
}
export function readResultPage(artifactRoot:string,locator:PageLocator,maxBytes:number){
 const root=realpathSync(artifactRoot);
 if(lstatSync(artifactRoot).isSymbolicLink()||!locator||! /^[0-9a-f-]{36}$/.test(locator.resultId)||!Number.isSafeInteger(locator.pageIndex)||locator.pageIndex<0||! /^[0-9a-f]{64}$/.test(locator.hash)||locator.path!==join(root,'file-discovery-'+locator.resultId,`page-${locator.pageIndex}.json`))throw Error('artifact_denied');
 const body=safeSourceRead(root,locator.path,maxBytes);if(sourceHash(body)!==locator.hash)throw Error('page_changed');
 const page=JSON.parse(body.toString('utf8'));if(page.resultId!==locator.resultId||page.pageIndex!==locator.pageIndex)throw Error('page_identity');return page;
}
