import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import delegate from './delegate.ts';
import {createDamageOwners} from './damage-guard-owners.ts';
import {createDamageBroker} from './damage-guard-broker.ts';
import {createDiscoveryOwners,discoveryAssignmentEnv} from './file-discovery/owners.ts';
import {createDiscoveryBroker} from './file-discovery/broker.ts';
import {createDiscoveryRuntime} from './file-discovery/runtime.ts';
import {parseFileDiscoveryConfig} from '../lib/system1/config-file-discovery.js';

async function waitFor(check:()=>boolean){const until=Date.now()+5000;while(!check()){assert.ok(Date.now()<until,'synthetic child did not become ready');await new Promise(r=>setTimeout(r,10));}}
async function fixture(){
 const root=mkdtempSync(join(tmpdir(),'d6-nested-')),saved={...process.env},identities:any[]=[];let calls=0;
 let current={session:'s',taskToken:'t',taskId:'task',inputRevision:'r'},beforeChildRegister:undefined|(()=>void);
 const owners=createDamageOwners({current:()=>current,admit:()=>true});
 const broker=await createDamageBroker({authority:{...owners,register(spec,parent){if(parent)beforeChildRegister?.();const i=owners.register(spec,parent);identities.push(i);return i;}},assess:async()=>{calls++;return 'unavailable';}});
 const listeners=process.listeners('SIGTERM');const hooks:Record<string,()=>void>={};
 const d9owners=createDiscoveryOwners('s',()=> 'task');
 const runtime=createDiscoveryRuntime({root,sessionId:'s',config:parseFileDiscoveryConfig({mode:'active',remoteContextApproved:true,include:['docs']}),service:{evaluate:async()=>{throw Error('no synthetic source export');}},context:()=> 'task',persist(){}});
 const d9=await createDiscoveryBroker({root,runtime,owners:d9owners});
 mkdirSync(join(root,'.ai'));writeFileSync(join(root,'.ai','system1.json'),JSON.stringify({version:2,mode:'auto',provider:'typesafe',model:'jev-1.13.0',apiKeyEnv:'TYPESAFE_API_KEY',consumers:{fileDiscovery:{mode:'off'},damageGuard:{mode:'off'}}}));
 writeFileSync(join(root,'pi'),String.raw`#!/usr/bin/env node
const fs=require('node:fs'),crypto=require('node:crypto'),args=process.argv;
process.stdin.resume();process.stdin.on('end',()=>{
const a=process.env.AF_D6_ASSIGNMENT?JSON.parse(process.env.AF_D6_ASSIGNMENT):null;
fs.appendFileSync(process.env.REPORT,JSON.stringify({hash:a?crypto.createHash('sha256').update(a.capability).digest('hex'):null,tools:args[args.indexOf('--tools')+1],config:process.env.AGENT_HUB_DELEGATE_CONFIG||null,cwd:process.cwd(),d9:process.env.AF_D9_REGISTERED==='1',safe:!process.env.TYPESAFE_API_KEY,extensions:args.filter((v,i)=>args[i-1]==='-e')})+'\n');
if(process.env.MODE==='wait'){console.log(JSON.stringify({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'READY'}}));setInterval(()=>{},1000);}
else if(process.env.MODE==='fallback'&&args.includes('fake/primary')){console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'error',errorMessage:'provider unavailable'}}));process.exitCode=1;}
else if(process.env.MODE==='failure'){process.exitCode=1;}
else console.log(JSON.stringify({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'## DIGEST\noriginal evidence'}}));
});`,{mode:0o755});
 const parent=broker.register({owner:'parent',tools:['read','bash','write','edit'],cwd:root});
 // Synthetic HOME/profile/config only; no inherited discovery assignment or provider secret.
 for(const key of Object.keys(process.env))if(key.startsWith('AF_D9_')||key.startsWith('AF_D6_')||key==='AGENT_FLEET_ACTIVE_PROFILE')delete process.env[key];
 Object.assign(process.env,{PATH:root+':'+saved.PATH,HOME:root,XDG_CONFIG_HOME:root,AF_D6_ASSIGNMENT:JSON.stringify(parent),REPORT:join(root,'report'),TYPESAFE_API_KEY:'synthetic-stripped'});
 const configure=(extra:any={})=>{
  process.env.AGENT_HUB_DELEGATE_CONFIG=JSON.stringify({persona:'builder',tag:'root',roles:{worker:{model:'fake/primary',fallbackModel:'fake/secondary',tools:'read,bash'}},depth:1,callBudget:4,remainingSpawns:4,parentTools:'read,bash,write,edit',personaPrompt:'synthetic',eventDir:root,cwd:root,damageControl:'/synthetic/safety.ts',...extra});
  let tool:any;delegate({registerTool:t=>tool=t,on:(event:string,fn:any)=>hooks[event]=fn} as any);return tool;
 };
 return {root,parent,identities,owners,broker,d9owners,hooks,calls:()=>calls,configure,setRegistrationHook:(fn:()=>void)=>beforeChildRegister=fn,rows:()=>existsSync(join(root,'report'))?readFileSync(join(root,'report'),'utf8').trim().split('\n').map(s=>JSON.parse(s)):[],change:()=>current={...current,inputRevision:'changed'},discovery(mode:string){
  for(const key of Object.keys(process.env))if(key.startsWith('AF_D9_'))delete process.env[key];
  if(mode==='absent')return;
  const lease=d9owners.register({taskId:'task',ownerId:'parent',attemptId:mode,cwd:root,task:'parent task',query:'parent query',effectiveTools:['read','bash','delegate'],readRoots:[],exportRoots:[],canRead:()=>false,canDisplay:()=>false,permissionIdentity:()=> 'p'});
  const a=d9owners.assignment(lease,mode==='failure'?join(root,'missing.sock'):d9.endpoint);
  Object.assign(process.env,discoveryAssignmentEnv(a,root,[]));
  if(mode==='on')writeFileSync(join(root,'.ai','system1.json'),JSON.stringify({version:2,mode:'auto',provider:'typesafe',model:'jev-1.13.0',apiKeyEnv:'TYPESAFE_API_KEY',consumers:{fileDiscovery:{mode:'active',remoteContextApproved:true,include:['docs']},damageGuard:{mode:'off'}}}));
 },close:async()=>{for(const listener of process.listeners('SIGTERM'))if(!listeners.includes(listener))process.removeListener('SIGTERM',listener);for(const key of Object.keys(process.env))if(!(key in saved))delete process.env[key];Object.assign(process.env,saved);runtime.dispose();d9owners.dispose();await d9.close();await broker.close();owners.dispose();rmSync(root,{recursive:true,force:true});}};
}

