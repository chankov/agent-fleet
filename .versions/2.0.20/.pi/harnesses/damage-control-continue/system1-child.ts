import {createDamageClient} from './system1-client.ts';
import {registerDamageGuard} from '../lib/damage-guard-port.ts';
import {captureDamageResult,damageCaptureState,originalDamageResult} from '../lib/damage-result-evidence.ts';
import {composeDamageResult,damageResultGap,type DamageResultEvent} from './result-screen.ts';

/** Explicit in-process assignment only. Construct during awaited session startup.
 * The parent authenticates capability ownership; no child identity or baseline
 * callback crosses IPC. Missing assignment must leave a parent port untouched.
 */
export function createDamageChild(assignment?:unknown){
 const client=createDamageClient(assignment),seen=new Set<string>(),results=new WeakMap<object,Promise<DamageResultEvent>>();
 let disposed=false;
 const unregister=assignment===undefined?()=>{}:registerDamageGuard({async call(event,ctx){
  if(!['bash','write','edit'].includes(event.toolName))return {block:false};
  const blocked=()=>({block:true,reason:'Damage-Control: assigned assessment did not authorize this call; re-authorize before retrying.'});
  if(disposed||seen.has(event.toolCallId))return blocked();
  // Observers/replays never spend the same local admission twice.
  seen.add(event.toolCallId);
  let exact:string;
  try{exact=JSON.stringify([event,ctx.cwd]);}catch{return blocked();}
  const result=await client.assess(event.toolName,event.input);
  try{
   if(disposed||exact!==JSON.stringify([event,ctx.cwd])||!ctx.revalidateBaseline?.())return blocked();
  }catch{return blocked();}
  return ['no_hold','unavailable','granted'].includes(result.outcome)?{block:false}:blocked();
 }});
 return {result<T extends DamageResultEvent>(event:T):Promise<T>{
  const prior=results.get(event);if(prior)return prior as Promise<T>;
  const deadlineAt=performance.timeOrigin+performance.now()+2000;
  captureDamageResult(event);
  const original=originalDamageResult(event);
  const work=(async()=>composeDamageResult(event,damageCaptureState(event)!=='captured'||!original?damageResultGap('original_capture_unavailable'):await client.result(original,{deadlineAt})))();
  results.set(event,work);return work;
 },dispose(){if(disposed)return;disposed=true;client.dispose();unregister();}};
}
