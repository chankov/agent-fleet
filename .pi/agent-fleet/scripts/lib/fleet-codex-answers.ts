// S6b native-context human actions. The API is cooperative, not human attestation.
import { randomUUID } from 'node:crypto';
import { redactSecrets } from '../../../harnesses/lib/fleet-transcript-store.ts';
import { AllowedSessionsPolicy, type ConversationKey, type TargetEpoch } from './fleet-codex-allowlist.ts';
import { AllowedSessionsStore, type StoreHandle } from './fleet-codex-allowlist-store.ts';
import { ReadonlyFleetBridge, type RegistryReader } from './fleet-codex-readonly.ts';
import { ActionLedger, targetKey, validInstructionTarget, type QuestionReceipt, type QuestionOutcome } from './fleet-codex-instruction-store.ts';
import { exact, validId, validToolCall, normalizeAnswer, validSnapshot, validateQuestionAnswer, answerDigest, questionDigest, type AnswerTransport, type QuestionBinding } from './fleet-codex-answer-transport.ts';
export class AnswerError extends Error {readonly code:string;constructor(code:string){super(code);this.code=code;}}
function fail(code:string):never{throw new AnswerError(code);}
const key=(c:ConversationKey)=>JSON.stringify([c.hostProfile,c.principal,c.threadId]);
export function parseAnswer(v:unknown){
 if(!exact(v,['requestId','target','questionId','toolCallId','operation','response'])||Buffer.byteLength(JSON.stringify(v))>65536||!validId(v.requestId)||!validInstructionTarget(v.target)||!validId(v.questionId)||!validToolCall(v.toolCallId)||v.operation!=='answer'&&v.operation!=='refusal'||(v.operation==='refusal')!==(v.response===null))fail('INVALID_ARGUMENTS');
 let response;try{response=normalizeAnswer(v.response);}catch{fail('INVALID_ARGUMENTS');}
 return {requestId:v.requestId,target:structuredClone(v.target),questionId:v.questionId,toolCallId:v.toolCallId,operation:v.operation as 'answer'|'refusal',response};
}
type Args=ReturnType<typeof parseAnswer>;
type Access={store:AllowedSessionsStore;handle:StoreHandle};
type Proposal={context:string;expires:number;args:Args;access:Access;questionDigest:string;digest:string;promise?:Promise<Record<string,unknown>>;outcome?:{result?:Record<string,unknown>;error?:unknown}};
export type AnswerBridgeOptions={policyRoot:string;assertNewAction?:(context:ConversationKey,requestId:string)=>void;registryReader:RegistryReader;transport:Pick<AnswerTransport,'inspect'|'send'|'receipt'>;now?:()=>number;monotonic?:()=>number;pendingBudget?:(context:string)=>{total:number;context:number}};
export class AnswerBridge {
 readonly #options:AnswerBridgeOptions;readonly #auth:ReadonlyFleetBridge;readonly #ledger:ActionLedger;readonly #pending=new Map<string,Proposal>();
 constructor(options:AnswerBridgeOptions){this.#options=options;this.#auth=new ReadonlyFleetBridge({registryReader:options.registryReader,policyBaseDir:options.policyRoot,now:options.now});this.#ledger=new ActionLedger(options.policyRoot+'.instructions',{now:options.now});}
 #context(c:ConversationKey){new AllowedSessionsPolicy().list(c);if(!exact(c,['hostProfile','principal','threadId']))fail('IDENTITY_REQUIRED');}
 #time(){const t=(this.#options.monotonic??(()=>performance.now()))();if(!Number.isFinite(t)||t<0)fail('CLOCK_INVALID');return t;}
 #prune(){const n=this.#time();for(const [id,p]of this.#pending)if(!p.promise&&p.expires<=n)this.#pending.delete(id);}
 pendingCount(context?:string){this.#prune();return context===undefined?this.#pending.size:[...this.#pending.values()].filter(p=>p.context===context).length;}
 #history(receipt:QuestionReceipt){return {status:'historical',source:'local_action_ledger',scope:'historical_only',completion:'not_established',humanProvenance:'unknown',receipt};}
 #same(old:ReturnType<ActionLedger['lookupAction']>,a:Args):QuestionReceipt {
  if(!old||old.operation==='instruction'||old.operation!==a.operation||targetKey(old.target)!==targetKey(a.target)||old.questionId!==a.questionId||old.toolCallId!==a.toolCallId||old.digest!==answerDigest(a.operation,a.target,a.questionId,a.toolCallId,old.questionDigest,a.response))fail('INTENT_CONFLICT');return old;
 }
 async #read(c:ConversationKey,t:TargetEpoch){const r=await this.#auth.checkAllowedReadTarget(c,{project:t.project,peer:t.peer});if(targetKey(r.target)!==targetKey(t))fail('TARGET_CHANGED');}
 async #access(c:ConversationKey,t:TargetEpoch,a?:Access):Promise<Access>{
  await this.#read(c,t);const s=await this.#auth.discoverCandidates(c,{project:t.project});if(s.status!=='complete'||s.partial)fail('REGISTRY_UNAVAILABLE');
  const matches=s.candidates.filter(v=>v.target.peer===t.peer);if(matches.length!==1||matches[0].presence!=='fresh'||targetKey(matches[0].target)!==targetKey(t))fail('TARGET_CHANGED');
  const counts=new Map<string,number>();for(const v of s.candidates)counts.set(v.target.peer,(counts.get(v.target.peer)??0)+1);const current=s.candidates.filter(v=>v.presence==='fresh'&&counts.get(v.target.peer)===1).map(v=>v.target);
  if(!a){const store=new AllowedSessionsStore(this.#options.policyRoot,c),state=await store.list(current),found=state.bindings.filter(v=>targetKey(v.target)===targetKey(t));if(found.length!==1)fail('NOT_ALLOWED');a={store,handle:await store.resolve(found[0].alias,current)};}
  if(targetKey(await a.store.authorize(a.handle,'send',current))!==targetKey(t))fail('TARGET_CHANGED');return a;
 }
 async prepare(c:ConversationKey,input:unknown,signal?:AbortSignal):Promise<Record<string,unknown>>{
  this.#context(c);const args=parseAnswer(input),old=this.#ledger.lookupAction(c,args.requestId);if(old)return this.#history(this.#same(old,args));this.#options.assertNewAction?.(c,args.requestId);this.#ledger.assertWritable(c);
  if(signal?.aborted)fail('REQUEST_CANCELLED');const access=await this.#access(c,args.target),q=await this.#options.transport.inspect(args.target,args.questionId,args.toolCallId,signal);
  await this.#read(c,args.target);if(signal?.aborted)fail('REQUEST_CANCELLED');
  if(!validSnapshot(q)||redactSecrets(JSON.stringify(q))!==JSON.stringify(q)||q.state!=='pending'||targetKey(q.owner)!==targetKey(args.target)||q.id!==args.questionId||q.toolCallId!==args.toolCallId||!validateQuestionAnswer(q,args.response))fail('QUESTION_CHANGED');
  this.#prune();const budget=this.#options.pendingBudget?.(key(c))??{total:0,context:0};if(this.#pending.size+budget.total>=64||this.pendingCount(key(c))+budget.context>=16)fail('BUSY');
  const proposalId=randomUUID(),qd=questionDigest(q),digest=answerDigest(args.operation,args.target,args.questionId,args.toolCallId,qd,args.response);
  this.#pending.set(proposalId,{context:key(c),expires:this.#time()+300000,args,access,questionDigest:qd,digest});
  return {status:'prepared',source:'local_human_action_proposal',proposalId,expiresInSeconds:300,...args,question:structuredClone(q),questionDigest:qd,digest,expectedRevision:access.handle.revision,requiresHumanConfirmation:true,humanProvenance:'unknown',effect:args.operation==='refusal'?'one question-scoped human refusal; not Pi turn cancel':'one addressed human answer to this exact pending question; not an LLM instruction'};
 }
 async commit(c:ConversationKey,id:string,signal?:AbortSignal):Promise<Record<string,unknown>>{
  this.#context(c);this.#prune();const p=this.#pending.get(id);if(!p||p.context!==key(c)||p.expires<=this.#time())fail('PROPOSAL_UNAVAILABLE');
  if(p.outcome){if(p.outcome.error)throw p.outcome.error;return structuredClone(p.outcome.result!);}if(p.promise)return p.promise;
  p.promise=(async()=>{let reserved:QuestionReceipt|undefined;
   try{
    const a=p.args,old=this.#ledger.lookupAction(c,a.requestId);if(old)return this.#history(this.#same(old,a));if(signal?.aborted)fail('REQUEST_CANCELLED');this.#options.assertNewAction?.(c,a.requestId);await this.#access(c,a.target,p.access);if(signal?.aborted)fail('REQUEST_CANCELLED');
    const reservation=this.#ledger.reserveAction(c,{operation:a.operation,requestId:a.requestId,target:a.target,questionId:a.questionId,toolCallId:a.toolCallId,questionDigest:p.questionDigest,digest:p.digest},{alias:p.access.handle.alias,policyRevision:p.access.handle.revision});
    if(!reservation.created)return this.#history(this.#same(reservation.receipt,a));reserved=reservation.receipt as QuestionReceipt;
    let result=await this.#options.transport.send(a.target,this.#binding(reserved),a.response,{signal,beforeWrite:async()=>{await this.#access(c,a.target,p.access);if(signal?.aborted)fail('REQUEST_CANCELLED');this.#options.assertNewAction?.(c,a.requestId);this.#ledger.markActionAttempt(c,a.requestId);}});
    try{await this.#read(c,a.target);}catch{result={state:'unknown',detail:'AUTHORIZATION_CHANGED',result:null};}
    if(signal?.aborted)result={state:'unknown',detail:'TRANSPORT_UNCERTAIN',result:null};
    return {...this.#history(this.#ledger.recordAction(c,a.requestId,result)),status:'recorded',source:'local_action_receipt'};
   }catch(error){if(reserved){try{this.#ledger.recordAction(c,reserved.requestId,{state:'not_sent',detail:'TRANSPORT_UNCERTAIN',result:null});}catch{/* preserve original uncertain state; no retry */}}throw error;}
  })();
  try{const result=await p.promise;p.outcome={result};return structuredClone(result);}catch(error){p.outcome={error};throw error;}finally{p.promise=undefined;}
 }
 #binding(r:QuestionReceipt):QuestionBinding{return{operation:r.operation,questionId:r.questionId,toolCallId:r.toolCallId,questionDigest:r.questionDigest,actionDigest:r.digest,wireId:r.wireId};}
 async receipt(c:ConversationKey,input:unknown,signal?:AbortSignal):Promise<Record<string,unknown>>{
  this.#context(c);if(!exact(input,['requestId'],['refresh'])||!validId(input.requestId)||Object.hasOwn(input,'refresh')&&typeof input.refresh!=='boolean')fail('INVALID_ARGUMENTS');
  let r=this.#ledger.lookupAction(c,input.requestId);if(!r)fail('INTENT_UNAVAILABLE');if(r.operation==='instruction')fail('INTENT_CONFLICT');if(input.refresh!==true)return this.#history(r);this.#ledger.assertWritable(c);
  if(signal?.aborted)fail('REQUEST_CANCELLED');await this.#read(c,r.target);if(!r.attempted)return this.#history(r);
  const remote:QuestionOutcome|null=await this.#options.transport.receipt(r.target,this.#binding(r),signal);await this.#read(c,r.target);if(signal?.aborted)fail('REQUEST_CANCELLED');
  if(remote)r=this.#ledger.recordAction(c,r.requestId,remote);return {...this.#history(r),refresh:remote?'terminal_observed':'unknown'};
 }
}
