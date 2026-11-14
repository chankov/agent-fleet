import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {lstatSync,realpathSync} from 'node:fs';
import {relative,resolve} from 'node:path';
import {checkedSourcePath} from '../../lib/safe-source-read.js';
import {exportPathAllowed} from '../agentic-sources.ts';
import {adaptDiscovery,canonicalCandidate,type CandidateSet} from './adapters.ts';
import {rankCandidates} from './sources.ts';
import type {FileDiscoveryConfig} from './evaluate.ts';
import type {System1Service} from '../../lib/system1/contracts.ts';
// Use the pinned Pi dependency for filtering immediate ls names, never for traversal.
const minimatch=(path:string,pattern:string,options:object):boolean=>createRequire(import.meta.resolve('@earendil-works/pi-coding-agent'))('minimatch').minimatch(path,pattern,options);
// Resolve the optional native discovery dependency only when requested. Off,
// explicit paths and automatic result adapters must import without a local Pi package.
type FindArgs={pattern:string;path:string;limit:number;tool?:'ls'};
export interface FindRequest {cwd:string;args:FindArgs;signal:AbortSignal}
type FindResponse={ok:true;result:unknown}|{ok:false;reason:string};
export type FindRun=(request:FindRequest)=>Promise<FindResponse>;
interface BatchResponse {completed:{args:FindArgs;response:FindResponse}[];reason?:string}
// One isolated actual Pi process per job avoids charging module startup once per pattern/root.
// No custom glob, shell, installer or parent-global PI_OFFLINE mutation.
async function runPiFindBatch(cwd:string,requests:FindArgs[],signal:AbortSignal,onCompleted?:(args:FindArgs,response:FindResponse)=>boolean):Promise<BatchResponse>{
 if(signal.aborted)return {completed:[],reason:'cancelled'};
 if(process.platform==='win32')return {completed:[],reason:'unsupported_platform'};
 return new Promise(resolveRun=>{
  const preloads=process.execArgv.flatMap((a,i,all)=>a.startsWith('--import=')?[a]:a==='--import'&&all[i+1]?[a,all[i+1]]:[]);
  const child=spawn(process.execPath,[...preloads,fileURLToPath(new URL('./discovery-worker.mjs',import.meta.url))],{detached:true,stdio:['pipe','pipe','pipe'],env:{PATH:process.env.PATH,HOME:process.env.HOME,PI_CODING_AGENT_DIR:process.env.PI_CODING_AGENT_DIR,PI_OFFLINE:'1'}});
  let output='',size=0,reason:string|undefined,killTimer:ReturnType<typeof setTimeout>|undefined;
  const completed:BatchResponse['completed']=[];
  const kill=(signal:NodeJS.Signals)=>{try{if(child.pid)process.kill(-child.pid,signal);}catch{}};
  const stop=(why:string)=>{if(reason)return;reason=why;kill('SIGTERM');killTimer=setTimeout(()=>kill('SIGKILL'),100);};
  const abort=()=>stop('cancelled');signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data',(b:string)=>{
   size+=Buffer.byteLength(b);if(size>262144){stop('output_limit');return;}output+=b;
   while(output.includes('\n')){
    const index=output.indexOf('\n'),line=output.slice(0,index);output=output.slice(index+1);
    try{const message=JSON.parse(line),expected=requests[completed.length];
     if(!expected||JSON.stringify(message.args)!==JSON.stringify(expected))throw Error('identity');
     const response:FindResponse=message.ok===true?{ok:true,result:message.result}:{ok:false,reason:message.reason??'unavailable'};
     completed.push({args:expected,response});if(onCompleted?.(expected,response))stop('candidate_limit');
    }catch{stop('unknown_shape');}
   }
  });
  child.stderr.resume();child.stdin.on('error',()=>{});child.on('error',()=>{reason=reason??'unavailable';});
  child.on('close',code=>{
   signal.removeEventListener('abort',abort);if(killTimer)clearTimeout(killTimer);
   // fd may ignore SIGTERM or outlive the wrapper. Terminate remaining group members before returning.
   if(reason)kill('SIGKILL');
   resolveRun({completed,...(reason||code!==0||completed.length<requests.length?{reason:reason??'unavailable'}:{})});
  });
  child.stdin.end(JSON.stringify({cwd,requests}));
 });
}
export const runPiFind:FindRun=async request=>{
 const batch=await runPiFindBatch(request.cwd,[request.args],request.signal);
 return batch.completed[0]?.response??{ok:false,reason:batch.reason??'unavailable'};
};
export async function discoverCandidates(options:{root:string;cwd?:string;config:FileDiscoveryConfig;paths?:readonly string[];patterns?:readonly string[];directories?:readonly string[];recursive?:boolean;signal:AbortSignal;runFind?:FindRun;runLs?:FindRun;canDiscover(path:string):boolean}):Promise<CandidateSet> {
 const root=realpathSync(options.root),cwd=resolve(options.cwd??root),paths=new Set<string>();let complete=true,reason:string|undefined,hidden=0,excluded=0;
 if(options.config.mode!=='active'||!options.config.remoteContextApproved)return {paths:[],discoveryComplete:false,remaining:'unknown',reason:options.config.mode==='active'?'not_approved':'consumer_off'};
 const controller=new AbortController();let deadline=false;
 const abort=()=>controller.abort();options.signal.addEventListener('abort',abort,{once:true});if(options.signal.aborted)abort();
 const timer=setTimeout(()=>{deadline=true;controller.abort();},options.config.limits.discoveryMs);
 const allowed=(full:string)=>{
  try{checkedSourcePath(root,full);const rel=relative(root,full);return exportPathAllowed(rel,options.config.include)&&options.canDiscover(full);}catch{return false;}
 };
 const add=(path:string)=>{
  if(!options.canDiscover(path)){hidden++;return;}
  if(!allowed(path))return;
  const candidate=canonicalCandidate(root,path,options.config.include);if(!candidate)return;
  if(paths.size>=options.config.limits.maxCandidates&&!paths.has(candidate)){complete=false;reason='candidate_limit';return;}
  paths.add(candidate);
 };
 try{
  for(const path of options.paths??[]){
   if(controller.signal.aborted)break;
   try{
    const full=checkedSourcePath(root,resolve(cwd,path));
    if(!lstatSync(full).isFile()||!options.canDiscover(full)){hidden++;continue;}
    const candidate=relative(root,full).split('\\').join('/');
    if(paths.size>=options.config.limits.maxCandidates&&!paths.has(candidate)){complete=false;reason='candidate_limit';continue;}
    // Explicit displayable identities survive export refusal for a denied ranking row.
    paths.add(candidate);
   }catch{hidden++;}
  }
  // Include roots are workspace-relative, not relative to a subdirectory caller cwd.
  const dirs=options.directories?.length?options.directories.map(d=>resolve(cwd,d)):options.patterns?.length?options.config.include.map(d=>resolve(root,d)):[];
  const requests:FindArgs[]=[];
  for(const full of dirs){
   if(controller.signal.aborted)break;
   if(!exportPathAllowed(relative(root,full),options.config.include)||!options.canDiscover(full)){complete=false;reason='scope_denied';continue;}
   try{checkedSourcePath(root,full);if(!lstatSync(full).isDirectory())throw Error('invalid_directory');}catch{complete=false;reason='invalid_directory';continue;}
   for(const pattern of options.patterns?.length?options.patterns:['**']){
    if(!pattern||Buffer.byteLength(pattern)>4096||/[\\\x00-\x1f]/.test(pattern)||pattern.startsWith('/')||pattern.split('/').includes('..')||options.recursive===false&&pattern.includes('/')){complete=false;reason='invalid_pattern';continue;}
    requests.push({pattern,path:full,limit:options.config.limits.maxCandidates,...(options.recursive===false?{tool:'ls' as const}:{})});
   }
  }
  if(Buffer.byteLength(JSON.stringify({cwd:root,requests}))>32768)throw Error('request_too_large');
  const consume=(args:FindArgs,response:FindResponse)=>{
   if(!response.ok){complete=false;reason=response.reason;return false;}
   const adapted=adaptDiscovery({tool:args.tool??'find',args:{path:args.path},result:response.result,cwd:root,root,include:options.config.include});
   excluded+=adapted.excluded??0;
   if(!adapted.discoveryComplete){complete=false;reason=adapted.reason??'candidate_limit';}
   for(const path of adapted.paths){
    if(args.tool==='ls'&&!minimatch(relative(args.path,resolve(root,path)),args.pattern,{dot:true,nonegate:true,nocomment:true}))continue;
    add(resolve(root,path));
   }
   return paths.size>=options.config.limits.maxCandidates;
  };
  if(requests.length&&paths.size<options.config.limits.maxCandidates&&!controller.signal.aborted){
   let batch:BatchResponse;
   if(requests.every(args=>args.tool==='ls'?options.runLs:options.runFind)){const completed:BatchResponse['completed']=[];for(const args of requests){if(controller.signal.aborted)break;const run=args.tool==='ls'?options.runLs!:options.runFind!;const response=await run({cwd:root,args,signal:controller.signal});completed.push({args,response});if(consume(args,response)){reason='candidate_limit';complete=false;break;}}batch={completed};}
   else batch=await runPiFindBatch(root,requests,controller.signal,consume);
   if(batch.reason){complete=false;reason=batch.reason;}
  }else if(requests.length){complete=false;reason=reason??'candidate_limit';}
  if(controller.signal.aborted){complete=false;reason=deadline?'deadline':'cancelled';}
 }catch{complete=false;reason=controller.signal.aborted?(deadline?'deadline':'cancelled'):'unavailable';}
 finally{clearTimeout(timer);options.signal.removeEventListener('abort',abort);}
 return {paths:[...paths].sort(),discoveryComplete:complete,remaining:complete?0:'unknown',hidden,excluded,...(reason?{reason}:{})};
}
export async function discoverAndRank(options:Parameters<typeof discoverCandidates>[0]&{task:string;service:System1Service;canDisplay(path:string):boolean;canRead?(path:string):boolean}){
 const discovery=await discoverCandidates(options);
 const ranked=await rankCandidates({...options,paths:discovery.paths,hidden:discovery.hidden});return {...ranked,discovery};
}
