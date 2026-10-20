import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createDamageHubSession} from './damage-guard-hub.ts';
import {normalizeSystem1Config} from '../lib/system1/config-v2.js';
import {createDamageClient} from '../damage-control-continue/system1-client.ts';
export const severe:any={status:'ok',evaluation:{answers:[{questionId:'effect',type:'choice',value:'severe',uncertainty:{provenance:'provider'}},{questionId:'evidence',type:'choice',value:'sufficient',uncertainty:{provenance:'provider'}}],metadata:{provider:'typesafe',requestedModel:'jev-1.13.0',returnedModel:'jev-1.13.0',questionSetVersion:'damage-guard/v1',latencyMs:1,attempts:1}}};
async function fixture(t:any,mode='active',evaluate?: (request:any)=>Promise<any>){
 const root=mkdtempSync(join(tmpdir(),'f9-output-'));mkdirSync(join(root,'docs'));writeFileSync(join(root,'docs','source'),'public fixture');t.after(()=>rmSync(root,{recursive:true,force:true}));
 let calls=0,admitted=true;const entries:any[]=[],admittedOwners=new Set<any>();
 const raw:any={version:2,mode:mode==='root-off'?'off':'auto',provider:'typesafe',model:'jev-1.13.0',apiKeyEnv:'TYPESAFE_API_KEY',consumers:{damageGuard:{mode:mode==='off'?'off':mode==='invalid'?'invalid':'active',remoteScopes:{results:mode!=='scope-off'},include:['docs']}}};
 if(mode==='missing')delete raw.consumers.damageGuard;
 const session=createDamageHubSession({root,selected:true,snapshot:normalizeSystem1Config(raw),taskId:()=> 'task',childAuthority:{taskToken:()=> 'token',admit:owner=>{admittedOwners.add(owner);return admitted;}},append:(customType,data)=>entries.push({customType,data}),entries:()=>entries,canRead:()=>true,service:mode==='key-unavailable'?undefined:{evaluate:async(request)=>{calls++;return evaluate?evaluate(request):severe;}},ask:async()=>{throw Error('results never ask');}});
 session.accept('read source');await session.start();t.after(()=>session.dispose());return {root,session,admittedOwners,calls:()=>calls,revokeAdmission:()=>admitted=false};
}
test('F9 production prepare physical read lease client broker screen warns without effect authority',async t=>{
 const f=await fixture(t),registration=f.session.prepare({ownerId:'reader',cwd:f.root,tools:['read'],admit:()=>true})!,lease=registration.open({cwd:f.root,tools:['read']}),client=createDamageClient(lease.assignment);t.after(()=>client.dispose());
 const event:any={toolName:'read',toolCallId:'source',input:{path:'docs/source'},content:[{type:'text',text:'public fixture'}]};
 assert.equal((await client.result(event)).warning,true);assert.equal(f.calls(),1);
 assert.equal((await client.assess('bash',{command:'echo forbidden'})).outcome,'revoked');assert.equal(f.calls(),1);
 assert.equal((await client.result({...event,toolName:'filesystem'})).status,'not_evaluated');assert.equal(f.calls(),1);
 f.revokeAdmission();assert.equal((await client.result(event)).status,'not_evaluated');assert.equal(f.calls(),1);assert.equal(lease.identity.signal.aborted,true);
});

