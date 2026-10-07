import type {DiscoveryDiagnostic} from '../system1-communication-store.ts';
import {realpathSync,statSync} from 'node:fs';
import type {System1Service} from '../../lib/system1/contracts.ts';
import {sourceHash} from '../agentic-sources.ts';
import {composeQuestions,evaluateFile,POLICY_VERSION,type FileDiscoveryConfig,type FileEvaluation,type ReadySource} from './evaluate.ts';
import {rankCandidates} from './sources.ts';
import {createResult} from './results.ts';
import {createDiscoveryBudget,type DiscoveryCounter} from './state.ts';
// Object keys are canonical; arrays (including ordinal levels) retain order.
export function canonicalHash(value:unknown):string {
 const canonical=(v:any):any=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
 return sourceHash(JSON.stringify(canonical(value)));
}
// Only this causal marker denotes a D9 request deadline; generic aborts remain cancellation.
export const DISCOVERY_DEADLINE=Object.freeze({type:'file_discovery_deadline'} as const);
export type DiscoveryDeadlineCause=typeof DISCOVERY_DEADLINE;
export function isDiscoveryDeadline(reason:unknown):reason is DiscoveryDeadlineCause {return reason===DISCOVERY_DEADLINE;}
type Score=FileEvaluation & {cached?:boolean};
type Work={owner:string;key:string;controller:AbortController;waiters:Set<symbol>;run():Promise<Score>;resolve(value:Score):void;promise:Promise<Score>};
export interface DiscoveryJob {owner:string;attempt?:string;trigger?:string;task:string;query:string;paths:readonly string[];discoveryComplete:boolean;hidden?:number;signal?:AbortSignal;context?():string;customQuestions?:unknown;canDisplay(path:string):boolean;canRead(path:string):boolean;permissionIdentity():string}
export function createDiscoveryRuntime(options:{root:string;sessionId:string;config:FileDiscoveryConfig;service?:System1Service;provider?:string;model?:string;context():string;persist(s:DiscoveryCounter):void;restored?:DiscoveryCounter|null;observe?(metadata:DiscoveryDiagnostic):(summary:unknown)=>void;clock?:{setTimeout:typeof setTimeout;clearTimeout:typeof clearTimeout}}) {
 const config=options.config,root=realpathSync(options.root),stat=statSync(root),workspace=[root,stat.dev,stat.ino];
 const budget=createDiscoveryBudget(options.sessionId,options.persist,options.restored),lifetime=new AbortController();
 const cache=new Map<string,FileEvaluation>(),inflight=new Map<string,Work>(),queues=new Map<string,Work[]>(),owners:string[]=[];
 const jobs=new Map<AbortController,{context:string;current():string}>();let active=0,lastOwner='',authStopped=false;
 const clock=options.clock??{setTimeout,clearTimeout};
 const unscored=(reason:string):Score=>({status:'unscored',reason});
 const pump=()=>{
  while(active<config.limits.concurrency&&owners.length){
   // Reinsert owners at the tail; never drain one owner's backlog first.
   if(owners.length>1&&owners[0]===lastOwner)owners.push(owners.shift()!);
   const owner=owners.shift()!,queue=queues.get(owner)!,work=queue.shift()!;lastOwner=owner;
   if(queue.length)owners.push(owner);else queues.delete(owner);
   if(work.controller.signal.aborted){work.resolve(unscored('cancelled'));continue;}
   active++;
   let onAbort!:()=>void;
   const cancelled=new Promise<Score>(resolve=>{onAbort=()=>resolve(unscored('cancelled'));work.controller.signal.addEventListener('abort',onAbort,{once:true});});
   void Promise.race([work.run(),cancelled]).catch(()=>unscored('unavailable')).then(result=>{
    if(work.controller.signal.aborted||lifetime.signal.aborted)result=unscored('cancelled');
    if(result.status==='scored'){cache.set(work.key,result);while(cache.size>config.limits.maxCacheEntries)cache.delete(cache.keys().next().value!);}
    work.resolve(result);
   }).finally(()=>{work.controller.signal.removeEventListener('abort',onAbort);active--;if(inflight.get(work.key)===work)inflight.delete(work.key);pump();});
  }
 };
 const score=async(job:DiscoveryJob,source:ReadySource,signal:AbortSignal,context:string,permission:string,metrics:{logicalCalls:number;attempts:number|null;usage:{inputTokens:number;outputTokens:number}|null}):Promise<Score>=>{
  const current=async()=>!signal.aborted&&(job.context??options.context)()===context&&job.permissionIdentity()===permission&&await source.current(signal);
  if(!await current())return unscored(signal.aborted?'cancelled':'changed');
  const questions=composeQuestions(job.customQuestions);if(!questions)return unscored('invalid_input');
  const key=canonicalHash({workspace,context,path:source.path,hash:source.hash,task:job.task,query:job.query,questions,policy:POLICY_VERSION,provider:options.provider??'typesafe',model:options.model??'jev-1.13.0',permission,include:config.include});
  const hit=cache.get(key);if(hit)return await current()?{...structuredClone(hit),cached:true}:unscored('changed');
  let work=inflight.get(key);
  if(!work){
   const controller=new AbortController();let resolve!:(s:Score)=>void;
   const promise=new Promise<Score>(r=>resolve=r);
   work={owner:job.owner,key,controller,waiters:new Set(),promise,resolve,async run(){
    if(authStopped)return unscored('auth');
    if(!options.service)return unscored('unavailable');
    if((job.context??options.context)()!==context||job.permissionIdentity()!==permission||!await source.current(controller.signal))return unscored('changed');
    const service:System1Service={async evaluate(request){
     if(controller.signal.aborted)return {status:'cancelled'};
     if(authStopped)return {status:'unavailable',reason:'auth'};
     const reserved=budget.reserve(config.limits.maxCallsPerSession);
     if(reserved!=='ok')throw Error(reserved);
     metrics.logicalCalls++;
     const previousAttempts=metrics.attempts,previousUsage=metrics.usage;metrics.attempts=null;metrics.usage=null;
     const result=await options.service!.evaluate(request);
     if(result.status==='ok'){
      const m=result.evaluation.metadata;
      if(Number.isSafeInteger(m.attempts)&&m.attempts>=0&&previousAttempts!==null)metrics.attempts=previousAttempts+m.attempts;else metrics.attempts=null;
      if(m.usage&&Number.isFinite(m.usage.inputTokens)&&Number.isFinite(m.usage.outputTokens)&&previousUsage){metrics.usage={inputTokens:previousUsage.inputTokens+m.usage.inputTokens,outputTokens:previousUsage.outputTokens+m.usage.outputTokens};}else metrics.usage=null;
     }else{metrics.attempts=null;metrics.usage=null;}
     if(result.status==='unavailable'&&result.reason==='auth')authStopped=true;
     return result;
    }};
    try{const result=await evaluateFile({config,service,source:{...source,current:()=>source.current(controller.signal)},task:job.task,customQuestions:job.customQuestions,signal:controller.signal});
     return (job.context??options.context)()===context&&job.permissionIdentity()===permission?result:unscored('changed');}
    catch(error){return unscored(error instanceof Error?error.message:'unavailable');}
   }};
   inflight.set(key,work);const queue=queues.get(job.owner);if(queue)queue.push(work);else{queues.set(job.owner,[work]);owners.push(job.owner);}
  }
  const shared=work,waiter=Symbol();shared.waiters.add(waiter);
  return new Promise<Score>(resolve=>{
   let done=false;
   const finish=async(value:Score)=>{
    if(done)return;done=true;signal.removeEventListener('abort',abort);shared.waiters.delete(waiter);
    if(!shared.waiters.size){shared.controller.abort();if(inflight.get(key)===shared)inflight.delete(key);}
    resolve(signal.aborted?unscored('cancelled'):await current()?structuredClone(value):unscored('changed'));
   };
   const abort=()=>{void finish(unscored('cancelled'));};signal.addEventListener('abort',abort,{once:true});
   if(signal.aborted)abort();else{void shared.promise.then(finish);pump();}
  });
 };
 const dispose=()=>{lifetime.abort();for(const job of jobs.keys())job.abort();for(const work of inflight.values()){work.controller.abort();work.resolve(unscored('cancelled'));}queues.clear();owners.length=0;cache.clear();inflight.clear();};
 return {get enabled(){return config.mode==='active'&&config.remoteContextApproved&&!lifetime.signal.aborted;},get calls(){return budget.calls;},dispose,syncContext(){for(const [job,{context,current}] of jobs)if(context!==current())job.abort();},
 async rank(job:DiscoveryJob){
  const started=Date.now(),metrics={logicalCalls:0,attempts:0 as number|null,usage:{inputTokens:0,outputTokens:0} as {inputTokens:number;outputTokens:number}|null};
  let finish:((summary:unknown)=>void)|undefined;
  try{finish=options.observe?.({owner:job.owner==='hub'?'hub':sourceHash(job.owner),attempt:job.attempt?sourceHash(job.attempt):undefined,trigger:job.trigger,provider:options.provider??'typesafe',model:options.model??'jev-1.13.0'});}catch{/* observer only */}
  const report=(result:ReturnType<typeof createResult>)=>{try{finish?.({...result,elapsedMs:Date.now()-started,...metrics,attempts:metrics.logicalCalls?metrics.attempts:null,usage:metrics.logicalCalls?metrics.usage:null});}catch{/* observer only */}return result;};
  const current=job.context??options.context,context=current(),permission=job.permissionIdentity(),controller=new AbortController();
  const identity={taskHash:sourceHash(job.task),queryHash:sourceHash(job.query),model:options.model??'jev-1.13.0'};
  const refused=(reason:string)=>report(createResult({identity,discoveryComplete:job.discoveryComplete,rows:job.paths.filter(p=>job.canDisplay(root+'/'+p)).map(path=>({path,status:'unscored',reason})),cancelled:reason==='cancelled'}));
  if(lifetime.signal.aborted)return refused('cancelled');
  if(job.signal?.aborted)return refused(isDiscoveryDeadline(job.signal.reason)?'deadline':'cancelled');
  if(jobs.size>=config.limits.maxQueuedJobs+config.limits.concurrency)return refused('queue_full');
  if(!composeQuestions(job.customQuestions))return refused('invalid_input');
  jobs.set(controller,{context,current});const abort=()=>controller.abort(job.signal?.reason);job.signal?.addEventListener('abort',abort,{once:true});
  if(job.signal?.aborted)abort();
  const timer=clock.setTimeout(()=>controller.abort(DISCOVERY_DEADLINE),config.limits.jobTimeoutMs);
  try{
   const ranked=await rankCandidates({root,config,paths:job.paths,task:job.task,customQuestions:job.customQuestions,hidden:job.hidden,service:options.service??{evaluate:async()=>({status:'unavailable',reason:'invalid_config'})},signal:controller.signal,canDisplay:job.canDisplay,canRead:job.canRead,evaluate:source=>score(job,source,controller.signal,context,permission,metrics)});
   if(current()!==context||job.permissionIdentity()!==permission)return refused('changed');
   const deadline=controller.signal.aborted&&isDiscoveryDeadline(controller.signal.reason);
   if(deadline)for(const row of ranked.rows)if(row.status==='unscored'&&row.reason==='cancelled')row.reason='deadline';
   return report(createResult({...ranked,identity,discoveryComplete:job.discoveryComplete,cancelled:controller.signal.aborted&&!deadline}));
  }finally{clock.clearTimeout(timer);job.signal?.removeEventListener('abort',abort);jobs.delete(controller);}
 }
 };
}
export type DiscoveryRuntime=ReturnType<typeof createDiscoveryRuntime>;
