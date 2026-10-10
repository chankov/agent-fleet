import type {ExtensionAPI,ExtensionContext} from "@earendil-works/pi-coding-agent";
import {createHash,randomUUID} from "node:crypto";
import {SettingsManager} from "@earendil-works/pi-coding-agent";
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
 let ctx:ExtensionContext, pending=false,interrupted=false,restored=false,cancelled=false,running=false,armed=true,task="",turn=0;
 let instructions="Preserve the task, tool results, decisions, scope, permissions and next allowed step. Do not repeat side effects.";
 let lastCompacted:number|null=null;
 let waitingUser=false;
 const status:ContextOwnerStatus={phase:"running",episode:0,tokens:null,window:null,cacheRead:null,cacheWrite:null,input:null,output:null};
 const publish=async(phase:ContextOwnerStatus["phase"])=>{status.phase=phase;const usage=ctx?.getContextUsage();status.tokens=usage?.tokens??null;status.window=usage?.contextWindow??ctx?.model?.contextWindow??null;if(!channel)return {status:"unavailable"};return await contextChannelCall(channel,"context_status",status);};
 const coordinator=new ContextContinuityCoordinator({
  identity:()=>({session:ctx.sessionManager.getSessionId(),task:assignment.owner,revision:1,owner:assignment.owner,attempt:1}),
  eligibility:()=>({active:interrupted,cancelled,completed:!interrupted,waitingUser,budgetBlocked:false}),
  compact:customInstructions=>new Promise<void>((resolve,reject)=>ctx.compact({customInstructions,onComplete:()=>resolve(),onError:reject})),
  restore:async()=>{if(restored && interrupted)await publish("continued");return restored;},
  replayUser:()=>false,
  continueTask:()=>{status.phase="continued";pi.sendMessage({customType:"agent-fleet-context-continuation",content:"Continue the same authorized physical attempt after compaction. Do not repeat completed effects or open a new task.",display:false},{triggerTurn:true});},
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
  if(projected/window<0.8)armed=true;
  if(armed && projected/window>=0.9){pending=true;interrupted=true;await publish("pending");ctx.abort();}
 });
 pi.on("context",(_event,context)=>{ctx=context;if(pending){interrupted=true;ctx.abort();}});
 pi.on("session_compact",async()=>{restored=true;armed=false;pending=false;lastCompacted=ctx.getContextUsage()?.tokens??null;await publish("recovered");});
 pi.on("turn_end",async(_event,context)=>{
  ctx=context;turn++;const usage=ctx.getContextUsage();const tokens=usage?.tokens??null,window=usage?.contextWindow??ctx.model?.contextWindow??null;
  if(tokens!==null && window && tokens/window>=0.9 && armed)pending=true;
  const result=await publish(pending?"pending":"running");
  const directive=result?.directive;
  if(directive?.type==="compact" && directive.owner===assignment.owner && directive.attempt===assignment.attempt && directive.episode===status.episode && status.phase==="pending" && !cancelled)pending=true;
  if(waitingUser || pending || tokens===null || window===null || tokens/window<0.6 || tokens/window>=0.9 || cancelled)return;
  const settings=SettingsManager.create(ctx.cwd).getCompactionSettings(ctx.model),keep=settings.keepRecentTokens;
  const responseTokens=compactionResponseReserve(settings,ctx.model?.maxTokens);
  if(lastCompacted!==null && tokens<=lastCompacted+keep)return;
  if(!channel)return;
  const reply=await contextChannelCall(channel,"context_assessment",{identity:ctx.sessionManager.getSessionId(),task:"Continue the owned task; task bodies, artifacts and tool output are not exported by the child adapter.",revision:1,turn,tokens,window,historyTokens:estimatePromptTokens(JSON.stringify(ctx.sessionManager.getBranch().filter(e=>e.type==="message"))),keepRecentTokens:keep,responseTokens,unsafe:false});
  try{pi.appendEntry("agent-fleet-context-assessment",contextAssessmentMetadata(reply.assessment,{tokens,window,responseTokens,turn}));}catch{}
  if(reply.owner===assignment.owner && reply.attempt===assignment.attempt && reply.assessment?.compact===true && typeof reply.assessment.instructions==="string" && reply.assessment.instructions.length<2048){pending=true;instructions=reply.assessment.instructions;}
 });
 pi.on("agent_settled",async(event,context)=>{
  ctx=context;if(event.aborted && !interrupted){cancelled=true;coordinator.fence();await publish("cancelled");return;}
  if(!pending || running || cancelled)return;running=true;pending=false;restored=false;armed=false;
  const capsule=coordinator.request("Continue current permitted step without replaying effects");status.episode=capsule.episode;
  await publish("compacting");const ok=await coordinator.run(instructions);running=false;await publish(ok?(interrupted?"continued":"recovered"):"failed");interrupted=false;
 });
}
