import test from 'node:test';
import assert from 'node:assert/strict';
import {createDamageHubSession} from './damage-guard-hub.ts';
import {normalizeSystem1Config} from '../lib/system1/config-v2.js';
import {connect} from 'node:net';
import {damageAssessmentFrame,damageControlFrame,verifyDamageFrame,type DamageAssignment} from './damage-guard-broker.ts';
const document={version:2,mode:'auto',provider:'typesafe',model:'jev-1.13.0',apiKeyEnv:'TYPESAFE_API_KEY',consumers:{damageGuard:{mode:'active',remoteScopes:{commands:true},include:['docs']}}};
const severe=()=>({status:'ok' as const,evaluation:{answers:[{questionId:'effect',type:'choice' as const,value:'severe',uncertainty:{provenance:'provider' as const}},{questionId:'evidence',type:'choice' as const,value:'sufficient',uncertainty:{provenance:'provider' as const}}],metadata:{provider:'typesafe',requestedModel:'jev-1.13.0',returnedModel:'jev-1.13.0',questionSetVersion:'damage-guard/v1',latencyMs:1,attempts:1}}});
function request(assignment:DamageAssignment,frame:unknown,held?:()=>void){return new Promise<any>((resolve,reject)=>{
 const socket=connect(assignment.path),rows:any[]=[];let buffer='';socket.on('error',reject);socket.on('connect',()=>socket.write(JSON.stringify(frame)+'\n'));
 socket.on('data',bytes=>{buffer+=bytes;let at:number;while((at=buffer.indexOf('\n'))>=0){const row=JSON.parse(buffer.slice(0,at));buffer=buffer.slice(at+1);assert.equal(verifyDamageFrame(row,assignment.capability),true);rows.push(row);if(row.outcome==='held')held?.();}});
 socket.on('close',()=>resolve(rows.at(-1)));
});}
function fixture(extra:any={}){const rows:any[]=[];return createDamageHubSession({root:process.cwd(),snapshot:normalizeSystem1Config(document),taskId:()=> 'task',append:(customType,data)=>rows.push({customType,data}),entries:()=>rows,canRead:()=>true,selected:true,childAuthority:{taskToken:()=> 'token',admit:()=>true},ask:async id=>({details:{runtimeAsk:{requestId:id},response:{kind:'selection',selections:['Allow once']}}}),service:{evaluate:async()=>severe()},...extra});}
test('F8 session broker uses durable held handshake and consumed human grant, reminted child ID override and replay',{timeout:3000},async()=>{
 let choice='Deny',asks=0;const rows:any[]=[];const session=fixture({append:(customType:string,data:any)=>rows.push({customType,data}),ask:async(id:string)=>{asks++;return {details:{runtimeAsk:{requestId:id},response:{kind:'selection',selections:[choice]}}};}});session.accept('input');await session.start();
 try{const lease=await session.prepare({ownerId:'specialist',cwd:process.cwd(),tools:['bash'],admit:()=>true})!.open({tools:['bash'],cwd:process.cwd()});
 const frame=(id:string,command='echo hello')=>damageAssessmentFrame(lease.assignment,id,'bash',{command});
 assert.equal((await request(lease.assignment,frame('one'),()=>assert.ok(rows.some(r=>r.data.decision==='hold')))).outcome,'blocked');
 assert.equal((await request(lease.assignment,frame('two'))).outcome,'blocked');assert.equal(session.armOverride('two'),true);assert.equal(asks,1);
 choice='Allow once';assert.equal((await request(lease.assignment,frame('three'))).outcome,'granted');assert.equal(asks,2);
 assert.notEqual((await request(lease.assignment,frame('three')))?.outcome,'granted');assert.equal((await request(lease.assignment,frame('four'))).outcome,'blocked');assert.equal(asks,2);
 assert.equal(session.armOverride('four'),true);lease.revoke();assert.equal(session.armOverride('four'),false);
 }finally{await session.dispose();}
});
test('F8 broker disabled configurations make zero inference while fresh descendants revoke transitively',{timeout:3000},async()=>{
 for(const config of [null,{...document,mode:'off'},{...document,consumers:{}},{...document,consumers:{damageGuard:{mode:'invalid'}}},document]){
 let calls=0;const session=fixture({snapshot:normalizeSystem1Config(config),service:config===document?undefined:{evaluate:async()=>{calls++;return severe();}}});session.accept('input');await session.start();
 try{const registration=session.prepare({ownerId:'specialist',cwd:process.cwd(),tools:['bash'],admit:()=>true});
 if(config!==document){assert.equal(registration,null);assert.equal(calls,0);continue;}
 assert.ok(registration);const lease=await registration.open({tools:['bash'],cwd:process.cwd()});
 assert.equal((await request(lease.assignment,damageAssessmentFrame(lease.assignment,'one','bash',{command:'echo hello'}))).outcome,'unavailable');
 const child=(await request(lease.assignment,damageControlFrame(lease.assignment,'nested','register_descendant',{tools:['bash']}))).assignment;
 lease.revoke();assert.equal((await request(child,damageAssessmentFrame(child,'child','bash',{command:'echo hello'}))).outcome,'revoked');assert.equal(calls,0);
 const reader=await session.prepare({ownerId:'research',cwd:process.cwd(),tools:['read','find'],admit:()=>true})!.open({tools:['read'],cwd:process.cwd()});assert.deepEqual(reader.identity.tools,['read']);assert.equal((await request(reader.assignment,damageAssessmentFrame(reader.assignment,'effect-denied','bash',{command:'echo hello'}))).outcome,'revoked');reader.revoke();assert.equal(reader.validate(),false);
 }finally{await session.dispose();}
 }
});
test('F8 reset during human wait awaits settlement and closes broker; repeated teardown shares completion',{timeout:3000},async()=>{
 let entered!:()=>void;const waiting=new Promise<void>(r=>entered=r);let aborted=false;
 const session=fixture({ask:async(_id:string,_q:unknown,signal:AbortSignal)=>{entered();return new Promise(resolve=>signal.addEventListener('abort',()=>{aborted=true;resolve({details:{cancelled:true}});},{once:true}));}});session.accept('input');await session.start();
 const lease=await session.prepare({ownerId:'child',cwd:process.cwd(),tools:['bash'],admit:()=>true})!.open({tools:['bash'],cwd:process.cwd()});
 const pending=request(lease.assignment,damageAssessmentFrame(lease.assignment,'wait','bash',{command:'echo hello'}));await waiting;
 const close=session.dispose();assert.equal(session.dispose(),close);await close;assert.equal(aborted,true);assert.equal(lease.identity.signal.aborted,true);assert.notEqual((await pending)?.outcome,'granted');
});