import {registerHooks} from 'node:module';
import {captureDamageResult} from '../lib/damage-result-evidence.ts';
registerHooks({resolve(s,c,n){return n(s==='@mariozechner/pi-coding-agent'?'@earendil-works/pi-coding-agent':s,c);}});
const {ExtensionRunner}=await import('@earendil-works/pi-coding-agent');
const {default:registerDiscoveryChild}=await import('./file-discovery/child-extension.ts');
const {composeDamageResult,damageResultGap}=await import('../damage-control-continue/result-screen.ts');
for(const failure of ['none','function','cycle','unsupported'])test(`F9 actual child D8 uses original evidence and preserves decorated structured output capture=${failure}`,async t=>{
 const failed=failure!=='none';
 const root=mkdtempSync(join(tmpdir(),'f9-d8-'));for(const dir of ['docs','.ai'])mkdirSync(join(root,dir));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const saved={...process.env};Object.assign(process.env,{AF_D9_REGISTERED:'1',AF_D9_ROOT:root,AF_D9_READ_ROOTS:'["docs"]',AF_D9_ENDPOINT:join(root,'absent.sock'),AF_D9_CAPABILITY:'fixture'});t.after(()=>{for(const key of Object.keys(process.env))if(!(key in saved))delete process.env[key];Object.assign(process.env,saved);});
 writeFileSync(join(root,'.ai','system1.json'),JSON.stringify({version:2,mode:'auto',provider:'typesafe',model:'jev-1.13.0',apiKeyEnv:'TYPESAFE_API_KEY',consumers:{fileDiscovery:{mode:'off'}}}));
 const handlers=new Map<string,Function[]>();const pi:any={on(n:string,h:Function){handlers.set(n,[...(handlers.get(n)??[]),h]);}};
 // Capture then decorate with content that cannot be parsed as the original discovery.
 pi.on('tool_result',(e:any)=>{captureDamageResult(e);return composeDamageResult(e,damageResultGap('unsupported_source'));});registerDiscoveryChild(pi);
 const e:any={toolName:'find',toolCallId:'find',input:{path:'docs',pattern:'*'},content:[{type:'text',text:'a.ts\nb.ts'}],details:{fileDiscovery:{original:true}},structuredContent:{output:'original'},usage:{inputTokens:2},status:'blocked',exit_code:7,...(failed?{extra:()=>{}}:{})};
 if(failure==='cycle')e.extra=e;if(failure==='unsupported')e.extra=new Date();
 const runner:any=new ExtensionRunner([{path:'child',handlers}] as any,{} as any,root,{} as any,{} as any);runner.createContext=()=>({cwd:root});
 const patch:any=await runner.emitToolResult(e),view={...e,...patch};
 assert.deepEqual(view.content[0],e.content[0]);assert.match(view.content[1].text,/Damage-Control/);
 assert.deepEqual(view.details,e.details);assert.equal(view.structuredContent.output,'original');assert.match(view.structuredContent.damageGuard.text,/unsupported_source/);
 assert.equal(view.status,'blocked');assert.equal(view.exit_code,7);assert.deepEqual(view.usage,e.usage);
 assert.match(view.content.at(-1).text,failed?/original_capture_unavailable/:/unknown_shape/);
});

