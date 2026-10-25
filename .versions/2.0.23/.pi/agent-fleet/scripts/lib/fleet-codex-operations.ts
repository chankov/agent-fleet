import { createHash } from 'node:crypto';
import { FleetSessionClient, type Binding } from './fleet-codex-session.ts';
import { readSources, sendInstruction, requestQuestion, probeInstruction, type QuestionRequest, type QuestionResponse } from './fleet-codex-transport.ts';
import { clientCatalog, type Availability, type Requirement } from './fleet-codex-catalog.ts';
import { ulid, type RegistryEntry } from './coms-envelope.ts';

export type JsonRecord = Record<string, unknown>;
export interface SourceReport {
 observedAt?:string; partial?:boolean; cursor:JsonRecord; questionState?:QuestionState;
 pane?:{paneId:string|null;state:string;reason?:string};
 activity?:{available?:boolean; current?:{detail?:string;kind?:string;at?:string}|null;steps?:unknown[];gap?:boolean};
 monitor?:{available?:boolean;tasks?:unknown[];gap?:boolean};
 binding?:Binding; receipts?:Receipt[]; replayed?:boolean; replies?:{wireId:string;state:'result'|'failed';result:string;truncated:boolean}[];
}
export interface Receipt {commandId:string; wireId?:string; target:string; digest:string; state:'unknown'|'submitted'|'queued'|'result'|'failed'; at:string; result?:unknown; reason?:string;}
interface QuestionReceipt {requestId:string;wireId:string;target:string;questionId:string;digest:string;status:string;at:string;}
interface QuestionState extends QuestionResponse { observedAt:string; questions:unknown[]; resolved:NonNullable<QuestionResponse['resolved']>; newQuestionIds:string[]; }
interface Journal {version:1; receipts:Receipt[]; questionReceipts?:QuestionReceipt[]; questionSeen?:{target:string;ids:string[]}; target?:string; cursor:JsonRecord; report?:SourceReport;}
interface Adapters {
 probe:(entry:RegistryEntry,project:string)=>Promise<Availability>;
 question:(entry:RegistryEntry,project:string,request:QuestionRequest)=>Promise<QuestionResponse>;
 read:(entry:RegistryEntry, project:string, cursor:JsonRecord, waitMs:number, pending?:string[] )=>Promise<SourceReport>;
 send:(entry:RegistryEntry,project:string,pane:string,id:string,text:string,waitMs:number,ack:(state:'submitted'|'queued')=>void)=>Promise<Pick<Receipt,'state'|'result'|'reason'>>;
}
const targetKey=(b:Binding)=>[b.project,b.peer,b.sessionId,b.startedAt].join('/');
function journal(raw:string|null):Journal {
 if (raw===null) return {version:1,receipts:[],cursor:{}};
 try {
  const j=JSON.parse(raw);
  if (j.version!==1 || !Array.isArray(j.receipts) || !j.cursor || typeof j.cursor!=='object' || j.receipts.some((r:Receipt)=>!r.commandId || !r.target || !r.digest || !['unknown','submitted','queued','result','failed'].includes(r.state))) throw Error();
  if(j.questionReceipts!==undefined && (!Array.isArray(j.questionReceipts)||j.questionReceipts.some((r:QuestionReceipt)=>!r.requestId||!r.wireId||!r.questionId||!r.digest||!r.target||typeof r.status!=='string')))throw Error();
  if(j.questionSeen!==undefined&&(!j.questionSeen||typeof j.questionSeen.target!=='string'||!Array.isArray(j.questionSeen.ids)||j.questionSeen.ids.length>256||j.questionSeen.ids.some((id:unknown)=>typeof id!=='string')))throw Error();
  return j;
 } catch {throw Error('invalid runtime journal; refusing to lose duplicate protection');}
}
export class FleetClientOperations {
 private client:FleetSessionClient; private adapters:Adapters;
 constructor(client:FleetSessionClient, adapters:Partial<Adapters>={}) {this.client=client;this.adapters={read:readSources,send:sendInstruction,question:requestQuestion,probe:probeInstruction,...adapters};}
 async describe() {
  const available=(reason:string):Availability=>({status:'available',reason});
  const unavailable=(reason:string):Availability=>({status:'unavailable',reason});
  let selection:ReturnType<FleetSessionClient['status']>|undefined;let selectionReason='selection unavailable';
  try {selection=this.client.status();selectionReason=`selection ${selection.status}`;}catch(error){selectionReason=error instanceof Error?error.message:selectionReason;}
  const binding=selection?.binding;
  const capabilities:Record<Requirement,Availability>={none:available('local operation; no selected target required'),
   identity:selection?available('conversation identity and selection storage readable'):unavailable(selectionReason),
   binding:binding?available('exact local binding readable'):unavailable(selectionReason),
   report:unavailable('no saved report for this binding'),sources:unavailable(selectionReason),instruction:unavailable(selectionReason),questions:unavailable(selectionReason)};
  const render=()=>{const catalog=clientCatalog();return {...catalog,observedAt:new Date().toISOString(),
   selection:selection??{status:'unavailable',reason:selectionReason},
   operations:catalog.operations.map(op=>({...op,availability:capabilities[op.requirements[0]]}))};};
  if(binding) {
   try {const j=journal(this.client.readRuntime().raw);if(j.target===targetKey(binding)&&j.report)capabilities.report=available('historical report for exact binding; no live freshness claim');}
   catch(error){const failure=unavailable(error instanceof Error?error.message:'journal unavailable');for(const key of ['binding','report','sources','instruction','questions'] as const)capabilities[key]=failure;if(selection?.status==='available')capabilities.identity=failure;}
  }
  if(selection?.status==='available'&&binding&&capabilities.binding.status==='available') {
   // The registry entry must be obtained under the same identity check, without a write lock or journal update.
   let entry:RegistryEntry;
   try {entry=this.client.selectedEntry();}
   catch {for(const key of ['sources','instruction','questions'] as const)capabilities[key]=unavailable('target changed during registry read');return render();}
   const [source,question,instruction]=await Promise.allSettled([
    this.adapters.read(entry,binding.project,{},0),
    this.adapters.question(entry,binding.project,{operation:'list',msg_id:ulid()}),
    this.adapters.probe(entry,binding.project),
   ]);
   const q=question.status==='fulfilled'?question.value:undefined;
   capabilities.questions=q?.status==='available'?available('addressed question list protocol verified; exact pending question and answer flags are checked on use'):
    {status:q?.status==='unsupported'?'unsupported':'unavailable',reason:q?.reason??(q?`question channel ${q.status}`:'question channel probe failed')};
   const r=source.status==='fulfilled'?source.value:undefined;
   const names=[r?.activity?.available?'activity':null,r?.monitor?.available?'monitor':null,q?.status==='available'?'questions':null].filter(Boolean);
   capabilities.sources=names.length?available(`readable sources: ${names.join(', ')}; coverage can be partial`):unavailable('activity, monitor and question sources unavailable');
   capabilities.instruction=instruction.status==='fulfilled'?instruction.value:unavailable('instruction preflight failed');
   try {this.assertCurrent(targetKey(binding));}
   catch {for(const key of ['sources','instruction','questions'] as const)capabilities[key]=unavailable('target changed during capability probe');}
  }
  return render();
 }
 private resolveQuestionReceipts(j:Journal,target:string,report:QuestionResponse) {
  for(const r of j.questionReceipts??[])if(r.target===target&&r.status==='unknown'&&
   report.resolved?.some(q=>q.id===r.questionId&&q.requestId===r.wireId&&['answered','cancelled'].includes(q.state)))r.status='accepted';
 }
 private async questionSnapshot(b:Binding,e:RegistryEntry,j:Journal):Promise<QuestionState> {
  const snapshot:QuestionState={status:'available',observedAt:new Date().toISOString(),questions:[],resolved:[],newQuestionIds:[],nextCursor:null,partial:false};
  const questions=new Map<string,unknown>();const resolved=new Map<string,NonNullable<QuestionResponse['resolved']>[number]>();
  let after:string|undefined;
  for(let page=0;page<4;page++) {
   let result:QuestionResponse;
   try {result=await this.adapters.question(e,b.project,{operation:'list',msg_id:ulid(),...(after?{after}:{})});}
   catch {result={status:'unavailable',reason:'question channel unavailable'};}
   if(result.status!=='available') {snapshot.status=result.status;snapshot.reason=result.reason;snapshot.partial=true;break;}
   for(const q of result.questions??[])questions.set((q as {id:string}).id,q);
   for(const q of result.resolved??[])resolved.set(q.id,q);
   snapshot.partial ||= !!result.partial;
   snapshot.nextCursor=result.nextCursor??null;
   if(!result.nextCursor)break;
   if(result.nextCursor===after){snapshot.partial=true;break;}
   after=result.nextCursor;
  }
  // A question resolved between pages must not be presented as still pending.
  for(const id of resolved.keys())questions.delete(id);
  snapshot.questions=[...questions.values()];snapshot.resolved=[...resolved.values()];
  const target=targetKey(b);const seen=j.questionSeen?.target===target?j.questionSeen.ids:[];
  snapshot.newQuestionIds=[...questions.keys()].filter(id=>!seen.includes(id));
  // A failed read is not evidence that previously observed questions disappeared.
  j.questionSeen={target,ids:[...new Set([...seen,...questions.keys()])].slice(-256)};
  this.resolveQuestionReceipts(j,target,snapshot);
  return snapshot;
 }
 private assertCurrent(target:string) {
  const current=this.client.status();
  if(current.status!=='available'||!current.binding||targetKey(current.binding)!==target)throw Error('target changed during read');
 }
 async status() {
  const status=this.client.status();
  if(status.status!=='available')return {...status,questionState:{status:'unavailable',reason:`selection ${status.status}`,observedAt:new Date().toISOString(),questions:[],resolved:[],newQuestionIds:[],partial:true}};
  return this.client.transaction(async(b,e,read,save)=>{
   const j=journal(read());const questionState=await this.questionSnapshot(b,e,j);
   this.assertCurrent(targetKey(b));save(JSON.stringify(j));return {...this.client.status(),questionState};
  });
 }
 async resync(fresh=false, waitMs=0) {
  return this.client.transaction(async(b,e,read,save)=>{
   const j=journal(read());const target=targetKey(b);const changed=j.target!==target;
   const cursor=fresh||changed?{}:j.cursor;
   const pending=j.receipts.filter(r=>r.target===target&&r.wireId&&!['result','failed'].includes(r.state)).map(r=>r.wireId!);
   const [source,question]=await Promise.allSettled([this.adapters.read(e,b.project,cursor,waitMs,pending),this.questionSnapshot(b,e,j)]);
   const report:SourceReport=source.status==='fulfilled'?source.value:{observedAt:new Date().toISOString(),cursor,partial:true,pane:{paneId:null,state:'unavailable',reason:'source reader unavailable'},activity:{available:false},monitor:{available:false}};
   const questionState:QuestionState=question.status==='fulfilled'?question.value:{status:'unavailable',observedAt:new Date().toISOString(),questions:[],resolved:[],newQuestionIds:[],partial:true};
   for(const reply of report.replies??[]){const receipt=j.receipts.find(r=>r.target===target&&r.wireId===reply.wireId);if(receipt&&!['result','failed'].includes(receipt.state)){receipt.state=reply.state;receipt.result=reply.result;receipt.reason=reply.truncated?'correlated Pi transcript reply (truncated)':'correlated Pi transcript reply';}}
   this.assertCurrent(target);
   j.target=target;j.cursor=report.cursor ?? {};j.report={...report,partial:!!report.partial||!!questionState.partial,questionState,binding:b,receipts:j.receipts.filter(r=>r.target===target).slice(-10)};
   save(JSON.stringify(j));return j.report;
  });
 }
 async replay():Promise<SourceReport> {const {binding,raw}=this.client.readRuntime();const j=journal(raw);if(j.target!==targetKey(binding)||!j.report)throw Error('no report for selected target');return {...j.report,replayed:true};}
 async receipts() {const {binding,raw}=this.client.readRuntime();const j=journal(raw);return {
  receipts:j.receipts.filter(r=>r.target===targetKey(binding)),questionReceipts:(j.questionReceipts??[]).filter(r=>r.target===targetKey(binding))};}
 async questions(after?:string) {
  if(after!==undefined&&!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(after))throw Error('invalid question cursor');
  return this.client.transaction(async(b,e,read,save)=>{
   const report=await this.adapters.question(e,b.project,{operation:'list',msg_id:ulid(),...(after?{after}:{})});
   const current=this.client.status();
   if(current.status!=='available'||!current.binding||targetKey(current.binding)!==targetKey(b))throw Error('target changed during question read');
   const j=journal(read());
   this.resolveQuestionReceipts(j,targetKey(b),report);
   save(JSON.stringify(j));return {...report,observedAt:new Date().toISOString(),binding:b};
  });
 }
 async answerQuestion(requestId:string,questionId:string,answer:unknown) {
  for(const id of [requestId,questionId])if(typeof id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(id))throw Error('invalid question/request ID');
  const serialized=JSON.stringify(answer);
  if(typeof serialized!=='string'||Buffer.byteLength(serialized)>16000)throw Error('invalid answer payload');
  return this.client.transaction(async(b,e,read,save)=>{
   const j=journal(read());const receipts=j.questionReceipts??=[];const target=targetKey(b);
   const digest=createHash('sha256').update(serialized).digest('hex');
   const prior=receipts.find(r=>r.requestId===requestId);
   if(prior){if(prior.target!==target||prior.questionId!==questionId||prior.digest!==digest)throw Error('request ID already used for different answer/question/target');return prior;}
   if(receipts.length>=1000)throw Error('question receipt journal full; no IDs were evicted');
   const receipt:QuestionReceipt={requestId,wireId:ulid(),target,questionId,digest,status:'unknown',at:new Date().toISOString()};
   receipts.push(receipt);save(JSON.stringify(j));
   try {
    const result=await this.adapters.question(e,b.project,{operation:answer===null?'cancel':'answer',msg_id:receipt.wireId,questionId,answer});
    receipt.status=result.status;
   }catch {receipt.status='unknown';}
   save(JSON.stringify(j));return receipt;
  });
 }
 async send(commandId:string,text:string,waitMs=1000) {
  if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(commandId))throw Error('invalid command ID');
  if(!text.trim()||Buffer.byteLength(text)>16000)throw Error('instruction must contain 1–16000 bytes');
  if(!Number.isInteger(waitMs)||waitMs<100||waitMs>60000)throw Error('wait must be 100–60000 ms');
  return this.client.transaction(async(b,e,read,save)=>{
   const j=journal(read()); const target=targetKey(b);const digest=createHash('sha256').update(text).digest('hex');
   const previous=j.receipts.find(r=>r.commandId===commandId);
   if(previous){if(previous.target!==target||previous.digest!==digest)throw Error('command ID already used for different text or target');return previous;}
   if(j.receipts.length>=1000)throw Error('receipt journal full; no IDs were evicted');
   const source=await this.adapters.read(e,b.project,{},0);
   const pane=source.pane?.paneId;
   if(!pane)throw Error('no unique visible herdr Pi pane; send unsupported');
   if(this.client.status().status!=='available')throw Error('target changed before send');
   const receipt:Receipt={commandId,wireId:ulid(),target,digest,state:'unknown',at:new Date().toISOString(),reason:'delivery not yet confirmed; never auto-retry'};
   j.receipts.push(receipt); save(JSON.stringify(j)); // Durable BEFORE any instruction crosses the socket.
   try {
    const result=await this.adapters.send(e,b.project,pane,receipt.wireId!,text,waitMs,state=>{receipt.state=state;receipt.reason='accepted as Pi follow-up; completion not yet confirmed';save(JSON.stringify(j));});
    Object.assign(receipt,result);
   } catch {receipt.state='unknown';receipt.reason='transport interrupted; inspect resync, do not resend';}
   save(JSON.stringify(j)); return receipt;
  });
 }
}
