import test from 'node:test';
import assert from 'node:assert/strict';
import {parseFileDiscoveryConfig} from '../../lib/system1/config-file-discovery.js';
import {createSystem1Service} from '../../lib/system1/service.ts';
import type {System1Provider} from '../../lib/system1/contracts.ts';
import {JEV_ENDPOINT,JEV_MODEL,createJevProvider,type JevTransport} from '../../lib/system1/jev.ts';
import {sourceHash} from '../agentic-sources.ts';
import {STANDARD_QUESTIONS,composeQuestions,evaluateFile} from './evaluate.ts';
export function fakeService(hook?:(request:any)=>void,invalid=false) {
 let calls=0;
 const provider:System1Provider={name:'fake',model:'test',capabilities:['ordinal','choice','predicate','distribution','provider_confidence'],async evaluate(r){
  calls++;hook?.(r);
  const answers=r.questions.map(q=>({questionId:q.id,type:q.type,uncertainty:{provenance:'provider' as const,confidence:0.8,...(q.type==='predicate'?{}:{distribution:Object.fromEntries((q.type==='ordinal'?q.levels.map((_,i)=>String(i)):Object.keys(q.options)).map(k=>[k,0.1]))})},...(q.type==='ordinal'?{value:invalid?99:0,levels:q.levels}:q.type==='choice'?{value:Object.keys(q.options)[0]}:{probabilityTrue:0.5})}));
  return {status:'ok',evaluation:{answers,metadata:{provider:'fake',requestedModel:'test',returnedModel:'test',questionSetVersion:r.questionSetVersion,latencyMs:1,attempts:1}}} as any;
 }};
 return {service:createSystem1Service({provider}),calls:()=>calls};
}
const config=parseFileDiscoveryConfig({mode:'active',remoteContextApproved:true,include:['src']});
const source={path:'src/a.ts',text:'safe fixture',hash:sourceHash('safe fixture'),current:async()=>true};
const base={config,source,task:'find rounding',signal:new AbortController().signal};
test('standard profile and 14 validated custom questions in one shared service call, no bodies in projection',async()=>{
 const fake=fakeService(r=>{assert.equal(r.questions.length,16);assert.equal(r.questionSetVersion,'file-discovery/questions/v1');});
 const customQuestions=Array.from({length:14},(_,i)=>({id:`q${i}`,type:'predicate',instructions:'check'}));
 const result=await evaluateFile({...base,...fake,customQuestions});
 assert.equal(result.status,'scored');if(result.status==='scored'){assert.equal(result.relevance,0);assert.equal(result.answers.length,16);assert.equal(result.answers[0].uncertainty.confidence,0.8);}
 assert.equal(fake.calls(),1);assert.ok(!JSON.stringify(result).includes(source.text));
});
test('absent/off/unapproved and invalid questions never infer or inherit consent',async()=>{
 const fake=fakeService();
 for(const c of [undefined,{...config,mode:'off' as const},{...config,remoteContextApproved:false}]) assert.equal((await evaluateFile({...base,...fake,config:c})).status,'unscored');
 for(const custom of [[{id:'d9_role',type:'predicate',instructions:'x'}],Array(15).fill({id:'x'}),[{id:'x',type:'choice',instructions:'x',options:{yes:null,no:null}}]]) assert.equal(composeQuestions(custom),undefined);
 assert.equal((await evaluateFile({...base,...fake,customQuestions:[{id:'d9_role'}]})).status,'unscored');assert.equal(fake.calls(),0);
});
test('bounds, invalid answers, source freshness and unavailable do not become relevance zero',async()=>{
 const fake=fakeService(undefined,true);
 assert.deepEqual(await evaluateFile({...base,...fake}),{status:'unscored',reason:'invalid_response'});
 const notReady=createSystem1Service({availability:{status:'unavailable',reason:'invalid_config'}});
 assert.deepEqual(await evaluateFile({...base,service:notReady}),{status:'unscored',reason:'invalid_config'});
 const valid=fakeService();assert.equal((await evaluateFile({...base,...valid,config:{...config,limits:{...config.limits,maxRequestBytes:100}}})).status,'unscored');
 assert.equal((await evaluateFile({...base,...valid,source:{...source,current:async()=>false}})).status,'unscored');assert.equal(valid.calls(),0);
});
const FIXTURE_KEY='fixture-key-not-a-credential';
function wireAnswers(mutate?:(body:any)=>void){
 const body={model:JEV_MODEL,usage:{input_tokens:11,output_tokens:4},answers:{
  d9_relevance:{type:'score',score:2,legend:{'0':'unrelated','1':'supporting','2':'directly relevant','3':'primary'},probabilities:{'0':0.05,'1':0.15,'2':0.7,'3':0.1},confidence:0.64},
  d9_role:{type:'choice',choice:'test',probabilities:{implementation:0.1,test:0.6,configuration:0.05,documentation:0.1,mixed:0.1,other:0.05},confidence:0.55},
 }};
 mutate?.(body);return body;
}
function jevService(transport:JevTransport,provider:System1Provider=createJevProvider({apiKey:FIXTURE_KEY,transport})){
 return {provider,service:createSystem1Service({provider})};
}
test('D9 standard questions score through the real Jev provider and shared service using only mocked transport',async()=>{
 let calls=0;let observed:any;
 const transport:JevTransport=async request=>{calls++;observed=request;return {status:200,headers:{},body:JSON.stringify(wireAnswers())};};
 const {provider,service}=jevService(transport);
 assert.equal(provider.capabilities.includes('distribution'),true);
 assert.equal(provider.capabilities.includes('provider_confidence'),false);
 const result=await evaluateFile({...base,service});
 assert.equal(calls,1);assert.equal(observed.url,JEV_ENDPOINT);assert.equal(observed.method,'POST');
 assert.equal(observed.headers.authorization,`Bearer ${FIXTURE_KEY}`);
 const sent=JSON.parse(observed.body.toString('utf8'));
 assert.equal(sent.model,JEV_MODEL);assert.equal(sent.questions.d9_relevance.type,'score');assert.equal(sent.questions.d9_role.type,'choice');
 assert.deepEqual(sent.questions.d9_relevance.criteria,STANDARD_QUESTIONS[0].levels);
 assert.equal(result.status,'scored');if(result.status!=='scored')return;
 assert.equal(result.relevance,2);assert.equal(result.role,'test');
 const relevance=result.answers.find(a=>a.questionId==='d9_relevance'),role=result.answers.find(a=>a.questionId==='d9_role');
 assert.equal(relevance?.type,'ordinal');assert.equal(role?.type,'choice');
 assert.deepEqual(relevance?.uncertainty,{provenance:'provider',confidence:0.64,distribution:{'0':0.05,'1':0.15,'2':0.7,'3':0.1}});
 assert.deepEqual(role?.uncertainty,{provenance:'provider',confidence:0.55,distribution:{implementation:0.1,test:0.6,configuration:0.05,documentation:0.1,mixed:0.1,other:0.05}});
 assert.ok(!JSON.stringify(result).includes(source.text));assert.ok(!JSON.stringify(result).includes(FIXTURE_KEY));
});
test('malformed Jev uncertainty stays unscored after transport and a provider missing distribution never reaches it',async()=>{
 for(const mode of ['confidence','distribution'] as const){
  let calls=0;const transport:JevTransport=async()=>{calls++;return {status:200,headers:{},body:JSON.stringify(wireAnswers(body=>{
   if(mode==='confidence')delete body.answers.d9_role.confidence;else delete body.answers.d9_relevance.probabilities;
  }))};};
  const result=await evaluateFile({...base,...jevService(transport)});
  assert.equal(calls,1);assert.deepEqual(result,{status:'unscored',reason:'invalid_response'});
 }
 let calls=0;const transport:JevTransport=async()=>{calls++;throw Error('transport must not run');};
 const real=createJevProvider({apiKey:FIXTURE_KEY,transport});
 const missing:System1Provider={...real,capabilities:real.capabilities.filter(capability=>capability!=='distribution')};
 assert.equal((await evaluateFile({...base,service:createSystem1Service({provider:missing})})).status,'unscored');
 assert.deepEqual(await evaluateFile({...base,service:createSystem1Service({provider:missing})}),{status:'unscored',reason:'unsupported'});
 assert.equal(calls,0);
 const incomplete:System1Provider={name:'typesafe',model:JEV_MODEL,capabilities:['ordinal','choice','predicate','distribution','probability_true'],async evaluate(request){
  calls++;return {status:'ok',evaluation:{answers:request.questions.map(q=>q.type==='ordinal'?{questionId:q.id,type:'ordinal',value:1,levels:[...q.levels],uncertainty:{provenance:'provider',confidence:0.4}}:{questionId:q.id,type:'choice',value:'test',uncertainty:{provenance:'provider',confidence:0.4}}),metadata:{provider:'typesafe',requestedModel:JEV_MODEL,returnedModel:JEV_MODEL,questionSetVersion:request.questionSetVersion,latencyMs:1,attempts:1}}};
 }};
 assert.deepEqual(await evaluateFile({...base,service:createSystem1Service({provider:incomplete})}),{status:'unscored',reason:'invalid_response'});
 assert.equal(calls,1);
});
