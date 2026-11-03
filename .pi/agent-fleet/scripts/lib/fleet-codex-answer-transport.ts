// S6b shared pure wire contract + bounded explicit-root transport. Import has no I/O.
import { createHash, randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createConnection } from 'node:net';
import { validInstructionTarget, targetKey, type QuestionReceipt, type QuestionOutcome } from './fleet-codex-instruction-store.ts';
import type { TargetEpoch } from './fleet-codex-allowlist.ts';
export const questionCapability = {name:'fleet_question_actions',version:2,expectedToolCallId:true,firstWinner:'pi_question_latch',receipt:'volatile_bounded'} as const;
export const object = (v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
export const exact = (v:unknown, required:string[], optional:string[]=[]):v is Record<string,unknown>=>object(v)&&required.every(k=>Object.hasOwn(v,k))&&Object.keys(v).every(k=>required.includes(k)||optional.includes(k));
export const validId=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(v);
export const validHash=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const date=(v:unknown):v is string=>typeof v==='string'&&v.length<=40&&Number.isFinite(Date.parse(v));
const clean=(v:unknown,max=16000):v is string=>typeof v==='string'&&v.trim().length>0&&Buffer.byteLength(v)<=max&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(v);
export const validToolCall=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=256&&!/[\u0000-\u001f\u007f]/u.test(v);
export type HumanResponse = {kind:'freeform';text:string}|{kind:'selection';selections:string[];comment?:string}|null;
export type QuestionSnapshot={id:string;toolCallId:string;owner:TargetEpoch;question:string;context?:string;options:{title:string;description?:string}[];allowMultiple:boolean;allowFreeform:boolean;allowComment:boolean;createdAt:string;expiresAt:null;state:string};
export function validSnapshot(v:unknown):v is QuestionSnapshot {
 if(!exact(v,['id','toolCallId','owner','question','options','allowMultiple','allowFreeform','allowComment','createdAt','expiresAt','state'],['context'])||!validId(v.id)||!validToolCall(v.toolCallId)||!validInstructionTarget(v.owner)||!clean(v.question)||v.context!==undefined&&!clean(v.context)||!Array.isArray(v.options)||v.options.length>64||!['allowMultiple','allowFreeform','allowComment'].every(k=>typeof v[k]==='boolean')||!date(v.createdAt)||v.expiresAt!==null||!['pending','answered','cancelled','expired','failed'].includes(v.state as string))return false;
 if(!v.options.every(o=>exact(o,['title'],['description'])&&clean(o.title)&& (o.description===undefined||clean(o.description))))return false;
 return new Set(v.options.map(o=>o.title)).size===v.options.length&&Buffer.byteLength(JSON.stringify(v))<=16000;
}
const sha=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export function questionDigest(q:QuestionSnapshot):string{return sha(['fleet-question-v2',targetKey(q.owner),q.id,q.toolCallId,q.question,q.context??null,q.options.map(o=>[o.title,o.description??null]),q.allowMultiple,q.allowFreeform,q.allowComment,q.createdAt,q.expiresAt]);}
export function normalizeAnswer(input:unknown):HumanResponse {
 if(input===null)return null;
 if(Buffer.byteLength(JSON.stringify(input)??'')>16000)throw Error('INVALID_ARGUMENTS');
 if(exact(input,['kind','text'])&&input.kind==='freeform'&&clean(input.text))return {kind:'freeform',text:input.text.trim()};
 if(!exact(input,['kind','selections'],['comment'])||input.kind!=='selection'||!Array.isArray(input.selections)||!input.selections.length||input.selections.length>64||!input.selections.every(v=>clean(v))||new Set(input.selections).size!==input.selections.length||input.comment!==undefined&&typeof input.comment!=='string'||typeof input.comment==='string'&&input.comment.trim()&&!clean(input.comment))throw Error('INVALID_ARGUMENTS');
 return {kind:'selection',selections:[...input.selections] as string[],...(typeof input.comment==='string'&&input.comment.trim()?{comment:input.comment.trim()}:{})};
}
export function validateQuestionAnswer(q:QuestionSnapshot,a:HumanResponse):boolean {
 if(a===null)return true;
 return a.kind==='freeform'?q.allowFreeform:(!a.comment||q.allowComment)&&(q.allowMultiple||a.selections.length===1)&&a.selections.every(t=>q.options.some(o=>o.title===t));
}
export function answerDigest(operation:'answer'|'refusal',owner:TargetEpoch,qid:string,toolCallId:string,qDigest:string,response:unknown):string {
 const a=normalizeAnswer(response),canonical=a===null?null:a.kind==='freeform'?['freeform',a.text]:['selection',a.selections,a.comment??null];
 return sha(['fleet-human-action-v2',operation,targetKey(owner),qid,toolCallId,qDigest,canonical]);
}
export type QuestionBinding={questionId:string;toolCallId:string;questionDigest:string;actionDigest:string;wireId:string;operation:'answer'|'refusal'};
export function validBinding(v:Record<string,unknown>):boolean{return validId(v.questionId)&&validToolCall(v.toolCallId)&&validHash(v.questionDigest)&&validHash(v.actionDigest)&&validHash(v.wireId);}
export class AnswerTransportError extends Error {readonly code:string;constructor(code:string){super(code);this.code=code;}}
function fail(code:string):never{throw new AnswerTransportError(code);}
export class AnswerTransport {
 readonly #root:string;readonly #timeout:number;
 constructor(options:{registryRoot:string;timeoutMs?:number}){if(!isAbsolute(options.registryRoot)||resolve(options.registryRoot)!==options.registryRoot)fail('UNSAFE_PATH');this.#root=options.registryRoot;this.#timeout=options.timeoutMs??1500;if(!Number.isInteger(this.#timeout)||this.#timeout<1||this.#timeout>1500)fail('INVALID_TRANSPORT_OPTIONS');}
 async #endpoint(t:TargetEpoch){if(!validInstructionTarget(t))fail('INVALID_TARGET');for(let p=this.#root;;p=dirname(p)){const s=await lstat(p);if(s.isSymbolicLink()||!s.isDirectory())fail('UNSAFE_PATH');if(p===dirname(p))break;}const dir=await lstat(join(this.#root,'sockets'));if(!dir.isDirectory()||dir.isSymbolicLink())fail('UNSAFE_PATH');const path=join(this.#root,'sockets',t.sessionId+'.sock'),s=await lstat(path);if(!s.isSocket()||s.isSymbolicLink()||process.getuid&&s.uid!==process.getuid())fail('UNSAFE_PATH');return{path,dev:s.dev,ino:s.ino};}
 async #rpc(t:TargetEpoch,fields:Record<string,unknown>,beforeWrite?:()=>Promise<void>,signal?:AbortSignal):Promise<Record<string,unknown>>{
  const ep=await this.#endpoint(t),msg_id=typeof fields.msg_id==='string'?fields.msg_id:randomUUID();
  const envelope={type:'question_request',version:2,msg_id,owner:t,...fields,sender_session:'local-codex-answer',sender_endpoint:'',hops:0,timestamp:new Date().toISOString()},frame=JSON.stringify(envelope)+'\n';if(Buffer.byteLength(frame)>32768)fail('FRAME_TOO_LARGE');
  return new Promise((yes,no)=>{let done=false,b=Buffer.alloc(0);const socket=createConnection(ep.path);const finish=(error?:unknown,r?:Record<string,unknown>)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);socket.destroy();error?no(error):yes(r!);};const abort=()=>finish(new AnswerTransportError('CANCELLED'));const timer=setTimeout(()=>finish(new AnswerTransportError('RPC_TIMEOUT')),this.#timeout);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted){abort();return;}
   socket.once('connect',()=>{void(async()=>{try{const now=await this.#endpoint(t);if(now.dev!==ep.dev||now.ino!==ep.ino)fail('TARGET_CHANGED');if(done||signal?.aborted)return;await beforeWrite?.();if(!done&&!signal?.aborted)socket.write(frame);}catch(e){finish(e);}})();});
   socket.on('data',(chunk:Buffer)=>{if(b.length+chunk.length>32768){finish(new AnswerTransportError('RPC_INVALID'));return;}b=Buffer.concat([b,chunk]);const end=b.indexOf(10);if(end<0)return;try{const r:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(b.subarray(0,end)));if(!object(r)||r.type!=='question_response'||r.version!==2||r.msg_id!==msg_id||!validInstructionTarget(r.owner)||targetKey(r.owner)!==targetKey(t))fail('RPC_INVALID');finish(undefined,r);}catch(e){finish(e);}});socket.once('error',()=>finish(new AnswerTransportError('RPC_UNAVAILABLE')));socket.once('close',()=>finish(new AnswerTransportError('RPC_UNAVAILABLE')));
  });
 }
 async inspect(t:TargetEpoch,qid:string,toolCallId:string,signal?:AbortSignal):Promise<QuestionSnapshot>{
  if(!validId(qid)||!validToolCall(toolCallId))fail('INVALID_ARGUMENTS');const r=await this.#rpc(t,{operation:'inspect',questionId:qid,toolCallId},undefined,signal);
  if(!exact(r,['type','version','msg_id','owner','questionId','toolCallId','questionDigest','actionDigest','wireId','status','ready','capability','question'])||r.status!=='pending'||r.ready!==true||!exact(r.capability,Object.keys(questionCapability))||!Object.entries(questionCapability).every(([k,v])=>(r.capability as Record<string,unknown>)[k]===v)||r.questionId!==qid||r.toolCallId!==toolCallId||r.actionDigest!==null||r.wireId!==null||!validSnapshot(r.question)||r.question.state!=='pending'||targetKey(r.question.owner)!==targetKey(t)||r.question.id!==qid||r.question.toolCallId!==toolCallId||r.questionDigest!==questionDigest(r.question))fail('ANSWER_UNSUPPORTED');return r.question;
 }
 #outcome(r:Record<string,unknown>,binding:QuestionBinding):QuestionOutcome|null{
  if(!exact(r,['type','version','msg_id','owner','questionId','toolCallId','questionDigest','actionDigest','wireId','status'],r.status==='unknown'?[]:['outcome','decisionAt'])||r.questionId!==binding.questionId||r.toolCallId!==binding.toolCallId||r.questionDigest!==binding.questionDigest||r.actionDigest!==binding.actionDigest||r.wireId!==binding.wireId)fail('RECEIPT_INVALID');if(r.status==='unknown')return null;
  if(!['accepted','late','expired','rejected'].includes(r.status as string)||!date(r.decisionAt)||r.outcome!==(r.status==='accepted'?(binding.operation==='answer'?'answered':'declined'):r.status))fail('RECEIPT_INVALID');
  return {state:r.status as QuestionReceipt['state'],detail:null,result:{outcome:r.outcome as NonNullable<QuestionReceipt['result']>['outcome'],decisionAt:r.decisionAt,observedAt:new Date().toISOString(),source:'pi_question_rpc_v2'}};
 }
 async send(t:TargetEpoch,binding:QuestionBinding,response:HumanResponse,options:{beforeWrite:()=>Promise<void>;signal?:AbortSignal}):Promise<QuestionOutcome>{
  if(!validInstructionTarget(t)||!exact(binding,['questionId','toolCallId','questionDigest','actionDigest','wireId','operation'])||!validBinding(binding)||!['answer','refusal'].includes(binding.operation)||(binding.operation==='refusal')!==(response===null)||answerDigest(binding.operation,t,binding.questionId,binding.toolCallId,binding.questionDigest,response)!==binding.actionDigest)fail('INVALID_ARGUMENTS');
  // Read-only inspect precedes the only mutation. A downgrade never triggers v1 fallback.
  const q=await this.inspect(t,binding.questionId,binding.toolCallId,options.signal);if(questionDigest(q)!==binding.questionDigest||!validateQuestionAnswer(q,response)||answerDigest(binding.operation,t,binding.questionId,binding.toolCallId,binding.questionDigest,response)!==binding.actionDigest)fail('QUESTION_CHANGED');
  const r=await this.#rpc(t,{...binding,operation:binding.operation,response,msg_id:binding.wireId},options.beforeWrite,options.signal);return this.#outcome(r,binding)??{state:'unknown',detail:'OUTCOME_UNAVAILABLE',result:null};
 }
 async receipt(t:TargetEpoch,binding:QuestionBinding,signal?:AbortSignal):Promise<QuestionOutcome|null>{if(!validInstructionTarget(t)||!exact(binding,['questionId','toolCallId','questionDigest','actionDigest','wireId','operation'])||!validBinding(binding)||!['answer','refusal'].includes(binding.operation))fail('INVALID_ARGUMENTS');const r=await this.#rpc(t,{...binding,operation:'receipt'},undefined,signal);return this.#outcome(r,binding);}
}
