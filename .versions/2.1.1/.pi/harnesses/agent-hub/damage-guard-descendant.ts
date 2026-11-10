import {randomUUID} from 'node:crypto';
import {connect} from 'node:net';
import {realpathSync} from 'node:fs';
import {DAMAGE_FRAME_BYTES,damageControlFrame,decodeDamageFrame,exactKeys,validDamageAssignment,verifyDamageFrame,type DamageAssignment} from './damage-guard-broker.ts';
import {type DamagePhysicalLease,type DamageSpawnRegistration} from './damage-guard-owners.ts';
import {spawnedDamageAssignment} from '../lib/damage-guard-port.ts';
import {spawnDiscoveryDescendant} from './file-discovery/descendant.ts';
import type {SpawnPiAgentOptions,SpawnPiAgentCallbacks,ModelFallbackOptions,SpawnPiAgentResult} from './spawn.ts';

/** Control only: no inference, retry, remote validation claim or task supplied by child text. */
function control(assignment:DamageAssignment,op:'register_descendant'|'revoke_self',extra:Record<string,unknown>={}):Promise<Record<string,unknown>> {
 return new Promise((resolve,reject)=>{
  const id=randomUUID(),socket=connect(assignment.path);let used=0,chunks:Buffer[]=[],ended=false,settled=false;
  const timer=setTimeout(()=>finish(),2000);
  function finish(row?:Record<string,unknown>){if(settled)return;settled=true;clearTimeout(timer);socket.destroy();if(row)resolve(row);else reject(Error('damage_descendant_control_unavailable'));}
  socket.on('connect',()=>socket.write(JSON.stringify(damageControlFrame(assignment,id,op,extra))+'\n'));
  socket.on('data',(b:Buffer)=>{used+=b.length;if(used>DAMAGE_FRAME_BYTES){finish();return;}chunks.push(b);});
  socket.on('end',()=>{
   ended=true;
   try{
    const bytes=Buffer.concat(chunks);if(bytes.at(-1)!==10||bytes.subarray(0,-1).includes(10))throw Error();
    const row=decodeDamageFrame(bytes.subarray(0,-1));
    if(!row||typeof row!=='object'||Array.isArray(row))throw Error();
    const reply=row as Record<string,unknown>;
    if(reply.v!==1||reply.id!==id||!verifyDamageFrame(reply,assignment.capability))throw Error();
    // Registration validates its exact shape after acquiring any authenticated
    // child assignment, so malformed partial registration can still be cleaned up.
    if(op==='revoke_self'&&!exactKeys(reply,['v','id','outcome','auth']))throw Error();
    finish(row as Record<string,unknown>);
   }catch{finish();}
  });
  socket.on('error',()=>finish());socket.on('close',()=>{if(!ended)finish();});
 });
}

export function createDamageDescendantRegistration(parent:DamageAssignment,input:{tools:readonly string[];cwd:string;signal?:AbortSignal;admit():boolean}):DamageSpawnRegistration & {close():Promise<void>} {
 if(!validDamageAssignment(parent))throw Error('damage_descendant_assignment_invalid');
 parent=Object.freeze({...parent});const cwd=realpathSync(input.cwd),tools=Object.freeze([...new Set(input.tools.filter(t=>['bash','write','edit','read','filesystem'].includes(t)))]);
 let closed=false;const leases=new Set<DamagePhysicalLease>(),pending=new Set<Promise<unknown>>(),cleanup=new Set<Promise<unknown>>();
 const validate=()=>{try{return !closed&&!input.signal?.aborted&&input.admit()===true;}catch{return false;}};
 const revokeRemote=(assignment:DamageAssignment)=>{
  const work=control(assignment,'revoke_self').catch(()=>{});cleanup.add(work);void work.finally(()=>cleanup.delete(work));
 };
 const abort=()=>{for(const lease of leases)lease.revoke();};input.signal?.addEventListener('abort',abort,{once:true});
 return {tools,validate,open(physical){
  const physicalTools=Object.freeze([...physical.tools]),physicalCwd=physical.cwd;
  const work=(async()=>{
   if(!validate()||!physicalTools.length||physicalTools.some(t=>!tools.includes(t))||realpathSync(physicalCwd)!==cwd)throw Error('damage_descendant_admission_denied');
   // Keep the bounded registration response drain alive on cancellation, so a late
   // authenticated assignment can be revoked rather than abandoned. No launch follows.
   const row=await control(parent,'register_descendant',{tools:physicalTools});
   if(!validDamageAssignment(row.assignment)||row.assignment.path!==parent.path||row.assignment.capability===parent.capability)throw Error('damage_descendant_registration_refused');
   const assignment=Object.freeze({...row.assignment}),controller=new AbortController();
   let revoked=false;
   const lease:DamagePhysicalLease={assignment,identity:Object.freeze({owner:`descendant-physical:${randomUUID()}`,attempt:randomUUID(),tools:physicalTools,cwd,signal:controller.signal}),validate:()=>!revoked&&validate(),revoke(){if(revoked)return;revoked=true;controller.abort();leases.delete(lease);revokeRemote(assignment);}};
   leases.add(lease);
   if(row.outcome!=='registered'||!exactKeys(row,['v','id','outcome','assignment','auth'])||!validate()){lease.revoke();throw Error('damage_descendant_registration_refused');}
   return lease;
  })();pending.add(work);void work.then(()=>pending.delete(work),()=>pending.delete(work));return work;
 },async close(){closed=true;input.signal?.removeEventListener('abort',abort);abort();await Promise.allSettled([...pending]);abort();await Promise.allSettled([...cleanup]);}};
}

/** D6 surrounds the existing D9 route; its registration reaches every F4 physical launch. */
export async function spawnDamageDescendant(opts:SpawnPiAgentOptions,fallbackModel:string|undefined,cbs:SpawnPiAgentCallbacks,fallbackOptions:ModelFallbackOptions,input:{childId:string;task:string;query:string;admit():boolean}):Promise<SpawnPiAgentResult>{
 let registration:ReturnType<typeof createDamageDescendantRegistration>|undefined;
 try{
  const parent=spawnedDamageAssignment();
  // The registration validates the exact assignment shape before any use.
  if(parent!==undefined)registration=createDamageDescendantRegistration(parent as DamageAssignment,{tools:opts.tools.split(',').map(t=>t.trim()),cwd:opts.cwd??process.cwd(),signal:opts.signal,admit:input.admit});
  const admitted=()=>{try{return !opts.signal?.aborted&&input.admit()===true&&(!registration||registration.validate());}catch{return false;}};
  if(!admitted())throw Error('damage_descendant_admission_denied');
  return await spawnDiscoveryDescendant({...opts,damageRegistration:registration,attemptLifecycle:{beforePhysicalSpawn(info){if(!admitted())throw Error('damage_descendant_admission_denied');return opts.attemptLifecycle?.beforePhysicalSpawn(info);},afterPhysicalSpawn(info){opts.attemptLifecycle?.afterPhysicalSpawn(info);}}},fallbackModel,cbs,fallbackOptions,{...input,admit:admitted});
 }catch{
  return {output:'',stderr:'damage_descendant_authority_unavailable',exitCode:1,spawnError:'damage_descendant_authority_unavailable',modelUsed:opts.model,toolCallsStarted:0,lifecycle:{launched:false,closeSeen:false}};
 }finally{await registration?.close();}
}
