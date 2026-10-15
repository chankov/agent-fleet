import {randomUUID} from 'node:crypto';
import {createOneUseAuthority,type OneUseAuthority} from './action-authorization.ts';
import {actionPresentation} from './task-triage-authorization.ts';
import {createDamageState,type DamageAction} from './damage-guard-state.ts';
import type {RuntimeQuestion} from '../ask-user-remote/runtime-ask.ts';
const key=(a:DamageAction)=>JSON.stringify([a.taskId,a.inputRevision,a.actionId,a.owner,a.attempt,a.operation,a.target,a.cwd]);
export type DamageApprovalProof=Readonly<{allowed:boolean;denialEpoch:number;overrideDenied:boolean}>;
export type DamageApprovalResult={status:'allowed';grant:OneUseAuthority}|{status:'denied'|'expired'|'cancelled'|'unpresentable'|'persistence_failed'};
export function createDamageApproval(deps:{state:ReturnType<typeof createDamageState>;current():DamageAction;baseline():boolean;ask(id:string,question:RuntimeQuestion,signal:AbortSignal):Promise<unknown>;timeoutMs?:number}){
 const authority=createOneUseAuthority();
 const generations=new Map<string,number>(),issued=new WeakMap<object,{binding:string;generation:number;denialEpoch:number;overrideDenied:boolean}>(),pending=new Map<string,Promise<DamageApprovalResult>>();
 const current=(a:DamageAction,signal?:AbortSignal)=>!signal?.aborted&&key(a)===key(deps.current())&&deps.baseline();
 const consumeProof=(grant:OneUseAuthority,action:DamageAction,signal?:AbortSignal):DamageApprovalProof=>{
  const row=issued.get(grant),failed=Object.freeze({allowed:false,denialEpoch:0,overrideDenied:false});
  if(!row||row.binding!==key(action)||row.generation!==generations.get(row.binding)||row.denialEpoch!==deps.state.denialEpoch(action)||deps.state.denied(action)&&!row.overrideDenied||!current(action,signal))return failed;
  issued.delete(grant);if(!authority.consume(grant,key(action)))return failed;
  try{deps.state.consumeAllow(action);}catch{return failed;}
  if(row.denialEpoch!==deps.state.denialEpoch(action)||!current(action,signal))return failed;
  return Object.freeze({allowed:true,denialEpoch:row.denialEpoch,overrideDenied:row.overrideDenied});
 };
 return {
  request(action:DamageAction,input:unknown,signal?:AbortSignal):Promise<DamageApprovalResult>{
   const binding=key(action),prior=pending.get(binding);if(prior)return prior;
   const generation=(generations.get(binding)??0)+1;generations.set(binding,generation);
   const result=request(action,input,generation,signal);pending.set(binding,result);void result.finally(()=>{if(pending.get(binding)===result)pending.delete(binding);});return result;
  },
  consume(grant:OneUseAuthority,action:DamageAction,signal?:AbortSignal){return consumeProof(grant,action,signal).allowed;},consumeProof,
 };
 async function request(action:DamageAction,input:unknown,generation:number,signal?:AbortSignal):Promise<DamageApprovalResult>{
   const snapshot={...action},binding=key(snapshot),detail=actionPresentation(snapshot,{input,cwd:snapshot.cwd});
   if(!detail)return {status:'unpresentable'};if(!current(snapshot,signal))return {status:'cancelled'};
   try{deps.state.hold(snapshot);}catch{return {status:'persistence_failed'};}
   const denialEpoch=deps.state.denialEpoch(snapshot);
   const waitSignal=signal??new AbortController().signal;
   const result=await (async():Promise<DamageApprovalResult>=>{
    if(!current(snapshot,waitSignal))return {status:'cancelled'};
    const id=randomUUID(),controller=new AbortController(),abort=()=>controller.abort();waitSignal.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(()=>controller.abort(),deps.timeoutMs??600000);
    try{
     const question:RuntimeQuestion={question:'Approve this exact Damage-Control action once?',context:`Task: ${snapshot.taskId}\nRevision: ${snapshot.inputRevision}\nOwner: ${snapshot.owner}\nAttempt: ${snapshot.attempt}\n${detail}`,options:['Allow once','Deny'],allowMultiple:false,allowFreeform:false,allowComment:false};
     const response=await deps.ask(id,question,controller.signal) as {isError?:boolean;details?:{cancelled?:boolean;runtimeAsk?:{requestId?:string};response?:{kind?:string;selections?:unknown[]}}};
     if(!current(snapshot,waitSignal)||key(action)!==binding)return {status:'cancelled'};
     if(controller.signal.aborted)return {status:'expired'};
     const row=response?.details;if(response?.isError||row?.cancelled||row?.runtimeAsk?.requestId!==id||row.response?.kind!=='selection'||row.response.selections?.length!==1)return {status:'expired'};
     const choice=row.response.selections[0];
     if(choice!=='Allow once'&&choice!=='Deny')return {status:'expired'};
     try{if(choice==='Deny'){deps.state.deny(snapshot);return {status:'denied'};}if(denialEpoch!==deps.state.denialEpoch(snapshot))return {status:'cancelled'};deps.state.allow(snapshot);}catch{return {status:'persistence_failed'};}
     if(!current(snapshot,waitSignal)||key(action)!==binding)return {status:'cancelled'};
     const grant=authority.issue(binding);issued.set(grant,{binding,generation,denialEpoch,overrideDenied:deps.state.denied(snapshot)});return {status:'allowed',grant};
    }catch{return {status:waitSignal.aborted?'cancelled':'expired'};}finally{clearTimeout(timer);waitSignal.removeEventListener('abort',abort);}
   })();
   return result??{status:'cancelled'};
  }
}
