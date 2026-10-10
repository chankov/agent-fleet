import test from "node:test";
import assert from "node:assert/strict";
import {createContextContinuityBroker} from "./context-continuity-broker.ts";
import {contextChannelCall} from "./context-continuity-client.ts";
import {openContextOwner,revokeContextOwner} from "./context-continuity-owners.ts";
test("authenticated status/directive works without System1 and revocation rejects late attempts",async()=>{
 const broker=await createContextContinuityBroker();try{const owner=openContextOwner("fixture");const assignment=broker.assignment(owner);
 const payload={phase:"pending",episode:1,tokens:900,window:1000,cacheRead:0,cacheWrite:0,input:900,output:1};
 const result=await contextChannelCall(assignment,"context_status",payload);assert.equal(result.status,"ok");assert.equal(result.directive.episode,1);assert.equal(result.directive.attempt,owner.attempt);
 assert.equal((await contextChannelCall({...assignment,token:"wrong"},"context_status",payload)).status,"denied");
 assert.equal((await contextChannelCall(assignment,"context_status",{...payload,eval:"arbitrary"})).status,"denied");
 assert.equal((await contextChannelCall(assignment,"context_assessment",{identity:"fixture",task:"task",revision:1,turn:1,tokens:600,window:1000,historyTokens:400,keepRecentTokens:100,responseTokens:100,unsafe:false})).assessment.status,"off");
 revokeContextOwner(owner.attempt);assert.equal((await contextChannelCall(assignment,"context_status",payload)).status,"denied");
 }finally{await broker.close();}
});
test("channel outage and cancellation are bounded unavailable, not permissions",async()=>{
 const broker=await createContextContinuityBroker();const a=broker.assignment(openContextOwner("outage"));await broker.close();assert.equal((await contextChannelCall(a,"context_status",{},10)).status,"unavailable");const c=new AbortController();c.abort();assert.equal((await contextChannelCall(a,"context_status",{},10,c.signal)).status,"unavailable");
});
