import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {normalizeSystem1Config} from '../lib/system1/config-v2.js';
import {originalDamageResult, damageCaptureState} from '../lib/damage-result-evidence.ts';
import {registerDamageGuardHub, configureDamageGuardHub, acceptDamageGuardInput, resetDamageGuardHub} from '../agent-hub/damage-guard-hub.ts';
import {registerDiscoveryHub, configureDiscoveryHub, resetDiscoveryHub} from '../agent-hub/file-discovery/hub.ts';
import {createDamageHubSession} from '../agent-hub/damage-guard-hub.ts';
import {createDiscoveryRuntime} from '../agent-hub/file-discovery/runtime.ts';
import {createDiscoveryOwners, discoveryAssignmentEnv} from '../agent-hub/file-discovery/owners.ts';
import {createDiscoveryBroker} from '../agent-hub/file-discovery/broker.ts';

registerHooks({resolve(s, c, next) { return next(s === '@mariozechner/pi-coding-agent' ? '@earendil-works/pi-coding-agent' : s, c); }});
// Deliberately no fallback/skip: an absent installed SDK, executor or WASM fails proof.
const {default:registerSafety}=await import('./index.ts');
const {default:registerDiscoveryChild}=await import('../agent-hub/file-discovery/child-extension.ts');
const sdkURL = import.meta.resolve('@earendil-works/pi-coding-agent');
const {AgentSession, SessionManager, SettingsManager, createCodemodeExtension} = await import('@earendil-works/pi-coding-agent');
const {Agent, runToolCall} = await import('@earendil-works/pi-agent-core');
const {createExtensionRuntime, loadExtensionFromFactory} = await import(new URL('./core/extensions/loader.js', sdkURL).href);
const {createEventBus} = await import(new URL('./core/event-bus.js', sdkURL).href);
const packageVersion = (url: string) => JSON.parse(readFileSync(new URL('../package.json', url), 'utf8')).version;
const versions = {sdk: packageVersion(sdkURL), codemode: packageVersion(import.meta.resolve('@earendil-works/pi-codemode')), node: process.version};
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

const severe: any = {status:'ok', evaluation:{answers:[
 {questionId:'effect', type:'choice', value:'severe', uncertainty:{provenance:'provider'}},
 {questionId:'evidence', type:'choice', value:'sufficient', uncertainty:{provenance:'provider'}}
], metadata:{provider:'typesafe', requestedModel:'jev-1.13.0', returnedModel:'jev-1.13.0', questionSetVersion:'damage-guard/v1', latencyMs:1, attempts:1}}};

