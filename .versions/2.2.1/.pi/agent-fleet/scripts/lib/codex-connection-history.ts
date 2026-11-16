import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {readPrivateJson,writePrivateJson} from './codex-bootstrap-files.ts';
import {safeDiagnosticReason,type ConnectionDiagnostic,type ConnectionAttempt,type ConnectionHistorySnapshot} from '../../../harnesses/lib/fleet-connection-diagnostics.ts';
import type {BootstrapNamespace} from '../../../harnesses/lib/fleet-notification-bootstrap.ts';
import {validInstructionTarget} from '../../../harnesses/lib/fleet-notification-validation.ts';
const key=(c:BootstrapNamespace)=>JSON.stringify([c.hostProfile,c.principal,c.threadId]);
const stages=new Set(['inspecting','prepared','confirming','writing_rights','probing','queue_submission','waiting_ack','validating_ack','activating','enabled','cancelled','blocked','rejected','unknown','expired','disabled','failed']);
/** Diagnostic evidence only. Never consumed by the authorization or activation path.
 * Per-file CAS prevents silently overwriting another process's diagnostics. */
export class ConnectionHistory {
 private pending=Promise.resolve();
 private gaps=new Set<string>();
 private readonly root:string;
 constructor(root:string){this.root=root;}
 path(c:BootstrapNamespace){return join(this.root,createHash('sha256').update(key(c)).digest('hex')+'.json');}
 private async load(c:BootstrapNamespace){
  const file=await readPrivateJson(this.path(c));if(!file)return null;
  const v=file.value;
  if(v?.schema!=='fleet-connection-history/v1'||key(v.namespace)!==key(c)||!Array.isArray(v.attempts)||v.attempts.length>20)throw Error('history_invalid');
  for(const a of v.attempts){
   if(typeof a.attemptId!=='string'||a.attemptId.length>128||!validInstructionTarget(a.owner)||!Array.isArray(a.transitions)||a.transitions.length>32)throw Error('history_invalid');
   for(const x of a.transitions)if(!stages.has(x.stage)||!Number.isSafeInteger(x.at)||x.at<0||x.deadline!==undefined&&(!Number.isSafeInteger(x.deadline)||x.deadline<0)||x.reason!==undefined&&(typeof x.reason!=='string'||safeDiagnosticReason(x.reason)!==x.reason)||x.probeId!==undefined&&!/^[a-f0-9-]{36}$/.test(x.probeId)||Object.keys(x).some(k=>!['stage','at','deadline','reason','probeId'].includes(k)))throw Error('history_invalid');
   if(Object.keys(a).some(k=>!['attemptId','owner','transitions'].includes(k)))throw Error('history_invalid');
  }
  return {attempts:v.attempts as ConnectionAttempt[],identity:file.identity};
 }
 record(event:ConnectionDiagnostic):Promise<void>{
  const e=structuredClone(event);
  this.pending=this.pending.then(async()=>{
   try{
    if(!stages.has(e.stage)||!validInstructionTarget(e.owner)||typeof e.attemptId!=='string'||e.attemptId.length>128||!Number.isSafeInteger(e.at)||e.at<0)throw Error('history_invalid');
    const file=await this.load(e.namespace),attempts=file?.attempts??[];
    let attempt=attempts.find(a=>a.attemptId===e.attemptId);
    if(attempt&&JSON.stringify(attempt.owner)!==JSON.stringify(e.owner))throw Error('history_owner_changed');
    if(!attempt){attempt={attemptId:e.attemptId,owner:e.owner,transitions:[]};attempts.push(attempt);}
    attempt.transitions.push({stage:e.stage,at:e.at,...(e.deadline===undefined?{}:{deadline:e.deadline}),...(e.reason===undefined?{}:{reason:safeDiagnosticReason(e.reason)}),...(e.probeId===undefined?{}:{probeId:e.probeId})});
    attempt.transitions=attempt.transitions.slice(-32);
    while(attempts.length>20)attempts.shift();
    const value={schema:'fleet-connection-history/v1',namespace:e.namespace,attempts};
    while(Buffer.byteLength(JSON.stringify(value))>30000&&attempts.length>1)attempts.shift();
    await writePrivateJson(this.path(e.namespace),value,{expected:file?.identity??null,createParent:true});this.gaps.delete(key(e.namespace));
   }catch{this.gaps.add(key(e.namespace));}
  });return this.pending;
 }
 async read(c:BootstrapNamespace):Promise<ConnectionHistorySnapshot>{
  await this.pending;
  try{const file=await this.load(c);return {scope:'historical_only',status:this.gaps.has(key(c))?'unavailable':file?'available':'missing',attempts:file?.attempts??[]};}
  catch{return {scope:'historical_only',status:'unavailable',attempts:[]};}
 }
}
