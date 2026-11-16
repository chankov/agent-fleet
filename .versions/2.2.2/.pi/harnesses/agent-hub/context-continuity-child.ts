import { createCompactionMonitor } from "./context-compaction-monitor.ts";
import { COMPACTION_MIN_PERCENT, COMPACTION_EARLY_PERCENT, COMPACTION_TARGET_PERCENT, COMPACTION_MAX_PERCENT, compactionRearmed, compactionShortOfTarget } from "../lib/context-compaction-policy.js";
import type {ExtensionAPI,ExtensionContext} from "@earendil-works/pi-coding-agent";
import {createHash,randomUUID} from "node:crypto";
import {SettingsManager,buildSessionContext} from "@earendil-works/pi-coding-agent";
import {currentPiRuntimeVersion,contextContinuityCompatibility} from "./context-continuity-compat.ts";
import {ContextContinuityCoordinator} from "./context-continuity.ts";
import {CONTEXT_CHANNEL_ENV,parseContextChannel,contextChannelCall} from "./context-continuity-client.ts";
import type {ContextOwnerStatus} from "./context-continuity-owners.ts";
import {estimatePromptTokens} from "./context-window.js";
import {compactionResponseReserve} from "./context-compaction-runtime.ts";
import {contextAssessmentMetadata} from "./context-compaction.ts";
/** Trusted common physical-attempt adapter. Never receives System1 credentials. */
export default function contextContinuityChild(pi:ExtensionAPI) {
 const channel=parseContextChannel(process.env[CONTEXT_CHANNEL_ENV]);
 if(!contextContinuityCompatibility(currentPiRuntimeVersion()).supported)return;
 const assignment=channel??{socket:"",owner:createHash("sha256").update(randomUUID()).digest("hex"),attempt:randomUUID(),token:""};
 const monitor=createCompactionMonitor(event=>{try{pi.appendEntry("agent-fleet-compaction-monitor",event);}catch{}});
 let ctx:ExtensionContext, pending=false,interrupted=false,restored=false,cancelled=false,running=false,armed=true,task="",turn=0;
 let instructions="Preserve the task, tool results, decisions, scope, permissions and next allowed step. Do not repeat side effects.";
 // First measured usage after the last compaction: Pi reports none until the next response.
 let compacted:number|null=null,awaitingCompacted=false,ceilingNoticed=false;
 let waitingUser=false;
 const measure=(tokens:number|null|undefined,window:number|null|undefined)=>{
  if(tokens==null || !window)return;
  if(awaitingCompacted){compacted=tokens;awaitingCompacted=false;}
  if(!armed && compactionRearmed(compacted,tokens,window))armed=true;
 };
 const status:ContextOwnerStatus={phase:"running",episode:0,tokens:null,window:null,cacheRead:null,cacheWrite:null,input:null,output:null};
 const publish=async(phase:ContextOwnerStatus["phase"],usage=ctx?.getContextUsage())=>{status.phase=phase;status.tokens=usage?.tokens??null;status.window=usage?.contextWindow??ctx?.model?.contextWindow??null;if(!channel)return {status:"unavailable"};return await contextChannelCall(channel,"context_status",status);};
 const coordinator=new ContextContinuityCoordinator({
  identity:()=>({session:ctx.sessionManager.getSessionId(),task:assignment.owner,revision:1,owner:assignment.owner,attempt:1}),
  eligibility:()=>({active:interrupted,cancelled,completed:!interrupted,waitingUser,budgetBlocked:false}),
  compact:customInstructions=>new Promise<void>((resolve,reject)=>{monitor.record("started",ctx.getContextUsage());ctx.compact({customInstructions,onComplete:()=>resolve(),onError:reject});}),
  restore:async()=>{return restored;},
  replayUser:()=>false,
  continueTask:()=>{monitor.record("continuation_requested",ctx.getContextUsage());status.phase="continued";pi.sendMessage({customType:"agent-fleet-context-continuation",content:"Continue the same authorized physical attempt after compaction. Do not repeat completed effects or open a new task.",display:false},{triggerTurn:true});},
 });
 pi.on("session_start",async(_event,context)=>{ctx=context;await publish("running");});
 pi.on("input",event=>{if(event.source!=="extension"){task=event.text;waitingUser=false;}});
 pi.on("tool_execution_start",(event:any)=>{if(event.toolName==="ask_user")waitingUser=true;});
 pi.on("tool_result",(event:any)=>{if(event.toolName==="ask_user" && !event.isError)waitingUser=false;});
 pi.on("message_end",async(event,context)=>{ctx=context;if(event.message.role==="assistant" && "usage" in event.message){const u=event.message.usage;status.input=u.input;status.output=u.output;status.cacheRead=u.cacheRead;status.cacheWrite=u.cacheWrite;}
  if(event.message.role!=="toolResult")return;
  const usage=ctx.getContextUsage();const window=usage?.contextWindow??ctx.model?.contextWindow;
  if(usage?.tokens==null || !window)return;
  const projected=usage.tokens+estimatePromptTokens(JSON.stringify(event.message.content));
  measure(usage.tokens,window);
  if(projected/window<COMPACTION_EARLY_PERCENT/100)armed=true;
  if(armed && projected/window>=COMPACTION_TARGET_PERCENT/100){pending=true;interrupted=true;await publish("pending");ctx.abort();}
 });
 pi.on("context",(_event,context)=>{ctx=context;const usage=ctx.getContextUsage();
  if((usage?.percent??0)>=COMPACTION_MAX_PERCENT && !pending && !running){
   const window=usage?.contextWindow??ctx.model?.contextWindow;measure(usage?.tokens,window);
   if(armed)pending=true;
   // A compacted baseline between target and ceiling re-arms by growth instead.
   else if(compactionShortOfTarget(compacted,window)){if(!ceilingNoticed){ceilingNoticed=true;monitor.record("ceiling_exceeded",usage);}}
   else {monitor.record("ceiling_blocked",usage);ctx.abort();return;}
  }
  if(pending){interrupted=true;ctx.abort();}});
 pi.on("session_compact",async()=>{restored=true;monitor.record("restored",ctx.getContextUsage());armed=false;pending=false;compacted=null;awaitingCompacted=true;ceilingNoticed=false;await publish("recovered");});
 pi.on("turn_end",async(_event,context)=>{
  ctx=context;turn++;const usage=ctx.getContextUsage();monitor.observe(usage);const tokens=usage?.tokens??null,window=usage?.contextWindow??ctx.model?.contextWindow??null;
  measure(tokens,window);
  if(tokens!==null && window && tokens/window>=COMPACTION_TARGET_PERCENT/100 && armed)pending=true;
  const result=await publish(pending?"pending":"running",usage);
  const directive=result?.directive;
  if(directive?.type==="compact" && directive.owner===assignment.owner && directive.attempt===assignment.attempt && directive.episode===status.episode && status.phase==="pending" && !cancelled)pending=true;
  if(!channel || waitingUser || pending || tokens===null || window===null || tokens/window<COMPACTION_MIN_PERCENT/100 || tokens/window>=COMPACTION_TARGET_PERCENT/100 || cancelled)return;
  const settings=SettingsManager.create(ctx.cwd).getCompactionSettings(ctx.model),keep=settings.keepRecentTokens;
  const responseTokens=compactionResponseReserve(settings,ctx.model?.maxTokens);
  if(compacted!==null && tokens<=compacted+keep)return;
  const reply=await contextChannelCall(channel,"context_assessment",{identity:ctx.sessionManager.getSessionId(),task:"Continue the owned task; task bodies, artifacts and tool output are not exported by the child adapter.",revision:1,turn,tokens,window,historyTokens:estimatePromptTokens(JSON.stringify(buildSessionContext(ctx.sessionManager.getBranch()).messages)),keepRecentTokens:keep,responseTokens,unsafe:false});
  try{pi.appendEntry("agent-fleet-context-assessment",contextAssessmentMetadata(reply.assessment,{tokens,window,responseTokens,turn}));}catch{}
  if(reply.owner===assignment.owner && reply.attempt===assignment.attempt && reply.assessment?.compact===true && typeof reply.assessment.instructions==="string" && reply.assessment.instructions.length<2048){pending=true;instructions=reply.assessment.instructions;}
 });
 pi.on("agent_settled",async(event,context)=>{
  ctx=context;if(event.aborted && !interrupted){cancelled=true;coordinator.fence();await publish("cancelled");return;}
  if(!pending || running || cancelled)return;running=true;pending=false;restored=false;armed=false;
  const capsule=coordinator.request("Continue current permitted step without replaying effects");status.episode=capsule.episode;
  await publish("compacting");const ok=await coordinator.run(instructions);running=false;if(!ok)monitor.record("failed",ctx.getContextUsage());await publish(ok?(interrupted?"continued":"recovered"):"failed");interrupted=false;
 });
}
