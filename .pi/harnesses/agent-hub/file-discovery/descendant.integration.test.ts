import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync,renameSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createDispatchNative} from '../dispatch-native.ts';
import {spawnPiAgentWithModelFallback} from '../spawn.ts';
import {sourceHash} from '../agentic-sources.ts';
import {rankDiscovery,registerDescendant,revokeDiscoveryAttempt} from './broker-client.ts';
import {nativeFixture} from './native-fixture.test-support.ts';

function chain(t:any,mode='normal',count=3) {
 const f=nativeFixture(t,count,count>255?12000:32768,count>255?{maxEvaluationsPerJob:1}:{}),delegate=resolve('.pi/harnesses/agent-hub/delegate.ts');
 const state:any={def:{name:'builder',description:'builder',tools:'read,find',toolsExplicit:true,systemPrompt:'MANDATORY POLICY',file:'agents/builder.md',subagents:{recon:{model:'fake/primary',fallbackModel:'fake/model',tools:'read,find'},finder:{model:'fake/model',tools:'find'}},delegateDepth:1},status:'idle',task:'',toolCount:0,messageCount:0,elapsed:0,lastWork:'',contextPct:0,contextTokens:0,sessionFile:null,runCount:0,runsSinceFresh:0,timeline:[]};
 const deps:any={getAgentState:()=>state,listAgentStates:()=>[state],getSessionDir:()=>f.session,getDispatchPolicy:()=>({default:'native',grace_s:0,substitutions:{}}),isComsReady:()=>false,getIdentity:()=>null,peersInScope:()=>[],wasComsMissNotified:()=>false,markComsMissNotified(){},startMonitorChild(){},finalizeMonitorChild(){},registerMonitorWaitOnly(){},registerMonitorProcess(){},appendMonitorOutput(){},getContextWindow:()=>100000,currentBudget:()=>({delegation:true,agentTurnMs:20000}),bumpRecycle(){},bumpDriftStop(){},getSessionHealthIo:()=>({existsSync,readFileSync,renameSync}),getSafetyHarnessPath:()=> 'safety',getDelegateExtensionPath:()=>delegate,getReconSearchTimeoutMs:()=>1000,getProjectDocsPaths:()=>['docs/ARCHITECTURE.md'],getUserLanguage:()=> 'English',getWatchdogSetting:()=> 'off',getWatchdogAgentOverride(){},getWorkMode:()=> 'operator',providerSemaphore:{run:async(_m:string,fn:any)=>fn()},executionHistory:{start:()=>({}),end(){}},displayName:(s:string)=>s,shortModel:(s:string)=>s,resolvedModel:()=> 'fake/model',resolvedThinking:()=> 'off',resolveThinkingLevel:()=> 'off',resolvedSubagentModel:(_d:any,_r:any,c:any)=>c.model,substitutedModel:(m:any)=>m,modelWindowLookup:()=>()=>undefined,specialistProjectPolicyPaths:()=>['AGENTS.md'],guardrailEnv:()=>({...f.env,CHAIN_MODE:mode}),appendInputArtifacts:(p:string)=>p+'\nORIGINAL EVIDENCE',appendDeclaredScope:(p:string,s:string[])=>p+'\nDECLARED_SCOPE '+s.join(','),flushTimelineStore(){},appendTimelineText(){},appendTimelineEvent(){},createTranscriptStore:()=>({append(){}}),updateWidget(){},startDelegationWatch(){},dispatchViaComs:async()=>null,runDriftJudge:async()=>null,notifyProviderQueue(){},spawnPiAgentWithModelFallback,prepareDiscovery:f.prepare};
 const guard=pathToFileURL(resolve('bin/test/helpers/system1-no-network.js')).href;
 writeFileSync(join(f.root,'pi'),`#!/usr/bin/env node
(async()=>{
 await import(${JSON.stringify(guard)});process.env.PI_OFFLINE='1';
 const fs=require('node:fs'),url=require('node:url'),crypto=require('node:crypto');const args=process.argv;
 let prompt='';for await(const chunk of process.stdin)prompt+=chunk;
 fs.writeFileSync(args[args.indexOf('--session')+1],JSON.stringify({type:'session',version:3,id:'chain'})+'\\n');
 const tools=args[args.indexOf('--tools')+1],model=args[args.indexOf('--model')+1],isWorker=tools.split(',').includes('delegate');
 const hooks={},registered={};const api={on:(e,f)=>(hooks[e]??=[]).push(f),registerTool:d=>registered[d.name]=d};
 for(const path of args.filter((v,i)=>args[i-1]==='-e'))if(path.endsWith('/delegate.ts')||path.endsWith('/file-discovery/child-extension.ts'))(await import(url.pathToFileURL(path).href)).default(api);
 let result={toolName:'find',input:{path:'docs',pattern:'*.ts'},toolCallId:'find-chain',content:[{type:'text',text:${JSON.stringify(f.paths.map(p=>p.slice(5)).join('\n'))}}],details:{}};
 for(const hook of hooks.tool_result??[]){const override=await hook(result,{cwd:process.cwd()});if(override)result={...result,...override};}
 let pageRows=0,readPages=0,next=result.details.fileDiscovery?.first;
 const {createReadTool}=await import(${JSON.stringify(pathToFileURL(resolve('node_modules/@earendil-works/pi-coding-agent/dist/index.js')).href)});
 while(next){const r=await createReadTool(process.cwd()).execute('page',{path:next.path},new AbortController().signal);const page=JSON.parse(r.content[0].text);pageRows+=page.rows.length;readPages++;next=page.next;}
 const record={pageRows,readPages,worker:isWorker,model,tools,prompt,systemPrompt:args[args.indexOf('--system-prompt')+1],appendPrompt:args[args.indexOf('--append-system-prompt')+1],owner:process.env.AF_D9_OWNER_ID,attempt:process.env.AF_D9_ATTEMPT_ID,capHash:process.env.AF_D9_CAPABILITY&&crypto.createHash('sha256').update(process.env.AF_D9_CAPABILITY).digest('hex'),keyAbsent:process.env.TYPESAFE_API_KEY==null,advice:result.details.fileDiscovery,original:result.content[0],extensionBeforeModel:!!result.details.fileDiscovery,registered:!!hooks.tool_result};
 fs.appendFileSync(process.env.REPORT,JSON.stringify(record)+'\\n');
 if(isWorker){
  if(process.env.CHAIN_MODE==='forged')process.env.AF_D9_CAPABILITY='0'.repeat(64);
  if(process.env.CHAIN_MODE==='unavailable')process.env.AF_D9_ENDPOINT='/missing-d9-socket';
  for(const role of ['unknown','recon','finder']){
   const response=await registered.delegate.execute('delegate-'+role,{role,instruction:'descendant own rounding',context:'child-specific evidence'},new AbortController().signal);
   fs.appendFileSync(process.env.REPORT,JSON.stringify({delegateResult:role,status:response.details.status,text:response.content[0].text})+'\\n');
  }
 }else if(process.env.CHAIN_MODE==='hold')await new Promise(()=>{setInterval(()=>{},1000);});
 else if(model==='fake/primary'){console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'error',errorMessage:'provider unavailable'}}));process.exitCode=1;return;}
 console.log(JSON.stringify({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'DIGEST:\\nchain complete'}}));
})().catch(e=>{console.error(e);process.exitCode=1;});
`,{mode:0o755});
 return {...f,state,native:createDispatchNative(deps)};
}

