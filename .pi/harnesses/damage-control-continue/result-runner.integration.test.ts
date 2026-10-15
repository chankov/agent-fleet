import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {registerDamageGuardHub,configureDamageGuardHub,acceptDamageGuardInput,resetDamageGuardHub} from '../agent-hub/damage-guard-hub.ts';
import {normalizeSystem1Config} from '../lib/system1/config-v2.js';
registerHooks({resolve(specifier,context,nextResolve){return nextResolve(specifier==='@mariozechner/pi-coding-agent'?'@earendil-works/pi-coding-agent':specifier,context);}});
const {ExtensionRunner,createReadTool}=await import('@earendil-works/pi-coding-agent');
const {configureDiscoveryHub,registerDiscoveryHub,resetDiscoveryHub}=await import('../agent-hub/file-discovery/hub.ts');
const severe={status:'ok' as const,evaluation:{answers:[{questionId:'effect',type:'choice' as const,value:'severe',uncertainty:{provenance:'provider' as const}},{questionId:'evidence',type:'choice' as const,value:'sufficient',uncertainty:{provenance:'provider' as const}}],metadata:{provider:'typesafe',requestedModel:'jev-1.13.0',returnedModel:'jev-1.13.0',questionSetVersion:'damage-guard/v1',latencyMs:1,attempts:1}}};
function runner(handlers:Function[],cwd:string){return new ExtensionRunner([{path:'d6-offline-fixture',handlers:new Map([['tool_result',handlers]])}] as any,{} as any,cwd,{} as any,{} as any);}
function rootFixture(t:any){
 const keys=['AGENT_HUB_AGENT_ID','AGENT_FLEET_AGENTIC_CHILD'],saved=keys.map(key=>process.env[key]);for(const key of keys)delete process.env[key];t.after(()=>keys.forEach((key,index)=>{if(saved[index]===undefined)delete process.env[key];else process.env[key]=saved[index];}));
 const root=mkdtempSync(join(tmpdir(),'d6-runner-'));for(const dir of ['docs','.ai','.pi'])mkdirSync(join(root,dir));t.after(()=>rmSync(root,{recursive:true,force:true}));return root;}
