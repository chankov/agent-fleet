import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHistoryProjectionMemo, projectCoordinationHistory } from "./history-projection.ts";

const assistant=(id:string)=>({role:"assistant",content:[{type:"toolCall",id,name:"dispatch_agent",arguments:{task:"Keep every declared requirement"}}]});
const result=(id:string,details:any={})=>({role:"toolResult",toolCallId:id,toolName:"dispatch_agent",isError:false,content:[{type:"text",text:"large historical report ".repeat(1500)}],details:{status:"completed_unverified",exitCode:0,accepted:false,...details}});
function directory(t:any){const dir=mkdtempSync(join(tmpdir(),"fleet-context-"));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;}

test("history projection shrinks older coordination bodies with exact readable originals and preserves protocol",t=>{
 const dir=directory(t),old=result("old");
 const messages:any[]=[{role:"user",content:"Requirement and explicit permission"},assistant("old"),old,{role:"user",content:"Continue the same authorized task"},assistant("latest"),result("latest")];
 const before=JSON.stringify(messages);const projected=projectCoordinationHistory(messages as any,dir);
 assert.equal(projected.projected,1);assert.ok(projected.savedBytes>20_000);
 assert.ok(JSON.stringify(projected.messages).length<before.length*.65);
 const saved=(projected.messages[2] as any).details.historicalReference;
 assert.deepEqual(JSON.parse(readFileSync(saved,"utf8")),old);assert.equal(JSON.stringify(messages),before,"saved session messages remain unchanged");
 assert.deepEqual(projected.messages[0],messages[0]);assert.deepEqual(projected.messages[1],messages[1]);assert.equal((projected.messages[2] as any).toolCallId,"old");
 assert.equal(projected.messages[5],messages[5],"latest result remains complete");
 assert.equal((projected.messages[2] as any).details.accepted,false,"projection cannot turn an unverified result into acceptance");
 assert.equal(projectCoordinationHistory(projected.messages,dir).projected,0,"projection is idempotent");
});

for(const special of ["error","question","unstructured-question","human","ordinary-read","pending","image","unknown-outcome","corrupt-original"] as const)test(`history projection preserves ${special}`,t=>{
 const dir=directory(t),old:any=result("old");
 if(special==="error")old.isError=true;
 if(special==="unstructured-question")old.content[0].text+="Which behavior do you want?";
 if(special==="question")old.details.questions=["Choose required behavior"];
 if(special==="human")old.toolName="ask_user";
 if(special==="ordinary-read")old.toolName="read";
 if(special==="pending")old.details.pending=true;
 if(special==="unknown-outcome"){old.details={};old.toolName="coms_await";}
 if(special==="image")old.content.push({type:"image",data:"pixels",mimeType:"image/png"});
 const messages:any[]=[assistant("old"),old,assistant("latest"),result("latest")];
 if(special==="corrupt-original"){
  const projected=projectCoordinationHistory(messages as any,dir);
  const ref=(projected.messages[1] as any).details.historicalReference;
  assert.ok(ref);writeFileSync(ref,"corrupt original");
 }
 assert.equal(projectCoordinationHistory(messages as any,dir).projected,0);
});

test("older inspection pages become exact references after the recent working set, while requirements stay verbatim",t=>{
 const dir=directory(t),old:any=result("old");old.toolName="read";old.content=[{type:"text",text:"source code\n".repeat(9000)}];old.details={};
 const recent:any=result("recent");recent.toolName="read";recent.content=[{type:"text",text:"recent working source"}];recent.details={};
 const user={role:"user",content:"Keep the documented UTC boundary requirement"};
 const messages:any[]=[user,assistant("old"),old,assistant("recent"),recent];
 const projected=projectCoordinationHistory(messages as any,dir);
 assert.equal(projected.projected,1);assert.ok(projected.savedBytes>90_000);
 assert.equal(projected.messages[0],user);assert.equal(projected.messages[4],recent);
 assert.deepEqual(JSON.parse(readFileSync((projected.messages[2] as any).details.historicalReference,"utf8")),old);
});

test("current prompt keeps exact sourced critical conditions outside historical projections",async()=>{
 const {stateCapsuleFragment}=await import("./prompts/fragments.ts");
 const prompt=stateCapsuleFragment({taskTier:"feature",taskTierAssumed:false,turnDispatchCount:0,turnResearchCount:0,taskDispatchCount:0,taskResearchCount:0,taskReviewRounds:0,provisionalConfirmations:[],requirements:[{id:"A1",text:"Use the UTC calendar boundary",source:"user-approved plan",reference:"PLAN.md:42",criticalConditions:["Never use the local calendar day"],recordedStatus:"unproven"}]} as any,{active:[],provisional:[],reasons:{}} as any);
 for(const condition of ["Use the UTC calendar boundary","user-approved plan","PLAN.md:42","Never use the local calendar day"])assert.ok(prompt.includes(condition),condition);
 assert.match(prompt,/recorded status is not fresh verification/);
});

test("history projection leaves an external artifact symlink untouched",t=>{
 const dir=directory(t),external=directory(t);
 symlinkSync(external,join(dir,"artifacts"));
 const messages:any[]=[assistant("old"),result("old"),assistant("latest"),result("latest")];
 assert.equal(projectCoordinationHistory(messages as any,dir).projected,0);
 assert.equal(existsSync(join(external,"context-history")),false,"projection cannot create directories through an external symlink");
});

const small=(id:string)=>{const r:any=result(id);r.content=[{type:"text",text:"historical report ".repeat(400)}];return r;};
test("a session memo projects in batches and reuses the exact earlier view without rereading",t=>{
 const dir=directory(t),memo=createHistoryProjectionMemo(16_000);
 const history:any[]=[assistant("a"),small("a"),assistant("b"),small("b")];
 let view=projectCoordinationHistory([...history,assistant("latest"),result("latest")] as any,dir,memo);
 assert.equal(view.projected,0,"one small result waits for a batch");
 history.push(assistant("c"),small("c"),assistant("d"),small("d"));
 view=projectCoordinationHistory([...history,assistant("latest2"),result("latest2")] as any,dir,memo);
 assert.equal(view.added,4,"the accumulated batch projects at once");
 const first=view.messages[1],reference=(first as any).details.historicalReference;
 const again=projectCoordinationHistory([...history,assistant("latest3"),result("latest3")] as any,dir,memo);
 assert.equal(again.added,0);assert.equal(again.projected,4);
 assert.equal(again.messages[1],first,"an earlier projection is the identical object, so the prompt prefix stays stable");
 writeFileSync(reference,"tampered");
 const checked=projectCoordinationHistory([...history,assistant("latest4"),result("latest4")] as any,dir,memo);
 assert.notEqual(checked.messages[1],first,"a changed original reference is never reused");
 assert.equal(checked.projected,3,"the tampered result stays verbatim until a new batch rewrites it");
});
