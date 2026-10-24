import {worktreeConsumerService} from '../lib/system1/worktree-service.ts';
import {randomUUID} from 'node:crypto';
import {beginRuntimeTrace,type TraceBus} from '../lib/execution-trace.ts';
import {realpathSync} from 'node:fs';
import {resolve} from 'node:path';
import {createDamageBroker,type DamageOutcome} from './damage-guard-broker.ts';
import type {DamageSpawnRegistration} from './damage-guard-owners.ts';
import {damageActionHashes} from '../lib/damage-action-hash.ts';
import {screenDamagePayload} from '../lib/system1/payload-screen.ts';
import {DAMAGE_GUARD_VERSION,DAMAGE_GUARD_QUESTIONS,damageVerdict} from './damage-guard-contract.ts';
import {createDamageOwners,type DamageOwnerIdentity,type DamageOwnerSpec} from './damage-guard-owners.ts';
import {actionPresentation} from './task-triage-authorization.ts';
import type {ExtensionAPI,ExtensionContext} from '@mariozechner/pi-coding-agent';
import type {System1Service} from '../lib/system1/contracts.ts';
import {normalizeSystem1Config} from '../lib/system1/config-v2.js';
import {parseDamageGuardConfig} from '../lib/system1/config-damage-guard.js';
import {readSystem1Selected} from '../lib/system1/config-loader.js';
import {currentFileAccessAllowed} from '../lib/damage-control-shared.ts';
import {registerDamageGuard,type DamageCallEvent,type DamageCallContext} from '../lib/damage-guard-port.ts';
import {createDamageGuard} from '../damage-control-continue/system1-guard.ts';
import {createDamageResultScreen,type DamageResultEvent} from '../damage-control-continue/result-screen.ts';
import {captureDamageResult} from '../lib/damage-result-evidence.ts';
import {createDamageIdentity,validDamageIdentity} from './damage-guard-identity.ts';
import {createDamageState,validDamageDecision,damageDenyKey,type DamageAction} from './damage-guard-state.ts';
import {createDamageApproval} from './damage-guard-approval.ts';
import {requestRuntimeAsk,type RuntimeQuestion} from '../ask-user-remote/runtime-ask.ts';
export const DAMAGE_INPUT_ENTRY='damage-guard-input',DAMAGE_DENY_ENTRY='damage-guard-denial';
interface HubSessionOptions {root:string;snapshot:ReturnType<typeof normalizeSystem1Config>;taskId():string;childAuthority?:{taskToken():unknown;admit(identity:DamageOwnerIdentity):boolean};append(type:string,data:unknown):void;entries():unknown[];canRead(path:string):boolean;selected:boolean;service?:System1Service;traceBus?:TraceBus;ask(id:string,question:RuntimeQuestion,signal:AbortSignal,action?:DamageAction):Promise<unknown>;}
export function createDamageHubSession(options:HubSessionOptions){
 const controller=new AbortController();let revoked=false;
 // A decision must follow its authoritative input hash in the same append-only history.
 // Partial loss/corruption is not an explicit revision rollback or a human override.
 const recoveryTasks=new Set<string>(),historyRevisions=new Map<string,string>();
 for(const item of options.entries()){
  const row=item as {customType?:string;data?:unknown};if(!row||![DAMAGE_INPUT_ENTRY,DAMAGE_DENY_ENTRY].includes(row.customType??''))continue;
  const data=row.data,taskId=(data as any)?.taskId;
  if(row.customType===DAMAGE_INPUT_ENTRY&&validDamageIdentity(data)){
   historyRevisions.set(data.taskId,data.revision);recoveryTasks.delete(data.taskId);
  }else if(row.customType===DAMAGE_DENY_ENTRY&&validDamageDecision(data)){
   if(historyRevisions.get(data.taskId)!==data.inputRevision)recoveryTasks.add(data.taskId);
  }else recoveryTasks.add(typeof taskId==='string'&&taskId?taskId:options.taskId());
 }
 const rows=(type:string)=>options.entries().filter((r:any)=>r?.customType===type).map((r:any)=>r.data);
 const identity=createDamageIdentity(row=>options.append(DAMAGE_INPUT_ENTRY,row));identity.restore(rows(DAMAGE_INPUT_ENTRY));
 const state=createDamageState(row=>options.append(DAMAGE_DENY_ENTRY,row));state.restore(rows(DAMAGE_DENY_ENTRY));
 const section=options.snapshot.consumers.damageGuard;
 const config=(section?.config??parseDamageGuardConfig({mode:'off'})) as ReturnType<typeof parseDamageGuardConfig>;
 const enabled=options.selected&&options.snapshot.status==='ready'&&section?.status==='ready';
 const attempt=randomUUID(),binding=()=>({taskId:options.taskId(),inputRevision:identity.revision(options.taskId()),owner:'hub',attempt});
 const sessionId=randomUUID();
 let lastTaskToken=options.childAuthority?.taskToken(),ownerTaskToken=randomUUID();
 const taskToken=()=>{const token=options.childAuthority?.taskToken();if(token!==lastTaskToken){lastTaskToken=token;ownerTaskToken=randomUUID();}return token===undefined||token===null||token===''?'':ownerTaskToken;};
 const owners=createDamageOwners({current:()=>({session:sessionId,taskToken:taskToken(),taskId:options.taskId(),inputRevision:identity.revision(options.taskId())}),admit:owner=>!revoked&&options.childAuthority?.admit(owner)===true});
 const admissions=new Map<DamageOwnerIdentity,()=>boolean>(),children=new Map<string,DamageOwnerIdentity>();
 let broker:Awaited<ReturnType<typeof createDamageBroker>>|undefined,startPromise:Promise<void>|undefined,closePromise:Promise<void>|undefined,backoff=0;
 const work=new Set<Promise<unknown>>();
 function track<T>(promise:Promise<T>):Promise<T>{work.add(promise);void promise.then(()=>work.delete(promise),()=>work.delete(promise));return promise;}
 const authority={
  register(spec:DamageOwnerSpec,ancestor?:DamageOwnerIdentity){
   const owner=owners.register(spec,ancestor);if(ancestor){const admit=admissions.get(ancestor);if(admit)admissions.set(owner,admit);}children.set(owner.owner,owner);return owner;
  },
  validate(owner:DamageOwnerIdentity,tool:string,cwd:string){
   try{const admit=admissions.get(owner);if(admit&&admit()!==true){owners.revoke(owner);return undefined;}}catch{owners.revoke(owner);return undefined;}
   return owners.validate(owner,tool,cwd);
  },revoke:owners.revoke,
 };
 const scopedService=worktreeConsumerService(options.service,options.snapshot.document,'damageGuard');
 const sharedService: System1Service|undefined=enabled&&scopedService?{evaluate:async request=>{
  if(Date.now()<backoff)return {status:'unavailable',reason:'network'};
  try{const result=await scopedService!.evaluate(request);if(result.status!=='ok')backoff=Date.now()+config.limits.outageBackoffMs;return result;}catch(error){backoff=Date.now()+config.limits.outageBackoffMs;throw error;}
 }}:undefined;
 const latestActions=new Map<string,string>();
 function noteAction(action:DamageAction){const key=overrideKey(action),prior=latestActions.get(action.owner);if(prior&&prior!==key)overrides.delete(prior);latestActions.set(action.owner,key);}
 const overrides=new Set<string>(),blocked=new Map<string,{action:DamageAction;input:unknown;bytes:number}>();let blockedBytes=0;
 const overrideKey=(action:DamageAction)=>JSON.stringify([damageDenyKey(action),action.owner,action.attempt]);
 const resultScreen=createDamageResultScreen({root:options.root,config:{...config,mode:enabled?'active':'off'},canRead:options.canRead,service:sharedService,signal:controller.signal,context:()=>JSON.stringify(binding())});
 function adapter(binding:()=>Pick<DamageAction,'taskId'|'inputRevision'|'owner'|'attempt'>,signal:AbortSignal,current:()=>boolean){
 const contexts=new Map<string,DamageCallContext>();
 const guard=createDamageGuard({root:options.root,config:{...config,mode:enabled?'active':'off'},state,binding,canRead:options.canRead,service:sharedService,signal,takeOverride:action=>{const key=overrideKey(action);if(!overrides.has(key))return false;overrides.delete(key);return true;},approve:async(action,input)=>{
  const ctx=contexts.get(JSON.stringify(action));
  const approval=createDamageApproval({state,current:()=>({...action,...binding()}),baseline:()=>!revoked&&current()&&ctx?.revalidateBaseline?.()===true,ask:options.ask,timeoutMs:config.limits.approvalTimeoutMs});
  const result=await approval.request(action,input,signal);return result.status==='allowed'?approval.consumeProof(result.grant,action,signal):false;
 }});
 return {
  async call(event:DamageCallEvent,ctx:DamageCallContext){
   if(!['bash','write','edit'].includes(event.toolName))return {block:false};
   if(revoked||signal.aborted||!current())return {block:true,reason:'Damage-Control: session or owner revoked'};
   const checkedCtx={...ctx,...(ctx.revalidateBaseline?{revalidateBaseline:()=>!revoked&&!signal.aborted&&current()&&ctx.revalidateBaseline?.()===true}:{})};
   if(recoveryTasks.has(options.taskId()))return {block:true,reason:'Damage-Control: inconsistent input/decision history; explicit new accepted input is required'};
   // Bind the authoritative new task before any off/compatibility shortcut.
   let revision='';try{revision=identity.bindTask(options.taskId());}catch{return {block:true,reason:'Damage-Control: input identity persistence failed'};}
   if(!revision)return rows(DAMAGE_DENY_ENTRY).length?{block:true,reason:'Damage-Control: accepted-input identity unavailable'}:{block:false};
   let action:DamageAction;try{action=guard.action(event,ctx);}catch{return {block:true,reason:'Damage-Control: exact action authority unavailable'};}
   const key=JSON.stringify(action);noteAction(action);
   const finishTrace=beginRuntimeTrace(options.traceBus,{kind:'policy',id:action.actionId,parentId:action.actionId,owner:action.owner,source:'damage-guard',tool:event.toolName,rule:'semantic_exact_action'});
   remember(action,event.input);
   if(!contexts.has(key))contexts.set(key,checkedCtx);
   try{const result=await guard.call(event,checkedCtx);if(result.block)remember(action,event.input);const final=!result.block&&(!current()||signal.aborted||ctx.revalidateBaseline?.()===false)?{block:true,reason:'Damage-Control: authority changed before admission'}:result;finishTrace({status:final.block?'blocked':'allowed'});return final;}catch(error){finishTrace({status:'failed'});throw error;}finally{contexts.delete(key);}
  },
  dispose(){guard.dispose();},
 };
 }
 // Child-local baseline is deliberately absent from this parent assessment port.
 // A grant attests semantic human consent only; the native hook owes baseline revalidation.
 function remember(action:DamageAction,input:unknown){
  if(!state.needsArm(action)||overrides.has(overrideKey(action))||!actionPresentation(action,{input,cwd:action.cwd}))return;
  try{const copy=structuredClone(input),bytes=Buffer.byteLength(JSON.stringify([action,copy]));
   for(const [id,row] of blocked)if(row.action.owner===action.owner&&row.action.attempt===action.attempt){blockedBytes-=row.bytes;blocked.delete(id);if(overrideKey(row.action)!==overrideKey(action))overrides.delete(overrideKey(row.action));}
   blocked.set(action.actionId,{action,input:copy,bytes});blockedBytes+=bytes;
   while(blockedBytes>config.limits.maxFrameBytes&&blocked.size){const id=blocked.keys().next().value!,row=blocked.get(id)!;blockedBytes-=row.bytes;blocked.delete(id);overrides.delete(overrideKey(row.action));}
  }catch{/* Unpresentable input never arms a dialog. */}
 }
 async function assess(owner:DamageOwnerIdentity,event:DamageCallEvent,context:{remainingMs:number;signal:AbortSignal;held():boolean}):Promise<DamageOutcome>{
  const current=()=>!revoked&&!context.signal.aborted&&!!authority.validate(owner,event.toolName,owner.cwd);
  if(!current())return 'revoked';
  if(recoveryTasks.has(owner.taskId))return 'blocked';
  const action:DamageAction={...owner,operation:event.toolName as DamageAction['operation'],actionId:event.toolCallId,...damageActionHashes(event.toolName,event.input)};
  noteAction(action);remember(action,event.input);
  const key=overrideKey(action),armed=overrides.delete(key);
  if(state.needsArm(action)&&!armed)return 'blocked';
  if(!state.held(action)&&!state.needsArm(action)){
   if(!sharedService||Date.now()<backoff)return 'unavailable';
   const controller=new AbortController(),abort=()=>controller.abort();context.signal.addEventListener('abort',abort,{once:true});owner.signal.addEventListener('abort',abort,{once:true});
   const deadline=Date.now()+Math.min(context.remainingMs,config.limits.hookTimeoutMs),timer=setTimeout(abort,Math.max(1,deadline-Date.now()));
   try{
    const raw=event.input as Record<string,unknown>,input=event.toolName!=='bash'&&typeof raw.path==='string'?{...raw,path:resolve(owner.cwd,raw.path)}:raw;
    const screened=await screenDamagePayload({kind:event.toolName==='bash'?'command':'edit',input},{root:options.root,config,canRead:options.canRead,signal:controller.signal});
    if(!current())return 'revoked';if(controller.signal.aborted)return 'indeterminate';if(screened.status!=='ready')return 'no_hold';
    const request={state:{owner:owner.owner,trigger:event.toolName,scope:screened.scope,coverage:screened.coverage,bytes:screened.bytes,payload:screened.payload},questions:DAMAGE_GUARD_QUESTIONS,questionSetVersion:DAMAGE_GUARD_VERSION,timeoutMs:Math.max(1,deadline-Date.now()),signal:controller.signal};
    if(Buffer.byteLength(JSON.stringify({...request,signal:undefined}))>config.limits.maxPayloadBytes)return 'no_hold';
    const result=await Promise.race([sharedService.evaluate(request),new Promise<import('../lib/system1/contracts.ts').System1Result>(r=>{if(controller.signal.aborted)r({status:'cancelled'});else controller.signal.addEventListener('abort',()=>r({status:'cancelled'}),{once:true});})]);
    if(!current())return 'revoked';if(controller.signal.aborted)return 'indeterminate';if(result.status!=='ok')return 'unavailable';
    if(damageVerdict(result,'call')!=='hold_exact_action')return 'no_hold';
    state.hold(action);
   }catch{return state.held(action)?'blocked':'indeterminate';}
   finally{clearTimeout(timer);context.signal.removeEventListener('abort',abort);owner.signal.removeEventListener('abort',abort);}
  }
  try{state.hold(action);}catch{return 'blocked';}
  if(!current()||!context.held())return 'blocked';
  const approval=createDamageApproval({state,current:()=>({...action,taskId:options.taskId(),inputRevision:identity.revision(options.taskId())}),baseline:current,ask:options.ask,timeoutMs:config.limits.approvalTimeoutMs});
  const result=await approval.request(action,event.input,context.signal);
  if(result.status!=='allowed'){remember(action,event.input);return 'blocked';}
  return approval.consumeProof(result.grant,action,context.signal).allowed&&current()?'granted':'blocked';
 }
 // Disabled optional assessment must not require a broker for ordinary work.
 // Persisted holds/denials still require enforcement, including after restart.
 const needsChildGuard=()=>enabled||recoveryTasks.has(options.taskId())||rows(DAMAGE_DENY_ENTRY).some((row:any)=>row?.taskId===options.taskId());
 function start(){if(!needsChildGuard())return Promise.resolve();return startPromise??=(async()=>{
  if(revoked)throw Error('damage_session_revoked');
  const opened=await createDamageBroker({authority,result:(owner,event,context)=>track((async()=>{
   const current=()=>!revoked&&!context.signal.aborted&&!!authority.validate(owner,event.toolName,owner.cwd);
   if(!current())return {version:1 as const,status:'not_evaluated' as const,coverage:'none' as const,reason:'cancelled' as const,warning:false,sourceTrusted:false as const};
   const original=captureDamageResult(event);
   return resultScreen.evaluate(original,owner.cwd,{owner:owner.owner,signal:AbortSignal.any([context.signal,owner.signal]),deadlineAt:Date.now()+context.remainingMs,current});
  })()),assess:(owner,event,context)=>track((async()=>{
   const finish=beginRuntimeTrace(options.traceBus,{kind:'policy',id:event.toolCallId,owner:owner.owner,source:'damage-guard',tool:event.toolName,rule:'semantic_exact_action',fingerprint:JSON.stringify(event.input)});
   try{const result=await assess(owner,event,context);finish({status:result==='granted'||result==='no_hold'?'allowed':result==='blocked'?'blocked':result==='cancelled'||result==='revoked'?'cancelled':'unavailable'});return result;}
   catch(error){finish({status:'failed'});throw error;}
  })())});
  if(revoked){await opened.close();throw Error('damage_session_revoked');}broker=opened;
 })();}
 function dispose(){
  if(closePromise)return closePromise;
  revoked=true;controller.abort();owners.dispose();parent.dispose();resultScreen.dispose();overrides.clear();
  return closePromise=(async()=>{await startPromise?.catch(()=>{});await Promise.allSettled([...work]);await broker?.close();})();
 }
 function prepare(input:{ownerId:string;cwd:string;tools:readonly string[];admit():boolean;signal?:AbortSignal}):DamageSpawnRegistration|null{
  if(revoked)throw Error('damage_session_revoked');
  if(!needsChildGuard())return null;
  if(!broker||!options.childAuthority)throw Error('damage_transport_unavailable');
  identity.bindTask(options.taskId());
  const captured={task:options.taskId(),revision:identity.revision(options.taskId()),token:options.childAuthority.taskToken()},cwd=realpathSync(input.cwd),tools=Object.freeze(input.tools.filter(t=>['bash','write','edit','read','filesystem'].includes(t)));
  const validate=()=>{try{return !revoked&&!input.signal?.aborted&&input.admit()===true&&captured.task===options.taskId()&&captured.revision===identity.revision(options.taskId())&&captured.token===options.childAuthority?.taskToken();}catch{return false;}};
  if(!validate())throw Error('damage_preparation_stale');if(!tools.length)return null;
  return {tools,validate,open(physical){
   if(!validate()||realpathSync(physical.cwd)!==cwd||!physical.tools.length||physical.tools.some(t=>!tools.includes(t)))throw Error('damage_physical_scope_invalid');
   // Broker registration and owner identity are synchronous and inseparable.
   const before=new Set(children.keys()),assignment=broker!.register({owner:input.ownerId,tools:physical.tools,cwd});
   const owner=[...children.values()].find(row=>!before.has(row.owner))!;admissions.set(owner,validate);
   const lease={assignment,identity:owner,validate:()=>!!authority.validate(owner,physical.tools[0],cwd),revoke:()=>owners.revoke(owner)};
   input.signal?.addEventListener('abort',lease.revoke,{once:true});owner.signal.addEventListener('abort',()=>{input.signal?.removeEventListener('abort',lease.revoke);},{once:true});
   if(!lease.validate()){lease.revoke();throw Error('damage_physical_stale');}return lease;
  }};
 }
 let parentController=new AbortController();
 let parent=adapter(binding,AbortSignal.any([controller.signal,parentController.signal]),()=>!revoked);
 return {
  start,prepare,
  accept(input:string){overrides.clear();try{identity.accept(options.taskId(),input);parentController.abort();parent.dispose();parentController=new AbortController();parent=adapter(binding,AbortSignal.any([controller.signal,parentController.signal]),()=>!revoked);recoveryTasks.delete(options.taskId());owners.invalidate();}catch(error){revoked=true;controller.abort();owners.dispose();parent.dispose();throw error;}},
  call:(event:DamageCallEvent,ctx:DamageCallContext)=>track(parent.call(event,ctx)),
  registerOwner(spec:DamageOwnerSpec,ancestor?:DamageOwnerIdentity){
   if(!options.childAuthority||revoked||recoveryTasks.has(options.taskId()))throw Error('damage_owner_authority_unavailable');
   identity.bindTask(options.taskId());
   const owner=authority.register(spec,ancestor),child=adapter(()=>owner,owner.signal,()=>!!authority.validate(owner,owner.tools[0],owner.cwd));
   owner.signal.addEventListener('abort',()=>child.dispose(),{once:true});
   return {identity:owner,call(event:DamageCallEvent,ctx:DamageCallContext){
    // This is a read-only baseline revalidation, never a second allow-once consumption.
    if(!authority.validate(owner,event.toolName,ctx.cwd)||ctx.revalidateBaseline?.()!==true)return Promise.resolve({block:true,reason:'Damage-Control: owner authority unavailable'});
    return track(child.call(event,ctx));
   },revoke(){owners.revoke(owner);}};
  },
  armOverride(actionId?:string){
   if(revoked||recoveryTasks.has(options.taskId()))return false;
   const row=actionId?blocked.get(actionId):[...blocked.values()].at(-1);
   if(!row||row.action.taskId!==options.taskId()||row.action.inputRevision!==identity.revision(options.taskId())||!state.needsArm(row.action)||latestActions.get(row.action.owner)!==overrideKey(row.action)||row.action.owner!=='hub'&&!authority.validate(children.get(row.action.owner)!,row.action.operation,row.action.cwd))return false;
   overrides.add(overrideKey(row.action));return true;
  },
  result<T extends DamageResultEvent>(event:T,cwd:string){return resultScreen.result(event,cwd);},
  dispose,
 };
}
const sessions=new WeakMap<ExtensionAPI,{runtime:ReturnType<typeof createDamageHubSession>;revoke():void}>();
const closures=new WeakMap<ExtensionAPI,Promise<void>>(),generations=new WeakMap<ExtensionAPI,object>();
const registered=new WeakSet<ExtensionAPI>();
export function registerDamageGuardHub(pi:ExtensionAPI){
 if(registered.has(pi))return;registered.add(pi);
 pi.on('tool_result',(event,ctx)=>{
  const original=captureDamageResult(event),session=sessions.get(pi);
  return session?.runtime.result(original,ctx.cwd);
 });
 pi.on('session_shutdown',()=>resetDamageGuardHub(pi));
 if(typeof pi.registerCommand==='function')pi.registerCommand('af-damage-override',{
  description:'Разреши нов точен approval диалог за следващия съвпадащ опит; трайният отказ остава.',
  handler:async(args,ctx)=>{const armed=sessions.get(pi)?.runtime.armOverride(args.trim()||undefined);ctx.ui.notify(armed?'Разрешен е само нов диалог за следващия точно съвпадащ опит. Няма разрешение за изпълнение; baseline правилата и трайният отказ остават.':'Няма актуален съвпадащ блокиран опит. Първо е нужен блокиран опит с валидна task/input идентичност.',armed?'info':'warning');},
 });
}
function closeSession(pi:ExtensionAPI){
 const prior=sessions.get(pi);sessions.delete(pi);prior?.revoke();
 const completion=prior?.runtime.dispose()??closures.get(pi)??Promise.resolve();closures.set(pi,completion);
 const settled=()=>{if(closures.get(pi)===completion)closures.delete(pi);};void completion.then(settled,settled);return completion;
}
export function resetDamageGuardHub(pi:ExtensionAPI){generations.set(pi,{});return closeSession(pi);}
export function prepareDamageGuardNative(pi:ExtensionAPI,input:Parameters<ReturnType<typeof createDamageHubSession>['prepare']>[0]){
 const session=sessions.get(pi);if(!session)throw Error('damage_owner_session_unavailable');return session.runtime.prepare(input);
}
export function acceptDamageGuardInput(pi:ExtensionAPI,input:string){sessions.get(pi)?.runtime.accept(input);}
/** Trusted parent access only; absence of a configured session/authority never creates one. */
export function registerDamageGuardOwner(pi:ExtensionAPI,spec:DamageOwnerSpec,ancestor?:DamageOwnerIdentity){
 const session=sessions.get(pi);if(!session)throw Error('damage_owner_session_unavailable');
 return session.runtime.registerOwner(spec,ancestor);
}
export async function configureDamageGuardHub(pi:ExtensionAPI,options:{snapshot:ReturnType<typeof normalizeSystem1Config>;service?:System1Service;ctx:ExtensionContext;taskId():string;childAuthority?:HubSessionOptions['childAuthority']}){
 const generation={};generations.set(pi,generation);if(sessions.has(pi)||closures.has(pi))await closeSession(pi);if(generations.get(pi)!==generation)return;
 if(process.env.AGENT_HUB_AGENT_ID||process.env.AGENT_FLEET_AGENTIC_CHILD)return;
 registerDamageGuardHub(pi);
 const runtime=createDamageHubSession({root:options.ctx.cwd,snapshot:options.snapshot,taskId:options.taskId,childAuthority:options.childAuthority,append:(type,data)=>pi.appendEntry(type,data),entries:()=>options.ctx.sessionManager.getEntries(),canRead:path=>currentFileAccessAllowed(options.ctx.cwd,path),selected:readSystem1Selected(options.ctx.cwd),service:options.service,traceBus:pi.events,ask:(id,q,signal,action)=>requestRuntimeAsk(pi.events,id,q,options.ctx,signal,{parentId:action?.actionId,parentKind:'policy',owner:action?.owner,source:'damage-guard'})});
 const entry={runtime,revoke:registerDamageGuard(runtime)};sessions.set(pi,entry);
 try{await runtime.start();if(generations.get(pi)!==generation||sessions.get(pi)!==entry){await runtime.dispose();return;}}
 catch(error){
  await runtime.dispose();
  // A current mandatory transport failure leaves a revoked parent fence installed.
  // Unregistering here would silently turn known denial into standalone permission.
  if(generations.get(pi)===generation)throw error;
  entry.revoke();if(sessions.get(pi)===entry)sessions.delete(pi);
 }
}
