import test from 'node:test';
import {createCommunicationStore} from '../system1-communication-store.ts';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {configureDiscoveryHub,registerDiscoveryHub,discoveryHubEnabled,discoveryManagedReadbackAllowed,discoveryHubRuntime,resetDiscoveryHub,discoveryHubNativeChannel,prepareDiscoveryNative} from './hub.ts';
import {Socket} from 'node:net';
import {spawnPiAgent} from '../spawn.ts';
import {rankDiscovery} from './broker-client.ts';
import {BROKER_LIMITS} from './broker.ts';
import {FILE_DISCOVERY_LIMITS} from '../../lib/system1/config-file-discovery.js';
import {normalizeSystem1Config} from '../../lib/system1/config-v2.js';
import {resolveWorkModeTools} from '../work-mode.ts';
import {createWorkModePolicy} from '../policy/work-mode.ts';
import {registerFilesystemTool} from '../filesystem-tool.ts';
import {boundToolResult} from '../bounded-output.ts';
import {sourceHash} from '../agentic-sources.ts';
const inherited={AGENT_HUB_AGENT_ID:process.env.AGENT_HUB_AGENT_ID,AGENT_FLEET_AGENTIC_CHILD:process.env.AGENT_FLEET_AGENTIC_CHILD,PI_OFFLINE:process.env.PI_OFFLINE};
delete process.env.AGENT_HUB_AGENT_ID;delete process.env.AGENT_FLEET_AGENTIC_CHILD;process.env.PI_OFFLINE='1';
const {createFindTool,createLsTool,createGrepTool}=await import('@earendil-works/pi-coding-agent');
test.after(()=>{for(const [key,value]of Object.entries(inherited))if(value===undefined)delete process.env[key];else process.env[key]=value;});
function setup(t:any,limits={},count=3,fail=false){
 const root=mkdtempSync(join(tmpdir(),'d9-hub-')),session=mkdtempSync(join(tmpdir(),'d9-pages-'));
 mkdirSync(join(root,'.ai'));mkdirSync(join(root,'docs'));mkdirSync(join(root,'.pi'));
 writeFileSync(join(root,'.ai/agent-fleet.json'),JSON.stringify({features:{system1:true}}));
 for(let i=0;i<count;i++)writeFileSync(join(root,'docs',`file-${i}.ts`),'rounding safe file '+i);
 const hooks:Record<string,Function[]>={},tools=new Map<string,any>(),entries:any[]=[];let calls=0,taskId='task',used=0;
 const pi:any={registerTool:(tool:any)=>tools.set(tool.name,tool),on:(e:string,f:Function)=>(hooks[e]??=[]).push(f),appendEntry:(customType:string,data:any)=>entries.push({type:'custom',customType,data})};
 const ctx:any={cwd:root,sessionManager:{getSessionId:()=> 's',getEntries:()=>entries}};
 const document={version:2,mode:'auto',provider:'typesafe',model:'jev-1.13.0',apiKeyEnv:'TYPESAFE_API_KEY',consumers:{fileDiscovery:{mode:'active',remoteContextApproved:true,include:['docs'],limits}}};
 const service={async evaluate(r:any){calls++;if(fail)return {status:'unavailable',reason:'network'} as any;return {status:'ok',evaluation:{answers:r.questions.map((q:any)=>({questionId:q.id,type:q.type,uncertainty:{provenance:'provider'},...(q.type==='ordinal'?{value:0,levels:q.levels}:q.type==='choice'?{value:Object.keys(q.options)[0]}:{probabilityTrue:0.5})})),metadata:{}}} as any;}};
 // Test-local snapshot seam only: keep parser/public maximum at 1000 ms while
 // allowing actual Pi discovery module startup on a loaded test host.
 const snapshot=structuredClone(normalizeSystem1Config(document));snapshot.consumers.fileDiscovery.config.limits.discoveryMs=15000;
 const store=createCommunicationStore();store.setEnabled(true);
 registerDiscoveryHub(pi);configureDiscoveryHub(pi,{snapshot,service,ctx,sessionDir:session,taskId:()=>taskId,communicationStore:store});
 entries.push({type:'message',message:{role:'user',content:'find rounding'}});
 registerFilesystemTool(pi,{enabled:()=>false,readOnly:()=>true,sessionDir:()=>session,managedReadbackAllowed:handle=>discoveryManagedReadbackAllowed(pi,handle),remainingSelfReadBytes:()=>65536-used,noteSelfReadBytes:b=>used+=b});
 t.after(async()=>{await resetDiscoveryHub(pi);rmSync(root,{recursive:true,force:true});rmSync(session,{recursive:true,force:true});});
 const toolResult=async(name:string,input:any,result:any,id='call')=>hooks.tool_result[0]({toolName:name,input,toolCallId:id,...result},ctx);
 const execute=async(name:string,params:any)=>tools.get(name).execute('call',params,new AbortController().signal,()=>{},ctx);
 return {root,session,pi,ctx,store,document,snapshot,service,hooks,tools,entries,execute,toolResult,calls:()=>calls,changeTask:()=>taskId='new',newTurn:()=>used=0,used:()=>used};
}
test('automatic actual parent inventory/find/ls/grep before model, all tiers and both catalogs, exact evidence and duplicate-event reuse with zero model asks',async t=>{
 const f=setup(t);let id=0;
 const inventory=await f.execute('filesystem',{operation:'inventory',path:'docs'});
 const originals=[['filesystem',{operation:'inventory',path:'docs'},inventory],
 ['find',{pattern:'*.ts',path:'docs'},await createFindTool(f.root).execute('find',{pattern:'*.ts',path:'docs'},new AbortController().signal)],
 ['ls',{path:'docs'},await createLsTool(f.root).execute('ls',{path:'docs'},new AbortController().signal)],
 ['grep',{pattern:'rounding',path:'docs'},await createGrepTool(f.root).execute('grep',{pattern:'rounding',path:'docs'},new AbortController().signal)]] as any[];
 for(const [name,args,result]of originals){
  const before=JSON.stringify(result);const eventId=String(id++);const first=await f.toolResult(name,args,result,eventId);
  assert.equal(first.details.fileDiscovery.counts.discovered,3);assert.equal(first.details.fileDiscovery.counts.evaluated,3);
  assert.deepEqual(first.content.slice(0,result.content.length),result.content);assert.equal(JSON.stringify(result),before);
  for(const [key,value]of Object.entries(result.details??{}))assert.deepEqual(first.details[key],value);
  const calls=f.calls();assert.equal((await f.toolResult(name,args,result,eventId)).details.fileDiscovery.counts.cached,3);assert.equal(f.calls(),calls);
  assert.ok(!JSON.stringify(first.details.fileDiscovery).includes('rounding safe file'));
 }
 assert.equal(f.calls(),12);
 const next=await f.toolResult('find',originals[1][1],originals[1][2],'next');assert.equal(next.details.fileDiscovery.counts.cached,3);assert.equal(f.calls(),12);
 for(const tier of ['trivial','small','feature','project'])for(const workMode of ['operator','orchestrator'] as const){
 let active:string[]=[];const policy=createWorkModePolicy({getBaselineTools:()=>['read','find','ls','grep','bash','ask_system1_files'],getRosterSize:()=>1,getActiveTeamName:()=> 'default',getComsReady:()=>false,getHerdrReady:()=>false,getAskUserAvailable:()=>false,getFileDiscoveryEnabled:()=>discoveryHubEnabled(f.pi),getIdentityLabel:()=>null,getTaskTier:()=>tier,getPendingOperations:()=>[],getContextState:()=> 'normal',setActiveTools:tools=>active=tools,persist(){},replayDeferredInputs(){},watchdogArmed:()=>false},workMode);
 policy.applyWorkModeTools();assert.ok(active.includes('ask_system1_files'));if(workMode==='orchestrator')assert.ok(!active.includes('bash'));
 }
});
test('precise skip and failure keep original candidates; bounded-output chaining and no arbitrary bash parsing',async t=>{
 const f=setup(t,{},3,true);
 const event={content:[{type:'text',text:'file-0.ts\nfile-1.ts'}]};
 const failed=await f.toolResult('find',{path:'docs'},event);assert.deepEqual(failed.content[0],event.content[0]);assert.equal(failed.details.fileDiscovery.status,'unavailable');
 assert.equal(await f.toolResult('bash',{},event),undefined);
 assert.equal((await f.toolResult('find',{path:'docs'},{content:[{type:'text',text:'../bad'}]},'bad')).details.fileDiscovery.reason,'ambiguous_filename');
 assert.equal((await f.toolResult('find',{path:'docs'},{content:[{type:'text',text:'file-0.ts'}]},'one')).details.fileDiscovery.reason,'fewer_than_two_candidates');
 const good=setup(t);const text='file-0.ts:1: '+'x'.repeat(90000)+'\nfile-1.ts:2: rounding';
 const full={toolName:'grep',toolCallId:'bounded',content:[{type:'text',text}],details:{}};
 const retained=join(good.session,'artifacts','bounded');mkdirSync(retained,{recursive:true});const bounded=boundToolResult(full,retained)!;
 assert.ok(bounded.details.boundedOutput);const ranked=await good.toolResult('grep',{path:'docs'},bounded,'bounded');
 assert.equal(ranked.details.fileDiscovery.counts.discovered,2);assert.deepEqual(ranked.content[0],bounded.content[0]);assert.deepEqual(ranked.details.boundedOutput,bounded.details.boundedOutput);
});
test('explicit paths/patterns/custom-only questions use same engine, reserved IDs/caps reject, off and child catalog never inherit',async t=>{
 const f=setup(t);const custom={id:'risk',type:'predicate',instructions:'Risk?'};
 const ranked=await f.execute('ask_system1_files',{paths:['docs/file-0.ts','docs/file-1.ts'],questions:[custom]});assert.equal(ranked.details.rows.length,2);assert.equal(ranked.details.rows[0].role,'implementation');assert.equal(ranked.details.rows[0].relevance,0);
 const patterns=await f.execute('ask_system1_files',{directories:['docs'],patterns:['*.ts'],questions:[custom]});assert.equal(patterns.details.rows.length,3);
 const calls=f.calls();for(const questions of [[{...custom,id:'d9_relevance'}],Array(15).fill(custom),[{id:'bad',type:'choice',instructions:'pick',options:{yes:null,no:null}}]])assert.equal((await f.execute('ask_system1_files',{paths:['docs/file-0.ts'],questions})).details.reason,'invalid_input');assert.equal(f.calls(),calls);
 assert.equal((await f.execute('ask_system1_files',{paths:['docs/file-0.ts'],command:'bad'})).details.reason,'invalid_input');
 process.env.AGENT_FLEET_AGENTIC_CHILD='1';try{assert.equal(discoveryHubEnabled(f.pi),false);assert.equal((await f.execute('ask_system1_files',{paths:['docs/file-0.ts']})).details.reason,'consumer_off');}finally{delete process.env.AGENT_FLEET_AGENTIC_CHILD;}
 await resetDiscoveryHub(f.pi);assert.equal(await f.toolResult('find',{path:'docs'},{content:[{type:'text',text:'file-0.ts\nfile-1.ts'}]},'off'),undefined);
 for(const workMode of ['operator','orchestrator'] as const)assert.ok(!resolveWorkModeTools({workMode,baselineTools:['ask_system1_files'],comsReady:false,herdrReady:false,askUserAvailable:false}).includes('ask_system1_files'));
});
test('B1 off/unconfigured automatic hooks are inert and preserve byte-identical discovery and read evidence without capture or inference',async t=>{
 const f=setup(t);await resetDiscoveryHub(f.pi);
 const unconfiguredHooks:Record<string,Function>={};registerDiscoveryHub({registerTool(){},on:(name:string,hook:Function)=>{unconfiguredHooks[name]=hook;}} as any);
 const original={content:[{type:'text',text:'EXACT FILE BODY\r\n\u0000 λ\nfile-0.ts:1: rounding'}],details:{retained:'original',boundedOutput:{contentPath:join(f.session,'must-not-read'),sha256:'bad'}}};
 const before=JSON.stringify(original);
 for(const state of ['unconfigured','off']){
  if(state==='off')configureDiscoveryHub(f.pi,{snapshot:normalizeSystem1Config({...f.document,consumers:{fileDiscovery:{mode:'off'}}}),service:f.service,ctx:f.ctx,sessionDir:f.session,taskId:()=> 'task'});
  for(const [tool,input]of [['find',{path:'docs'}],['ls',{path:'docs'}],['grep',{path:'docs'}],['filesystem',{operation:'inventory',path:'docs'}],['filesystem',{operation:'read',path:'docs/file-0.ts'}],['filesystem',{operation:'readback',handle:'invalid'}]] as const){
   assert.equal(state==='unconfigured'?await unconfiguredHooks.tool_result({toolName:tool,input,...original},f.ctx):await f.toolResult(tool,input,original,`${state}-${tool}-${JSON.stringify(input)}`),undefined);
   assert.equal(JSON.stringify(original),before);
  }
 }
 assert.equal(f.calls(),0);assert.equal(discoveryHubRuntime(f.pi),null);
});
test('B1 enabled non-discovery filesystem read/readback evidence is untouched',async t=>{
 const f=setup(t);const original={content:[{type:'text',text:'EXACT FILE BODY\r\nλ'}],details:{identity:'original'}};const before=JSON.stringify(original);
 for(const operation of ['read','excerpt','readback','snapshot'])assert.equal(await f.toolResult('filesystem',{operation},original,operation),undefined);
 assert.equal(JSON.stringify(original),before);assert.equal(f.calls(),0);
});
test('REAL orchestrator filesystem readback pages 2+ across turns, exact unchanged 64KiB ceiling, trusted identity/hash and stale permissions',async t=>{
 const f=setup(t,{resultPageBytes:12000,maxEvaluationsPerJob:1},700);
 const params={operation:'inventory',path:'docs',page_size:1000};const original=await f.execute('filesystem',params);
 const ranked=await f.toolResult('filesystem',params,original,'pages');const advice=ranked.details.fileDiscovery;assert.ok(advice.first.handle);assert.equal(advice.total,500);assert.equal(advice.discoveryComplete,false);
 let next=advice.first,seen=0,pages=0,turns=0;const paths=new Set();
 while(next){
  const response=await f.execute('filesystem',{operation:'readback',handle:next.handle});const data=response.details.result;
  if(data.refused){assert.equal(data.reason,'too_large');assert.ok(f.used()<=65536);f.newTurn();turns++;continue;}
  const page=JSON.parse(data.content);assert.equal(page.pageIndex,pages);assert.equal(page.offset,seen);assert.equal(page.resultId,advice.resultId);assert.equal(page.total,500);
  for(const row of page.rows){assert.ok(!paths.has(row.path));paths.add(row.path);seen++;}pages++;next=page.next;
 }
 assert.equal(seen,500);assert.ok(pages>2);assert.ok(turns>0);
 // The actual handler, not a page helper, refuses later use after task switch.
 f.changeTask();await assert.rejects(()=>f.execute('filesystem',{operation:'readback',handle:advice.first.handle}),/stale|denied/);
});
test('managed pages current-policy and hash revocation refuse actual readback; resume retains logical calls',async t=>{
 const f=setup(t,{resultPageBytes:2600,maxEvaluationsPerJob:1},50);
 const ranked=await f.execute('ask_system1_files',{directories:['docs'],recursive:false});const handle=ranked.details.first.handle;
 const calls=discoveryHubRuntime(f.pi)!.calls;configureDiscoveryHub(f.pi,{snapshot:f.snapshot,service:f.service,ctx:f.ctx,sessionDir:f.session,taskId:()=> 'task'});assert.equal(discoveryHubRuntime(f.pi)!.calls,calls);
 await assert.rejects(()=>f.execute('filesystem',{operation:'readback',handle}),/stale|denied/);
 const again=await f.execute('ask_system1_files',{directories:['docs'],recursive:false});const fresh=again.details.first.handle;
 writeFileSync(join(f.root,'.pi/damage-control-rules.yaml'),'bashToolPatterns: []\nzeroAccessPaths:\n  - "docs/**"\nreadOnlyPaths: []\nnoDeletePaths: []\n');
 await assert.rejects(()=>f.execute('filesystem',{operation:'readback',handle:fresh}),/stale|denied/);
});
test('N4 production Hub query revision invalidates Hub cache but preserves immutable child query and awaited broker advice; authoritative task switch refuses before reads',async t=>{
 const f=setup(t);const channel=discoveryHubNativeChannel(f.pi)!;const broker=await channel.ready;assert.ok(broker);
 const lease=channel.owners.register({taskId:'task',ownerId:'trusted-test-worker',attemptId:'test-attempt',cwd:f.root,task:'rounding',query:'docs',effectiveTools:['find','read'],readRoots:['docs'],exportRoots:['docs'],canRead:()=>true,canDisplay:()=>true,permissionIdentity:()=> 'v1'});
 const assignment=channel.owners.assignment(lease,broker.endpoint);
 const result=await rankDiscovery(assignment,{paths:['docs/file-0.ts'],discovery:{complete:true}});assert.equal(result.ok,true);assert.equal(f.calls(),1);
 // Change user text while a real native broker request is in inference.
 const evaluate=f.service.evaluate.bind(f.service);let started!:()=>void,release!:()=>void;
 const ready=new Promise<void>(r=>started=r),gate=new Promise<void>(r=>release=r);
 f.service.evaluate=async(r:any)=>{started();await gate;return evaluate(r);};
 const pending=rankDiscovery(assignment,{paths:['docs/file-1.ts'],discovery:{complete:true}});await ready;
 f.entries.push({type:'message',message:{role:'user',content:'new query same task id'}});
 for(const fn of f.hooks.before_agent_start)await fn({},f.ctx);release();
 const continued=await pending;assert.equal(continued.ok,true);assert.equal((continued as any).result.queryHash,sourceHash('docs'));assert.equal(lease.signal.aborted,false);assert.equal(lease.attemptSignal.aborted,false);
 assert.equal((await rankDiscovery(assignment,{paths:['docs/file-0.ts'],discovery:{complete:true}}) as any).result.counts.cached,1);assert.equal(f.calls(),2);
 // Hub cache remains keyed to revised user text, not the child's query.
 const event={content:[{type:'text',text:'file-0.ts\nfile-1.ts'}]};
 await f.toolResult('find',{path:'docs'},event,'revision');const calls=f.calls();
 f.entries.push({type:'message',message:{role:'user',content:'another same-task revision'}});
 for(const fn of f.hooks.before_agent_start)await fn({},f.ctx);
 await f.toolResult('find',{path:'docs'},event,'revision');assert.equal(f.calls(),calls+2);
 let reads=0;const stale=channel.owners.register({...lease,ownerId:'stale',attemptId:'stale',canRead:()=>{reads++;return true;},canDisplay:()=>{reads++;return true;}});
 const staleAssignment=channel.owners.assignment(stale,broker.endpoint);f.changeTask();
 assert.equal((await rankDiscovery(staleAssignment,{paths:['docs/file-1.ts'],discovery:{complete:true}}) as any).error,'unauthorized');assert.equal(reads,0);assert.equal(stale.attemptSignal.aborted,true);
 for(const fn of f.hooks.before_agent_start)await fn({},f.ctx);assert.equal(lease.attemptSignal.aborted,true);
 for(const fn of f.hooks.session_shutdown)await fn({},f.ctx);assert.equal(channel.owners.size,0);assert.equal(broker.connections,0);assert.equal(discoveryHubNativeChannel(f.pi),null);
});
test('N4 real production Hub and physical spawn: same-task followup survives; actual task switch, session cancellation and shutdown terminate',async t=>{
 for(const mode of ['followup','task','cancel','shutdown']){
  const f=setup(t),prepared=await prepareDiscoveryNative(f.pi,{ownerId:'native-'+mode,task:'immutable child task',query:'immutable child query',tools:['read','find'],cwd:f.root,scope:['docs/file-0.ts']});
  assert.ok(prepared?.registration);
  writeFileSync(join(f.root,'pi'),`#!/usr/bin/env node
process.stdin.resume();
require('node:fs').writeFileSync('assignment.json',JSON.stringify({endpoint:process.env.AF_D9_ENDPOINT,capability:process.env.AF_D9_CAPABILITY,sessionId:process.env.AF_D9_SESSION_ID,taskId:process.env.AF_D9_TASK_ID,ownerId:process.env.AF_D9_OWNER_ID,attemptId:process.env.AF_D9_ATTEMPT_ID,queryHash:process.env.AF_D9_QUERY_HASH}));
console.log(JSON.stringify({type:'tool_execution_start',toolCallId:'ready',toolName:'find',args:{}}));
setTimeout(()=>console.log(JSON.stringify({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'healthy complete'}})),2000);
`,{mode:0o755});
  let started!:()=>void;const ready=new Promise<void>(r=>started=r),controller=new AbortController();
  const pending=spawnPiAgent({model:'fake/healthy',tools:'read,find',thinking:'off',sessionFile:join(f.session,'child'),prompt:'own task',cwd:f.root,env:{PATH:f.root+':'+process.env.PATH},discoveryRegistration:prepared.registration,signal:controller.signal,turnDeadlineMs:5000},{onToolStart(){started();}});
  await ready;const channel=discoveryHubNativeChannel(f.pi)!;assert.equal(channel.owners.size,1);
  const assignment=JSON.parse(readFileSync(join(f.root,'assignment.json'),'utf8'));
  f.entries.push({type:'message',message:{role:'user',content:'same-task followup'}});
  for(const fn of f.hooks.before_agent_start)await fn({},f.ctx);assert.equal(channel.owners.size,1);
  const advice=await rankDiscovery(assignment,{paths:['docs/file-0.ts'],discovery:{complete:true}});
  assert.equal(advice.ok,true);assert.equal((advice as any).result.queryHash,sourceHash('immutable child query'));assert.equal((advice as any).result.counts.cached,1);assert.equal(f.calls(),1);
  if(mode==='task'){f.changeTask();for(const fn of f.hooks.before_agent_start)await fn({},f.ctx);}
  else if(mode==='cancel')controller.abort();
  else if(mode==='shutdown')for(const fn of f.hooks.session_shutdown)await fn({},f.ctx);
  const result=await pending;
  if(mode==='followup'){assert.equal(result.exitCode,0);assert.equal(result.termination,undefined);assert.equal(result.output,'healthy complete');}
  else assert.equal(result.termination?.reason,'cancelled');
  assert.equal(channel.owners.size,0);
 }
});

