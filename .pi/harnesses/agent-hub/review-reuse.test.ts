import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyProcessClassification, createProcessState, normalizeProcessState, noteProcessStage } from "./process-obligations.ts";
import { reviewInput, retainReview, reusableReview } from "./review-reuse.ts";

test("review coverage persists and invalidates on code, contract or report changes without a quota",t=>{
 const cwd=mkdtempSync(join(tmpdir(),"fleet-review-policy-"));t.after(()=>rmSync(cwd,{recursive:true,force:true}));
 execFileSync("git",["init"],{cwd,stdio:"ignore"});writeFileSync(join(cwd,"a.ts"),"export const value=1;\n");
 execFileSync("git",["add","."],{cwd,stdio:"ignore"});execFileSync("git",["-c","user.name=Test","-c","user.email=test@example.com","commit","-m","fixture"],{cwd,stdio:"ignore"});
 writeFileSync(join(cwd,"a.ts"),"export const value=2;\n");writeFileSync(join(cwd,"review.md"),"APPROVE");
 let state=applyProcessClassification(createProcessState(),{risk:"high",scope:"small",reason:"review code"}).state;
 state={...state,changedFiles:["a.ts"]};state=noteProcessStage(state,"review",{evidenceRef:"review.md",revision:"current"});
 const requirements=[{id:"A1",text:"UTC boundary",source:"user",criticalConditions:["UTC calendar day"]}];
 const input=reviewInput(cwd,"task","security-auditor",["a.ts"],state,requirements,[]);assert.ok(input);
 state=normalizeProcessState(retainReview(state,input,"review.md",cwd));
 assert.ok(reusableReview(state,input,cwd));
 writeFileSync(join(cwd,"unrelated.txt"),"unrelated");
 assert.ok(reusableReview(state,reviewInput(cwd,"task","security-auditor",["a.ts"],state,requirements,[]),cwd));
 assert.equal(reusableReview(state,reviewInput(cwd,"task","security-auditor",["a.ts"],state,[{...requirements[0],criticalConditions:["different requirement"]}],[]),cwd),null);
 writeFileSync(join(cwd,"a.ts"),"export const value=3;\n");assert.equal(reusableReview(state,reviewInput(cwd,"task","security-auditor",["a.ts"],state,requirements,[]),cwd),null);
 writeFileSync(join(cwd,"review.md"),"changed evidence");assert.equal(reusableReview(state,input,cwd),null);
});
