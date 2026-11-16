import {randomUUID} from 'node:crypto';
import {AllowedSessionsStore,StoreError,type StoreOptions,type StoreSnapshot} from './fleet-codex-allowlist-store.ts';
import type {ConversationKey,TargetEpoch,Right} from './fleet-codex-allowlist.ts';
import {PermissionTransport} from './fleet-codex-permission-transport.ts';
import type {NativePresenceDirectory} from './codex-native-presence.ts';
import {BootstrapChannelClient,namespaceKey,bootstrapNamespace,type BootstrapPresence} from '../../../harnesses/lib/fleet-bootstrap-channel.ts';
import {codexRightsSnapshot} from '../../../harnesses/lib/fleet-codex-policy-snapshot.ts';
import {targetKey,validInstructionTarget} from '../../../harnesses/lib/fleet-target-identity.ts';

type Candidate={target:TargetEpoch;current:TargetEpoch[]};
type Pending={context:string;owner:TargetEpoch;expires:number;link:BootstrapChannelClient;running?:Promise<any>;outcome?:any};
const object=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const clone=<T>(v:T):T=>structuredClone(v);
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const failure=(reason:string)=>({status:'blocked',reason,noChanges:true,activation:'not_performed'});

/** Native MCP process owns the writer; neither model arguments nor the AF
 * process can call it directly. Server write frames are accepted only on the
 * exact attached owner/namespace/host-instance channel after native Pi consent.
 * Same-UID cooperative scope is NOT cryptographic human/host authentication. */
