import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createDiscoveryOwners,DISCOVERY_CHILD_ENV_KEYS} from './owners.ts';
import {nativeChildEnv,spawnPiAgent,spawnPiAgentWithModelFallback,killPiTree,type SpawnPiAgentOptions} from '../spawn.ts';
import {createDiscoveryRuntime} from './runtime.ts';
import {createDiscoveryBroker} from './broker.ts';
import {rankDiscovery} from './broker-client.ts';
import {parseFileDiscoveryConfig} from '../../lib/system1/config-file-discovery.js';
function fixture(t:any,ownerOptions:Parameters<typeof createDiscoveryOwners>[2]={}) {
 const root=mkdtempSync(join(tmpdir(),'d9-attempt-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 writeFileSync(join(root,'pi'),`#!/usr/bin/env node
const fs=require('node:fs');process.stdin.resume();
const model=process.argv[process.argv.indexOf('--model')+1];
fs.appendFileSync(process.env.REPORT,JSON.stringify({attempt:process.env.AF_D9_ATTEMPT_ID,capability:process.env.AF_D9_CAPABILITY,endpoint:process.env.AF_D9_ENDPOINT,keyAbsent:process.env.TYPESAFE_API_KEY==null,extension:process.argv.includes('trusted-extension')})+'\\n');
if(process.env.TREE==='1'){
 const child=require('node:child_process').spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});process.send('ready');setInterval(()=>{},1000)"],{stdio:['ignore','inherit','inherit','ipc']});
 child.once('message',()=>{fs.writeFileSync(process.env.CHILD_PID,String(child.pid));console.log(JSON.stringify({type:'tool_execution_start',toolCallId:'tree',toolName:'find',args:{}}));});
 setInterval(()=>{},1000);
}
else if(process.env.HEALTHY==='1'){
 console.log(JSON.stringify({type:'tool_execution_start',toolCallId:'healthy',toolName:'find',args:{}}));
 setTimeout(()=>{console.log(JSON.stringify({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'healthy complete'}}));},600);
}
else if(process.env.HANG==='1')setInterval(()=>{},1000);
else if(model==='fake/primary'){console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'error',errorMessage:'provider unavailable'}}));process.exitCode=1;}
`,{mode:0o755});
 let task='task';const owners=createDiscoveryOwners('session',()=>task,ownerOptions);t.after(()=>owners.dispose());
 const registration={owners,endpoint:join(root,'s'),extension:'trusted-extension',owner:{taskId:'task',ownerId:'research',cwd:root,task:'rounding',query:'own search',effectiveTools:['read','find'],readRoots:['docs'],exportRoots:['docs'],canRead:()=>true,canDisplay:()=>true,permissionIdentity:()=> 'v1'}};
 const opts:SpawnPiAgentOptions={model:'fake/primary',tools:'read,find',thinking:'off',sessionFile:join(root,'session'),prompt:'x',cwd:root,activeProfileSnapshot:undefined,discoveryRegistration:registration,env:{PATH:root+':'+process.env.PATH,REPORT:join(root,'report'),TYPESAFE_API_KEY:'injected',AF_D9_ENDPOINT:'forged',AF_D9_CAPABILITY:'forged'}};
 return {root,owners,opts,switchTask(){task='other';owners.syncTask();},rows:()=>readFileSync(join(root,'report'),'utf8').trim().split('\n').map(v=>JSON.parse(v))};
}
test('T7 actual common physical spawn fallback and reused options get fresh registered leases before startup; drift composes',async t=>{
 const f=fixture(t);let before=0,after=0;const identities:string[]=[];
 f.opts.attemptLifecycle={beforePhysicalSpawn(){before++;},afterPhysicalSpawn(){after++;}};
 const result=await spawnPiAgentWithModelFallback(f.opts,'fake/fallback',{onProcess(){assert.equal(f.owners.size,1);}});
 assert.equal(result.exitCode,0);assert.equal(result.termination,undefined);assert.equal(f.owners.size,0);
 await spawnPiAgent({...f.opts,model:'fake/fallback'});assert.equal(before,3);assert.equal(after,3);
 for(const row of f.rows()){assert.ok(row.extension);assert.ok(row.keyAbsent);assert.equal(row.endpoint,join(f.root,'s'));assert.match(row.capability,/^[0-9a-f]{64}$/);identities.push(row.attempt);}
 assert.equal(new Set(identities).size,3);assert.equal(new Set(f.rows().map(r=>r.capability)).size,3);
 assert.equal(f.opts.env?.AF_D9_ENDPOINT,'forged');assert.equal((f.opts as any).discoveryAssignment,undefined);
});
test('T7 actual public tree kill and direct process kill fence ownership immediately',async t=>{
 for(const tree of [true,false]){const f=fixture(t);const result=await spawnPiAgent({...f.opts,env:{...f.opts.env,HANG:'1'}},{onProcess(proc){assert.equal(f.owners.size,1);if(tree)killPiTree(proc);else proc.kill('SIGTERM');assert.equal(f.owners.size,0);}});assert.notEqual(result.exitCode,0);assert.equal(f.owners.size,0);}
});
test('T7 discovery-only cancellation owns the process group and kills a SIGTERM-resistant physical descendant',async t=>{
 const f=fixture(t),marker=join(f.root,'child-pid');let childPid:number|undefined;
 t.after(()=>{if(childPid)try{process.kill(childPid,'SIGKILL');}catch{}});
 const result=await spawnPiAgent({...f.opts,env:{...f.opts.env,TREE:'1',CHILD_PID:marker}},{onToolStart(){childPid=Number(readFileSync(marker,'utf8'));f.switchTask();assert.equal(f.owners.size,0);}});
 assert.equal(result.termination?.reason,'cancelled');assert.equal(result.termination?.escalated,true);
 const until=Date.now()+1000;let alive=true;
 while(alive&&Date.now()<until){try{process.kill(childPid!,0);if(process.platform==='linux'&&readFileSync(`/proc/${childPid}/stat`,'utf8').split(') ')[1].startsWith('Z'))alive=false;}catch{alive=false;}if(alive)await new Promise(r=>setTimeout(r,20));}
 assert.equal(alive,false,'discovery cancellation must kill the descendant, not just its leader');
});
test('T7 inherited and override endpoint/capability/activation are stripped without trusted registration',async()=>{
 const env=Object.fromEntries(DISCOVERY_CHILD_ENV_KEYS.map(key=>[key,'forged']));const merged=nativeChildEnv(env,{...env,TYPESAFE_API_KEY:'key',OTHER:'kept'});
 for(const key of DISCOVERY_CHILD_ENV_KEYS)assert.equal(merged[key],undefined);assert.equal(merged.TYPESAFE_API_KEY,undefined);assert.equal(merged.OTHER,'kept');
});
test('T7 failed spawn, isolation refusal, pre-cancel, kill and session/task switch revoke and fence leases',async t=>{
 const f=fixture(t);let closes=0;f.opts.attemptLifecycle={beforePhysicalSpawn(){},afterPhysicalSpawn(){closes++;}};
 const failed=await spawnPiAgent({...f.opts,env:{PATH:'/nonexistent'}});assert.ok(failed.spawnError);assert.equal(f.owners.size,0);
 const refused=await spawnPiAgent({...f.opts,writeIsolation:{enabled:false,cwd:f.root}});assert.ok(refused.spawnError);assert.equal(f.owners.size,0);
 const aborted=new AbortController();aborted.abort();const cancelled=await spawnPiAgent({...f.opts,signal:aborted.signal});assert.equal(cancelled.lifecycle.launched,false);assert.equal(f.owners.size,0);
 const kill=await spawnPiAgent({...f.opts,env:{...f.opts.env,HANG:'1'}},{onControl(control){assert.equal(f.owners.size,1);control.terminate();assert.equal(f.owners.size,0);}});assert.equal(kill.termination?.reason,'drift_stop');assert.equal(f.owners.size,0);
 const switched=await spawnPiAgent({...f.opts,env:{...f.opts.env,HANG:'1'}},{onControl(){f.switchTask();assert.equal(f.owners.size,0);}});assert.equal(switched.termination?.reason,'cancelled');assert.equal(closes,5);
 const other=fixture(t);const shutdown=await spawnPiAgent({...other.opts,env:{...other.opts.env,HANG:'1'}},{onControl(){other.owners.dispose();}});assert.equal(shutdown.termination?.reason,'cancelled');assert.equal(other.owners.size,0);
});
test('B1 short advisory TTL and authorize staleness refuse real broker BEFORE reads while healthy physical pi exits 0 without cancellation',async t=>{
 for(const mode of ['timer','authorize-expiry','stale-context']){
  let now=Date.now(),context='original',reads=0,ranks=0;
  const f=fixture(t,{ttlMs:mode==='timer'?80:5000,now:()=>now,currentContext:()=>context});
  const runtime=createDiscoveryRuntime({root:f.root,sessionId:'session',config:parseFileDiscoveryConfig({mode:'active',remoteContextApproved:true,include:['docs']}),context:()=>context,persist(){}});
  const rank=runtime.rank.bind(runtime);runtime.rank=async job=>{ranks++;return rank(job);};
  const broker=await createDiscoveryBroker({root:f.root,runtime,owners:f.owners});t.after(async()=>{runtime.dispose();await broker.close();});
  f.opts.discoveryRegistration!.endpoint=broker.endpoint;
  f.opts.discoveryRegistration!.owner.canRead=()=>{reads++;return true;};
  f.opts.discoveryRegistration!.owner.canDisplay=()=>{reads++;return true;};
  let started!:()=>void;const ready=new Promise<void>(r=>started=r);
  const pending=spawnPiAgent({...f.opts,model:'fake/healthy',turnDeadlineMs:5000,env:{...f.opts.env,HEALTHY:'1'}},{onToolStart(){started();}});
  await ready;if(mode==='timer')await new Promise(r=>setTimeout(r,120));else if(mode==='authorize-expiry')now+=6000;else context='revised';
  const row=f.rows()[0],assignment={endpoint:broker.endpoint,capability:row.capability,sessionId:'session',taskId:'task',ownerId:'research',attemptId:row.attempt,queryHash:(await import('../agentic-sources.ts')).sourceHash('own search')};
  assert.equal((await rankDiscovery(assignment,{paths:['docs/a'],discovery:{complete:true}}) as any).error,'unauthorized');
  f.owners.syncTask();assert.equal(f.owners.size,1,'expired inference retains authoritative physical lifecycle');
  assert.equal(reads,0);assert.equal(ranks,0);
  const result=await pending;assert.equal(result.exitCode,0);assert.equal(result.termination,undefined);assert.equal(result.output,'healthy complete');assert.equal(f.owners.size,0);
 }
});
test('B1 expired inference still terminates physical attempt on authoritative task switch and dispose',async t=>{
 for(const mode of ['task','dispose']){
  const f=fixture(t,{ttlMs:40});let started!:()=>void;const ready=new Promise<void>(r=>started=r);
  const pending=spawnPiAgent({...f.opts,env:{...f.opts.env,HEALTHY:'1'}},{onToolStart(){started();}});
  await ready;await new Promise(r=>setTimeout(r,60));assert.equal(f.owners.size,1);
  if(mode==='task')f.switchTask();else f.owners.dispose();
  const result=await pending;assert.equal(result.termination?.reason,'cancelled');assert.equal(f.owners.size,0);
 }
});

test('T12 C3N3 registration/assignment unavailable degrades normal physical launch without credentials; authoritative admission still refuses',async t=>{
 for(const mode of ['register','assignment']){
  const f=fixture(t);if(mode==='register')f.owners.register=()=>{throw Error('owner_registration_denied');};else f.owners.assignment=()=>{throw Error('owner_expired');};
  const result=await spawnPiAgent({...f.opts,model:'fake/fallback'});assert.equal(result.exitCode,0);assert.equal(f.owners.size,0);
  const row=f.rows()[0];assert.equal(row.attempt,undefined);assert.equal(row.capability,undefined);assert.equal(row.endpoint,undefined);assert.equal(row.extension,false);assert.equal(row.keyAbsent,true);
 }
 const f=fixture(t);f.switchTask();const denied=await spawnPiAgent({...f.opts,model:'fake/fallback'});assert.equal(denied.lifecycle?.launched,false);assert.match(denied.spawnError??'',/owner_admission_changed/);
});
