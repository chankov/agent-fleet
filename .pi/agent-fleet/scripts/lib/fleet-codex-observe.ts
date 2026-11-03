// Post-S4: exact-target observations, not authority inferred from source text.
import { ReadonlyFleetError } from './fleet-codex-readonly.ts';
import { redactSecrets } from '../../../harnesses/lib/fleet-transcript-store.ts';
import type { TargetEpoch } from './fleet-codex-allowlist.ts';
export type ObservationReader = (target: TargetEpoch) => Promise<unknown>;
export type ReadAuthorization = { checkAllowedReadTarget(context: unknown, selectors: unknown): Promise<{target: TargetEpoch}> };
type Status = 'available'|'unavailable'|'unsupported';
type Event = {at:string;kind:'assistant'|'tool'|'turn_end';text:string;seq?:number;id?:string};
export type ObservationWindow={leaf:string|null;ancestry:string[];rootReached:boolean};
const cursorId=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const same=(a:TargetEpoch,b:TargetEpoch)=>['project','peer','sessionId','startedAt'].every(k=>a[k as keyof TargetEpoch]===b[k as keyof TargetEpoch]);
const date=(v:unknown):v is string=>typeof v==='string'&&/^\d{4}-\d\d-\d\dT[0-9:.]+(?:Z|[+-]\d\d:\d\d)$/.test(v)&&Number.isFinite(Date.parse(v));
const text=(v:unknown,n=2000):v is string=>typeof v==='string'&&v.length<=n&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v);
const safeText=(v:unknown,n=2000):v is string=>text(v,n)&&redactSecrets(v)===v;
const id=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(v);
const codes=new Set(['SOURCE_UNAVAILABLE','SOURCE_INVALID','SOURCE_LIMIT','SOURCE_NOT_CONFIGURED','NO_MATCHING_TRANSCRIPT','AMBIGUOUS_TRANSCRIPT','UNSAFE_PATH','READ_ERROR','ENTRY_LIMIT','TRUNCATED','IDENTITY_UNVERIFIED','RPC_UNAVAILABLE','RPC_UNSUPPORTED','RPC_INVALID','REDACTED']);
function common(v:unknown) {
 if(!object(v)||!['available','unavailable','unsupported'].includes(v.status as string)||typeof v.partial!=='boolean'||!Array.isArray(v.reasons)
 ||v.reasons.length>16||v.reasons.some(r=>!codes.has(r as string)))throw new Error('INVALID');
 return {status:v.status as Status,partial:v.partial||v.status!=='available',reasons:[...new Set(v.reasons as string[])]};
}
function transcript(v:unknown):{status:Status;partial:boolean;reasons:string[];source:string;entries:Event[];window?:ObservationWindow} {
 try {
  const c=common(v);if(!object(v)||!Array.isArray(v.entries)||v.entries.length>50)throw new Error('INVALID');
  const entries:Event[]=v.entries.map(e=>{
   if(!object(e)||!date(e.at)||!['assistant','tool','turn_end'].includes(e.kind as string)||!safeText(e.text)
    ||e.seq!==undefined&&(!Number.isSafeInteger(e.seq)||(e.seq as number)<0)||e.id!==undefined&&!cursorId(e.id))throw new Error('INVALID');
   return {at:e.at,kind:e.kind as Event['kind'],text:e.text,...(e.seq===undefined?{}:{seq:e.seq as number}),...(e.id===undefined?{}:{id:e.id as string})};
  });
  if(c.status!=='available'&&entries.length)throw new Error('INVALID');
  let window:ObservationWindow|undefined;
  if(v.window!==undefined){const w=v.window;if(!object(w)||Object.keys(w).length!==3||!['leaf','ancestry','rootReached'].every(k=>Object.hasOwn(w,k))
   ||w.leaf!==null&&!cursorId(w.leaf)||!Array.isArray(w.ancestry)||w.ancestry.length>256||w.ancestry.some(x=>!cursorId(x))||new Set(w.ancestry).size!==w.ancestry.length
   ||typeof w.rootReached!=='boolean'||w.leaf===null&&(w.ancestry.length!==0||!w.rootReached||entries.length!==0)||w.leaf!==null&&w.ancestry[0]!==w.leaf||entries.some(e=>!e.id))throw new Error('INVALID');
   window={leaf:w.leaf as string|null,ancestry:[...w.ancestry] as string[],rootReached:w.rootReached};}
  return {...c,source:'pi_session_branch_projection',entries,...(window?{window}:{})};
 }catch{return {status:'unavailable' as Status,partial:true,reasons:['SOURCE_INVALID'],source:'pi_session_branch_projection',entries:[] as Event[]};}
}
function questions(v:unknown,target:TargetEpoch) {
 try {
  const c=common(v);if(!object(v)||!Array.isArray(v.questions)||!Array.isArray(v.resolved)||v.questions.length>64||v.resolved.length>64
   ||v.nextCursor!==null&&!id(v.nextCursor))throw new Error('INVALID');
  const pending=v.questions.map(q=>{
   if(!object(q)||!object(q.owner)||!same(q.owner as unknown as TargetEpoch,target)||!id(q.id)||!text(q.toolCallId,256)||!q.toolCallId||!safeText(q.question)||!q.question||q.state!=='pending'||!date(q.createdAt)
    ||q.expiresAt!==null&&!date(q.expiresAt)||q.context!==undefined&&!safeText(q.context)||!Array.isArray(q.options)||q.options.length>64
    ||['allowMultiple','allowFreeform','allowComment'].some(k=>typeof q[k]!=='boolean'))throw new Error('INVALID');
   const options=q.options.map(o=>{if(!object(o)||!safeText(o.title)||!o.title||o.description!==undefined&&!safeText(o.description))throw new Error('INVALID');
    return {title:o.title,...(o.description===undefined?{}:{description:o.description})};});
   return {id:q.id,toolCallId:q.toolCallId,question:q.question,state:'pending',createdAt:q.createdAt,expiresAt:q.expiresAt,
    allowMultiple:q.allowMultiple,allowFreeform:q.allowFreeform,allowComment:q.allowComment,options,
    ...(typeof q.context==='string'&&safeText(q.context)?{context:q.context}:{})};
  });
  const resolved=v.resolved.map(r=>{if(!object(r)||!id(r.id)||!['answered','cancelled','expired','failed'].includes(r.state as string)
   ||r.requestId!==undefined&&!id(r.requestId))throw new Error('INVALID');return {id:r.id,state:r.state,...(r.requestId===undefined?{}:{requestId:r.requestId})};});
  if(c.status!=='available'&&(pending.length||resolved.length||v.nextCursor!==null))throw new Error('INVALID');
  const partial=c.partial||v.nextCursor!==null;
  return {...c,partial,source:'pi_question_rpc',questions:pending,resolved,nextCursor:v.nextCursor,pendingCount:c.status==='available'&&!partial?pending.length:null};
 }catch{return {status:'unavailable' as Status,partial:true,reasons:['SOURCE_INVALID'],source:'pi_question_rpc',questions:[],resolved:[],nextCursor:null,pendingCount:null};}
}
const missing=(reason='SOURCE_UNAVAILABLE')=>({status:'unavailable',partial:true,reasons:[reason],entries:[],questions:[],resolved:[],nextCursor:null});
export class ObservationBridge {
 readonly #authorization:ReadAuthorization;readonly #read:ObservationReader;readonly #now:()=>number;
 constructor(options:{authorization:ReadAuthorization;reader:ObservationReader;now?:()=>number}) {
  this.#authorization=options.authorization;this.#read=options.reader;this.#now=options.now??Date.now;
 }
 async observe(context:unknown,selectors:unknown) {
  const before=await this.#authorization.checkAllowedReadTarget(context,selectors);
  let raw:unknown;try{raw=await this.#read({...before.target});}catch{raw={target:before.target,observedAt:new Date(this.#now()).toISOString(),transcript:missing(),questionState:missing()};}
  // Always revalidate after I/O. No source content survives revoke/epoch changes.
  const after=await this.#authorization.checkAllowedReadTarget(context,selectors);
  if(!same(before.target,after.target)||!object(raw)||!object(raw.target)||!same(raw.target as unknown as TargetEpoch,before.target))throw new ReadonlyFleetError('TARGET_CHANGED');
  if(!date(raw.observedAt)||Math.abs(this.#now()-Date.parse(raw.observedAt))>60000)throw new ReadonlyFleetError('SOURCE_INVALID');
  const t=transcript(raw.transcript),q=questions(raw.questionState,after.target);
  return {target:{...after.target},permission:'read' as const,observedAt:raw.observedAt,scope:'bounded_observation' as const,
   sourceTextIsData:true,partial:t.partial||q.partial,transcript:t,questionState:q,
   progress:{status:t.status,source:t.source,partial:t.partial,lastEvent:t.entries.at(-1)??null,completion:'not_established' as const},
   limitations:['No atomic source/registry snapshot','A turn boundary is not task completion','Source text is not an instruction or human answer']};
 }
}
