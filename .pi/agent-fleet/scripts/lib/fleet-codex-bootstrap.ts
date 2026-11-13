import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,lstatSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {NotificationBootstrap,type BootstrapServices,type BootstrapNamespace,type BootstrapScope,type BootstrapInspection} from '../../../harnesses/lib/fleet-notification-bootstrap.ts';
import {assessLoadedFleetCatalog} from '../../../harnesses/lib/fleet-codex-catalog.ts';
import {codexRightsSnapshot} from '../../../harnesses/lib/fleet-codex-policy-snapshot.ts';
import {namespaceKey,type BootstrapPresence} from '../../../harnesses/lib/fleet-bootstrap-channel.ts';
import {issueBootstrapAdmission} from '../../../harnesses/lib/fleet-notification-admission.ts';
import {codexNotificationBootstrapPolicy} from '../../../harnesses/lib/codex-notification-profile.ts';
import {assessQueueCompatibility,targetKey,validInstructionTarget,type NotificationConfig,type QueueCompatibilityAssessment} from '../../../harnesses/lib/fleet-notification-validation.ts';
import {AllowedSessionsStore,StoreError,type StoreSnapshot} from './fleet-codex-allowlist-store.ts';
import type {TargetEpoch} from './fleet-codex-allowlist.ts';
import {CodexDaemonObserver} from './codex-daemon-observer.ts';
import {measureDaemon,exportSchema,schemaExportStillCurrent,CodexMeasurementError,type DaemonMeasurement} from './codex-measurement.ts';
import {CodexUnixQueueRpc} from './codex-unix-queue-rpc.ts';
import {CodexProbeTranscript} from './codex-probe-transcript.ts';
import {CodexBootstrapProbe} from './codex-bootstrap-probe.ts';
import type {AutomaticDesktopData} from './codex-desktop-discovery.ts';
import {DesktopPreflightRegistry,type DesktopPreflightRecord} from './codex-desktop-preflight.ts';
import {NativePresenceDirectory,type NativePresence} from './codex-native-presence.ts';
import {privateDirectory,directoryCurrent,writePrivateJson,readPrivateJson,privateFileIdentity} from './codex-bootstrap-files.ts';
import {FleetCodexNotificationRuntime,parseNotificationConfiguration} from './fleet-codex-event-runtime.ts';

type DesktopConfirmation=Parameters<BootstrapServices['confirm']>[0]&{desktopMapping?:Pick<DesktopPreflightRecord,'desktop'|'desktopVersion'|'versionSource'|'socketPath'|'codexHome'|'binaryPath'>};
type Eligible=Exclude<QueueCompatibilityAssessment,{level:'blocked'}>;
type Snapshot={namespace:BootstrapNamespace;owner:TargetEpoch;record:DesktopPreflightRecord;observation:BootstrapPresence;store:AllowedSessionsStore;state:StoreSnapshot|null;observer:CodexDaemonObserver;measurement:DaemonMeasurement;assessment:Eligible;catalog:any;wall:number;transcriptPath?:string};
export type BootstrapChatRow={namespace:BootstrapNamespace;producer:'fresh'|'missing'|'stale'|'ambiguous';hostInstance?:string;clientInfo?:BootstrapPresence['clientInfo'];rights:readonly string[];rightsStatus:string;expiresAt?:number;notification:string;reason?:string;compatibility?:string;daemonVersion?:string;desktopVersion?:string;socketEpoch?:string;bindingEpoch?:string;lastProbe?:{id:string;receiptId:string};lastNotification?:unknown;proposalState?:string};
type Activation=Parameters<BootstrapServices['activate']>[0];
type Active={runtime:FleetCodexNotificationRuntime;config:NotificationConfig;path:string;identity:string;parentIdentity:string;guard:()=>boolean;request:Activation;snapshot:Snapshot;controller:AbortController;monoUntil:number;wall:number;rechecking:boolean;attempted:boolean;recheckFailure?:string;autoBudget:{remaining:number}};
const clone=<T>(v:T):T=>structuredClone(v);
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
// Cached diagnostics only: exact internal codes, never raw exceptions/UA/paths.
const recheckFailures=new Set(['daemon_version_unavailable','daemon_observation_failed','measurement_timeout','measurement_cancelled','invalid_socket_epoch','initialize_epoch_mismatch','socket_epoch_changed','schema_binary_changed','native_presence_required','desktop_preflight_required','catalog_not_ready','continuation_scope_changed','continuation_rights_changed','continuation_config_changed','compat_recheck_failed','compat_recheck_changed','bootstrap_cancelled','bootstrap_context_changed','daemon_context_changed','bootstrap_rights_changed','bootstrap_probe_not_sent','bootstrap_probe_unknown_no_replay','compat_recheck_probe_unknown','bootstrap_activation_cancelled','bootstrap_activation_changed','bootstrap_config_scope_mismatch','bootstrap_config_changed','notification_journal_root_conflict','bootstrap_file_changed','bootstrap_file_publication_unknown']);
function recheckFailure(stage:'inspect'|'probe'|'verify'|'activate',error:unknown,cancelled:boolean){return 'd7_'+stage+'_'+(cancelled?'cancelled':error instanceof Error&&recheckFailures.has(error.message)?error.message:'failed');}
/** Production AF services. All status/render data is cached. No active services
 * are created until explicit native prepare/UI enable; raw presence is never
 * promoted to Desktop identity or no-load capability. Only Codex writes rights.
 * Missing operator-observed Desktop/process/catalog mapping fails closed and is
 * a live-preflight prerequisite, not fabricated offline qualification. */
