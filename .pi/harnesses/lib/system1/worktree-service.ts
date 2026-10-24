import type { System1Service } from './contracts.ts';
import { readSystem1Document } from './config-loader.js';
import { sessionRootsFromEnv } from '../workspace-context.ts';
import { worktreeScopeApproved,worktreeScopePreview } from './worktree-scopes.ts';
/** Revalidate the exact scope at the provider boundary and before accepting a late result. */
export function worktreeConsumerService(service:System1Service|undefined,document:any,consumer:string):System1Service|undefined {
 if(!service)return undefined;
 const binding=sessionRootsFromEnv();if(!binding||binding.mode!=='targeted')return service;
 let digest:string|undefined;try{digest=worktreeScopePreview(document,consumer,binding)?.digest;}catch{}
 async function current(){
  try{
   if(!digest||sessionRootsFromEnv()?.targetId!==binding!.targetId)return false;
   const {readDamagePolicy}=await import('../damage-policy.ts');
   if(!readDamagePolicy(binding!.executionRoot,binding))return false;
   const latest=readSystem1Document(binding!.workspaceRoot);
   return worktreeScopePreview(latest,consumer,binding)?.digest===digest&&worktreeScopeApproved(latest,consumer,binding);
  }catch{return false;}
 }
 return {async evaluate(request){
  if(!await current())return {status:'unavailable',reason:'invalid_config'};
  const result=await service.evaluate(request);
  return await current()?result:{status:'unavailable',reason:'invalid_config'};
 }};
}
