import type {CommunicationStore} from '../system1-communication-store.ts';
import {mkdirSync,lstatSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import type {NativeDiscoveryInput,NativeDiscoveryContext} from './native-context.ts';
import type {OwnerLease} from './owners.ts';
import {resolve,join,relative} from 'node:path';
import {safeSourceRead} from '../../lib/safe-source-read.js';
import {decodeDeterministicHandle} from '../../lib/deterministic-handle-path.ts';
import {currentFileAccessAllowed} from '../../lib/damage-control-shared.ts';
import {exportPathAllowed} from '../agentic-sources.ts';
import {registerAskSystem1Files} from '../tools/ask-system1-files.ts';
import {adaptDiscovery} from './adapters.ts';
import {discoverCandidates} from './discovery.ts';
import {composeQuestions} from './evaluate.ts';
import {createDiscoveryOwners,type DiscoveryOwners} from './owners.ts';
import {createDiscoveryBroker,type DiscoveryBroker} from './broker.ts';
import {writeResultPages,readResultPage,type DiscoveryResult} from './results.ts';
import type {ExtensionAPI,ExtensionContext} from '@mariozechner/pi-coding-agent';
import type {System1Service} from '../../lib/system1/contracts.ts';
import {readSystem1Selected,type loadSystem1Snapshot} from '../../lib/system1/config-loader.js';
import {agenticParentAllowed} from '../agentic-hub.ts';
import {sourceHash} from '../agentic-sources.ts';
import {createDiscoveryRuntime,type DiscoveryRuntime} from './runtime.ts';
import {DISCOVERY_COUNTER,restoreDiscoveryCounter} from './state.ts';
import type {FileDiscoveryConfig} from './evaluate.ts';
const sessions=new WeakMap<ExtensionAPI,{runtime:DiscoveryRuntime;config:FileDiscoveryConfig;root:string;sessionDir:string;task():string;context():string;taskId():string;candidates?:{context:string;paths:string[];complete:boolean};results:Map<string,string>;events:Map<string,Promise<unknown>>;observe?(trigger:string,status:string):void;owners:DiscoveryOwners;broker:Promise<DiscoveryBroker|null>}>();
export function discoveryHubRuntime(pi:ExtensionAPI){return agenticParentAllowed()?sessions.get(pi)?.runtime??null:null;}
export function discoveryHubEnabled(pi:ExtensionAPI){return discoveryHubRuntime(pi)?.enabled===true;}
export function resetDiscoveryHub(pi:ExtensionAPI):Promise<void>{const session=sessions.get(pi);session?.runtime.dispose();session?.owners.dispose();sessions.delete(pi);return session?.broker.then(async broker=>{await broker?.close();}).catch(()=>{})??Promise.resolve();}
export function discoveryHubNativeChannel(pi:ExtensionAPI){const session=agenticParentAllowed()?sessions.get(pi):undefined;return session?{owners:session.owners,ready:session.broker}:null;}
export function configureDiscoveryHub(pi:ExtensionAPI,options:{snapshot:ReturnType<typeof loadSystem1Snapshot>;service?:System1Service;ctx:ExtensionContext;sessionDir:string;taskId():string;communicationStore?:CommunicationStore}) {
 resetDiscoveryHub(pi);const section=options.snapshot.consumers.fileDiscovery;
 if(!agenticParentAllowed()||options.snapshot.status!=='ready'||section.status!=='ready'||!readSystem1Selected(options.ctx.cwd))return;
 const config=section.config as FileDiscoveryConfig,sessionId=options.ctx.sessionManager.getSessionId();
 const entries=()=>options.ctx.sessionManager.getEntries();
 const task=()=>{const last=[...entries()].reverse().find((r:any)=>r?.type==='message'&&r.message?.role==='user') as any;return !last?'':typeof last.message.content==='string'?last.message.content:JSON.stringify(last.message.content??'');};
 const context=()=>sourceHash(JSON.stringify([options.taskId(),task()]));
 let restored=restoreDiscoveryCounter(entries(),sessionId);const persist=(s:any)=>pi.appendEntry(DISCOVERY_COUNTER,s);
 if(restored){try{persist(restored);}catch{restored=null;}}
 const runtime=createDiscoveryRuntime({root:options.ctx.cwd,sessionId,config,service:options.service,context,persist,restored,observe:metadata=>options.communicationStore?.beginDiscovery(metadata)??(()=>{})});
 // Latest user text revises Hub advice/cache, not the task bound to a live child.
 const owners=createDiscoveryOwners(sessionId,options.taskId);
 const session:Session={runtime,config,root:options.ctx.cwd,sessionDir:options.sessionDir,task,context,taskId:options.taskId,results:new Map(),events:new Map(),owners,broker:Promise.resolve(null)};
 session.observe=(trigger,status)=>options.communicationStore?.beginDiscovery({owner:'hub',trigger,provider:'typesafe',model:'jev-1.13.0'})({status});
 sessions.set(pi,session);
 session.broker=createDiscoveryBroker({root:session.root,runtime,owners,publish:(result,lease)=>deliverNative(session,result,lease)}).then(async broker=>{if(sessions.get(pi)!==session){await broker.close();return null;}return broker;}).catch(()=>null);
}
type Session=NonNullable<ReturnType<typeof sessions.get>>;
const canRead=(session:Session,path:string)=>currentFileAccessAllowed(session.root,path);
const pageRoot=(session:Session)=>join(session.sessionDir,'artifacts','file-discovery');
function deliver(session:Session,result:DiscoveryResult){
 if(Buffer.byteLength(JSON.stringify(result))<=session.config.limits.resultPageBytes)return result;
 const root=pageRoot(session);mkdirSync(root,{recursive:true,mode:0o700});
 const first=writeResultPages(root,result,session.config.limits.resultPageBytes,true);
 session.results.set(result.resultId,session.context());
 const {rows:_rows,...summary}=result;return {...summary,total:result.rows.length,offset:0,first,instruction:'All rows are retained. Use filesystem readback with first.handle and then each page next.handle; a spent self-read turn requires continuation on the next turn.'};
}
export function discoveryManagedReadbackAllowed(pi:ExtensionAPI,handle:string):boolean {
 const session=sessions.get(pi);if(!session)return true;
 try{
  const decoded=decodeDeterministicHandle(handle),root=pageRoot(session);
  if(!decoded.path.startsWith(root+'/'))return true;
  const match=/\/file-discovery-([0-9a-f-]{36})\/page-(\d+)\.json$/.exec(decoded.path);
  if(!match||!discoveryHubEnabled(pi)||session.results.get(match[1])!==session.context()||decoded.offset!==0)return false;
  const page=readResultPage(root,{path:decoded.path,hash:decoded.hash,resultId:match[1],pageIndex:Number(match[2])},session.config.limits.resultPageBytes);
  return page.taskHash===sourceHash(session.task())&&page.rows.every((row:any)=>canRead(session,resolve(session.root,row.path))&&(row.status==='unscored'||exportPathAllowed(row.path,session.config.include)));
 }catch{return false;}
}
async function rank(session:Session,paths:string[],query:string,complete:boolean,signal?:AbortSignal,customQuestions?:unknown,hidden?:number,trigger?:string){
 session.candidates={context:session.context(),paths:paths.slice(0,session.config.limits.maxCandidates),complete:complete&&paths.length<=session.config.limits.maxCandidates};
 const permissionIdentity=()=>JSON.stringify(paths.map(path=>canRead(session,resolve(session.root,path))));
 return session.runtime.rank({owner:'hub',trigger,task:session.task(),query,paths,discoveryComplete:complete,signal,customQuestions,hidden,canRead:path=>canRead(session,path),canDisplay:path=>canRead(session,path),permissionIdentity});
}
export function registerDiscoveryHub(pi:ExtensionAPI){
 registerAskSystem1Files(pi,{async execute(raw,signal){
  const session=sessions.get(pi);if(!session||!discoveryHubEnabled(pi))return {status:'skipped',reason:'consumer_off'};
  if(!session.task().trim())return {status:'skipped',reason:'missing_task'};
  const params=raw as any;
  if(!params||Object.keys(params).some(k=>!['paths','patterns','directories','recursive','questions'].includes(k))||!composeQuestions(params.questions)||['paths','patterns','directories'].some(k=>params[k]!==undefined&&(!Array.isArray(params[k])||params[k].some((v:any)=>typeof v!=='string')||params[k].length>(k==='paths'?1024:20)))||params.recursive!==undefined&&typeof params.recursive!=='boolean'||Buffer.byteLength(JSON.stringify(params))>session.config.limits.maxRequestBytes)return {status:'unavailable',reason:'invalid_input'};
  if(![params.paths,params.patterns,params.directories].some(v=>v?.length))return {status:'unavailable',reason:'invalid_input'};
  const context=session.context();
  const discovery=await discoverCandidates({...params,root:session.root,config:session.config,signal:signal??new AbortController().signal,canDiscover:(path:string)=>canRead(session,path)});
  if(session.context()!==context||signal?.aborted)return {status:'cancelled'};
  const result=await rank(session,discovery.paths,JSON.stringify(params),discovery.discoveryComplete,signal,params.questions,discovery.hidden,'explicit');
  try{return {...deliver(session,result),discovery};}catch{return {status:'unavailable',reason:'page_unavailable',counts:result.counts};}
 }});
 pi.on('tool_result',async(event,ctx)=>{
  if(!['filesystem','find','ls','grep'].includes(event.toolName))return;
  if(event.toolName==='filesystem'&&(event.input as any)?.operation!=='inventory')return;
  const session=sessions.get(pi);
  // Off/unconfigured is inert: do not capture evidence or rewrite tool results.
  if(!session||!discoveryHubEnabled(pi))return;
  const original={content:event.content,details:event.details};
  const reply=(advice:any)=>{if(advice.status==='skipped')session.observe?.(event.toolName,'skipped');return ({content:[...event.content,{type:'text' as const,text:'File discovery advice: '+JSON.stringify(advice)}],details:{...(event.details&&typeof event.details==='object'?event.details:{}),fileDiscovery:advice}});};
  const key=JSON.stringify([session.context(),event.toolCallId,sourceHash(JSON.stringify(original))]);
  if(session.events.has(key))return session.events.get(key) as any;
  const context=session.context();
  const operation=(async()=>{
   if(!session.task().trim())return reply({status:'skipped',reason:'missing_task'});
   let result:any=event;
   const bounded=(event.details as any)?.boundedOutput;
   if(bounded){
    try{const body=safeSourceRead(session.sessionDir,bounded.contentPath,262144);if(sourceHash(body)!==bounded.sha256)throw Error();const {boundedOutput:_bounded,...details}=event.details as any;result={...event,content:[{type:'text',text:body.toString('utf8')}],details};}
    catch{return reply({status:'skipped',reason:'bounded_evidence_unavailable'});}
   }
   const candidates=adaptDiscovery({tool:event.toolName,args:event.input as any,result,cwd:ctx.cwd,root:session.root,include:session.config.include});
   if(candidates.reason&&candidates.paths.length===0)return reply({status:'skipped',reason:candidates.reason});
   if(candidates.paths.length<2)return reply({status:'skipped',reason:'fewer_than_two_candidates',discoveryComplete:candidates.discoveryComplete});
   const ranked=await rank(session,candidates.paths,JSON.stringify([event.toolName,event.input]),candidates.discoveryComplete,undefined,undefined,candidates.hidden,event.toolName);
   if(context!==session.context()||!discoveryHubEnabled(pi))return reply({status:'cancelled',reason:'stale_task'});
   try{return reply(deliver(session,ranked));}catch{return reply({status:'unavailable',reason:'page_unavailable',counts:ranked.counts});}
  })();session.events.set(key,operation);while(session.events.size>2048)session.events.delete(session.events.keys().next().value!);
  try{return await operation;}finally{if(session.events.get(key)===operation)session.events.delete(key);}
 });
 pi.on('tool_call',event=>{if(event.toolName==='filesystem'&&typeof (event.input as any)?.handle==='string'&&!discoveryManagedReadbackAllowed(pi,(event.input as any).handle))return {block:true,reason:'D9 managed page is stale or denied by current permissions/hash.'};});
 pi.on('before_agent_start',()=>{discoveryHubRuntime(pi)?.syncContext();sessions.get(pi)?.owners.syncTask();});
 pi.on('session_shutdown',()=>resetDiscoveryHub(pi));
}

function deliverNative(session:Session,result:DiscoveryResult,lease?:OwnerLease) {
 if(Buffer.byteLength(JSON.stringify(result))<=session.config.limits.resultPageBytes)return result;
 if(lease&&!lease.effectiveTools.some(t=>t==='read'||t==='filesystem'))return {status:'unavailable',reason:'page_read_not_permitted',counts:result.counts};
 const root=pageRoot(session);mkdirSync(root,{recursive:true,mode:0o700});
 const first=writeResultPages(root,result,session.config.limits.resultPageBytes,true);
 const {rows:_rows,...summary}=result;
 return {...summary,total:result.rows.length,offset:0,first,instruction:'All rows are retained in bounded pages. Use your already permitted read tool on first.path (or filesystem readback on first.handle), then next.path/handle. No new tool or read permission is granted; if those paths are denied report that restriction.'};
}
/** Called only after launch admission/artifact gates; scope hints never grant read/export. */
export async function prepareDiscoveryNative(pi:ExtensionAPI,input:NativeDiscoveryInput):Promise<NativeDiscoveryContext|null> {
 const session=sessions.get(pi);if(!session||!discoveryHubEnabled(pi))return null;
 const context=session.context(),taskId=session.taskId();
 const current=()=>sessions.get(pi)===session&&discoveryHubEnabled(pi)&&context===session.context()&&taskId===session.taskId()&&!input.signal?.aborted;
 if(!current())return {manifest:{status:'cancelled'},current};
 const canReadOwner=(path:string)=>input.tools.some(t=>t==='read'||t==='filesystem')&&canRead(session,path);
 const owner={taskId,ownerId:input.ownerId,cwd:input.cwd,task:input.task,query:input.query,effectiveTools:input.tools,readRoots:session.config.include,exportRoots:session.config.include,canRead:canReadOwner,canDisplay:(p:string)=>canRead(session,p),permissionIdentity:()=>JSON.stringify([input.tools,session.config.include,session.taskId()])};
 if(!input.tools.some(t=>t==='read'||t==='filesystem'))return {manifest:{status:'skipped',reason:'owner_read_not_permitted'},current};
 const broker=await session.broker;if(!current())return {manifest:{status:'cancelled'},current};
 if(!broker)return {manifest:{status:'unavailable',reason:'channel_unavailable',fallback:'Continue ordinary permitted discovery.'},current};
 let paths:string[]=[],complete=true;
 if(!input.scope.length&&session.candidates?.context===context){paths=session.candidates.paths;complete=session.candidates.complete;}
 else {
  const explicit:string[]=[],directories:string[]=[],patterns:string[]=[];
  for(const hint of input.scope){if(/[*?\[{]/.test(hint))patterns.push(hint);else {try{if(lstatSync(resolve(input.cwd,hint)).isDirectory())directories.push(hint);else explicit.push(hint);}catch{explicit.push(hint);}}}
  const discovery=await discoverCandidates({root:session.root,cwd:input.cwd,config:session.config,paths:explicit,patterns,directories:input.scope.length?directories:session.config.include.map(p=>resolve(session.root,p)),recursive:true,signal:input.signal??new AbortController().signal,canDiscover:p=>canRead(session,p)});
  paths=discovery.paths;complete=discovery.discoveryComplete;
 }
 if(!current())return {manifest:{status:'cancelled'},current};
 const result=await session.runtime.rank({owner:input.ownerId,trigger:'pre_spawn',task:input.task,query:input.query,context:()=>session.taskId()+':'+sourceHash(input.query),paths,discoveryComplete:complete,signal:input.signal,permissionIdentity:()=>JSON.stringify([owner.effectiveTools,owner.readRoots,owner.exportRoots,owner.permissionIdentity(),paths.map(p=>exportPathAllowed(p,owner.readRoots)&&exportPathAllowed(p,owner.exportRoots)&&owner.canDisplay(resolve(input.cwd,p))&&canReadOwner(resolve(input.cwd,p)))]),canRead:canReadOwner,canDisplay:owner.canDisplay});
 if(!current())return {manifest:{status:'cancelled'},current};
 let manifest:unknown;try{manifest=deliverNative(session,result);}catch{manifest={status:'unavailable',reason:'page_unavailable',counts:result.counts};}
 return {manifest,current,registration:{owners:session.owners,endpoint:broker.endpoint,owner:{...owner,initialPaths:paths.map(p=>relative(input.cwd,resolve(session.root,p)).split('\\').join('/')),discoveryComplete:complete},extension:fileURLToPath(new URL('./child-extension.ts',import.meta.url))}};
}
