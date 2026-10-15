import test from 'node:test';
import assert from 'node:assert/strict';
import {cpSync,existsSync,mkdtempSync,mkdirSync,readFileSync,readdirSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const entries=[
 'agent-hub/damage-guard-hub.ts','agent-hub/damage-guard-broker.ts','agent-hub/damage-guard-owners.ts',
 'agent-hub/damage-guard-state.ts','agent-hub/damage-guard-approval.ts','agent-hub/damage-guard-contract.ts',
 'damage-control-continue/system1-child.ts','damage-control-continue/system1-client.ts',
 'damage-control-continue/system1-guard.ts','damage-control-continue/result-screen.ts',
 'lib/damage-control-shared.ts','lib/damage-guard-port.ts','lib/damage-result-evidence.ts',
 'lib/system1/config-v2.js','lib/system1/config-loader.js','lib/system1/service.ts',
 'agent-hub/file-discovery/hub.ts','agent-hub/file-discovery/child-extension.ts','agent-hub/file-discovery/adapters.ts',
];
const forbidden=/(^|\/)(fixtures|bin\/test)(\/|$)|\.test\.[^/]+$|\.test-support\.ts$|damage-guard-test-tsconfig\.json$/;

// This runner is written only into disposable storage. All production imports below
// resolve under the copied, extracted artifact, never the repository harness tree.
const runner=String.raw`
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {registerHooks} from 'node:module';
import {fileURLToPath} from 'node:url';
const harness=new URL('./harnesses/',import.meta.url);
registerHooks({resolve(s,c,next){
 const alias=s.replace('@mariozechner/pi-coding-agent','@earendil-works/pi-coding-agent').replace('@mariozechner/pi-tui','@earendil-works/pi-tui');
 const resolved=next(alias,c);
 if(c.parentURL?.startsWith(harness.href)&&s.startsWith('.')){
  assert.ok(resolved.url.startsWith(harness.href),'relative runtime import escaped extracted tree: '+s);
  assert.doesNotMatch(resolved.url,/\/fixtures\/|\.test\.|\.test-support\./);
 }
 return resolved;
}});
const {createDamageHubSession,registerDamageGuardHub,configureDamageGuardHub,acceptDamageGuardInput,resetDamageGuardHub}=await import('./harnesses/agent-hub/damage-guard-hub.ts');
const {normalizeSystem1Config}=await import('./harnesses/lib/system1/config-v2.js');
const {createDamageClient}=await import('./harnesses/damage-control-continue/system1-client.ts');
const {createDamageChild}=await import('./harnesses/damage-control-continue/system1-child.ts');
const {captureDamageResult}=await import('./harnesses/lib/damage-result-evidence.ts');
const {registerDiscoveryHub,configureDiscoveryHub,resetDiscoveryHub}=await import('./harnesses/agent-hub/file-discovery/hub.ts');
const {default:registerDiscoveryChild}=await import('./harnesses/agent-hub/file-discovery/child-extension.ts');
const {createDiscoveryOwners,discoveryAssignmentEnv}=await import('./harnesses/agent-hub/file-discovery/owners.ts');
const {createDiscoveryBroker}=await import('./harnesses/agent-hub/file-discovery/broker.ts');
const {createDiscoveryRuntime}=await import('./harnesses/agent-hub/file-discovery/runtime.ts');
const {parseFileDiscoveryConfig}=await import('./harnesses/lib/system1/config-file-discovery.js');
const {ExtensionRunner}=await import('@earendil-works/pi-coding-agent');
const severe={status:'ok',evaluation:{answers:[{questionId:'effect',type:'choice',value:'severe',uncertainty:{provenance:'provider'}},{questionId:'evidence',type:'choice',value:'sufficient',uncertainty:{provenance:'provider'}}],metadata:{provider:'typesafe',requestedModel:'jev-1.13.0',returnedModel:'jev-1.13.0',questionSetVersion:'damage-guard/v1',latencyMs:1,attempts:1}}};
const base=fileURLToPath(new URL('./work/',import.meta.url));mkdirSync(base);
function workspace(name){const root=join(base,name);mkdirSync(root);for(const d of ['docs','.ai','.pi'])mkdirSync(join(root,d));writeFileSync(join(root,'docs/source'),'public fixture');writeFileSync(join(root,'.ai/agent-fleet.json'),JSON.stringify({features:{system1:true}}));writeFileSync(join(root,'.ai/system1.json'),JSON.stringify({version:2,mode:'auto',provider:'typesafe',model:'jev-1.13.0',apiKeyEnv:'TYPESAFE_API_KEY',consumers:{fileDiscovery:{mode:'off'}}}));return root;}
function config(mode){const raw={version:2,mode:mode==='root-off'?'off':'auto',provider:'typesafe',model:'jev-1.13.0',apiKeyEnv:'TYPESAFE_API_KEY',consumers:{damageGuard:{mode:mode==='off'?'off':mode==='invalid'?'invalid':'active',remoteScopes:{commands:true,results:true},include:['docs']}}};if(mode==='missing')delete raw.consumers.damageGuard;return normalizeSystem1Config(raw);}
function port(){const handlers=new Map(),entries=[];return {handlers,entries,pi:{registerTool(){},on(n,h){handlers.set(n,[...(handlers.get(n)||[]),h]);},appendEntry(customType,data){entries.push({customType,data});}}};}
function pipeline(handlers,root,ctx){const r=new ExtensionRunner([{path:'extracted',handlers}],{},root,{},{});r.createContext=()=>ctx;return r;}
function original(toolName='read'){return {toolName,toolCallId:'result',input:toolName==='read'?{path:'docs/source'}:{path:'docs',pattern:'*'},content:[{type:'text',text:toolName==='read'?'public fixture':'a.ts\nb.ts'}],structuredContent:{retained:'original'},details:{retained:true},status:'ok',exit_code:0,isError:false,usage:{inputTokens:2}};}
function preserved(view,event){assert.deepEqual(view.content[0],event.content[0]);assert.equal(view.status,event.status);assert.equal(view.exit_code,event.exit_code);assert.equal(view.isError,event.isError);assert.deepEqual(view.usage,event.usage);assert.deepEqual(view.details.truncation,event.details.truncation);if(typeof event.structuredContent==='string')assert.ok(view.structuredContent.startsWith(event.structuredContent));else assert.deepEqual(view.structuredContent.originalStructuredContent,event.structuredContent);}
for(const mode of ['missing','off','invalid','root-off','key-unavailable','active','failure']){
 const root=workspace(mode);let calls=0;const rows=[];
 const service=mode==='key-unavailable'?undefined:{evaluate:async()=>{calls++;return mode==='failure'?{status:'unavailable',reason:'network'}:severe;}};
 const session=createDamageHubSession({root,selected:true,snapshot:config(mode),taskId:()=> 'task',childAuthority:{taskToken:()=> 'token',admit:()=>true},append:(customType,data)=>rows.push({customType,data}),entries:()=>rows,canRead:()=>true,service,ask:async id=>({details:{runtimeAsk:{requestId:id},response:{kind:'selection',selections:['Allow once']}}})});
 let client,child;
 try{
  session.accept('synthetic input');await session.start();
  const lease=session.prepare({ownerId:'reader',cwd:root,tools:['read','bash'],admit:()=>true}).open({cwd:root,tools:['read','bash']});
  client=createDamageClient(lease.assignment);
  const command=await client.assess('bash',{command:'echo public fixture'});
  assert.equal(command.outcome,mode==='active'?'granted':'unavailable');
  const event=original();delete event.structuredContent;event.details={truncation:{truncated:false}};
  const result=await client.result(event);assert.equal(result.warning,mode==='active');assert.equal(result.sourceTrusted,false);
  child=createDamageChild(lease.assignment);
  const decorated=await child.result({...event,toolCallId:'child'});assert.deepEqual(decorated.content[0],event.content[0]);assert.deepEqual(decorated.details,event.details);assert.equal(decorated.status,'ok');assert.equal(decorated.exit_code,0);assert.deepEqual(decorated.usage,event.usage);
  assert.match(decorated.content.at(-1).text,mode==='active'?/Untrusted Damage-Control advisory/:/not_evaluated/);
  assert.equal(calls,mode==='active'?3:mode==='failure'?1:0);
  console.log('PASS extracted broker/client command + result + child '+mode+' calls='+calls);
 }finally{child?.dispose();client?.dispose();await session.dispose();}
}
// Production original -> D6 -> D8 parent and child adapters, with D8 off/failure.
for(const side of ['parent','child'])for(const mode of ['active','off','failure']){
 const root=workspace(side+'-'+mode);for(const n of ['a.ts','b.ts'])writeFileSync(join(root,'docs',n),'public fixture');
 const p=port();const ctx={cwd:root,sessionManager:{getEntries:()=>p.entries,getSessionId:()=> 'fixture'},ui:{notify(){},setStatus(){}},hasUI:false};
 let child,session,discoveryRuntime,discoveryOwners,discoveryBroker;let damageCalls=0,rankCalls=0;
 const damageService={evaluate:async()=>{damageCalls++;return mode==='failure'?{status:'unavailable',reason:'network'}:severe;}};
 const discoveryService={evaluate:async request=>{rankCalls++;return mode==='failure'?{status:'unavailable',reason:'network'}:{status:'ok',evaluation:{answers:request.questions.map(q=>({questionId:q.id,type:q.type,uncertainty:{provenance:'provider'},...(q.type==='ordinal'?{value:0,levels:q.levels}:q.type==='choice'?{value:Object.keys(q.options)[0]}:{probabilityTrue:0.5})})),metadata:{}}};}};
 try{
  if(side==='parent'){
   registerDamageGuardHub(p.pi);registerDiscoveryHub(p.pi);
   const snapshot=structuredClone(config(mode));snapshot.consumers.fileDiscovery=normalizeSystem1Config({version:2,mode:'auto',provider:'typesafe',model:'jev-1.13.0',apiKeyEnv:'TYPESAFE_API_KEY',consumers:{fileDiscovery:{mode:mode==='off'?'off':'active',remoteContextApproved:true,include:['docs']}}}).consumers.fileDiscovery;
   await configureDamageGuardHub(p.pi,{ctx,snapshot,taskId:()=> 'task',service:damageService});acceptDamageGuardInput(p.pi,'find synthetic files');
   await configureDiscoveryHub(p.pi,{ctx,snapshot,taskId:()=> 'task',sessionDir:root,service:discoveryService});
  }else{
   const rows=[];session=createDamageHubSession({root,selected:true,snapshot:config(mode),taskId:()=> 'task',childAuthority:{taskToken:()=> 'token',admit:()=>true},append:(customType,data)=>rows.push({customType,data}),entries:()=>rows,canRead:()=>true,service:damageService,ask:async()=>{throw Error('no ask');}});session.accept('find synthetic');await session.start();
   const lease=session.prepare({ownerId:'child',cwd:root,tools:['read'],admit:()=>true}).open({cwd:root,tools:['read']});child=createDamageChild(lease.assignment);
   p.pi.on('tool_result',e=>{captureDamageResult(e);return child.result(e);});
   const discoveryConfig=parseFileDiscoveryConfig({mode:mode==='off'?'off':'active',remoteContextApproved:true,include:['docs']});
   discoveryRuntime=createDiscoveryRuntime({root,sessionId:'fixture',config:discoveryConfig,service:discoveryService,context:()=> 'task',persist(){}});
   discoveryOwners=createDiscoveryOwners('fixture',()=> 'task');discoveryBroker=await createDiscoveryBroker({root,runtime:discoveryRuntime,owners:discoveryOwners});
   const owner=discoveryOwners.register({taskId:'task',ownerId:'reader',attemptId:'attempt',cwd:root,task:'find synthetic',query:'find synthetic',effectiveTools:['find','read'],readRoots:['docs'],exportRoots:['docs'],canRead:()=>true,canDisplay:()=>true,permissionIdentity:()=> 'fixture'});
   Object.assign(process.env,discoveryAssignmentEnv(discoveryOwners.assignment(owner,discoveryBroker.endpoint),root,['docs']));
   registerDiscoveryChild(p.pi);
  }
  for(const tool of ['find','read']){
   if(!p.entries.some(row=>row.type==='message'))p.entries.push({type:'message',message:{role:'user',content:'find synthetic files'}});
   const event=original(tool);event.details={truncation:{truncated:false}};
   // read must match the source bytes; find retains native structured evidence.
   if(tool==='read')event.structuredContent='public fixture';
   const expected=structuredClone(event),view={...event,...await pipeline(p.handlers,root,ctx).emitToolResult(event)};
   assert.deepEqual(event,expected);preserved(view,expected);
   const metadata=tool==='find'?view.structuredContent.damageGuard.metadata:JSON.parse(view.content[1].text.split('Damage-Control result coverage: ')[1]);
   assert.equal(metadata.warning,tool==='read'&&mode==='active');assert.equal(metadata.sourceTrusted,false);
   assert.equal(metadata.coverage,tool==='read'&&mode==='active'?'complete':'none');
   assert.equal(metadata.status,tool==='read'&&mode==='active'?'evaluated':'not_evaluated');
   assert.match(view.content[1].text,tool==='read'&&mode==='active'?/Untrusted Damage-Control advisory/:/not_evaluated/);
   if(tool==='find'){
    assert.equal(metadata.reason,side==='parent'&&mode==='off'?'consumer_off':'unsupported_source');
    if(side==='parent'&&mode==='off')assert.deepEqual(view.details,event.details);
    else {assert.match(view.content.at(-1).text,/File discovery advice:/);assert.deepEqual(view.structuredContent.damageGuard.metadata,metadata);assert.equal(view.details.fileDiscovery.counts.discovered,2);assert.equal(view.details.fileDiscovery.evaluationComplete,mode==='active');assert.equal(view.details.fileDiscovery.counts.evaluated,mode==='active'?2:0);}
   }else assert.deepEqual(view.details,event.details);
  }
  assert.equal(damageCalls,mode==='off'?0:1);assert.equal(rankCalls>0,mode!=='off',side+' '+mode+' rank calls='+rankCalls);
  console.log('PASS extracted original→D6→D8 '+side+' '+mode+' preserves evidence and coverage');
 }finally{child?.dispose();await session?.dispose();discoveryRuntime?.dispose();discoveryOwners?.dispose();await discoveryBroker?.close();await resetDamageGuardHub(p.pi);await resetDiscoveryHub(p.pi);for(const k of Object.keys(process.env))if(k.startsWith('AF_D9_'))delete process.env[k];}
}
`;

test('F12 offline packed artifact contains guide and runtime-only import closure and executes D6/D8 APIs',{timeout:120000},()=>{
 const temp=mkdtempSync(join(tmpdir(),'d6-package-'));
 try{
  for(const name of ['home','config','cache','unpacked','fixture'])mkdirSync(join(temp,name));
  const empty=join(temp,'empty.npmrc');writeFileSync(empty,'');
  // npm always considers a project .npmrc: refuse rather than read protected config.
  assert.equal(existsSync(join(repo,'.npmrc')),false,'packing requires a repository without protected project npm configuration');
  const env={PATH:process.env.PATH,HOME:join(temp,'home'),XDG_CONFIG_HOME:join(temp,'config'),XDG_CACHE_HOME:join(temp,'cache'),NPM_CONFIG_USERCONFIG:empty,NPM_CONFIG_GLOBALCONFIG:join(temp,'global.npmrc'),NPM_CONFIG_CACHE:join(temp,'cache'),NODE_OPTIONS:`--import=${join(repo,'bin/test/helpers/system1-no-network.js')}`};
  writeFileSync(env.NPM_CONFIG_GLOBALCONFIG,'');
  const packed=JSON.parse(execFileSync('npm',['pack','--ignore-scripts','--offline','--json','--pack-destination',temp],{cwd:repo,env,encoding:'utf8',timeout:90000,maxBuffer:10*1024*1024}));
  const files:string[]=packed[0].files.map((f:{path:string})=>f.path);
  assert.ok(files.includes('docs/system1-damage-guard.md'),'D6 guide must ship');
  for(const file of files.filter(f=>f.startsWith('.pi/harnesses/')||f.startsWith('bin/test/')))assert.equal(forbidden.test(file),false,`excluded project test artifact shipped: ${file}`);
  assert.equal(files.some(f=>f.startsWith('bin/test/')),false);
  execFileSync('tar',['-xzf',join(temp,packed[0].filename),'-C',join(temp,'unpacked')],{env,timeout:30000});
  const extracted=join(temp,'unpacked/package'),fixture=join(temp,'fixture'),harness=join(fixture,'harnesses');
  assert.match(readFileSync(join(extracted,'docs/system1-damage-guard.md'),'utf8'),/Damage|damage/);
  // Third-party bytes are not runtime harness bytes; use local dependencies only.
  cpSync(join(extracted,'.pi/harnesses'),harness,{recursive:true,filter:path=>!path.split('/').includes('node_modules')});
  writeFileSync(join(fixture,'package.json'),'{"type":"module"}');
  assert.ok(existsSync(join(repo,'node_modules/@earendil-works/pi-coding-agent')),'existing local SDK required; do not install');
  symlinkSync(join(repo,'node_modules'),join(temp,'node_modules'),'dir');
  const visited=new Set<string>();
  function closure(file:string){
   assert.ok(file.startsWith(harness+'/'));assert.equal(forbidden.test(file),false,`runtime imported test infrastructure: ${file}`);
   assert.ok(existsSync(file),`missing extracted runtime import: ${file}`);if(visited.has(file))return;visited.add(file);
   const source=readFileSync(file,'utf8');
   for(const dep of ts.preProcessFile(source,true,true).importedFiles){if(!dep.fileName.startsWith('.'))continue;const target=resolve(dirname(file),dep.fileName);closure(target);}
  }
  for(const entry of entries)closure(join(harness,entry));
  console.log(`PASS extracted runtime import closure: ${visited.size} project modules`);
  writeFileSync(join(fixture,'runner.mjs'),runner);
  const output=execFileSync(process.execPath,[join(fixture,'runner.mjs')],{cwd:fixture,env,encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024});
  console.log(output.trim());
  // Also inspect copied bytes, independently of npm's JSON listing.
  function inspect(dir:string){for(const entry of readdirSync(dir,{withFileTypes:true})){const file=join(dir,entry.name);assert.equal(forbidden.test(file),false,file);if(entry.isDirectory())inspect(file);}}
  inspect(harness);
 }finally{rmSync(temp,{recursive:true,force:true});}
});