import {createDiscoveryOwners,discoveryAssignmentEnv} from './file-discovery/owners.ts';
import {createDiscoveryBroker} from './file-discovery/broker.ts';
import {createDiscoveryRuntime} from './file-discovery/runtime.ts';
import {parseFileDiscoveryConfig} from '../lib/system1/config-file-discovery.js';
const {default:registerSafety}=await import('../damage-control-continue/index.ts');
for(const mode of ['active','off'])for(const discovery of [true,false])for(const bounded of ['direct','verified','mismatch'])test(`F9 installed child safety original D6=${mode} D8/D9=${discovery} bounded=${bounded} broker ranks only original candidates`,async t=>{
 const f=await fixture(t,mode);for(const name of ['a.ts','b.ts'])writeFileSync(join(f.root,'docs',name),'public fixture');
 mkdirSync(join(f.root,'.ai'));mkdirSync(join(f.root,'.pi'));
 writeFileSync(join(f.root,'.pi','damage-control-rules.yaml'),JSON.stringify({bashToolPatterns:[],zeroAccessPaths:[],readOnlyPaths:[],noDeletePaths:[]}));
 writeFileSync(join(f.root,'.ai','system1.json'),JSON.stringify({version:2,mode:'auto',provider:'typesafe',model:'jev-1.13.0',apiKeyEnv:'TYPESAFE_API_KEY',consumers:{fileDiscovery:{mode:'off'}}}));
 let ranked=0;const config=parseFileDiscoveryConfig({mode:'active',remoteContextApproved:true,include:['docs']});
 const runtime=createDiscoveryRuntime({root:f.root,sessionId:'s',config,service:{evaluate:async(request:any)=>{ranked++;return {status:'ok',evaluation:{answers:request.questions.map((q:any)=>({questionId:q.id,type:q.type,uncertainty:{provenance:'provider'},...(q.type==='ordinal'?{value:0,levels:q.levels}:q.type==='choice'?{value:Object.keys(q.options)[0]}:{probabilityTrue:0.5})})),metadata:{}}} as any;}},context:()=> 'task',persist(){}});
 const owners=createDiscoveryOwners('s',()=> 'task'),broker=await createDiscoveryBroker({root:f.root,runtime,owners});
 t.after(async()=>{runtime.dispose();owners.dispose();await broker.close();});
 const owner=owners.register({taskId:'task',ownerId:'reader',attemptId:'attempt',cwd:f.root,task:'find source',query:'find source',effectiveTools:['find','read'],readRoots:['docs'],exportRoots:['docs'],canRead:()=>true,canDisplay:()=>true,permissionIdentity:()=> 'p'});
 const saved={...process.env};Object.assign(process.env,discoveryAssignmentEnv(owners.assignment(owner,broker.endpoint),f.root,['docs']));t.after(()=>{for(const key of Object.keys(process.env))if(!(key in saved))delete process.env[key];Object.assign(process.env,saved);});
 const registration=f.session.prepare({ownerId:'reader',cwd:f.root,tools:['read'],admit:()=>true}),damage=registration?.open({cwd:f.root,tools:['read']});
 assert.equal(registration===null,mode==='off');
 const handlers=new Map<string,Function[]>(),pi:any={on(n:string,h:Function){handlers.set(n,[...(handlers.get(n)??[]),h]);},registerCommand(){},appendEntry(){}};
 registerSafety(pi,{assignment:damage?.assignment});if(discovery)registerDiscoveryChild(pi);
 const runner:any=new ExtensionRunner([{path:'child',handlers}] as any,{} as any,f.root,{} as any,{} as any);runner.createContext=()=>({cwd:f.root,ui:{notify(){},setStatus(){}},hasUI:false});
 await runner.emit({type:'session_start'});t.after(()=>runner.emit({type:'session_shutdown'}));
 const body='a.ts\nb.ts',contentPath=join(f.root,'bounded');writeFileSync(contentPath,body);
 const event:any={toolName:'find',toolCallId:'find',input:{path:'docs',pattern:'*'},content:[{type:'text',text:bounded==='direct'?body:'original bounded notice'}],...(bounded==='direct'?{}:{details:{boundedOutput:{contentPath,sha256:bounded==='verified'?createHash('sha256').update(body).digest('hex'):'0'.repeat(64)}}}),structuredContent:{retained:'original'},isError:false,usage:{inputTokens:3},status:'ok',exit_code:0};
 const view:any={...event,...await runner.emitToolResult(event)};
 assert.equal(f.calls(),0);assert.equal(ranked>0,discovery&&bounded!=='mismatch');if(mode==='active')assert.match(view.content[1].text,/unsupported_source/);else assert.doesNotMatch(JSON.stringify(view),/Damage-Control result coverage:/);if(discovery&&bounded!=='mismatch')assert.equal(view.details.fileDiscovery.counts.discovered,2);else if(discovery)assert.match(view.content.at(-1).text,/bounded_evidence_unavailable/);else assert.equal(view.content.length,mode==='active'?2:1);assert.equal(view.structuredContent.retained,'original');if(mode==='active')assert.match(view.structuredContent.damageGuard.text,/unsupported_source/);assert.deepEqual(view.content[0],event.content[0]);assert.equal(view.status,'ok');assert.equal(view.exit_code,0);assert.deepEqual(view.usage,event.usage);
});

