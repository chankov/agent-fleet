import type {ExtensionAPI} from '@mariozechner/pi-coding-agent';
import {safeSourceRead} from '../../lib/safe-source-read.js';
import {sourceHash} from '../agentic-sources.ts';
import {adaptDiscovery} from './adapters.ts';
import {rankDiscovery} from './broker-client.ts';
import type {DiscoveryAssignment} from './owners.ts';

/** Explicitly loaded by the trusted common spawn registration; registers no tools. */
export default function registerDiscoveryChild(pi:ExtensionAPI):void {
 if(process.env.AF_D9_REGISTERED!=='1')return;
 const root=process.env.AF_D9_ROOT;
 let include:string[];try{include=JSON.parse(process.env.AF_D9_READ_ROOTS??'');if(!Array.isArray(include)||!include.every(p=>typeof p==='string'))return;}catch{return;}
 const assignment:DiscoveryAssignment={endpoint:process.env.AF_D9_ENDPOINT!,capability:process.env.AF_D9_CAPABILITY!,sessionId:process.env.AF_D9_SESSION_ID!,taskId:process.env.AF_D9_TASK_ID!,ownerId:process.env.AF_D9_OWNER_ID!,attemptId:process.env.AF_D9_ATTEMPT_ID!,queryHash:process.env.AF_D9_QUERY_HASH!};
 if(!root||!assignment.endpoint||!assignment.capability)return;
 let controller=new AbortController();const pending=new Map<string,Promise<any>>();
 const abort=()=>{controller.abort();pending.clear();};
 pi.on('session_shutdown',abort);pi.on('session_before_switch',abort);
 pi.on('tool_result',async(event,ctx)=>{
  if(!['find','ls','grep','filesystem'].includes(event.toolName)||event.toolName==='filesystem'&&(event.input as any)?.operation!=='inventory')return;
  const reply=(advice:unknown)=>({content:[...event.content,{type:'text' as const,text:'File discovery advice: '+JSON.stringify(advice)}],details:{...(event.details&&typeof event.details==='object'?event.details:{}),fileDiscovery:advice}});
  if(controller.signal.aborted)return reply({status:'cancelled'});
  const key=JSON.stringify([event.toolCallId,event.toolName,event.input,sourceHash(JSON.stringify(event.content))]);if(pending.has(key))return pending.get(key);
  const work=(async()=>{
   let result:any=event;const bounded=(event.details as any)?.boundedOutput;
   if(bounded){try{const body=safeSourceRead(root,bounded.contentPath,262144);if(sourceHash(body)!==bounded.sha256)throw Error();const {boundedOutput:_b,...details}=event.details as any;result={...event,content:[{type:'text',text:body.toString('utf8')}],details};}catch{return reply({status:'skipped',reason:'bounded_evidence_unavailable'});}}
   const candidates=adaptDiscovery({tool:event.toolName,args:event.input as any,result,cwd:ctx.cwd,root,include});
   if(candidates.paths.length<2)return reply({status:'skipped',reason:candidates.reason??'fewer_than_two_candidates',discoveryComplete:candidates.discoveryComplete});
   const response=await rankDiscovery(assignment,{paths:candidates.paths,discovery:{complete:candidates.discoveryComplete,...(!candidates.discoveryComplete?{reason:'truncated'}:{})}},controller.signal);
   if(controller.signal.aborted)return reply({status:'cancelled'});
   return reply(response.ok?response.result:{status:response.error==='cancelled'?'cancelled':'unavailable',reason:response.error,fallback:'Original discovery evidence is retained; continue ordinary permitted reads.'});
  })();pending.set(key,work);try{return await work;}finally{pending.delete(key);}
 });
}
