import { createHash, randomUUID } from 'node:crypto';
import type { Socket } from 'node:net';
import { processShared } from '../lib/process-shared.ts';
import { redactSecrets } from '../lib/fleet-transcript-store.ts';
import { exact, validHash, validBinding, validSnapshot, questionDigest, answerDigest, normalizeAnswer, validateQuestionAnswer, questionCapability, type QuestionSnapshot } from '../../agent-fleet/scripts/lib/fleet-codex-answer-transport.ts';
import { validInstructionTarget } from '../../agent-fleet/scripts/lib/fleet-codex-instruction-store.ts';

export interface QuestionOwner { project:string; peer:string; sessionId:string; startedAt:string; }
export interface QuestionParams {
	question:string; context?:string; options?:Array<string | {title:string; description?:string}>;
	allowMultiple?:boolean; allowFreeform?:boolean; allowComment?:boolean;
}
type Answer = {kind:'selection'; selections:string[]; comment?:string} | {kind:'freeform'; text:string} | null;
type Status = 'pending' | 'answered' | 'cancelled' | 'expired' | 'failed';
interface Question {
	id:string; toolCallId:string; owner:QuestionOwner; question:string; context?:string;
	options:Array<{title:string; description?:string}>;
	allowMultiple:boolean; allowFreeform:boolean; allowComment:boolean;
	createdAt:string; expiresAt:null; state:Status;
}
interface RecordEntry {
	question:Question; offer?: (result:unknown) => boolean;
	receipt?: {requestId:string; digest:string};
}
const sameOwner = (a:QuestionOwner|null|undefined,b:QuestionOwner|null|undefined) => !!a && !!b &&
	['project','peer','sessionId','startedAt'].every(k => typeof a[k as keyof QuestionOwner] === 'string' && a[k as keyof QuestionOwner] === b[k as keyof QuestionOwner]);
const validId = (value:unknown):value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(value);

