import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeEndpoint, makePromptEnvelope, readOneLine, ulid, writeAck, type RegistryEntry } from './coms-envelope.ts';
import { herdr } from '../../../../.pi/harnesses/lib/herdr-client.ts';
import type { Availability } from './fleet-codex-catalog.ts';
import type { JsonRecord, Receipt, SourceReport } from './fleet-codex-operations.ts';

export function readSources(entry:RegistryEntry, project:string, cursor:JsonRecord, waitMs=0, pending:string[]=[]):Promise<SourceReport> {
 return new Promise((resolve,reject)=>{
  const helper=fileURLToPath(new URL('../fleet-codex-read.py',import.meta.url));
  const child=execFile('python3',[helper],{timeout:30000+waitMs,maxBuffer:1024*1024,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}},(error,stdout)=>{
   if(error){reject(Error('source reader unavailable; Python 3 and existing herdr/monitor access required'));return;}
   try {const r=JSON.parse(stdout);if(r.error||!r.cursor||typeof r.cursor!=='object'||!r.pane||!r.activity||!r.monitor)throw Error();resolve(r as SourceReport);}catch{reject(Error('invalid source response'));}
  });
  child.stdin!.end(JSON.stringify({entry,project,cursor,waitMs,pending}));
 });
}

/** One bounded coms frame; never retries a write. */
export async function exchange(endpoint:string, envelope:object, timeoutMs=2000):Promise<JsonRecord> {
 const socket=net.createConnection({path:endpoint});
 const timer=setTimeout(()=>socket.destroy(Error('coms timeout')),timeoutMs);
 try {
  const response=readOneLine(socket);
  socket.once('connect',()=>socket.write(JSON.stringify(envelope)+'\n'));
  return JSON.parse(await response);
 } finally {clearTimeout(timer);socket.destroy();}
}

export interface QuestionRequest { operation:'list'|'answer'|'cancel'; msg_id:string; questionId?:string; answer?:unknown; after?:string; }
export interface QuestionResponse {
 status:string; questions?:unknown[]; resolved?:{id:string;requestId?:string;state:string}[];
 nextCursor?:string|null; partial?:boolean; questionId?:string; reason?:string;
}
function assertPiEndpoint(entry:RegistryEntry) {
 if(!/^[A-Za-z0-9-]{1,64}$/.test(entry.session_id)||entry.endpoint!==makeEndpoint(entry.session_id))throw Error('unsupported noncanonical Pi endpoint');
 const info=fs.lstatSync(entry.endpoint);
 if(!info.isSocket()||info.isSymbolicLink()||(process.getuid&&info.uid!==process.getuid()))throw Error('unsafe Pi endpoint');
}

/** Addressed tool answers bypass the LLM prompt queue; the owning Pi validates the question. */
export async function requestQuestion(entry:RegistryEntry,project:string,request:QuestionRequest):Promise<QuestionResponse> {
 assertPiEndpoint(entry);
 const owner={project,peer:entry.name,sessionId:entry.session_id,startedAt:entry.started_at};
 const result=await exchange(entry.endpoint,{type:'question_request',version:1,sender_session:ulid(),sender_endpoint:'',owner,...request});
 if(result.type==='nack'&&result.msg_id===request.msg_id&&result.error==='unknown type')return {status:'unsupported',reason:'Pi runtime has no addressed question handler'};
 const actual=result.owner as typeof owner|undefined;
 if(result.type!=='question_response'||result.version!==1||result.msg_id!==request.msg_id||!actual||
   Object.keys(owner).some(k=>actual[k as keyof typeof owner]!==owner[k as keyof typeof owner])||
   !['available','accepted','invalid','conflict','late','expired','stale','unsupported','not_ready','unknown_question'].includes(String(result.status)))throw Error('invalid question response');
 if(request.operation==='list'&&result.status==='available') {
  const id=(value:unknown)=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(value);
  const text=(value:unknown)=>typeof value==='string'&&value.trim().length>0;
  if(!Array.isArray(result.questions)||!Array.isArray(result.resolved)||result.questions.length>64||result.resolved.length>64||
   (result.nextCursor!==undefined&&result.nextCursor!==null&&!id(result.nextCursor))||
   (result.partial!==undefined&&typeof result.partial!=='boolean')||
   result.questions.some(q=>!q||!id(q.id)||!text(q.toolCallId)||!text(q.question)||q.state!=='pending'||
    !q.owner||Object.keys(owner).some(k=>q.owner[k]!==owner[k as keyof typeof owner])||
    (q.context!==undefined&&typeof q.context!=='string')||!Array.isArray(q.options)||q.options.some((o:any)=>!o||!text(o.title)||(o.description!==undefined&&typeof o.description!=='string'))||
    ['allowMultiple','allowFreeform','allowComment'].some(k=>typeof q[k]!=='boolean')||!text(q.createdAt)||q.expiresAt!==null)||
   result.resolved.some(q=>!q||!id(q.id)||!['answered','cancelled','expired','failed'].includes(q.state)||(q.requestId!==undefined&&!id(q.requestId))))throw Error('invalid question list');
 }

 return result as unknown as QuestionResponse;
}

