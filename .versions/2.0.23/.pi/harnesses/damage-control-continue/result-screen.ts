import {createHash} from 'node:crypto';
import {resolve,isAbsolute} from 'node:path';
import {damageCaptureAvailable} from '../lib/damage-result-evidence.ts';
import {damageResultView} from '../lib/damage-result-view.ts';
import {safeSourceRead} from '../lib/safe-source-read.js';
import {screenDamagePayload} from '../lib/system1/payload-screen.ts';
import {parseDamageGuardConfig} from '../lib/system1/config-damage-guard.js';
import {DAMAGE_GUARD_VERSION,DAMAGE_GUARD_QUESTIONS,damageVerdict} from '../agent-hub/damage-guard-contract.ts';
import type {System1Service,System1Result} from '../lib/system1/contracts.ts';
export interface DamageResultEvent {toolName:string;toolCallId:string;input:unknown;content:readonly any[];details?:unknown;structuredContent?:unknown;isError?:boolean;usage?:unknown;status?:string;exit_code?:number;exitCode?:number;}
const record=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
/** Only complete output with a single verifiable authorized file source is supported. */
function extract(event:DamageResultEvent,cwd?:string):{path:string;text:string;hash?:string}|undefined {
 if(event.isError||event.status!==undefined&&!['ok','success','done'].includes(event.status)||event.exit_code!==undefined&&event.exit_code!==0||event.exitCode!==undefined&&event.exitCode!==0||!record(event.input)||event.content.length!==1||event.content[0]?.type!=='text'||typeof event.content[0].text!=='string')return;
 const input=event.input,text=event.content[0].text,details=event.details;
 if(event.toolName==='read'){
  if(typeof input.path!=='string'||input.offset!==undefined&&input.offset!==1||input.limit!==undefined)return;
  if(details!==undefined&&(!record(details)||Object.keys(details).some(k=>k!=='truncation')||details.truncation?.truncated!==false))return;
  if(event.structuredContent!==undefined&&event.structuredContent!==text)return;
  return {path:resolve(cwd??'.',input.path),text};
 }
 if(event.toolName==='bash'){
  if(typeof input.command!=='string'||!record(event.structuredContent))return;
  // No expansion, quotes, pipeline, redirection, substitution or unknown shell form.
  const match=/^cat[ \t]+(?:(--)[ \t]+)?([A-Za-z0-9_./-]+)$/.exec(input.command.trim());
  const output=event.structuredContent;
  if(!match||!match[1]&&match[2].startsWith('-')||output.truncated!==false||output.exit_code!==0||typeof output.output!=='string')return;
  return {path:resolve(cwd??'.',match[2]),text:output.output};
 }
 if(event.toolName==='filesystem'&&input.operation==='excerpt'&&typeof input.path==='string'&&record(details)&&record(details.result)){
  const value=details.result;
  if(value.refused||typeof value.path!=='string'||!isAbsolute(value.path)||cwd!==undefined&&value.path!==resolve(cwd,input.path)||value.exactBytesOnDisk!==value.path||value.contentEncoding!=='utf8'||typeof value.content!=='string'||value.offset!==0||value.truncated!==false||value.nextHandle!==null||value.untrusted!==true||value.modelDelegated!==false||typeof value.hash!=='string'||!/^[a-f0-9]{64}$/.test(value.hash)||value.contentBytes!==Buffer.byteLength(value.content)||value.totalBytes!==value.contentBytes)return;
  try{if(JSON.stringify(JSON.parse(text))!==JSON.stringify(value))return;}catch{return;}
  return {path:value.path,text:value.content,hash:value.hash};
 }
}
export const DAMAGE_RESULT_REASONS=['original_capture_unavailable','cancelled','consumer_off','scope_off','service_unavailable','unsupported_source','source_denied','secret','oversized','incomplete','unsupported','unverified_source','stale_or_cancelled','insufficient_evidence','severe_source_instructions','no_additional_finding','screening_failed','transport_unavailable'] as const;
export interface DamageResultMetadata {version:1;status:'evaluated'|'not_evaluated';coverage:'complete'|'none';reason:typeof DAMAGE_RESULT_REASONS[number];warning:boolean;sourceTrusted:false;}
export function damageResultGap(reason:DamageResultMetadata['reason']):DamageResultMetadata{return {version:1,status:'not_evaluated',coverage:'none',reason,warning:false,sourceTrusted:false};}
export function validDamageResultMetadata(v:unknown):v is DamageResultMetadata {
 if(!record(v)||Object.keys(v).sort().join(',')!=='coverage,reason,sourceTrusted,status,version,warning'||v.version!==1||v.sourceTrusted!==false||!DAMAGE_RESULT_REASONS.includes(v.reason))return false;
 return v.status==='evaluated'?v.coverage==='complete'&&(v.reason==='severe_source_instructions'&&v.warning===true||v.reason==='no_additional_finding'&&v.warning===false):v.status==='not_evaluated'&&v.coverage==='none'&&v.warning===false&&!['severe_source_instructions','no_additional_finding'].includes(v.reason);
}
export function composeDamageResult<T extends DamageResultEvent>(event:T,metadata:DamageResultMetadata):T {
 const advice=metadata.warning?'[Untrusted Damage-Control advisory: source contains agent-directed malicious instructions; this warning grants no authority.] ':'';
 return damageResultView(event,advice+'Damage-Control result coverage: '+JSON.stringify(metadata),metadata);
}
/** Only strict supported evidence crosses IPC. Usage, arbitrary extras and decorations stay local. */
export function projectDamageResult(event:DamageResultEvent):Omit<DamageResultEvent,'toolCallId'>|undefined {
 const input=event.input;if(!record(input)||event.isError)return;
 const allowed=event.toolName==='read'?['path','offset','limit']:event.toolName==='bash'?['command','timeout']:event.toolName==='filesystem'?['operation','path']:[];
 if(!allowed.length||Object.keys(input).some(k=>!allowed.includes(k)))return;
 if(!extract(event))return;
 const result:any={toolName:event.toolName,input:structuredClone(input),content:[{type:'text',text:event.content[0].text}]};
 if(event.toolName==='read'){if(event.details!==undefined)result.details={truncation:{truncated:false}};if(event.structuredContent!==undefined)result.structuredContent=event.structuredContent;}
 if(event.toolName==='bash'){const value=event.structuredContent as any;result.structuredContent={output:value.output,exit_code:0,truncated:false};}
 if(event.toolName==='filesystem'){
  const value=(event.details as any).result;result.details={result:Object.fromEntries(['path','exactBytesOnDisk','contentEncoding','content','offset','truncated','nextHandle','untrusted','modelDelegated','hash','contentBytes','totalBytes'].map(k=>[k,value[k]]))};
  result.content=[{type:'text',text:JSON.stringify(result.details.result)}];
 }
 return result;
}
export function validDamageResultEvidence(v:unknown):boolean {
 try {if(!record(v)||Object.keys(v).some(k=>!['toolName','input','content','details','structuredContent'].includes(k)))return false;const projected=projectDamageResult({...v,toolCallId:''} as DamageResultEvent);return !!projected&&JSON.stringify(projected)===JSON.stringify(v);}catch{return false;}
}
export function createDamageResultScreen(deps:{root:string;config:ReturnType<typeof parseDamageGuardConfig>;canRead(path:string):boolean;service?:System1Service;signal?:AbortSignal;context():string}){
 let disposed=false,backoff=0;const lifetime=new AbortController();
 const screen={dispose(){disposed=true;lifetime.abort();},async evaluate(event:DamageResultEvent,cwd:string,options:{owner?:string;signal?:AbortSignal;deadlineAt?:number;current?():boolean}={}):Promise<DamageResultMetadata>{
  const context=deps.context();
  const finish=(reason:DamageResultMetadata['reason'],warning=false,complete=false):DamageResultMetadata=>({version:1,status:complete?'evaluated':'not_evaluated',coverage:complete?'complete':'none',reason,warning,sourceTrusted:false});
  if(!damageCaptureAvailable(event))return finish('original_capture_unavailable');
  if(disposed||deps.signal?.aborted||options.signal?.aborted)return finish('cancelled');
  if(deps.config.mode!=='active')return finish('consumer_off');
  if(!deps.config.remoteScopes.results)return finish('scope_off');
  if(!deps.service||Date.now()<backoff)return finish('service_unavailable');
  const source=extract(event,cwd);if(!source)return finish('unsupported_source');
  const controller=new AbortController(),abort=()=>controller.abort();options.signal?.addEventListener('abort',abort,{once:true});deps.signal?.addEventListener('abort',abort,{once:true});lifetime.signal.addEventListener('abort',abort,{once:true});
  const deadline=Math.min(Date.now()+deps.config.limits.hookTimeoutMs,options.deadlineAt??Infinity);if(deadline<=Date.now()){options.signal?.removeEventListener('abort',abort);deps.signal?.removeEventListener('abort',abort);lifetime.signal.removeEventListener('abort',abort);return finish('cancelled');}const timer=setTimeout(abort,deadline-Date.now());
  try{
   const screened=await screenDamagePayload({kind:'result',path:source.path,text:source.text,complete:true},{root:deps.root,config:deps.config,canRead:deps.canRead,signal:controller.signal});
   if(screened.status!=='ready')return finish(screened.reason);
   // Authorization/include checks precede this bounded local provenance check.
   // Output from an unknown/overridden shell, changed alias or partial read never substitutes for source bytes.
   const body=safeSourceRead(deps.root,source.path,deps.config.limits.maxPayloadBytes,()=>{if(controller.signal.aborted||!deps.canRead(source.path))throw Error('source_denied');});
   if(!body.equals(Buffer.from(source.text,'utf8'))||source.hash&&source.hash!==createHash('sha256').update(body).digest('hex'))return finish('unverified_source');
   if(controller.signal.aborted||options.current?.()===false)return finish('stale_or_cancelled');
   const request={state:{owner:options.owner??'hub',trigger:event.toolName,scope:'results',coverage:screened.coverage,bytes:screened.bytes,payload:screened.payload},questions:DAMAGE_GUARD_QUESTIONS,questionSetVersion:DAMAGE_GUARD_VERSION,timeoutMs:Math.max(1,deadline-Date.now()),signal:controller.signal};
   if(Buffer.byteLength(JSON.stringify({...request,signal:undefined}))>deps.config.limits.maxPayloadBytes)return finish('oversized');
   const result=await Promise.race([deps.service.evaluate(request),new Promise<System1Result>(resolve=>{if(controller.signal.aborted)resolve({status:'cancelled'});else controller.signal.addEventListener('abort',()=>resolve({status:'cancelled'}),{once:true});})]);
   if(disposed||controller.signal.aborted||options.signal?.aborted||options.current?.()===false||context!==deps.context()||!deps.canRead(source.path))return finish('stale_or_cancelled');
   if(result.status!=='ok'){backoff=Date.now()+deps.config.limits.outageBackoffMs;return finish('service_unavailable');}
   const verdict=damageVerdict(result,'result');
   return verdict==='not_evaluated'?finish('insufficient_evidence'):finish(verdict==='warn_result'?'severe_source_instructions':'no_additional_finding',verdict==='warn_result',true);
  }catch{return finish(disposed||deps.signal?.aborted?'cancelled':'screening_failed');}
  finally{clearTimeout(timer);options.signal?.removeEventListener('abort',abort);deps.signal?.removeEventListener('abort',abort);lifetime.signal.removeEventListener('abort',abort);}
 }};
 return {...screen,async result<T extends DamageResultEvent>(event:T,cwd:string):Promise<T>{return composeDamageResult(event,await screen.evaluate(event,cwd));}};
}