for(const mode of ['active','off','missing','invalid','root-off','key-unavailable','scope-off'])for(const structured of ['absent','string','object','collision'])test(`F9 installed child production result ${mode} structured=${structured}`,async t=>{
 const f=await fixture(t,mode),registration=f.session.prepare({ownerId:'reader',cwd:f.root,tools:['read'],admit:()=>true}),lease=registration?.open({cwd:f.root,tools:['read']});assert.equal(!lease,['off','missing','invalid','root-off','scope-off'].includes(mode));mkdirSync(join(f.root,'.pi'));writeFileSync(join(f.root,'.pi','damage-control-rules.yaml'),JSON.stringify({bashToolPatterns:[],zeroAccessPaths:[],readOnlyPaths:[],noDeletePaths:[]}));
 const handlers=new Map<string,Function[]>(),pi:any={on(n:string,h:Function){handlers.set(n,[...(handlers.get(n)??[]),h]);},registerCommand(){},appendEntry(){}};registerSafety(pi,{assignment:lease?.assignment});
 const runner:any=new ExtensionRunner([{path:'child',handlers}] as any,{} as any,f.root,{} as any,{} as any);runner.createContext=()=>({cwd:f.root,ui:{notify(){},setStatus(){}},hasUI:false});await runner.emit({type:'session_start'});t.after(()=>runner.emit({type:'session_shutdown'}));
 const event:any={toolName:'read',toolCallId:'read',input:{path:'docs/source'},content:[{type:'text',text:'public fixture'}],details:{truncation:{truncated:false}},usage:{inputTokens:2},status:'ok',exit_code:0,isError:false,...(structured==='absent'?{}:{structuredContent:structured==='string'?'public fixture':structured==='object'?{output:'public fixture'}:{damageGuard:{retained:true},originalStructuredContent:'keep'}})};
 const expected=structuredClone(event),view:any={...event,...await runner.emitToolResult(event)};
 assert.deepEqual(event,expected);assert.deepEqual(view.content[0],expected.content[0]);assert.deepEqual(view.details,expected.details);assert.equal(view.status,expected.status);assert.equal(view.exit_code,0);assert.equal(view.isError,false);assert.deepEqual(view.usage,expected.usage);
 if(!lease){assert.equal(f.calls(),0);assert.deepEqual(view,expected,'disabled optional adapter leaves the result untouched');return;}
 const supported=structured==='absent'||structured==='string';assert.equal(f.calls(),mode==='active'&&supported?1:0);assert.match(view.content.at(-1).text,mode==='active'&&supported?/Untrusted Damage-Control advisory/:/not_evaluated/);
 if(structured==='string')assert.ok(view.structuredContent.startsWith(expected.structuredContent));if(structured==='object'||structured==='collision')assert.deepEqual(view.structuredContent.originalStructuredContent,expected.structuredContent);
});
for(const failure of ['insufficient','unavailable','throw','revoked','cancelled'])test(`F9 production result ${failure} never invents warning or source trust`,async t=>{
 let f:any;f=await fixture(t,'active',async()=>{if(failure==='throw')throw Error('provider SENTINEL');if(failure==='revoked')f.revokeAdmission();if(failure==='cancelled')queueMicrotask(()=>client.dispose());if(failure==='insufficient'){const result=structuredClone(severe);result.evaluation.answers[1].value='insufficient';return result;}return {status:'unavailable',reason:'network'};});
 const lease=f.session.prepare({ownerId:'reader',cwd:f.root,tools:['read'],admit:()=>true})!.open({cwd:f.root,tools:['read']}),client=createDamageClient(lease.assignment);t.after(()=>client.dispose());
 const result=await client.result({toolName:'read',toolCallId:'read',input:{path:'docs/source'},content:[{type:'text',text:'public fixture'}]});assert.equal(result.status,'not_evaluated');assert.equal(result.warning,false);assert.equal(result.sourceTrusted,false);assert.equal(f.calls(),1);assert.ok(!JSON.stringify(result).includes('SENTINEL'));
});
import {createHash} from 'node:crypto';
test('F9 production client screens relative filesystem exact excerpt and constrained cat with owner-bound cwd',async t=>{
 const f=await fixture(t),lease=f.session.prepare({ownerId:'reader',cwd:f.root,tools:['filesystem','bash'],admit:()=>true})!.open({cwd:f.root,tools:['filesystem','bash']}),client=createDamageClient(lease.assignment);t.after(()=>client.dispose());
 const path=join(f.root,'docs','source'),content='public fixture',value={path,exactBytesOnDisk:path,contentEncoding:'utf8',content,offset:0,truncated:false,nextHandle:null,untrusted:true,modelDelegated:false,hash:createHash('sha256').update(content).digest('hex'),contentBytes:Buffer.byteLength(content),totalBytes:Buffer.byteLength(content)};
 assert.equal((await client.result({toolName:'filesystem',toolCallId:'fs',input:{operation:'excerpt',path:'docs/source'},content:[{type:'text',text:JSON.stringify(value)}],details:{result:value}})).warning,true);
 assert.equal((await client.result({toolName:'bash',toolCallId:'cat',input:{command:'cat docs/source'},content:[{type:'text',text:content}],structuredContent:{output:content,exit_code:0,truncated:false}})).warning,true);assert.equal(f.calls(),2);
});
for(const kind of ['cycle','function','unsupported','image','multiblock','blocked','error','nonzero','partial','oversize','secret'])test(`F9 installed assigned child ${kind} retains output and makes zero result inference`,async t=>{
 const f=await fixture(t),lease=f.session.prepare({ownerId:'reader',cwd:f.root,tools:['read'],admit:()=>true})!.open({cwd:f.root,tools:['read']});mkdirSync(join(f.root,'.pi'));writeFileSync(join(f.root,'.pi','damage-control-rules.yaml'),JSON.stringify({bashToolPatterns:[],zeroAccessPaths:[],readOnlyPaths:[],noDeletePaths:[]}));
 const handlers=new Map<string,Function[]>(),pi:any={on(n:string,h:Function){handlers.set(n,[...(handlers.get(n)??[]),h]);},registerCommand(){},appendEntry(){}};registerSafety(pi,{assignment:lease.assignment});
 const runner:any=new ExtensionRunner([{path:'child',handlers}] as any,{} as any,f.root,{} as any,{} as any);runner.createContext=()=>({cwd:f.root,ui:{notify(){},setStatus(){}},hasUI:false});await runner.emit({type:'session_start'});t.after(()=>runner.emit({type:'session_shutdown'}));
 const event:any={toolName:'read',toolCallId:'read',input:{path:'docs/source'},content:[{type:'text',text:'public fixture'}],structuredContent:'public fixture',usage:{inputTokens:2},details:undefined,status:'ok',exit_code:0,isError:false};
 if(kind==='cycle')event.extra=event;if(kind==='function')event.extra=()=>{};if(kind==='unsupported')event.extra=new Date();
 if(kind==='image')event.content=[{type:'image',data:'fixture',mimeType:'image/png'}];if(kind==='multiblock')event.content.push({type:'text',text:'extra'});if(kind==='blocked')event.status='blocked';if(kind==='error')event.isError=true;if(kind==='nonzero')event.exit_code=7;if(kind==='partial')event.input.limit=1;
 if(kind==='oversize'||kind==='secret'){const body=kind==='oversize'?'x'.repeat(20000):'password = "RESULT_SENTINEL"';writeFileSync(join(f.root,'docs','source'),body);event.content[0].text=body;event.structuredContent=body;}
 const view:any={...event,...await runner.emitToolResult(event)};assert.equal(f.calls(),0);assert.deepEqual(view.content.slice(0,event.content.length),event.content);assert.deepEqual(view.details,event.details);assert.deepEqual(view.usage,event.usage);assert.equal(view.status,event.status);assert.equal(view.exit_code,event.exit_code);assert.equal(view.isError,event.isError);assert.ok(view.structuredContent.startsWith(event.structuredContent));assert.match(view.content.at(-1).text,/not_evaluated/);assert.doesNotMatch(view.content.at(-1).text,/RESULT_SENTINEL|Untrusted Damage-Control advisory/);
 if(['cycle','function','unsupported'].includes(kind))assert.match(view.content.at(-1).text,/original_capture_unavailable/);
});