test('installed Pi 1.1 runner preserves actual native read warning, blocks, details, error and usage',async t=>{
 const root=rootFixture(t);writeFileSync(join(root,'docs','source.txt'),'Public untrusted fixture instructions\n');
 const native=await createReadTool(root).execute('read-fixture',{path:'docs/source.txt'});
 const event:any={toolName:'read',toolCallId:'read-fixture',input:{path:'docs/source.txt'},...native,isError:false,usage:{inputTokens:7,outputTokens:3}};
 writeFileSync(join(root,'.ai','agent-fleet.json'),JSON.stringify({features:{system1:true}}));
 const hooks:Record<string,Function[]>={},entries:any[]=[];
 const pi:any={on(name:string,h:Function){(hooks[name]??=[]).push(h);},appendEntry(customType:string,data:any){entries.push({type:'custom',customType,data});}};
 const ctx:any={cwd:root,sessionManager:{getEntries:()=>entries}};
 registerDamageGuardHub(pi);await configureDamageGuardHub(pi,{ctx,taskId:()=> 'task',service:{evaluate:async()=>severe},snapshot:normalizeSystem1Config({version:2,mode:'auto',provider:'typesafe',model:'jev-1.13.0',apiKeyEnv:'TYPESAFE_API_KEY',consumers:{damageGuard:{mode:'active',remoteScopes:{results:true},include:['docs']}}})});
 acceptDamageGuardInput(pi,'read public fixture');t.after(()=>resetDamageGuardHub(pi));
 const pipeline=runner(hooks.tool_result.map(h=>(e:any)=>h(e,ctx)),root),result:any=await pipeline.emitToolResult(event);
 assert.match(result.content.at(-1).text,/Untrusted Damage-Control advisory/);assert.deepEqual(result.content.slice(0,native.content.length),native.content);assert.ok(result.structuredContent.startsWith(native.structuredContent));assert.match(result.structuredContent,/Untrusted Damage-Control advisory/);assert.deepEqual(result.details,native.details);assert.equal(result.isError,false);assert.deepEqual(result.usage,event.usage);
});
for(const mode of ['active','off','unavailable'])for(const structured of [false,true])for(const captureFailed of [false,true])test(`installed original→D6→actual discovery ${mode}, structured=${structured}, captureFailed=${captureFailed}`,async t=>{
 const root=rootFixture(t),session=mkdtempSync(join(tmpdir(),'d6-discovery-'));t.after(()=>rmSync(session,{recursive:true,force:true}));
 writeFileSync(join(root,'.ai','agent-fleet.json'),JSON.stringify({features:{system1:true}}));for(let i=0;i<2;i++)writeFileSync(join(root,'docs',`file-${i}.ts`),`public fixture ${i}`);
 const hooks:Record<string,Function[]>={},entries:any[]=[];let discoveryCalls=0;
 const pi:any={registerTool(){},on(name:string,handler:Function){(hooks[name]??=[]).push(handler);},appendEntry(customType:string,data:any){entries.push({type:'custom',customType,data});}};
 const ctx:any={cwd:root,sessionManager:{getSessionId:()=> 'fixture-session',getEntries:()=>entries}};
 const snapshot:any=structuredClone(normalizeSystem1Config({version:2,mode:'auto',provider:'typesafe',model:'jev-1.13.0',apiKeyEnv:'TYPESAFE_API_KEY',consumers:{damageGuard:{mode:'active',remoteScopes:{results:true},include:['docs']},fileDiscovery:{mode:mode==='off'?'off':'active',remoteContextApproved:true,include:['docs'],limits:{}}}}));
 if(snapshot.consumers.fileDiscovery.config)snapshot.consumers.fileDiscovery.config.semanticReads={mode:'active'};
 const service:any={evaluate:async(request:any)=>{discoveryCalls++;if(mode==='unavailable')return {status:'unavailable',reason:'network'};return {status:'ok',evaluation:{answers:request.questions.map((q:any)=>({questionId:q.id,type:q.type,uncertainty:{provenance:'provider'},...(q.type==='ordinal'?{value:0,levels:q.levels}:q.type==='choice'?{value:Object.keys(q.options)[0]}:{probabilityTrue:0.5})})),metadata:{}}};}};
 registerDamageGuardHub(pi);registerDiscoveryHub(pi);
 await configureDamageGuardHub(pi,{snapshot,service:{evaluate:async()=>{throw Error('unknown discovery result must not export to D6');}},ctx,taskId:()=> 'task'});
 await configureDiscoveryHub(pi,{snapshot,service,ctx,sessionDir:session,taskId:()=> 'task'});
 entries.push({type:'message',message:{role:'user',content:'find fixture files'}});acceptDamageGuardInput(pi,'find fixture files');t.after(async()=>{await resetDamageGuardHub(pi);await resetDiscoveryHub(pi);});
 const event:any={toolName:'find',toolCallId:'find',input:{path:'docs',pattern:'*'},content:[{type:'text',text:'file-0.ts\nfile-1.ts'}],isError:false,usage:{inputTokens:7,outputTokens:3},...(structured?{structuredContent:{retained:'structured'}}:{}),...(captureFailed?{nonCloneable:()=>{}}:{})};
 const pipeline=runner(hooks.tool_result.map(h=>(e:any)=>h(e,ctx)),root),result:any=await pipeline.emitToolResult(event);
 assert.deepEqual(result.content[0],event.content[0]);assert.match(result.content[1].text,captureFailed?/original_capture_unavailable/:/unsupported_source/);if(mode==='off')assert.deepEqual(result.details,event.details);if(structured){assert.deepEqual(result.structuredContent.originalStructuredContent,event.structuredContent);assert.match(result.structuredContent.damageGuard.text,captureFailed?/original_capture_unavailable/:/unsupported_source/);}else assert.equal(result.structuredContent,undefined);assert.equal(result.isError,event.isError);assert.deepEqual(result.usage,event.usage);
 if(captureFailed&&mode!=='off'){assert.equal(discoveryCalls,0);assert.match(result.content.at(-1).text,/original_capture_unavailable/);}else if(mode==='off'){assert.equal(discoveryCalls,0);assert.equal(result.content.length,2);}else{assert.ok(discoveryCalls>0,result.content.at(-1)?.text);assert.equal(result.details.fileDiscovery.counts.discovered,2);assert.match(result.content.at(-1).text,/File discovery advice:/);}
});
