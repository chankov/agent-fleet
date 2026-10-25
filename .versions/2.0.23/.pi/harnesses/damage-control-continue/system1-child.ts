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
  const blocked=(reason:string)=>({block:true,reason:`Damage-Control: ${reason}`});
  if(disposed)return blocked('child assignment disposed; start a fresh authorized attempt.');
  if(seen.has(event.toolCallId))return blocked('duplicate tool call; this call was already assessed.');
  // Observers/replays never spend the same local admission twice.
  seen.add(event.toolCallId);
  let exact:string;
  try{exact=JSON.stringify([event,ctx.cwd]);}catch{return blocked('invalid tool call payload.');}
  const result=await client.assess(event.toolName,event.input);
  try{
   if(disposed)return blocked('child assignment disposed while waiting.');
   if(exact!==JSON.stringify([event,ctx.cwd]))return blocked('tool call changed while waiting; submit the current call.');
   if(!ctx.revalidateBaseline?.())return blocked('baseline authority changed or is unavailable; revalidate local policy.');
  }catch{return blocked('baseline revalidation failed.');}
  if(['no_hold','unavailable','granted'].includes(result.outcome))return {block:false};
  const reasons={
   blocked:'action denied or held; existing human approval requirements remain in force.',
   cancelled:'assessment cancelled; no approval was granted.',
   revoked:'child assignment revoked; start a fresh authorized attempt.',
   indeterminate:'optional assessment transport or registration failed; this is an internal runtime error, not a human denial.',
  };
  return blocked(reasons[result.outcome as keyof typeof reasons]??`assessment returned ${result.outcome}.`);
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