test('F7 actual delegate D9 absent/off/on/failure x D6 absent/off/on preserves fallback, depth, safety and distinct capabilities',async()=>{
 for(const discovery of ['absent','off','on','failure'])for(const damage of ['absent','off','on']){
  const f=await fixture();try{
   f.discovery(discovery);if(damage==='absent')delete process.env.AF_D6_ASSIGNMENT;
   if(damage==='on'){const path=join(f.root,'.ai','system1.json'),config=JSON.parse(readFileSync(path,'utf8'));config.consumers.damageGuard={mode:'active',remoteScopes:{commands:true},include:['docs']};writeFileSync(path,JSON.stringify(config));}
   process.env.MODE='fallback';const tool=f.configure();
   const result=await tool.execute('c',{role:'worker',instruction:'child text is not Hub input',allow_write:true});assert.equal(result.details.status,'done');
   const rows=f.rows();assert.equal(rows.length,2);assert.equal(f.calls(),0);
   for(const row of rows){assert.equal(row.tools,'read,bash');assert.equal(row.cwd,f.root);assert.equal(row.config,null);assert.equal(row.safe,true);assert.equal(row.extensions[0],'/synthetic/safety.ts');assert.equal(row.d9,discovery==='off'||discovery==='on');assert.equal(!!row.hash,damage!=='absent');}
   if(damage!=='absent'){
    assert.notEqual(rows[0].hash,rows[1].hash);assert.notEqual(rows[0].hash,createHash('sha256').update(f.parent.capability).digest('hex'));
    assert.equal(f.identities.length,3);assert.equal(f.identities.slice(1).every(i=>i.signal.aborted),true);assert.equal(f.identities[0].signal.aborted,false);
   }
   assert.equal(JSON.stringify(result).includes(f.parent.capability),false);assert.match(JSON.stringify(result),/original evidence/);
  }finally{await f.close();}
 }
});

test('F7 actual delegate admission refusals, malformed assignment and stale Hub authority cannot launch',async()=>{
 for(const mode of ['abort','stale','malformed','budget','depth','role','tools']){
  const f=await fixture();try{
   const tool=f.configure(mode==='budget'?{remainingSpawns:0}:mode==='depth'?{depth:0}:mode==='tools'?{parentTools:'read',roles:{worker:{model:'fake/primary',tools:'bash'}}}:{}),c=new AbortController();
   if(mode==='abort')c.abort();if(mode==='stale')f.change();if(mode==='malformed')process.env.AF_D6_ASSIGNMENT='invalid';
   const result=await tool.execute('c',{role:mode==='role'?'unknown':'worker',instruction:'probe',allow_write:true},c.signal);
   assert.notEqual(result.details.status,'done');assert.equal(f.rows().length,0);assert.equal(f.calls(),0);
  }finally{await f.close();}
 }
});