export class CodexBootstrapProducer {
 readonly #links=new Map<string,BootstrapChannelClient>();readonly #opening=new Map<string,Promise<BootstrapChannelClient>>();readonly #pending=new Map<string,Pending>();readonly #writing=new Set<string>();readonly #stop=new AbortController();
 readonly #contexts=new Map<string,{observation:BootstrapPresence;at:number;dirty:boolean;publishing?:Promise<void>}>();readonly #requests=new Set<string>();#polling=false;#timer?:ReturnType<typeof setInterval>;
 readonly hostInstance=randomUUID();
 private readonly options:{policyRoot:string;transport:Pick<PermissionTransport,'open'>;candidate:(c:ConversationKey,t:TargetEpoch)=>Promise<Candidate>;observation:()=>{protocolVersion:string;clientInfo:BootstrapPresence['clientInfo'];catalog:string[]}|null;storeOptions?:StoreOptions;now?:()=>number;monotonic?:()=>number;pendingBudget?:(context:string)=>{total:number;context:number};presence?:NativePresenceDirectory};
 constructor(options:CodexBootstrapProducer['options']){this.options={...options};}
 #now(){return (this.options.now??Date.now)();}#mono(){return (this.options.monotonic??(()=>performance.now()))();}
 #store(c:ConversationKey){return new AllowedSessionsStore(this.options.policyRoot,c,{...this.options.storeOptions,now:this.options.now});}
 async #state(c:ConversationKey):Promise<StoreSnapshot|null>{try{return await this.#store(c).open();}catch(e){if(e instanceof StoreError&&e.code==='STATE_MISSING')return null;throw e;}}
 async #fresh(c:ConversationKey,owner:TargetEpoch,signal:AbortSignal){if(this.#stop.signal.aborted||signal.aborted)throw Error('bootstrap_cancelled');const selected=await this.options.candidate(clone(c),clone(owner));if(this.#stop.signal.aborted||signal.aborted||targetKey(selected.target)!==targetKey(owner))throw Error('bootstrap_owner_changed');return clone(selected);}
 #linkKey(c:ConversationKey,t:TargetEpoch){return namespaceKey(c)+'/'+targetKey(t);}
 /** Called only after validated native metadata, never from model identity args.
  * Coalesced private publication has no rights, queue, probe or daemon effects. */
 observe(c:ConversationKey){
  if(!this.options.presence||this.#stop.signal.aborted||!bootstrapNamespace(c))return;const raw=this.options.observation();if(!raw)return;
  const k=namespaceKey(c);let context=this.#contexts.get(k);if(!context){if(this.#contexts.size>=32)return;context={observation:{namespace:clone(c),hostInstance:this.hostInstance,...clone(raw)},at:this.#now(),dirty:true};this.#contexts.set(k,context);}else{context.observation={namespace:clone(c),hostInstance:this.hostInstance,...clone(raw)};context.at=this.#now();context.dirty=true;}
  for(const [id,link]of this.#links)if(id.startsWith(k+'/')&&!link.signal.aborted)void link.refresh(context.observation,context.at).catch(()=>link.stop());
  if(!context.publishing){const current=context;let work:Promise<void>;work=(async()=>{while(current.dirty&&!this.#stop.signal.aborted){current.dirty=false;try{await this.options.presence!.publish(clone(current.observation),this.#stop.signal);}catch{}}})().finally(()=>{if(current.publishing===work)current.publishing=undefined;});current.publishing=work;}
  if(!this.#timer){this.#timer=setInterval(()=>{void this.#poll();},500);this.#timer.unref?.();}
 }
 async #published(c:ConversationKey,signal:AbortSignal){
  const work=this.#contexts.get(namespaceKey(c))?.publishing;if(!work)return;let timer:ReturnType<typeof setTimeout>|undefined;const stop=AbortSignal.any([signal,this.#stop.signal]);let abort=()=>{};
  try{await Promise.race([work,new Promise<never>((_,reject)=>{abort=()=>reject(Error('bootstrap_cancelled'));stop.addEventListener('abort',abort,{once:true});timer=setTimeout(()=>reject(Error('bootstrap_presence_unavailable')),2000);if(stop.aborted)abort();})]);}finally{clearTimeout(timer);stop.removeEventListener('abort',abort);}
 }
 async #poll(){
  if(this.#polling||this.#stop.signal.aborted||!this.options.presence)return;this.#polling=true;
  try{
   for(const [k,c]of this.#contexts)if(this.#now()-c.at>=600000){this.#contexts.delete(k);void this.options.presence.remove(c.observation).catch(()=>{});}
   if(!this.#contexts.size){clearInterval(this.#timer);this.#timer=undefined;return;}
   for(const entry of await this.options.presence.requests(this.hostInstance,this.#stop.signal)){
    if(this.#requests.has(entry.request.id))continue;if(this.#requests.size>=256)this.#requests.delete(this.#requests.values().next().value!);this.#requests.add(entry.request.id);
    const c=this.#contexts.get(namespaceKey(entry.request.namespace));if(!c||this.#now()-c.at>=600000)continue;
    try{await this.#fresh(entry.request.namespace,entry.request.owner,this.#stop.signal);await this.#link(entry.request.namespace,entry.request.owner,this.#stop.signal);}catch{}
    finally{await this.options.presence.consume(entry.path,entry.identity).catch(()=>{});}
   }
  }catch{}finally{this.#polling=false;}
 }
 async #link(c:ConversationKey,owner:TargetEpoch,signal:AbortSignal){
  const id=this.#linkKey(c,owner),existing=this.#links.get(id);if(existing&&!existing.signal.aborted){const at=this.#contexts.get(namespaceKey(c))?.at??this.#now(),raw=this.options.observation();if(raw)await existing.refresh({namespace:clone(c),hostInstance:this.hostInstance,...clone(raw)},at);return existing;}
  const opening=this.#opening.get(id);if(opening)return opening;
  const observation=this.options.observation();if(!bootstrapNamespace(c)||!validInstructionTarget(owner)||!observation||this.#stop.signal.aborted||this.#links.size+this.#opening.size>=32)throw Error('bootstrap_presence_unavailable');
  const work=Promise.resolve().then(async()=>{
   let link:BootstrapChannelClient|undefined;
   try{const socket=await this.options.transport.open(owner,async()=>{await this.#fresh(c,owner,signal);},AbortSignal.any([signal,this.#stop.signal]));
    if(this.#stop.signal.aborted||signal.aborted){socket.destroy();throw Error('bootstrap_cancelled');}
    link=new BootstrapChannelClient({socket,owner,observation:{namespace:clone(c),hostInstance:this.hostInstance,...clone(observation)},writeRights:(command,s)=>this.#write(c,owner,command,s),signal:this.#stop.signal,observedAt:this.#contexts.get(namespaceKey(c))?.at??this.#now()});
    await link.ready();await this.#fresh(c,owner,signal);if(link.signal.aborted)throw Error('bootstrap_presence_unavailable');this.#links.set(id,link);const active=link;
    active.signal.addEventListener('abort',()=>{if(this.#links.get(id)===active)this.#links.delete(id);},{once:true});return active;
   }catch(e){link?.stop();throw e;}finally{this.#opening.delete(id);}
  });this.#opening.set(id,work);return work;
 }
 async #write(c:ConversationKey,owner:TargetEpoch,command:unknown,signal:AbortSignal){
  const context=namespaceKey(c);
  if(!object(command)||!object(command.scope)||!object(command.expected)||this.#writing.has(context))throw Error('bootstrap_writer_invalid');
  const {scope,expected}=clone(command);
  if(!bootstrapNamespace(scope.namespace)||namespaceKey(scope.namespace)!==context||!validInstructionTarget(scope.owner)||targetKey(scope.owner)!==targetKey(owner)
   ||!object(scope.binding)||scope.binding.threadId!==c.threadId||scope.binding.hostInstance!==this.hostInstance||scope.binding.fleetOwner!==targetKey(owner)
   ||!Number.isSafeInteger(scope.until)||scope.until<=this.#now()||scope.until-this.#now()>720*3600000||!Array.isArray(scope.rights)||scope.rights.length>3
   ||JSON.stringify(scope.rights)!==JSON.stringify(['read',...(scope.rights.includes('send')?['send']:[]),...(scope.rights.includes('approve')?['approve']:[])]))throw Error('bootstrap_writer_scope_changed');
  this.#writing.add(context);
  try{
   const selected=await this.#fresh(c,owner,signal),store=this.#store(c);let state=await this.#state(c);
   if(JSON.stringify(codexRightsSnapshot(state,owner))!==JSON.stringify(expected))throw Error('bootstrap_rights_changed');
   await this.#fresh(c,owner,signal);
   if(!state){if(signal.aborted)throw Error('bootstrap_cancelled');state=await store.initialize();if(signal.aborted)throw Error('bootstrap_writer_unknown');}
   const binding=state.bindings.find(b=>b.target.project===owner.project&&b.target.peer===owner.peer),rights=scope.rights as Right[];
   const result=binding?await store.reconnect({alias:binding.alias,previousTarget:binding.target,target:owner,rights,expiresAt:scope.until},selected.current,state.revision,signal)
    :await store.connect({alias:owner.project+':'+owner.peer,target:owner,rights,expiresAt:scope.until},selected.current,state.revision,signal);
   if(signal.aborted)throw Error('bootstrap_writer_unknown');await this.#fresh(c,owner,signal);
   return codexRightsSnapshot(result,owner);
  }finally{this.#writing.delete(context);}
 }
 pendingCount(context?:string){for(const [id,p]of this.#pending)if((!p.running||p.outcome)&&p.expires<=this.#mono())this.#pending.delete(id);return context===undefined?this.#pending.size:[...this.#pending.values()].filter(p=>p.context===context).length;}
 #capacity(c:ConversationKey){const other=this.options.pendingBudget?.(namespaceKey(c))??{total:0,context:0};return this.pendingCount()+other.total>=64||this.pendingCount(namespaceKey(c))+other.context>=16;}
 async prepare(c:ConversationKey,a:any,signal=new AbortController().signal){
  if(this.#capacity(c))return failure('bootstrap_capacity');this.observe(c);
  try{
   await this.#published(c,signal);
   const selected=await this.#fresh(c,a.target,signal),link=await this.#link(clone(c),selected.target,signal),state=await this.#state(c);
   const binding=state?.bindings.find(b=>b.target.project===a.target.project&&b.target.peer===a.target.peer);
   const until=this.#now()+(a.durationHours??12)*3600000,rights=[...(a.rights??binding?.rights??['read'])];
   const result=await link.request('prepare',{until,rights},signal);
   if(result?.status==='prepared'&&uuid(result.proposalId)){
    if(this.#capacity(c))return failure('bootstrap_capacity');
    this.#pending.set(result.proposalId,{context:namespaceKey(c),owner:clone(selected.target),expires:this.#mono()+300000,link});
   }
   return {...clone(result),target:clone(selected.target),source:'native_pi_bootstrap',humanProvenance:'pending_native_pi_confirmation',delivery:'not_attempted'};
  }catch{return failure('bootstrap_presence_or_control_unavailable');}
 }
 has(c:ConversationKey,id:string){return this.#pending.get(id)?.context===namespaceKey(c);}
 /** Release the initiating model/tool turn before waiting for that same chat's
  * terminal probe ACK. A handoff receipt never proves consent or effects. The
  * normal MCP signal survives successful response; cancellation before handoff
  * and producer shutdown still cancel the scoped operation. */
 async beginCommit(c:ConversationKey,id:string,signal=new AbortController().signal){
  const p=this.#pending.get(id);if(!p||p.context!==namespaceKey(c)||p.expires<=this.#mono())throw Error('bootstrap_proposal_unavailable');if(signal.aborted||this.#stop.signal.aborted)throw Error('bootstrap_cancelled');
  if(p.outcome)return {...clone(p.outcome),cachedPreviousCommit:true,delivery:'not_established_by_receipt'};
  if(!p.running)void this.commit(c,id,signal).catch(()=>{});
  return {status:'pending',proposalId:id,source:'native_pi_bootstrap',humanProvenance:'not_established_by_handoff',activation:'not_established_by_handoff',rightsCommitted:'not_established_by_handoff',delivery:'not_established_by_handoff',startsDaemon:false,grantsApproveAutomatically:false};
 }
 async commit(c:ConversationKey,id:string,signal=new AbortController().signal){
  const p=this.#pending.get(id);if(!p||p.context!==namespaceKey(c)||p.expires<=this.#mono())throw Error('bootstrap_proposal_unavailable');
  if(p.outcome)return clone(p.outcome);if(p.running)return p.running.then(clone);
  p.running=Promise.resolve().then(async()=>{try{await this.#fresh(c,p.owner,signal);p.outcome=await p.link.request('commit',{proposalId:id},signal);}catch{p.outcome={status:'failed_or_unknown',reason:'bootstrap_control_lost',replayAllowed:false,activation:'unknown'};}return clone(p.outcome);});return p.running.then(clone);
 }
 async status(c:ConversationKey,owner:TargetEpoch,signal=new AbortController().signal){
  const link=this.#links.get(this.#linkKey(c,owner));if(!link||link.signal.aborted)return failure('bootstrap_presence_unavailable');
  try{return await link.request('status',{},signal);}catch{return failure('bootstrap_control_unavailable');}
 }
 stop(){this.#stop.abort();clearInterval(this.#timer);for(const l of this.#links.values())l.stop();this.#links.clear();const contexts=[...this.#contexts.values()];this.#contexts.clear();if(this.options.presence)void Promise.allSettled(contexts.map(c=>c.publishing)).then(()=>Promise.allSettled(contexts.map(c=>this.options.presence!.remove(c.observation))));}
}
