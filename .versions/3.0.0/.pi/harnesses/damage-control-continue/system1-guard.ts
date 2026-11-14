import {realpathSync} from 'node:fs';
import {resolve} from 'node:path';
import {parseDamageGuardConfig} from '../lib/system1/config-damage-guard.js';
import {damageActionHashes} from '../lib/damage-action-hash.ts';
import {screenDamagePayload} from '../lib/system1/payload-screen.ts';
import {DAMAGE_GUARD_VERSION,DAMAGE_GUARD_QUESTIONS,damageVerdict} from '../agent-hub/damage-guard-contract.ts';
import {createDamageState,damageDenyKey,type DamageAction} from '../agent-hub/damage-guard-state.ts';
import type {DamageApprovalProof} from '../agent-hub/damage-guard-approval.ts';
import type {DamageCallEvent,DamageCallContext} from '../lib/damage-guard-port.ts';
import type {System1Service,System1Result} from '../lib/system1/contracts.ts';
export function createDamageGuard(deps:{root:string;config:ReturnType<typeof parseDamageGuardConfig>;state:ReturnType<typeof createDamageState>;binding():Pick<DamageAction,'taskId'|'inputRevision'|'owner'|'attempt'>;canRead(path:string):boolean;service?:System1Service;signal?:AbortSignal;takeOverride?(action:DamageAction):boolean;approve(action:DamageAction,input:unknown):Promise<boolean|DamageApprovalProof>}){
 let backoff=0,disposed=false;const lifetime=new AbortController();
 const revoked=()=>disposed||deps.signal?.aborted===true;
 const holds=new Set<string>(),admitted=new Map<string,DamageApprovalProof>(),pending=new Map<string,Promise<{block:boolean;reason?:string}>>();
 const action=(event:DamageCallEvent,ctx:DamageCallContext):DamageAction=>({...deps.binding(),operation:event.toolName as DamageAction['operation'],actionId:event.toolCallId,...damageActionHashes(event.toolName,event.input),cwd:realpathSync(ctx.cwd)});
 const evaluate=async(event:DamageCallEvent,ctx:DamageCallContext)=>{
  if(!['bash','write','edit'].includes(event.toolName))return {block:false};
  const contract=action(event,ctx),identity=JSON.stringify(contract),holdKey=damageDenyKey(contract);
  if(revoked())return {block:true,reason:'Damage-Control: owner cancelled; propose no retry.'};
  if(deps.state.needsArm(contract)&&deps.takeOverride?.(contract)!==true)return {block:true,reason:'Damage-Control: exact action denied or outcome-recovery fenced. Only the human can arm /af-damage-override for a new exact approval dialog.'};
  const resolveHold=async()=>{
   try{
    const answer=await deps.approve(contract,event.input),proof:DamageApprovalProof=typeof answer==='boolean'?{allowed:answer,denialEpoch:deps.state.denialEpoch(contract),overrideDenied:false}:answer;
    if(!proof.allowed||revoked()||ctx.revalidateBaseline?.()!==true||JSON.stringify(action(event,ctx))!==identity||proof.denialEpoch!==deps.state.denialEpoch(contract)||deps.state.denied(contract)&&!proof.overrideDenied)return {block:true,reason:'Damage-Control: exact action remains held'};
    admitted.set(identity,proof);holds.delete(holdKey);return {block:false};
   }catch{return {block:true,reason:'Damage-Control: held approval failed'};}
  };
  if(holds.has(holdKey)||deps.state.held(contract)||deps.state.needsArm(contract))return resolveHold();
  if(!deps.service||deps.config.mode!=='active'||Date.now()<backoff)return {block:false};
  const controller=new AbortController(),abort=()=>controller.abort();deps.signal?.addEventListener('abort',abort,{once:true});lifetime.signal.addEventListener('abort',abort,{once:true});
  let timer:ReturnType<typeof setTimeout>|undefined,held=false;
  try{
   const deadline=Date.now()+deps.config.limits.hookTimeoutMs;
   timer=setTimeout(abort,deps.config.limits.hookTimeoutMs);
   const raw=event.input as Record<string,unknown>;
   const input=event.toolName!=='bash'&&raw&&typeof raw==='object'&&typeof raw.path==='string'?{...raw,path:resolve(ctx.cwd,raw.path)}:raw;
   const screened=await screenDamagePayload({kind:event.toolName==='bash'?'command':'edit',input},{root:deps.root,config:deps.config,canRead:deps.canRead,signal:controller.signal});
   if(screened.status!=='ready')return revoked()?{block:true,reason:'Damage-Control: cancelled'}:{block:false};
   const request={state:{owner:contract.owner,trigger:event.toolName,scope:screened.scope,coverage:screened.coverage,bytes:screened.bytes,payload:screened.payload},questions:DAMAGE_GUARD_QUESTIONS,questionSetVersion:DAMAGE_GUARD_VERSION,timeoutMs:Math.max(1,deadline-Date.now()),signal:controller.signal};
   if(Buffer.byteLength(JSON.stringify({...request,signal:undefined}))>deps.config.limits.maxPayloadBytes)return {block:false};
   const result=await Promise.race([deps.service.evaluate(request),new Promise<System1Result>(resolve=>{if(controller.signal.aborted)resolve({status:'cancelled'});else controller.signal.addEventListener('abort',()=>resolve({status:'cancelled'}),{once:true});})]);
   if(revoked()||JSON.stringify(action(event,ctx))!==identity)return {block:true,reason:'Damage-Control: authority changed or cancelled'};
   if(result.status!=='ok'){backoff=Date.now()+deps.config.limits.outageBackoffMs;return {block:false};}
   if(damageVerdict(result,'call')!=='hold_exact_action')return {block:false};
   held=true;holds.add(holdKey);clearTimeout(timer);timer=undefined;
   // Durable fence precedes the human wait; failed decision writes cannot lose its protection on resume.
   deps.state.hold(contract);
   return resolveHold();
  }catch{return revoked()||held?{block:true,reason:'Damage-Control: cancelled or held approval failed'}:{block:false};}
  finally{if(timer)clearTimeout(timer);deps.signal?.removeEventListener('abort',abort);lifetime.signal.removeEventListener('abort',abort);}
 };
 return {action,call(event:DamageCallEvent,ctx:DamageCallContext){
  if(revoked())return Promise.resolve({block:true,reason:'Damage-Control: cancelled'});
  let initial:DamageAction;try{initial=action(event,ctx);}catch{return Promise.resolve({block:true,reason:'Damage-Control: exact action authority unavailable'});}
  const key=JSON.stringify(initial),prior=pending.get(key);
  // Coalesce assessment, not execution permission: a duplicate observer cannot spend one grant twice.
  if(prior)return prior.then(decision=>decision.block?decision:{block:true,reason:'Damage-Control: duplicate in-flight action; no duplicate execution'});
  const result=evaluate(event,ctx).then(decision=>{
   const proof=admitted.get(key),authorized=proof?.allowed&&proof.denialEpoch===deps.state.denialEpoch(initial)&&(!deps.state.denied(initial)||proof.overrideDenied);
   if(!decision.block&&(revoked()||ctx.revalidateBaseline?.()===false||JSON.stringify(action(event,ctx))!==key||(deps.state.needsArm(initial)||deps.state.held(initial)||holds.has(damageDenyKey(initial)))&&!authorized))return {block:true,reason:'Damage-Control: authority changed before effect admission'};
   return decision;
  }).catch(()=>({block:true,reason:'Damage-Control: action authority revalidation failed'}));
  pending.set(key,result);void result.finally(()=>{if(pending.get(key)===result)pending.delete(key);admitted.delete(key);});return result;
 },dispose(){disposed=true;lifetime.abort();pending.clear();admitted.clear();}};
}
