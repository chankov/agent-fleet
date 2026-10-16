import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync,renameSync,mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createDispatchNative} from './dispatch-native.ts';
import {spawnPiAgentWithModelFallback} from './spawn.ts';
import {createDamageOwners} from './damage-guard-owners.ts';
import {createDamageBroker} from './damage-guard-broker.ts';
import {createDiscoveryOwners} from './file-discovery/owners.ts';
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};};
async function fixture(t:any){
 const root=mkdtempSync(join(tmpdir(),'d6-worker-')),session=join(root,'session');mkdirSync(session);
 writeFileSync(join(root,'pi'),`#!/usr/bin/env node
const fs=require('node:fs');const args=process.argv,a=JSON.parse(process.env.AF_D6_ASSIGNMENT||'null');
let prompt='';process.stdin.on('data',b=>prompt+=b);process.stdin.on('end',()=>{
const model=args[args.indexOf('--model')+1],file=args[args.indexOf('--session')+1];
fs.writeFileSync(file,JSON.stringify({type:'session',version:3,id:'fixture'})+'\\n');
fs.appendFileSync(process.env.REPORT,JSON.stringify({model,assigned:!!a,capability:a?.capability,tools:args[args.indexOf('--tools')+1],cwd:process.cwd(),safe:!process.env.TYPESAFE_API_KEY,resume:args.includes('-c'),extensions:args.filter((v,i)=>args[i-1]==='-e')})+'\\n');
if(process.env.MODE==='corrupt'&&!fs.existsSync(process.env.REPORT+'.once')){fs.writeFileSync(process.env.REPORT+'.once','1');console.error('not a valid pi session');process.exitCode=1;}
else if(process.env.MODE==='fallback'&&model==='fake/primary'){console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'error',errorMessage:'provider unavailable'}}));process.exitCode=1;}
});`,{mode:0o755});
 let calls=0,current=true,revision='r';const identities:any[]=[],leases:any[]=[],inputs:any[]=[];
 const owners=createDamageOwners({current:()=>({session:'s',taskToken:'t',taskId:'task',inputRevision:revision}),admit:()=>current});
 const broker=await createDamageBroker({authority:{...owners,register(spec,parent){const i=owners.register(spec,parent);identities.push(i);return i;}},assess:async()=>{calls++;return 'unavailable';}});
 let wait:undefined|(()=>Promise<void>);
 const prepare=(input:any)=>{inputs.push(input);return {tools:['bash','edit','write'],validate:()=>current&&revision==='r'&&input.admit(),async open(info:any){
 assert.ok(leases.every(l=>l.identity.signal.aborted));const assignment=broker.register({owner:input.ownerId,...info}),identity=identities.at(-1);
 const lease={assignment,identity,validate:()=>!!owners.validate(identity,info.tools[0],info.cwd),revoke:()=>owners.revoke(identity)};leases.push(lease);await wait?.();return lease;
 }};};
 t.after(async()=>{owners.dispose();await broker.close();rmSync(root,{recursive:true,force:true});});
 return {root,session,inputs,leases,identities,prepare,calls:()=>calls,deny:()=>current=false,revise:()=>revision='other',setWait:(fn:any)=>wait=fn,
 env:{PATH:root+':'+process.env.PATH,NODE_OPTIONS:process.env.NODE_OPTIONS??'',REPORT:join(root,'report'),TYPESAFE_API_KEY:'synthetic',AF_D6_ASSIGNMENT:'forged'},rows:()=>existsSync(join(root,'report'))?readFileSync(join(root,'report'),'utf8').trim().split('\n').map(s=>JSON.parse(s)):[]};
}
function worker(f:any,overrides:any={}) {
 const state:any={def:{name:'builder',description:'builder',tools:'read,find',toolsExplicit:true,systemPrompt:'MANDATORY POLICY\nUse skills/incremental-implementation/SKILL.md',file:'agents/builder.md',fallbackModel:'fake/model'},status:'idle',task:'',toolCount:0,messageCount:0,elapsed:0,lastWork:'',contextPct:0,contextTokens:0,sessionFile:null,runCount:0,runsSinceFresh:0,timeline:[]};
 const deps:any={getAgentState:()=>state,listAgentStates:()=>[state],getSessionDir:()=>f.session,getDispatchPolicy:()=>({default:'native',grace_s:0,substitutions:{}}),isComsReady:()=>false,getIdentity:()=>null,peersInScope:()=>[],wasComsMissNotified:()=>false,markComsMissNotified(){},startMonitorChild(){},finalizeMonitorChild(){},registerMonitorWaitOnly(){},registerMonitorProcess(){},appendMonitorOutput(){},getContextWindow:()=>100000,currentBudget:()=>({delegation:false,agentTurnMs:20000}),bumpRecycle(){},bumpDriftStop(){},getSessionHealthIo:()=>({existsSync,readFileSync,renameSync}),getSafetyHarnessPath:()=> 'safety',getDelegateExtensionPath:()=>null,getReconSearchTimeoutMs:()=>1000,getProjectDocsPaths:()=>['docs/PHILOSOPHY.md'],getUserLanguage:()=> 'English',getWatchdogSetting:()=> 'off',getWatchdogAgentOverride(){},getWorkMode:()=> 'operator',providerSemaphore:{run:async(_m:string,fn:any)=>fn()},executionHistory:{start:()=>({}),end(){}},displayName:(s:string)=>s,shortModel:(s:string)=>s,resolvedModel:()=> 'fake/primary',resolvedThinking:()=> 'off',resolveThinkingLevel:()=> 'off',resolvedSubagentModel:()=> 'fake/model',substitutedModel:(m:any)=>m,modelWindowLookup:()=>()=>undefined,specialistProjectPolicyPaths:()=>['AGENTS.md'],guardrailEnv:()=>f.env,appendInputArtifacts:(p:string)=>p+'\nINPUT_ARTIFACT original failure evidence',appendDeclaredScope:(p:string,s:string[])=>p+'\nDECLARED_SCOPE '+s.join(','),flushTimelineStore(){},appendTimelineText(){},appendTimelineEvent(){},createTranscriptStore:()=>({append(){}}),updateWidget(){},startDelegationWatch(){},dispatchViaComs:async()=>null,runDriftJudge:async()=>null,notifyProviderQueue(){},spawnPiAgentWithModelFallback,...overrides};
 return {state,deps,native:createDispatchNative(deps)};
}

