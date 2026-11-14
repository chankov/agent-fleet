import {randomUUID,createHash} from 'node:crypto';
import {assessLoadedFleetCatalog} from './fleet-codex-catalog.ts';
import {validInstructionTarget,targetKey,type QueueCompatibilityAssessment} from './fleet-notification-validation.ts';
import type {CodexEventBinding} from './fleet-codex-event-bridge.ts';

type Owner=Readonly<{project:string;peer:string;sessionId:string;startedAt:string}>;
export type BootstrapNamespace=Readonly<{hostProfile:string;principal:string;threadId:string}>;
export type BootstrapRight='read'|'send'|'approve';
export type BootstrapRights=Readonly<{revision:number;rights:readonly BootstrapRight[];status:string;expiresAt?:number}>;
type Eligible=Exclude<QueueCompatibilityAssessment,{level:'blocked'}>;
export type BootstrapInspection=Readonly<{
 desktopIdentity?:string;hostInstance:string;identity:'host_context_validated';catalog:unknown;assessment:QueueCompatibilityAssessment;
 /** A server-owned tested capability, NEVER inferred from UA/schema or model flags. */
 probeReadCapability:'verified_without_loading'|'unavailable';rights:BootstrapRights;
}>;
export type BootstrapScope=Readonly<{owner:Owner;namespace:BootstrapNamespace;binding:CodexEventBinding;until:number;rights:readonly BootstrapRight[]}>;
export type BootstrapConfirmation=Readonly<{scope:BootstrapScope;compatibility:Eligible;previousRights:BootstrapRights;warning?:'schema_not_verified';probeConsumesModelTurn:true;requiresCodexWriterQuiescence:true;grantsApproveAutomatically:false}>;
export type ProbeReceipt=Readonly<{
 status:'acknowledged';source:'read_only_assistant_transcript';probeId:string;threadId:string;hostInstance:string;
 daemonVersion:string;desktopVersion:string;socketEpoch:string;notLoadedBefore:true;notLoadedAfter:true;receiptId:string;
}>;
export type BootstrapServices={
 owner:()=>Owner|null;now?:()=>number;monotonic?:()=>number;operationTimeoutMs?:number;
 inspect:(namespace:BootstrapNamespace,signal:AbortSignal)=>Promise<BootstrapInspection>;
 confirm:(review:BootstrapConfirmation,signal:AbortSignal)=>Promise<boolean>;
 /** Adapter to the CODEX singleton writer. AF never writes AllowedSessionsStore. */
 codexWriteRights:(request:Readonly<{scope:BootstrapScope;expected:BootstrapRights}>,signal:AbortSignal)=>Promise<BootstrapRights>;
 probe:(request:Readonly<{scope:BootstrapScope;assessment:Eligible;probeId:string}>,signal:AbortSignal)=>Promise<ProbeReceipt|{status:'failed'|'unknown';reason:string}>;
 /** Atomic0600 config + in-memory admission/activation; only after live ACK. */
 activate:(request:Readonly<{scope:BootstrapScope;assessment:Eligible;receipt:ProbeReceipt;catalog:unknown;rights:BootstrapRights}>,signal:AbortSignal)=>Promise<{enabled:true}>;
 disable:(namespace:BootstrapNamespace,signal:AbortSignal)=>Promise<void>;
};
type Inspection=Omit<BootstrapInspection,'assessment'|'catalog'|'rights'> & {assessment:Eligible;catalog:{identity:string;protocolVersion:string;tools:{name:string}[]};rights:BootstrapRights};
type Result=Readonly<{status:string;reason?:string;rightsCommitted?:true|'unknown';expiresAt?:number;compatibility?:string;activation:'not_performed'|'enabled'|'unknown';startsDaemon:false;grantsApproveAutomatically:false}>;
type Guarded={scope:Pick<BootstrapScope,'owner'|'until'>;wall:number;mono:number;cancelled:boolean;controllers:Set<AbortController>};
type Pending=Guarded & {id:string;scope:BootstrapScope;before:Inspection;key:string;state:string;result?:Result;running?:Promise<Result>};
const object=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const text=(v:unknown,max=512):v is string=>typeof v==='string'&&v.length>0&&v.length<=max&&!/[\u0000-\u0020\u007f]/.test(v);
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const namespace=(v:unknown):v is BootstrapNamespace=>object(v)&&Object.keys(v).sort().join(',')==='hostProfile,principal,threadId'&&text(v.hostProfile,128)&&text(v.principal,128)&&uuid(v.threadId);
const key=(v:BootstrapNamespace)=>JSON.stringify([v.hostProfile,v.principal,v.threadId]);
const failure=(error:unknown,fallback:string)=>error instanceof Error&&/^[a-z][a-z0-9_]{0,95}$/.test(error.message)?error.message:fallback;
const rights=(v:unknown):v is BootstrapRight[]=>Array.isArray(v)&&v.length<=3&&JSON.stringify(v)===JSON.stringify(['read',...(v.includes('send')?['send']:[]),...(v.includes('approve')?['approve']:[])]);
const outcome=(status:string,reason?:string,committed?:true|'unknown',activation:'not_performed'|'unknown'='not_performed'):Result=>({status,...(reason?{reason}:{}),...(committed?{rightsCommitted:committed}:{}),activation,startsDaemon:false,grantsApproveAutomatically:false});