test('T10 actual parent Hub → native worker → delegate production extensions: own query/attempts, initial FULL manifest, automatic current discovery before model, shared cache/budget, no keys and narrower caps',async t=>{
 const f=chain(t),result=await f.native.dispatchAgent('builder','parent worker task',f.ctx,[],f.paths,false,'native');assert.equal(result.exitCode,0,result.output);
 const rows=f.rows(),worker=rows.find((r:any)=>r.worker),children=rows.filter((r:any)=>r.worker===false),recon=children.filter((r:any)=>r.tools==='read,find'),finder=children.find((r:any)=>r.tools==='find');
 assert.equal(children.length,3);assert.equal(recon.length,2);assert.equal(new Set([worker,...recon].map((r:any)=>r.attempt)).size,3);assert.equal(new Set([worker,...recon].map((r:any)=>r.owner)).size,3);assert.equal(new Set([worker,...recon].map((r:any)=>r.capHash)).size,3);
 for(const child of recon){assert.ok(child.keyAbsent&&child.registered&&child.extensionBeforeModel);assert.deepEqual(child.original,{type:'text',text:'file-0.ts\nfile-1.ts\nfile-2.ts'});assert.equal(child.advice.rows.length,3);assert.equal(child.advice.taskHash,sourceHash('descendant own rounding'));assert.equal(child.advice.queryHash,sourceHash(JSON.stringify(['descendant own rounding','child-specific evidence'])));assert.match(child.prompt,/child-specific evidence/);assert.match(child.prompt,/File discovery context \(advisory, separate/);const initial=JSON.parse(child.prompt.split('## File discovery context (advisory, separate from task/policy/scope/evidence)\n')[1]);assert.equal(initial.rows.length,3);assert.equal(initial.taskHash,sourceHash('descendant own rounding'));assert.equal(initial.queryHash,child.advice.queryHash);assert.match(child.appendPrompt,/AGENTS.md/);assert.match(child.appendPrompt,/docs\/ARCHITECTURE.md/);assert.match(child.appendPrompt,/remaining depth is 0/);assert.ok(child.advice.rows.every((r:any)=>r.status==='cached'));}
 assert.equal(finder.tools,'find');assert.equal(finder.advice.status,'unavailable');assert.equal(finder.advice.reason,'unauthorized');assert.ok(rows.some((r:any)=>r.delegateResult==='unknown'&&r.status==='refused'));assert.equal(f.calls(),6);assert.equal(f.channel()!.owners.size,0);
});

test('T10 production chain forged/expired parent denies registration BEFORE source evaluation; missing broker preserves normal delegate fallback and caps',async t=>{
 for(const mode of ['forged','expired','unavailable']){
  const f=chain(t,mode);
  if(mode==='expired'){const owners=f.channel()!.owners,register=owners.register.bind(owners);owners.register=(o:any)=>register(o,1);}
  const result=await f.native.dispatchAgent('builder','parent task',f.ctx,[],f.paths,false,'native');assert.equal(result.exitCode,0,result.output);
  const rows=f.rows(),worker=rows.find((r:any)=>r.worker),children=rows.filter((r:any)=>r.worker===false);
  // A 1ms lease may expire BEFORE assignment, not just before descendant registration.
  // In that case C3N3 reports unavailable on the worker and launches ordinary children
  // without a D9 assignment/context; neither path may infer or gain tools/credentials.
  const assignmentUnavailable=mode==='expired'&&!worker.registered;
  if(assignmentUnavailable)assert.match(worker.prompt,/File discovery physical attempt: unavailable \(registration unavailable\)/);
  assert.equal(children.length,3);for(const child of children){assert.equal(child.registered,false);assert.equal(child.owner,undefined);assert.ok(child.keyAbsent);
   if(assignmentUnavailable)assert.equal(child.prompt,'## Context from your parent\nchild-specific evidence\n\n## Your task\ndescendant own rounding');
   else {assert.match(child.prompt,/File discovery context/);assert.match(child.prompt,/unavailable/);}
   assert.ok(['read,find','find'].includes(child.tools));}
  assert.equal(f.calls(),3);assert.equal(f.channel()!.owners.size,0);
 }
});

test('T10 real broker bounds registration to allowed tree and tools; forged identity denies BEFORE reads',async t=>{
 const f=chain(t),context=await f.prepare({ownerId:'worker',task:'worker',query:'worker query',scope:f.paths,tools:['read','find','delegate'],cwd:f.root});
 const {openDiscoveryAttempt}=await import('./owners.ts');const parent=openDiscoveryAttempt(context!.registration!);const originalCalls=f.calls();
 const input={childId:'recon-1',task:'child',query:'child query',tools:['read','find']};
 assert.equal((await registerDescendant({...parent.assignment,capability:'0'.repeat(64)},input)).ok,false);
 for(const bad of [{...input,childId:'outside.recon-1'},{...input,tools:['read','write']},{...input,tools:['read','delegate']}])assert.equal((await registerDescendant(parent.assignment,bad)).ok,false);
 const reply=await registerDescendant(parent.assignment,input);assert.equal(reply.ok,true);if(!reply.ok)return;const child=(reply.result as any).assignment;
 assert.equal((await registerDescendant(child,{...input,childId:'recon-2'})).ok,false);assert.notEqual(child.queryHash,parent.assignment.queryHash);
 assert.equal((await rankDiscovery(child,{paths:f.paths,discovery:{complete:true}})).ok,true);
 for(let i=2;i<=3;i++)assert.equal((await registerDescendant(parent.assignment,{...input,childId:'recon-'+i})).ok,true);
 const findOnly=await registerDescendant(parent.assignment,{...input,childId:'finder-4',tools:['find']});assert.equal(findOnly.ok,true);
 if(findOnly.ok){const assignment=(findOnly.result as any).assignment;assert.equal((await rankDiscovery(assignment,{paths:f.paths,discovery:{complete:true}})).ok,false);const size=f.channel()!.owners.size;assert.equal((await revokeDiscoveryAttempt(assignment)).ok,true);assert.equal(f.channel()!.owners.size,size-1);}
 assert.equal((await registerDescendant(parent.assignment,{...input,childId:'recon-5'})).ok,false);
 assert.equal((await registerDescendant(parent.assignment,input)).ok,false); // No overlapping retry lease.
 assert.equal((await revokeDiscoveryAttempt(child)).ok,true);
 assert.equal((await registerDescendant(parent.assignment,input)).ok,true);assert.equal((await registerDescendant(parent.assignment,input)).ok,false);
 parent.revoke();assert.equal((await registerDescendant(parent.assignment,input)).ok,false);assert.equal((await rankDiscovery(child,{paths:f.paths,discovery:{complete:true}})).ok,false);assert.equal(f.calls(),originalCalls+3);assert.equal(f.channel()!.owners.size,0);
});

test('T10 production task/tree cancellation cascades descendant leases and terminates physical children; no late model advice/fallback',async t=>{
 const f=chain(t,'hold'),running=f.native.dispatchAgent('builder','parent task',f.ctx,[],f.paths,false,'native');
 // File report is emitted only AFTER the child extension has delivered advice.
 await new Promise<void>((done,fail)=>{const until=Date.now()+15000;const timer=setInterval(()=>{try{if(f.rows().some((r:any)=>r.worker===false)){clearInterval(timer);done();return;}}catch{}if(Date.now()>until){clearInterval(timer);fail(Error('child did not launch'));}},10);});
 assert.equal(f.channel()!.owners.size,2);f.switchTask();f.channel()!.owners.syncTask();
 const result=await running;assert.notEqual(result.exitCode,0);assert.equal(f.channel()!.owners.size,0);assert.equal(f.rows().filter((r:any)=>r.worker===false).length,1);
});

test('T10 production child manifest await cancellation fences startup and late inference; parent remains authority after every await',async t=>{
 const f=chain(t);let started!:()=>void,complete!:(value:any)=>void,request:any;
 const childInference=new Promise<void>(resolve=>started=resolve),evaluate=f.service.evaluate;
 f.service.evaluate=async(r:any)=>{if(r.state.task==='descendant own rounding'){request=r;started();return new Promise(resolve=>complete=resolve);}return evaluate(r);};
 const running=f.native.dispatchAgent('builder','parent task',f.ctx,[],f.paths,false,'native');await childInference;
 assert.equal(f.channel()!.owners.size,2);f.switchTask();f.channel()!.owners.syncTask();
 const result=await running;assert.notEqual(result.exitCode,0);assert.equal(f.channel()!.owners.size,0);assert.equal(f.rows().filter((r:any)=>r.worker===false).length,0);
 complete(await evaluate(request));await new Promise(resolve=>setImmediate(resolve));assert.equal(f.rows().filter((r:any)=>r.worker===false).length,0);
});

test('T10 real UDS oversized registration reply revokes undeliverable child; expired identity can ONLY self-revoke, never register or read',async t=>{
 const f=chain(t),context=await f.prepare({ownerId:'worker',task:'worker',query:'worker query',scope:f.paths,tools:['read','find','delegate'],cwd:f.root});
 const {createDiscoveryOwners,openDiscoveryAttempt}=await import('./owners.ts'),{createDiscoveryBroker}=await import('./broker.ts'),{discoveryHubRuntime}=await import('./hub.ts');
 let now=0;const owners=createDiscoveryOwners('session',()=> 'task',{now:()=>now,ttlMs:1000}),broker=await createDiscoveryBroker({root:f.root,runtime:discoveryHubRuntime(f.pi)!,owners,limits:{responseBytes:256}});t.after(()=>broker.close());
 const parent=openDiscoveryAttempt({owner:context!.registration!.owner,owners,endpoint:broker.endpoint}),before=f.calls();
 const input={childId:'recon-1',task:'child',query:'own child query',tools:['read']};
 const oversized=await registerDescendant(parent.assignment,input);assert.deepEqual(oversized,{ok:false,error:'response_too_large'});assert.equal(owners.size,1);
 now=1001;assert.equal((await registerDescendant(parent.assignment,input)).ok,false);assert.equal((await rankDiscovery(parent.assignment,{paths:f.paths,discovery:{complete:true}})).ok,false);assert.equal(f.calls(),before);
 assert.equal((await revokeDiscoveryAttempt(parent.assignment)).ok,true);assert.equal(owners.size,0);
});

test('T12 >255 automatic actual worker and nested delegate lifecycle keeps full-list pages and partial evaluation without shortlist',async t=>{
 const f=chain(t,'normal',300),result=await f.native.dispatchAgent('builder','parent worker task',f.ctx,[],f.paths,false,'native');assert.equal(result.exitCode,0,result.output);
 const ranked=f.rows().filter((r:any)=>r.worker||r.tools==='read,find');assert.equal(ranked.length,3);
 for(const row of ranked){assert.ok(row.registered&&row.extensionBeforeModel&&row.keyAbsent);assert.equal(row.advice.total,300);assert.equal(row.pageRows,300);assert.ok(row.readPages>2);assert.equal(row.advice.status,'partial');assert.equal(row.advice.counts.unscored,299);assert.equal(row.advice.discoveryComplete,true);}
 assert.equal(f.calls(),2);assert.equal(f.channel()!.owners.size,0);
});
