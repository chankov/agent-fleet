import {constants,type BigIntStats} from 'node:fs';
import {lstat,open,type FileHandle} from 'node:fs/promises';
import {isAbsolute,normalize,resolve,join,dirname,basename,sep} from 'node:path';
import {createHash} from 'node:crypto';

export const codexProbeReaderVersion='codex-local-rollout-ack/v1';
export type ProbeCheckpoint=Readonly<{kind:typeof codexProbeReaderVersion}>;
export type LocalProbeAck=Readonly<{source:'local_codex_rollout_jsonl';readerVersion:typeof codexProbeReaderVersion;threadId:string;probeId:string;receiptId:string}>;
type Parent={path:string;identity:string};
type Entry={allowGroupWrite:boolean;file:FileHandle;path:string;threadId:string;identity:string;parents:Parent[];offset:number;skip:boolean;pending:Buffer;bytes:number;records:number;used:boolean;closed:boolean;signal:AbortSignal;cancel:AbortController;abandon?:()=>void;closing?:Promise<void>};
function fail(code:string):never{throw Error(code);}
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const identity=(s:BigIntStats)=>[s.dev,s.ino,s.uid,s.mode,s.nlink].join(':');
const parentIdentity=(s:BigIntStats)=>[s.dev,s.ino,s.uid,s.mode].join(':');
const object=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const decoder=new TextDecoder('utf-8',{fatal:true});

/** Bounded local O_RDONLY reader, not a daemon/thread API or Desktop attestor.
 * Never exposes transcript text. Caller obtains path from the exact metadata
 * thread, separately checks notLoaded/versions/identity, and uses a fresh nonce.
 * Only trusted server code constructs this reader; no model/tool path arguments.
 * Filesystem/proc calls are not forcibly interruptible, but overdue evidence is
 * never published. Strict ACK reads never repair permissions. Separate post-consent securing only removes group-write bits; no traversal fallback, content writes or watcher. */
