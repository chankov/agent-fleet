import {createHash,randomUUID} from 'node:crypto';
import {opendir,lstat,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {namespaceKey,bootstrapNamespace,type BootstrapPresence} from '../../../harnesses/lib/fleet-bootstrap-channel.ts';
import type {ConversationKey,TargetEpoch} from './fleet-codex-allowlist.ts';
import {validInstructionTarget} from '../../../harnesses/lib/fleet-target-identity.ts';
import {privateDirectory,readPrivateJson,writePrivateJson,privateFileIdentity,canonicalPrivatePath} from './codex-bootstrap-files.ts';
const TTL=600000,uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const object=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
export type NativePresence={schema:'fleet-native-presence/v1';observation:BootstrapPresence;observedAt:number};
export type NativeAttachRequest={schema:'fleet-native-attach-request/v1';id:string;namespace:ConversationKey;hostInstance:string;owner:TargetEpoch;createdAt:number};
const hash=(c:ConversationKey)=>createHash('sha256').update(namespaceKey(c)).digest('hex');
export function validNativeObservation(v:unknown):v is BootstrapPresence{return object(v)&&Object.keys(v).sort().join(',')==='catalog,clientInfo,hostInstance,namespace,protocolVersion'&&bootstrapNamespace(v.namespace)&&uuid(v.hostInstance)&&v.protocolVersion==='2025-06-18'&&(v.clientInfo===null||object(v.clientInfo)&&Object.keys(v.clientInfo).sort().join(',')==='name,version'&&typeof v.clientInfo.name==='string'&&typeof v.clientInfo.version==='string'&&[v.clientInfo.name,v.clientInfo.version].every(x=>x.length>=1&&x.length<=256&&!/[\u0000-\u001f\u007f]/.test(x)))&&Array.isArray(v.catalog)&&v.catalog.length<=128&&Array.from(v.catalog).every(x=>typeof x==='string'&&/^[A-Za-z0-9._-]{1,128}$/.test(x))&&new Set(v.catalog).size===v.catalog.length;}
/** Private metadata rendezvous, not policy/config/consent. No new listener or
 * broadcast to unrelated AF projects. Native publishes only observed context;
 * AF may ask its exact owner to attach, but only a later Pi-confirmed coordinator
 * command can reach the Codex writer. No directory repair/foreign file cleanup. */
export class NativePresenceDirectory {
 readonly root:string;readonly #now:()=>number;readonly #issued=new Map<string,{path:string;identity:string}>();
 constructor(root:string,now=Date.now){if(!canonicalPrivatePath(root))throw Error('native_presence_root');this.root=root;this.#now=now;}
 #time(){const now=this.#now();if(!Number.isSafeInteger(now)||now<0)throw Error('native_presence_clock');return now;}
 #path(o:BootstrapPresence){return join(this.root,'presence-'+hash(o.namespace)+'-'+o.hostInstance+'.json');}
 async publish(value:BootstrapPresence,signal?:AbortSignal){
  const seen=structuredClone(value);if(!validNativeObservation(seen))throw Error('native_presence_invalid');const record:NativePresence={schema:'fleet-native-presence/v1',observation:seen,observedAt:this.#time()};
  await writePrivateJson(this.#path(seen),record,{signal,createParent:true});return structuredClone(record);
 }
 async #files(prefix:'presence-'|'request-',signal?:AbortSignal){
  try{await privateDirectory(this.root);}catch(e){if((e as any)?.code==='ENOENT')return [];throw e;}
  const dir=await opendir(this.root),files:{name:string;value:any;identity:string}[]=[];let count=0,total=0;
  try{for await(const entry of dir){if(signal?.aborted)throw Error('native_presence_cancelled');if(++count>128)throw Error('native_presence_limit');if(!entry.name.startsWith(prefix)||!entry.name.endsWith('.json'))continue;
   let at:Awaited<ReturnType<typeof readPrivateJson>>;try{at=await readPrivateJson(join(this.root,entry.name),32768,signal);}catch(e){if(!(e instanceof Error)||e.message!=='bootstrap_file_changed')throw e;at=await readPrivateJson(join(this.root,entry.name),32768,signal);}if(!at)throw Error('native_presence_changed');total+=Buffer.byteLength(JSON.stringify(at.value));if(total>1048576)throw Error('native_presence_limit');files.push({name:entry.name,...at});
  }}finally{try{await dir.close();}catch(e){if((e as any)?.code!=='ERR_DIR_CLOSED')throw e;}}return files;
 }
 async list(signal?:AbortSignal){
  const result:Readonly<NativePresence&{fresh:boolean}>[]=[];const now=this.#time();
  for(const file of await this.#files('presence-',signal)){
   const v=file.value;if(!object(v)||Object.keys(v).sort().join(',')!=='observation,observedAt,schema'||v.schema!=='fleet-native-presence/v1'||!validNativeObservation(v.observation)||!Number.isSafeInteger(v.observedAt)||v.observedAt>now+1000||file.name!=='presence-'+hash(v.observation.namespace)+'-'+v.observation.hostInstance+'.json')throw Error('native_presence_invalid');
   result.push({...structuredClone(v as NativePresence),fresh:now-v.observedAt<TTL});
  }return result;
 }
 async requestAttach(seen:NativePresence,owner:TargetEpoch,signal?:AbortSignal){
  const selected={schema:seen.schema,observation:structuredClone(seen.observation),observedAt:seen.observedAt},target=structuredClone(owner),now=this.#time();if(selected.schema!=='fleet-native-presence/v1'||!validNativeObservation(selected.observation)||!validInstructionTarget(target)||!Number.isSafeInteger(selected.observedAt)||now-selected.observedAt>=TTL||selected.observedAt>now+1000)throw Error('native_presence_stale');
  await privateDirectory(this.root);const current=await readPrivateJson(this.#path(selected.observation),32768,signal);if(!current||current.value?.schema!==selected.schema||JSON.stringify(current.value.observation)!==JSON.stringify(selected.observation)||!Number.isSafeInteger(current.value.observedAt)||current.value.observedAt<selected.observedAt||this.#time()-current.value.observedAt>=TTL||current.value.observedAt>this.#time()+1000)throw Error('native_presence_changed');
  const request:NativeAttachRequest={schema:'fleet-native-attach-request/v1',id:randomUUID(),namespace:selected.observation.namespace,hostInstance:selected.observation.hostInstance,owner:target,createdAt:this.#time()};
  const path=join(this.root,'request-'+request.id+'.json');if(this.#issued.size>=32)throw Error('native_presence_request_capacity');const identity=await writePrivateJson(path,request,{signal,expected:null});this.#issued.set(request.id,{path,identity});return request.id;
 }
 async requests(hostInstance:string,signal?:AbortSignal){
  const result:{request:NativeAttachRequest;path:string;identity:string}[]=[];const now=this.#time();
  for(const file of await this.#files('request-',signal)){
   const v=file.value;if(!object(v)||Object.keys(v).sort().join(',')!=='createdAt,hostInstance,id,namespace,owner,schema'||v.schema!=='fleet-native-attach-request/v1'||!uuid(v.id)||!uuid(v.hostInstance)||!bootstrapNamespace(v.namespace)||!validInstructionTarget(v.owner)||!Number.isSafeInteger(v.createdAt)||v.createdAt>now+1000||file.name!=='request-'+v.id+'.json')throw Error('native_presence_request_invalid');
   if(now-v.createdAt>=5000){await this.consume(join(this.root,file.name),file.identity).catch(()=>{});continue;}
   if(v.hostInstance===hostInstance)result.push({request:structuredClone(v as NativeAttachRequest),path:join(this.root,file.name),identity:file.identity});
  }return result;
 }
 async consume(path:string,expected:string){
  if(!path.startsWith(this.root+'/')||!/^request-[a-f0-9-]{36}\.json$/.test(path.slice(this.root.length+1)))throw Error('native_presence_path');
  const current=await lstat(path);if(privateFileIdentity(current)!==expected)throw Error('native_presence_changed');await unlink(path);
 }
 async cancelAttach(id:string){const issued=this.#issued.get(id);if(!issued)return;this.#issued.delete(id);try{await this.consume(issued.path,issued.identity);}catch(e){if((e as any)?.code!=='ENOENT')throw e;}}
 async remove(observed:BootstrapPresence){const path=this.#path(observed),old=await readPrivateJson(path);if(!old)return;if(old.value?.observation?.hostInstance!==observed.hostInstance)throw Error('native_presence_changed');const at=await lstat(path);if(privateFileIdentity(at)!==old.identity)throw Error('native_presence_changed');await unlink(path);}
}
