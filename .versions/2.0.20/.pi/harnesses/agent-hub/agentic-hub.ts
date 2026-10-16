import {resolve} from 'node:path';
import type {ExtensionAPI,ExtensionContext} from '@mariozechner/pi-coding-agent';
import type {System1Service} from '../lib/system1/contracts.ts';
import {readSystem1Selected,type loadSystem1Snapshot} from '../lib/system1/config-loader.js';
import {currentFileAccessAllowed} from '../lib/damage-control-shared.ts';
import {createAgenticRuntime,type AgenticRuntime} from './agentic-runtime.ts';
import {createAgenticEvidence,type AgenticEvidence} from './agentic-evidence.ts';
import {createAgenticSources,sourceHash} from './agentic-sources.ts';
import type {CommunicationStore} from './system1-communication-store.ts';
import {AGENTIC_COUNTER,restoreAgenticCounter} from './agentic-state.ts';
import type {AgenticConfig} from './agentic-contract.ts';
import {registerAskSystem1} from './tools/ask-system1.ts';
export const AGENTIC_CHILD_ENV='AGENT_FLEET_AGENTIC_CHILD';
export function agenticParentAllowed(env:NodeJS.ProcessEnv=process.env):boolean{return !env.AGENT_HUB_AGENT_ID&&!env[AGENTIC_CHILD_ENV];}
const sessions=new WeakMap<ExtensionAPI,{runtime:AgenticRuntime;evidence:AgenticEvidence}>();
export function agenticHubRuntime(pi:ExtensionAPI):AgenticRuntime|null{return agenticParentAllowed()?sessions.get(pi)?.runtime??null:null;}
export function agenticHubEnabled(pi:ExtensionAPI):boolean{return agenticParentAllowed()&&sessions.get(pi)?.runtime.enabled===true;}
export function resetAgenticHub(pi:ExtensionAPI):void{const prior=sessions.get(pi);prior?.runtime.dispose();prior?.evidence.dispose();sessions.delete(pi);}
export function configureAgenticHub(pi:ExtensionAPI,options:{snapshot:ReturnType<typeof loadSystem1Snapshot>;service?:System1Service;ctx:ExtensionContext;sessionDir:string;communicationStore?:CommunicationStore;taskId():string}) {
 resetAgenticHub(pi);
 const section=options.snapshot.consumers.agenticAsk;
 if(!agenticParentAllowed()||options.snapshot.status!=='ready'||section.status!=='ready'||!readSystem1Selected(options.ctx.cwd))return;
 const config=section.config as AgenticConfig,sessionId=options.ctx.sessionManager.getSessionId();
 const entries=()=>options.ctx.sessionManager.getEntries();
 const context=()=>{
  const last=[...entries()].reverse().find((r:any)=>r?.type==='message'&&r.message?.role==='user') as any;
  return sourceHash(JSON.stringify([options.taskId(),last?.message?.content??null]));
 };
 const canRead=(path:string)=>currentFileAccessAllowed(options.ctx.cwd,path);
 const evidence=createAgenticEvidence({config,sessionId,sessionDir:options.sessionDir,context,taskId:options.taskId,canRead});
 const collect=createAgenticSources({root:options.ctx.cwd,config,canRead,resolveEvidence:(refs,signal)=>evidence.resolve(refs,signal)});
 let restored=restoreAgenticCounter(entries(),sessionId);
 const persist=(s:any)=>pi.appendEntry(AGENTIC_COUNTER,s);
 // Persist the zero baseline too, so an enabled session with no evaluations
 // resumes unambiguously; a missing historical baseline fails closed.
 if(restored){try{persist(restored);}catch{restored=null;}}
 const runtime=createAgenticRuntime({config,service:options.service,sessionId,context,persist,restored,collect,observe:(id,status)=>options.communicationStore?.finishAgentic(id,status)});
 sessions.set(pi,{runtime,evidence});
}
export function registerAgenticHub(pi:ExtensionAPI):void {
 registerAskSystem1(pi,{runtime:()=>agenticHubRuntime(pi)});
 pi.on('tool_result',(event,ctx)=>{
  const session=sessions.get(pi);if(!session||!agenticHubEnabled(pi)||event.toolName!=='bash')return;
  const summary=session.evidence.capture(event,ctx.cwd);
  if(!summary)return;
  return {content:[...event.content,{type:'text',text:`Recorded advisory evidence ref: ${summary.ref} (${summary.truncation}; exit code ${summary.exitCode??'unknown'}).`}],details:{...(event.details&&typeof event.details==='object'?event.details:{}),agenticEvidence:summary}};
 });
 pi.on('tool_call',(event,ctx)=>{
  if(event.toolName!=='filesystem')return;
  const {handle,path}=(event.input as any),evidence=sessions.get(pi)?.evidence;
  if(typeof handle==='string'&&evidence?.canReadHandle(handle)===false || typeof path==='string'&&evidence?.canReadTarget(resolve(ctx.cwd,path))===false)return {block:true,reason:'Recorded evidence readback denied by current file-access policy or stale task/hash.'};
 });
 pi.on('session_shutdown',()=>resetAgenticHub(pi));
}