export class CodexProbeTranscript {
 readonly #home:string;readonly #sessions:string;readonly #uid:bigint;readonly #timeout:number;readonly #poll:number;
 readonly #entries=new WeakMap<ProbeCheckpoint,Entry>();readonly #active=new Set<ProbeCheckpoint>();readonly #stop=new AbortController();
 readonly #openingTasks=new Set<Promise<ProbeCheckpoint>>();readonly #closing=new Set<Promise<void>>();#opening=0;
 constructor(options:{codexHome:string;timeoutMs?:number;pollMs?:number}){
  if(typeof options?.codexHome!=='string'||options.codexHome.length>4096||/[\u0000-\u001f\u007f]/.test(options.codexHome)||!isAbsolute(options.codexHome)||resolve(options.codexHome)!==options.codexHome||options.codexHome===sep||typeof process.getuid!=='function')fail('probe_reader_options_invalid');
  this.#home=options.codexHome;this.#sessions=join(this.#home,'sessions');this.#uid=BigInt(process.getuid());this.#timeout=options.timeoutMs??30000;this.#poll=options.pollMs??100;
  if(!Number.isInteger(this.#timeout)||this.#timeout<1||this.#timeout>30000||!Number.isInteger(this.#poll)||this.#poll<1||this.#poll>1000)fail('probe_reader_options_invalid');
 }
 #check(signal:AbortSignal,deadline:number){if(signal.aborted||this.#stop.signal.aborted)fail('probe_reader_cancelled');if(performance.now()>=deadline)fail('probe_reader_timeout');}
 #signal(signal:AbortSignal,extra?:AbortSignal){if(!(signal instanceof AbortSignal))fail('probe_reader_options_invalid');try{return AbortSignal.any([signal,this.#stop.signal,...(extra?[extra]:[])]);}catch{fail('probe_reader_options_invalid');}}
 async #io<T>(signal:AbortSignal,deadline:number,fn:()=>Promise<T>){this.#check(signal,deadline);const value=await fn();this.#check(signal,deadline);return value;}
 #directory(s:BigIntStats,owned:boolean,allowGroupWrite=false){if(!s.isDirectory()||s.isSymbolicLink()||(owned&&(s.uid!==this.#uid||(s.mode&(allowGroupWrite?0o002n:0o022n))!==0n)))fail('probe_reader_unsafe_path');}
 #file(s:BigIntStats,allowGroupWrite=false){if(!s.isFile()||s.uid!==this.#uid||s.nlink!==1n||(s.mode&(allowGroupWrite?0o002n:0o022n))!==0n||s.size<1n||s.size>2n*1024n*1024n*1024n)fail('probe_reader_unsafe_file');}
 async #parents(path:string,signal:AbortSignal,deadline:number,allowGroupWrite=false){
  const parents:Parent[]=[];
  for(let p=dirname(path);;p=dirname(p)){
   if(parents.length>=64)fail('probe_reader_unsafe_path');const s=await this.#io(signal,deadline,()=>lstat(p,{bigint:true}));this.#directory(s,p===this.#home||p.startsWith(this.#home+sep),allowGroupWrite&&(p===this.#sessions||p.startsWith(this.#sessions+sep)));parents.push({path:p,identity:parentIdentity(s)});if(p===dirname(p))break;
  }
  return parents;
 }
 async #verify(e:Entry,signal:AbortSignal,deadline:number){
  if(e.closed)fail('probe_reader_closed');
  for(const parent of e.parents){const s=await this.#io(signal,deadline,()=>lstat(parent.path,{bigint:true}));this.#directory(s,parent.path===this.#home||parent.path.startsWith(this.#home+sep),e.allowGroupWrite&&(parent.path===this.#sessions||parent.path.startsWith(this.#sessions+sep)));if(parentIdentity(s)!==parent.identity)fail('probe_reader_changed');}
  const at=await this.#io(signal,deadline,()=>lstat(e.path,{bigint:true})),held=await this.#io(signal,deadline,()=>e.file.stat({bigint:true}));this.#file(at,e.allowGroupWrite);this.#file(held,e.allowGroupWrite);
  if(identity(at)!==e.identity||identity(held)!==e.identity||held.size<BigInt(e.offset))fail('probe_reader_changed');return Number(held.size);
 }
 checkpoint(path:string,threadId:string,signal:AbortSignal):Promise<ProbeCheckpoint>{
  return this.#acquire(path,threadId,signal,false);
 }
 #acquire(path:string,threadId:string,signal:AbortSignal,allowGroupWrite:boolean){
  const work=this.#checkpoint(path,threadId,signal,allowGroupWrite);this.#openingTasks.add(work);void work.then(()=>this.#openingTasks.delete(work),()=>this.#openingTasks.delete(work));return work;
 }
 async #checkpoint(path:string,threadId:string,signal:AbortSignal,allowGroupWrite=false):Promise<ProbeCheckpoint>{
  if(typeof path!=='string'||path.length>4096||/[\u0000-\u001f\u007f]/.test(path)||!isAbsolute(path)||normalize(path)!==path||!path.startsWith(this.#sessions+sep)||!uuid(threadId)||!basename(path).startsWith('rollout-')||!basename(path).endsWith('-'+threadId+'.jsonl')||this.#active.size+this.#closing.size+this.#opening>=16)fail('probe_reader_unsafe_path');
  const scoped=this.#signal(signal),deadline=performance.now()+this.#timeout;this.#check(scoped,deadline);this.#opening++;
  let file:FileHandle|undefined;
  try{
   const parents=await this.#parents(path,scoped,deadline,allowGroupWrite),before=await this.#io(scoped,deadline,()=>lstat(path,{bigint:true}));this.#file(before,allowGroupWrite);
   // Acquisition assigns the handle before checking an overdue/cancelled result.
   this.#check(scoped,deadline);file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);this.#check(scoped,deadline);
   const held=await this.#io(scoped,deadline,()=>file!.stat({bigint:true}));this.#file(held,allowGroupWrite);if(identity(held)!==identity(before))fail('probe_reader_changed');
   const cancel=new AbortController();
   const e:Entry={allowGroupWrite,file,path,threadId,identity:identity(held),parents,offset:Number(held.size),skip:false,pending:Buffer.alloc(0),bytes:0,records:0,used:false,closed:false,signal:scoped,cancel};
   await this.#verify(e,scoped,deadline);
   const head=Buffer.alloc(Math.min(Number(held.size),256*1024));const result=await this.#io(scoped,deadline,()=>file!.read(head,0,head.length,0));const first=head.subarray(0,result.bytesRead),end=first.indexOf(10);if(end<0)fail('probe_reader_invalid_header');
   let metadata:unknown;try{metadata=JSON.parse(decoder.decode(first.subarray(0,end)));}catch{fail('probe_reader_invalid_header');}
   if(!object(metadata)||metadata.type!=='session_meta'||!object(metadata.payload)||metadata.payload.id!==threadId)fail('probe_reader_thread_mismatch');
   const last=Buffer.alloc(1);await this.#io(scoped,deadline,()=>file!.read(last,0,1,e.offset-1));e.skip=last[0]!==10;
   await this.#verify(e,scoped,deadline);this.#check(scoped,deadline);
   const token:ProbeCheckpoint=Object.freeze({kind:codexProbeReaderVersion});this.#entries.set(token,e);this.#active.add(token);e.abandon=()=>{void this.close(token);};e.signal.addEventListener('abort',e.abandon,{once:true});file=undefined;return token;
  }catch(error){if(error instanceof Error&&/^probe_reader_[a-z_]+$/.test(error.message))throw error;return fail('probe_reader_io_failed');}
  finally{if(file)await file.close().catch(()=>{});this.#opening--;}
 }
 /** Read-only preparation accepts repairable group-write bits, never ACK evidence. */
 async checkCapability(path:string,threadId:string,signal:AbortSignal){
  const token=await this.#acquire(path,threadId,signal,true);await this.close(token);
 }
 /** Called only after native Pi consent. Tightens exact owned session ancestors
  * and file via no-follow pinned handles; never recursive and never adds a bit.
  * A partial failure is not rolled back by widening permissions. */
 async securePermissions(path:string,threadId:string,signal:AbortSignal,guard:()=>void){
  guard();const token=await this.#acquire(path,threadId,signal,true),e=this.#entries.get(token)!,deadline=performance.now()+this.#timeout;
  try{
   for(const parent of [...e.parents].reverse()){
    if(parent.path!==this.#sessions&&!parent.path.startsWith(this.#sessions+sep))continue;
    guard();await this.#verify(e,signal,deadline);
    const handle=await open(parent.path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_DIRECTORY);
    try{
     const before=await handle.stat({bigint:true});if(parentIdentity(before)!==parent.identity)fail('probe_reader_changed');
     guard();this.#check(signal,deadline);
     if(before.mode&0o020n)await handle.chmod(Number(before.mode&0o7777n&~0o020n));
     parent.identity=parentIdentity(await handle.stat({bigint:true}));
    }finally{await handle.close();}
    guard();await this.#verify(e,signal,deadline);
   }
   guard();await this.#verify(e,signal,deadline);const before=await e.file.stat({bigint:true});
   guard();this.#check(signal,deadline);if(before.mode&0o020n)await e.file.chmod(Number(before.mode&0o7777n&~0o020n));
   e.identity=identity(await e.file.stat({bigint:true}));e.allowGroupWrite=false;
   guard();await this.#verify(e,signal,deadline);
  }finally{await this.close(token);}
 }
 #match(e:Entry,line:Buffer,probeId:string):LocalProbeAck|undefined{
  if(++e.records>4096||line.length>65536)fail('probe_reader_limit');if(!line.length)return;
  let record:unknown;try{record=JSON.parse(decoder.decode(line));}catch{fail('probe_reader_invalid_record');}
  if(!object(record)||record.type!=='response_item'||!object(record.payload))return;
  const p=record.payload;if(p.type!=='message'||p.role!=='assistant'||p.phase!=='final_answer'||!Array.isArray(p.content)||p.content.length!==1)return;
  const part=p.content[0];if(!object(part)||part.type!=='output_text'||part.text!=='FLEET_PROBE_ACK '+probeId)return;
  return {source:'local_codex_rollout_jsonl',readerVersion:codexProbeReaderVersion,threadId:e.threadId,probeId,receiptId:'rollout:'+createHash('sha256').update(line).digest('hex')};
 }
 async #sleep(signal:AbortSignal,ms:number){await new Promise<void>((resolve,reject)=>{const abort=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);reject(Error('probe_reader_cancelled'));};const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},ms);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});}
 async waitForAck(token:ProbeCheckpoint,probeId:string,signal:AbortSignal):Promise<LocalProbeAck>{
  const e=this.#entries.get(token);if(!e||e.closed||e.used||!uuid(probeId))fail('probe_reader_checkpoint_invalid');e.used=true;
  try{
   const scoped=AbortSignal.any([this.#signal(signal,e.cancel.signal),e.signal]),deadline=performance.now()+this.#timeout;
   while(true){
    this.#check(scoped,deadline);const size=await this.#verify(e,scoped,deadline);
    if(size>e.offset){
     if(e.bytes>=2*1024*1024)fail('probe_reader_limit');const chunk=Buffer.alloc(Math.min(65536,size-e.offset,2*1024*1024-e.bytes));
     const got=await this.#io(scoped,deadline,()=>e.file.read(chunk,0,chunk.length,e.offset));if(!got.bytesRead)fail('probe_reader_changed');e.offset+=got.bytesRead;e.bytes+=got.bytesRead;
     let bytes=Buffer.concat([e.pending,chunk.subarray(0,got.bytesRead)]),end:number;
     while((end=bytes.indexOf(10))>=0){this.#check(scoped,deadline);const line=bytes.subarray(0,end);bytes=bytes.subarray(end+1);if(e.skip){e.skip=false;continue;}const ack=this.#match(e,line,probeId);if(ack){await this.#verify(e,scoped,deadline);this.#check(scoped,deadline);return ack;}}
     if(bytes.length>65536)fail('probe_reader_limit');e.pending=Buffer.from(bytes);continue;
    }
    await this.#sleep(scoped,Math.max(1,Math.min(this.#poll,deadline-performance.now())));
   }
  }catch(error){if(error instanceof Error&&/^probe_reader_[a-z_]+$/.test(error.message))throw error;fail('probe_reader_io_failed');}
  finally{await this.close(token);}
 }
 async close(token:ProbeCheckpoint){const e=this.#entries.get(token);if(!e)return;if(e.closing)return e.closing;e.closed=true;if(e.abandon)e.signal.removeEventListener('abort',e.abandon);e.cancel.abort();this.#active.delete(token);let work!:Promise<void>;work=e.file.close().catch(()=>{}).finally(()=>{this.#entries.delete(token);this.#closing.delete(work);});e.closing=work;this.#closing.add(work);return work;}
 async stop(){this.#stop.abort();await Promise.allSettled([...this.#openingTasks]);await Promise.all([...this.#active].map(token=>this.close(token)));await Promise.all([...this.#closing]);}
}