/** Explicit factories and inert loader/runtime: no discovery or default auth/settings reads. */
type Options = {child?:boolean; mode?:'severe'|'unknown'|'insufficient'|'off'|'outage'; d8?:boolean; tool?:'read'|'find'; shape?:'absent'|'string'|'object'|'collision'; failure?:'function'|'cycle'|'unsupported'; error?:boolean};
async function fixture(t: any, structured: boolean, options:Options = {}) {
 const {child=false, mode='severe', d8=true, tool='find', failure, error=false} = options;
 const shape=options.shape??(structured?'object':'absent');
 t.diagnostic(JSON.stringify(versions));
 assert.equal(versions.sdk, '1.1.0');
 assert.equal(versions.codemode, '1.1.0');
 const root = mkdtempSync(join(tmpdir(), 'f10-codemode-'));
 const saved = ['AGENT_HUB_AGENT_ID', 'AGENT_FLEET_AGENTIC_CHILD', 'AF_D9_REGISTERED', 'AF_D9_ROOT', 'AF_D9_READ_ROOTS', 'AF_D9_ENDPOINT', 'AF_D9_CAPABILITY', 'AF_D9_SESSION_ID', 'AF_D9_TASK_ID', 'AF_D9_OWNER_ID', 'AF_D9_ATTEMPT_ID', 'AF_D9_QUERY_HASH'].map(key => [key, process.env[key]]);
 for (const [key] of saved) delete process.env[key!];
 t.after(() => { for (const [key, value] of saved) { if (value === undefined) delete process.env[key!]; else process.env[key!] = value; } });
 for (const dir of ['docs', '.ai', '.pi', 'agent']) mkdirSync(join(root, dir));
 t.after(() => rmSync(root, {recursive:true, force:true}));
 writeFileSync(join(root, '.ai', 'agent-fleet.json'), JSON.stringify({features:{system1:true}}));
 for (const name of ['a.ts', 'b.ts']) writeFileSync(join(root, 'docs', name), 'public fixture');
 writeFileSync(join(root,'.pi','damage-control-rules.yaml'),JSON.stringify({bashToolPatterns:[],zeroAccessPaths:[],readOnlyPaths:[],noDeletePaths:[]}));
 // Only synthetic temporary configuration is visible to the production child adapter.
 writeFileSync(join(root,'.ai','system1.json'),JSON.stringify({version:2,mode:'off',consumers:{}}));
 const sessionManager = SessionManager.inMemory(root);
 const snapshot: any = normalizeSystem1Config({version:2, mode:'auto', provider:'typesafe', model:'jev-1.13.0', apiKeyEnv:'TYPESAFE_API_KEY', consumers:{
  damageGuard:{mode:mode==='off'?'off':'active', remoteScopes:{results:true}, include:['docs']},
  fileDiscovery:{mode:d8?'active':'off', remoteContextApproved:true, include:['docs'], limits:{}}
 }});
 let d6Calls = 0, d8Calls = 0;
 const requests: any[] = [], calls: any[] = [], results: any[] = [], observed: any[] = [];
 const body=tool==='find'?'a.ts\nb.ts':'public fixture';
 const original: any = {...(error?{isError:true}:{}),content:[{type:'text', text:body}], details:{truncation:{truncated:false}}, usage:{inputTokens:7, outputTokens:3}, ...(shape==='absent'?{}:{structuredContent:shape==='string'?body:shape==='collision'?{damageGuard:{retained:true},fileDiscovery:{retained:true},originalStructuredContent:'keep'}:{retained:'original'}})};
 if(failure==='function')original.details.extra=()=>{};
 if(failure==='cycle')original.details.extra=original.details;
 if(failure==='unsupported')original.details.extra=new Date(0);
 const before = failure?undefined:structuredClone(original), originalHash = failure?undefined:hash(before);
 const d6Service:any={evaluate:async(request:any)=>{
  d6Calls++; requests.push({d6:request});
  if(mode==='outage')return {status:'unavailable',reason:'network'};
  const result=structuredClone(severe);
  if(mode==='unknown')result.evaluation.answers[0].value='unknown';
  if(mode==='insufficient')result.evaluation.answers[1].value='insufficient';
  return result;
 }};
 const d8Service:any={evaluate:async(request:any)=>{
  d8Calls++; requests.push(request);
  return {status:'ok',evaluation:{answers:request.questions.map((q:any)=>({questionId:q.id,type:q.type,uncertainty:{provenance:'provider'},...(q.type==='ordinal'?{value:0,levels:q.levels}:q.type==='choice'?{value:Object.keys(q.options)[0]}:{probabilityTrue:0.5})})),metadata:{}}};
 }};
 let assignment:any;
 if(child){
  const damage=createDamageHubSession({root,selected:true,snapshot,taskId:()=> 'task',childAuthority:{taskToken:()=> 'token',admit:()=>true},append(){},entries:()=>[],canRead:()=>true,service:d6Service,ask:async()=>{throw Error('result screening must not ask');}});
  damage.accept('read public fixture'); await damage.start();
  t.after(()=>damage.dispose());
  const lease=damage.prepare({ownerId:'reader',cwd:root,tools:['read','find'],admit:()=>true})!.open({cwd:root,tools:['read']});
  assignment=lease.assignment;
  if(d8){
   const runtime=createDiscoveryRuntime({root,sessionId:'f10',config:snapshot.consumers.fileDiscovery.config,service:d8Service,context:()=> 'task',persist(){}});
   const owners=createDiscoveryOwners('f10',()=> 'task');
   const broker=await createDiscoveryBroker({root,runtime,owners});
   t.after(async()=>{runtime.dispose();owners.dispose();await broker.close();});
   const owner=owners.register({taskId:'task',ownerId:'reader',attemptId:'attempt',cwd:root,task:'find public fixtures',query:'find public fixtures',effectiveTools:['read','find'],readRoots:['docs'],exportRoots:['docs'],canRead:()=>true,canDisplay:()=>true,permissionIdentity:()=> 'p'});
   Object.assign(process.env,discoveryAssignmentEnv(owners.assignment(owner,broker.endpoint),root,['docs']));
  }
 }
 const runtime = createExtensionRuntime(), bus = createEventBus();
 let piRef: any;
 const factories = [
  createCodemodeExtension({models:false}),
  (pi: any) => {
   piRef = pi;
   pi.on('tool_call', (event: any) => { if (event.toolName === tool) calls.push(event); });
   if(child){registerSafety(pi,{assignment});if(d8)registerDiscoveryChild(pi);}
   else {registerDamageGuardHub(pi);registerDiscoveryHub(pi);}
   pi.on('session_start', async (_event: any, ctx: any) => {
    if(!child){
     await configureDamageGuardHub(pi, {ctx, snapshot, taskId:() => 'task', service:d6Service});
     await configureDiscoveryHub(pi, {ctx, snapshot, taskId:() => 'task', sessionDir:join(root, 'agent'), service:d8Service});
    }
    sessionManager.appendMessage({role:'user', content:'find public fixture files', timestamp:Date.now()});
    acceptDamageGuardInput(pi, 'find public fixture files');
   });
   pi.on('tool_result', (event: any) => {
    if (event.toolName !== tool) return;
    const evidence: any = originalDamageResult(event);
    observed.push({state:damageCaptureState(event), evidence, frozenHash:evidence?hash(evidence):undefined});
    results.push(event);
   });
  }
 ];
 const extensions = [];
 for (const [index, factory] of factories.entries()) {
  const loaded = await loadExtensionFromFactory(factory, root, bus, runtime, `f10-inline-${index}`);
  assert.ok(loaded);
  extensions.push(loaded);
 }
 const empty = () => ({diagnostics:[]});
 const resourceLoader: any = {
  getExtensions:() => ({extensions, errors:[], runtime}),
  getSkills:() => ({...empty(), skills:[]}), getPrompts:() => ({...empty(), prompts:[]}),
  getThemes:() => ({...empty(), themes:[]}), getAgentsFiles:() => ({agentsFiles:[]}),
  getSystemPrompt:() => 'Offline synthetic tool-call fixture', getAppendSystemPrompt:() => [],
  getSystemPromptSource:() => undefined, getAppendSystemPromptSources:() => [],
  extendResources() { throw Error('resource discovery is forbidden'); }, async reload() { throw Error('reload is forbidden'); }
 };
 const inert = () => { throw Error('model/provider runtime must remain unused'); };
 const modelRuntime: any = {getModels:() => [], getAvailableSnapshot:() => [], getModel:() => undefined, getPhysicalModel:() => undefined, getError:() => undefined, getAuth:inert, stream:inert, resolveModel:inert};
 const nestedCode=tool==='find'?'tools.find({path:"docs", pattern:"*"})':'tools.read({path:"docs/a.ts"})';
 const call = {type:'toolCall' as const, id:'codemode-fixture', name:'codemode', arguments:{code:`try { const value = await ${nestedCode}; text("F10_VALUE=" + JSON.stringify(value)); } catch (error) { text("F10_ERROR=" + String(error)); } text("F10_SANDBOX_COMPLETED");`}};
 // Synthetic assistant call, not a model response or provider invocation.
 const assistant: any = {role:'assistant', content:[call], api:'offline', provider:'fixture', model:'inert', stopReason:'toolUse', usage:{input:0, output:0, totalTokens:0, cost:{input:0, output:0, total:0}}, timestamp:Date.now()};
 const agent = new Agent({initialState:{messages:[assistant]}, streamFn:inert});
 const session = new AgentSession({agent, sessionManager, settingsManager:SettingsManager.inMemory(), cwd:root, resourceLoader, modelRuntime,
  initialActiveToolNames:[tool, 'codemode'], baseToolsOverride:{[tool]:{name:tool, label:'Synthetic permitted tool', description:'Read public fixtures', parameters:{type:'object', properties:{path:{type:'string'}, pattern:{type:'string'}}, required:['path'], additionalProperties:false}, ...(shape==='absent'?{}:{outputSchema:{type:shape==='string'?'string':'object'}}), execute:async () => original}}} as any);
 t.after(async () => { if(child)await session.extensionRunner.emit({type:'session_shutdown'}); await resetDamageGuardHub(piRef); await resetDiscoveryHub(piRef); session.dispose(); });
 await session.bindExtensions({onError:(error: any) => { throw Error(JSON.stringify(error)); }});
 const events: any[] = [];
 session.subscribe((event: any) => events.push(event));
 const outcome = await runToolCall(call, {tools:agent.state.tools, assistantMessage:assistant, context:{messages:agent.state.messages, tools:agent.state.tools}, beforeToolCall:agent.beforeToolCall, afterToolCall:agent.afterToolCall});
 return {outcome, original, before, originalHash, calls, results, observed, events, requests, d6Calls, d8Calls};
}

