import {randomUUID} from 'node:crypto';
import {namespaceKey} from './fleet-codex-namespace.ts';
export {namespaceKey};
import type {Socket} from 'node:net';
import type {ConversationKey,TargetEpoch} from '../../agent-fleet/scripts/lib/fleet-codex-allowlist.ts';

const MAX_FRAME=32768,MAX_LINKS=32,MAX_PENDING=8,TTL=600000;
const object=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const own=(v:unknown,keys:string[]):v is Record<string,any>=>object(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const targetKey=(v:TargetEpoch)=>JSON.stringify([v.project,v.peer,v.sessionId,v.startedAt]);
const sameOwner=(a:unknown,b:TargetEpoch)=>own(a,['project','peer','sessionId','startedAt'])&&['project','peer','sessionId','startedAt'].every(k=>a[k]===b[k as keyof TargetEpoch]);
export const bootstrapNamespace=(v:unknown):v is ConversationKey=>own(v,['hostProfile','principal','threadId'])&&uuid(v.threadId)&&['hostProfile','principal'].every(k=>typeof v[k]==='string'&&/^[A-Za-z0-9._-]{1,128}$/.test(v[k]));
export type BootstrapPresence={namespace:ConversationKey;hostInstance:string;protocolVersion:string;clientInfo:{name:string;version:string}|null;catalog:string[]};
function presence(v:unknown):v is BootstrapPresence{
 return own(v,['namespace','hostInstance','protocolVersion','clientInfo','catalog'])&&bootstrapNamespace(v.namespace)&&uuid(v.hostInstance)
  &&v.protocolVersion==='2025-06-18'&&(v.clientInfo===null||own(v.clientInfo,['name','version'])&&['name','version'].every(k=>typeof v.clientInfo[k]==='string'&&v.clientInfo[k].length>=1&&v.clientInfo[k].length<=256&&!/[\u0000-\u001f\u007f]/.test(v.clientInfo[k])))
  &&Array.isArray(v.catalog)&&v.catalog.length<=128&&Array.from(v.catalog).every(x=>typeof x==='string'&&/^[A-Za-z0-9._-]{1,128}$/.test(x))&&new Set(v.catalog).size===v.catalog.length;
}
function fault(code:string):Error{return Error('bootstrap_channel_'+code);}
function send(socket:Socket,value:unknown){const frame=JSON.stringify(value)+'\n';if(socket.destroyed||Buffer.byteLength(frame)>MAX_FRAME||socket.writableLength>MAX_FRAME*2)throw fault('unavailable');socket.write(frame);}
type Waiter={resolve:(v:any)=>void;reject:(e:Error)=>void;dispose:()=>void};
type Link={socket:Socket;owner:TargetEpoch;observation:BootstrapPresence;token:string;until:number;monoUntil:number;freshUntil:number;freshMonoUntil:number;observedAt:number;timer:ReturnType<typeof setTimeout>;abort:AbortController;pending:Map<string,Waiter>;calls:Map<string,AbortController>;used:Set<string>};

/** Owner/namespace-bound cooperative channel. Presence is OBSERVATION ONLY, not
 * Desktop identity, a loaded-consumer attestation, no-load proof, or consent.
 * The AF side has no policy-store import/mutation. Only a trusted coordinator
 * may invoke writeRights after its native Pi confirmation. No retry/replay. */
export class BootstrapChannelServer {
 readonly #links=new Map<string,Link>();#stopped=false;
 private readonly options:{owner:()=>TargetEpoch|null;request:(operation:'prepare'|'commit'|'status',payload:any,signal:AbortSignal)=>Promise<unknown>;onDisconnect?:(c:ConversationKey)=>void;acceptNamespace?:(c:ConversationKey)=>boolean;now?:()=>number;monotonic?:()=>number};
 constructor(options:BootstrapChannelServer['options']){this.options={...options};}
 #now(){return (this.options.now??Date.now)();} #mono(){return (this.options.monotonic??(()=>performance.now()))();}
 #current(link:Link){const owner=this.options.owner();return !this.#stopped&&!link.abort.signal.aborted&&!link.socket.destroyed&&!!owner&&targetKey(owner)===targetKey(link.owner)&&this.#now()<link.until&&this.#mono()<link.monoUntil;}
 #reply(link:Link,id:string,body:unknown){send(link.socket,{type:'connection_response',version:1,msg_id:id,owner:link.owner,bootstrap:body});}
 #drop(link:Link){if(link.abort.signal.aborted)return;link.abort.abort();clearTimeout(link.timer);const key=namespaceKey(link.observation.namespace);if(this.#links.get(key)===link)this.#links.delete(key);for(const p of link.pending.values()){p.dispose();p.reject(fault('unknown'));}link.pending.clear();for(const c of link.calls.values())c.abort();link.calls.clear();link.socket.destroy();try{this.options.onDisconnect?.(structuredClone(link.observation.namespace));}catch{}}
 #fresh(link:Link){return this.#current(link)&&this.#now()<link.freshUntil&&this.#mono()<link.freshMonoUntil;}
 #schedule(link:Link){clearTimeout(link.timer);link.timer=setTimeout(()=>{if(this.#current(link))this.#schedule(link);else this.#drop(link);},Math.max(1,Math.min(TTL,link.until-this.#now(),link.monoUntil-this.#mono())));link.timer.unref?.();}
 observation(c:ConversationKey):BootstrapPresence|null{const link=this.#links.get(namespaceKey(c));return link&&this.#fresh(link)?structuredClone(link.observation):null;}
 /** Existing confirmed lease can retain its live process-bound transport after
  * discovery presence ages out. This does NOT authorize a new grant/renewal. */
 leaseObservation(c:ConversationKey):BootstrapPresence|null{const link=this.#links.get(namespaceKey(c));return link&&this.#current(link)?structuredClone(link.observation):null;}
 observations(){return [...this.#links.values()].filter(l=>this.#fresh(l)).map(l=>structuredClone(l.observation));}
 /** Explicit COMS handoff after its first envelope. This reader owns all later
  * frames, including bytes already received with attach. Other COMS protocols
  * never enter this stream; every frame still passes handle's scope guards. */
 handleStream(socket:Socket,envelope:any,buffered:Buffer):boolean{
  if(envelope?.type!=='connection_request'||envelope.operation!=='bootstrap_channel')return false;
  if(envelope.payload?.kind!=='attach'||!Buffer.isBuffer(buffered)){socket.destroy();return true;}
  this.handle(socket,envelope);if(socket.destroyed)return true;
  let pending=Buffer.alloc(0);
  const onData=(chunk:Buffer)=>{
   let offset=0;
   while(offset<chunk.length&&!socket.destroyed){
    const end=chunk.indexOf(10,offset),stop=end<0?chunk.length:end,part=chunk.subarray(offset,stop);
    if(pending.length+part.length>MAX_FRAME){socket.destroy();return;}
    pending=Buffer.concat([pending,part]);offset=end<0?chunk.length:end+1;
    if(end<0)return;
    const line=pending;pending=Buffer.alloc(0);
    try{const frame=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(line));if(!this.handle(socket,frame)){socket.destroy();return;}}
    catch{socket.destroy();return;}
   }
  };
  socket.on('data',onData);socket.once('close',()=>{socket.removeListener('data',onData);pending=Buffer.alloc(0);});
  if(buffered.length)onData(buffered);return true;
 }
 handle(socket:Socket,envelope:any):boolean{
  if(envelope?.type!=='connection_request'||envelope.operation!=='bootstrap_channel')return false;
  const owner=this.options.owner(),p=envelope.payload;
  if(!owner||!sameOwner(envelope.owner,owner)||envelope.version!==1||!uuid(envelope.msg_id)||!object(p)||Buffer.byteLength(JSON.stringify(envelope))>MAX_FRAME||this.#stopped){socket.destroy();return true;}
  if(p.kind==='attach'){
   if(!own(p,['kind','observation','observedAt'])||!Number.isSafeInteger(p.observedAt)||p.observedAt>this.#now()+1000||this.#now()-p.observedAt>=TTL||!presence(p.observation)||this.options.acceptNamespace&&!this.options.acceptNamespace(p.observation.namespace)){socket.destroy();return true;}
   for(const link of this.#links.values())if(!this.#current(link))this.#drop(link);
   const key=namespaceKey(p.observation.namespace);
   // Never replace a live writer implicitly, even with another host instance.
   if(this.#links.has(key)||[...this.#links.values()].some(l=>l.socket===socket)||this.#links.size>=MAX_LINKS){socket.destroy();return true;}
   const link:Link={socket,owner:structuredClone(owner),observation:structuredClone(p.observation),token:randomUUID(),until:this.#now()+TTL,monoUntil:this.#mono()+TTL,freshUntil:p.observedAt+TTL,freshMonoUntil:this.#mono()+Math.max(0,TTL-(this.#now()-p.observedAt)),observedAt:p.observedAt,timer:undefined as any,abort:new AbortController(),pending:new Map(),calls:new Map(),used:new Set()};
   this.#schedule(link);this.#links.set(key,link);socket.once('close',()=>this.#drop(link));socket.once('error',()=>this.#drop(link));
   try{this.#reply(link,envelope.msg_id,{kind:'attached',token:link.token,expiresInSeconds:TTL/1000,identity:'not_attested',readiness:'not_established'});}catch{this.#drop(link);}return true;
  }
  const link=[...this.#links.values()].find(l=>l.socket===socket);
  if(!link||!this.#current(link)||p.token!==link.token){if(link)this.#drop(link);else socket.destroy();return true;}
  if(p.kind==='refresh'&&own(p,['kind','token','observation','observedAt'])&&presence(p.observation)&&Number.isSafeInteger(p.observedAt)&&p.observedAt>=link.observedAt&&p.observedAt<=this.#now()+1000&&this.#now()-p.observedAt<TTL&&namespaceKey(p.observation.namespace)===namespaceKey(link.observation.namespace)&&p.observation.hostInstance===link.observation.hostInstance&&p.observation.protocolVersion===link.observation.protocolVersion&&JSON.stringify(p.observation.clientInfo)===JSON.stringify(link.observation.clientInfo)){
   link.observation=structuredClone(p.observation);link.observedAt=p.observedAt;link.freshUntil=p.observedAt+TTL;link.freshMonoUntil=this.#mono()+Math.max(0,TTL-(this.#now()-p.observedAt));link.until=Math.max(link.until,link.freshUntil);link.monoUntil=Math.max(link.monoUntil,link.freshMonoUntil);this.#schedule(link);return true;
  }
  if(p.kind==='reply'&&own(p,['kind','token','result'])){const waiter=link.pending.get(envelope.msg_id);if(!waiter){this.#drop(link);return true;}link.pending.delete(envelope.msg_id);waiter.dispose();waiter.resolve(structuredClone(p.result));return true;}
  if(p.kind==='cancel'&&own(p,['kind','token','requestId'])&&uuid(p.requestId)){link.calls.get(p.requestId)?.abort();return true;}
  if(p.kind!=='request'||!own(p,['kind','token','operation','payload'])||!['prepare','commit','status'].includes(p.operation)||link.calls.size>=MAX_PENDING||link.used.has(envelope.msg_id)){this.#drop(link);return true;}
  const controller=new AbortController();link.calls.set(envelope.msg_id,controller);if(link.used.size>=256)link.used.delete(link.used.values().next().value!);link.used.add(envelope.msg_id);
  // Scope is from the attached native context, never a model-supplied namespace.
  const payload=object(p.payload)?{...structuredClone(p.payload),namespace:structuredClone(link.observation.namespace)}:null;
  void(async()=>{try{if(!payload)throw fault('invalid');const result=await this.options.request(p.operation,payload,controller.signal);if(!this.#current(link)||controller.signal.aborted)return;this.#reply(link,envelope.msg_id,{kind:'result',token:link.token,result});}catch{if(this.#current(link)&&!controller.signal.aborted)try{this.#reply(link,envelope.msg_id,{kind:'result',token:link.token,result:{status:'failed_or_unknown',reason:'bootstrap_unavailable',replayAllowed:false}});}catch{this.#drop(link);}}finally{link.calls.delete(envelope.msg_id);}})();
  return true;
 }
 async writeRights(c:ConversationKey,command:unknown,signal:AbortSignal):Promise<any>{
  const link=this.#links.get(namespaceKey(c));if(!link||!this.#fresh(link)||signal.aborted||link.pending.size>=MAX_PENDING)throw fault('unavailable');
  const id=randomUUID();const result:any=await new Promise((resolve,reject)=>{
   const finish=(error:Error)=>{if(!link.pending.delete(id))return;dispose();reject(error);this.#drop(link);};
   const abort=()=>finish(fault('unknown')),timer=setTimeout(()=>finish(fault('unknown')),4500);
   const dispose=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);};link.pending.set(id,{resolve,reject,dispose});signal.addEventListener('abort',abort,{once:true});
   try{this.#reply(link,id,{kind:'write_rights',token:link.token,namespace:structuredClone(c),command:structuredClone(command)});}catch{finish(fault('unknown'));}
   if(signal.aborted)abort();
  });
  if(object(command)&&object(command.scope)&&result?.status==='active'&&result.expiresAt===command.scope.until&&Number.isSafeInteger(result.expiresAt)&&result.expiresAt>this.#now()&&result.expiresAt-this.#now()<=720*3600000&&this.#current(link)){
   link.until=Math.max(link.until,result.expiresAt);link.monoUntil=Math.max(link.monoUntil,this.#mono()+result.expiresAt-this.#now());this.#schedule(link);
  }
  return result;
 }
 reset(){for(const link of this.#links.values())this.#drop(link);}
 stop(){this.#stopped=true;for(const l of [...this.#links.values()])this.#drop(l);}
}

/** Native Codex side only. Carries server-authorized rights requests to its
 * injected singleton writer; public model calls cannot invoke that callback. */
export class BootstrapChannelClient {
 readonly #owner:TargetEpoch;readonly #observation:BootstrapPresence;readonly #abort=new AbortController();readonly #pending=new Map<string,Waiter>();readonly #writes=new Set<string>();
 #token:string|null=null;#buffer=Buffer.alloc(0);#writing=false;#timer:ReturnType<typeof setTimeout>;#until=Date.now()+TTL;#monoUntil=performance.now()+TTL;readonly #ready:Promise<void>;readonly #externalAbort=()=>this.stop();
 private readonly options:{socket:Socket;owner:TargetEpoch;observation:BootstrapPresence;writeRights:(command:any,signal:AbortSignal)=>Promise<unknown>;signal?:AbortSignal;observedAt?:number};
 constructor(options:BootstrapChannelClient['options']){
  if(!presence(options.observation))throw fault('invalid');this.options={...options};this.#owner=structuredClone(options.owner);this.#observation=structuredClone(options.observation);
  this.#timer=setTimeout(()=>this.stop(),TTL);this.#timer.unref?.();options.signal?.addEventListener('abort',this.#externalAbort,{once:true});
  const socket=options.socket;socket.on('data',(chunk:Buffer)=>this.#data(chunk));socket.once('error',()=>this.stop());socket.once('close',()=>this.stop());
  this.#ready=this.#wait('attach',{kind:'attach',observation:this.#observation,observedAt:options.observedAt??Date.now()},1500).then(r=>{if(r.kind!=='attached'||!uuid(r.token))throw fault('invalid');this.#token=r.token;}).catch(e=>{this.stop();throw e;});
  // A producer may be retained before a caller awaits ready; no unhandled reject.
  void this.#ready.catch(()=>{});if(options.signal?.aborted)this.stop();
 }
 get signal(){return this.#abort.signal;}
 ready(){return this.#ready;}
 #schedule(){clearTimeout(this.#timer);this.#timer=setTimeout(()=>{if(Date.now()>=this.#until||performance.now()>=this.#monoUntil)this.stop();else this.#schedule();},Math.max(1,Math.min(TTL,this.#until-Date.now(),this.#monoUntil-performance.now())));this.#timer.unref?.();}
 async refresh(observation:BootstrapPresence,observedAt:number){await this.ready();if(!presence(observation)||namespaceKey(observation.namespace)!==namespaceKey(this.#observation.namespace)||observation.hostInstance!==this.#observation.hostInstance)throw fault('invalid');this.#send(randomUUID(),{kind:'refresh',token:this.#token,observation:structuredClone(observation),observedAt});this.#until=Math.max(this.#until,observedAt+TTL);this.#monoUntil=Math.max(this.#monoUntil,performance.now()+Math.max(0,TTL-(Date.now()-observedAt)));this.#schedule();}
 #send(id:string,payload:unknown){send(this.options.socket,{type:'connection_request',version:1,msg_id:id,owner:this.#owner,operation:'bootstrap_channel',payload,sender_session:'local-codex-bootstrap',sender_endpoint:'',hops:0,timestamp:new Date().toISOString()});}
 #wait(_operation:string,payload:unknown,timeout:number,signal?:AbortSignal):Promise<any>{
  if(this.#abort.signal.aborted||signal?.aborted||this.#pending.size>=MAX_PENDING)throw fault('unavailable');const id=randomUUID();
  return new Promise((resolve,reject)=>{const abort=()=>{if(!this.#pending.delete(id))return;dispose();try{if(this.#token)this.#send(randomUUID(),{kind:'cancel',token:this.#token,requestId:id});}catch{}reject(fault('unknown'));this.stop();};const timer=setTimeout(abort,timeout);const dispose=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);};this.#pending.set(id,{resolve,reject,dispose});signal?.addEventListener('abort',abort,{once:true});try{this.#send(id,payload);}catch{abort();}if(signal?.aborted)abort();});
 }
 async request(operation:'prepare'|'commit'|'status',payload:object,signal?:AbortSignal){await this.ready();const r=await this.#wait(operation,{kind:'request',token:this.#token,operation,payload:structuredClone(payload)},operation==='commit'?240000:35000,signal);if(r.kind!=='result'||r.token!==this.#token){this.stop();throw fault('invalid');}return structuredClone(r.result);}
 #data(chunk:Buffer){
  if(this.#abort.signal.aborted)return;
  try{let bytes=Buffer.concat([this.#buffer,chunk]),end:number;while((end=bytes.indexOf(10))>=0){if(end>MAX_FRAME)throw fault('invalid');const frame=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,end)));bytes=bytes.subarray(end+1);if(!object(frame)||frame.type!=='connection_response'||frame.version!==1||!uuid(frame.msg_id)||!sameOwner(frame.owner,this.#owner)||!object(frame.bootstrap))throw fault('invalid');const body=frame.bootstrap,waiter=this.#pending.get(frame.msg_id);
    if(waiter){if(!this.#token&&body.kind==='attached'&&uuid(body.token))this.#token=body.token;this.#pending.delete(frame.msg_id);waiter.dispose();waiter.resolve(body);continue;}
    if(!this.#token||body.kind!=='write_rights'||body.token!==this.#token||!bootstrapNamespace(body.namespace)||namespaceKey(body.namespace)!==namespaceKey(this.#observation.namespace)||this.#writing||this.#writes.has(frame.msg_id))throw fault('invalid');
    if(this.#writes.size>=32)this.#writes.delete(this.#writes.values().next().value!);this.#writes.add(frame.msg_id);this.#writing=true;const command=structuredClone(body.command);
    void(async()=>{try{const result:any=await this.options.writeRights(command,this.#abort.signal);if(result?.status==='active'&&Number.isSafeInteger(result.expiresAt)&&result.expiresAt>Date.now()&&result.expiresAt-Date.now()<=720*3600000){this.#until=Math.max(this.#until,result.expiresAt);this.#monoUntil=Math.max(this.#monoUntil,performance.now()+result.expiresAt-Date.now());this.#schedule();}if(!this.#abort.signal.aborted)this.#send(frame.msg_id,{kind:'reply',token:this.#token,result});}catch{if(!this.#abort.signal.aborted)try{this.#send(frame.msg_id,{kind:'reply',token:this.#token,result:{status:'unknown',reason:'codex_writer_failed_or_uncertain'}});}catch{this.stop();}}finally{this.#writing=false;}})();
   }if(bytes.length>MAX_FRAME)throw fault('invalid');this.#buffer=Buffer.from(bytes);
  }catch{this.stop();}
 }
 stop(){if(this.#abort.signal.aborted)return;this.#abort.abort();clearTimeout(this.#timer);this.options.signal?.removeEventListener('abort',this.#externalAbort);this.options.socket.destroy();for(const p of this.#pending.values()){p.dispose();p.reject(fault('unknown'));}this.#pending.clear();}
}
