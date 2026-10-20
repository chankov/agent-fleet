import {randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {realpathSync} from 'node:fs';
import {resolve} from 'node:path';
import {sourceHash,exportPathAllowed} from '../agentic-sources.ts';
export interface DiscoveryOwner {
 taskId:string;ownerId:string;attemptId:string;cwd:string;task:string;query:string;
 effectiveTools:readonly string[];readRoots:readonly string[];exportRoots:readonly string[];
 initialPaths?:readonly string[];discoveryComplete?:boolean;
 canRead(path:string):boolean;canDisplay(path:string):boolean;permissionIdentity():string;
}
export interface DiscoveryAssignment {endpoint:string;capability:string;sessionId:string;taskId:string;ownerId:string;attemptId:string;queryHash:string}
export interface OwnerLease extends DiscoveryOwner {sessionId:string;capability:string;queryHash:string;signal:AbortSignal;attemptSignal:AbortSignal;expiresAt:number}
export function createDiscoveryOwners(sessionId:string,currentTaskId:()=>string,options:{maxOwners?:number;now?():number;ttlMs?:number;currentContext?():string}={}) {
 const leases=new Map<string,{lease:OwnerLease;controller:AbortController;attemptController:AbortController;timer:ReturnType<typeof setTimeout>;requests:Set<string>;context:string}>();
 const parents=new Map<string,string>(),launches=new Map<string,Map<string,{identity:string;attempts:number;capability:string}>>();
 const now=options.now??Date.now;let closed=false;
 // Advisory expiry fences inference only. Retain the physical attempt until exit or
 // authoritative revocation so a later task switch/dispose can still terminate it.
 const expire=(capability:string)=>{const row=leases.get(capability);if(!row)return;row.controller.abort();clearTimeout(row.timer);for(const [child,parent]of parents)if(parent===capability)expire(child);};
 const revoke=(capability:string)=>{const row=leases.get(capability);if(!row)return;expire(capability);for(const [child,parent]of parents)if(parent===capability)revoke(child);row.attemptController.abort();leases.delete(capability);parents.delete(capability);launches.delete(capability);};
 const active=(lease:OwnerLease)=>!closed&&lease.sessionId===sessionId&&lease.taskId===currentTaskId();
 const fresh=(lease:OwnerLease)=>!closed&&!lease.signal.aborted&&lease.sessionId===sessionId&&lease.taskId===currentTaskId()&&lease.expiresAt>now()&&leases.get(lease.capability)?.context===(options.currentContext?.()??currentTaskId());
 return {
 admitted(owner:Pick<DiscoveryOwner,'taskId'>){return !closed&&owner.taskId===currentTaskId();},
 register(owner:DiscoveryOwner,ttlMs=options.ttlMs??1200000):OwnerLease {
  if(closed||owner.taskId!==currentTaskId()||!owner.task.trim()||!owner.query.trim()||![sessionId,owner.taskId,owner.ownerId,owner.attemptId].every(v=>typeof v==='string'&&v.length>0&&v.length<=128)||leases.size>=(options.maxOwners??128)||!Number.isSafeInteger(ttlMs)||ttlMs<1||ttlMs>3600000)throw Error('owner_registration_denied');
  if([...leases.values()].some(({lease})=>lease.ownerId===owner.ownerId&&lease.attemptId===owner.attemptId))throw Error('attempt_already_registered');
  const capability=randomBytes(32).toString('hex'),controller=new AbortController(),attemptController=new AbortController();
  const lease:OwnerLease=Object.freeze({...owner,cwd:realpathSync(owner.cwd),effectiveTools:Object.freeze([...owner.effectiveTools]),readRoots:Object.freeze([...owner.readRoots]),exportRoots:Object.freeze([...owner.exportRoots]),initialPaths:Object.freeze([...(owner.initialPaths??[])]),sessionId,capability,queryHash:sourceHash(owner.query),signal:controller.signal,attemptSignal:attemptController.signal,expiresAt:now()+ttlMs});
  const timer=setTimeout(()=>expire(capability),ttlMs);timer.unref();leases.set(capability,{lease,controller,attemptController,timer,requests:new Set(),context:options.currentContext?.()??currentTaskId()});return lease;
 },
 authorize(request:{capability:string;sessionId:string;taskId:string;ownerId:string;attemptId:string;queryHash:string;requestId:string},requireRead=true,allowExpiredRevocation=false):OwnerLease|null {
  // Compare opaque credentials without publishing them or treating child identity as authority.
  const row=leases.get(request.capability);if(!row)return null;
  const a=Buffer.from(request.capability),b=Buffer.from(row.lease.capability);
  if(a.length!==b.length||!timingSafeEqual(a,b))return null;
  const lease=row.lease;
  if(!active(lease)){revoke(lease.capability);return null;}
  if(!fresh(lease)){expire(lease.capability);if(!allowExpiredRevocation)return null;}
  if(['sessionId','taskId','ownerId','attemptId','queryHash'].some(k=>(request as any)[k]!== (lease as any)[k])||row.requests.has(request.requestId)||row.requests.size>=1024)return null;
  if(requireRead&&!lease.effectiveTools.some(t=>t==='read'||t==='filesystem'))return null;
  row.requests.add(request.requestId);return lease;
 },
 registerDescendant(parent:OwnerLease,input:{childId:string;task:string;query:string;tools:readonly string[]}):OwnerLease {
  // The delegate runtime owns role/depth/concurrency admission. This channel
  // cannot spawn: it only narrows an authenticated, already allowed attempt.
  if(!this.current(parent)||!parent.effectiveTools.includes('delegate')||parents.has(parent.capability)||!/^([a-z0-9]+(?:-[a-z0-9]+)*)-[1-4]$/.test(input.childId)||!input.task.trim()||!input.query.trim()||input.task.length>16384||input.query.length>32768||!input.tools.length||input.tools.some(t=>t==='delegate'||!parent.effectiveTools.includes(t)))throw Error('descendant_registration_denied');
  const tree=launches.get(parent.capability)??new Map(),identity=JSON.stringify([input.task,input.query,input.tools]);
  const previous=tree.get(input.childId);
  if(previous&&(previous.identity!==identity||previous.attempts>=2||leases.has(previous.capability))||!previous&&tree.size>=4)throw Error('descendant_registration_denied');
  const lease=this.register({...parent,ownerId:randomUUID(),attemptId:randomUUID(),task:input.task,query:input.query,effectiveTools:input.tools,
   canRead:p=>fresh(parent)&&parent.canRead(p),canDisplay:p=>fresh(parent)&&parent.canDisplay(p),permissionIdentity:()=>parent.permissionIdentity()},Math.max(1,Math.floor(parent.expiresAt-now())));
  parents.set(lease.capability,parent.capability);tree.set(input.childId,{identity,attempts:(previous?.attempts??0)+1,capability:lease.capability});launches.set(parent.capability,tree);
  return lease;
 },
 current(lease:OwnerLease){return fresh(lease)&&leases.get(lease.capability)?.lease===lease;},
 allows(lease:OwnerLease,path:string,content=true){
  const full=resolve(lease.cwd,path);
  return fresh(lease)&&exportPathAllowed(path,lease.readRoots)&&lease.canDisplay(full)&&(!content||lease.effectiveTools.some(t=>t==='read'||t==='filesystem')&&exportPathAllowed(path,lease.exportRoots)&&lease.canRead(full));
 },
 assignment(lease:OwnerLease,endpoint:string):DiscoveryAssignment {if(!fresh(lease)||leases.get(lease.capability)?.lease!==lease)throw Error('owner_expired');return {endpoint,capability:lease.capability,sessionId,taskId:lease.taskId,ownerId:lease.ownerId,attemptId:lease.attemptId,queryHash:lease.queryHash};},
 revoke,revokeOwner(ownerId:string){for(const [key,{lease}]of leases)if(lease.ownerId===ownerId)revoke(key);},
 syncTask(){for(const [key,{lease}]of leases)if(!active(lease))revoke(key);else if(!fresh(lease))expire(key);},
 dispose(){closed=true;for(const key of leases.keys())revoke(key);},get size(){return leases.size;}
 };
}
export type DiscoveryOwners=ReturnType<typeof createDiscoveryOwners>;

/** Only the common physical spawn seam consumes this parent-owned registration. */
export interface DiscoverySpawnRegistration {
 owners?:DiscoveryOwners;endpoint:string;owner:Omit<DiscoveryOwner,'attemptId'>;extension?:string;admit?():boolean;
 /** Explicit per-attempt broker assignment, never read from inherited env by spawn. */
 remoteAttempt?:{assignment:DiscoveryAssignment;signal:AbortSignal;revoke():void};
}
export const DISCOVERY_CHILD_ENV_KEYS=['AF_D9_ENDPOINT','AF_D9_CAPABILITY','AF_D9_SESSION_ID','AF_D9_TASK_ID','AF_D9_OWNER_ID','AF_D9_ATTEMPT_ID','AF_D9_QUERY_HASH','AF_D9_REGISTERED','AF_D9_ROOT','AF_D9_READ_ROOTS'] as const;
export function openDiscoveryAttempt(registration:DiscoverySpawnRegistration) {
 const {owners,owner,endpoint}=registration;
 if(registration.admit?.()===false||owners&&!owners.admitted(owner))throw Error('owner_admission_changed');
 if(registration.remoteAttempt)return {...registration.remoteAttempt,env:discoveryAssignmentEnv(registration.remoteAttempt.assignment,owner.cwd,owner.readRoots)};
 if(!owners)throw Error('owner_registration_denied');
 const lease=owners.register({...owner,attemptId:randomUUID()});
 try {
  const assignment=owners.assignment(lease,endpoint);
  return {assignment,env:discoveryAssignmentEnv(assignment,owner.cwd,owner.readRoots),signal:lease.attemptSignal,revoke:()=>owners.revoke(lease.capability)};
 } catch(error) { owners.revoke(lease.capability); throw error; }
}
export function discoveryAssignmentEnv(assignment:DiscoveryAssignment,root:string,readRoots:readonly string[]) {
 const env:Record<string,string>={AF_D9_REGISTERED:'1',AF_D9_ROOT:root,AF_D9_READ_ROOTS:JSON.stringify(readRoots)};
 for(const [key,value]of Object.entries(assignment))env[({endpoint:'AF_D9_ENDPOINT',capability:'AF_D9_CAPABILITY',sessionId:'AF_D9_SESSION_ID',taskId:'AF_D9_TASK_ID',ownerId:'AF_D9_OWNER_ID',attemptId:'AF_D9_ATTEMPT_ID',queryHash:'AF_D9_QUERY_HASH'} as Record<string,string>)[key]]=value;
 return env;
}
export function discoveryAssignmentFromEnv():DiscoveryAssignment|null {
 if(process.env.AF_D9_REGISTERED!=='1')return null;
 const assignment={endpoint:process.env.AF_D9_ENDPOINT!,capability:process.env.AF_D9_CAPABILITY!,sessionId:process.env.AF_D9_SESSION_ID!,taskId:process.env.AF_D9_TASK_ID!,ownerId:process.env.AF_D9_OWNER_ID!,attemptId:process.env.AF_D9_ATTEMPT_ID!,queryHash:process.env.AF_D9_QUERY_HASH!};
 return Object.values(assignment).every(v=>typeof v==='string'&&v.length>0)?assignment:null;
}