async function verifyInstructionTarget(entry:RegistryEntry,project:string,pane?:string) {
 assertPiEndpoint(entry);
 const agents=(await herdr.agentList({timeoutMs:2000})).agents;
 const matches=agents.filter(a=>a.agent==='pi' && (a.tokens as JsonRecord)?.coms===entry.name && (a.tokens as JsonRecord)?.proj===project);
 if(matches.length!==1||(pane!==undefined&&matches[0].pane_id!==pane))throw Error('no unique matching visible Pi pane');
 const foundPane=matches[0].pane_id;
 if(typeof foundPane!=='string'||!foundPane)throw Error('missing visible Pi pane identity');
 pane=foundPane;
 const pingId=ulid();
 const pong=await exchange(entry.endpoint,{type:'ping',msg_id:pingId,sender_session:ulid(),sender_endpoint:''});
 const card=pong.agent_card as {name?:string;pane_id?:string;status?:string}|undefined;
 if(pong.type!=='pong'||pong.msg_id!==pingId||card?.name!==entry.name||card?.pane_id!==pane)throw Error('target pane identity unavailable');
 return card!;
}

/** Read-only preflight shared with send; never tests support by sending a prompt. */
export async function probeInstruction(entry:RegistryEntry,project:string):Promise<Availability> {
 try {await verifyInstructionTarget(entry,project);return {status:'available',reason:'unique visible Pi pane and correlated coms ping verified; future instruction acceptance is not guaranteed'};}
 catch(error){return {status:'unavailable',reason:error instanceof Error?error.message:'instruction preflight failed'};}
}

export async function sendInstruction(entry:RegistryEntry,project:string,pane:string,commandId:string,text:string,waitMs:number,ack:(state:'submitted'|'queued')=>void):Promise<Pick<Receipt,'state'|'result'|'reason'>> {
 // Pi endpoints are session-specific. Never resolve a replacement by peer name after this point.
 const card=await verifyInstructionTarget(entry,project,pane);
 const sender={session_id:ulid(),name:'chatgpt-client',endpoint:'',cwd:process.cwd()};
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fcc-'));fs.chmodSync(dir,0o700);
 sender.endpoint=path.join(dir,'reply.sock');
 const envelope=makePromptEnvelope(sender,text,{reply_timeout_ms:waitMs});
 envelope.msg_id=commandId;
 // The wire message ID is independent from the human command ID and correlated exactly on reply.
 let resolveReply!:(r:Pick<Receipt,'state'|'result'|'reason'>)=>void;
 const reply=new Promise<Pick<Receipt,'state'|'result'|'reason'>>(resolve=>{resolveReply=resolve;});
 const sockets=new Set<net.Socket>();
 const server=net.createServer(socket=>{
  sockets.add(socket);socket.once('close',()=>sockets.delete(socket));socket.setTimeout(2000,()=>socket.destroy());
  void readOneLine(socket).then(line=>{
   const response=JSON.parse(line);
   if(response.type!=='response'||response.msg_id!==envelope.msg_id||response.sender_session!==entry.session_id)throw Error('unmatched response');
   writeAck(socket,response.msg_id);
   resolveReply(response.error?{state:'failed',reason:'Pi reported an error',result:response.error}:{state:'result',result:response.response,reason:'correlated Pi reply received'});
  }).catch(()=>socket.destroy());
 });
 let timer:NodeJS.Timeout|undefined;
 try {
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(sender.endpoint,resolve);});
  const accepted=await exchange(entry.endpoint,envelope);
  if(accepted.type==='nack' && accepted.msg_id===envelope.msg_id)return {state:'failed',reason:'Pi rejected the instruction'};
  if(accepted.type!=='ack'||accepted.msg_id!==envelope.msg_id)throw Error('unmatched ACK');
  const state=card.status==='working'?'queued':'submitted';ack(state);
  return await Promise.race([reply,new Promise<Pick<Receipt,'state'|'reason'>>(resolve=>{timer=setTimeout(()=>resolve({state,reason:'reply window ended; use resync for later public output, never resend this ID'}),waitMs);})]);
 } finally {
  if(timer)clearTimeout(timer);for(const socket of sockets)socket.destroy();server.close();fs.rmSync(dir,{recursive:true,force:true});
 }
}