// TDD vertical: establish text fallback, then require the same advice in schema-backed script values.
// Keep the original regression assertion: parent D8 must not vanish from script values.
for (const structured of [false, true]) test(`F10 real SDK parent original→D6→D8 discovery script visibility structured=${structured}`, async t => {
 const f = await fixture(t, structured);
 const script = f.outcome.result.content.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('\n');
 assert.equal(f.outcome.isError, false, script);
 assert.match(script, /Script completed/);
 assert.match(script, /F10_SANDBOX_COMPLETED/);
 assert.equal(f.calls.length, 1);
 assert.equal(f.calls[0].toolCallId, 'codemode-fixture/1');
 assert.equal(f.calls[0].parentToolCallId, 'codemode-fixture');
 assert.equal(f.results.length, 1);
 const nested = f.events.filter(event => event.type === 'tool_execution_end' && event.toolName === 'find');
 assert.equal(nested.length, 1);
 assert.equal(nested[0].parentToolCallId, 'codemode-fixture');
 assert.equal(f.d6Calls, 0, 'find is unsupported D6 inference source');
 assert.equal(f.d8Calls, 2, JSON.stringify({requests:f.requests, script}));
 assert.deepEqual(f.requests.map(request => request.state.source.path).sort(), ['docs/a.ts', 'docs/b.ts']);
 assert.equal(f.observed[0].state, 'captured');
 const evidence = f.observed[0].evidence;
 assert.ok(Object.isFrozen(evidence));
 assert.ok(Object.isFrozen(evidence.content));
 assert.notEqual(evidence.content, f.original.content);
 assert.notEqual(evidence.details, f.original.details);
 assert.deepEqual(evidence.content, f.before.content);
 assert.deepEqual(evidence.details, f.before.details);
 assert.deepEqual(evidence.usage, f.before.usage);
 assert.equal(evidence.isError, false);
 assert.equal(evidence.toolCallId, 'codemode-fixture/1');
 assert.equal(hash(evidence), f.observed[0].frozenHash);
 assert.equal(hash(f.original), f.originalHash);
 assert.deepEqual(f.original, f.before);
 assert.deepEqual(nested[0].result.content[0], f.before.content[0]);
 assert.deepEqual(nested[0].result.usage, f.before.usage);
 assert.equal(nested[0].isError, false);
 assert.deepEqual(nested[0].result.details.truncation, f.before.details.truncation);
 assert.equal(nested[0].result.details.fileDiscovery.counts.discovered, 2);
 assert.doesNotMatch(JSON.stringify(f.requests), /Damage-Control|damageGuard|unsupported_source/);
 const valueLine = script.split('\n').find(line => line.startsWith('F10_VALUE='));
 assert.ok(valueLine, script);
 const scriptValue = JSON.stringify(JSON.parse(valueLine.slice('F10_VALUE='.length)));
 assert.match(scriptValue, /unsupported_source/, 'D6 honest coverage must survive actual script conversion');
 assert.match(scriptValue, /File discovery advice:/, 'D8 advice must survive actual script conversion, not merely appear in hook content');
 assert.match(scriptValue, /a\.ts/);
 assert.match(scriptValue, /b\.ts/);
});

