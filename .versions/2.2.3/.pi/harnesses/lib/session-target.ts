import {TARGET_CAPABILITIES} from './target-capabilities.js';
import {realpathSync} from 'node:fs';
import type {ExtensionAPI} from '@mariozechner/pi-coding-agent';
import {sessionRootsFromEnv,validateSessionRoots,projectForSession,type SessionRoots} from './workspace-context.ts';
import {approveWorktreeScope} from './system1/worktree-scopes.ts';
import {readSystem1Document,loadSystem1Snapshot} from './system1/config-loader.js';
const ENTRY='fleet-session-roots-v1';
/** Session metadata binds history to a checkout. It never supplies source consent. */
export function createSessionTargetGuard(pi:ExtensionAPI){
 let binding:SessionRoots|undefined;let refusal:string|undefined;let initialized=false;
 function current(cwd:string):string|undefined {
  if(refusal)return refusal;
  if(!initialized)return process.env.AF_SESSION_ROOTS?'session_target_not_initialized':undefined;
  try{
   const supplied=sessionRootsFromEnv();
   if(!binding)return supplied?'session_target_changed':undefined;
   validateSessionRoots(binding);
   if(supplied?.targetId!==binding.targetId||realpathSync(cwd)!==binding.executionRoot)return 'session_target_changed';
   return undefined;
  }catch{return 'session_target_stale';}
 }
 async function start(ctx:any){
  refusal=undefined;initialized=true;
  try{
   const supplied=sessionRootsFromEnv();
   if(binding&&supplied?.targetId!==binding.targetId)throw Error('session_target_changed');
   binding??=supplied;
   const branch=ctx.sessionManager?.getBranch?.()??[];
   const saved=branch.filter((entry:any)=>entry.type==='custom'&&entry.customType===ENTRY).at(-1)?.data;
   if(saved){validateSessionRoots(saved);if(!binding||saved.targetId!==binding.targetId)throw Error('resume_target_mismatch');}
   else if(binding){
    if(branch.some((entry:any)=>entry.type==='message'))throw Error('unbound_resume_requires_new_session');
    if(!ctx.sessionManager)throw Error('session_binding_unavailable');
    pi.appendEntry(ENTRY,binding);
   }
   const error=current(ctx.cwd);if(error)throw Error(error);
  }catch(error){refusal=error instanceof Error?error.message:String(error);ctx.ui.notify(`Fleet target refused: ${refusal}. Start a new session from af with the original --worktree.`,'error');}
 }
 pi.registerCommand('af-worktree',{
  description:'Inspect and verify this session’s immutable selected checkout',
  handler:async(args,ctx)=>{
   if(args.trim()&&!['status','verify'].includes(args.trim())){ctx.ui.notify('Usage: /af-worktree [status|verify]. Select another checkout by starting a new just fleet --worktree session.','warning');return;}
   const error=current(ctx.cwd);
   if(error){ctx.ui.notify(`Fleet target refused: ${error}`,'error');return;}
   if(!binding){ctx.ui.notify('Legacy session: no selected worktree');return;}
   const snapshot=loadSystem1Snapshot(binding.executionRoot,binding);
   let flag:string|undefined;try{flag=pi.getFlag('project') as string|undefined;}catch{}
   const project=projectForSession(flag??process.env.AF_TARGET_EFFECTIVE_PROJECT??process.env.AF_TARGET_BASE_PROJECT??'default',binding);
   ctx.ui.notify(JSON.stringify({workspaceRoot:binding.workspaceRoot,resourceRoot:binding.resourceRoot,executionRoot:binding.executionRoot,repositoryRoot:binding.repositoryRoot,targetId:binding.targetId,...project,capabilities:TARGET_CAPABILITIES,configurationStatus:snapshot.status,configurationReason:snapshot.targetReason??null,consumers:Object.fromEntries(Object.entries(snapshot.consumers).map(([name,section]:[string,any])=>[name,{configuredMode:snapshot.document?.consumers?.[name]?.mode??'off',effectiveMode:section.config?.mode??'off',scopeStatus:section.status,reason:section.reason??(section.status==='invalid'?'needs_adaptation':null),providerChecked:false,applicabilityChecked:false}]))},null,2));
  },
 });
 pi.registerCommand('af-worktree-consent',{
  description:'Fresh, exact per-consumer System 1 source-export approval for this checkout',
  handler:async(args,ctx)=>{
   const error=current(ctx.cwd);if(error||binding?.mode!=='targeted'){ctx.ui.notify(`Worktree approval refused: ${error??'target_required'}`,'error');return;}
   const result=await approveWorktreeScope({binding,consumer:args.trim(),readDocument:()=>readSystem1Document(binding!.workspaceRoot),
    ask:ctx.hasUI?async descriptor=>ctx.ui.confirm('Approve this exact worktree source-export scope?',JSON.stringify(descriptor,null,2)):undefined});
   ctx.ui.notify(result.status==='approved'?'Exact worktree scope approved. Restart Fleet with the same --worktree to activate it; modes, limits and include lists were not changed.':`Worktree scope refused: ${result.reason}`,result.status==='approved'?'info':'warning');
  },
 });
 return {start,current};
}
