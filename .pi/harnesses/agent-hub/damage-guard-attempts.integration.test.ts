import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {connect} from 'node:net';
import {spawnPiAgent,spawnPiAgentWithModelFallback,killPiTree} from './spawn.ts';
import {createDamageOwners} from './damage-guard-owners.ts';
import {createDiscoveryOwners} from './file-discovery/owners.ts';
import {createDamageBroker,damageAssessmentFrame} from './damage-guard-broker.ts';
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};};
async function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'d6-spawn-'));
 writeFileSync(join(dir,'pi'),`#!/usr/bin/env node
const fs=require('node:fs'),crypto=require('node:crypto');
const a=process.env.AF_D6_ASSIGNMENT ? JSON.parse(process.env.AF_D6_ASSIGNMENT) : null;
const keys=Object.keys(process.env).filter(k=>k.startsWith('AF_D6'));
const row={assigned:!!a,onlyTrusted:keys.every(k=>k==='AF_D6_ASSIGNMENT'),hash:a?crypto.createHash('sha256').update(a.capability).digest('hex'):null,cwd:process.cwd(),tools:process.argv[process.argv.indexOf('--tools')+1],safe:!process.env.TYPESAFE_API_KEY};
fs.appendFileSync(process.env.REPORT,JSON.stringify(row)+'\\n');
if(process.env.MODE==='pipes') {
 const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore',process.stdout,process.stderr]});
 fs.writeFileSync(process.env.PIPE_PID,String(child.pid));process.exit(0);
}
else if(process.env.MODE==='wait') { process.stdout.write(JSON.stringify({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'READY'}})+'\\n');setInterval(()=>{},1000); }
else if(process.env.MODE==='fallback' && process.argv.includes('fake/primary')) {process.stdout.write(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'error',errorMessage:'provider unavailable'}})+'\\n');process.exit(1);}
else process.exit(0);
`,{mode:0o755});
 let current={session:'s',taskToken:'t',taskId:'task',inputRevision:'r'},admitted=true,throws=false,calls=0;
 const owners=createDamageOwners({current:()=>current,admit:()=>{if(throws)throw Error('denied');return admitted;}});
 const identities:any[]=[],leases:any[]=[],opened:any[]=[];
 let assessment:any=async()=> 'no_hold';
 const broker=await createDamageBroker({authority:{...owners,register(spec,parent){const identity=owners.register(spec,parent);identities.push(identity);return identity;}},assess:async(...args)=>{calls++;return assessment(...args);}});
 let prepare:undefined|(()=>Promise<void>);
 const registration={tools:['bash','edit'],validate:()=>admitted&&!throws&&current.inputRevision==='r'&&current.taskToken==='t',async open(info:any){
  assert.equal(leases.every(l=>l.identity.signal.aborted),true);
  opened.push(info);
  const assignment=broker.register({owner:'physical',...info});const identity=identities.at(-1);
  const lease={assignment,identity,validate:()=>!!owners.validate(identity,info.tools[0],info.cwd),revoke:()=>owners.revoke(identity)};
  leases.push(lease);try{await prepare?.();return lease;}catch(error){lease.revoke();throw error;}
 }};
 const opts:any={model:'fake/primary',tools:'read,bash,write',thinking:'off',systemPrompt:'synthetic',noSkills:true,noContextFiles:true,sessionFile:join(dir,'session'),prompt:'probe',cwd:dir,activeProfileSnapshot:undefined,physicalAttempt:{generation:1},damageRegistration:registration,env:{PATH:`${dir}:${process.env.PATH??''}`,NODE_OPTIONS:process.env.NODE_OPTIONS??'',REPORT:join(dir,'report'),AF_D6_ASSIGNMENT:'forged',AF_D6_UNKNOWN:'forged',TYPESAFE_API_KEY:'forged'}};
 return {dir,owners,registration,identities,leases,opened,opts,broker,calls:()=>calls,rows:()=>readFileSync(join(dir,'report'),'utf8').trim().split('\n').map(s=>JSON.parse(s)),setPrepare:(fn:()=>Promise<void>)=>prepare=fn,setAssessment:(fn:any)=>assessment=fn,change:(field:string)=>current={...current,[field]:'changed'},deny:()=>admitted=false,allow:()=>admitted=true,throwAdmission:()=>throws=true,close:async()=>{await broker.close();owners.dispose();rmSync(dir,{recursive:true,force:true});}};
}
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
async function request(a:any,id:string){return new Promise<any[]>(resolve=>{const s=connect(a.path),rows:any[]=[];let text='';s.on('connect',()=>s.write(JSON.stringify(damageAssessmentFrame(a,id,'bash',{command:'echo synthetic'}))+'\n'));s.on('data',b=>{text+=b;for(let n;(n=text.indexOf('\n'))>=0;){rows.push(JSON.parse(text.slice(0,n)));text=text.slice(n+1);}});s.on('error',()=>{});s.on('close',()=>resolve(rows));});}
test('F4 physical argv intersects declared tools, trusted assignment only, no preparation inference',async()=>{
 const f=await fixture();try{
  const result=await spawnPiAgent(f.opts);assert.equal(result.exitCode,0);
  assert.deepEqual(f.opened,[{tools:['bash'],cwd:f.dir}]);
  assert.deepEqual(f.rows()[0],{assigned:true,onlyTrusted:true,hash:hash(f.leases[0].assignment.capability),cwd:f.dir,tools:'read,bash,write',safe:true});
  assert.equal(f.calls(),0);assert.equal(f.leases[0].identity.signal.aborted,true);
  await request(f.leases[0].assignment,'stale');assert.equal(f.calls(),0);
  await spawnPiAgent({...f.opts,tools:'read,write'});assert.equal(f.leases.length,1);assert.equal(f.rows()[1].assigned,false);
  await spawnPiAgent({...f.opts,damageRegistration:undefined});assert.equal(f.rows()[2].assigned,false);
 }finally{await f.close();}
});
test('F4 actual fallback and identical generation resume-to-clean retries mint fresh UUID and capability',async()=>{
 const f=await fixture();try{
  const result=await spawnPiAgentWithModelFallback({...f.opts,env:{...f.opts.env,MODE:'fallback'}},'fake/secondary');assert.equal(result.exitCode,0);assert.equal(f.leases.length,2);
  await spawnPiAgent({...f.opts,resume:true});await spawnPiAgent({...f.opts,resume:false});
  assert.equal(new Set(f.identities.map(i=>i.attempt)).size,4);assert.equal(new Set(f.identities.map(i=>i.owner)).size,4);assert.equal(new Set(f.leases.map(l=>hash(l.assignment.capability))).size,4);
  assert.equal(f.leases.every(l=>l.identity.signal.aborted),true);assert.equal(f.calls(),0);
 }finally{await f.close();}
});
test('F4 deferred preparation revalidates task input and admission without proactive abort',async()=>{
 for(const change of ['session','taskToken','taskId','inputRevision','deny','throw','abort']){
  const f=await fixture(),entered=deferred(),release=deferred(),controller=new AbortController();try{
   f.setPrepare(async()=>{entered.resolve();await release.promise;});
   const run=spawnPiAgent({...f.opts,signal:controller.signal});await entered.promise;
   if(change==='deny')f.deny();else if(change==='throw')f.throwAdmission();else if(change==='abort')controller.abort();else f.change(change);
   release.resolve();const result=await run;assert.equal(result.lifecycle.launched,false);assert.equal(f.leases[0].identity.signal.aborted,true);assert.equal(f.calls(),0);
  }finally{release.resolve();await f.close();}
 }
});
test('F4 fallback admission change cannot open a late physical launch',async()=>{
 const f=await fixture();try{
  const result=await spawnPiAgentWithModelFallback({...f.opts,env:{...f.opts.env,MODE:'fallback'}},'fake/secondary',{onModelFallback:()=>f.deny()});
  assert.equal(result.lifecycle.launched,false);assert.equal(f.leases.length,1);assert.equal(f.leases[0].identity.signal.aborted,true);assert.equal(f.rows().length,1);
 }finally{await f.close();}
});
test('F4 pre-abort, malformed lease, registration failure, missing executable and isolation refusal fence launch',async()=>{
 const f=await fixture();try{
  const c=new AbortController();c.abort();assert.equal((await spawnPiAgent({...f.opts,signal:c.signal})).lifecycle.launched,false);assert.equal(f.leases.length,0);
  assert.equal((await spawnPiAgent({...f.opts,damageRegistration:{...f.registration,open:()=>{throw Error('registration unavailable');}}})).lifecycle.launched,false);
  let revoked=false;assert.equal((await spawnPiAgent({...f.opts,damageRegistration:{...f.registration,open:()=>({identity:{},assignment:{},validate:()=>true,revoke:()=>revoked=true})}})).lifecycle.launched,false);assert.equal(revoked,true);
  f.setPrepare(async()=>{throw Error('synthetic partial registration failure');});
  assert.equal((await spawnPiAgent(f.opts)).lifecycle.launched,false);assert.equal(f.leases.at(-1).identity.signal.aborted,true);
  f.setPrepare(async()=>{});
  assert.ok((await spawnPiAgent({...f.opts,env:{...f.opts.env,PATH:f.dir+'/absent'}})).spawnError);assert.equal(f.leases.at(-1).identity.signal.aborted,true);
  assert.equal((await spawnPiAgent({...f.opts,writeIsolation:{enabled:false,cwd:f.dir}})).lifecycle.launched,false);assert.equal(f.leases.at(-1).identity.signal.aborted,true);
 }finally{await f.close();}
});
test('F4 live abort, direct kill, tree kill, control stop and owner invalidation revoke transitively',async()=>{
 for(const mode of ['abort','kill','tree','control','invalidate']){
  const f=await fixture(),ready=deferred(),c=new AbortController();let proc:any,control:any;
  try{
   const run=spawnPiAgent({...f.opts,signal:c.signal,env:{...f.opts.env,MODE:'wait'}},{onProcess:p=>proc=p,onControl:x=>control=x,onTextDelta:()=>ready.resolve()});await ready.promise;
   const root=f.identities[0],child=f.owners.register({owner:'child',tools:['bash'],cwd:f.dir},root),grand=f.owners.register({owner:'grand',tools:['bash'],cwd:f.dir},child),sibling=f.owners.register({owner:'sibling',tools:['bash'],cwd:f.dir});
   proc.kill(0);assert.equal(root.signal.aborted,false);
   if(mode==='abort')c.abort();if(mode==='kill')proc.kill();if(mode==='tree')killPiTree(proc);if(mode==='control')control.terminate('drift_stop');if(mode==='invalidate'){f.deny();f.owners.invalidate();}
   assert.equal(root.signal.aborted,true);assert.equal(child.signal.aborted,true);assert.equal(grand.signal.aborted,true);assert.equal(sibling.signal.aborted,mode==='invalidate');
   const result=await run;assert.equal(result.lifecycle.closeSeen,true);assert.equal(result.termination?.reason,mode==='control'?'drift_stop':'cancelled');f.leases[0].revoke();f.leases[0].revoke();await request(f.leases[0].assignment,'late');assert.equal(f.calls(),0);
  }finally{if(proc&&!proc.killed)killPiTree(proc);await f.close();}
 }
});
test('F4 false and throwing registry admission permanently revoke descendants, unaffected sibling remains valid',async()=>{
 for(const throws of [false,true]){
  let allow=true;const r=createDamageOwners({current:()=>({session:'s',taskToken:'t',taskId:'task',inputRevision:'r'}),admit:i=>{if(i.owner.startsWith('sibling:'))return true;if(!allow&&throws)throw Error('unavailable');return allow;}});
  const spec={owner:'physical',tools:['bash'],cwd:process.cwd()},root=r.register(spec),child=r.register({...spec,owner:'child'},root),grand=r.register({...spec,owner:'grand'},child),sibling=r.register({...spec,owner:'sibling'});
  allow=false;assert.equal(r.validate(root,'bash',process.cwd()),undefined);assert.equal(root.signal.aborted,true);assert.equal(child.signal.aborted,true);assert.equal(grand.signal.aborted,true);
  allow=true;assert.equal(r.validate(root,'bash',process.cwd()),undefined);assert.ok(r.validate(sibling,'bash',process.cwd()));r.dispose();
 }
});
test('F4 final synchronous launch fence catches silent authority loss after async preparation',async()=>{
 const f=await fixture();try{
  let checks=0;
  const registration={...f.registration,validate:()=>++checks<5};
  const result=await spawnPiAgent({...f.opts,damageRegistration:registration});
  assert.equal(checks,5);assert.equal(result.lifecycle.launched,false);assert.equal(f.leases[0].identity.signal.aborted,true);
 }finally{await f.close();}
});
test('F4 leader exit revokes before inherited pipes close; callback exception cleanup is idempotent',async()=>{
 const f=await fixture(),exited=deferred();let descendant:number|undefined;
 try{
  let closeSeen=false;
  const run=spawnPiAgent({...f.opts,env:{...f.opts.env,MODE:'pipes',PIPE_PID:join(f.dir,'pid')}},{onProcess:p=>{p.once('exit',()=>exited.resolve());p.once('close',()=>closeSeen=true);}});
  await exited.promise;descendant=Number(readFileSync(join(f.dir,'pid'),'utf8'));
  assert.equal(f.leases[0].identity.signal.aborted,true);assert.equal(closeSeen,false);
  await request(f.leases[0].assignment,'before_close');assert.equal(f.calls(),0);
  process.kill(descendant,'SIGTERM');descendant=undefined;
  assert.equal((await run).lifecycle.closeSeen,true);
  const result=await spawnPiAgent({...f.opts,env:{...f.opts.env,MODE:'wait'}},{onProcess:()=>{throw Error('synthetic callback failure');}});
  assert.equal(result.termination?.reason,'cancelled');assert.equal(f.leases.at(-1).identity.signal.aborted,true);
 }finally{if(descendant)try{process.kill(descendant,'SIGKILL');}catch{}await f.close();}
});
test('F4 real broker optional unavailability retains baseline, revoked pending hold cannot release',async()=>{
 const f=await fixture(),ready=deferred(),held=deferred(),release=deferred();let proc:any;
 try{
  f.setAssessment(async()=> 'unavailable');
  const run=spawnPiAgent({...f.opts,env:{...f.opts.env,MODE:'wait'}},{onProcess:p=>proc=p,onTextDelta:()=>ready.resolve()});await ready.promise;
  assert.equal((await request(f.leases[0].assignment,'optional'))[0].outcome,'unavailable');assert.equal(f.identities[0].signal.aborted,false);
  f.setAssessment(async(_i:any,_e:any,c:any)=>{assert.equal(c.held(),true);held.resolve();await release.promise;return 'granted';});
  const pending=request(f.leases[0].assignment,'held');await held.promise;
  f.owners.revoke(f.identities[0]);release.resolve();
  assert.deepEqual((await pending).map(r=>r.outcome),['held','revoked']);
  await run;await request(f.leases[0].assignment,'after_revoke');assert.equal(f.calls(),2);
 }finally{release.resolve();if(proc&&!proc.killed)killPiTree(proc);await f.close();}
});
test('F4 D6 independently enforces lifetime with D9 present, safety extensions keep original order',async()=>{
 const f=await fixture(),d9=createDiscoveryOwners('session',()=> 'task'),ready=deferred();let proc:any;
 try{
  const discoveryRegistration={owners:d9,endpoint:'/synthetic/broker',owner:{taskId:'task',ownerId:'child',cwd:f.dir,task:'synthetic',query:'synthetic',effectiveTools:['read'],readRoots:[],exportRoots:[],canRead:()=>false,canDisplay:()=>false,permissionIdentity:()=> 'p'}};
  const extensions=['/synthetic/mandatory-safety.ts','/synthetic/other.ts'];
  const run=spawnPiAgent({...f.opts,extensions,discoveryRegistration,env:{...f.opts.env,MODE:'wait'}},{onProcess:p=>{proc=p;const flags=p.spawnargs.flatMap((x,i)=>x==='-e'?[p.spawnargs[i+1]]:[]);assert.deepEqual(flags.slice(0,2),extensions);assert.equal(flags.filter(x=>x===extensions[0]).length,1);},onTextDelta:()=>ready.resolve()});
  await ready.promise;assert.equal(d9.size,1);assert.equal(f.leases.length,1);
  f.owners.revoke(f.identities[0]);const result=await run;assert.equal(result.termination?.reason,'cancelled');assert.equal(d9.size,0);assert.equal(f.calls(),0);assert.equal(result.modelFallback,undefined);
 }finally{if(proc&&!proc.killed)killPiTree(proc);d9.dispose();await f.close();}
});