function scriptOutput(f:any){return f.outcome.result.content.filter((b:any)=>b.type==='text').map((b:any)=>b.text).join('\n');}
function scriptValue(f:any){
 const line=scriptOutput(f).split('\n').find((line:string)=>line.startsWith('F10_VALUE='));
 assert.ok(line,scriptOutput(f));
 return JSON.stringify(JSON.parse(line.slice('F10_VALUE='.length)));
}
function assertOriginal(f:any){
 const evidence=f.observed[0].evidence;
 assert.equal(f.observed[0].state,'captured');
 assert.ok(Object.isFrozen(evidence)); assert.ok(Object.isFrozen(evidence.content)); assert.ok(Object.isFrozen(evidence.details));
 assert.notEqual(evidence.content,f.original.content); assert.notEqual(evidence.details,f.original.details);
 assert.deepEqual(evidence.content,f.before.content); assert.deepEqual(evidence.details,f.before.details);
 assert.deepEqual(evidence.structuredContent,f.before.structuredContent); assert.deepEqual(evidence.usage,f.before.usage);
 if(evidence.structuredContent&&typeof evidence.structuredContent==='object')assert.notEqual(evidence.structuredContent,f.original.structuredContent);
 assert.equal(hash(evidence),f.observed[0].frozenHash); assert.equal(hash(f.original),f.originalHash);
 const nested=f.events.filter((e:any)=>e.type==='tool_execution_end'&&e.toolName!=='codemode');
 assert.equal(nested.length,1); assert.equal(nested[0].parentToolCallId,'codemode-fixture');
 assert.deepEqual(nested[0].result.content[0],f.before.content[0]); assert.deepEqual(nested[0].result.usage,f.before.usage);
 assert.deepEqual(nested[0].result.details.truncation,f.before.details.truncation);
 assert.equal(f.calls.length,1); assert.equal(f.calls[0].toolCallId,'codemode-fixture/1'); assert.equal(f.calls[0].parentToolCallId,'codemode-fixture');
 assert.equal(f.outcome.isError,false,scriptOutput(f)); assert.match(scriptOutput(f),/F10_SANDBOX_COMPLETED/);
}
for(const child of [false,true])for(const mode of ['severe','unknown','insufficient','off','outage'] as const)for(const d8 of [false,true])for(const shape of ['absent','string','object','collision'] as const)for(const tool of ['read','find'] as const){
 test(`F10 sandbox ${child?'child':'parent'} ${tool} ${mode} D8=${d8} shape=${shape}`,async t=>{
  const f=await fixture(t,false,{child,mode,d8,shape,tool});
  assertOriginal(f);
  const script=scriptValue(f), supported=tool==='read'&&(shape==='absent'||shape==='string');
  assert.equal(f.d6Calls,supported&&mode!=='off'?1:0,script);
  assert.equal(f.d8Calls,tool==='find'&&d8?2:0,script);
  assert.match(script,/Damage-Control result coverage:/);
  assert.match(script,/sourceTrusted/);
  if(supported&&mode==='severe')assert.match(script,/Untrusted Damage-Control advisory/);
  else assert.doesNotMatch(script,/Untrusted Damage-Control advisory/);
  // Assigned children project supported evidence before transport; unsupported
  // results stay local even with an off consumer. Neither ordering implies trust.
  if(child&&!supported)assert.match(script,/unsupported_source/);
  else if(mode==='off')assert.match(script,/consumer_off/);
  else if(!supported)assert.match(script,/unsupported_source/);
  else if(mode==='outage')assert.match(script,/service_unavailable/);
  else if(mode==='unknown'||mode==='insufficient')assert.match(script,/insufficient_evidence/);
  if(tool==='find'&&d8){
   assert.match(script,/File discovery advice:/); assert.match(script,/a\.ts/); assert.match(script,/b\.ts/);
   const requests=f.requests.filter((r:any)=>!r.d6);
   assert.deepEqual(requests.map((r:any)=>r.state.source.path).sort(),['docs/a.ts','docs/b.ts']);
   assert.doesNotMatch(JSON.stringify(requests),/Damage-Control|damageGuard|unsupported_source/);
  }else assert.doesNotMatch(script,/File discovery advice:/);
  if(shape==='collision')assert.deepEqual(f.observed[0].evidence.structuredContent,f.before.structuredContent);
 });
}
for(const child of [false,true])for(const failure of ['function','cycle','unsupported'] as const)test(`F10 sandbox ${child?'child':'parent'} capture=${failure} is explicit gap`,async t=>{
 const f=await fixture(t,true,{child,failure});
 assert.equal(f.outcome.isError,false,scriptOutput(f)); assert.match(scriptOutput(f),/F10_SANDBOX_COMPLETED/);
 assert.equal(f.observed[0].state,'failed'); assert.equal(f.observed[0].evidence,undefined);
 assert.equal(f.d6Calls,0); assert.equal(f.d8Calls,0); assert.match(scriptValue(f),/original_capture_unavailable/);
 assert.doesNotMatch(scriptValue(f),/Untrusted Damage-Control advisory/);
});
for(const child of [false,true])for(const shape of ['absent','string','object','collision'] as const)test(`F10 sandbox ${child?'child':'parent'} error shape=${shape} remains error without speculative trust`,async t=>{
 const f=await fixture(t,false,{child,tool:'read',shape,error:true});
 assertOriginal(f);
 assert.equal(f.d6Calls,0); assert.equal(f.d8Calls,0);
 assert.equal(f.observed[0].evidence.isError,true);
 const nested=f.events.find((e:any)=>e.type==='tool_execution_end'&&e.toolName==='read');
 assert.equal(nested.isError,true);
 assert.match(nested.result.content.at(-1).text,/Damage-Control result coverage:.*unsupported_source/);
 if(shape==='absent'){
  // Installed SDK rejects non-structured errors using the original first text
  // block, not the composed text fallback. Coverage remains in the nested result;
  // do not claim the rejected script value carries it or infer source trust.
  const rejected=scriptOutput(f).split('\n').find((line:string)=>line.startsWith('F10_ERROR='));
  assert.equal(rejected,'F10_ERROR=Error: public fixture');
  assert.doesNotMatch(scriptOutput(f),/F10_VALUE=/);
 }else{
  assert.match(scriptValue(f),/Damage-Control result coverage:/);
  assert.match(scriptValue(f),/unsupported_source/);
  assert.doesNotMatch(scriptValue(f),/Untrusted Damage-Control advisory/);
 }
});
