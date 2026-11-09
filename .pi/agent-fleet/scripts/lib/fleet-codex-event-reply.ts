import {createHash} from 'node:crypto';
import {decodeQuestionReference} from '../../../harnesses/lib/fleet-question-reference.ts';
import {targetKey,validInstructionTarget} from './fleet-codex-instruction-store.ts';
import {redactSecrets} from '../../../harnesses/lib/fleet-transcript-store.ts';
import type {AddressedFleetEvent,CodexEventBinding} from '../../../harnesses/lib/fleet-codex-event-bridge.ts';
import type {TargetEpoch} from './fleet-codex-allowlist.ts';
const sha=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)??'null').digest('hex');
export type FleetEventReply={kind:'message';summary:string}|{kind:'question';response:unknown}|{kind:'permission';decision:'allow_once'|'deny';reason:string};
export type ReplyPorts={
 /** Decoded tool payloads from the ACTUAL native host context, never identity copied from notification text. */
 invoke(name:string,args:unknown):Promise<any>;
 currentBinding():CodexEventBinding|null;
 /** First-party native invocation metadata, independent of BOTH the event and saved binding. */
 nativeIdentity():{threadId:string;identityAssurance:'host_context_validated'|'unknown'}|null;
 /** Human workflow only; never a boolean supplied by the notification/model payload. */
 confirmHuman?:(proposal:unknown)=>Promise<boolean>;
};
/** Route a host/model-selected response; never chooses task necessity or manufactures
 * human consent. Native APIs independently enforce read/send/approve and exact freshness. */
export async function replyFleetEvent(event:AddressedFleetEvent,target:TargetEpoch,reply:FleetEventReply,ports:ReplyPorts){
 const binding=ports.currentBinding();
 const fresh=()=>{const now=ports.currentBinding(),native=typeof ports.nativeIdentity==='function'?ports.nativeIdentity():null;return native?.identityAssurance==='host_context_validated'&&!!binding&&native.threadId===binding.threadId&&!!now&&sha(now)===sha(binding)&&event.bindingId===binding.id&&event.bindingEpoch===binding.epoch&&event.fleetOwner===binding.fleetOwner&&binding.fleetOwner===targetKey(target)&&Date.now()<event.deadline;};
 if(!validInstructionTarget(target)||!fresh()||reply.kind!==event.kind)throw Error('event_reply_stale_or_wrong_kind');
 const question=event.kind==='question'?decodeQuestionReference(event.reference):null;
 if(event.kind==='question'&&!question)throw Error('event_reply_reference_invalid');
 const prefix='fleet:'+event.kind+'/';
 if(!question&&!event.reference.startsWith(prefix))throw Error('event_reply_reference_invalid');
 const parts=question?[]:event.reference.slice(prefix.length).split('/');
 if(parts.some(p=>!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(p)))throw Error('event_reply_reference_invalid');
 const requestId='reply-'+sha([binding!.id,binding!.epoch,event.id,event.kind]);
 if(reply.kind==='message')return {status:'summary_only',source:'codex_machine',summaryPreview:redactSecrets(reply.summary).slice(0,1024),humanConsent:false,piEffect:'not_established'};
 if(reply.kind==='question'){
  if(!question)throw Error('question_reference_incomplete');
  if(redactSecrets(JSON.stringify(reply.response))!==JSON.stringify(reply.response))throw Error('question_response_unaddressable');
  const proposal=await ports.invoke('fleet_answer_prepare',{requestId,target,questionId:question.questionId,toolCallId:question.toolCallId,operation:reply.response===null?'refusal':'answer',response:reply.response});
  if(!fresh())throw Error('event_reply_expired');
  if(!ports.confirmHuman)return {status:'human_confirmation_required',proposal,humanConsent:false};
  if(!await ports.confirmHuman(proposal))return {status:'human_confirmation_not_obtained',humanConsent:false};
  if(!fresh())throw Error('event_reply_expired');
  const result=await ports.invoke('fleet_answer_commit',{proposalId:proposal.proposalId});
  return {status:'question_commit_returned',result,humanProvenance:'host_callback_not_cryptographic',piEffect:'not_established'};
 }
 if(parts.length!==1||parts[0].length>96||!['allow_once','deny'].includes(reply.decision)||!reply.reason?.trim()||reply.reason.length>2000||redactSecrets(reply.reason)!==reply.reason)throw Error('permission_reply_invalid');
 let cursor:string|null=null,snapshot:any,seen=new Set<string>();
 for(let page=0;page<8;page++){
  if(!fresh())throw Error('event_reply_expired');
  const result=await ports.invoke('fleet_permissions',{target,operation:'list',snapshot:null,...(cursor?{cursor}:{})});
  if(result?.status!=='ok'||!Array.isArray(result.requests))throw Error('permission_list_unavailable');
  snapshot=result.requests.find((r:any)=>r?.snapshot?.id===parts[0])?.snapshot;if(snapshot)break;
  cursor=result.nextCursor??null;if(!cursor)break;if(seen.has(cursor))throw Error('permission_cursor_invalid');seen.add(cursor);
 }
 if(!snapshot||!validInstructionTarget(snapshot.owner)||targetKey(snapshot.owner)!==targetKey(target)||!fresh())throw Error('permission_not_pending');
 const inspection=await ports.invoke('fleet_permissions',{target,operation:'inspect',snapshot});
 if(inspection?.status!=='ok'||inspection.state?.status!=='pending'||sha(inspection.view?.snapshot)!==sha(snapshot)||!fresh())throw Error('permission_changed');
 const result=await ports.invoke('fleet_permission_decide',{requestId,snapshot,decision:reply.decision,reason:reply.reason});
 // Tool return/accepted_by_latch is not applied or tool completion. No automatic retry.
 return {status:'machine_decision_returned',source:'codex_machine',humanConsent:false,result,piEffect:'not_established',automaticResend:false};
}
