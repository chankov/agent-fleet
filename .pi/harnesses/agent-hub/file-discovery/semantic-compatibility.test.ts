import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {normalizeSystem1Config} from '../../lib/system1/config-v2.js';import {createDiscoveryRuntime} from './runtime.ts';
const rootDocument={version:2,mode:'auto',provider:'typesafe',model:'jev-1.13.0',apiKeyEnv:'TYPESAFE_API_KEY'};
test('D8 on/off coexists with D9/D10, absent service and provider failure without changing exact local evidence',async()=>{
 const root=mkdtempSync(join(tmpdir(),'d8-compat-'));mkdirSync(join(root,'docs'));writeFileSync(join(root,'docs/a'),'exact evidence');
 try{
  for(const semantic of ['off','active'])for(const agentic of ['off','recommended'])for(const failure of [false,true]){
   const snapshot=normalizeSystem1Config({...rootDocument,consumers:{fileDiscovery:{mode:'active',remoteContextApproved:true,include:['docs'],semanticReads:{mode:semantic}},agenticAsk:{mode:agentic,remoteContextApproved:true,include:['git:tracked']}}});
   assert.equal(snapshot.consumers.fileDiscovery.status,'ready');assert.equal(snapshot.consumers.agenticAsk.config.mode,agentic);
   const runtime=createDiscoveryRuntime({root,sessionId:'s',config:snapshot.consumers.fileDiscovery.config,context:()=> 't',persist(){},service:failure?undefined:{evaluate:async r=>({status:'ok',evaluation:{answers:r.questions.map(q=>({questionId:q.id,type:q.type,uncertainty:{provenance:'provider'},...(q.type==='ordinal'?{value:0,levels:q.levels}:q.type==='choice'?{value:Object.keys(q.options)[0]}:{probabilityTrue:0.5})})),metadata:{}}}) as any}});
   try{const result=await runtime.rank({owner:'hub',foreground:true,paths:['docs/a'],task:'task',query:'q',discoveryComplete:true,canRead:()=>true,canDisplay:()=>true,permissionIdentity:()=> 'p'});assert.equal(result.rows.length,1);assert.equal(result.rows[0].answers?.length,failure?undefined:semantic==='active'?5:2);assert.equal(result.rows[0].status,failure?'unscored':'scored');}finally{runtime.dispose();}
  }
  assert.equal(normalizeSystem1Config(undefined).status,'missing');
  for(const semantic of ['off','active'])assert.equal(normalizeSystem1Config({...rootDocument,mode:'off',consumers:{fileDiscovery:{mode:'active',remoteContextApproved:true,include:['docs'],semanticReads:{mode:semantic}}}}).status,'off');
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('D8 damage-control denial and restored compaction counter remain authoritative with semantic on/off',async()=>{
 const {restoreDiscoveryCounter,DISCOVERY_COUNTER}=await import('./state.ts');
 const root=mkdtempSync(join(tmpdir(),'d8-policy-'));mkdirSync(join(root,'docs'));mkdirSync(join(root,'.pi'));writeFileSync(join(root,'docs/a'),'evidence');writeFileSync(join(root,'.pi/damage-control-rules.yaml'),'zeroAccessPaths:\n  - docs/a\n');
 try{
  for(const mode of ['off','active']){
   const config=normalizeSystem1Config({...rootDocument,consumers:{fileDiscovery:{mode:'active',remoteContextApproved:true,include:['docs'],semanticReads:{mode},limits:{maxCallsPerSession:1}}}}).consumers.fileDiscovery.config;
   const restored=restoreDiscoveryCounter([{type:'custom',customType:DISCOVERY_COUNTER,data:{schema:DISCOVERY_COUNTER,sessionId:'s',calls:1}}],'s');let calls=0;
   const runtime=createDiscoveryRuntime({root,sessionId:'s',config,restored,context:()=> 'same task',persist(){},service:{evaluate:async()=>{calls++;return {status:'unavailable',reason:'network'};}}});
   try{const result=await runtime.rank({owner:'hub',task:'task',query:'query',paths:['docs/a'],foreground:true,discoveryComplete:true,canDisplay:()=>true,canRead:()=>false,permissionIdentity:()=> 'denied'});assert.equal(result.rows[0].reason,'denied');assert.equal(result.rows[0].answers,undefined);assert.equal(runtime.calls,1);assert.equal(calls,0);}finally{runtime.dispose();}
  }
 }finally{rmSync(root,{recursive:true,force:true});}
});