test('F8 actual root specialist/research/nested launches use production D6 with D9 absent or off and taskTriage absent',{timeout:45000},async()=>{
 const {mkdtempSync,mkdirSync,writeFileSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {spawnSync}=await import('node:child_process');
 const root=mkdtempSync(join(tmpdir(),'d6-root-'));mkdirSync(join(root,'.ai'));writeFileSync(join(root,'.ai','agent-fleet.json'),JSON.stringify({features:{system1:false}}));
 mkdirSync(join(root,'.pi','agents','personas'),{recursive:true});mkdirSync(join(root,'.pi','harnesses','damage-control-continue'),{recursive:true});
 writeFileSync(join(root,'.pi','harnesses','damage-control-continue','index.ts'),'export default function(){}');
 writeFileSync(join(root,'.pi','agents','teams.yaml'),'fixture:\n  - fixture-worker\n');
 writeFileSync(join(root,'.pi','agents','personas','fixture-worker.md'),'---\nname: fixture-worker\ndescription: synthetic worker\ntools: read,bash,delegate\nmodel: fake/worker\nmodels:\n  - fake/worker\n  - fake/primary\nsubagents:\n  nested:\n    model: fake/nested\n    tools: read,bash\n---\nSynthetic policy.');
 writeFileSync(join(root,'pi'),`#!/usr/bin/env node
const fs=require('node:fs'),args=process.argv;
let prompt='';process.stdin.on('data',b=>prompt+=b);process.stdin.on('end',async()=>{try{
 const assignment=process.env.AF_D6_ASSIGNMENT?JSON.parse(process.env.AF_D6_ASSIGNMENT):null,model=args[args.indexOf('--model')+1],config=process.env.AGENT_HUB_DELEGATE_CONFIG;
 const session=args[args.indexOf('--session')+1];if(session)fs.writeFileSync(session,JSON.stringify({type:'session',version:3,id:'synthetic'})+'\\n');
 fs.appendFileSync(${JSON.stringify(join(root,'report'))},JSON.stringify({model,assignment,tools:args[args.indexOf('--tools')+1],safe:!process.env.TYPESAFE_API_KEY,config:!!config,cwd:process.cwd()})+'\\n');
 if(model==='fake/primary'){console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'error',errorMessage:'provider unavailable'}}));process.exitCode=1;return;}
 if(model==='fake/worker'&&!fs.existsSync(${JSON.stringify(join(root,'retry.once'))})){fs.writeFileSync(${JSON.stringify(join(root,'retry.once'))},'1');if(session)fs.writeFileSync(session,'corrupted');console.error('not a valid pi session');process.exitCode=1;return;}
 if(config){const {default:delegate}=await import(${JSON.stringify(new URL('./delegate.ts',import.meta.url).href)});let tool;delegate({registerTool:t=>tool=t,on(){}});const result=await tool.execute('nested-call',{role:'nested',instruction:'Synthetic nested instruction',allow_write:true});if(result.details.status!=='done')throw Error(JSON.stringify(result));}
 console.log(JSON.stringify({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'changed_files: []\\nassertions_proven: []\\nassertions_unproven: []\\nassertions_failed: []\\ntests_run: []\\nopen_risks: []\\nrequires_user_decision: []'}}));
}catch(error){console.error(error);process.exitCode=1;}});
`,{mode:0o755});
 const source=`
 import assert from 'node:assert/strict';
 import {registerHooks} from 'node:module';
 const stub='export const copyToClipboard=()=>{},getMarkdownTheme=()=>({}),getAgentDir=()=>process.env.HOME,isToolCallEventType=(name,event)=>event.toolName===name;export class CustomEditor{};export class DynamicBorder{};';
 const tui='export const Key={},matchesKey=()=>false,isKeyRelease=()=>false,truncateToWidth=s=>s,visibleWidth=s=>s.length,wrapTextWithAnsi=s=>[s];export class Text{};export class Container{addChild(){}};export class Spacer{};export class Box{};export class Markdown{};';
 registerHooks({resolve(specifier,context,next){if(specifier==='@mariozechner/pi-coding-agent')return {url:'data:text/javascript,'+encodeURIComponent(stub),shortCircuit:true};if(specifier==='@mariozechner/pi-tui')return {url:'data:text/javascript,'+encodeURIComponent(tui),shortCircuit:true};return next(specifier,context)}});
 const {default:net}=await import('node:net');const {syncBuiltinESMExports}=await import('node:module');let servers=0;const createServer=net.createServer;net.createServer=(...args)=>{servers++;return createServer(...args)};syncBuiltinESMExports();
 const {default:register}=await import(${JSON.stringify(new URL('./index.ts',import.meta.url).href)});assert.equal(servers,0,'root import must not start sockets');
 import {prepareDamageGuardNative} from ${JSON.stringify(new URL('./damage-guard-hub.ts',import.meta.url).href)};
 const handlers=new Map(),commands=new Map(),tools=new Map(),entries=[];let asks=0,failInput=false;
 const {readFileSync}=await import('node:fs');
 const pi=new Proxy({events:{on(){return ()=>{}},emit(){}},on(name,fn){const rows=handlers.get(name)||[];rows.push(fn);handlers.set(name,rows)},registerCommand(name,value){commands.set(name,value)},registerTool(value){tools.set(value.name,value)},appendEntry(customType,data){if(failInput&&customType==='damage-guard-input')throw Error('synthetic disk failure');entries.push({customType,data})},getFlag(name){return name==='agent-team'?'fixture':name==='work-mode'?'operator':undefined},getActiveTools(){return ['read','bash','edit','write']},getAllTools(){return []},setActiveTools(){},getThinkingLevel(){return 'off'}},{get(target,key){return key in target?target[key]:()=>{}}});
 const ctx={cwd:process.cwd(),model:{provider:'fake',id:'worker',contextWindow:100000},hasUI:false,isIdle:()=>true,getContextUsage:()=>undefined,sessionManager:{getEntries:()=>entries,getSessionId:()=> 'root-fixture',getSessionFile:()=>undefined,getBranch:()=>[],getLeafId:()=>null},ui:{select:async()=>{asks++;return 'Allow once'},notify(){},setStatus(){},setWidget(){},setFooter(){},setEditorText(){},getEditorText:()=>'',setWorkingMessage(){},setTitle(){}}};
 register(pi);
 const emit=async(name,event)=>{for(const fn of handlers.get(name)||[])await fn(event,ctx)};
 assert.throws(()=>prepareDamageGuardNative(pi,{ownerId:'prestart',cwd:ctx.cwd,tools:['bash'],admit:()=>true}));
 await emit('session_start',{type:'session_start'});
 await emit('input',{text:'Synthetic authoritative user input',source:'interactive'});
 const registration=prepareDamageGuardNative(pi,{ownerId:'root-specialist',cwd:ctx.cwd,tools:['bash'],admit:()=>true});
 assert.equal(registration,null,'disabled optional D6 must not register physical launches');
 assert.ok(entries.some(row=>row.customType==='damage-guard-input'));
 const classified=await tools.get('set_task_tier').execute('tier',{tier:'feature',risk:'low',scope:'small',reason:'Synthetic fixture needs the existing nested-launch budget'},undefined,undefined,ctx);assert.notEqual(classified.isError,true,JSON.stringify(classified));
 ctx.ui.select=async(_prompt,options)=>options.find(option=>option.startsWith('fake/primary'));await commands.get('af-agent-model').handler('fixture-worker',ctx);
 const dispatch=await tools.get('dispatch_agent').execute('specialist-call',{agent:'fixture-worker',task:'Inspect the synthetic launch contract',backend:'native'},undefined,undefined,ctx);
 assert.equal(dispatch.details.exitCode,0,JSON.stringify(dispatch));
 const research=await tools.get('spawn_research').execute('research-call',{task:'Find synthetic launch evidence',model:'fake/research'},undefined,undefined,ctx);assert.equal(research.details.exitCode,0,JSON.stringify(research));
 const reports=readFileSync(${JSON.stringify(join(root,'report'))},'utf8').trim().split('\\n').map(JSON.parse);
 const workers=reports.filter(row=>row.model==='fake/worker'),primaries=reports.filter(row=>row.model==='fake/primary');assert.ok(primaries.length>=1,'actual root model fallback must launch primary');assert.equal(workers.length,2,'corrupt fallback session must retry freshly');assert.equal(reports.length,primaries.length+4,JSON.stringify(reports));assert.equal(new Set(reports.filter(row=>row.assignment).map(row=>row.assignment.capability)).size,reports.filter(row=>row.assignment).length);
 const specialist=reports.find(row=>row.model==='fake/worker'),nested=reports.find(row=>row.model==='fake/nested'),reader=reports.find(row=>row.model==='fake/research');
 assert.equal(specialist.assignment,null);assert.equal(nested.assignment,null);
 assert.equal(reader.assignment,null);assert.equal(reader.tools,'read,grep,find,ls');assert.equal(nested.config,false);assert.ok(reports.every(row=>row.safe&&row.cwd===ctx.cwd));
 const {damageAssessmentFrame}=await import(${JSON.stringify(new URL('./damage-guard-broker.ts',import.meta.url).href)});const {connect}=await import('node:net');
 const outcome=assignment=>new Promise((resolve,reject)=>{const socket=connect(assignment.path);let body='';socket.on('error',reject);socket.on('connect',()=>socket.write(JSON.stringify(damageAssessmentFrame(assignment,'after-launch','bash',{command:'echo probe'}))+'\\n'));socket.on('data',bytes=>body+=bytes);socket.on('close',()=>resolve(body?JSON.parse(body.trim()).outcome:null));});
 for(const row of reports.filter(row=>row.assignment))assert.equal(await outcome(row.assignment),'revoked','every physical owner and descendant is revoked when its launch settles');
 const {damageActionHashes}=await import(${JSON.stringify(new URL('../lib/damage-action-hash.ts',import.meta.url).href)});
 const accepted=entries.filter(row=>row.customType==='damage-guard-input').at(-1).data,input={command:'echo denied original input'};
 entries.push({customType:'damage-guard-denial',data:{schema:'damage-denial/v1',taskId:accepted.taskId,inputRevision:accepted.revision,operation:'bash',target:damageActionHashes('bash',input).target,cwd:ctx.cwd,decision:'deny'}});
 await emit('session_start',{type:'session_start'});assert.equal(registration,null);
 const {assessDamageCall}=await import(${JSON.stringify(new URL('../lib/damage-guard-port.ts',import.meta.url).href)});
 const event={toolName:'bash',toolCallId:'resumed-deny',input},baseline={cwd:ctx.cwd,revalidateBaseline:()=>true};
 assert.equal((await assessDamageCall(event,baseline)).block,true);assert.equal(asks,0);
 ctx.hasUI=true;ctx.ui.select=async()=>{asks++;return 'Allow once'};await commands.get('af-damage-override').handler('resumed-deny',ctx);assert.equal(asks,0,'root override only arms a dialog');
 assert.equal((await assessDamageCall({...event,toolCallId:'new-ipc-id'},baseline)).block,false);assert.equal(asks,1);
 assert.equal((await assessDamageCall({...event,toolCallId:'replay'},baseline)).block,true);assert.equal(asks,1);
 await commands.get('af-damage-override').handler('replay',ctx);let entered,late;const waiting=new Promise(resolve=>entered=resolve);ctx.ui.select=async(_q,_options,{signal})=>{asks++;entered();return new Promise(resolve=>{late=resolve;signal.addEventListener('abort',()=>resolve(undefined),{once:true});});};
 const pending=assessDamageCall({...event,toolCallId:'root-wait'},baseline);await waiting;await emit('session_start',{type:'session_start'});assert.equal((await pending).block,true);late('Allow once');assert.equal((await assessDamageCall({...event,toolCallId:'after-late-response'},baseline)).block,true);
 failInput=true;await emit('input',{text:'Different accepted input whose persistence fails',source:'interactive'});
 assert.equal((await assessDamageCall({...event,toolCallId:'failed-input'},baseline)).block,true);assert.throws(()=>prepareDamageGuardNative(pi,{ownerId:'after-disk-failure',cwd:ctx.cwd,tools:['bash'],admit:()=>true}));
 await emit('session_shutdown',{type:'session_shutdown'});
 await emit('session_shutdown',{type:'session_shutdown'});
 console.log('F8_ROOT_CALLBACKS_OK');
 `;
 try{for(const d9 of ['absent','off']){
  if(d9==='off'){writeFileSync(join(root,'.ai','agent-fleet.json'),JSON.stringify({features:{system1:true}}));writeFileSync(join(root,'.ai','system1.json'),JSON.stringify({...document,consumers:{damageGuard:{mode:'off'},fileDiscovery:{mode:'off'}}}));rmSync(join(root,'report'),{force:true});rmSync(join(root,'retry.once'),{force:true});}
  const result=spawnSync(process.execPath,['--experimental-transform-types','--input-type=module','--eval',source],{cwd:root,env:{PATH:root+':'+process.env.PATH,HOME:root,NODE_OPTIONS:(process.env.NODE_OPTIONS??'')+' --experimental-transform-types',TERM:'dumb',TYPESAFE_API_KEY:'synthetic-secret',AF_D6_ASSIGNMENT:'synthetic-forged'},encoding:'utf8',timeout:20000});assert.equal(result.status,0,d9+': '+result.stderr+result.stdout);assert.match(result.stdout,/F8_ROOT_CALLBACKS_OK/);
 }}finally{rmSync(root,{recursive:true,force:true});}
});

test('F8 registered configuration/reset overlap never publishes stale session or capabilities',{timeout:3000},async()=>{
 const {mkdtempSync,mkdirSync,writeFileSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const {configureDamageGuardHub,resetDamageGuardHub,prepareDamageGuardNative,acceptDamageGuardInput}=await import('./damage-guard-hub.ts');
 const root=mkdtempSync(join(tmpdir(),'d6-overlap-'));mkdirSync(join(root,'.ai'));writeFileSync(join(root,'.ai','agent-fleet.json'),JSON.stringify({features:{system1:false}}));
 const entries:any[]=[],handlers=new Map<string,any>(),pi:any={events:{on(){return ()=>{}},emit(){}},on:(name:string,fn:any)=>handlers.set(name,fn),registerCommand(){},appendEntry:(customType:string,data:any)=>entries.push({customType,data})};
 const childKeys=['AGENT_HUB_AGENT_ID','AGENT_FLEET_AGENTIC_CHILD'],saved=childKeys.map(key=>process.env[key]);childKeys.forEach(key=>delete process.env[key]);
 const ctx:any={cwd:root,hasUI:false,sessionManager:{getEntries:()=>entries},ui:{notify(){}}};const options={snapshot:normalizeSystem1Config(null),ctx,taskId:()=> 'task',childAuthority:{taskToken:()=> 'token',admit:()=>true}};
 try{
  const first=configureDamageGuardHub(pi,options);acceptDamageGuardInput(pi,'input');const closed=resetDamageGuardHub(pi);assert.equal(resetDamageGuardHub(pi),closed);
  const second=configureDamageGuardHub(pi,options);assert.throws(()=>prepareDamageGuardNative(pi,{ownerId:'old',cwd:root,tools:['bash'],admit:()=>true}));
  await Promise.all([first,closed,second]);const registration=prepareDamageGuardNative(pi,{ownerId:'fresh',cwd:root,tools:['bash'],admit:()=>true});assert.equal(registration,null);
  await handlers.get('session_shutdown')();assert.throws(()=>prepareDamageGuardNative(pi,{ownerId:'late',cwd:root,tools:['bash'],admit:()=>true}));
 }finally{await resetDamageGuardHub(pi);childKeys.forEach((key,index)=>{if(saved[index]===undefined)delete process.env[key];else process.env[key]=saved[index];});rmSync(root,{recursive:true,force:true});}
});
test('F8 transport disconnect aborts human wait and never transfers a late grant',{timeout:3000},async()=>{
 let entered!:()=>void;const waiting=new Promise<void>(r=>entered=r);let aborted=false;
 const session=fixture({ask:async(_id:string,_q:unknown,signal:AbortSignal)=>{entered();return new Promise(resolve=>signal.addEventListener('abort',()=>{aborted=true;resolve({details:{cancelled:true}});},{once:true}));}});session.accept('input');await session.start();
 try{const lease=await session.prepare({ownerId:'disconnect',cwd:process.cwd(),tools:['bash'],admit:()=>true})!.open({tools:['bash'],cwd:process.cwd()});
 const socket=connect(lease.assignment.path);socket.on('error',()=>{});await new Promise<void>(r=>socket.once('connect',r));socket.write(JSON.stringify(damageAssessmentFrame(lease.assignment,'first','bash',{command:'echo hello'}))+'\n');await waiting;
 socket.destroy();await new Promise<void>(r=>setTimeout(r,20));assert.equal(aborted,true);
 lease.revoke();assert.equal((await request(lease.assignment,damageAssessmentFrame(lease.assignment,'after-disconnect','bash',{command:'echo hello'}))).outcome,'revoked');
 }finally{await session.dispose();}
});

test('F8 failed mandatory broker startup fences parent admission rather than unregistering to standalone permission',{timeout:3000},async()=>{
 const {mkdtempSync,mkdirSync,writeFileSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const {configureDamageGuardHub,resetDamageGuardHub,prepareDamageGuardNative}=await import('./damage-guard-hub.ts');const {assessDamageCall}=await import('../lib/damage-guard-port.ts');
 const root=mkdtempSync(join(tmpdir(),'d6-unsupported-'));mkdirSync(join(root,'.ai'));writeFileSync(join(root,'.ai','agent-fleet.json'),JSON.stringify({features:{system1:true}}));
 const keys=['AGENT_HUB_AGENT_ID','AGENT_FLEET_AGENTIC_CHILD'],saved=keys.map(key=>process.env[key]);keys.forEach(key=>delete process.env[key]);const descriptor=Object.getOwnPropertyDescriptor(process,'platform')!;
 const pi:any={events:{on(){return ()=>{}},emit(){}},on(){},registerCommand(){},appendEntry(){}};const ctx:any={cwd:root,hasUI:false,sessionManager:{getEntries:()=>[]},ui:{notify(){}}};
 try{Object.defineProperty(process,'platform',{...descriptor,value:'win32'});
 await configureDamageGuardHub(pi,{snapshot:normalizeSystem1Config(null),ctx,taskId:()=> 'task',childAuthority:{taskToken:()=> 'token',admit:()=>true}});
 assert.equal(prepareDamageGuardNative(pi,{ownerId:'off-child',cwd:root,tools:['bash'],admit:()=>true}),null,'off mode works without supported IPC');await resetDamageGuardHub(pi);
 await assert.rejects(configureDamageGuardHub(pi,{snapshot:normalizeSystem1Config(document),ctx,taskId:()=> 'task',childAuthority:{taskToken:()=> 'token',admit:()=>true}}),/damage_local_ipc_unsupported/);
 assert.equal((await assessDamageCall({toolName:'bash',toolCallId:'after-failure',input:{command:'echo hello'}},{cwd:root,revalidateBaseline:()=>true})).block,true);
 assert.throws(()=>prepareDamageGuardNative(pi,{ownerId:'child',cwd:root,tools:['bash'],admit:()=>true}));
 }finally{Object.defineProperty(process,'platform',descriptor);await resetDamageGuardHub(pi);keys.forEach((key,index)=>{if(saved[index]===undefined)delete process.env[key];else process.env[key]=saved[index];});rmSync(root,{recursive:true,force:true});}
});
test('F8 parent and physical owners share outage backoff without per-request inference retries',{timeout:3000},async()=>{
 let calls=0;const session=fixture({service:{evaluate:async()=>{calls++;throw Error('synthetic provider outage');}}});session.accept('input');await session.start();
 try{const one=await session.prepare({ownerId:'one',cwd:process.cwd(),tools:['bash'],admit:()=>true})!.open({tools:['bash'],cwd:process.cwd()}),two=await session.prepare({ownerId:'two',cwd:process.cwd(),tools:['bash'],admit:()=>true})!.open({tools:['bash'],cwd:process.cwd()});
 assert.equal((await request(one.assignment,damageAssessmentFrame(one.assignment,'one','bash',{command:'echo hello'}))).outcome,'indeterminate');
 assert.equal((await request(two.assignment,damageAssessmentFrame(two.assignment,'two','bash',{command:'echo hello'}))).outcome,'unavailable');
 assert.equal((await session.call({toolName:'bash',toolCallId:'parent',input:{command:'echo hello'}},{cwd:process.cwd(),revalidateBaseline:()=>true})).block,false);assert.equal(calls,1);
 }finally{await session.dispose();}
});
