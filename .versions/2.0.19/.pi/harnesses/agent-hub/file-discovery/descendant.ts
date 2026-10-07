import {existsSync,readFileSync,writeFileSync,unlinkSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {spawnPiAgent,spawnPiAgentWithModelFallback,type SpawnPiAgentOptions,type SpawnPiAgentCallbacks,type ModelFallbackOptions,type SpawnPiAgentResult} from '../spawn.ts';
import {profileFallback,readActiveProfile} from '../policy/profile-runtime.ts';
import {discoveryAssignmentFromEnv,type DiscoveryAssignment,type DiscoverySpawnRegistration} from './owners.ts';
import {registerDescendant,rankDiscovery,revokeDiscoveryAttempt} from './broker-client.ts';

/** Called only by delegate.ts after its synchronous role/depth/tree/tool reservation.
 * Broker grants inference ownership, not launch authority. Channel failure keeps the
 * ordinary delegate path and its exact permissions; cancellation never retries.
 */
export async function spawnDiscoveryDescendant(opts:SpawnPiAgentOptions,fallbackModel:string|undefined,cbs:SpawnPiAgentCallbacks,fallbackOptions:ModelFallbackOptions,input:{childId:string;task:string;query:string;admit():boolean}):Promise<SpawnPiAgentResult> {
 const parent=discoveryAssignmentFromEnv();
 if(!parent)return spawnPiAgentWithModelFallback(opts,fallbackModel,cbs,fallbackOptions);
 try{fallbackModel=profileFallback(fallbackModel,readActiveProfile()??readActiveProfile(opts.env));}
 catch(error){return {output:'',stderr:String(error),exitCode:1,spawnError:String(error),modelUsed:opts.model,toolCallsStarted:0,lifecycle:{launched:false,closeSeen:false}};}
 const run=async(model:string)=>{
  const controller=new AbortController();let assignment:DiscoveryAssignment|undefined,revokeWork:Promise<unknown>|undefined;
  const revoke=()=>{if(assignment&&!revokeWork)revokeWork=revokeDiscoveryAttempt(assignment);};
  const abort=()=>{controller.abort();revoke();};opts.signal?.addEventListener('abort',abort,{once:true});
  let manifest:unknown={status:'unavailable',reason:'channel_unavailable',fallback:'Continue ordinary permitted discovery.'};
  let registration:DiscoverySpawnRegistration|undefined;
  try{
   if(opts.signal?.aborted||!input.admit())controller.abort();
   if(!controller.signal.aborted){
    try {
    const response=await registerDescendant(parent,{childId:input.childId,task:input.task,query:input.query,tools:opts.tools.split(',').map(t=>t.trim()).filter(Boolean)},controller.signal);
    if(response.ok){
     const result=response.result as {assignment:DiscoveryAssignment;cwd:string;readRoots:string[];exportRoots:string[];initialPaths:string[];discoveryComplete:boolean};
     const candidate=result.assignment;
     // The broker is trusted, but never reuse a parent's identity even on a bad reply.
     if(!candidate||candidate.capability===parent.capability||candidate.ownerId===parent.ownerId||candidate.attemptId===parent.attemptId)throw Error('invalid_descendant_assignment');
     assignment=candidate;
     if(controller.signal.aborted||!input.admit())abort();
     else {
      const initial=await rankDiscovery(assignment,{paths:result.initialPaths??[],discovery:{complete:result.discoveryComplete}},controller.signal);
      manifest=initial.ok?initial.result:{status:'unavailable',reason:initial.error,fallback:'Continue ordinary permitted discovery.'};
      if(controller.signal.aborted||!input.admit())abort();
      else registration={endpoint:assignment.endpoint,owner:{taskId:assignment.taskId,ownerId:assignment.ownerId,cwd:result.cwd,task:input.task,query:input.query,effectiveTools:opts.tools.split(','),readRoots:result.readRoots,exportRoots:result.exportRoots,canRead:()=>false,canDisplay:()=>false,permissionIdentity:()=>''},extension:fileURLToPath(new URL('./child-extension.ts',import.meta.url)),remoteAttempt:{assignment,signal:controller.signal,revoke}};
     }
    }else manifest={status:response.error==='cancelled'?'cancelled':'unavailable',reason:response.error,fallback:'Continue ordinary permitted discovery.'};
    }catch{revoke();registration=undefined;manifest={status:'unavailable',reason:'channel_unavailable',fallback:'Continue ordinary permitted discovery.'};}
   }
   if(!input.admit()||opts.signal?.aborted)abort();
   return await spawnPiAgent({...opts,model,signal:controller.signal,discoveryRegistration:registration,prompt:opts.prompt+'\n\n## File discovery context (advisory, separate from task/policy/scope/evidence)\n'+JSON.stringify(manifest)},cbs);
  }finally{opts.signal?.removeEventListener('abort',abort);revoke();await revokeWork;}
 };
 // Same fallback semantics as spawn.ts, but registration must be awaited before
 // EACH physical command (the common spawn seam itself is synchronous). Retain
 // session restoration, read-only replay policy and active-profile admission.
 const sessionExisted=existsSync(opts.sessionFile);let snapshot:Buffer|undefined;
 if(sessionExisted){try{snapshot=readFileSync(opts.sessionFile);}catch{}}
 const primary=await run(opts.model);
 if(!fallbackModel||fallbackModel===opts.model||primary.spawnError||primary.termination)return primary;
 const workStarted=primary.toolCallsStarted>0||Boolean(primary.output.trim());
 if(workStarted&&!fallbackOptions.midRun)return primary;
 const reason=primary.assistantError?primary.assistantError.slice(-500):primary.exitCode!==0?(primary.stderr.trim().slice(-500)||`pi exited with code ${primary.exitCode??'unknown'}`):null;
 const providerFailure=/\b(provider unavailable|service unavailable|overloaded|rate limit|too many requests|out of memory|oom|memory limit|resource exhausted|econn(?:reset|refused)|connection (?:reset|refused)|fetch failed|network error|gateway timeout|http\s*5\d\d|\b429\b)\b/i;
 if(!reason||workStarted&&!providerFailure.test(reason)||sessionExisted&&!snapshot)return primary;
 try{if(sessionExisted&&snapshot)writeFileSync(opts.sessionFile,snapshot);else unlinkSync(opts.sessionFile);}catch(error:any){if(error?.code!=='ENOENT')return primary;}
 const notice={from:opts.model,to:fallbackModel,reason};cbs.onModelFallback?.(notice);
 return {...await run(fallbackModel),modelFallback:notice};
}
