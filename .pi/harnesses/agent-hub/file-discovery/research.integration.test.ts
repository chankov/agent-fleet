import test from 'node:test';
import assert from 'node:assert/strict';
import {createResearchRuntime} from '../research/runtime.ts';
import {spawnPiAgentWithModelFallback} from '../spawn.ts';
import {nativeFixture} from './native-fixture.test-support.ts';
function research(f:any,overrides:any={}) {
 let states=new Map(),next=1;
 const deps:any={getResearchStates:()=>states,setResearchStates:(v:any)=>states=v,getNextResearchId:()=>next,setNextResearchId:(v:number)=>next=v,hubState:{getSessionDir:()=>f.session},budget:{currentBudget:()=>({agentTurnMs:20000})},artifacts:{appendInputArtifacts:(p:string)=>p+'\nINPUT_ARTIFACT exact'},executionHistory:{start:()=>({}),end(){}},providerSemaphore:{run:async(_m:string,fn:any)=>fn()},getSafetyHarnessPath:()=> 'safety',getReconSearchTimeoutMs:()=>1000,getContextWindow:()=>10000,resolvedModel:()=> 'fake/model',resolvedThinking:()=> 'off',resolveThinkingLevel:()=> 'off',fallbackModelFor:()=> 'fake/model',substitutedModel:(m:any)=>m,modelWindowLookup:()=>()=>undefined,guardrailEnv:()=>f.env,notifyProviderQueue(){},getProjectPolicyPaths:()=>['AGENTS.md'],getProjectDocsPaths:()=>['docs/PHILOSOPHY.md'],nativeResearchSystemPrompt:()=> 'MANDATORY_POLICY',requireSafetyHarness:()=>({ok:true,extensions:[]}),shortModel:(m:string)=>m,displayName:(s:string)=>s,flushTimelineStore(){},appendTimelineText(){},appendTimelineEvent(){},createTranscriptStore:()=>({append(){}}),spawnPiAgentWithModelFallback,prepareDiscovery:f.prepare,...overrides};
 const runtime=createResearchRuntime(deps);const def={name:'researcher',description:'research',tools:'read,find',toolsExplicit:true,file:'researcher.md',systemPrompt:'policy'};
 return {runtime,state:runtime.createState(def,true,'fake/primary')};
}
test('T8 production research gates -> initial FULL manifest -> actual registered child tool_result before next model step; fallback fresh identity no keys, explicit caps, pages through permitted read without bounded-output',async t=>{
 const f=nativeFixture(t,300,12000,{maxEvaluationsPerJob:1}),r=research(f);const result=await r.runtime.spawn(r.state,'own rounding query',f.ctx,[],undefined,{readScope:f.paths});
 assert.equal(result.exitCode,0);const rows=f.rows();assert.equal(rows.length,2);assert.notEqual(rows[0].attempt,rows[1].attempt);
 for(const row of rows){assert.equal(row.tools,'read,find');assert.ok(row.keyAbsent&&row.registered&&row.modelStepAfterAdvice);assert.match(row.prompt,/INPUT_ARTIFACT exact/);assert.match(row.prompt,/File discovery context/);assert.ok(row.prompt.includes('"total":300'));assert.equal(row.advice.total,300);assert.equal(row.pageRows,300);assert.ok(row.readPages>1);assert.deepEqual(row.original,{type:'text',text:f.paths.map((p:string)=>p.slice(5)).join('\n')});}
 assert.equal(f.calls(),1);assert.equal(f.channel().owners.size,0);
});
test('T8 pre-manifest and post-await cancellation/task/admission/queued rechecks start no child; safety gate before prepare',async t=>{
 for(const mode of ['pre','cancel','task','admission','tools','queue','safety']){
  const f=nativeFixture(t),controller=new AbortController();let allowed=true,prepared=0,spawned=0;
  const r=research(f,{prepareDiscovery:async(input:any)=>{prepared++;const result=await f.prepare(input);if(mode==='cancel')controller.abort();if(mode==='task')f.switchTask();if(mode==='admission')allowed=false;if(mode==='tools')r.state.def.tools='find';return result;},requireSafetyHarness:()=>mode==='safety'?{ok:false,error:'refused safety'}:{ok:true,extensions:[]},providerSemaphore:{run:async(_m:string,fn:any)=>{if(mode==='queue')allowed=false;return fn();}},spawnPiAgentWithModelFallback:async()=>{spawned++;throw Error('must not spawn');}});
  if(mode==='pre')controller.abort();const result=await r.runtime.spawn(r.state,'query',f.ctx,[],controller.signal,{readScope:f.paths,admit:()=>allowed});
  assert.notEqual(result.exitCode,0);assert.equal(spawned,0);assert.equal(result.lifecycle?.launched,false);assert.equal(prepared,mode==='pre'||mode==='safety'?0:1);
 }
});
test('T8 actual failed research physical spawn closes registry and finalizes evidence',async t=>{
 const f=nativeFixture(t),r=research(f,{guardrailEnv:()=>({PATH:'/nonexistent'})});
 const result=await r.runtime.spawn(r.state,'query',f.ctx,[],undefined,{readScope:f.paths});
 assert.notEqual(result.exitCode,0);assert.match(result.output,/Error spawning research/);assert.equal(f.channel().owners.size,0);assert.equal(r.runtime.states().size,0);
});
test('T8 no read_scope uses current same-task candidates, else bounded approved roots; failed transport explicit original evidence fallback and find-only no export',async t=>{
 const f=nativeFixture(t);const input={ownerId:'native',task:'own task',query:'own query',scope:[],tools:['read','find'],cwd:f.root};
 const initial=await f.prepare(input);assert.equal((initial!.manifest as any).rows.length,3);
 const before=f.calls();await f.hooks.tool_result[0]({toolName:'find',input:{path:'docs'},toolCallId:'parent',content:[{type:'text',text:'file-0.ts\nfile-1.ts'}],details:{}},f.ctx);
 const reused=await f.prepare({...input,ownerId:'native-2'});assert.equal((reused!.manifest as any).rows.length,2);assert.ok(f.calls()>=before);
 await f.hooks.tool_result[0]({toolName:'find',input:{path:'docs'},toolCallId:'partial',content:[{type:'text',text:'file-0.ts\nfile-1.ts\n\n[2 results limit reached. Use limit=4 for more, or refine pattern]'}],details:{resultLimitReached:2}},f.ctx);
 const partial=await f.prepare({...input,ownerId:'partial'});assert.equal((partial!.manifest as any).discoveryComplete,false);assert.equal((partial!.manifest as any).remaining,'unknown');
 const denied=await f.prepare({...input,tools:['find']});assert.equal((denied!.manifest as any).reason,'owner_read_not_permitted');assert.equal(denied!.registration,undefined);
 const r=research(f,{prepareDiscovery:async(i:any)=>{const prepared=await f.prepare(i);return {...prepared,registration:{...prepared!.registration,endpoint:'/tmp/nonexistent-d9-channel'}};}});
 const result=await r.runtime.spawn(r.state,'query',f.ctx,[],undefined,{readScope:f.paths});assert.equal(result.exitCode,0);
 for(const row of f.rows()){assert.equal(row.advice.status,'unavailable');assert.equal(row.advice.reason,'channel_unavailable');assert.equal(row.original.text,f.paths.map((p:string)=>p.slice(5)).join('\n'));}
});