test('T11 production Hub current automatic trigger projection observes actual adapter/rank and distinct skipped trigger without sensitive evidence',async t=>{
 const f=setup(t);const original=await createFindTool(f.root).execute('f',{pattern:'*.ts',path:'docs'},new AbortController().signal);
 await f.toolResult('find',{pattern:'*.ts',path:'docs'},original,'observe');let pair=f.store.snapshot().at(-1)!;
 assert.equal(pair.consumer,'fileDiscovery');assert.equal(pair.owner,'hub');assert.equal(JSON.parse(pair.request!).trigger,'find');assert.equal(JSON.parse(pair.response!).counts.evaluated,3);
 await f.toolResult('find',{path:'docs'},{content:[{type:'text',text:'file-0.ts'}]},'skip');pair=f.store.snapshot().at(-1)!;assert.equal(pair.status,'skipped');
 assert.ok(!JSON.stringify(f.store.snapshot()).includes('rounding'));assert.ok(!JSON.stringify(f.store.snapshot()).includes('file-0.ts'));
});

test('T12 production A paths / B shallow pattern / C recursive: >255 full-list pages, low and unscored remain, automatic real root find partial coverage',async t=>{
 const f=setup(t,{maxEvaluationsPerJob:1,resultPageBytes:12000},300);
 for(const params of [{paths:Array.from({length:300},(_,i)=>`docs/file-${i}.ts`)},{directories:['docs'],patterns:['*.ts'],recursive:false},{directories:['docs'],patterns:['**'],recursive:true}]){
  const result=(await f.execute('ask_system1_files',params)).details;assert.equal(result.total,300);assert.equal(result.status,'partial');assert.equal(result.counts.unscored,299);
  let next=result.first,count=0;const identities=new Set();while(next){const r=await f.execute('filesystem',{operation:'readback',handle:next.handle});if(r.details.result.refused){f.newTurn();continue;}const page=JSON.parse(r.details.result.content);for(const row of page.rows){count++;identities.add(row.path);}next=page.next;}
  assert.equal(count,300);assert.equal(identities.size,300);f.newTurn();
 }
 const args={path:'docs',pattern:'*.ts',limit:280},original=await createFindTool(f.root).execute('find',args,new AbortController().signal);
 const advice=(await f.toolResult('find',args,original,'full-root')).details.fileDiscovery;assert.equal(advice.total,280);assert.equal(advice.discoveryComplete,false);assert.equal(advice.remaining,'unknown');assert.deepEqual(original.content,(await f.toolResult('find',args,original,'root-cache')).content.slice(0,original.content.length));
});
function until<T>(promise:Promise<T>,ms=5000):Promise<T>{
 return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('barrier timeout')),ms);promise.then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});});
}
test('Hub store projects a client deadline as unavailable before the runtime job timer, and explicit abort stays cancelled',async t=>{
 const f=setup(t);assert.equal(f.snapshot.consumers.fileDiscovery.config.limits.jobTimeoutMs,20000);
 const channel=discoveryHubNativeChannel(f.pi)!;const broker=await channel.ready;assert.ok(broker);
 const lease=channel.owners.register({taskId:'task',ownerId:'deadline-worker',attemptId:'deadline-attempt',cwd:f.root,task:'rounding',query:'docs',effectiveTools:['find','read'],readRoots:['docs'],exportRoots:['docs'],canRead:()=>true,canDisplay:()=>true,permissionIdentity:()=>'v1'});
 const assignment=channel.owners.assignment(lease,broker.endpoint);let entered!:()=>void;const ready=new Promise<void>(r=>entered=r);
 const runtime=discoveryHubRuntime(f.pi)!;const real=runtime.rank.bind(runtime);const results:any[]=[],waiters:Array<(value:any)=>void>=[];
 runtime.rank=async(job:any)=>{const result=await real(job);const waiter=waiters.shift();if(waiter)waiter(result);else results.push(result);return result;};
 const nextRank=()=>results.length?Promise.resolve(results.shift()):new Promise(resolve=>waiters.push(resolve));
 f.service.evaluate=async()=>{entered();return new Promise(()=>{});};
 const pending=rankDiscovery(assignment,{paths:['docs/file-0.ts','docs/file-1.ts'],discovery:{complete:true}},undefined,4000);
 assert.equal(await Promise.race([ready.then(()=>'entered'),pending.then(()=>'early')]),'entered');
 const client=await until(pending) as any,ranked=await until(nextRank());
 assert.equal(client.error,'deadline');assert.equal(ranked.status,'unavailable');assert.equal(ranked.rows.length,2);assert.ok(ranked.rows.every((row:any)=>row.reason==='deadline'));
 assert.equal(f.store.snapshot().length,1);assert.equal(f.store.snapshot()[0].status,'unavailable');assert.notEqual(f.store.snapshot()[0].status,'cancelled');
 assert.equal(lease.signal.aborted,false);assert.equal(lease.attemptSignal.aborted,false);assert.equal(channel.owners.size,1);
 assert.ok(!JSON.stringify(f.store.snapshot()).includes('rounding safe file'));assert.ok(!JSON.stringify(ranked).includes('rounding safe file'));
 const g=setup(t);let seen=false;g.service.evaluate=async()=>{seen=true;return new Promise(()=>{});};
 const controller=new AbortController();const ask=g.tools.get('ask_system1_files').execute('id',{paths:['docs/file-0.ts','docs/file-1.ts']},controller.signal);
 while(!seen)await new Promise(r=>setTimeout(r,10));controller.abort();const cancelled=await ask;
 assert.equal(cancelled.details.status,'cancelled');assert.equal(g.store.snapshot().at(-1)!.status,'cancelled');
});
const lateSuccess=()=>({status:'ok',evaluation:{answers:[{questionId:'d9_relevance',type:'ordinal',value:3,levels:['unrelated','supporting','directly relevant','primary'],uncertainty:{provenance:'provider',confidence:0.91,distribution:[0,0,0,1]}},{questionId:'d9_role',type:'choice',value:'implementation',uncertainty:{provenance:'provider',confidence:0.91,distribution:[1,0,0,0,0,0]}}],metadata:{attempts:1,usage:{inputTokens:3,outputTokens:2}}}});
function assertHealthy(lease:any,channel:any,ranked:any,store:any){
 assert.equal(lease.signal.aborted,false);assert.equal(lease.attemptSignal.aborted,false);assert.equal(channel.owners.size,1);
 assert.ok(!JSON.stringify(store.snapshot()).includes('rounding safe file'));assert.ok(!JSON.stringify(ranked).includes('rounding safe file'));assert.ok(!JSON.stringify(store.snapshot()).includes(lease.capability));
}
async function hubRank(f:any){
 const channel=discoveryHubNativeChannel(f.pi)!;const broker=await channel.ready;assert.ok(broker);
 const lease=channel.owners.register({taskId:'task',ownerId:'hub-boundary',attemptId:'hub-attempt',cwd:f.root,task:'rounding',query:'docs',effectiveTools:['find','read'],readRoots:['docs'],exportRoots:['docs'],canRead:()=>true,canDisplay:()=>true,permissionIdentity:()=>'v1'});
 const assignment=channel.owners.assignment(lease,broker.endpoint);let entered!:()=>void;const ready=new Promise<void>(r=>entered=r);let release!:(value:any)=>void;const gate=new Promise(r=>release=r);
 const runtime=discoveryHubRuntime(f.pi)!;const real=runtime.rank.bind(runtime);const results:any[]=[],waiters:Array<(value:any)=>void>=[];
 runtime.rank=async(job:any)=>{const result=await real(job);const waiter=waiters.shift();if(waiter)waiter(result);else results.push(result);return result;};
 f.service.evaluate=async()=>{entered();return gate;};
 return {channel,lease,assignment,ready,release,nextRank:()=>results.length?Promise.resolve(results.shift()):new Promise(resolve=>waiters.push(resolve))};
}
test('configured Hub store projects a broker timer as unavailable deadline before the client and runtime timers',async t=>{
 assert.equal(BROKER_LIMITS.requestMs,20000);assert.equal(BROKER_LIMITS.partialFrameMs,1000);assert.equal(FILE_DISCOVERY_LIMITS.jobTimeoutMs,20000);assert.equal(FILE_DISCOVERY_LIMITS.discoveryMs,1000);
 const f=setup(t);assert.equal(f.snapshot.consumers.fileDiscovery.config.limits.jobTimeoutMs,20000);const hub=await hubRank(f);
 const originalSetTimeout=global.setTimeout;const originalEnd=Socket.prototype.end;let brokerFired=0,terminalSends=0;
 global.setTimeout=function(fn:any,ms?:number,...args:any[]){const stack=new Error().stack??'';if(ms===20000&&stack.includes('file-discovery/broker.ts'))return originalSetTimeout(()=>{brokerFired++;return fn();},500,...args);return originalSetTimeout(fn,ms as any,...args);} as typeof setTimeout;
 Socket.prototype.end=function(this:any,chunk:any,...args:any[]){if(typeof chunk==='string'&&chunk.includes('"type":"rank_deadline"'))terminalSends++;return originalEnd.call(this,chunk,...args);} as any;
 try{
  const started=Date.now();const pending=rankDiscovery(hub.assignment,{paths:['docs/file-0.ts','docs/file-1.ts'],discovery:{complete:true}},undefined,8000);
  assert.equal(await Promise.race([hub.ready.then(()=>'entered'),pending.then(()=>'early')]),'entered');
  const client=await until(pending,8000) as any,ranked=await until(hub.nextRank(),8000),elapsed=Date.now()-started;
  assert.equal(client.error,'deadline');assert.equal(terminalSends,0);assert.equal(brokerFired,1);assert.ok(elapsed<3000,'broker timer elapsed '+elapsed);
  assert.equal(ranked.status,'unavailable');assert.equal(ranked.rows.length,2);assert.ok(ranked.rows.every((row:any)=>row.reason==='deadline'));
  assert.equal(f.store.snapshot().length,1);assert.equal(f.store.snapshot()[0].status,'unavailable');assert.notEqual(f.store.snapshot()[0].status,'cancelled');assertHealthy(hub.lease,hub.channel,ranked,f.store);
 }finally{global.setTimeout=originalSetTimeout;Socket.prototype.end=originalEnd;}
});
async function hubFault(t:any,fault:'epipe'|'end'|'silent'){
 const f=setup(t);assert.equal(f.snapshot.consumers.fileDiscovery.config.limits.jobTimeoutMs,20000);assert.equal(BROKER_LIMITS.requestMs,20000);assert.equal(BROKER_LIMITS.partialFrameMs,1000);
 const hub=await hubRank(f);const original=Socket.prototype.end;let injected=0;
 Socket.prototype.end=function(this:any,chunk:any,...args:any[]){
  if(typeof chunk==='string'&&chunk.includes('"type":"rank_deadline"')){injected++;if(fault==='epipe'){this.destroy(Object.assign(new Error('injected terminal write failure'),{code:'EPIPE'}));return this;}if(fault==='end'){this.destroy();return this;}return this;}
  return original.call(this,chunk,...args);
 } as any;
 try{
  const started=Date.now();const pending=rankDiscovery(hub.assignment,{paths:['docs/file-0.ts','docs/file-1.ts'],discovery:{complete:true}},undefined,400);
  assert.equal(await Promise.race([hub.ready.then(()=>'entered'),pending.then(()=>'early')]),'entered',fault);
  const client=await until(pending,8000) as any,ranked=await until(hub.nextRank(),8000);
  return {f,hub,client,ranked,injected,elapsed:Date.now()-started,fault};
 }finally{Socket.prototype.end=original;}
}
test('configured Hub store maps undelivered terminal EPIPE, end/close and ACK cleanup expiry to cancelled, not a typed deadline',async t=>{
 assert.equal(FILE_DISCOVERY_LIMITS.jobTimeoutMs,20000);assert.equal(FILE_DISCOVERY_LIMITS.discoveryMs,1000);const elapsed:Record<string,number>={};
 for(const fault of ['epipe','end','silent'] as const){
  const cell=await hubFault(t,fault);elapsed[fault]=cell.elapsed;
  assert.equal(cell.injected,1,fault);assert.equal(cell.client.error,'channel_unavailable',fault);assert.notEqual(cell.client.error,'deadline',fault);
  assert.equal(cell.ranked.status,'cancelled',fault);assert.ok(cell.ranked.rows.every((row:any)=>row.reason==='cancelled'&&row.status!=='scored'),fault);
  assert.equal(cell.f.store.snapshot().length,1,fault);assert.equal(cell.f.store.snapshot()[0].status,'cancelled',fault);assert.notEqual(cell.f.store.snapshot()[0].status,'unavailable',fault);
  assert.ok(cell.elapsed<6000,fault+' elapsed '+cell.elapsed);assertHealthy(cell.hub.lease,cell.hub.channel,cell.ranked,cell.f.store);
 }
 assert.ok(elapsed.silent>=elapsed.epipe+700,'cleanup '+elapsed.silent+' vs epipe '+elapsed.epipe);
});
test('late provider success cannot overwrite a failed Hub-store terminal delivery',async t=>{
 const cell=await hubFault(t,'epipe');assert.equal(cell.client.error,'channel_unavailable');assert.equal(cell.ranked.status,'cancelled');assert.equal(cell.f.store.snapshot()[0].status,'cancelled');
 const before=JSON.stringify(cell.f.store.snapshot());cell.hub.release(lateSuccess());await new Promise(r=>setTimeout(r,80));
 assert.equal(JSON.stringify(cell.f.store.snapshot()),before);assert.equal(cell.ranked.status,'cancelled');assert.ok(cell.ranked.rows.every((row:any)=>row.reason==='cancelled'&&row.status!=='scored'));
 assert.equal(cell.client.error,'channel_unavailable');assertHealthy(cell.hub.lease,cell.hub.channel,cell.ranked,cell.f.store);
});
