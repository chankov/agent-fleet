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

test('parent bound IDs roundtrip through actual native registration schema and validator',async()=>{
 const {default:extension}=await import('./specialist-result.ts');
 const ids=['AF-MIN-CHANGE','B1','B2','B3','B4','A1','A4','R2'];
 const old=process.env.AGENT_HUB_BOUND_ASSERTION_IDS;
 try{
  process.env.AGENT_HUB_BOUND_ASSERTION_IDS=JSON.stringify(ids);
  let tool:any;extension({registerTool:(t:any)=>tool=t});
  const {Value}=await import('@sinclair/typebox/value');
  const input={...report(),assertions_unproven:ids.map(id=>({id}))};
  assert.equal(Value.Check(tool.parameters,input),true);
  assert.deepEqual((await tool.execute('id',input,null,null,{cwd:process.cwd()})).details.specialistResult.assertions_unproven.map((a:any)=>a.id),ids);
  assert.equal(Value.Check(tool.parameters,{...report(),assertions_unproven:[{id:'A999'}]}),false);
  await assert.rejects(()=>tool.execute('id',{...report(),assertions_unproven:[{id:'A999'}]},null,null,{cwd:process.cwd()}));
  await assert.rejects(()=>tool.execute('id',{...report(),assertions_unproven:[{id:'B1'},{id:'B1'}]},null,null,{cwd:process.cwd()}));
  for(const bad of ['null','{}','["B1","B1"]','["bad id"]','',JSON.stringify(Array.from({length:101},(_,i)=>`B${i}`)),JSON.stringify(['X'.repeat(65)]),' '.repeat(8193)]){
   process.env.AGENT_HUB_BOUND_ASSERTION_IDS=bad;
   assert.throws(()=>extension({registerTool(){}}),undefined,bad.slice(0,80));
  }
 }finally{if(old===undefined)delete process.env.AGENT_HUB_BOUND_ASSERTION_IDS;else process.env.AGENT_HUB_BOUND_ASSERTION_IDS=old;}
 assert.doesNotThrow(()=>validateSpecialistResult({...report(),assertions_unproven:[{id:'A1'}]},process.cwd()));
 assert.throws(()=>validateSpecialistResult({...report(),assertions_unproven:[{id:'B1'}]},process.cwd()));
});

test('empty bound contract admits no assertion; invalid provided contracts never regain legacy schema',async()=>{
 const {specialistResultSchema}=await import('./specialist-result.ts');
 const {Value}=await import('@sinclair/typebox/value');
 assert.equal(Value.Check(specialistResultSchema([]),report()),true);
 assert.equal(Value.Check(specialistResultSchema([]),{...report(),assertions_unproven:[{id:'A1'}]}),false);
 for(const value of [null,{},['B1','B1'],['bad id'],['X'.repeat(65)],new Array(1)]) assert.throws(()=>specialistResultSchema(value as any));
});

test('typed resume identity binds exact parent IDs, copies them, and rejects malformed contracts',async()=>{
 const {bindResume}=await import('./task-resume-contract.ts');
 const ids=['AF-MIN-CHANGE','B1','A4','R2'];
 const first=bindResume({taskId:'task',instructions:'same',boundAssertionIds:ids});
 ids.push('B2'); assert.deepEqual(first.boundAssertionIds,['AF-MIN-CHANGE','B1','A4','R2']);
 assert.equal(bindResume({taskId:'task',instructions:'same',boundAssertionIds:first.boundAssertionIds,previous:first}).resumeAllowed,true);
 for(const boundAssertionIds of [undefined,[],['B1']]) assert.equal(bindResume({taskId:'task',instructions:'same',boundAssertionIds,previous:first}).resumeAllowed,false);
 for(const boundAssertionIds of [null,{},['B1','B1']]) assert.throws(()=>bindResume({taskId:'task',instructions:'same',boundAssertionIds} as any));
});