/** Owned by the Pi process. Only the shared race latch can accept an answer. */
export class QuestionChannel {
	enabled = false;
	private entries = new Map<string,RecordEntry>();
	private omitted = false;
	// Separate volatile proof window, not another arbiter or a human-auth mechanism.
	private guardedReceipts = new Map<string,Record<string,unknown>>();
	private owner:() => QuestionOwner|null;
	constructor(owner:() => QuestionOwner|null) { this.owner = owner; }
	reset() { for (const entry of this.entries.values()) this.close(entry,'expired'); this.omitted=false; this.guardedReceipts.clear(); }
	private close(entry:RecordEntry, state:Status) {
		if (entry.question.state !== 'pending') return;
		entry.question.state = state; entry.offer = undefined;
	}
	private check(owner:QuestionOwner) {
		if (!this.enabled) return 'unsupported';
		const current=this.owner();
		for (const entry of this.entries.values()) if (!sameOwner(entry.question.owner,current)) this.close(entry,'expired');
		return sameOwner(current,owner) ? null : 'stale';
	}
	open(toolCallId:string, params:QuestionParams) {
		const owner=this.owner();
		if (!this.enabled || !owner || !toolCallId || typeof params.question !== 'string' || !params.question.trim()) return null;
		this.check(owner);
		if (Buffer.byteLength(JSON.stringify(params)) > 16000 || [...this.entries.values()].filter(e=>e.question.state==='pending').length >= 64) {
			this.omitted=true; return null;
		}
		// Retain bounded terminal records for duplicate and late classification.
		for (const [id,entry] of this.entries) {
			if (this.entries.size < 256) break;
			if (entry.question.state !== 'pending') this.entries.delete(id);
		}
		const question:Question = {
			id:randomUUID(), toolCallId, owner:{...owner}, question:params.question,
			context:params.context?.trim() || undefined,
			options:(params.options??[]).map(v=>typeof v==='string'?{title:v}:v),
			allowMultiple:params.allowMultiple??false, allowFreeform:params.allowFreeform??true,
			allowComment:params.allowComment??false, createdAt:new Date().toISOString(), expiresAt:null, state:'pending',
		};
		const entry:RecordEntry={question}; this.entries.set(question.id,entry);
		return {
			id:question.id,
			registerAnswer:(offer:(result:unknown)=>boolean) => { if (question.state==='pending') entry.offer=offer; },
			onSettled:({result}:{result?:{isError?:boolean;details?:{cancelled?:boolean}}}) => this.close(entry,!result||result.isError?'failed':result.details?.cancelled?'cancelled':'answered'),
			validateRemote:(result:{details?:{response?:unknown;cancelled?:boolean}}) => {
				const response=result?.details?.response;
				if (validateAnswer(question,response)===undefined || (response===null)!==(result?.details?.cancelled===true)) throw Error('invalid remote answer');
				return result;
			},
			expire:() => this.close(entry,'expired'),
		};
	}
	guarded(e:Record<string,unknown>):Record<string,unknown> {
		const common=['type','version','msg_id','owner','operation','questionId','toolCallId'];
		const metadata=['sender_session','sender_endpoint','hops','timestamp'];
		const inspect=e.operation==='inspect';
		const fields=inspect?common:[...common,'questionDigest','actionDigest','wireId',...(e.operation==='receipt'?[]:['response'])];
		if(!exact(e,fields,metadata)||e.type!=='question_request'||e.version!==2||!validId(e.msg_id)||!validInstructionTarget(e.owner)||!validId(e.questionId)||typeof e.toolCallId!=='string'||!e.toolCallId||e.toolCallId.length>256||/[\u0000-\u001f\u007f]/u.test(e.toolCallId))return {status:'invalid'};
		const owner=e.owner, ownerStatus=this.check(owner);if(ownerStatus)return {status:ownerStatus};
		const base={questionId:e.questionId,toolCallId:e.toolCallId,questionDigest:e.questionDigest??null,actionDigest:e.actionDigest??null,wireId:e.wireId??null};
		if(!inspect&&!validBinding(e))return {status:'invalid'};
		if(!inspect){
			const old=this.guardedReceipts.get(e.wireId as string);
			if(old){if(!validInstructionTarget(old.owner)||!sameOwner(old.owner,owner)||!Object.entries(base).every(([k,v])=>old[k]===v))return {...base,status:'conflict'};
				if(e.operation!=='receipt'){try{if(e.operation!=='answer'&&e.operation!=='refusal'||(e.operation==='refusal')!==(e.response===null)||answerDigest(e.operation,owner,e.questionId,e.toolCallId,e.questionDigest as string,e.response)!==e.actionDigest)return {...base,status:'conflict'};}catch{return {...base,status:'invalid'};}}
				return structuredClone(old);
			}
			if(e.operation==='receipt')return {...base,status:'unknown'};
		}
		if(!inspect&&e.operation!=='answer'&&e.operation!=='refusal')return {...base,status:'unsupported'};
		const entry=this.entries.get(e.questionId);
		if(!entry||!sameOwner(entry.question.owner,owner)||entry.question.toolCallId!==e.toolCallId)return {...base,status:'unknown'};
		const q=entry.question;
		if(!validSnapshot(q)||redactSecrets(JSON.stringify(q))!==JSON.stringify(q))return {...base,status:'not_addressable'};
		const snapshot=q as QuestionSnapshot,digest=questionDigest(snapshot);
		if(inspect)return q.state==='pending'&&entry.offer&&this.guardedReceipts.size<256?{...base,status:'pending',ready:true,capability:questionCapability,question:structuredClone(q),questionDigest:digest}:{...base,status:'not_ready'};
		if(digest!==e.questionDigest||!validHash(e.actionDigest)||e.msg_id!==e.wireId)return {...base,status:'changed'};
		let response;try{response=normalizeAnswer(e.response);}catch{return {...base,status:'invalid'};}
		if((e.operation==='refusal')!==(response===null)||!validateQuestionAnswer(snapshot,response)||answerDigest(e.operation as 'answer'|'refusal',owner,q.id,q.toolCallId,digest,response)!==e.actionDigest)return {...base,status:'invalid'};
		// A v1 accepted receipt is deliberately not upgraded into v2 proof.
		if(entry.receipt?.requestId===e.wireId)return {...base,status:'unknown'};
		if(this.guardedReceipts.size>=256)return {...base,status:'rejected',outcome:'rejected',decisionAt:new Date().toISOString()};
		const result=this.submit(owner,q.id,e.wireId as string,response);
		const status=result.status==='accepted'?'accepted':result.status==='expired'?'expired':result.status==='late'?'late':'rejected';
		const proof={owner:structuredClone(owner),...base,status,outcome:status==='accepted'?(e.operation==='answer'?'answered':'declined'):status,decisionAt:new Date().toISOString()};
		this.guardedReceipts.set(e.wireId as string,proof);return structuredClone(proof);
	}
	list(owner:QuestionOwner, after?:string) {
		const status=this.check(owner);
		const entries=status?[]:[...this.entries.values()].filter(e=>sameOwner(e.question.owner,owner));
		const start=after?entries.findIndex(e=>e.question.id===after):-1;
		const pending=entries.slice(start+1).filter(e=>e.question.state==='pending');
		const questions:Question[]=[];let bytes=0;
		for(const entry of pending) {
			const size=Buffer.byteLength(JSON.stringify(entry.question));
			if(bytes+size>32768)break;
			questions.push(structuredClone(entry.question));bytes+=size;
		}
		const closed=entries.filter(e=>e.question.state!=='pending');
		return {status:status??'available', questions,
			resolved:closed.slice(-64).map(e=>({id:e.question.id,state:e.question.state,requestId:e.receipt?.requestId})),
			nextCursor:questions.length<pending.length?questions.at(-1)?.id??null:null,
			partial:this.omitted||questions.length<pending.length||closed.length>64||Boolean(after&&start===-1)};
	}
	submit(owner:QuestionOwner, id:string, requestId:string, input:unknown) {
		const status=this.check(owner);
		if (status) return {status};
		if (!validId(id) || !validId(requestId)) return {status:'invalid'};
		if ([...this.entries.values()].some(e=>e.question.id!==id&&e.receipt?.requestId===requestId)) return {status:'conflict'};
		const entry=this.entries.get(id);
		if (!entry) return {status:'unknown_question'};
		if (!sameOwner(entry.question.owner,owner)) return {status:'stale'};
		const serialized=JSON.stringify(input);
		if (typeof serialized !== 'string' || Buffer.byteLength(serialized)>16000) return {status:'invalid'};
		const digest=createHash('sha256').update(serialized).digest('hex');
		if (entry.receipt?.requestId===requestId) return {status:entry.receipt.digest===digest?'accepted':'conflict', questionId:id};
		if (entry.question.state !== 'pending') return {status:entry.question.state==='expired'?'expired':'late', questionId:id};
		if (!entry.offer) return {status:'not_ready'};
		const answer=validateAnswer(entry.question,input);
		if (answer===undefined) return {status:'invalid'};
		const text=answer===null?'User cancelled the question':answer.kind==='freeform'?`User answered: ${answer.text}`:
			`User answered: ${answer.selections.join(', ')}${answer.comment?` — ${answer.comment}`:''}`;
		const result={content:[{type:'text',text}],details:{question:entry.question.question,context:entry.question.context,
			options:entry.question.options,response:answer,cancelled:answer===null}};
		if (!entry.offer(result)) return {status:'late',questionId:id};
		entry.receipt={requestId,digest};
		return {status:'accepted',questionId:id};
	}
}

