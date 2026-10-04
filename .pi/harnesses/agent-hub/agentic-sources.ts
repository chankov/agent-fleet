import {createHash} from 'node:crypto';
import {Worker} from 'node:worker_threads';
import {resolve} from 'node:path';
import {realpathSync} from 'node:fs';
import {checkedSourcePath} from '../lib/safe-source-read.js';
import {containsCommunicationSecret} from './system1-communication-store.ts';
import type {AgenticConfig,AgenticInput,SourceSummary} from './agentic-contract.ts';
import type {AgenticSources} from './agentic-runtime.ts';
export const sourceHash=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
const forbidden=/^(?:\.env(?:\..*)?|\.git|\.ssh|\.aws|\.npmrc|\.netrc|credentials?(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|ed25519)|.*\.(?:pem|key|p12|pfx|sqlite|db))$/i;
export function exportPathAllowed(path:string,include:readonly string[]):boolean {
 if(!path||path.startsWith('/')||/[\\\0*?]/.test(path)||path.split('/').some(p=>!p||p==='.'||p==='..'||forbidden.test(p)))return false;
 if(/(?:^|\/)(?:agent-sessions|sessions?|transcripts?|artifacts|node_modules|\.cache)(?:\/|$)/i.test(path))return false;
 if(path.startsWith('.ai/')||/^\.pi\/(?:coms|logs|state|runtime|agent-fleet-state)(?:\/|$)/.test(path))return false;
 return include.some(p=>{const prefix=p.replace(/\/$/,'');return path===prefix||path.startsWith(prefix+'/');});
}
export function readSourcesWorker(root:string,paths:string[],maxBytes:number,signal:AbortSignal,deadlineMs:number):Promise<Buffer[]> {
 if(signal.aborted)return Promise.reject(Error('cancelled'));
 return new Promise((resolve,reject)=>{
  const worker=new Worker(new URL('./agentic-sources-worker.mjs',import.meta.url),{workerData:{root,paths,maxBytes},// This worker is plain ESM; retain preloads (including the no-network guard),
   // not process-global V8/TLS flags or CLI --input-type that workers reject.
   execArgv:process.execArgv.flatMap((arg,i,all)=>arg.startsWith('--import=')?[arg]:arg==='--import'&&all[i+1]?[arg,all[i+1]]:[])});let done=false;
  const finish=(error?:Error,bodies?:Buffer[])=>{if(done)return;done=true;clearTimeout(timer);signal.removeEventListener('abort',abort);void worker.terminate();error?reject(error):resolve(bodies!);};
  const abort=()=>finish(Error('cancelled'));const timer=setTimeout(()=>finish(Error('collection_timeout')),deadlineMs);
  signal.addEventListener('abort',abort,{once:true});
  worker.on('message',m=>m.ok?finish(undefined,m.bodies.map((b:Uint8Array)=>Buffer.from(b))):finish(Error(m.reason)));
  worker.on('error',()=>finish(Error('evidence_unavailable')));worker.on('exit',()=>{if(!done)finish(Error('evidence_unavailable'));});
 });
}
export function createAgenticSources(options:{root:string;config:AgenticConfig;canRead(path:string):boolean;read?:typeof readSourcesWorker;resolveEvidence?(refs:string[],signal:AbortSignal):Promise<AgenticSources>}) {
 const root=realpathSync(options.root),read=options.read??readSourcesWorker;
 const approved=(path:string)=>{if(!exportPathAllowed(path,options.config.include))throw Error('source_denied');const full=resolve(root,path);if(!options.canRead(full))throw Error('source_denied');checkedSourcePath(root,full);return full;};
 return async(input:AgenticInput,signal:AbortSignal):Promise<AgenticSources>=>{
  const selections=input.paths??[],paths=selections.map(p=>approved(p.path));
  const bytes=paths.length?await read(root,paths,options.config.limits.maxSourceBytes,signal,options.config.limits.collectionMs):[];
  const sources=bytes.map((b,index)=>{
   if(containsCommunicationSecret(b.toString('utf8')))throw Error('source_denied');
   const selection=selections[index],lines=b.toString('utf8').split('\n');if(b.length&&b[b.length-1]===10)lines.pop();
   const start=selection.startLine??1,end=selection.endLine??Math.max(1,lines.length);
   if(start>lines.length||end>lines.length)throw Error('evidence_incomplete');
   const text=selection.startLine===undefined&&selection.endLine===undefined?b.toString('utf8'):lines.slice(start-1,end).join('\n');
   const summary:SourceSummary={kind:'file',ref:selection.path,hash:sourceHash(b),bytes:Buffer.byteLength(text),path:selection.path,startLine:start,endLine:end,totalLines:lines.length,complete:start===1&&end===lines.length};
   return {summary,text};
  });
  const evidence=input.evidenceRefs?.length?options.resolveEvidence?await options.resolveEvidence(input.evidenceRefs,signal):(()=>{throw Error('evidence_unavailable');})():{sources:[],current:async()=>true};
  return {sources:[...sources,...evidence.sources],async current(){
   try{const currentPaths=selections.map(p=>approved(p.path));const current=currentPaths.length?await read(root,currentPaths,options.config.limits.maxSourceBytes,signal,options.config.limits.collectionMs):[];return current.every((b,i)=>sourceHash(b)===sources[i].summary.hash)&&await evidence.current();}catch{return false;}
  }};
 };
}
