import {randomUUID} from 'node:crypto';
import {permissionAuditOutcome,type PermissionRelay} from './permission-relay.ts';
import {createOneUseAuthority,type OneUseAuthority} from './action-authorization.ts';
import {actionPresentation} from './task-triage-authorization.ts';
import {createDamageState,type DamageAction} from './damage-guard-state.ts';
import type {RuntimeQuestion} from '../ask-user-remote/runtime-ask.ts';
import {decideIdenticalDialog,identicalDialogKey} from '../lib/identical-dialog.ts';
const key=(a:DamageAction)=>JSON.stringify([a.taskId,a.inputRevision,a.actionId,a.owner,a.attempt,a.operation,a.target,a.cwd]);
export type DamageApprovalProof=Readonly<{allowed:boolean;denialEpoch:number;overrideDenied:boolean}>;
export type DamageApprovalResult={status:'allowed';grant:OneUseAuthority}|{status:'denied'|'expired'|'cancelled'|'unpresentable'|'persistence_failed'};
export function createDamageApproval(deps:{state:ReturnType<typeof createDamageState>;current():DamageAction;baseline():boolean;ask(id:string,question:RuntimeQuestion,signal:AbortSignal,action?:DamageAction):Promise<unknown>;timeoutMs?:number;relay?:PermissionRelay;audit?(record:unknown):void}){
 const authority=createOneUseAuthority();
 const generations=new Map<string,number>(),issued=new WeakMap<object,{binding:string;generation:number;denialEpoch:number;overrideDenied:boolean;expiresAt:number;snapshot:DamageAction;valid?:()=>boolean;applied?:(ok:boolean)=>void}>(),pending=new Map<string,Promise<DamageApprovalResult>>();
 const current=(a:DamageAction,signal?:AbortSignal)=>!signal?.aborted&&key(a)===key(deps.current())&&deps.baseline();
 const revoke=(grant:OneUseAuthority,row:ReturnType<typeof issued.get>)=>{
  if(!row)return;issued.delete(grant);authority.consume(grant,row.binding);
  if(row.generation===generations.get(row.binding)){try{deps.state.consumeAllow(row.snapshot);}catch{}}
  row.applied?.(false);
 };
 const consumeProof=(grant:OneUseAuthority,action:DamageAction,signal?:AbortSignal):DamageApprovalProof=>{
  const row=issued.get(grant),failed=Object.freeze({allowed:false,denialEpoch:0,overrideDenied:false});
  try{
   if(!row||row.binding!==key(action)||row.generation!==generations.get(row.binding)||row.denialEpoch!==deps.state.denialEpoch(action)||deps.state.denied(action)&&!row.overrideDenied||row.valid&&!row.valid()||Date.now()>=row.expiresAt||!current(action,signal)){revoke(grant,row);return failed;}
   issued.delete(grant);if(!authority.consume(grant,key(action))){revoke(grant,row);return failed;}
   deps.state.consumeAllow(action);
   if(row.denialEpoch!==deps.state.denialEpoch(action)||row.valid&&!row.valid()||Date.now()>=row.expiresAt||!current(action,signal)){revoke(grant,row);return failed;}
   row.applied?.(true);return Object.freeze({allowed:true,denialEpoch:row.denialEpoch,overrideDenied:row.overrideDenied});
  }catch{revoke(grant,row);return failed;}
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
   const presentationCurrent=()=>actionPresentation(snapshot,{input,cwd:snapshot.cwd})===detail;
   try{deps.state.hold(snapshot);}catch{return {status:'persistence_failed'};}
   const denialEpoch=deps.state.denialEpoch(snapshot);
   const waitSignal=signal??new AbortController().signal;
   const result=await (async():Promise<DamageApprovalResult>=>{
    if(!current(snapshot,waitSignal))return {status:'cancelled'};
    const id=randomUUID(),controller=new AbortController(),localController=new AbortController(),abort=()=>{controller.abort();localController.abort();};waitSignal.addEventListener('abort',abort,{once:true});
    const expiresAt=Date.now()+(deps.timeoutMs??600000);
    const timer=setTimeout(abort,Math.max(1,expiresAt-Date.now()));
    try{
     const question:RuntimeQuestion={question:'Approve this exact Damage-Control action once?',context:`Task: ${snapshot.taskId}\nRevision: ${snapshot.inputRevision}\nOwner: ${snapshot.owner}\n${detail}`,options:['Allow once','Deny'],allowMultiple:false,allowFreeform:false,allowComment:false};
     const dialogKey=identicalDialogKey(['damage',snapshot.taskId,snapshot.inputRevision,snapshot.owner,snapshot.operation,snapshot.target,snapshot.cwd,question.question,question.options,detail]);
     const relayRequest=!deps.state.needsArm(snapshot)?deps.relay?.open(snapshot,input,()=>current(snapshot,controller.signal)&&presentationCurrent(),expiresAt):null;
     let applied:((ok:boolean)=>void)|undefined;
     const localDecision=async()=>{
      const response=await deps.ask(id,question,localController.signal,snapshot) as {isError?:boolean;details?:{cancelled?:boolean;runtimeAsk?:{requestId?:string};response?:{kind?:string;selections?:unknown[]}}};
      if(!current(snapshot,waitSignal)||!presentationCurrent()||key(action)!==binding||controller.signal.aborted)return 'cancel';
      const row=response?.details,choice=row?.response?.selections?.[0];
      if(response?.isError||row?.cancelled||row?.runtimeAsk?.requestId!==id||row.response?.kind!=='selection'||row.response.selections?.length!==1)return 'cancel';
      return choice==='Allow once'?'allow':choice==='Deny'?'deny':'cancel';
     };
     let decision:'allow'|'deny'|'cancel';
     if(relayRequest){
      applied=relayRequest.applied;
      const abortRelay=()=>relayRequest.cancel();controller.signal.addEventListener('abort',abortRelay,{once:true});
      // The local human UI and machine path share the latch. No runtimeAsk-shaped machine answer.
      void localDecision().then(d=>{if(d==='allow'||d==='deny')relayRequest.human(d==='allow'?'allow_once':'deny','local-ui');},()=>{});
      const outcome=await relayRequest.result;
      localController.abort();
      controller.signal.removeEventListener('abort',abortRelay);
      decision=outcome.status==='decided'?(outcome.decision==='allow_once'?'allow':'deny'):'cancel';
      if(outcome.status==='decided'){try{deps.audit?.({schema:'damage-permission-decision/v1',identityAssurance:outcome.source==='codex_machine'?'cooperative_native_thread_no_host_or_turn_attestation':'local_human_ui',permissionId:relayRequest.id,taskId:snapshot.taskId,inputRevision:snapshot.inputRevision,actionId:snapshot.actionId,actionDigest:relayRequest.actionDigest,payloadDigest:snapshot.target,...permissionAuditOutcome(outcome)});}catch{applied(false);return {status:'persistence_failed'};}}
     }else decision=await decideIdenticalDialog(dialogKey,localDecision,{fresh:deps.state.needsArm(snapshot)});
     if(!current(snapshot,waitSignal)||!presentationCurrent()||key(action)!==binding){applied?.(false);return {status:'cancelled'};}
     if(decision==='cancel')return controller.signal.aborted?{status:'expired'}:{status:'cancelled'};
     try{if(decision==='deny'){deps.state.deny(snapshot);return {status:'denied'};}if(denialEpoch!==deps.state.denialEpoch(snapshot))return {status:'cancelled'};deps.state.allow(snapshot);}catch{return {status:'persistence_failed'};}
     if(!current(snapshot,waitSignal)||!presentationCurrent()||key(action)!==binding||Date.now()>=expiresAt){try{deps.state.consumeAllow(snapshot);}catch{}applied?.(false);return {status:'cancelled'};}
     const grant=authority.issue(binding);issued.set(grant,{binding,generation,denialEpoch,overrideDenied:deps.state.denied(snapshot),expiresAt,snapshot,applied,valid:()=>presentationCurrent()&&(relayRequest?.valid()??true)});return {status:'allowed',grant};
    }catch{return {status:waitSignal.aborted?'cancelled':'expired'};}finally{localController.abort();clearTimeout(timer);waitSignal.removeEventListener('abort',abort);}
   })();
   return result??{status:'cancelled'};
  }
}
