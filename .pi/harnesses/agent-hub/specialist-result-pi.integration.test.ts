import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnPiAgent } from "./spawn.ts";

import {resolvePiTestRuntime} from '../../../bin/test/helpers/pi-runtime.js';
const root=fileURLToPath(new URL("../../../",import.meta.url));
const runtime=resolvePiTestRuntime({root});
const probe=String.raw`
import {createAssistantMessageEventStream} from "@earendil-works/pi-ai";
let calls=0;
export default function(pi:any){
 pi.registerProvider("result-fixture",{name:"fixture",baseUrl:"http://127.0.0.1",apiKey:"fixture",api:"fixture-api",
 models:[{id:"m",name:"m",reasoning:false,input:["text"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:64000,maxTokens:1000}],
 streamSimple(model:any){
  const stream=createAssistantMessageEventStream();
  queueMicrotask(()=>{
   const msg:any={role:"assistant",content:[],api:model.api,provider:model.provider,model:model.id,usage:{input:100,output:10,cacheRead:0,cacheWrite:0,totalTokens:110,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:"stop",timestamp:Date.now()};
   stream.push({type:"start",partial:msg});
   if(++calls<=2){
    const path=calls===1?"missing.txt":"proof.txt";
    const tc={type:"toolCall",id:"submit-"+calls,name:"submit_result",arguments:{status:"completed",summary:"Done",changed_files:[],assertions_proven:[{id:"A1",evidence:path}],assertions_unproven:[],assertions_failed:[],tests_run:[],open_risks:[],requires_user_decision:[],evidence:[{path}]}};
    msg.content.push(tc);msg.stopReason="toolUse";stream.push({type:"toolcall_start",contentIndex:0,partial:msg});stream.push({type:"toolcall_end",contentIndex:0,toolCall:tc,partial:msg});
   }else{
    msg.content.push({type:"text",text:"RESULT_FINISHED"});stream.push({type:"text_start",contentIndex:0,partial:msg});stream.push({type:"text_delta",contentIndex:0,delta:"RESULT_FINISHED",partial:msg});stream.push({type:"text_end",contentIndex:0,content:"RESULT_FINISHED",partial:msg});
   }
   stream.push({type:"done",reason:msg.stopReason,message:msg});stream.end();
  });return stream;
 }});
}
`;
test("real project Pi validates a failed submission then delivers a repaired result through native transport",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"af-result-pi-"));
 try{
  mkdirSync(join(dir,"bin"));mkdirSync(join(dir,"agent"));
  symlinkSync(runtime.cli,join(dir,"bin/pi"));
  writeFileSync(join(dir,"provider.ts"),probe);writeFileSync(join(dir,"proof.txt"),"Verified fixture");
  writeFileSync(join(dir,"agent/settings.json"),JSON.stringify({compaction:{enabled:false}}));
  const results:any[]=[];
  const result=await spawnPiAgent({model:"result-fixture/m",tools:"submit_result",thinking:"off",sessionFile:join(dir,"session.jsonl"),prompt:"Report fixture",cwd:dir,turnDeadlineMs:20000,
   specialistResultTool:true,noSkills:true,noContextFiles:true,
   extensions:[join(root,".pi/harnesses/agent-hub/specialist-result.ts"),join(dir,"provider.ts")],
   env:{PATH:join(dir,"bin")+":"+process.env.PATH,HOME:dir,PI_CODING_AGENT_DIR:join(dir,"agent"),PI_OFFLINE:"1",NODE_OPTIONS:"--import="+join(root,"bin/test/helpers/system1-no-network.js")},
  },{onToolEnd:(name,id,error)=>results.push({name,id,error})});
  assert.equal(result.exitCode,0,result.stderr);
  assert.equal(results.length,2,JSON.stringify({results,result}));
  assert.equal(results[0].error,true);
  assert.equal(results[1].error,false);
  assert.equal(result.specialistResult?.status,"completed",JSON.stringify(result));
  assert.equal(result.specialistResult?.assertions_proven[0].evidence,"proof.txt");
  assert.match(result.specialistResult!.evidence[0].sha256,/^[a-f0-9]{64}$/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
