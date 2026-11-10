// Root routing is not source-export consent. Only this exact, user-approved
// descriptor can activate a configured consumer for a physical checkout.
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { safeSourceRead } from '../safe-source-read.js';
import { resolvePolicyRoots, policyRootValidationContext } from '../policy-roots.js';
import { sessionRootsFromEnv, validateSessionRoots } from '../workspace-context.js';
import { CONSUMERS, deepFreeze, normalizeSystem1Config } from './config-v2.js';
const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
function policy(roots) {
 const path=join(roots.workspaceRoot,'.ai/agent-fleet-overrides.md');
 const raw=existsSync(path)?safeSourceRead(roots.workspaceRoot,path,1024*1024).toString('utf8'):'';
 const config={rulesDirs:[],docsPaths:[]};let section=false;
 for(const line of raw.split(/\r?\n/)){
  const heading=line.match(/^##\s+(.+?)\s*$/);if(heading){section=['agent-hub','agent-team'].includes(heading[1].trim().toLowerCase());continue;}
  const pair=section&&line.match(/^\s*(rules|docs)\s*:\s*(.+?)\s*$/i);if(pair)config[pair[1].toLowerCase()==='rules'?'rulesDirs':'docsPaths']=pair[2].split(',').map(s=>s.trim()).filter(Boolean);
 }
 const table=resolvePolicyRoots(roots.executionRoot,config,roots.workspaceRoot);
 if(table.diagnostics.length)throw Error('ambiguous_worktree_policy');
 const guardPolicyHash=hash(safeSourceRead(roots.workspaceRoot,join(roots.workspaceRoot,'.pi/damage-control-rules.yaml'),1024*1024).toString('utf8'));
 return {table,guardPolicyHash,configurationHash:hash(raw),roots:table.roots.map(root=>{const s=statSync(root.canonicalPath,{bigint:true});return {role:root.role,path:root.canonicalPath,lexicalPath:root.lexicalPath,kind:root.kind,device:String(s.dev),inode:String(s.ino),birthtime:String(s.birthtimeNs)};})};
}
const within=(base,path)=>path===base||path.startsWith(base+sep);
function projectSection(section,roots,grants){
 const result=JSON.parse(JSON.stringify(section));
 const map=path=>{
  if(path==='git:tracked')return path;
  if(typeof path!=='string'||isAbsolute(path)||path.includes('\\\\')||path.includes('\0'))throw Error('ambiguous_application_scope');
  const absolute=resolve(roots.workspaceRoot,path);
  if(within(roots.repositoryRoot,absolute))return relative(roots.repositoryRoot,absolute).split(sep).join('/')||'git:tracked';
  const grant=grants.find(root=>root.role!=='workspace'&&within(root.lexicalPath??root.path,absolute));
  if(grant){const suffix=relative(grant.lexicalPath??grant.path,absolute);return relative(roots.executionRoot,resolve(grant.path,suffix)).split(sep).join('/');}
  if(path.split('/').includes('..'))throw Error('ambiguous_application_scope');
  return path; // An explicit target-relative scope, shown as such for fresh consent.
 };
 if(Array.isArray(result.include))result.include=result.include.map(map);
 for(const binding of result.localBindings??[]){
  if(Array.isArray(binding.applicability?.paths))binding.applicability.paths=binding.applicability.paths.map(map);
  if(Array.isArray(binding.exceptions?.paths))binding.exceptions.paths=binding.exceptions.paths.map(map);
  if(binding.placement?.prefix)binding.placement.prefix=map(binding.placement.prefix);
 }
 return result;
}
export function projectWorktreeDocument(document,binding=sessionRootsFromEnv()) {
 if(!binding||binding.mode!=='targeted'||!document?.consumers)return document;
 const roots=validateSessionRoots(binding),grants=policy(roots).roots;
 return {...document,consumers:Object.fromEntries(Object.entries(document.consumers).map(([name,section])=>[name,projectSection(section,roots,grants)]))};
}
export function worktreeScopePreview(document,consumer,binding=sessionRootsFromEnv()) {
 if(!binding||binding.mode!=='targeted')return undefined;
 const roots=validateSessionRoots(binding);
 if(!CONSUMERS.includes(consumer))throw Error('unknown_consumer');
 if(!['ready','off'].includes(normalizeSystem1Config(document).status))throw Error('invalid_configuration');
 const section=document?.consumers?.[consumer];
 if(!section)throw Error('consumer_unconfigured');
 const {table,...policyScope}=policy(roots);
 const projected=projectSection(section,roots,policyScope.roots);
 const effective=normalizeSystem1Config({...document,consumers:{[consumer]:projected}},policyRootValidationContext(table)).consumers[consumer];
 if(effective.status==='invalid')throw Error('ambiguous_consumer_scope');
 const dataContracts={watchdog:'bounded progress messages',proactiveReview:'bounded changed-file excerpts and selected rule sections',dispatchTriage:'bounded task and role metadata',taskTriage:'bounded task state',agenticAsk:'explicit included file selections and opt-in tool output references',fileDiscovery:'approved candidate snippets and directory metadata',contextCompaction:'bounded session history',damageGuard:'commands, edits and results selected by remoteScopes'};
 const descriptor={version:1,consumer,dataContract:dataContracts[consumer],targetId:roots.targetId,workspaceRoot:roots.workspaceRoot,executionRoot:roots.executionRoot,
  repositoryRoot:roots.repositoryRoot,provider:document.provider,model:document.model,apiKeyEnv:document.apiKeyEnv,
  configurationHash:hash(document),scope:JSON.parse(JSON.stringify(section)),effectiveScope:effective.config??projected,policy:policyScope};
 return deepFreeze({...descriptor,digest:hash(descriptor)});
}
function recordPath(preview){return join(preview.workspaceRoot,'.pi/agent-sessions/worktree-consent',preview.targetId,`${preview.consumer}.json`);}
export function worktreeScopeApproved(document,consumer,binding=sessionRootsFromEnv()) {
 if(!binding||binding.mode!=='targeted')return true;
 try{
  const preview=worktreeScopePreview(document,consumer,binding),path=recordPath(preview),stat=lstatSync(path);
  if(!stat.isFile()||(stat.mode&0o077)!==0||(process.getuid&&stat.uid!==process.getuid()))return false;
  const record=JSON.parse(safeSourceRead(binding.workspaceRoot,path,65536).toString('utf8'));
  return record.version===1&&record.approved===true&&record.digest===preview.digest&&record.consumer===consumer&&record.targetId===binding.targetId;
 }catch{return false;}
}
function privateDirectory(root,parts){
 let path=root;
 for(const part of parts){path=join(path,part);if(!existsSync(path))mkdirSync(path,{mode:0o700});const s=lstatSync(path);if(!s.isDirectory()||realpathSync(path)!==path)throw Error('consent_storage_denied');}
 return path;
}
/** The caller supplies a real UI callback, never a Boolean/environment approval. */
export async function approveWorktreeScope({consumer,readDocument,ask,binding=sessionRootsFromEnv()}) {
 if(!binding||binding.mode!=='targeted')return {status:'refused',reason:'target_required'};
 if(typeof ask!=='function')return {status:'refused',reason:'approval_requires_ui'};
 let before;try{before=worktreeScopePreview(readDocument(),consumer,binding);}catch{return {status:'refused',reason:'scope_unavailable'};}
 if(await ask(before)!==true)return {status:'refused',reason:'scope_not_approved'};
 let after;try{after=worktreeScopePreview(readDocument(),consumer,binding);}catch{return {status:'refused',reason:'scope_changed'};}
 if(after.digest!==before.digest)return {status:'refused',reason:'scope_changed'};
 const directory=privateDirectory(binding.workspaceRoot,['.pi','agent-sessions','worktree-consent',binding.targetId]);
 const path=recordPath(before),temporary=join(directory,`.${randomUUID()}.tmp`);let fd;
 try{
  fd=openSync(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  writeFileSync(fd,JSON.stringify({version:1,approved:true,digest:before.digest,consumer,targetId:binding.targetId}));fsyncSync(fd);closeSync(fd);fd=undefined;
  if(worktreeScopePreview(readDocument(),consumer,binding).digest!==before.digest)throw Error('scope_changed');
  renameSync(temporary,path);
  return {status:'approved',digest:before.digest};
 }finally{if(fd!==undefined)closeSync(fd);try{unlinkSync(temporary);}catch{}}
}
export function gateWorktreeConsumer(document,consumer,section,binding=sessionRootsFromEnv()) {
 if(!binding||binding.mode!=='targeted'||section?.status!=='ready'||document?.mode==='off')return section;
 if(consumer==='proactiveReview'&&section.config?.remoteContext==='disabled')return section;
 if(worktreeScopeApproved(document,consumer,binding))return section;
 return Object.freeze({status:'off',reason:'needs_worktree_consent',config:Object.freeze({...section.config,mode:'off'})});
}
export function gateWorktreeSnapshot(snapshot,binding=sessionRootsFromEnv()) {
 if(!binding||binding.mode!=='targeted')return snapshot;
 const consumers=Object.fromEntries(Object.entries(snapshot.consumers).map(([name,section])=>[name,gateWorktreeConsumer(snapshot.document,name,section,binding)]));
 return Object.freeze({...snapshot,consumers:Object.freeze(consumers),targetId:binding.targetId});
}
