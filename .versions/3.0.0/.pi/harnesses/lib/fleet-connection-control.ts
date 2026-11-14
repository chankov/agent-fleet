import {randomUUID,createHash} from 'node:crypto';
import {lstat,realpath,readdir,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join,isAbsolute} from 'node:path';
import type {Socket} from 'node:net';
import {targetKey,validInstructionTarget} from './fleet-notification-validation.ts';
import type {ConversationKey} from '../../agent-fleet/scripts/lib/fleet-codex-allowlist.ts';
import {BootstrapChannelServer,namespaceKey} from './fleet-bootstrap-channel.ts';
import type {NotificationBootstrap,BootstrapServices} from './fleet-notification-bootstrap.ts';
export type ConnectionRights={rights:readonly string[];expiresAt?:number;status:string;revision?:number};
export type NotificationSession={status():{threadId:string;enabled:boolean;expiresAt:number;reason:string;[key:string]:unknown};renewUntil(until:number):unknown};
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const object=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const exact=(v:unknown,fields:string[])=>object(v)&&Object.keys(v).length===fields.length&&fields.every(k=>Object.hasOwn(v,k));
/** Bounded inventory of the explicitly configured private policy directory; never probes host auth files. */
export async function connectionNamespaces(root:string):Promise<ConversationKey[]>{
 if(!isAbsolute(root)||await realpath(root)!==root)throw Error('unsafe_policy_root');const dir=await lstat(root);if(!dir.isDirectory()||dir.uid!==process.getuid?.()||(dir.mode&0o777)!==0o700)throw Error('unsafe_policy_root');
 const entries=await readdir(root,{withFileTypes:true}),result:ConversationKey[]=[];
 for(const entry of entries.slice(0,256)){if(!entry.isFile()||!/^([a-f0-9]{64})\.json$/.test(entry.name))continue;let file;
  try{file=await open(join(root,entry.name),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);const s=await file.stat();if(!s.isFile()||s.uid!==process.getuid?.()||(s.mode&0o777)!==0o600||s.nlink!==1||s.size>65536)continue;
   const buffer=Buffer.alloc(65537),read=await file.read(buffer,0,buffer.length,0);if(read.bytesRead>65536)continue;const namespace=JSON.parse(buffer.subarray(0,read.bytesRead).toString('utf8')).namespace;
   if(!exact(namespace,['hostProfile','principal','threadId'])||!uuid(namespace.threadId)||!['hostProfile','principal'].every(k=>typeof namespace[k]==='string'&&/^[A-Za-z0-9._-]{1,128}$/.test(namespace[k])))continue;
   if(createHash('sha256').update(JSON.stringify([namespace.hostProfile,namespace.principal,namespace.threadId])).digest('hex')+'.json'!==entry.name)continue;
   result.push(namespace);if(result.length>=64)break;
  }catch{}finally{await file?.close();}
 }return result;
}
/** Same-UID cooperative control, NOT host/human attestation. Never grants rights or starts a daemon. */
export class FleetConnectionControl {
 private proposals=new Map<string,{context:string;threadId:string;until:number;before:number;owner:string;expires:number;outcome?:unknown;attempted?:boolean}>();
 private observed=new Map<string,{namespace:ConversationKey;rights:ConnectionRights;observedAt:number}>();
 readonly bootstrapChannel:BootstrapChannelServer;
 private options:{owner:()=>unknown;session:()=>NotificationSession|undefined;readRights:(c:ConversationKey)=>Promise<ConnectionRights>;now?:()=>number;defaultNamespace?:{hostProfile:string;principal:string};listNamespaces?:()=>Promise<ConversationKey[]>;bootstrap?:NotificationBootstrap;bootstrapStatus?:(c:ConversationKey)=>unknown};
 constructor(options:FleetConnectionControl['options']){this.options={...options};this.bootstrapChannel=new BootstrapChannelServer({
  owner:()=>{const o=this.options.owner();return validInstructionTarget(o)?o:null;},now:options.now,
  acceptNamespace:c=>!!this.options.bootstrap&&(!this.options.defaultNamespace||c.hostProfile===this.options.defaultNamespace.hostProfile&&c.principal===this.options.defaultNamespace.principal),
  request:async(operation,payload,signal)=>{const bootstrap=this.options.bootstrap;if(!bootstrap)return {status:'blocked',reason:'bootstrap_unavailable'};
   if(operation==='status'&&exact(payload,['namespace']))return {status:'cached',namespace:payload.namespace,bootstrap:bootstrap.rows().find(r=>namespaceKey(r.namespace)===namespaceKey(payload.namespace))??null,notifications:this.options.bootstrapStatus?.(payload.namespace)??{enabled:false,reason:'cached_runtime_unavailable'},delivery:'not_established_by_status'};
   if(operation==='prepare'&&exact(payload,['namespace','until','rights']))return bootstrap.prepare(payload.namespace,payload.until,payload.rights,signal);
   if(operation==='commit'&&exact(payload,['namespace','proposalId'])&&uuid(payload.proposalId))return bootstrap.commit(payload.proposalId,payload.namespace,signal);
   return {status:'rejected',reason:'invalid_bootstrap_operation'};
  },onDisconnect:c=>{void this.options.bootstrap?.disable(c).catch(()=>{});},
 });}
 writeBootstrapRights(request:Parameters<BootstrapServices['codexWriteRights']>[0],signal:AbortSignal){return this.bootstrapChannel.writeRights(request.scope.namespace,request,signal);}
 bootstrapRows(){return this.options.bootstrap?.rows()??[];}
 stop(){this.options.bootstrap?.stop();this.bootstrapChannel.stop();}
 private now(){return (this.options.now??Date.now)();}
 async request(operation:string,payload:unknown){
  if(!object(payload)||!exact(payload.namespace,['hostProfile','principal','threadId'])||!uuid(payload.namespace.threadId)||!['hostProfile','principal'].every(k=>typeof payload.namespace[k]==='string'&&/^[A-Za-z0-9._-]{1,128}$/.test(payload.namespace[k])))return {status:'rejected'};
  const c=payload.namespace as ConversationKey,now=this.now(),session=this.options.session();
  if(this.options.defaultNamespace&&(c.hostProfile!==this.options.defaultNamespace.hostProfile||c.principal!==this.options.defaultNamespace.principal))return {status:'blocked',reason:'host_namespace_mismatch'};
  if(this.options.bootstrap&&['prepare','commit'].includes(operation))return {status:'blocked',reason:'bootstrap_protocol_required',activation:'not_performed'};
  const notification=session?.status(),matches=notification?.threadId===c.threadId;
  if(this.observed.size>=64&&!this.observed.has(c.threadId))return {status:'blocked',reason:'connection_inventory_full'};
  const rights=await this.options.readRights(c);this.observed.set(c.threadId,{namespace:c,rights,observedAt:now});
  const effective=rights.status==='active'&&(rights.expiresAt===undefined||rights.expiresAt>now);
  const status={namespace:c,rights:{...rights,effective,remainingMs:rights.expiresAt===undefined?null:Math.max(0,rights.expiresAt-now)},notifications:matches?notification:{enabled:false,reason:'host_mapping_required',events:['message','question','permission']},delivery:'not_established_by_status'};
  if(operation==='status'&&exact(payload,['namespace']))return {status:'observed',...status};
  if(operation==='prepare'&&exact(payload,['namespace','until','desktopConfirmed'])&&payload.desktopConfirmed===true&&Number.isSafeInteger(payload.until)&&payload.until>now&&payload.until<=now+30*24*3600000){
   if(!matches||!notification?.enabled)return {status:'blocked',reason:matches?notification?.reason:'host_mapping_required',...status};
   if(payload.until<=notification.expiresAt)return {status:'blocked',reason:'renewal_would_not_extend',...status};
   for(const [id,p] of this.proposals)if(p.expires<=now)this.proposals.delete(id);
   if(this.proposals.size>=32)return {status:'blocked',reason:'busy'};
   const owner=this.options.owner();if(!validInstructionTarget(owner))return {status:'blocked',reason:'owner_unavailable'};
   const proposalId=randomUUID();this.proposals.set(proposalId,{context:JSON.stringify(c),threadId:c.threadId,until:payload.until,before:notification.expiresAt,owner:targetKey(owner),expires:now+300000});
   return {status:'prepared',proposalId,expiresInSeconds:300,notificationsUntil:payload.until,events:['message','question','permission'],requiresExplicitConfirmation:true,humanProvenance:'unknown',...status};
  }
  if(operation==='commit'&&exact(payload,['namespace','proposalId'])){
   const p=this.proposals.get(payload.proposalId),owner=this.options.owner();
   if(!p||p.context!==JSON.stringify(c)||p.threadId!==c.threadId||!validInstructionTarget(owner)||targetKey(owner)!==p.owner||p.expires<=now)return {status:'rejected',reason:'proposal_unavailable'};
   if(p.attempted)return {status:'historical',outcome:p.outcome??{status:'unknown'},replayed:false};
   if(!effective||!rights.rights.includes('read')||rights.expiresAt!==undefined&&rights.expiresAt<p.until||!matches||!notification?.enabled||notification.expiresAt!==p.before)return {status:'rejected',reason:'authority_or_mapping_changed'};
   p.attempted=true;
   try{p.outcome={status:'renewed',notifications:session!.renewUntil(p.until)};}catch{p.outcome={status:'unknown',reason:'renewal_failed_or_uncertain',replayAllowed:false};}
   return p.outcome;
  }
  return {status:'rejected'};
 }
 rows(){const now=this.now(),session=this.options.session()?.status();return [...new Set([...this.observed.keys(),...(session?[session.threadId]:[])])].map(threadId=>{
  const observation=this.observed.get(threadId),rights=observation?.rights,stale=!observation||now-observation.observedAt>5000;
  return {threadId,rights:rights?.rights??[],rightsExpiresAt:rights?.expiresAt??null,rightsReason:stale?'rights_not_freshly_observed':rights?.expiresAt!==undefined&&rights.expiresAt<=now?'rights_expired':rights?.status??'unknown',rightsObservedAt:observation?.observedAt??null,notifications:session?.threadId===threadId?session:{enabled:false,expiresAt:null,reason:'host_mapping_required'}};
 });}
 async refresh(){if(this.options.listNamespaces)try{for(const namespace of await this.options.listNamespaces()){if(this.observed.size>=64)break;if(!this.observed.has(namespace.threadId))this.observed.set(namespace.threadId,{namespace,rights:{rights:[],status:'unknown'},observedAt:0});}}catch{}const session=this.options.session()?.status();if(session&&this.options.defaultNamespace&&!this.observed.has(session.threadId))this.observed.set(session.threadId,{namespace:{...this.options.defaultNamespace,threadId:session.threadId},rights:{rights:[],status:'unknown'},observedAt:0});for(const row of this.observed.values()){try{row.rights=await this.options.readRights(row.namespace);row.observedAt=this.now();}catch{row.rights={rights:[],status:'rights_unavailable'};}}}
 handleStream(socket:Socket,envelope:any,buffered:Buffer){return this.bootstrapChannel.handleStream(socket,envelope,buffered);}
 handle(socket:Socket,envelope:any){if(this.bootstrapChannel.handle(socket,envelope))return true;if(envelope?.type!=='connection_request')return false;
  const reply=(body:unknown)=>{try{socket.end(JSON.stringify({type:'connection_response',version:1,msg_id:envelope.msg_id,owner:this.options.owner(),...body as object})+'\n');}catch{}};
  if(!exact(envelope,['type','version','msg_id','owner','operation','payload','sender_session','sender_endpoint','hops','timestamp'])||envelope.version!==1||typeof envelope.msg_id!=='string'||envelope.msg_id.length>96||!validInstructionTarget(envelope.owner)||!validInstructionTarget(this.options.owner())||targetKey(envelope.owner)!==targetKey(this.options.owner() as any)||JSON.stringify(envelope).length>32768){reply({status:'rejected'});return true;}
  void this.request(envelope.operation,envelope.payload).then(reply,()=>reply({status:'unavailable'}));return true;
 }
}
export function connectionLines(rows:ReturnType<FleetConnectionControl['rows']>,now=Date.now()){
 const ttl=(until:number|null|undefined)=>until==null?'no deadline reported':`${new Date(until).toISOString()} / ${until<=now?'expired':`${Math.ceil((until-now)/60000)}m left`}`;
 return rows.flatMap(r=>[`Chat ${r.threadId}`,`  rights ${r.rights.join('+')||'unknown'} · ${r.rightsReason}`,`  rights expiry ${r.rightsExpiresAt==null&&r.rights.length?'until revoked (legacy)':ttl(r.rightsExpiresAt)}`,`  notifications ${r.notifications?.enabled?'enabled':'inactive'} · ${r.notifications?.reason??'unknown'}`,`  notification expiry ${ttl(r.notifications?.expiresAt as number|undefined)}`,`  message/question/permission · delivery unverified · transport not probed`,`  last queue evidence ${(r.notifications as any)?.lastNotification?.queueStatus??'unknown'}`]);
}
