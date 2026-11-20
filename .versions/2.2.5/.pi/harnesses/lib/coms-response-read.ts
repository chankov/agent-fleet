// Cooperative same-user read RPC. References/cursors are routing data, never authority.
import {createHash} from 'node:crypto';
import {redactSecrets} from './fleet-transcript-store.ts';
import {sameOwner,validOwner,validWire,type InstructionOwner} from './coms-instruction-receipts.ts';
export const RESPONSE_MAX_BYTES=1024*1024, RESPONSE_PAGE_BYTES=2048, RESPONSE_FRAME_BYTES=16384;
export const RESPONSE_PROJECTION='public-final-v1';
export const responseCodes=['NOT_READY','SOURCE_UNAVAILABLE','SOURCE_CHANGED','TARGET_CHANGED','INVALID_ARGUMENTS','INVALID_CURSOR','RESPONSE_TOO_LARGE','RESPONSE_CAPACITY','RPC_INVALID','RPC_UNAVAILABLE','RPC_UNSUPPORTED','UNSAFE_PATH','REQUEST_CANCELLED'] as const;
export class ResponseReadError extends Error {readonly code:string;constructor(code:string){super(code);this.code=code;}}
function fail(code:string):never{throw new ResponseReadError(code);}
export const responseHash=(text:string|Buffer)=>createHash('sha256').update(text).digest('hex');
const object=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const exact=(v:unknown,fields:string[])=>object(v)&&Object.keys(v).length===fields.length&&fields.every(k=>Object.hasOwn(v,k));
export const validReference=(v:unknown):v is string=>typeof v==='string'&&/^fleet:message\/response-v1-[a-f0-9]{64}$/.test(v);
export function responseReference(owner:InstructionOwner,wireId:string){
 if(!validOwner(owner)||!validWire(wireId))fail('INVALID_ARGUMENTS');
 return 'fleet:message/response-v1-'+responseHash(JSON.stringify([owner.project,owner.peer,owner.sessionId,owner.startedAt,wireId]));
}
export type ResponsePage={version:1;target:InstructionOwner;reference:string;projectionVersion:string;text:string;offsetBytes:number;nextOffsetBytes:number;totalBytes:number;sourceSha256:string;chunkSha256:string;nextCursor:string|null;eof:boolean;redacted:boolean;sourceState:{state:'result'|'failed';stopReason:string};sourceTextIsData:true};
type Cursor={version:1;target:InstructionOwner;reference:string;scope:string;projectionVersion:string;sourceSha256:string;offset:number};
export function decodeResponseCursor(value:unknown):Cursor{
 try{
  if(typeof value!=='string'||value.length>2048||!value.length||!/^[A-Za-z0-9_-]+$/.test(value))fail('INVALID_CURSOR');
  const bytes=Buffer.from(value,'base64url');if(bytes.toString('base64url')!==value)fail('INVALID_CURSOR');
  const c=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  if(!exact(c,['version','target','reference','scope','projectionVersion','sourceSha256','offset'])||c.version!==1||!validOwner(c.target)||!validReference(c.reference)||!validWire(c.scope)||c.projectionVersion!==RESPONSE_PROJECTION||!validWire(c.sourceSha256)||!Number.isSafeInteger(c.offset)||c.offset<=0||c.offset>RESPONSE_MAX_BYTES)fail('INVALID_CURSOR');
  return c;
 }catch{ return fail('INVALID_CURSOR'); }
}
function project(entry:unknown){
 if(!object(entry)||entry.type!=='message'||!object(entry.message)||entry.message.role!=='assistant')fail('SOURCE_UNAVAILABLE');
 const m=entry.message;
 if(!['stop','end_turn','error','aborted','max_tokens','refusal'].includes(m.stopReason))fail('SOURCE_UNAVAILABLE');
 const blocks=typeof m.content==='string'?[{type:'text',text:m.content}]:m.content;
 if(!Array.isArray(blocks)||blocks.length>4096)fail('RESPONSE_TOO_LARGE');
 const text:string[]=[];let count=0;
 for(const b of blocks){if(!object(b)||b.type!=='text')continue;if(typeof b.text!=='string')fail('SOURCE_UNAVAILABLE');count+=Buffer.byteLength(b.text)+(text.length?1:0);if(count>RESPONSE_MAX_BYTES)fail('RESPONSE_TOO_LARGE');text.push(b.text);}
 const raw=text.join('\n');if(Buffer.from(raw).toString('utf8')!==raw)fail('SOURCE_UNAVAILABLE');
 // Include newlines and unterminated quoted credentials before the common scrubber.
 const quoted=raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'').replace(/(["']?)(\b[A-Z0-9_]*(?:api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|pwd|token|secret))\1(\s*[:=]\s*)(["'])([\s\S]*?)(?:\4|$)/gi,(_m,q,key,sep,valueQuote)=>`${q}${key}${q}${sep}${valueQuote}[REDACTED]${valueQuote}`);
 const safe=redactSecrets(quoted).replace(/-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*/gi,'[REDACTED]').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'');
 if(Buffer.byteLength(safe)>RESPONSE_MAX_BYTES)fail('RESPONSE_TOO_LARGE');
 return {safe,redacted:safe!==raw,sourceSha256:responseHash(safe),sourceEntryDigest:responseHash(JSON.stringify([text,m.stopReason])),sourceState:{state:['stop','end_turn'].includes(m.stopReason)?'result' as const:'failed' as const,stopReason:m.stopReason as string}};
}
export type ResponseManager={getLeafId?:()=>string|null;getEntry?:(id:string)=>unknown};
type Pointer={version:1;owner:InstructionOwner;wireId:string;sourceEntryId:string;sourceSha256:string;sourceEntryDigest:string;projectionVersion:string};
type Slot={owner:InstructionOwner;wireId:string;pointerId?:string;code?:string};
export class SessionResponseReader{
 readonly #entries=new Map<string,Slot>();readonly #capacity:number;
 constructor(capacity=4096){this.#capacity=capacity;}
 clear(){this.#entries.clear();}
 begin(owner:InstructionOwner,wireId:string){const ref=responseReference(owner,wireId);if(!this.#entries.has(ref)){if(this.#entries.size>=this.#capacity)return false;this.#entries.set(ref,{owner:{...owner},wireId,code:'NOT_READY'});}return true;}
 capture(owner:InstructionOwner,wireId:string,sourceEntryId:string|undefined,manager:ResponseManager|undefined,append:(kind:string,data:unknown)=>void){
  const ref=responseReference(owner,wireId);if(!this.begin(owner,wireId))return {reference:ref,code:'RESPONSE_CAPACITY'};
  const slot=this.#entries.get(ref)!;if(slot.pointerId||slot.code!=='NOT_READY')return {reference:ref,code:slot.code};
  try{
   if(!sourceEntryId||!manager?.getEntry||!manager.getLeafId)fail('SOURCE_UNAVAILABLE');
   const source=manager.getEntry(sourceEntryId);if(!object(source)||source.id!==sourceEntryId)fail('SOURCE_UNAVAILABLE');const p=project(source);
   const pointer:Pointer={version:1,owner:{...owner},wireId,sourceEntryId,sourceSha256:p.sourceSha256,sourceEntryDigest:p.sourceEntryDigest,projectionVersion:RESPONSE_PROJECTION};
   const before=manager.getLeafId();append('coms-response-pointer',pointer);const id=manager.getLeafId();
   if(!id||id===before)fail('SOURCE_UNAVAILABLE');const recorded=manager.getEntry(id);
   if(!object(recorded)||recorded.type!=='custom'||recorded.customType!=='coms-response-pointer'||JSON.stringify(recorded.data)!==JSON.stringify(pointer))fail('SOURCE_UNAVAILABLE');
   slot.pointerId=id;delete slot.code;return {reference:ref,sourceSha256:p.sourceSha256};
  }catch(e){slot.code=e instanceof ResponseReadError?e.code:'SOURCE_UNAVAILABLE';return {reference:ref,code:slot.code};}
 }
 read(owner:InstructionOwner,reference:string,scope:string,cursor:unknown,manager:ResponseManager|undefined):ResponsePage{
  if(!validOwner(owner)||!validReference(reference)||!validWire(scope))fail('INVALID_ARGUMENTS');
  const c=cursor===undefined?undefined:decodeResponseCursor(cursor);
  if(c&&(!sameOwner(c.target,owner)||c.reference!==reference||c.scope!==scope))fail('INVALID_CURSOR');
  const slot=this.#entries.get(reference);if(!slot)fail('SOURCE_UNAVAILABLE');if(!sameOwner(slot.owner,owner))fail('TARGET_CHANGED');if(slot.code)fail(slot.code);
  if(!slot.pointerId||!manager?.getEntry)fail('SOURCE_UNAVAILABLE');
  const marker=manager.getEntry(slot.pointerId);
  if(!object(marker)||marker.id!==slot.pointerId||marker.type!=='custom'||marker.customType!=='coms-response-pointer')fail('SOURCE_UNAVAILABLE');
  const p=marker.data;
  if(!exact(p,['version','owner','wireId','sourceEntryId','sourceSha256','sourceEntryDigest','projectionVersion'])||p.version!==1||!validOwner(p.owner)||!sameOwner(p.owner,owner)||p.wireId!==slot.wireId||responseReference(owner,p.wireId)!==reference||typeof p.sourceEntryId!=='string'||!validWire(p.sourceSha256)||!validWire(p.sourceEntryDigest)||p.projectionVersion!==RESPONSE_PROJECTION)fail('SOURCE_CHANGED');
  const source=manager.getEntry(p.sourceEntryId);if(!object(source)||source.id!==p.sourceEntryId)fail('SOURCE_UNAVAILABLE');
  const projected=project(source);if(projected.sourceEntryDigest!==p.sourceEntryDigest||projected.sourceSha256!==p.sourceSha256||c&&c.sourceSha256!==projected.sourceSha256)fail('SOURCE_CHANGED');
  const bytes=Buffer.from(projected.safe),offset=c?.offset??0;
  if(offset>bytes.length||offset===bytes.length&&offset!==0||offset>0&&(bytes[offset]&0xc0)===0x80)fail('INVALID_CURSOR');
  let end=Math.min(offset+RESPONSE_PAGE_BYTES,bytes.length);while(end<bytes.length&&(bytes[end]&0xc0)===0x80)end--;
  const text=bytes.subarray(offset,end).toString('utf8'),eof=end===bytes.length;
  const nextCursor=eof?null:Buffer.from(JSON.stringify({version:1,target:owner,reference,scope,projectionVersion:RESPONSE_PROJECTION,sourceSha256:projected.sourceSha256,offset:end} satisfies Cursor)).toString('base64url');
  const result:ResponsePage={version:1,target:{...owner},reference,projectionVersion:RESPONSE_PROJECTION,text,offsetBytes:offset,nextOffsetBytes:end,totalBytes:bytes.length,sourceSha256:projected.sourceSha256,chunkSha256:responseHash(text),nextCursor,eof,redacted:projected.redacted,sourceState:projected.sourceState,sourceTextIsData:true};
  if(Buffer.byteLength(JSON.stringify(result))>RESPONSE_FRAME_BYTES-1024)fail('RESPONSE_TOO_LARGE');return result;
 }
 handle(socket:{write:(s:string)=>unknown},envelope:unknown,getOwner:()=>InstructionOwner|null,manager:ResponseManager|undefined){
  if(!object(envelope)||envelope.type!=='response_read_request')return false;
  let page:ResponsePage|undefined,code:string|undefined;const owner=getOwner();
  try{
   const fields=['type','version','msg_id','sender_session','sender_endpoint','owner','reference','scope',...(envelope.cursor===undefined?[]:['cursor'])];
   if(!exact(envelope,fields)||envelope.version!==1||typeof envelope.msg_id!=='string'||!/^[A-Za-z0-9_-]{1,96}$/.test(envelope.msg_id)||!validOwner(envelope.owner)||typeof envelope.sender_session!=='string'||envelope.sender_session.length>96||envelope.sender_endpoint!=='')fail('INVALID_ARGUMENTS');
   if(!owner||!sameOwner(owner,envelope.owner))fail('TARGET_CHANGED');page=this.read(owner,envelope.reference,envelope.scope,envelope.cursor,manager);
  }catch(e){code=e instanceof ResponseReadError?e.code:'SOURCE_UNAVAILABLE';}
  const after=getOwner();if(!owner||!after||!sameOwner(owner,after)){code='TARGET_CHANGED';page=undefined;}
  socket.write(JSON.stringify({type:'response_read_response',version:1,msg_id:typeof envelope.msg_id==='string'?envelope.msg_id.slice(0,96):'',owner:after,...(code?{status:'error',code}:{status:'available',page})})+'\n');return true;
 }
}
export function validateResponsePage(v:unknown,target:InstructionOwner,reference:string,scope:string,cursor?:string):ResponsePage{
 try{
  if(!exact(v,['version','target','reference','projectionVersion','text','offsetBytes','nextOffsetBytes','totalBytes','sourceSha256','chunkSha256','nextCursor','eof','redacted','sourceState','sourceTextIsData'])||!object(v)||v.version!==1||!validOwner(v.target)||!sameOwner(v.target,target)||v.reference!==reference||v.projectionVersion!==RESPONSE_PROJECTION||v.sourceTextIsData!==true||typeof v.text!=='string'||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v.text)||Buffer.byteLength(v.text)>RESPONSE_PAGE_BYTES||Buffer.from(v.text).toString()!==v.text||!validWire(v.sourceSha256)||v.chunkSha256!==responseHash(v.text)||typeof v.redacted!=='boolean'||typeof v.eof!=='boolean'||!exact(v.sourceState,['state','stopReason'])||!['result','failed'].includes(v.sourceState.state)||!['stop','end_turn','error','aborted','max_tokens','refusal'].includes(v.sourceState.stopReason)||v.sourceState.state!==(['stop','end_turn'].includes(v.sourceState.stopReason)?'result':'failed'))fail('RPC_INVALID');
  const start=cursor?decodeResponseCursor(cursor):undefined;
  if(start&&(!sameOwner(start.target,target)||start.reference!==reference||start.scope!==scope||start.sourceSha256!==v.sourceSha256))fail('RPC_INVALID');
  if(![v.offsetBytes,v.nextOffsetBytes,v.totalBytes].every(x=>Number.isSafeInteger(x)&&x>=0&&x<=RESPONSE_MAX_BYTES)||v.offsetBytes!==(start?.offset??0)||v.nextOffsetBytes!==v.offsetBytes+Buffer.byteLength(v.text)||v.nextOffsetBytes>v.totalBytes||v.eof!==(v.nextOffsetBytes===v.totalBytes)||!v.eof&&v.nextOffsetBytes<=v.offsetBytes)fail('RPC_INVALID');
  if(v.eof){if(v.nextCursor!==null)fail('RPC_INVALID');if(v.offsetBytes===0&&responseHash(v.text)!==v.sourceSha256)fail('RPC_INVALID');}
  else{const next=decodeResponseCursor(v.nextCursor);if(!sameOwner(next.target,target)||next.reference!==reference||next.scope!==scope||next.sourceSha256!==v.sourceSha256||next.offset!==v.nextOffsetBytes)fail('RPC_INVALID');}
  if(Buffer.byteLength(JSON.stringify(v))>RESPONSE_FRAME_BYTES-1024)fail('RPC_INVALID');return v as ResponsePage;
 }catch{return fail('RPC_INVALID');}
}
