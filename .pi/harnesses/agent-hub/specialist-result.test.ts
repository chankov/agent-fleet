import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateSpecialistResult, resultFromToolEvent } from "./specialist-result.ts";

const report=()=>({status:"completed",summary:"Done",changed_files:[],assertions_proven:[],assertions_unproven:[],assertions_failed:[],tests_run:[],open_risks:[],requires_user_decision:[],evidence:[]});
test("structured submission validates real evidence and rejects escaping/missing references",()=>{
 const root=mkdtempSync(join(tmpdir(),"af-result-"));
 try{
  writeFileSync(join(root,"proof.txt"),"test exit 0");
  const value=validateSpecialistResult({...report(),evidence:[{path:"proof.txt"}]},root);
  assert.match(value.evidence[0].sha256,/^[a-f0-9]{64}$/);
  assert.throws(()=>validateSpecialistResult({...report(),evidence:[{path:"missing"}]},root));
  assert.throws(()=>validateSpecialistResult({...report(),evidence:[{path:"../outside"}]},root));
  symlinkSync("/etc/passwd",join(root,"escape"));
  assert.throws(()=>validateSpecialistResult({...report(),evidence:[{path:"escape"}]},root));
  assert.throws(()=>validateSpecialistResult({...report(),accepted:true},root));
  assert.throws(()=>validateSpecialistResult({...report(),assertions_proven:[{id:"A1",note:"done",evidence:"made up"}]},root));
 }finally{rmSync(root,{recursive:true,force:true});}
});
test("only successful matched tool execution supplies a result, never assistant prose",()=>{
 const input=report();
 const result={details:{specialistResult:{...input,evidence:[]}}};
 assert.equal(resultFromToolEvent(false,input,"submit_result",result,false),null);
 assert.equal(resultFromToolEvent(true,undefined,"submit_result",result,false),null);
 assert.equal(resultFromToolEvent(true,input,"submit_result",result,true),null);
 assert.equal(resultFromToolEvent(true,input,"bash",result,false),null);
 assert.equal(resultFromToolEvent(true,input,"submit_result",{details:{specialistResult:{...input,evidence:[null]}}},false),null);
 assert.equal(resultFromToolEvent(true,input,"submit_result",result,false)?.status,"completed");
});
