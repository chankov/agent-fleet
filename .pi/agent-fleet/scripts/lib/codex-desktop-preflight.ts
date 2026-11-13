import {createHash} from 'node:crypto';
import {constants,lstatSync,openSync,readSync,closeSync,readlinkSync,type BigIntStats} from 'node:fs';
import {open,lstat,readlink,type FileHandle} from 'node:fs/promises';
import {isAbsolute,resolve,join,dirname} from 'node:path';
import {bootstrapNamespace,namespaceKey,type BootstrapPresence} from '../../../harnesses/lib/fleet-bootstrap-channel.ts';
import {compareCodexVersions} from '../../../harnesses/lib/codex-compat.ts';
import {privateDirectory,writePrivateJson} from './codex-bootstrap-files.ts';
import {readDesktopPackageVersion,desktopPackageCurrent,type DesktopPackageEvidence,type AutomaticDesktopData} from './codex-desktop-discovery.ts';
import {validNativeObservation} from './codex-native-presence.ts';

const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const sameNative=(a:BootstrapPresence,b:BootstrapPresence)=>same(a.namespace,b.namespace)&&a.hostInstance===b.hostInstance&&a.protocolVersion===b.protocolVersion&&same(a.clientInfo,b.clientInfo);
const identity=(s:BigIntStats)=>[s.dev,s.ino,s.uid,s.mode,s.size,s.mtimeNs,s.ctimeNs].join(':');
const plain=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const own=(v:unknown,keys:string[]):v is Record<string,any>=>plain(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
function normalizeObservation(value:unknown):BootstrapPresence{
 if(!validNativeObservation(value)||!value.clientInfo)throw Error('desktop_preflight_inputs');
 return {namespace:{hostProfile:value.namespace.hostProfile,principal:value.namespace.principal,threadId:value.namespace.threadId},hostInstance:value.hostInstance,protocolVersion:value.protocolVersion,clientInfo:{name:value.clientInfo.name,version:value.clientInfo.version},catalog:[...value.catalog]};
}
const safePath=(v:unknown):v is string=>typeof v==='string'&&v.length<=4096&&isAbsolute(v)&&resolve(v)===v&&!/[\u0000-\u001f\u007f]/.test(v);
const decode=(b:Uint8Array)=>new TextDecoder('utf-8',{fatal:true}).decode(b);
type ProcessIdentity={pid:number;startTicks:string;executable:string;fileIdentity:string;sha256:string};
export type DesktopPreflightRecord={schema:'fleet-desktop-native-mapping/v1';observation:BootstrapPresence;desktop:ProcessIdentity;desktopVersion:string;desktopPackage?:DesktopPackageEvidence;versionSource:'operator_observed_running_desktop_version'|'automatically_observed_desktop_package_version';socketPath:string;codexHome:string;binaryPath:string|null;capturedAt:number;mappingSource:'native_pi_operator_observed_desktop_and_loaded_catalog'|'native_pi_confirmed_automatic_desktop_mapping'|'automatic_desktop_observation_pending_pi_confirmation'};

/** Read-only PID/executable checks plus explicit native Pi operator mapping.
 * This does not discover a Desktop, infer identity/catalog from clientInfo, or
 * mint rights/activation. capture MUST be called only by the native preflight UI
 * after operator verifies the exact Desktop/chat and actual loaded catalog.
 * File is server-owned mapping policy, not consent; every bootstrap reconfirms.
 * Production procRoot is /proc. Tests use only an explicitly injected fake tree. */
export class DesktopPreflightRegistry {
 private readonly root:string;private readonly procRoot:string;private readonly confirm:(review:Readonly<{observation:BootstrapPresence;desktop:ProcessIdentity;desktopVersion:string;socketPath:string;codexHome:string;binaryPath:string|null}>,signal:AbortSignal)=>Promise<boolean>;
 readonly #digests=new Map<string,string>();
 readonly #proofs=new WeakMap<DesktopPreflightRecord,{record:DesktopPreflightRecord;file:string;fileIdentity:string;rootIdentity:string;version?:DesktopPackageEvidence}>();
 readonly #drafts=new WeakMap<DesktopPreflightRecord,{record:DesktopPreflightRecord;version:DesktopPackageEvidence}>();
 constructor(options:{root:string;procRoot?:string;confirm:DesktopPreflightRegistry['confirm']}){if(!safePath(options.root)||!safePath(options.procRoot??'/proc'))throw Error('desktop_preflight_options');this.root=options.root;this.procRoot=options.procRoot??'/proc';this.confirm=options.confirm;}
 #check(signal:AbortSignal,deadline:number){if(signal.aborted||performance.now()>=deadline)throw Error('desktop_preflight_cancelled_or_overdue');}
 async #io<T>(signal:AbortSignal,deadline:number,work:()=>Promise<T>){this.#check(signal,deadline);const v=await work();this.#check(signal,deadline);return v;}
 async #small(path:string,max:number,signal:AbortSignal,deadline:number){const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const buffer=Buffer.alloc(max+1);const {bytesRead}=await this.#io(signal,deadline,()=>file.read(buffer,0,buffer.length,0));if(bytesRead>max)throw Error('desktop_preflight_limit');return buffer.subarray(0,bytesRead);}finally{await file.close();}}
 async #process(pid:number,signal:AbortSignal,deadline:number){
  if(!Number.isSafeInteger(pid)||pid<1||pid>2147483647||typeof process.getuid!=='function')throw Error('desktop_preflight_pid');
  const base=join(this.procRoot,String(pid)),stat=await this.#io(signal,deadline,()=>lstat(base,{bigint:true}));if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==BigInt(process.getuid()))throw Error('desktop_preflight_process_owner');
  const raw=decode(await this.#small(join(base,'stat'),16384,signal,deadline)),end=raw.lastIndexOf(') '),parts=raw.slice(end+2).trim().split(/\s+/);
  if(!raw.startsWith(pid+' (')||end<0||!/^\d{1,32}$/.test(parts[19]??''))throw Error('desktop_preflight_process_invalid');
  const executable=await this.#io(signal,deadline,()=>readlink(join(base,'exe')));if(!safePath(executable))throw Error('desktop_preflight_executable_unavailable');
  return {pid,startTicks:parts[19],executable};
 }
 async #desktop(pid:number,signal:AbortSignal):Promise<ProcessIdentity>{
  const deadline=performance.now()+10000,before=await this.#process(pid,signal,deadline);let file:FileHandle|undefined;
  try{
   const stat=await this.#io(signal,deadline,()=>lstat(before.executable,{bigint:true}));
   if(!stat.isFile()||stat.isSymbolicLink()||(stat.uid!==BigInt(process.getuid!())&&stat.uid!==0n)||(stat.mode&0o022n)!==0n||(stat.mode&0o111n)===0n||stat.size<1n||stat.size>512n*1024n*1024n)throw Error('desktop_preflight_executable_unsafe');
   this.#check(signal,deadline);file=await open(before.executable,constants.O_RDONLY|constants.O_NOFOLLOW);this.#check(signal,deadline);
   const held=await this.#io(signal,deadline,()=>file!.stat({bigint:true}));if(identity(held)!==identity(stat))throw Error('desktop_preflight_executable_changed');
   const key=identity(held)+':'+before.executable;let digest=this.#digests.get(key);
   if(!digest){const hash=createHash('sha256'),buffer=Buffer.alloc(65536);let offset=0;while(offset<Number(held.size)){const result=await this.#io(signal,deadline,()=>file!.read(buffer,0,Math.min(buffer.length,Number(held.size)-offset),offset));if(!result.bytesRead)throw Error('desktop_preflight_executable_changed');hash.update(buffer.subarray(0,result.bytesRead));offset+=result.bytesRead;}digest=hash.digest('hex');}
   if(identity(await this.#io(signal,deadline,()=>file!.stat({bigint:true})))!==identity(held)||identity(await this.#io(signal,deadline,()=>lstat(before.executable,{bigint:true})))!==identity(held)||!same(before,await this.#process(pid,signal,deadline)))throw Error('desktop_preflight_executable_changed');
   await file.close();file=undefined;this.#check(signal,deadline);if(this.#digests.size>=64)this.#digests.delete(this.#digests.keys().next().value!);this.#digests.set(key,digest);
   return {...before,fileIdentity:identity(held),sha256:digest};
  }finally{await file?.close();}
 }
 #file(namespace:BootstrapPresence['namespace']){if(!bootstrapNamespace(namespace))throw Error('desktop_preflight_namespace');return join(this.root,'mapping-'+createHash('sha256').update(namespaceKey(namespace)).digest('hex')+'.json');}
 async #parent(create:boolean){
  try{await privateDirectory(dirname(this.root));await privateDirectory(this.root,create);}catch(e){if((e as Error).message==='bootstrap_directory_unsafe')throw Error('desktop_preflight_root_unsafe');throw e;}
 }
 async capture(observation:BootstrapPresence,options:{desktopPid:number;desktopVersion:string;socketPath:string;codexHome:string;binaryPath?:string},signal:AbortSignal):Promise<DesktopPreflightRecord>{
  const seen=normalizeObservation(observation),selected=structuredClone(options);
  if(!bootstrapNamespace(seen.namespace)||!seen.clientInfo||compareCodexVersions(selected.desktopVersion,selected.desktopVersion)!==0||!safePath(selected.socketPath)||selected.socketPath.length>100||!safePath(selected.codexHome)||selected.binaryPath!==undefined&&!safePath(selected.binaryPath))throw Error('desktop_preflight_inputs');
  const desktop=await this.#desktop(selected.desktopPid,signal),review={observation:seen,desktop,desktopVersion:selected.desktopVersion,socketPath:selected.socketPath,codexHome:selected.codexHome,binaryPath:selected.binaryPath??null};
  if(await this.confirm(structuredClone(review),signal)!==true||signal.aborted)throw Error('desktop_preflight_not_confirmed');
  if(!same(desktop,await this.#desktop(selected.desktopPid,signal)))throw Error('desktop_preflight_changed');
  const record:DesktopPreflightRecord={schema:'fleet-desktop-native-mapping/v1',observation:seen,desktop,desktopVersion:review.desktopVersion,socketPath:review.socketPath,codexHome:review.codexHome,binaryPath:review.binaryPath,versionSource:'operator_observed_running_desktop_version',capturedAt:Date.now(),mappingSource:'native_pi_operator_observed_desktop_and_loaded_catalog'};
  await this.#parent(true);await writePrivateJson(this.#file(seen.namespace),record,{signal});return structuredClone(record);
 }
 /** Process-local draft only: no mapping/consent/admission or filesystem writes. */
 async observeAutomatic(observation:BootstrapPresence,options:AutomaticDesktopData,signal:AbortSignal):Promise<DesktopPreflightRecord>{
  const seen=normalizeObservation(observation),selected=structuredClone(options);
  if(!safePath(selected.socketPath)||selected.socketPath.length>100||!safePath(selected.codexHome)||selected.binaryPath!==undefined&&!safePath(selected.binaryPath))throw Error('desktop_preflight_inputs');
  const desktop=await this.#desktop(selected.desktopPid,signal),version=await readDesktopPackageVersion(desktop.executable,signal);
  if(version.version!==selected.desktopVersion||!same(desktop,await this.#desktop(selected.desktopPid,signal)))throw Error('desktop_preflight_changed');
  const record:DesktopPreflightRecord={schema:'fleet-desktop-native-mapping/v1',observation:seen,desktop,desktopVersion:version.version,desktopPackage:version,versionSource:'automatically_observed_desktop_package_version',socketPath:selected.socketPath,codexHome:selected.codexHome,binaryPath:selected.binaryPath??null,capturedAt:Date.now(),mappingSource:'automatic_desktop_observation_pending_pi_confirmation'};
  this.#drafts.set(record,{record:structuredClone(record),version});return record;
 }
 isAutomaticDraft(record:DesktopPreflightRecord){return this.#drafts.has(record);}
 observedCurrentNow(record:DesktopPreflightRecord,observation:BootstrapPresence){
  const draft=this.#drafts.get(record);return draft?validNativeObservation(observation)&&same(record,draft.record)&&sameNative(record.observation,observation)&&desktopPackageCurrent(draft.version)&&this.#processCurrent(record.desktop):this.currentNow(record,observation);
 }
 identityFingerprint(record:DesktopPreflightRecord){const proof=this.#drafts.get(record)??this.#proofs.get(record);if(!proof||!same(record,proof.record))throw Error('desktop_preflight_changed');return createHash('sha256').update(JSON.stringify([record.desktop,record.desktopVersion,record.socketPath,record.codexHome,record.binaryPath,proof.version?.fileIdentity??null])).digest('hex');}
 /** The callback is the genuine combined native Pi interaction, never a tool boolean. */
 async confirmAutomatic(record:DesktopPreflightRecord,observation:BootstrapPresence,confirm:()=>Promise<boolean>,signal:AbortSignal,scopeCurrent:()=>void=()=>{}):Promise<DesktopPreflightRecord|null>{
  if(!this.#drafts.has(record)||!this.observedCurrentNow(record,observation)||signal.aborted)throw Error('desktop_preflight_changed');
  if(await confirm()!==true||signal.aborted)return null;
  const guard=()=>{scopeCurrent();if(signal.aborted||!this.observedCurrentNow(record,observation))throw Error('desktop_preflight_changed');};guard();
  await privateDirectory(dirname(this.root),true);await this.#parent(true);guard();await writePrivateJson(this.#file(observation.namespace),{...record,mappingSource:'native_pi_confirmed_automatic_desktop_mapping'},{signal,guard});
  const current=await this.current(observation,signal);if(!current)throw Error('bootstrap_file_publication_unknown');try{guard();}catch{throw Error('bootstrap_file_publication_unknown');}this.#drafts.delete(record);return current;
 }
 async current(observation:BootstrapPresence,signal:AbortSignal):Promise<DesktopPreflightRecord|null>{
  const deadline=performance.now()+12000;let file:FileHandle|undefined;
  try{
   const seen=normalizeObservation(observation);
   await this.#parent(false);const path=this.#file(seen.namespace),before=await this.#io(signal,deadline,()=>lstat(path,{bigint:true}));
   if(!before.isFile()||before.isSymbolicLink()||before.uid!==BigInt(process.getuid!())||(before.mode&0o077n)!==0n||before.nlink!==1n||before.size<1n||before.size>32768n)return null;
   file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);const at=await file.stat({bigint:true});if(identity(at)!==identity(before))return null;
   const data=Buffer.alloc(Number(at.size)+1),read=await file.read(data,0,data.length,0);if(read.bytesRead!==Number(at.size)||identity(await file.stat({bigint:true}))!==identity(at))return null;
   const raw=JSON.parse(decode(data.subarray(0,read.bytesRead)));
   if(!own(raw,['schema','observation','desktop','desktopVersion','versionSource','socketPath','codexHome','binaryPath','capturedAt','mappingSource',...(Object.hasOwn(raw,'desktopPackage')?['desktopPackage']:[])])||!own(raw.desktop,['pid','startTicks','executable','fileIdentity','sha256']))return null;
   const record:DesktopPreflightRecord={schema:raw.schema,observation:normalizeObservation(raw.observation),desktop:{pid:raw.desktop.pid,startTicks:raw.desktop.startTicks,executable:raw.desktop.executable,fileIdentity:raw.desktop.fileIdentity,sha256:raw.desktop.sha256},desktopVersion:raw.desktopVersion,...(Object.hasOwn(raw,'desktopPackage')?{desktopPackage:raw.desktopPackage}:{}),versionSource:raw.versionSource,socketPath:raw.socketPath,codexHome:raw.codexHome,binaryPath:raw.binaryPath,capturedAt:raw.capturedAt,mappingSource:raw.mappingSource};
   const automatic=record.mappingSource==='native_pi_confirmed_automatic_desktop_mapping'&&record.versionSource==='automatically_observed_desktop_package_version',manual=record.mappingSource==='native_pi_operator_observed_desktop_and_loaded_catalog'&&record.versionSource==='operator_observed_running_desktop_version';
   if(!plain(record)||record.schema!=='fleet-desktop-native-mapping/v1'||!automatic&&!manual||compareCodexVersions(record.desktopVersion,record.desktopVersion)!==0||!sameNative(record.observation,seen)||!Number.isSafeInteger(record.capturedAt)||record.capturedAt<0||record.capturedAt>Date.now()+1000||!safePath(record.socketPath)||record.socketPath.length>100||!safePath(record.codexHome)||record.binaryPath!==null&&!safePath(record.binaryPath)||!same(record.desktop,await this.#desktop(record.desktop.pid,signal)))return null;
   if(identity(await lstat(path,{bigint:true}))!==identity(at))return null;await file.close();file=undefined;this.#check(signal,deadline);
   if(automatic&&!own(record.desktopPackage,['version','path','fileIdentity'])||manual&&record.desktopPackage!==undefined)return null;
   const version=automatic?await readDesktopPackageVersion(record.desktop.executable,signal):undefined;if(version&&(version.version!==record.desktopVersion||!same(version,record.desktopPackage)))return null;
   const root=await lstat(this.root,{bigint:true}),result=structuredClone(record);this.#check(signal,deadline);this.#proofs.set(result,{record:structuredClone(record),file:path,fileIdentity:identity(at),rootIdentity:[root.dev,root.ino,root.uid,root.mode].join(':'),...(version?{version}:{})});return result;
  }catch{return null;}finally{await file?.close();}
 }
 /** Only a record freshly returned by current() has this process-local proof.
  * Bounded synchronous reads are used immediately before bytes/publication;
  * never called from cached status/render and never infer authority from JSON. */
 currentNow(record:DesktopPreflightRecord,observation:BootstrapPresence):boolean{
  const proof=this.#proofs.get(record);if(!proof||!validNativeObservation(observation)||!same(record,proof.record)||!sameNative(record.observation,observation)||proof.version&&!desktopPackageCurrent(proof.version))return false;
  try{const root=lstatSync(this.root,{bigint:true});return !root.isSymbolicLink()&&[root.dev,root.ino,root.uid,root.mode].join(':')===proof.rootIdentity&&identity(lstatSync(proof.file,{bigint:true}))===proof.fileIdentity&&this.#processCurrent(record.desktop);}catch{return false;}
 }
 #processCurrent(desktop:ProcessIdentity):boolean{
  let fd:number|undefined;
  try{
   const dir=join(this.procRoot,String(desktop.pid)),parent=lstatSync(dir);if(!parent.isDirectory()||parent.isSymbolicLink()||parent.uid!==process.getuid?.()||readlinkSync(join(dir,'exe'))!==desktop.executable||identity(lstatSync(desktop.executable,{bigint:true}))!==desktop.fileIdentity)return false;
   fd=openSync(join(dir,'stat'),constants.O_RDONLY|constants.O_NOFOLLOW);const buffer=Buffer.alloc(16385),size=readSync(fd,buffer,0,buffer.length,0);if(size>16384)return false;const raw=decode(buffer.subarray(0,size)),end=raw.lastIndexOf(') ');return raw.startsWith(desktop.pid+' (')&&end>0&&raw.slice(end+2).trim().split(/\s+/)[19]===desktop.startTicks;
  }catch{return false;}finally{if(fd!==undefined)closeSync(fd);}
 }
}