test('F7 parent cancellation/reset/exit and child failure revoke descendants without revoking unrelated sibling',async()=>{
 for(const mode of ['abort','session_before_switch','session_shutdown','failure']){
  const f=await fixture(),c=new AbortController();try{
   process.env.MODE=mode==='failure'?'failure':'wait';const tool=f.configure({roles:{worker:{model:'fake/primary',tools:'read,bash'}}});
   const sibling=f.owners.register({owner:'unrelated',tools:['bash'],cwd:f.root});
   const run=tool.execute('c',{role:'worker',instruction:'probe',allow_write:true},c.signal);
   if(mode!=='failure'){
    // Timeline deltas flush on a bounded interval while the synthetic child waits.
    await waitFor(()=>f.rows().length>0);if(mode==='abort')c.abort();else f.hooks[mode]();
   }
   await run;assert.equal(f.identities[1].signal.aborted,true);assert.ok(f.owners.validate(sibling,'bash',f.root));assert.equal(f.calls(),0);
  }finally{c.abort();await f.close();}
 }
});

test('F7 concurrent actual delegates retain write downgrade and local read-only physical fence',async()=>{
 const f=await fixture(),c=new AbortController();try{
  process.env.MODE='wait';const tool=f.configure();
  const first=tool.execute('c1',{role:'worker',instruction:'first',allow_write:true},c.signal);await waitFor(()=>f.rows().length>0);
  process.env.MODE='primary';const second=await tool.execute('c2',{role:'worker',instruction:'second',allow_write:true});assert.equal(second.details.status,'done');
  assert.equal(f.rows()[1].tools,'read');assert.ok(f.rows()[1].hash);assert.notEqual(f.rows()[0].hash,f.rows()[1].hash);assert.deepEqual(f.identities[2].tools,['read']);assert.equal(f.owners.validate(f.identities[2],'bash',f.root),undefined);assert.equal(f.identities[2].signal.aborted,true);assert.equal(f.calls(),0);c.abort();await first;
 }finally{c.abort();await f.close();}
});

test('F7 actual delegate authoritative task loss or cancellation during registration never launches a process',async()=>{
 for(const mode of ['revision','abort','reset']){
  const f=await fixture(),c=new AbortController();try{
   const tool=f.configure();f.setRegistrationHook(()=>{if(mode==='revision')f.change();else if(mode==='abort')c.abort();else f.hooks.session_before_switch();});
   const result=await tool.execute('c',{role:'worker',instruction:'probe',allow_write:true},c.signal);
   assert.notEqual(result.details.status,'done');assert.equal(f.rows().length,0);assert.equal(f.calls(),0);assert.equal(f.identities.slice(1).every(i=>i.signal.aborted),true);
  }finally{c.abort();await f.close();}
 }
});

test('F7 actual queued read-only descendant preserves reservation downgrade and cancellation fence',async()=>{
 const f=await fixture(),firstSignal=new AbortController(),secondSignal=new AbortController();try{
  process.env.AGENT_HUB_PROVIDER_LIMITS='fake=1';process.env.MODE='wait';const tool=f.configure();
  const first=tool.execute('c1',{role:'worker',instruction:'first',allow_write:true},firstSignal.signal);await waitFor(()=>f.rows().length>0);
  const second=tool.execute('c2',{role:'worker',instruction:'queued',allow_write:true},secondSignal.signal);
  await waitFor(()=>readFileSync(join(f.root,'events.jsonl'),'utf8').includes('"t":"queued"'));
  secondSignal.abort();firstSignal.abort();await first;const result=await second;
  assert.notEqual(result.details.status,'done');assert.equal(f.rows().length,1);assert.equal(f.identities.length,2);assert.equal(f.identities[1].signal.aborted,true);assert.equal(f.calls(),0);
  const reservations=readFileSync(join(f.root,'events.jsonl'),'utf8').trim().split('\n').map(s=>JSON.parse(s)).filter(x=>x.t==='spawn');
  assert.equal(reservations[1].tools,'read');assert.equal(reservations[1].remainingSpawns,2);
 }finally{firstSignal.abort();secondSignal.abort();await f.close();}
});