test('T8 production child extension session cancellation during awaited broker discovery fences advice before next model step',async t=>{
 const {openDiscoveryAttempt}=await import('./owners.ts');const {discoveryHubRuntime}=await import('./hub.ts');const {default:registerChild}=await import('./child-extension.ts');
 const f=nativeFixture(t),prepared=await f.prepare({ownerId:'cancel-child',task:'own task',query:'own query',scope:f.paths,tools:['read','find'],cwd:f.root});
 const attempt=openDiscoveryAttempt(prepared!.registration!);t.after(()=>attempt.revoke());
 const prior={...process.env};Object.assign(process.env,attempt.env);const hooks:Record<string,Function>={};
 try{registerChild({on:(e:string,fn:Function)=>hooks[e]=fn,registerTool(){throw Error('no extra tools');}} as any);}finally{for(const key of Object.keys(attempt.env))if(prior[key]===undefined)delete process.env[key];else process.env[key]=prior[key];}
 const runtime=discoveryHubRuntime(f.pi)!;const original=runtime.rank.bind(runtime);let started!:()=>void,release!:()=>void;const ready=new Promise<void>(r=>started=r),gate=new Promise<void>(r=>release=r);
 runtime.rank=async job=>{started();await gate;return original(job);};
 const result=hooks.tool_result({toolName:'find',input:{path:'docs'},toolCallId:'cancel',content:[{type:'text',text:'file-0.ts\nfile-1.ts'}],details:{}},f.ctx);
 await ready;hooks.session_before_switch();release();const cancelled=await result;assert.equal(cancelled.details.fileDiscovery.status,'cancelled');assert.equal(cancelled.details.fileDiscovery.rows,undefined);assert.equal(cancelled.content[0].text,'file-0.ts\nfile-1.ts');
});