function validateAnswer(q:Question,input:unknown):Answer|undefined {
	if (input===null) return null;
	if (!input || typeof input!=='object' || Array.isArray(input)) return undefined;
	const a=input as Record<string,unknown>;
	if (a.kind==='freeform' && q.allowFreeform && Object.keys(a).every(k=>['kind','text'].includes(k)) && typeof a.text==='string' && a.text.trim()) {
		return {kind:'freeform',text:a.text.trim()};
	}
	if (a.kind!=='selection' || !Object.keys(a).every(k=>['kind','selections','comment'].includes(k)) || !Array.isArray(a.selections) ||
		!a.selections.length || (!q.allowMultiple && a.selections.length!==1) || new Set(a.selections).size!==a.selections.length ||
		a.selections.some(v=>typeof v!=='string'||!q.options.some(o=>o.title===v)) ||
		(a.comment!==undefined && (!q.allowComment || typeof a.comment!=='string'))) return undefined;
	return {kind:'selection',selections:a.selections as string[],...(typeof a.comment==='string'&&a.comment.trim()?{comment:a.comment.trim()}:{})};
}

// Module-local singletons would split the wrapper from its coms owner, so the channel
// is process-shared; session_shutdown/reset still expires every address.
interface SharedChannel {peers:Set<() => QuestionOwner|null>;channel:QuestionChannel;}
function createSharedChannel():SharedChannel {
 const peers=new Set<() => QuestionOwner|null>();
 return {peers,channel:new QuestionChannel(()=>{
  const owners=[...peers].map(get=>get()).filter((o):o is QuestionOwner=>o!==null);
  return owners.length===1?owners[0]:null;
 })};
}
const shared=processShared('agent-fleet.addressed-questions.v1',createSharedChannel);
export const questionChannel=shared.channel;
export function registerQuestionPeer(getOwner:() => QuestionOwner|null) { shared.peers.add(getOwner); return () => { shared.peers.delete(getOwner); }; }

/** Uses coms' existing custom-envelope hook; never enqueues an LLM instruction. */
export function handleQuestionEnvelope(socket:Pick<Socket,'end'>, envelope:Record<string,unknown>, channel=questionChannel):boolean {
	if (envelope.type!=='question_request') return false;
	const owner=envelope.owner as QuestionOwner;
	if(envelope.version===2){
		const result=typeof channel.guarded==='function'?channel.guarded(envelope):{status:'unsupported'},response={type:'question_response',version:2,msg_id:validId(envelope.msg_id)?envelope.msg_id:null,owner:validInstructionTarget(owner)?owner:null,...result};
		const bytes=JSON.stringify(response)+'\n';socket.end(Buffer.byteLength(bytes)<=32768?bytes:JSON.stringify({type:'question_response',version:2,msg_id:response.msg_id,owner:response.owner,status:'oversized'})+'\n');return true;
	}
	let result:Record<string,unknown>;
	if (envelope.version!==1 || !owner || !validId(envelope.msg_id)) result={status:'invalid'};
	else if (envelope.operation==='list') result=envelope.after!==undefined&&!validId(envelope.after)?{status:'invalid'}:channel.list(owner,envelope.after as string|undefined);
	else if (envelope.operation==='answer' || envelope.operation==='cancel') result=channel.submit(owner,
		envelope.questionId as string,envelope.msg_id,envelope.operation==='cancel'?null:envelope.answer);
	else result={status:'unsupported'};
	socket.end(JSON.stringify({type:'question_response',version:1,msg_id:envelope.msg_id,owner,...result})+'\n');
	return true;
}
