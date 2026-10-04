import test from 'node:test';
import assert from 'node:assert/strict';
import {createCommunicationStore} from './system1-communication-store.ts';
import {createAgenticRuntime} from './agentic-runtime.ts';
import {parseAgenticConfig} from '../lib/system1/config-agentic.js';
import type {EvaluateRequest,System1Result} from '../lib/system1/contracts.ts';
const config=parseAgenticConfig({mode:'advisory',remoteContextApproved:true});
const input={state:'PRIVATE_STATE',questions:[{id:'PRIVATE_ID',type:'choice',instructions:'PRIVATE_QUESTION',options:{PRIVATE_LABEL:'PRIVATE_CRITERION',unknown:null}}]};
const answer=(request:EvaluateRequest):System1Result=>({status:'ok',evaluation:{answers:[{questionId:'PRIVATE_ID',type:'choice',value:'PRIVATE_LABEL',uncertainty:{provenance:'provider',distribution:{PRIVATE_LABEL:1}}}],metadata:{provider:'fake',requestedModel:'fake',returnedModel:'fake',questionSetVersion:request.questionSetVersion,latencyMs:7,attempts:2}}});
test('agentic viewer records only counts/bytes and actual metadata, never dynamic text/labels/bodies',async()=>{
 const store=createCommunicationStore();store.setEnabled(true);store.subscribe(()=>{throw Error('observer');});
 const runtime=createAgenticRuntime({config,sessionId:'s',context:()=> 't',persist(){},observe:(id,status)=>store.finishAgentic(id,status),service:store.wrap({evaluate:async r=>answer(r)},{provider:'fake',model:'fake'})});
 assert.equal((await runtime.evaluate(input)).status,'ok');const pair=store.snapshot()[0];assert.equal(pair.consumer,'agenticAsk');assert.equal(pair.owner,'hub');const request=JSON.parse(pair.request!),response=JSON.parse(pair.response!);assert.equal(request.state.questionCount,1);assert.ok(request.state.requestBytes>0);assert.equal(response.metadata.attempts,2);assert.equal(response.metadata.latencyMs,7);assert.equal(response.metadata.usage,null);assert.equal(response.answerCount,1);
 assert.ok(!JSON.stringify(pair).includes('PRIVATE_'));
});
test('unknown agentic request shape stays withheld, off store remains passive',async()=>{
 const store=createCommunicationStore();const wrapped=store.wrap({evaluate:async r=>answer(r)},{provider:'fake',model:'fake'});
 const request:any={state:{owner:'PRIVATE_OWNER',sources:[{text:'PRIVATE_BODY'}]},questions:input.questions,questionSetVersion:'agentic-ask/v1'};
 await wrapped.evaluate(request);assert.equal(store.snapshot().length,0);store.setEnabled(true);await wrapped.evaluate(request);const pair=store.snapshot()[0];assert.equal(pair.owner,'hub');assert.equal(pair.request,null);assert.equal(pair.response,null);assert.ok(!JSON.stringify(pair).includes('PRIVATE_'));
});
test('stale and cancelled advice cannot appear successful even when provider settles late',async()=>{
 for(const mode of ['stale','cancelled'] as const){
 const store=createCommunicationStore();store.setEnabled(true);let context='t',finish!:(r:System1Result)=>void,request!:EvaluateRequest;
 const runtime=createAgenticRuntime({config,sessionId:'s',context:()=> context,persist(){},observe:(id,status)=>store.finishAgentic(id,status),service:store.wrap({evaluate:r=>{request=r;return new Promise(resolve=>finish=resolve);}},{provider:'fake',model:'fake'})});
 const signal=new AbortController();const pending=runtime.evaluate(input,signal.signal);await new Promise(r=>setImmediate(r));
 if(mode==='stale')context='next';else signal.abort();
 if(mode==='stale')finish(answer(request));
 assert.equal((await pending).status,mode);assert.equal(store.snapshot()[0].status,mode);
 if(mode==='cancelled'){finish(answer(request));await new Promise(r=>setImmediate(r));}
 const pair=store.snapshot()[0];assert.equal(pair.status,mode);assert.equal(JSON.parse(pair.response!).status,mode);assert.ok(!JSON.stringify(pair).includes('PRIVATE_'));
 }
});
