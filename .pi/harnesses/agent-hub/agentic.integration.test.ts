import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {configureAgenticHub,registerAgenticHub,resetAgenticHub} from './agentic-hub.ts';
import {createAgenticRuntime} from './agentic-runtime.ts';
import {createSystem1Service} from '../lib/system1/service.ts';
import {normalizeSystem1Config} from '../lib/system1/config-v2.js';
import {parseAgenticConfig} from '../lib/system1/config-agentic.js';
import {createProcessState,applyProcessClassification,evaluateProcessObligations,processPreEffectGate} from './process-obligations.ts';
import {AGENTIC_COUNTER} from './agentic-state.ts';
import type {System1Answer,System1Service,System1Result,ProviderEvaluateRequest} from '../lib/system1/contracts.ts';
const section={mode:'advisory',remoteContextApproved:true,include:['src'],allowToolOutputs:true,limits:{maxCallsPerSession:3}};
const snapshot=normalizeSystem1Config({version:2,mode:'auto',provider:'typesafe',model:'jev-1.13.0',apiKeyEnv:'TYPESAFE_API_KEY',consumers:{agenticAsk:section}});
const questions=[{id:'tests_pass',type:'predicate',instructions:'Did the tests pass?'},{id:'risk',type:'ordinal',instructions:'Assess risk',levels:['low','high']},{id:'clarity',type:'choice',instructions:'Request classification',options:{clear:'Clear request',unknown:null}}];
function providerResult(request:ProviderEvaluateRequest):System1Result {
 const answers:System1Answer[]=request.questions.map(q=>q.type==='predicate'?{questionId:q.id,type:q.type,probabilityTrue:0.99,uncertainty:{provenance:'provider'}}:q.type==='ordinal'?{questionId:q.id,type:q.type,value:0,levels:q.levels,uncertainty:{provenance:'provider'}}:{questionId:q.id,type:q.type,value:'clear',uncertainty:{provenance:'provider'}});
 return {status:'ok',evaluation:{answers,metadata:{provider:'fake',requestedModel:'fake',returnedModel:'fake',questionSetVersion:request.questionSetVersion,latencyMs:1,attempts:1,usage:{inputTokens:15,outputTokens:5}}}};
}
test('A/B/C flow through real tool registration and shared validation; advice never satisfies actual process gates',async()=>{
 const root=mkdtempSync(join(tmpdir(),'ask-scenarios-'));
 try{
 mkdirSync(join(root,'.ai'));writeFileSync(join(root,'.ai/agent-fleet.json'),JSON.stringify({features:{system1:true}}));
 mkdirSync(join(root,'src'));writeFileSync(join(root,'src/app.ts'),'export const answer = 42;\n');
 const histories:any[]=[],hooks:Record<string,Function[]>={};let tool:any,task='t1';const sent:ProviderEvaluateRequest[]=[];
 const pi:any={registerTool:(t:any)=>tool=t,on:(e:string,f:Function)=>(hooks[e]??=[]).push(f),appendEntry:(customType:string,data:any)=>histories.push({type:'custom',customType,data})};
 const ctx:any={cwd:root,sessionManager:{getSessionId:()=> 'session',getEntries:()=>histories}};
 const service=createSystem1Service({provider:{name:'fake',model:'fake',capabilities:['choice','ordinal','predicate','probability_true'],evaluate:async request=>{sent.push(request);return providerResult(request) as any;}}});
 registerAgenticHub(pi);const configure=()=>configureAgenticHub(pi,{snapshot,service,ctx,sessionDir:root,taskId:()=>task});configure();
 const process=applyProcessClassification(createProcessState(),{risk:'high',scope:'wide',reason:'Sensitive wide change'}).state;
 const before=structuredClone(process),verdict=evaluateProcessObligations(process,{writable:true,budgetTier:'small'}),gate=processPreEffectGate(process,'write');assert.ok(gate);assert.equal(verdict.accepted,false);
 const capture=(id:string,text:string,details:any={},isError=false)=>hooks.tool_result[0]({toolName:'bash',toolCallId:id,content:[{type:'text',text}],details,isError},ctx).details.agenticEvidence;
 const failed=capture('test','FAIL app.test.ts: expected 41, got 42',{complete:true,exitCode:1},true);
 const diff=capture('diff','diff --git a/src/app.ts b/src/app.ts\n-export const answer = 41;\n+export const answer = 42;');
 const scenarios=[{state:'Triage this failing test',paths:[{path:'src/app.ts'}],evidenceRefs:[failed.ref],questions},{state:'Judge the recorded diff',evidenceRefs:[diff.ref],questions},{state:'BG: Защо резултатът е 42? EN: Why is the result 42?',paths:[{path:'src/app.ts',startLine:1,endLine:1}],questions}];
 for(const input of scenarios){const result=await tool.execute('ask',input,new AbortController().signal);assert.equal(result.details.status,'ok',JSON.stringify(result.details));assert.equal(result.details.advisory,true);assert.equal(result.details.evaluation.metadata.usage.inputTokens,15);assert.ok(!JSON.stringify(result).includes('export const answer'));assert.deepEqual(process,before);assert.deepEqual(evaluateProcessObligations(process,{writable:true,budgetTier:'small'}),verdict);assert.deepEqual(processPreEffectGate(process,'write'),gate);assert.equal(processPreEffectGate(process,'prove')?.reason,'process_obligations_open');}
 assert.equal(sent.length,3);assert.equal((sent[0].state as any).sources[1].text,'FAIL app.test.ts: expected 41, got 42');assert.equal((sent[0].state as any).sources[1].readbackHandle,undefined);assert.equal((sent[1].state as any).sources[0].text.includes('diff --git'),true);assert.ok((sent[2].state as any).state.includes('Защо'));
 task='t2';configure();assert.equal((await tool.execute('ask',scenarios[2],new AbortController().signal)).details.reason,'budget_exhausted');assert.equal(sent.length,3);assert.equal(histories.filter(r=>r.customType===AGENTIC_COUNTER).at(-1).data.calls,3);
 resetAgenticHub(pi);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('mid-read/mid-inference cancellation, deadlines and unavailable service refuse without late success',async()=>{
 const config=parseAgenticConfig({...section,limits:{collectionMs:30,timeoutMs:30,maxCallsPerSession:1}});
 const input={state:'x',questions:[{id:'q',type:'predicate',instructions:'Clear?'}]};
 const base={config,sessionId:'s',context:()=> 't',persist(){}};
 let calls=0,collectionSignal!:AbortSignal;
 const service:System1Service={evaluate:async()=>{calls++;return {status:'cancelled'};}};
 const c=new AbortController();const reading=createAgenticRuntime({...base,service,collect:async(_input,signal)=>{collectionSignal=signal;return new Promise(()=>{});}});const p=reading.evaluate({...input,paths:[{path:'src/app.ts'}]},c.signal);c.abort();assert.equal((await p).status,'cancelled');assert.equal(collectionSignal.aborted,true);assert.equal(calls,0);assert.equal(reading.calls,0);
 const timed=createAgenticRuntime({...base,service,collect:async()=>({sources:[],current:()=>new Promise(()=>{})})});assert.equal((await timed.evaluate({...input,paths:[{path:'src/app.ts'}]}) as any).reason,'timeout');assert.equal(calls,0);
 let finish!:(r:System1Result)=>void,request!:ProviderEvaluateRequest;
 const late=createAgenticRuntime({...base,service:{evaluate:r=>{request=r as ProviderEvaluateRequest;return new Promise(resolve=>finish=resolve);}}});const result=await late.evaluate(input);assert.equal(result.status,'unavailable');assert.equal((result as any).reason,'timeout');assert.equal(request.signal!.aborted,true);finish(providerResult(request));assert.equal(late.calls,1);
 assert.equal((await createAgenticRuntime(base).evaluate(input) as any).reason,'invalid_config');
 const missing=createAgenticRuntime({...base,service:{evaluate:async()=>({status:'skipped',reason:'missing_key'})}});assert.equal((await missing.evaluate(input) as any).reason,'missing_key');
});