export class FleetCodexBootstrap {
 readonly coordinator:NotificationBootstrap;readonly native:NativePresenceDirectory;readonly preflight:DesktopPreflightRegistry;
 private readonly options:{policyRoot:string;namespace:{hostProfile:string;principal:string};owner:()=>TargetEpoch|null;presence:(c:BootstrapNamespace,lease?:boolean)=>BootstrapPresence|null;writeRights:BootstrapServices['codexWriteRights'];confirm:(review:DesktopConfirmation,signal:AbortSignal)=>Promise<boolean>;discoverDesktop?:(signal:AbortSignal)=>Promise<AutomaticDesktopData>;confirmPreflight:ConstructorParameters<typeof DesktopPreflightRegistry>[0]['confirm'];procRoot?:string;referenceDocuments?:unknown;legacy?:()=>{config:NotificationConfig;runtime?:FleetCodexNotificationRuntime;release:()=>void}|undefined};
 readonly #automatic=new Map<string,DesktopPreflightRecord>();readonly #root:string;readonly #stop=new AbortController();#epoch=new AbortController();readonly #snapshots=new Map<string,Snapshot>();readonly #active=new Map<string,Active>();readonly #rows=new Map<string,BootstrapChatRow>();readonly #schemas=new Map<string,Awaited<ReturnType<typeof exportSchema>>>();readonly #exports=new Map<string,Promise<Awaited<ReturnType<typeof exportSchema>>>>();readonly #busy=new Set<string>();#refreshing=false;
 constructor(options:FleetCodexBootstrap['options']){
  this.options={...options,namespace:{...options.namespace}};this.#root=options.policyRoot+'.bootstrap';this.native=new NativePresenceDirectory(options.policyRoot+'.presence');
  this.preflight=new DesktopPreflightRegistry({root:join(this.#root,'desktop-mappings'),procRoot:options.procRoot,confirm:async(review,signal)=>{const accepted=await options.confirmPreflight(review,signal);if(accepted===true&&!signal.aborted)await privateDirectory(this.#root,true);return accepted;}});
  this.coordinator=new NotificationBootstrap({owner:options.owner,inspect:(c,s)=>this.#inspect(c,s),confirm:(r,s)=>this.#confirm(r,s),codexWriteRights:options.writeRights,probe:(r,s)=>this.#probe(r,s),activate:(r,s)=>this.#activate(r,s),disable:(c,s)=>this.#disable(c,s)});
 }
 async #confirm(review:Parameters<BootstrapServices['confirm']>[0],signal:AbortSignal){
  const key=namespaceKey(review.scope.namespace),snapshot=this.#snapshots.get(key);if(!snapshot)throw Error('bootstrap_inspection_required');this.#guard(snapshot);
  const record=snapshot.record,ask=()=>this.options.confirm({...review,...(this.preflight.isAutomaticDraft(record)?{desktopMapping:{desktop:clone(record.desktop),desktopVersion:record.desktopVersion,versionSource:record.versionSource,socketPath:record.socketPath,codexHome:record.codexHome,binaryPath:record.binaryPath}}:{})},signal);
  const accepted=await ask();if(!accepted)return false;this.#guard(snapshot);
  if(signal.aborted||!snapshot.transcriptPath)throw Error('bootstrap_cancelled');
  const reader=new CodexProbeTranscript({codexHome:record.codexHome,timeoutMs:2000});
  try{await reader.securePermissions(snapshot.transcriptPath,review.scope.namespace.threadId,signal,()=>this.#guard(snapshot));}finally{await reader.stop();}
  if(!this.preflight.isAutomaticDraft(record))return true;
  const confirmed=await this.preflight.confirmAutomatic(record,snapshot.observation,async()=>{this.#guard(snapshot);return true;},signal,()=>this.#guard(snapshot));
  if(!confirmed)return false;snapshot.record=confirmed;this.#automatic.delete(key);return true;
 }

 #owner(){const owner=this.options.owner();if(!validInstructionTarget(owner))throw Error('owner_unavailable');return clone(owner);}
 async #rights(c:BootstrapNamespace){const store=new AllowedSessionsStore(this.options.policyRoot,c);try{return {store,state:await store.open()};}catch(e){if(e instanceof StoreError&&e.code==='STATE_MISSING')return {store,state:null};throw Error('codex_rights_unavailable');}}
 #catalog(observation:BootstrapPresence){const catalog={identity:'host_context_validated',protocolVersion:observation.protocolVersion,tools:observation.catalog.map(name=>({name}))};if(!assessLoadedFleetCatalog(catalog).ready)throw Error('catalog_not_ready');return catalog;}
 #rightsCurrent(snapshot:Snapshot,allowSend=false){
  if(snapshot.store.snapshotCurrent(snapshot.state))return true;
  const next=allowSend?snapshot.store.advanceSendSnapshot(snapshot.state,snapshot.owner):null;
  if(!next)return false;snapshot.state=next;return true;
 }
 #guard(snapshot:Snapshot,scope?:BootstrapScope,assessment?:Eligible,lease=false,allowSend=false){
  const seen=this.options.presence(snapshot.namespace,lease),owner=this.options.owner();
  if(this.#stop.signal.aborted||!owner||targetKey(owner)!==targetKey(snapshot.owner)||!seen||seen.hostInstance!==snapshot.observation.hostInstance||(!this.preflight.currentNow(snapshot.record,seen)&&(!!scope||lease||!this.preflight.observedCurrentNow(snapshot.record,seen)))||!this.#rightsCurrent(snapshot,allowSend)||Date.now()<snapshot.wall)throw Error('bootstrap_context_changed');
  this.#catalog(seen);
  if(snapshot.observer.socketEpoch(this.#stop.signal)!==snapshot.measurement.socketEpoch)throw Error('daemon_context_changed');
  if(assessment&&!same(assessment.context,snapshot.assessment.context))throw Error('daemon_context_changed');
  if(scope){const rights=codexRightsSnapshot(snapshot.state,owner),project=(r:readonly string[])=>allowSend?r.filter(r=>r!=='send'):r;if(targetKey(scope.owner)!==targetKey(owner)||namespaceKey(scope.namespace)!==namespaceKey(snapshot.namespace)||scope.binding.hostInstance!==seen.hostInstance||rights.status!=='active'||rights.expiresAt!==scope.until||Date.now()>=scope.until||!same(project(rights.rights),project(scope.rights)))throw Error('bootstrap_rights_changed');}
 }
 async #contract(record:DesktopPreflightRecord,measured:DaemonMeasurement,signal:AbortSignal){
  if(!record.binaryPath)return {state:'unavailable' as const,daemonVersion:measured.version,desktopVersion:record.desktopVersion,socketEpoch:measured.socketEpoch,reason:'matching_binary_unavailable' as const};
  const key=hash([record.binaryPath,measured.version,measured.socketEpoch]);let evidence=this.#schemas.get(key);
  try{
   if(evidence&&!await schemaExportStillCurrent(record.binaryPath,evidence,{signal,timeoutMs:2000})){this.#schemas.delete(key);evidence=undefined;}
   if(!evidence){let pending=this.#exports.get(key);if(!pending){pending=exportSchema(record.binaryPath,measured,{signal,timeoutMs:8000});this.#exports.set(key,pending);void pending.finally(()=>this.#exports.delete(key)).catch(()=>{});}evidence=await pending;if(signal.aborted)throw Error('bootstrap_cancelled');if(!await schemaExportStillCurrent(record.binaryPath,evidence,{signal,timeoutMs:2000}))throw Error('schema_binary_changed');if(this.#schemas.size>=2)this.#schemas.delete(this.#schemas.keys().next().value!);this.#schemas.set(key,evidence);}
   return {state:'available' as const,daemonVersion:evidence.version,desktopVersion:record.desktopVersion,socketEpoch:evidence.socketEpoch,documents:evidence.documents};
  }catch(e){if(!signal.aborted&&e instanceof CodexMeasurementError&&e.code==='measurement_timeout')return {state:'unavailable' as const,daemonVersion:measured.version,desktopVersion:record.desktopVersion,socketEpoch:measured.socketEpoch,reason:'schema_export_timeout' as const};throw e;}
 }
 async #inspect(c:BootstrapNamespace,signal:AbortSignal,lease=false):Promise<BootstrapInspection>{
  if(c.hostProfile!==this.options.namespace.hostProfile||c.principal!==this.options.namespace.principal||this.#stop.signal.aborted||signal.aborted)throw Error('native_namespace_unavailable');
  if(!lease&&this.#active.get(namespaceKey(c))?.rechecking)throw Error('bootstrap_recheck_in_progress');
  const owner=this.#owner(),observation=this.options.presence(c,lease);if(!observation)throw Error('native_presence_required');
  if(!lease){const all=await this.native.list(signal),matching=all.filter(r=>r.fresh&&namespaceKey(r.observation.namespace)===namespaceKey(c)&&r.observation.hostInstance===observation.hostInstance);if(matching.length!==1||matching[0].observation.hostInstance!==observation.hostInstance)throw Error('native_presence_ambiguous_or_unavailable');}
  let record=await this.preflight.current(observation,signal);
  if(!record&&!lease&&this.options.discoverDesktop){
   const key=namespaceKey(c),draft=this.#automatic.get(key);
   if(draft&&this.preflight.observedCurrentNow(draft,observation))record=draft;
   else{if(this.#automatic.size>=32&&!this.#automatic.has(key))throw Error('bootstrap_capacity');record=await this.preflight.observeAutomatic(observation,await this.options.discoverDesktop(signal),signal);this.#automatic.set(key,record);}
  }
  if(!record)throw Error('desktop_preflight_required');
  this.#catalog(record.observation);const catalog=this.#catalog(observation),{store,state}=await this.#rights(c),observer=new CodexDaemonObserver({socketPath:record.socketPath}),measurement=await measureDaemon(observer,{signal,timeoutMs:2000});
  const contract=await this.#contract(record,measurement,signal),reference=this.options.referenceDocuments??JSON.parse(readFileSync(new URL('../fixtures/codex-notification-contracts/bootstrap-profile-0.167.json',import.meta.url),'utf8')).referenceDocuments;
  const assessment=assessQueueCompatibility({daemonVersion:measurement.version,desktopVersion:record.desktopVersion,socketEpoch:measurement.socketEpoch,contract},codexNotificationBootstrapPolicy(reference));if(assessment.level==='blocked')throw Error(assessment.reason);
  const snapshot:Snapshot={namespace:clone(c),owner,record,observation:clone(observation),store,state,observer,measurement,assessment,catalog,wall:Date.now()};
  const guard=()=>{if(signal.aborted)throw Error('bootstrap_cancelled');this.#guard(snapshot,undefined,undefined,lease);};guard();
  // Actual capability check: exact metadata path/header, no turns/hydration,
  // before/after notLoaded observations. It is NOT inferred from reader source.
  const rpc=new CodexUnixQueueRpc({socketPath:record.socketPath}),reader=new CodexProbeTranscript({codexHome:record.codexHome,timeoutMs:2000});
  try{const pin={daemonVersion:measurement.version,socketEpoch:measurement.socketEpoch};const read=async()=>{guard();const raw:any=await rpc.request('thread/read',{threadId:c.threadId,includeTurns:false},{signal,pin,beforeWrite:guard});guard();if(raw?.thread?.id!==c.threadId||raw.thread.status?.type!=='notLoaded'||typeof raw.thread.path!=='string')throw Error('probe_read_capability_unavailable');return raw.thread.path as string;};
   const path=await read();await reader.checkCapability(path,c.threadId,signal);snapshot.transcriptPath=path;if(await read()!==path)throw Error('probe_read_path_changed');
  }finally{await reader.stop();}
  guard();if(this.#snapshots.size>=32&&!this.#snapshots.has(namespaceKey(c))){const old=[...this.#snapshots.keys()].find(k=>!this.#active.has(k)&&!this.#busy.has(k));if(!old)throw Error('bootstrap_capacity');this.#snapshots.delete(old);}this.#snapshots.set(namespaceKey(c),snapshot);return {desktopIdentity:this.preflight.identityFingerprint(record),hostInstance:observation.hostInstance,identity:'host_context_validated',catalog,assessment,probeReadCapability:'verified_without_loading',rights:codexRightsSnapshot(state,owner)};
 }
 async #probe(request:Parameters<BootstrapServices['probe']>[0],signal:AbortSignal,lease=false){
  const snapshot=this.#snapshots.get(namespaceKey(request.scope.namespace));if(!snapshot)throw Error('bootstrap_inspection_required');this.#guard(snapshot,request.scope,request.assessment,lease);
  const reader=new CodexProbeTranscript({codexHome:snapshot.record.codexHome}),driver=new CodexBootstrapProbe({rpc:new CodexUnixQueueRpc({socketPath:snapshot.record.socketPath}),reader,guard:()=>this.#guard(snapshot,request.scope,request.assessment,lease)});
  try{return await driver.run(request,signal);}finally{await reader.stop();}
 }
 async #activate(request:Activation,signal:AbortSignal,continuation?:Active){
  if(continuation)signal=AbortSignal.any([signal,continuation.controller.signal]);
  const key=namespaceKey(request.scope.namespace),snapshot=this.#snapshots.get(key);if(!snapshot)throw Error('bootstrap_inspection_required');const deadline=performance.now()+4000;
  const guard=()=>{if(signal.aborted||performance.now()>=deadline)throw Error('bootstrap_activation_cancelled');this.#guard(snapshot,request.scope,request.assessment,!!continuation);if(continuation)this.#continuationCurrent(key,continuation,false);};guard();
  const scopeHash=hash([request.scope.namespace,request.scope.owner]),legacy=this.options.legacy?.(),matchingLegacy=legacy&&legacy.config.approval.binding.threadId===request.scope.namespace.threadId&&targetKey(legacy.config.approval.target)===targetKey(request.scope.owner)?legacy:undefined;
  const old=this.#active.get(key),sameOld=old&&targetKey(old.config.approval.target)===targetKey(request.scope.owner)?old:undefined;
  const path=join(this.#root,'configs',scopeHash+'.json'),previous=await readPrivateJson(path,32768,signal);guard();let saved:NotificationConfig|undefined;
  if(previous){saved=parseNotificationConfiguration(JSON.stringify(previous.value));if(!saved.compat||namespaceKey(saved.compat.namespace)!==key||saved.approval.binding.threadId!==request.scope.namespace.threadId||targetKey(saved.approval.target)!==targetKey(request.scope.owner))throw Error('bootstrap_config_scope_mismatch');}
  const roots=[sameOld?.config.stateRoot,matchingLegacy?.config.stateRoot,saved?.stateRoot].filter((r):r is string=>typeof r==='string');if(new Set(roots).size>1)throw Error('notification_journal_root_conflict');const stateRoot=roots[0]??join(this.#root,'events',scopeHash);
  if(old){await old.runtime.stopAndDrain();if(!continuation)this.#active.delete(key);}if(matchingLegacy){await matchingLegacy.runtime?.stopAndDrain();matchingLegacy.release();}guard();
  await privateDirectory(dirname(stateRoot),true);await privateDirectory(dirname(path),true);guard();const parentIdentity=await privateDirectory(dirname(path));
  let identity:string|undefined,completed=false,admitted:ReturnType<typeof issueBootstrapAdmission>;
  const current=()=>{try{if(!completed&&(signal.aborted||performance.now()>=deadline))return false;this.#guard(snapshot,request.scope,request.assessment,true,completed);return !!identity&&directoryCurrent(dirname(path),parentIdentity)&&privateFileIdentity(lstatSync(path))===identity&&performance.now()<leaseDeadline;}catch{return false;}};
  const leaseDeadline=continuation?.monoUntil??performance.now()+Math.max(0,request.scope.until-Date.now());admitted=issueBootstrapAdmission(request,{stateRoot,socketPath:snapshot.record.socketPath,messageBudgetMs:30000},current);
  guard();if(continuation&&previous?.identity!==continuation.identity)throw Error('bootstrap_config_changed');identity=await writePrivateJson(path,admitted.config,{signal,guard,expected:previous?.identity??null});guard();
  await this.refreshCached();guard();
  const runtime=new FleetCodexNotificationRuntime(admitted.config,()=>this.options.owner(),undefined,undefined,admitted.admission,()=>{const active=this.#active.get(key);if(active?.runtime===runtime)this.#scheduleRecheck(key,active);});
  try{await runtime.start();guard();if(!current())throw Error('bootstrap_activation_changed');this.#active.set(key,{runtime,config:admitted.config,path,identity,parentIdentity,guard:current,request:clone(request),snapshot,controller:new AbortController(),monoUntil:leaseDeadline,wall:continuation?.wall??Date.now(),rechecking:false,attempted:false,autoBudget:continuation?.autoBudget??{remaining:4}});completed=true;if(continuation)continuation.controller.abort();return {enabled:true as const};}catch(e){runtime.stop();throw e;}
 }
 async #disable(c:BootstrapNamespace,signal:AbortSignal){
  const key=namespaceKey(c),active=this.#active.get(key);if(active){active.controller.abort();active.runtime.stop();this.#active.delete(key);if(!this.#stop.signal.aborted&&!signal.aborted)await writePrivateJson(active.path,{...active.config,optedIn:false},{signal,expected:active.identity});}
  await this.refreshCached();
 }
 async #attach(c:BootstrapNamespace,signal:AbortSignal){
  if(this.options.presence(c))return;const key=namespaceKey(c),rows=(await this.native.list(signal)).filter(r=>r.fresh&&namespaceKey(r.observation.namespace)===key);if(rows.length!==1)throw Error('native_presence_required');const r=rows[0];let attach:string|undefined;
  try{attach=await this.native.requestAttach({schema:r.schema,observation:r.observation,observedAt:r.observedAt},this.#owner(),signal);const until=performance.now()+5000;
   while(!this.options.presence(c)){if(signal.aborted||this.#stop.signal.aborted||performance.now()>=until)throw Error('native_writer_unavailable');await new Promise(resolve=>setTimeout(resolve,50));}
  }finally{if(attach)await this.native.cancelAttach(attach).catch(()=>{});}
 }
 async capturePreflight(c:BootstrapNamespace,parameters:Parameters<DesktopPreflightRegistry['capture']>[1],signal=new AbortController().signal){signal=AbortSignal.any([signal,this.#epoch.signal,this.#stop.signal]);await this.#attach(c,signal);const observed=this.options.presence(c);if(!observed)throw Error('native_presence_required');this.#catalog(observed);const record=await this.preflight.capture(observed,parameters,signal);await this.refreshCached();return record;}
 async enable(c:BootstrapNamespace,rights:readonly ('read'|'send'|'approve')[]=['read','send','approve'],durationHours=12,signal=new AbortController().signal){
  signal=AbortSignal.any([signal,this.#epoch.signal,this.#stop.signal]);const key=namespaceKey(c);if(this.#busy.has(key))throw Error('bootstrap_busy');this.#busy.add(key);
  try{
   await this.#attach(c,signal);
   const prepared=await this.coordinator.prepare(c,Date.now()+durationHours*3600000,rights,signal);if(prepared.status!=='prepared'||!('proposalId'in prepared))return prepared;return await this.coordinator.commit(prepared.proposalId as string,c,signal);
  }finally{this.#busy.delete(key);await this.refreshCached();}
 }
 #continuationCurrent(key:string,active:Active,file=true){
  const scope=active.request.scope,seen=this.options.presence(scope.namespace,true),owner=this.options.owner();
  if(this.#stop.signal.aborted||active.controller.signal.aborted||this.#active.get(key)!==active||!owner||targetKey(owner)!==targetKey(scope.owner)||Date.now()<active.wall||Date.now()>=scope.until||performance.now()>=active.monoUntil||!seen||seen.hostInstance!==scope.binding.hostInstance||!this.preflight.currentNow(active.snapshot.record,seen)||!this.#rightsCurrent(active.snapshot,true))throw Error('continuation_scope_changed');
  this.#catalog(seen);const rights=codexRightsSnapshot(active.snapshot.state,owner),withoutSend=(r:readonly string[])=>r.filter(r=>r!=='send');if(rights.status!=='active'||rights.revision<active.config.approval.authorityRevision||rights.expiresAt!==scope.until||!same(withoutSend(rights.rights),withoutSend(scope.rights)))throw Error('continuation_rights_changed');
  if(file&&(!directoryCurrent(dirname(active.path),active.parentIdentity)||privateFileIdentity(lstatSync(active.path))!==active.identity))throw Error('continuation_config_changed');
 }
 #scheduleRecheck(key:string,active:Active){
  if(active.attempted||active.rechecking||this.#stop.signal.aborted)return;active.attempted=true;active.rechecking=true;
  // Only a detected context invalidation schedules this. Cached status/UI refresh
  // never calls it. One attempt: unknown probe/activation is never replayed.
  void this.#recheck(key,active).catch(()=>{}).finally(()=>{active.rechecking=false;});
 }
 async #recheck(key:string,active:Active){
  const deadline=new AbortController(),timer=setTimeout(()=>deadline.abort(),60000),signal=AbortSignal.any([deadline.signal,active.controller.signal,this.#epoch.signal,this.#stop.signal]);
  let stage:'inspect'|'probe'|'verify'|'activate'='inspect';
  try{
   this.#continuationCurrent(key,active);const inspection=await this.#inspect(active.request.scope.namespace,signal,true);this.#continuationCurrent(key,active);
   if(!same(inspection.rights,codexRightsSnapshot(active.snapshot.state,active.request.scope.owner)))throw Error('continuation_rights_changed');
   // A missing schema cannot prove the old used contract is still the same.
   // D6 stays paused with guidance; do not silently authorize a new version.
   if(inspection.assessment.level==='contract_unverified'||inspection.assessment.level==='blocked'||active.config.compat?.level!==inspection.assessment.level||!active.config.compat.fingerprint||inspection.assessment.fingerprint!==active.config.compat.fingerprint||active.autoBudget.remaining<=0)throw Error('compat_recheck_failed');
   const scope={...clone(active.request.scope),rights:[...inspection.rights.rights],binding:{...active.request.scope.binding,epoch:randomUUID()}},probeId=randomUUID();active.autoBudget.remaining--;
   stage='probe';const receipt=await this.#probe({scope,assessment:inspection.assessment,probeId},signal,true);this.#continuationCurrent(key,active);
   if(receipt.status!=='acknowledged')throw Error('compat_recheck_probe_unknown');stage='verify';const after=await this.#inspect(scope.namespace,signal,true);this.#continuationCurrent(key,active);
   if(after.assessment.level==='blocked'||!same(after.assessment,inspection.assessment)||!same(after.rights,inspection.rights))throw Error('compat_recheck_changed');
   stage='activate';await this.#activate({scope,assessment:inspection.assessment,receipt,catalog:inspection.catalog,rights:inspection.rights},signal,active);
  }catch(error){if(this.#active.get(key)===active)active.recheckFailure=recheckFailure(stage,error,signal.aborted);}
  finally{clearTimeout(timer);}
 }
 /** Separate safety watcher, not rendering/status. It may only retire the old
  * runtime; continuation runs under the prior Pi scope, same fingerprint and
  * original common wall/monotonic lease, with no Codex writer calls. */
 checkContexts(){for(const [key,active]of this.#active)if(!active.guard())active.runtime.pauseForContextChange();}
 hasRuntimeFor(threadId:string){return [...this.#active.values()].some(a=>a.config.approval.binding.threadId===threadId);}
 async disable(c:BootstrapNamespace){const key=namespaceKey(c),active=this.#active.get(key);if(active){active.controller.abort();active.runtime.stop();}const result=await this.coordinator.disable(c);if(active&&this.#active.get(key)===active){await this.#disable(c,this.#stop.signal);return {status:'disabled',activation:'not_performed'};}return result;}
 rows(){return [...this.#rows.values()].map(clone);}
 async refreshCached(){
  if(this.#refreshing||this.#stop.signal.aborted)return;this.#refreshing=true;
  try{
   let presences:Readonly<NativePresence&{fresh:boolean}>[]=[];try{presences=await this.native.list();}catch{}
   const keys=new Map<string,BootstrapNamespace>();for(const p of presences)if(p.observation.namespace.hostProfile===this.options.namespace.hostProfile&&p.observation.namespace.principal===this.options.namespace.principal)keys.set(namespaceKey(p.observation.namespace),p.observation.namespace);for(const c of this.coordinator.rows())keys.set(namespaceKey(c.namespace),c.namespace);for(const s of this.#snapshots.values())keys.set(namespaceKey(s.namespace),s.namespace);
   for(const [key,c]of [...keys].slice(0,32)){
    const rows=presences.filter(p=>namespaceKey(p.observation.namespace)===key),attached=this.options.presence(c),fresh=rows.filter(p=>p.fresh&&(!attached||p.observation.hostInstance===attached.hostInstance)),seen=fresh.length===1?fresh[0].observation:rows[0]?.observation,active=this.#active.get(key),snapshot=this.#snapshots.get(key),phase=this.coordinator.rows().find(r=>namespaceKey(r.namespace)===key);
    const status=active?.runtime.status();let rights:ReturnType<typeof codexRightsSnapshot>;try{rights=codexRightsSnapshot((await this.#rights(c)).state,this.#owner());}catch{rights={revision:0,rights:[],status:'unavailable'};}
    this.#rows.set(key,{namespace:clone(c),producer:fresh.length>1?'ambiguous':fresh.length===1?'fresh':rows.length?'stale':'missing',hostInstance:seen?.hostInstance,clientInfo:seen?.clientInfo,rights:rights.rights,rightsStatus:rights.status,expiresAt:rights.expiresAt,notification:active?.rechecking?'rechecking_context':status?.enabled?'enabled':status?.reason??'disabled',reason:active?.recheckFailure??status?.reason??phase?.reason,proposalState:phase?.state,compatibility:active?.config.compat?.level??snapshot?.assessment.level,daemonVersion:active?.config.compat?.daemonVersion??snapshot?.measurement.version,desktopVersion:active?.config.compat?.desktopVersion??snapshot?.record.desktopVersion,socketEpoch:active?.config.compat?.socketEpoch??snapshot?.measurement.socketEpoch,bindingEpoch:active?.config.approval.binding.epoch,lastProbe:active?.config.compat?.probe,lastNotification:status?.lastNotification});
   }
  }finally{this.#refreshing=false;}
 }
 reset(){this.#epoch.abort();this.#epoch=new AbortController();this.coordinator.reset();for(const a of this.#active.values()){a.controller.abort();a.runtime.stop();}this.#active.clear();this.#snapshots.clear();this.#automatic.clear();this.#rows.clear();}
 stop(){this.#stop.abort();this.#epoch.abort();this.coordinator.stop();for(const a of this.#active.values()){a.controller.abort();a.runtime.stop();}this.#active.clear();this.#automatic.clear();}
}