/** AF-side bounded orchestration. The injected adapters are trusted server code,
 * NOT model/tool-supplied JSON or booleans. Missing identity/no-load capability
 * fails before consent/rights/probe. Cached rows/status never run an adapter.
 * Adapters must honor cancellation and recheck scope immediately before every
 * external write/publication; arbitrary uncooperative effects cannot be undone.
 * This coordinator is not a live driver or evidence qualification registry. */
export class NotificationBootstrap {
 readonly #services:BootstrapServices;readonly #now:()=>number;readonly #mono:()=>number;readonly #timeout:number;
 #stopped=false;
 readonly #pending=new Map<string,Pending>();readonly #rows=new Map<string,{namespace:BootstrapNamespace;ownerKey:string;state:string;reason?:string;expiresAt?:number;validUntil:number}>();
 constructor(services:BootstrapServices){this.#services={...services};if(['owner','inspect','confirm','codexWriteRights','probe','activate','disable'].some(k=>typeof (this.#services as any)[k]!=='function'))throw Error('bootstrap_options_invalid');this.#now=services.now??Date.now;this.#mono=services.monotonic??(()=>performance.now());this.#timeout=services.operationTimeoutMs??60000;if(!Number.isInteger(this.#timeout)||this.#timeout<1||this.#timeout>60000)throw Error('bootstrap_options_invalid');}
 #owner(){const owner=this.#services.owner();if(!validInstructionTarget(owner))throw Error('owner_unavailable');return structuredClone(owner);}
 #rights(value:BootstrapRights):BootstrapRights{
  if(!object(value)||!Number.isSafeInteger(value.revision)||value.revision<0||!Array.isArray(value.rights)||(value.rights.length&&!rights(value.rights))||!text(value.status,128)||(value.expiresAt!==undefined&&(!Number.isSafeInteger(value.expiresAt)||value.expiresAt<=0)))throw Error('rights_invalid');
  return {revision:value.revision,rights:[...value.rights],status:value.status,...(value.expiresAt===undefined?{}:{expiresAt:value.expiresAt})};
 }
 #inspection(value:BootstrapInspection):Inspection{
  const assessed=value?.assessment;
  if(value?.desktopIdentity!==undefined&&(typeof value.desktopIdentity!=='string'||!/^([a-f0-9]{64})$/.test(value.desktopIdentity)))throw Error('identity_or_probe_read_unavailable');
  if(!object(value)||value.identity!=='host_context_validated'||!text(value.hostInstance)||value.probeReadCapability!=='verified_without_loading'||!assessed||assessed.level==='blocked'||!['verified','contract_checked','contract_unverified'].includes(assessed.level)||assessed.activation!=='not_performed'||assessed.requiresProbe!==true)throw Error(assessed?.level==='blocked'?assessed.reason:'identity_or_probe_read_unavailable');
  if(assessed.level==='contract_unverified'&&(assessed.warning!=='schema_not_verified'||!['matching_binary_unavailable','schema_export_unavailable','schema_export_timeout'].includes(assessed.reason)))throw Error('compatibility_invalid');
  const c=assessed.context;
  if(!text(c.daemonVersion,256)||!text(c.desktopVersion,256)||!text(c.socketEpoch,1024)||(['verified','contract_checked'].includes(assessed.level)&&!('fingerprint'in assessed&&/^[a-f0-9]{64}$/.test(assessed.fingerprint))))throw Error('compatibility_invalid');
  if(!assessLoadedFleetCatalog(value.catalog).ready)throw Error('catalog_not_ready');
  const catalog=value.catalog as {protocolVersion:string;tools:{name:string}[]};
  return {...(value.desktopIdentity?{desktopIdentity:value.desktopIdentity}:{}),identity:'host_context_validated',hostInstance:value.hostInstance,probeReadCapability:value.probeReadCapability,assessment:structuredClone(assessed),rights:this.#rights(value.rights),catalog:{identity:'host_context_validated',protocolVersion:catalog.protocolVersion,tools:catalog.tools.map(t=>({name:t.name})).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)}};
 }
 #inspectionKey(v:Inspection){return createHash('sha256').update(JSON.stringify([v.hostInstance,v.assessment,v.catalog,v.probeReadCapability,v.desktopIdentity??null])).digest('hex');}
 #guard(p:Guarded){const now=this.#now(),mono=this.#mono();if(this.#stopped||p.cancelled||!Number.isSafeInteger(now)||!Number.isFinite(mono)||now<p.wall||mono<p.mono||now-p.wall>=300000||mono-p.mono>=300000||now>=p.scope.until||targetKey(this.#owner())!==targetKey(p.scope.owner))throw Error('proposal_context_changed');}
 async #call<T>(p:Guarded,ms:number,fn:(signal:AbortSignal)=>Promise<T>):Promise<T>{
  this.#guard(p);ms=Math.min(ms,this.#timeout);const controller=new AbortController(),deadline=performance.now()+ms;p.controllers.add(controller);let timer:ReturnType<typeof setTimeout>|undefined,abort=()=>{};
  const stopped=new Promise<never>((_,reject)=>{abort=()=>reject(Error(p.cancelled?'bootstrap_cancelled':'bootstrap_timeout'));controller.signal.addEventListener('abort',abort,{once:true});timer=setTimeout(()=>controller.abort(),ms);});
  try{const result=await Promise.race([Promise.resolve().then(()=>fn(controller.signal)),stopped]);if(performance.now()>=deadline)throw Error('bootstrap_timeout');this.#guard(p);return result;}
  finally{if(timer)clearTimeout(timer);controller.signal.removeEventListener('abort',abort);p.controllers.delete(controller);controller.abort();}
 }
 #remember(p:Pending,state:string,reason?:string){if(this.#stopped||p.cancelled)return;p.state=state;this.#rows.set(key(p.scope.namespace),{namespace:structuredClone(p.scope.namespace),ownerKey:targetKey(p.scope.owner),state,...(reason?{reason}:{}),expiresAt:p.scope.until,validUntil:state==='enabled'?p.scope.until:Math.min(p.scope.until,p.wall+300000)});}
 #prune(){const now=this.#now(),mono=this.#mono();let owner='';try{owner=targetKey(this.#owner());}catch{}for(const [id,p]of this.#pending)if(targetKey(p.scope.owner)!==owner||now<p.wall||mono<p.mono||now-p.wall>=300000||mono-p.mono>=300000){p.cancelled=true;for(const c of p.controllers)c.abort();this.#pending.delete(id);}for(const [id,row]of this.#rows)if(row.ownerKey!==owner||row.state!=='enabled'&&row.validUntil<=now)this.#rows.delete(id);}
 rows(){const now=this.#now();let current='';try{current=targetKey(this.#owner());}catch{}return structuredClone([...this.#rows.values()].map(({ownerKey,...row})=>({...row,...(ownerKey!==current?{state:'owner_changed'}:row.validUntil<=now?{state:'expired'}:{})})));}
 async prepare(c:BootstrapNamespace,until:number,requestedRights?:readonly BootstrapRight[],signal?:AbortSignal){
  if(signal?.aborted)return {status:'blocked',reason:'bootstrap_cancelled',activation:'not_performed'};
  if(this.#stopped)return {status:'blocked',reason:'bootstrap_stopped',activation:'not_performed'};
  if(!namespace(c)||!Number.isSafeInteger(until)||until<=this.#now()||until-this.#now()>720*3600000||(requestedRights!==undefined&&!rights(requestedRights)))return {status:'blocked',reason:'invalid_proposal',activation:'not_performed'};
  c=structuredClone(c);requestedRights=requestedRights===undefined?undefined:[...requestedRights];
  this.#prune();if(this.#pending.size>=16||(!this.#rows.has(key(c))&&this.#rows.size>=32))return {status:'blocked',reason:'bootstrap_capacity',activation:'not_performed'};
  if([...this.#pending.values()].some(p=>key(p.scope.namespace)===key(c)&&!p.result&&!p.cancelled))return {status:'blocked',reason:'proposal_in_progress',activation:'not_performed'};
  let owner:Owner;try{owner=this.#owner();}catch{return {status:'blocked',reason:'owner_unavailable',activation:'not_performed'};}
  const wall=this.#now(),mono=this.#mono(),id=randomUUID();
  const placeholder={owner,namespace:structuredClone(c),binding:{id:'notification-'+randomUUID(),epoch:randomUUID(),hostInstance:'pending',threadId:c.threadId,fleetOwner:targetKey(owner)},until,rights:['read'] as BootstrapRight[]};
  const p:Pending={id,scope:placeholder,before:null as unknown as Inspection,key:'',wall,mono,state:'inspecting',cancelled:false,controllers:new Set()};
  // Reserve capacity before yielding, including concurrently inspecting jobs.
  this.#pending.set(id,p);this.#rows.set(key(c),{namespace:structuredClone(c),ownerKey:targetKey(owner),state:'inspecting',expiresAt:until,validUntil:Math.min(until,wall+300000)});
  const cancelled=()=>{p.cancelled=true;for(const controller of p.controllers)controller.abort();};signal?.addEventListener('abort',cancelled,{once:true});if(signal?.aborted)cancelled();
  try{
   const seen=this.#inspection(await this.#call(p,30000,s=>this.#services.inspect(structuredClone(c),s)));
   p.before=seen;p.key=this.#inspectionKey(seen);
   p.scope={...placeholder,binding:{...placeholder.binding,hostInstance:seen.hostInstance},rights:[...(requestedRights??(seen.rights.rights.length?seen.rights.rights:['read']))]};
   this.#pending.set(id,p);this.#remember(p,'prepared');
   return {status:'prepared',proposalId:id,namespace:structuredClone(c),owner:structuredClone(owner),expiresAt:until,rights:[...p.scope.rights],compatibility:seen.assessment.level,...(seen.assessment.level==='contract_unverified'?{warning:'schema_not_verified'}:{}),requiresPiConfirmation:true,activation:'not_performed',startsDaemon:false,grantsApproveAutomatically:false};
  }catch(error){const reason=failure(error,'inspection_failed');this.#pending.delete(id);if(!p.cancelled)this.#rows.set(key(c),{namespace:structuredClone(c),ownerKey:targetKey(owner),state:'blocked',reason,expiresAt:until,validUntil:Math.min(until,wall+300000)});return {status:'blocked',reason,activation:'not_performed'};}
  finally{signal?.removeEventListener('abort',cancelled);}
 }
 async #fresh(p:Pending,expectedRights:BootstrapRights){
  const seen=this.#inspection(await this.#call(p,30000,s=>this.#services.inspect(structuredClone(p.scope.namespace),s)));
  if(this.#inspectionKey(seen)!==p.key||JSON.stringify(seen.rights)!==JSON.stringify(expectedRights))throw Error('observed_context_changed');return seen;
 }
 cancel(proposalId:string,c:BootstrapNamespace){const p=this.#pending.get(proposalId);if(!p||key(p.scope.namespace)!==key(c)||p.result)return false;p.cancelled=true;for(const controller of p.controllers)controller.abort();return true;}
 commit(proposalId:string,c?:BootstrapNamespace,signal?:AbortSignal):Promise<Result>{
  const p=this.#pending.get(proposalId);if(!p||c&&key(c)!==key(p.scope.namespace))return Promise.resolve(outcome('rejected','proposal_unavailable'));
  if(signal?.aborted){this.cancel(proposalId,p.scope.namespace);return Promise.resolve(outcome('rejected','bootstrap_cancelled'));}
  try{this.#guard(p);}catch{return Promise.resolve(outcome('rejected','proposal_context_changed'));}
  if(p.result)return Promise.resolve(structuredClone(p.result));
  const cancelled=()=>this.cancel(proposalId,p.scope.namespace);signal?.addEventListener('abort',cancelled,{once:true});
  if(!p.running)p.running=Promise.resolve().then(()=>this.#commit(p));
  return p.running.then(result=>structuredClone(result)).finally(()=>signal?.removeEventListener('abort',cancelled));
 }
 async #commit(p:Pending):Promise<Result>{
  let changed=false,writtenConfirmed=false,activationAttempted=false;
  try{
   this.#guard(p);await this.#fresh(p,p.before.rights);this.#remember(p,'confirming');
   const review:BootstrapConfirmation={scope:structuredClone(p.scope),compatibility:structuredClone(p.before.assessment),previousRights:structuredClone(p.before.rights),...(p.before.assessment.level==='contract_unverified'?{warning:'schema_not_verified' as const}:{}),probeConsumesModelTurn:true,requiresCodexWriterQuiescence:true,grantsApproveAutomatically:false};
   if(await this.#call(p,60000,s=>this.#services.confirm(review,s))!==true){this.#remember(p,'cancelled');return p.result=outcome('cancelled','pi_confirmation_declined');}
   await this.#fresh(p,p.before.rights);this.#remember(p,'writing_rights');changed=true;
   const written=this.#rights(await this.#call(p,5000,s=>this.#services.codexWriteRights({scope:structuredClone(p.scope),expected:structuredClone(p.before.rights)},s)));
   if(written.revision<=p.before.rights.revision||written.status!=='active'||written.expiresAt!==p.scope.until||JSON.stringify(written.rights)!==JSON.stringify(p.scope.rights))throw Error('rights_commit_uncertain');
   writtenConfirmed=true;
   const seen=await this.#fresh(p,written),probeId=randomUUID();this.#remember(p,'probing');
   const receipt=structuredClone(await this.#call(p,30000,s=>this.#services.probe({scope:structuredClone(p.scope),assessment:structuredClone(seen.assessment),probeId},s)));
   if(receipt.status!=='acknowledged')throw Error('probe_'+receipt.status);
   const context=seen.assessment.context;
   if(receipt.source!=='read_only_assistant_transcript'||receipt.probeId!==probeId||receipt.threadId!==p.scope.namespace.threadId||receipt.hostInstance!==seen.hostInstance||receipt.daemonVersion!==context.daemonVersion||receipt.desktopVersion!==context.desktopVersion||receipt.socketEpoch!==context.socketEpoch||receipt.notLoadedBefore!==true||receipt.notLoadedAfter!==true||!text(receipt.receiptId))throw Error('probe_context_mismatch');
   await this.#fresh(p,written);this.#remember(p,'activating');activationAttempted=true;
   const active=await this.#call(p,5000,s=>this.#services.activate({scope:structuredClone(p.scope),assessment:structuredClone(seen.assessment),receipt:structuredClone(receipt),catalog:structuredClone(seen.catalog),rights:structuredClone(written)},s));
   if(active?.enabled!==true)throw Error('activation_uncertain');this.#remember(p,'enabled');
   return p.result={status:'enabled',rightsCommitted:true,expiresAt:p.scope.until,compatibility:seen.assessment.level,activation:'enabled',startsDaemon:false,grantsApproveAutomatically:false};
  }catch(error){const reason=failure(error,'bootstrap_failed');this.#remember(p,changed?'unknown':'rejected',reason);return p.result=outcome(changed?'partially_applied_or_unknown':'rejected',reason,changed?(writtenConfirmed?true:'unknown'):undefined,activationAttempted?'unknown':'not_performed');}
 }
 reset(){for(const p of this.#pending.values()){p.cancelled=true;for(const controller of p.controllers)controller.abort();}this.#pending.clear();this.#rows.clear();}
 stop(){this.#stopped=true;for(const p of this.#pending.values()){p.cancelled=true;for(const controller of p.controllers)controller.abort();}this.#pending.clear();for(const row of this.#rows.values()){row.state='disabled';row.reason='owner_stopped';}}
 async disable(c:BootstrapNamespace){
  if(this.#stopped)return outcome('rejected','bootstrap_stopped');
  if(!namespace(c)||!this.#rows.has(key(c)))return outcome('rejected','unknown_namespace');c=structuredClone(c);let owner:Owner;try{owner=this.#owner();}catch{return outcome('rejected','owner_unavailable');}
  for(const p of this.#pending.values())if(key(p.scope.namespace)===key(c)){p.cancelled=true;for(const controller of p.controllers)controller.abort();}
  const budget:Guarded={scope:{owner,until:this.#now()+5001},wall:this.#now(),mono:this.#mono(),cancelled:false,controllers:new Set()};
  try{await this.#call(budget,5000,s=>this.#services.disable(structuredClone(c),s));this.#rows.set(key(c),{namespace:structuredClone(c),ownerKey:targetKey(owner),state:'disabled',validUntil:this.#now()+300000});return outcome('disabled');}
  catch{return outcome('unknown','disable_failed',undefined,'unknown');}
 }
}