const contract=()=>({taskId:'task',instructions:'bounded task',scope:['docs/a'],deliverables:['docs/out'],artifacts:['docs/input'],permissions:['read','bash'],model:'fake/primary'});
async function dispatch(w:any,f:any,c=contract()){return w.native.dispatchAgent('builder','bounded task',f.ctx??{cwd:f.root,model:{provider:'fake',id:'model'},ui:{notify(){}}},[],c.scope,false,'native',false,c);}
test('F5 independent D9 absent/off/on and D6 absent/off/on reach production seam without inference',async t=>{
 for(const d9 of ['absent','off','on'])for(const d6 of ['absent','off','on']){
  const f=await fixture(t);const discovery=createDiscoveryOwners('s',()=> 'task');t.after(()=>discovery.dispose());
  const discoveryContext={current:()=>true,registration:{owners:discovery,endpoint:'/synthetic/broker',owner:{taskId:'task',ownerId:'child',cwd:f.root,task:'bounded task',query:'docs',effectiveTools:['read','bash'],readRoots:[],exportRoots:[],canRead:()=>false,canDisplay:()=>false,permissionIdentity:()=> 'p'}}};
  const w=worker(f,{...(d9==='absent'?{}:{prepareDiscovery:()=>d9==='off'?null:discoveryContext}),...(d6==='absent'?{}:{prepareDamageGuard:d6==='off'?()=>null:f.prepare})});w.state.def.tools='read,bash';
  const result=await dispatch(w,f);assert.equal(result.exitCode,0);assert.equal(f.rows().length,1);assert.equal(f.rows()[0].assigned,d6==='on');assert.equal(f.rows()[0].safe,true);assert.equal(f.calls(),0);assert.ok(f.leases.every(l=>l.identity.signal.aborted));assert.equal(discovery.size,0);
  if(d6==='on'){assert.equal(f.inputs[0].ownerId,result.dispatchId);assert.ok(Object.isFrozen(f.inputs[0].contract));assert.ok(Object.isFrozen(f.inputs[0].contract.scope));assert.equal(f.inputs[0].contract.model,undefined);}
 }
});
test('F5 preparation and queue recheck all preserved admission predicates and immutable contract',async t=>{
 for(const phase of ['discovery','damage','queue'])for(const change of ['kill','restart','state','dispatch','session','launch','admission','tools','cwd','task','scope','permissions','revision','throws']){
  const f=await fixture(t),c=contract();let w:any,registered=true,allowed=true,session=f.session,launch='launch';const ctx:any={cwd:f.root,model:{provider:'fake',id:'model'},ui:{notify(){}}};
  const mutate=()=>{if(change==='kill')w.state.killedByOperator=true;if(change==='restart')w.state.restarting=true;if(change==='state')registered=false;if(change==='dispatch')w.state.dispatchId='other';if(change==='session')session+='other';if(change==='launch')launch='other';if(change==='admission')allowed=false;if(change==='throws')allowed=false;if(change==='tools')w.state.def.tools='read';if(change==='cwd')ctx.cwd+='other';if(change==='task')c.instructions='other';if(change==='scope')c.scope.push('wide');if(change==='permissions')c.permissions.push('write');if(change==='revision')f.revise();};
  w=worker(f,{getAgentState:()=>registered?w.state:undefined,getSessionDir:()=>session,launchIdentity:()=>launch,nativeAdmission:()=>{if(change==='throws'&&!allowed)throw Error('synthetic');return allowed;},prepareDiscovery:async()=>{if(phase==='discovery')mutate();return {current:()=>change!=='revision'||phase!=='discovery'};},prepareDamageGuard:async(i:any)=>{const r=f.prepare(i);if(phase==='damage')mutate();return r;},providerSemaphore:{run:async(_m:any,fn:any)=>{if(phase==='queue')mutate();return fn();}}});w.state.def.tools='read,bash';
  const result=await w.native.dispatchAgent('builder','bounded task',ctx,[],c.scope,false,'native',false,c);assert.equal(f.rows().length,0,phase+'/'+change);assert.notEqual(result.exitCode,0);assert.ok(f.leases.every(l=>l.identity.signal.aborted));assert.equal(f.calls(),0);
 }
});
test('F5 real fallback fresh leases, stable dispatch contract and cancellation fences without D6 or effect tools',async t=>{
 for(const mode of ['normal','deny','absent','readonly']){
  const f=await fixture(t);let w:any;const wopts:any={prepareDamageGuard:mode==='absent'?undefined:f.prepare,guardrailEnv:()=>({...f.env,MODE:'fallback'}),spawnPiAgentWithModelFallback:(opts:any,model:any,cb:any)=>spawnPiAgentWithModelFallback(opts,model,{...cb,onModelFallback:(e:any)=>{cb.onModelFallback?.(e);if(mode!=='normal')w.state.killedByOperator=true;}})};
  w=worker(f,wopts);w.state.def.tools=mode==='readonly'?'read':'read,bash';const result=await dispatch(w,f);
  assert.equal(f.rows().length,mode==='normal'?2:1);assert.equal(f.calls(),0);assert.ok(f.leases.every(l=>l.identity.signal.aborted));
  if(mode==='normal'){assert.equal(result.exitCode,0);assert.equal(new Set(f.identities.map(i=>i.attempt)).size,2);assert.equal(new Set(f.leases.map(l=>l.assignment.capability)).size,2);assert.equal(f.inputs.length,1);assert.deepEqual(f.inputs[0].contract.scope,['docs/a']);assert.equal(f.inputs[0].ownerId,result.dispatchId);assert.ok(f.identities.every(i=>i.owner.startsWith(result.dispatchId+':')));}
 }
});
test('F5 deferred physical open revokes stale input and failed launch cleans up',async t=>{
 for(const mode of ['revision','kill','scope','cwd','failed']){
 const f=await fixture(t),entered=deferred(),release=deferred(),c=contract(),ctx:any={cwd:f.root,model:{provider:'fake',id:'model'},ui:{notify(){}}};let w:any;
 if(mode!=='failed')f.setWait(async()=>{entered.resolve();await release.promise;});
 w=worker(f,{prepareDamageGuard:f.prepare,...(mode==='failed'?{guardrailEnv:()=>({...f.env,PATH:'/nonexistent'})}:{})});w.state.def.tools='read,bash';
 const pending=w.native.dispatchAgent('builder','bounded task',ctx,[],c.scope,false,'native',false,c);if(mode!=='failed'){assert.equal(await Promise.race([entered.promise.then(()=> 'entered'),pending.then(()=> 'finished')]),'entered');if(mode==='revision')f.revise();if(mode==='kill')w.state.killedByOperator=true;if(mode==='scope')c.scope.push('wide');if(mode==='cwd')ctx.cwd+='other';release.resolve();}
 const result=await pending;if(mode!=='failed')assert.equal(result.lifecycle?.launched,false);else assert.match(result.diagnostics?.spawnError??'',/ENOENT/);assert.equal(f.rows().length,0);assert.equal(f.leases.length,1);assert.ok(f.leases[0].identity.signal.aborted);assert.equal(f.calls(),0);
 }
});
test('F5 corrupt-session clean retry remints capability and rechecks authority even without D6',async t=>{
 for(const mode of ['normal','cancel','absent','readonly']){
  const f=await fixture(t);let w:any;const ctx:any={cwd:f.root,model:{provider:'fake',id:'model'},ui:{notify(text:string){if(mode!=='normal'&&text.includes('retrying once'))w.state.killedByOperator=true;}}};
  w=worker(f,{prepareDamageGuard:mode==='absent'?undefined:f.prepare,guardrailEnv:()=>({...f.env,MODE:'corrupt'})});w.state.def.tools=mode==='readonly'?'read':'read,bash';w.state.def.fallbackModel='fake/primary';
  const result=await w.native.dispatchAgent('builder','bounded task',ctx,[],['docs/a'],false,'native',false,contract());
  assert.equal(f.rows().length,mode==='normal'?2:1);assert.ok(f.leases.every(l=>l.identity.signal.aborted));assert.equal(f.calls(),0);
  if(mode==='normal'){assert.equal(result.exitCode,0);assert.equal(new Set(f.identities.map(i=>i.attempt)).size,2);assert.equal(new Set(f.leases.map(l=>l.assignment.capability)).size,2);assert.equal(f.inputs.length,1);assert.equal(result.sessionReset?.retried,true);}
 }
});
test('F5 false or throwing supplied validation fails closed for non-effect tools',async t=>{
 for(const mode of ['false','throw']){const f=await fixture(t),w=worker(f,{prepareDamageGuard:()=>({tools:['bash'],validate(){if(mode==='throw')throw Error('synthetic');return false;},open(){throw Error('must not open');}})});
  const result=await dispatch(w,f);assert.equal(result.lifecycle?.launched,false);assert.equal(f.rows().length,0);assert.equal(f.calls(),0);
 }
});
test('F5 model and environment changes do not change admitted contract or tool caps and safety order',async t=>{
 const f=await fixture(t),c=contract();let w:any;
 w=worker(f,{prepareDamageGuard:(i:any)=>{c.model='fake/authority-forgery';return f.prepare(i);},guardrailEnv:()=>({...f.env,MODE:'fallback',AF_D6_UNKNOWN:'forged'}),spawnPiAgentWithModelFallback:(opts:any,model:any,cb:any)=>spawnPiAgentWithModelFallback(opts,model,{...cb,onModelFallback:(e:any)=>{cb.onModelFallback?.(e);c.model='fake/another';}})});w.state.def.tools='read,bash';
 const result=await dispatch(w,f,c);assert.equal(result.exitCode,0);assert.equal(f.rows().length,2);assert.deepEqual(f.inputs[0].contract.permissions,['bash','read']);// Every native specialist also receives the structured submit_result report tool.
 assert.deepEqual(f.inputs[0].tools,['read','bash','submit_result']);
 for(const row of f.rows()){assert.equal(row.tools,'read,bash,submit_result');assert.equal(row.cwd,f.root);assert.equal(row.extensions[0],'safety');assert.equal(row.extensions.filter((p:string)=>p==='safety').length,1);assert.equal(row.safe,true);}
 assert.ok(f.leases.every(l=>l.identity.signal.aborted));assert.equal(f.calls(),0);
});
test('F5 independent deferred discovery, D6 preparation and queue fence mutations made while waiting',async t=>{
 for(const phase of ['discovery','damage','queue'])for(const change of ['cancel','scope','cwd','discovery']){
  const f=await fixture(t),c=contract(),entered=deferred(),release=deferred();let discoveryCurrent=true;
  const wait=async()=>{entered.resolve();await release.promise;};
  const w=worker(f,{prepareDiscovery:async()=>{if(phase==='discovery')await wait();return {current:()=>discoveryCurrent};},prepareDamageGuard:async(i:any)=>{if(phase==='damage')await wait();return f.prepare(i);},providerSemaphore:{run:async(_m:any,fn:any)=>{if(phase==='queue')await wait();return fn();}}});w.state.def.tools='read,bash';
  const ctx:any={cwd:f.root,model:{provider:'fake',id:'model'},ui:{notify(){}}};
  const pending=w.native.dispatchAgent('builder','bounded task',ctx,[],c.scope,false,'native',false,c);
  try{await entered.promise;if(change==='cancel')w.state.killedByOperator=true;if(change==='scope')c.scope.push('wide');if(change==='cwd')ctx.cwd+='other';if(change==='discovery')discoveryCurrent=false;release.resolve();
   const result=await pending;assert.equal(result.lifecycle?.launched,false);assert.equal(f.rows().length,0);assert.equal(f.leases.length,0);assert.equal(f.calls(),0);
  }finally{release.resolve();}
 }
});
