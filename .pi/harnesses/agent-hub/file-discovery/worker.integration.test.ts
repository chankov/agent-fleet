import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync,renameSync} from 'node:fs';
import {createDispatchNative} from '../dispatch-native.ts';
import {spawnPiAgentWithModelFallback} from '../spawn.ts';
import {sourceHash} from '../agentic-sources.ts';
import {createCommunicationStore} from '../system1-communication-store.ts';
import {rankDiscovery} from './broker-client.ts';
import {BROKER_LIMITS} from './broker.ts';
import {FILE_DISCOVERY_LIMITS} from '../../lib/system1/config-file-discovery.js';
import {createChildHookHarness,nativeFixture} from './native-fixture.test-support.ts';
function worker(f:any,overrides:any={}) {
 const state:any={def:{name:'builder',description:'builder',tools:'read,find',toolsExplicit:true,systemPrompt:'MANDATORY POLICY\nUse skills/incremental-implementation/SKILL.md',file:'agents/builder.md',fallbackModel:'fake/model'},status:'idle',task:'',toolCount:0,messageCount:0,elapsed:0,lastWork:'',contextPct:0,contextTokens:0,sessionFile:null,runCount:0,runsSinceFresh:0,timeline:[]};
 const deps:any={getAgentState:()=>state,listAgentStates:()=>[state],getSessionDir:()=>f.session,getDispatchPolicy:()=>({default:'native',grace_s:0,substitutions:{}}),isComsReady:()=>false,getIdentity:()=>null,peersInScope:()=>[],wasComsMissNotified:()=>false,markComsMissNotified(){},startMonitorChild(){},finalizeMonitorChild(){},registerMonitorWaitOnly(){},registerMonitorProcess(){},appendMonitorOutput(){},getContextWindow:()=>100000,currentBudget:()=>({delegation:false,agentTurnMs:20000}),bumpRecycle(){},bumpDriftStop(){},getSessionHealthIo:()=>({existsSync,readFileSync,renameSync}),getSafetyHarnessPath:()=> 'safety',getDelegateExtensionPath:()=>null,getReconSearchTimeoutMs:()=>1000,getProjectDocsPaths:()=>['docs/PHILOSOPHY.md'],getUserLanguage:()=> 'English',getWatchdogSetting:()=> 'off',getWatchdogAgentOverride(){},getWorkMode:()=> 'operator',providerSemaphore:{run:async(_m:string,fn:any)=>fn()},executionHistory:{start:()=>({}),end(){}},displayName:(s:string)=>s,shortModel:(s:string)=>s,resolvedModel:()=> 'fake/primary',resolvedThinking:()=> 'off',resolveThinkingLevel:()=> 'off',resolvedSubagentModel:()=> 'fake/model',substitutedModel:(m:any)=>m,modelWindowLookup:()=>()=>undefined,specialistProjectPolicyPaths:()=>['AGENTS.md'],guardrailEnv:()=>f.env,appendInputArtifacts:(p:string)=>p+'\nINPUT_ARTIFACT original failure evidence',appendDeclaredScope:(p:string,s:string[])=>p+'\nDECLARED_SCOPE '+s.join(','),flushTimelineStore(){},appendTimelineText(){},appendTimelineEvent(){},createTranscriptStore:()=>({append(){}}),updateWidget(){},startDelegationWatch(){},dispatchViaComs:async()=>null,runDriftJudge:async()=>null,notifyProviderQueue(){},spawnPiAgentWithModelFallback,prepareDiscovery:f.prepare,...overrides};
 return {state,deps,native:createDispatchNative(deps)};
}
test('T9 actual native prepare/spawn keeps separate FULL context, policy/acceptance/scope/evidence; fallback fresh leases and exact resume contract',async t=>{
 const f=nativeFixture(t),w=worker(f),task='own worker rounding\nA3 acceptance remains VERBATIM\nDELIVERABLE exact';
 const contract={taskId:'task',instructions:task,scope:f.paths,deliverables:['docs/result'],artifacts:[],model:'fake/primary',permissions:'read,find'};
 const result=await w.native.dispatchAgent('builder',task,f.ctx,[],f.paths,false,'native',false,contract);assert.equal(result.exitCode,0);
 const continued=await w.native.dispatchAgent('builder','USER_ANSWER exact resume',f.ctx,[],f.paths,false,'native',true,contract);assert.equal(continued.exitCode,0);
 const rows=f.rows();assert.equal(rows.length,4);assert.equal(new Set(rows.map((r:any)=>r.attempt)).size,4);assert.equal(rows[0].resume,false);assert.equal(rows[2].resume,true);
 for(const row of rows){assert.match(row.systemPrompt,/Read the persona source before work and applicable project rules before edits or commands/);assert.match(row.systemPrompt,/skills\/incremental-implementation\/SKILL.md/);assert.match(row.systemPrompt,/AGENTS.md/);assert.ok(row.keyAbsent&&row.registered&&row.modelStepAfterAdvice);assert.equal(row.tools,'read,find');assert.match(row.prompt,/DECLARED_SCOPE docs\/file-0.ts,docs\/file-1.ts,docs\/file-2.ts/);assert.match(row.prompt,/INPUT_ARTIFACT original failure evidence/);assert.match(row.prompt,/File discovery context \(advisory, separate/);assert.equal(row.advice.rows.length,3);assert.equal(row.advice.taskHash,sourceHash(task));assert.equal(row.advice.queryHash,sourceHash(JSON.stringify([task,f.paths])));}
 assert.match(rows[0].prompt,/A3 acceptance remains VERBATIM/);assert.match(rows[2].prompt,/USER_ANSWER exact resume/);assert.equal(w.state.resumeContract.instructions,task.replace(/\s+/g,' '));assert.deepEqual(w.state.resumeContract.scope,f.paths);assert.equal(f.channel().owners.size,0);
});
test('T9 overlapping native owners keep own task/query/scope and immutable per-attempt identity, never parent or other owner query',async t=>{
 const f=nativeFixture(t),a=worker(f),b=worker(f);b.state.def.name='verifier';const scopes=[[f.paths[0]],[f.paths[1]]],tasks=['builder own query','verifier separate query'];
 const results=await Promise.all([a.native.dispatchAgent('builder',tasks[0],f.ctx,[],scopes[0],false,'native'),b.native.dispatchAgent('verifier',tasks[1],f.ctx,[],scopes[1],false,'native')]);assert.ok(results.every(r=>r.exitCode===0));
 const rows=f.rows();assert.equal(new Set(rows.map((r:any)=>r.attempt)).size,4);
 for(let i=0;i<2;i++){const own=rows.filter((r:any)=>r.prompt.startsWith(tasks[i]));assert.equal(own.length,2);for(const row of own){assert.equal(row.advice.taskHash,sourceHash(tasks[i]));assert.equal(row.advice.queryHash,sourceHash(JSON.stringify([tasks[i],scopes[i]])));assert.ok(row.prompt.includes('DECLARED_SCOPE '+scopes[i][0]));}}
 assert.equal(f.channel().owners.size,0);
});
test('T9 native manifest post-await gate/kill/restart/task/session/queue rechecks refuse startup; actual failed spawn revokes',async t=>{
 for(const mode of ['kill','restart','task','session','admission','tools','queue','failed']){
  const f=nativeFixture(t);let allowed=true,session=f.session,spawns=0;let w:any;
  w=worker(f,{getSessionDir:()=>session,nativeAdmission:()=>allowed,prepareDiscovery:async(i:any)=>{const prepared=await f.prepare(i);if(mode==='kill')w.state.killedByOperator=true;if(mode==='restart')w.state.restarting=true;if(mode==='task')f.switchTask();if(mode==='session')session+='-new';if(mode==='admission')allowed=false;if(mode==='tools')w.state.def.tools='find';return prepared;},providerSemaphore:{run:async(_m:string,fn:any)=>{if(mode==='queue')allowed=false;return fn();}},...(mode==='failed'?{guardrailEnv:()=>({PATH:'/nonexistent'})}:{spawnPiAgentWithModelFallback:async()=>{spawns++;throw Error('must not launch');}})});
  const result=await w.native.dispatchAgent('builder','own query',f.ctx,[],f.paths,false,'native');assert.notEqual(result.exitCode,0);assert.equal(spawns,0);assert.equal(f.channel().owners.size,0);
  if(mode!=='failed')assert.equal(result.lifecycle?.launched,false);
 }
});
function until<T>(promise:Promise<T>,ms=8000):Promise<T>{
 return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('barrier timeout')),ms);promise.then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});});
}
test('production child hook projects broker deadline as unavailable and session switch or shutdown as cancelled',async t=>{
 const deadline=await createChildHookHarness(t,{requestMs:4000});
 const pending=deadline.runHook('deadline');
 assert.equal(await Promise.race([deadline.entered().then(()=>'entered'),pending.then(()=>'early')]),'entered');
 const result=await until(pending,15000);assert.equal(result.code,0,result.err);assert.equal(result.advice.status,'unavailable');assert.equal(result.advice.reason,'deadline');
 assert.deepEqual(result.advice.original,{type:'text',text:'a.ts\nb.ts'});assert.match(result.advice.extra,/File discovery advice/);
 const ranked=await until(deadline.nextRank());assert.equal(ranked.status,'unavailable');assert.ok(ranked.rows.every((row:any)=>row.reason==='deadline'));
 assert.equal(deadline.store.snapshot().at(-1).status,'unavailable');assert.equal(deadline.clock().fired,0);
 assert.equal(deadline.lease.signal.aborted,false);assert.equal(deadline.lease.attemptSignal.aborted,false);assert.equal(deadline.owners.size,1);
 assert.ok(!JSON.stringify(result.advice).includes('safe child bytes'));
 for(const mode of ['switch','shutdown'] as const){
  const harness=await createChildHookHarness(t,{requestMs:20000});const cancelled=await until(harness.runHook(mode),15000);
  assert.equal(cancelled.code,0,cancelled.err);assert.equal(cancelled.advice.status,'cancelled');assert.notEqual(cancelled.advice.reason,'deadline');
  assert.equal(harness.lease.attemptSignal.aborted,false);assert.equal(harness.clock().fired,0);
 }
});
test('native fixture store observes client deadline before the runtime job timer and does not revoke the owner',async t=>{
 const store=createCommunicationStore();store.setEnabled(true);const f=nativeFixture(t,3,32768,{},{store});
 let entered!:()=>void;const ready=new Promise<void>(r=>entered=r);f.service.evaluate=async()=>{entered();return new Promise(()=>{});};
 const channel=f.channel()!;const broker=await channel.ready;assert.ok(broker);
 const lease=channel.owners.register({taskId:'task',ownerId:'fixture-worker',attemptId:'fixture-attempt',cwd:f.root,task:'rounding',query:'docs',effectiveTools:['find','read'],readRoots:['docs'],exportRoots:['docs'],canRead:()=>true,canDisplay:()=>true,permissionIdentity:()=>'v1'});
 const assignment=channel.owners.assignment(lease,broker.endpoint);
 const pending=rankDiscovery(assignment,{paths:['docs/file-0.ts','docs/file-1.ts'],discovery:{complete:true}},undefined,4000);
 assert.equal(await Promise.race([ready.then(()=>'entered'),pending.then(()=>'early')]),'entered');
 const client=await until(pending) as any;assert.equal(client.error,'deadline');
 for(let i=0;i<40&&store.snapshot().at(-1)?.status==='pending';i++)await new Promise(r=>setTimeout(r,50));
 assert.equal(store.snapshot().at(-1)!.status,'unavailable');
 assert.equal(lease.signal.aborted,false);assert.equal(lease.attemptSignal.aborted,false);assert.equal(channel.owners.size,1);
 assert.ok(!JSON.stringify(store.snapshot()).includes('safe native rounding code'));
});
function childEvidence(result:any){
 assert.equal(result.code,0,result.err);assert.deepEqual(result.advice.original,{type:'text',text:'a.ts\nb.ts'});assert.match(result.advice.extra,/File discovery advice/);
 assert.ok(!JSON.stringify(result.advice).includes('safe child bytes'));assert.ok(result.advice.events.includes('tool_result'));
}
const lateSuccess=()=>({status:'ok',evaluation:{answers:[{questionId:'d9_relevance',type:'ordinal',value:3,levels:['unrelated','supporting','directly relevant','primary'],uncertainty:{provenance:'provider',confidence:0.91,distribution:[0,0,0,1]}},{questionId:'d9_role',type:'choice',value:'implementation',uncertainty:{provenance:'provider',confidence:0.91,distribution:[1,0,0,0,0,0]}}],metadata:{attempts:1,usage:{inputTokens:3,outputTokens:2}}}});
test('registered production child hook projects a client-timer ACK as unavailable deadline before broker and runtime timers',async t=>{
 assert.equal(BROKER_LIMITS.requestMs,20000);assert.equal(BROKER_LIMITS.partialFrameMs,1000);assert.equal(FILE_DISCOVERY_LIMITS.jobTimeoutMs,20000);assert.equal(FILE_DISCOVERY_LIMITS.discoveryMs,1000);
 const harness=await createChildHookHarness(t,{requestMs:8000});const started=Date.now();const pending=harness.runHook('client-deadline');
 assert.equal(await Promise.race([harness.entered().then(()=>'entered'),pending.then(()=>'early')]),'entered');
 const result=await until(pending,8000);const elapsed=Date.now()-started;childEvidence(result);
 assert.equal(result.advice.status,'unavailable');assert.equal(result.advice.reason,'deadline');assert.equal(result.advice.injected,1);assert.equal(result.advice.clientTimerShortened,1);assert.equal(result.advice.fault,'');
 assert.ok(elapsed<3000,'client timer elapsed '+elapsed);
 const ranked=await until(harness.nextRank());assert.equal(ranked.status,'unavailable');assert.ok(ranked.rows.every((row:any)=>row.reason==='deadline'));
 assert.equal(harness.store.snapshot().length,1);assert.equal(harness.store.snapshot().at(-1).status,'unavailable');assert.notEqual(harness.store.snapshot().at(-1).status,'cancelled');
 assert.equal(harness.clock().fired,0);assert.equal(harness.lease.signal.aborted,false);assert.equal(harness.lease.attemptSignal.aborted,false);assert.equal(harness.owners.size,1);
 assert.ok(!JSON.stringify(harness.store.snapshot()).includes('safe child bytes'));assert.ok(!JSON.stringify(harness.store.snapshot()).includes(harness.lease.capability));
});
test('registered production child hook maps undelivered terminal EPIPE, end/close and ACK cleanup expiry to channel_unavailable and parent cancellation',async t=>{
 assert.equal(BROKER_LIMITS.partialFrameMs,1000);assert.equal(FILE_DISCOVERY_LIMITS.jobTimeoutMs,20000);
 const elapsed:Record<string,number>={};
 for(const mode of ['client-epipe','client-end','client-cleanup'] as const){
  const harness=await createChildHookHarness(t,{requestMs:8000});const started=Date.now();const pending=harness.runHook(mode);
  assert.equal(await Promise.race([harness.entered().then(()=>'entered'),pending.then(()=>'early')]),'entered',mode);
  const result=await until(pending,8000);elapsed[mode]=Date.now()-started;childEvidence(result);
  assert.equal(result.advice.injected,1,mode);assert.equal(result.advice.clientTimerShortened,1,mode);assert.equal(result.advice.fault,mode.slice('client-'.length)==='cleanup'?'silent':mode.slice('client-'.length),mode);
  assert.equal(result.advice.status,'unavailable',mode);assert.equal(result.advice.reason,'channel_unavailable',mode);assert.notEqual(result.advice.reason,'deadline',mode);
  const ranked=await until(harness.nextRank());assert.equal(ranked.status,'cancelled',mode);assert.ok(ranked.rows.every((row:any)=>row.reason==='cancelled'&&row.status!=='scored'),mode);
  assert.equal(harness.store.snapshot().length,1,mode);assert.equal(harness.store.snapshot().at(-1).status,'cancelled',mode);assert.notEqual(harness.store.snapshot().at(-1).status,'unavailable',mode);
  assert.equal(harness.clock().fired,0,mode);assert.equal(harness.lease.signal.aborted,false,mode);assert.equal(harness.lease.attemptSignal.aborted,false,mode);assert.equal(harness.owners.size,1,mode);
  assert.ok(!JSON.stringify(harness.store.snapshot()).includes('safe child bytes'));assert.ok(!JSON.stringify(ranked).includes('safe child bytes'));assert.ok(!JSON.stringify(harness.store.snapshot()).includes(harness.lease.capability));
 }
 assert.ok(elapsed['client-cleanup']>=elapsed['client-epipe']+700,'cleanup '+elapsed['client-cleanup']+' vs epipe '+elapsed['client-epipe']);
 assert.ok(elapsed['client-cleanup']<6000,'cleanup must be the 1000ms ACK bound, not the broker timer');
});
test('late provider success cannot overwrite a failed child-hook terminal delivery or its cancelled observation',async t=>{
 const harness=await createChildHookHarness(t,{requestMs:8000});const pending=harness.runHook('client-epipe');
 assert.equal(await Promise.race([harness.entered().then(()=>'entered'),pending.then(()=>'early')]),'entered');
 const result=await until(pending,8000);const ranked=await until(harness.nextRank());childEvidence(result);
 assert.equal(result.advice.reason,'channel_unavailable');assert.equal(ranked.status,'cancelled');assert.equal(harness.store.snapshot().at(-1).status,'cancelled');
 const before=JSON.stringify(harness.store.snapshot());harness.releaseEval(lateSuccess());await new Promise(r=>setTimeout(r,80));
 assert.equal(JSON.stringify(harness.store.snapshot()),before);assert.equal(ranked.status,'cancelled');assert.ok(ranked.rows.every((row:any)=>row.reason==='cancelled'&&row.status!=='scored'));
 assert.equal(result.advice.reason,'channel_unavailable');assert.equal(harness.ranks(),1);assert.equal(harness.lease.signal.aborted,false);assert.equal(harness.lease.attemptSignal.aborted,false);
});
