import {createHash} from 'node:crypto';
import type {BootstrapServices} from '../../../harnesses/lib/fleet-notification-bootstrap.ts';
import type {CodexUnixQueueRpc} from './codex-unix-queue-rpc.ts';
import type {CodexProbeTranscript,ProbeCheckpoint} from './codex-probe-transcript.ts';
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const object=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
type Request=Parameters<BootstrapServices['probe']>[0];
/** One no-load probe. guard is TRUSTED server code rechecking exact native
 * identity/read capability/owner/rights/context; never a model-supplied boolean.
 * Metadata path comes only from pinned includeTurns:false response, not tool args.
 * No fallback to thread load/resume, queue retry, or queue-ACK-as-delivery. */
export class CodexBootstrapProbe {
 private readonly options:{rpc:Pick<CodexUnixQueueRpc,'request'>;reader:Pick<CodexProbeTranscript,'checkpoint'|'waitForAck'|'close'>;guard:(request:Request)=>void;progress?:(stage:'queue_submission'|'waiting_ack'|'validating_ack',deadline:number)=>void};
 readonly #used=new Map<string,number>();
 constructor(options:CodexBootstrapProbe['options']){this.options={...options};}
 async run(input:Request,signal:AbortSignal):ReturnType<BootstrapServices['probe']>{
  const request=structuredClone(input),{scope,assessment,probeId}=request;
  if(!uuid(probeId)||!uuid(scope?.namespace?.threadId)||scope.binding.threadId!==scope.namespace.threadId||!['verified','contract_checked','contract_unverified'].includes(assessment.level)||!('context'in assessment))throw Error('bootstrap_probe_invalid');
  const now=performance.now();for(const [id,until]of this.#used)if(until<=now)this.#used.delete(id);
  if(this.#used.has(probeId)||this.#used.size>=128)throw Error('bootstrap_probe_not_replayable');this.#used.set(probeId,now+600000);
  const deadline=now+120000,timeout=new AbortController(),scoped=AbortSignal.any([signal,timeout.signal]),timer=setTimeout(()=>timeout.abort(),120000);
  const guard=()=>{if(scoped.aborted||performance.now()>=deadline||Date.now()>=scope.until)throw Error('bootstrap_probe_stale');this.options.guard(structuredClone(request));if(scoped.aborted||performance.now()>=deadline)throw Error('bootstrap_probe_stale');};
  const pin={daemonVersion:assessment.context.daemonVersion,socketEpoch:assessment.context.socketEpoch};let checkpoint:ProbeCheckpoint|undefined,attempted=false;
  const metadata=async()=>{guard();const raw=await this.options.rpc.request('thread/read',{threadId:scope.namespace.threadId,includeTurns:false},{signal:scoped,pin,beforeWrite:guard});guard();
   if(!object(raw)||!object(raw.thread)||raw.thread.id!==scope.namespace.threadId||raw.thread.status?.type!=='notLoaded'||typeof raw.thread.path!=='string'||!raw.thread.path||raw.thread.path.length>4096)throw Error('bootstrap_probe_metadata_unavailable');return raw.thread.path as string;};
  try{
   const path=await metadata();checkpoint=await this.options.reader.checkpoint(path,scope.namespace.threadId,scoped);guard();
   if(await metadata()!==path)throw Error('bootstrap_probe_path_changed');
   if(deadline-performance.now()<=10000)throw Error('bootstrap_probe_budget_too_short');
   const clientUserMessageId=createHash('sha256').update(JSON.stringify([scope.binding,assessment.context,probeId])).digest('hex');
   const envelope={schema:'fleet-bootstrap-probe/v1',source:'fleet_machine',transportOrigin:'user_input',humanApproval:false,deliveryProbe:true,probeId,threadId:scope.namespace.threadId,bindingId:scope.binding.id,bindingEpoch:scope.binding.epoch,fleetOwner:scope.binding.fleetOwner,deadline:Math.floor(Math.min(scope.until,Date.now()+deadline-performance.now())),expectedReply:'FLEET_PROBE_ACK '+probeId};
   const text='FLEET_BOOTSTRAP_PROBE_V1\n'+JSON.stringify(envelope)+'\nТова е само машинен тест за доставка, НЕ човешко одобрение или Fleet задача. Само ако thread/epoch/срокът съвпадат, отговори с единствен final_answer точно expectedReply, без инструменти, файлови промени, права или команди. При изтекъл/чужд probe не възстановявай разрешения.';
   this.options.progress?.('queue_submission',envelope.deadline);
   const result=await this.options.rpc.request('thread/queue/add',{threadId:scope.namespace.threadId,clientUserMessageId,input:[{type:'text',text,text_elements:[]}]},{signal:scoped,pin,beforeWrite:()=>{guard();attempted=true;}});
   guard();if(!attempted)throw Error('bootstrap_probe_missing_prewrite_guard');const q=object(result)&&result.queuedSubmission;
   if(!object(q)||typeof q.id!=='string'||!q.id||q.id.length>256||q.clientUserMessageId!==clientUserMessageId||!Array.isArray(q.input)||q.input.length!==1||q.input[0]?.type!=='text'||q.input[0]?.text!==text)throw Error('bootstrap_probe_enqueue_unknown');
   this.options.progress?.('waiting_ack',envelope.deadline);
   const ack=await this.options.reader.waitForAck(checkpoint,probeId,scoped);guard();
   this.options.progress?.('validating_ack',envelope.deadline);
   if(ack.source!=='local_codex_rollout_jsonl'||ack.readerVersion!=='codex-local-rollout-ack/v1'||ack.threadId!==scope.namespace.threadId||ack.probeId!==probeId||!/^rollout:[a-f0-9]{64}$/.test(ack.receiptId))throw Error('bootstrap_probe_ack_invalid');
   if(await metadata()!==path)throw Error('bootstrap_probe_path_changed');guard();
   const closing=checkpoint;checkpoint=undefined;await this.options.reader.close(closing);guard();
   return {status:'acknowledged',source:'read_only_assistant_transcript',probeId,threadId:scope.namespace.threadId,hostInstance:scope.binding.hostInstance,...assessment.context,notLoadedBefore:true,notLoadedAfter:true,receiptId:ack.receiptId};
  }catch(error){
   // Only expose known diagnostic codes, never transport messages or payloads.
   const known=new Set(['bootstrap_probe_stale','bootstrap_probe_path_changed','bootstrap_probe_enqueue_unknown','bootstrap_probe_ack_invalid','bootstrap_probe_metadata_unavailable','probe_reader_timeout','probe_reader_cancelled','probe_reader_changed']);
   const cause=timeout.signal.aborted?'timeout':signal.aborted?'cancelled':error instanceof Error&&known.has(error.message)?error.message:undefined;
   throw Error((attempted?'bootstrap_probe_unknown_no_replay':'bootstrap_probe_not_sent')+(cause?'_'+cause:''));
  }
  finally{clearTimeout(timer);timeout.abort();if(checkpoint)await this.options.reader.close(checkpoint);}
 }
}
