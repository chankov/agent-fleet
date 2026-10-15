import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync,writeFileSync,rmSync,symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { captureReviewBaseline,retainReviewHistory,reviewContinuation } from "./review-continuity.ts";
import { reviewInput } from "./review-reuse.ts";
import { createProcessState,normalizeProcessState } from "./process-obligations.ts";

function fixture(t:any){
 const cwd=mkdtempSync(join(tmpdir(),"af-review-continuity-"));t.after(()=>rmSync(cwd,{recursive:true,force:true}));
 execFileSync("git",["init"],{cwd,stdio:"ignore"});
 writeFileSync(join(cwd,"a.ts"),"const a=1;\n");
 execFileSync("git",["add","."],{cwd,stdio:"ignore"});
 execFileSync("git",["-c","user.name=Test","-c","user.email=test@example.com","commit","-m","fixture"],{cwd,stdio:"ignore"});
 writeFileSync(join(cwd,"a.ts"),"const a=2;\n");
 let state={...createProcessState(),changedFiles:["a.ts"]};
 const input=reviewInput(cwd,"task","code-reviewer",["a.ts"],state,[],[])!;
 const baseline=captureReviewBaseline(cwd,input,state)!;
 writeFileSync(join(cwd,"review.md"),"REJECT: constant");
 writeFileSync(join(cwd,"baseline.json"),JSON.stringify(baseline));
 state=normalizeProcessState(retainReviewHistory(state,input,"review.md","baseline.json",cwd));
 return {cwd,state,input,baseline};
}
test("history survives normalization but never satisfies review; changed code gets an actual patch",t=>{
 const f=fixture(t);
 writeFileSync(join(f.cwd,"a.ts"),"const a=3;\n");
 const next=captureReviewBaseline(f.cwd,f.input,f.state);
 const text=reviewContinuation(f.state,f.input,next,f.cwd);
 assert.match(text,/Incremental review context/);assert.match(text,/-const a=2/);assert.match(text,/\+const a=3/);
 assert.equal(f.state.review.evidenceRef,null);
 assert.equal(reviewContinuation(f.state,{...f.input,taskId:"other"},next,f.cwd),"");
});
for(const change of ["scope","contract","head","new-file","missing","tampered","symlink","focus"]){
 test("full review fallback for "+change,t=>{
  const f=fixture(t);let input={...f.input},baseline=structuredClone(f.baseline);
  if(change==="scope")input.scope=["a.ts","b.ts"];
  if(change==="contract")input.contractHash="f".repeat(64);
  if(change==="head")baseline.head="other";
  if(change==="new-file")baseline.files["b.ts"]={content:"new",mode:33188};
  if(change==="missing")rmSync(join(f.cwd,"baseline.json"));
  if(change==="tampered")writeFileSync(join(f.cwd,"review.md"),"APPROVE");
  if(change==="symlink"){rmSync(join(f.cwd,"baseline.json"));symlinkSync("/etc/passwd",join(f.cwd,"baseline.json"));}
  assert.match(reviewContinuation(f.state,input,baseline,f.cwd,change==="focus"),/Full review required/);
 });
}
test("snapshot refuses binary and oversized files instead of emitting partial delta",t=>{
 const f=fixture(t);
 writeFileSync(join(f.cwd,"a.ts"),Buffer.alloc(10));
 assert.equal(captureReviewBaseline(f.cwd,f.input,f.state),null);
 writeFileSync(join(f.cwd,"a.ts"),"x".repeat(65537));
 assert.equal(captureReviewBaseline(f.cwd,f.input,f.state),null);
});
