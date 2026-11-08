// An addressed, read-only RPC over the existing local coms socket. Never queues prompts.
import { redactSecrets } from './fleet-transcript-store.ts';
import { createHash } from 'node:crypto';
export type ObservationOwner={project:string;peer:string;sessionId:string;startedAt:string};
export type SessionHistory={getLeafId?:()=>unknown;getEntry?:(id:string)=>unknown};
type Provider={owner:()=>ObservationOwner|null;session:()=>SessionHistory|null|undefined;questions:()=>unknown;permissions?:()=>unknown;now?:()=>number};
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const same=(a:unknown,b:unknown)=>object(a)&&object(b)&&['project','peer','sessionId','startedAt'].every(k=>typeof a[k]==='string'&&a[k]===b[k]);
const id=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(v);
const gap=(reason:string,status='unavailable')=>({status,partial:true,reasons:[reason],entries:[]});
function project(session:SessionHistory|null|undefined,owner:ObservationOwner) {
 const token=(value:unknown)=>createHash('sha256').update(JSON.stringify([owner.project,owner.peer,owner.sessionId,owner.startedAt,value])).digest('hex');
 if(typeof session?.getLeafId!=='function'||typeof session.getEntry!=='function')return gap('SOURCE_NOT_CONFIGURED','unsupported');
 const rows:Array<{at:string;kind:string;text:string;id:string}>=[];const reasons=new Set<string>();const visited=new Set<string>();
 const initial=session.getLeafId();let cursor=initial,bytes=0,full=false;
 for(let count=0;cursor!==null&&count<256;count++) {
  if(!id(cursor)||visited.has(cursor))return gap('SOURCE_INVALID');visited.add(cursor);
  const e=session.getEntry(cursor);if(!object(e)||e.id!==cursor||e.parentId!==null&&!id(e.parentId))return gap('SOURCE_UNAVAILABLE');
  cursor=e.parentId;
  if(e.type!=='message'||!object(e.message)||e.message.role!=='assistant')continue;
  const at=typeof e.timestamp==='string'&&Number.isFinite(Date.parse(e.timestamp))?new Date(e.timestamp).toISOString():null;
  if(!at){reasons.add('SOURCE_INVALID');continue;}
  const content=e.message.content;if(!Array.isArray(content)){reasons.add('SOURCE_INVALID');continue;}
  const blockRows:Array<{at:string;kind:string;text:string;id:string}>=[];
  const add=(ordinal:number,kind:string,text:string)=>blockRows.push({at,kind,text,id:token(['event',e.id,ordinal,kind,text,at])});
  for(const [ordinal,block] of content.slice(0,128).entries()) {
   if(!object(block)){reasons.add('SOURCE_INVALID');continue;}
   // Thinking is deliberately outside the public projection, not missing public data.
   if(block.type==='thinking')continue;
   if(block.type==='text'&&typeof block.text==='string') {
    if(block.text.length>8000){reasons.add('SOURCE_LIMIT');continue;}
    const safe=redactSecrets(block.text);if(safe!==block.text)reasons.add('REDACTED');
    if(safe.length>2000)reasons.add('TRUNCATED');
    add(ordinal,'assistant',safe.slice(0,2000));
   }
   else if(block.type==='toolCall'&&typeof block.name==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(block.name))add(ordinal,'tool',block.name);
   else reasons.add('SOURCE_INVALID');
  }
  if(content.length>=128)reasons.add('ENTRY_LIMIT');
  if(['stop','error','aborted','end_turn','max_tokens','refusal'].includes(e.message.stopReason as string))add(content.length,'turn_end','turn boundary: '+e.message.stopReason);
  // Walk newest -> oldest, but preserve the order inside each assistant message.
  for(const r of blockRows.reverse()){
   if(rows.length>=50){reasons.add('ENTRY_LIMIT');break;}
   const size=Buffer.byteLength(JSON.stringify(r));if(bytes+size>49152){reasons.add('SOURCE_LIMIT');full=true;break;}
   bytes+=size;rows.push(r);
  }
  if(full)break;
  if(rows.length>=50){if(cursor!==null)reasons.add('ENTRY_LIMIT');break;}
 }
 if(cursor!==null)reasons.add('ENTRY_LIMIT');
 if(session.getLeafId()!==initial)return gap('SOURCE_UNAVAILABLE');
 return {status:'available',partial:reasons.size>0,reasons:[...reasons],entries:rows.reverse(),
  window:{leaf:initial===null?null:token(['entry',initial]),ancestry:[...visited].map(entry=>token(['entry',entry])),rootReached:cursor===null}};
}
export function handleObservationEnvelope(socket:{end(data:string):unknown},envelope:Record<string,unknown>,provider:Provider):boolean {
 if(envelope.type!=='observation_request')return false;
 const send=(status:string,body:Record<string,unknown>={})=>{
  const result={type:'observation_response',version:1,msg_id:id(envelope.msg_id)?envelope.msg_id:null,owner:provider.owner(),status,...body};
  const line=JSON.stringify(result)+'\n';socket.end(Buffer.byteLength(line)<=131072?line:JSON.stringify({type:'observation_response',version:1,msg_id:result.msg_id,status:'limited'})+'\n');
 };
 if(envelope.version!==1||!id(envelope.msg_id)||Object.keys(envelope).some(k=>!['type','version','msg_id','sender_session','sender_endpoint','operation','owner'].includes(k))){send('invalid');return true;}
 if(envelope.operation!=='snapshot'){send('unsupported');return true;}
 const owner=provider.owner();if(!same(owner,envelope.owner)){send('stale');return true;}
 try {
  let transcript:ReturnType<typeof project>;try{transcript=project(provider.session(),owner!);}catch{transcript=gap('SOURCE_UNAVAILABLE');}
  let q:unknown;try{q=provider.questions();}catch{q={status:'unavailable'};}
  const questionState=object(q)&&q.status==='available'?{...q,reasons:[]}:{status:object(q)&&q.status==='unsupported'?'unsupported':'unavailable',partial:true,reasons:[object(q)&&q.status==='unsupported'?'RPC_UNSUPPORTED':'SOURCE_UNAVAILABLE'],questions:[],resolved:[],nextCursor:null};
  let permissionState:unknown={status:'unsupported',partial:true,pendingCount:null,requests:[],resolved:[],nextCursor:null};
  try{if(provider.permissions)permissionState=provider.permissions();}catch{permissionState={status:'unavailable',partial:true,pendingCount:null,requests:[],resolved:[],nextCursor:null};}
  if(!same(owner,provider.owner())){send('stale');return true;}
  send('available',{observedAt:new Date((provider.now??Date.now)()).toISOString(),transcript,questionState,permissionState});
 }catch{send('unavailable');}
 return true;
}
