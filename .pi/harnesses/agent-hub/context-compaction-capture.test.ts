import test from "node:test";
import assert from "node:assert/strict";
import {createCommunicationStore} from "./system1-communication-store.ts";
import {contextAssessmentMetadata,CONTEXT_COMPACTION_QUESTION_VERSION} from "./context-compaction.ts";
import type {System1Service} from "../lib/system1/contracts.ts";
for(const fail of [false,true])test(`D7 request/response capture is metadata-only, including error=${fail}`,async()=>{
 const canary="PRIVATE_TASK_SUMMARY_SECRET_CANARY";
 const store=createCommunicationStore();store.setEnabled(true);
 const service: System1Service={evaluate:async()=>{if(fail)throw Error(canary);return {status:"ok",evaluation:{answers:[{questionId:"boundary",type:"choice",value:"safe",uncertainty:{provenance:"provider",confidence:1}},{questionId:"retention",type:"choice",value:canary,uncertainty:{provenance:"provider",confidence:1}}],metadata:{provider:canary,requestedModel:canary,returnedModel:canary,questionSetVersion:canary,latencyMs:1,attempts:1}}};}};
 try { await store.wrap(service,{provider:"typesafe",model:"jev-1.13.0"}).evaluate({questionSetVersion:CONTEXT_COMPACTION_QUESTION_VERSION,state:{task:canary,summary:canary,token:canary},questions:[{id:canary,type:"choice",instructions:canary,options:{other:canary}}]}); }catch(error){assert.ok(fail);}
 const capture=JSON.stringify(store.snapshot());assert.equal(capture.includes(canary),false);assert.equal(store.snapshot().length,1);assert.match(capture,/stateBytes/);assert.match(capture,/contextCompaction/);
});

test("D7 local assessment diagnostics omit task, instructions, model text and arbitrary errors",()=>{
 const canary="PRIVATE_ASSESSMENT_CANARY";
 const metadata=contextAssessmentMetadata({status:"ineligible",reason:"insufficient_headroom",inferenceRequested:false,task:canary,instructions:canary},{tokens:232385,window:272000,responseTokens:16384,historyTokens:210000,keepRecentTokens:20000,turn:8,task:canary});
 assert.equal(JSON.stringify(metadata).includes(canary),false);assert.equal(metadata.reason,"insufficient_headroom");assert.equal(metadata.responseReservedTokens,16384);
 const failure=contextAssessmentMetadata({status:canary,reason:canary,message:canary},{tokens:NaN,window:Infinity});
 assert.equal(JSON.stringify(failure).includes(canary),false);assert.equal(failure.reason,"evaluation_failed");assert.equal(failure.tokens,null);
});
