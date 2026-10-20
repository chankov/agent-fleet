import type {ExtensionAPI} from '@mariozechner/pi-coding-agent';
import {safeSourceRead} from '../../lib/safe-source-read.js';
import {damageCaptureState,originalDamageResult} from '../../lib/damage-result-evidence.ts';
import {damageResultView} from '../../lib/damage-result-view.ts';
import {sourceHash} from '../agentic-sources.ts';
import {adaptDiscovery} from './adapters.ts';
import {loadSystem1Snapshot,readSystem1Selected} from '../../lib/system1/config-loader.js';
import {FOREGROUND_MS} from './semantic-profiles.ts';
import {rankDiscovery} from './broker-client.ts';
import type {DiscoveryAssignment} from './owners.ts';

/** Explicitly loaded by the trusted common spawn registration; registers no tools. */
export default function registerDiscoveryChild(pi:ExtensionAPI):void {
 if(process.env.AF_D9_REGISTERED!=='1')return;
 const root=process.env.AF_D9_ROOT;
 let include:string[];try{include=JSON.parse(process.env.AF_D9_READ_ROOTS??'');if(!Array.isArray(include)||!include.every(p=>typeof p==='string'))return;}catch{return;}
 const assignment:DiscoveryAssignment={endpoint:process.env.AF_D9_ENDPOINT!,capability:process.env.AF_D9_CAPABILITY!,sessionId:process.env.AF_D9_SESSION_ID!,taskId:process.env.AF_D9_TASK_ID!,ownerId:process.env.AF_D9_OWNER_ID!,attemptId:process.env.AF_D9_ATTEMPT_ID!,queryHash:process.env.AF_D9_QUERY_HASH!};
 if(!root||!assignment.endpoint||!assignment.capability)return;
 const snapshot=loadSystem1Snapshot(root),semantic=snapshot.status==='ready'&&readSystem1Selected(root)&&snapshot.consumers.fileDiscovery.status==='ready'&&snapshot.consumers.fileDiscovery.config.semanticReads.mode==='active';
 let controller=new AbortController();const pending=new Map<string,Promise<any>>();
 const abort=()=>{controller.abort();pending.clear();};
 pi.on('session_shutdown',abort);pi.on('session_before_switch',abort);
 pi.on('tool_result',async(event,ctx)=>{
  if(!['find','ls','grep','filesystem'].includes(event.toolName)||event.toolName==='filesystem'&&!['inventory','stat'].includes((event.input as any)?.operation))return;
  const deadlineAt=Date.now()+FOREGROUND_MS;
  const statEvent=event.toolName==='filesystem'&&(event.input as any)?.operation==='stat';if(statEvent&&!semantic)return;
  const reply=(advice:unknown)=>damageResultView({...event,details:event.details===undefined?{fileDiscovery:advice}:event.details&&typeof event.details==='object'&&!Array.isArray(event.details)&&!Object.hasOwn(event.details,'fileDiscovery')?{...event.details,fileDiscovery:advice}:event.details},'File discovery advice: '+JSON.stringify(advice),advice,'fileDiscovery');
  if(controller.signal.aborted)return reply({status:'cancelled'});
  if(damageCaptureState(event)!=='captured')return reply({status:'skipped',reason:'original_capture_unavailable'});
  const evidence=originalDamageResult(event);if(!evidence)return reply({status:'skipped',reason:'original_capture_unavailable'});
  const key=JSON.stringify([evidence.toolCallId,evidence.toolName,evidence.input,sourceHash(JSON.stringify([evidence.content,evidence.details,evidence.structuredContent]))]);if(pending.has(key))return pending.get(key);
  const work=(async()=>{
   let result:any=evidence;const bounded=(evidence.details as any)?.boundedOutput;
   if(bounded){try{const body=safeSourceRead(root,bounded.contentPath,262144);if(sourceHash(body)!==bounded.sha256)throw Error();const {boundedOutput:_b,...details}=evidence.details as any;result={...evidence,content:[{type:'text',text:body.toString('utf8')}],details};}catch{return reply({status:'skipped',reason:'bounded_evidence_unavailable'});}}
   const candidates=adaptDiscovery({tool:evidence.toolName,args:evidence.input as any,result,cwd:ctx.cwd,root,include});
   if(!candidates.paths.length||candidates.paths.length<2&&!semantic)return reply({status:'skipped',reason:candidates.reason??'fewer_than_two_candidates',discoveryComplete:candidates.discoveryComplete});
   const response=await rankDiscovery(assignment,{paths:candidates.paths,foreground:semantic&&candidates.paths.length===1,discovery:{complete:candidates.discoveryComplete,...(!candidates.discoveryComplete?{reason:'truncated'}:{})}},controller.signal,semantic&&candidates.paths.length===1?Math.max(1,deadlineAt-Date.now()):undefined);
   if(controller.signal.aborted)return reply({status:'cancelled'});
   return reply(response.ok?response.result:{status:response.error==='cancelled'?'cancelled':'unavailable',reason:response.error,fallback:'Original discovery evidence is retained; continue ordinary permitted reads.'});
  })();pending.set(key,work);try{return await work;}finally{pending.delete(key);}
 });
}
