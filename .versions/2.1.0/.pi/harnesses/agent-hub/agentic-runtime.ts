import { randomUUID } from 'node:crypto';
import type { JsonText, System1Result, System1Service } from '../lib/system1/contracts.ts';
import { AGENTIC_VERSION, validateAgenticInput, type AgenticConfig, type AgenticInput, type AgenticResult, type SourceSummary } from './agentic-contract.ts';
import { createAgenticBudget, type AgenticCounter } from './agentic-state.ts';
export interface AgenticSources { sources: { summary:SourceSummary; text:string }[]; current():Promise<boolean>; }
export function createAgenticRuntime(options:{ config?:AgenticConfig; service?:System1Service; sessionId:string; context():string; persist(s:AgenticCounter):void; restored?:AgenticCounter|null; parent?:boolean; observe?(evaluationId:string,status:AgenticResult['status']):void; collect?(input:AgenticInput,signal:AbortSignal):Promise<AgenticSources> }) {
 const budget=createAgenticBudget(options.sessionId,options.persist,options.restored);
 const lifetime=new AbortController();
 const config=options.config;
 const enabled=options.parent!==false&&(config?.mode==='advisory'||config?.mode==='recommended')&&config.remoteContextApproved===true;
 return { get enabled(){return enabled&&!lifetime.signal.aborted;}, get mode():AgenticConfig['mode']{return enabled&&!lifetime.signal.aborted&&config?config.mode:'off';}, get calls(){return budget.calls;}, dispose(){lifetime.abort();},
 async evaluate(value:unknown,signal?:AbortSignal):Promise<AgenticResult>{
  const evaluationId=randomUUID(); let sourceSummary:SourceSummary[]=[];
  const reply=(result:System1Result|{status:'skipped'|'unavailable'|'stale';reason:any},breakdown?:Record<string,number>):AgenticResult=>{
   try{options.observe?.(evaluationId,result.status);}catch{/* diagnostics never affect advice */}
   return {...result,evaluationId,advisory:true,sourceSummary,...(breakdown?{breakdown}:{})} as AgenticResult;
  };
  if(lifetime.signal.aborted||signal?.aborted)return reply({status:'cancelled'});
  if(options.parent===false||!config||config.mode==='off')return reply({status:'skipped',reason:'consumer_off'});
  if(!config.remoteContextApproved)return reply({status:'skipped',reason:'not_approved'});
  const validated=validateAgenticInput(value,config.limits);
  if(!validated.ok)return reply({status:'unavailable',reason:validated.reason},validated.breakdown);
  if(!options.service)return reply({status:'unavailable',reason:'invalid_config'});
  const input=validated.input, context=options.context(), call=new AbortController();
  const abort=()=>call.abort(); signal?.addEventListener('abort',abort,{once:true});lifetime.signal.addEventListener('abort',abort,{once:true});
  let timer:ReturnType<typeof setTimeout>|undefined;
  const cancellation=new Promise<never>((_,reject)=>call.signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true}));
  const race=<T>(p:Promise<T>)=>Promise.race([p,cancellation]);
  try {
   timer=setTimeout(abort,config.limits.collectionMs);
   const collected:AgenticSources=(input.paths?.length||input.evidenceRefs?.length) ? options.collect ? await race(options.collect(input,call.signal)) : (()=>{throw new Error('source_denied');})() : {sources:[],current:async()=>true};
   sourceSummary=collected.sources.map(s=>s.summary);
   if(call.signal.aborted)return reply({status:'cancelled'});
   const state={schema:AGENTIC_VERSION,owner:'hub',evaluationId,context,taskContextHash:context, state:input.state??null,sources:collected.sources.map(({summary:{readbackHandle:_localHandle,...summary},text})=>({...summary,text}))};
   const request={state:state as JsonText,questions:input.questions,questionSetVersion:AGENTIC_VERSION,timeoutMs:config.limits.timeoutMs};
   const breakdown={state:Buffer.byteLength(JSON.stringify(input.state??null)),questions:Buffer.byteLength(JSON.stringify(input.questions)),sources:Buffer.byteLength(JSON.stringify(state.sources)),framing:0,total:Buffer.byteLength(JSON.stringify(request))};
   breakdown.framing=breakdown.total-breakdown.state-breakdown.questions-breakdown.sources;
   if(breakdown.total>config.limits.maxRequestBytes)return reply({status:'unavailable',reason:'state_too_large'},breakdown);
   if(options.context()!==context || !await race(collected.current()))return reply({status:'unavailable',reason:'source_changed'});
   clearTimeout(timer);
   const reserved=budget.reserve(config.limits.maxCallsPerSession);
   if(reserved!=='ok')return reply({status:reserved==='budget_exhausted'?'skipped':'unavailable',reason:reserved});
   timer=setTimeout(abort,config.limits.timeoutMs);
   const result=await race(options.service.evaluate({...request,signal:call.signal}));
   if(call.signal.aborted)return reply({status:'cancelled'});
   if(result.status==='ok'&&(options.context()!==context||!await race(collected.current())))return reply({status:'stale',reason:'source_changed'});
   return reply(result);
  } catch(error) {
   if(call.signal.aborted)return reply(signal?.aborted||lifetime.signal.aborted?{status:'cancelled'}:{status:'unavailable',reason:'timeout'});
   const reason=(error as Error).message;
   return reply({status:'unavailable',reason:['source_denied','source_changed','evidence_incomplete','evidence_unavailable','state_too_large','collection_timeout'].includes(reason)?reason:'evidence_unavailable'});
  } finally {clearTimeout(timer);signal?.removeEventListener('abort',abort);lifetime.signal.removeEventListener('abort',abort);}
 }
 };
}
export type AgenticRuntime=ReturnType<typeof createAgenticRuntime>;