test('F9 actual physical native child installed runner read result crosses production session broker and revokes on exit',async t=>{
 const f=await fixture(t);mkdirSync(join(f.root,'.pi'));writeFileSync(join(f.root,'.pi','damage-control-rules.yaml'),JSON.stringify({bashToolPatterns:[],zeroAccessPaths:[],readOnlyPaths:[],noDeletePaths:[]}));
 const safety=new URL('../damage-control-continue/index.ts',import.meta.url).href,sdk=import.meta.resolve('@earendil-works/pi-coding-agent'),report=join(f.root,'view.json');
 writeFileSync(join(f.root,'pi'),`#!/usr/bin/env node
const fs=require('node:fs');process.stdin.resume();process.stdin.on('end',async()=>{try{
 const {registerHooks}=await import('node:module');registerHooks({resolve(s,c,n){return n(s==='@mariozechner/pi-coding-agent'?'@earendil-works/pi-coding-agent':s,c);}});
 const {ExtensionRunner}=await import(${JSON.stringify(sdk)}),{default:register}=await import(${JSON.stringify(safety)});
 const handlers=new Map(),pi={on(n,h){handlers.set(n,[...(handlers.get(n)||[]),h])},registerCommand(){},appendEntry(){}};
 register(pi,{assignment:JSON.parse(process.env.AF_D6_ASSIGNMENT)});
 const runner=new ExtensionRunner([{path:'native-safety',handlers}],{},process.cwd(),{},{});runner.createContext=()=>({cwd:process.cwd(),ui:{notify(){},setStatus(){}},hasUI:false});await runner.emit({type:'session_start'});
 const original={toolName:'read',toolCallId:'native-read',input:{path:'docs/source'},content:[{type:'text',text:'public fixture'}],structuredContent:'public fixture',usage:{inputTokens:2},status:'ok',exit_code:0,isError:false};
 const view={...original,...await runner.emitToolResult(original)};await runner.emit({type:'session_shutdown'});
 fs.writeFileSync(${JSON.stringify(report)},JSON.stringify({view,original,safe:!process.env.TYPESAFE_API_KEY,assignmentKeys:Object.keys(process.env).filter(k=>k.startsWith('AF_D6_'))}));
 console.log(JSON.stringify({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'read result retained'}}));
 }catch(e){console.error(e);process.exitCode=1;}});
 `,{mode:0o755});
 const {spawnPiAgent}=await import('./spawn.ts');
 const registration=f.session.prepare({ownerId:'native-reader',cwd:f.root,tools:['read'],admit:()=>true})!;
 const result=await spawnPiAgent({model:'fake/reader',tools:'read',thinking:'off',systemPrompt:'synthetic',noSkills:true,noContextFiles:true,prompt:'read fixture',sessionFile:join(f.root,'session'),cwd:f.root,damageRegistration:registration,env:{PATH:f.root+':'+process.env.PATH,HOME:f.root,XDG_CONFIG_HOME:f.root,NODE_OPTIONS:process.env.NODE_OPTIONS??'',AF_D6_ASSIGNMENT:'forged',AF_D6_UNKNOWN:'forged',TYPESAFE_API_KEY:'SENTINEL'}});
 assert.equal(result.exitCode,0,result.stderr);const {readFileSync}=await import('node:fs'),row=JSON.parse(readFileSync(report,'utf8'));
 assert.equal(f.calls(),1);assert.ok(f.admittedOwners.size>0);assert.ok([...f.admittedOwners].every(owner=>owner.signal.aborted));assert.equal(row.safe,true);assert.deepEqual(row.assignmentKeys,['AF_D6_ASSIGNMENT']);assert.deepEqual(row.view.content[0],row.original.content[0]);assert.match(row.view.content.at(-1).text,/Untrusted Damage-Control advisory/);assert.ok(row.view.structuredContent.startsWith(row.original.structuredContent));assert.equal(row.view.status,'ok');assert.equal(row.view.exit_code,0);assert.deepEqual(row.view.usage,row.original.usage);
});
