import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyProcessClassification, createProcessState, normalizeProcessState, noteProcessStage } from "./process-obligations.ts";
import { reviewInput, retainReview, reusableReview } from "./review-reuse.ts";
import { revisionOf } from "./scope-gate.js";

test("review coverage persists and invalidates on code, contract or report changes without a quota",t=>{
 const cwd=mkdtempSync(join(tmpdir(),"fleet-review-policy-"));t.after(()=>rmSync(cwd,{recursive:true,force:true}));
 execFileSync("git",["init"],{cwd,stdio:"ignore"});writeFileSync(join(cwd,"a.ts"),"export const value=1;\n");
 execFileSync("git",["add","."],{cwd,stdio:"ignore"});execFileSync("git",["-c","user.name=Test","-c","user.email=test@example.com","commit","-m","fixture"],{cwd,stdio:"ignore"});
 writeFileSync(join(cwd,"a.ts"),"export const value=2;\n");writeFileSync(join(cwd,"review.md"),"APPROVE");
 let state=applyProcessClassification(createProcessState(),{risk:"high",scope:"small",reason:"review code"}).state;
 state={...state,changedFiles:["a.ts"]};state=noteProcessStage(state,"review",{evidenceRef:"review.md",revision:revisionOf(cwd)});
 const requirements=[{id:"A1",text:"UTC boundary",source:"user",criticalConditions:["UTC calendar day"]}];
 const input=reviewInput(cwd,"task","reviewer",["a.ts"],state,requirements,[]);assert.ok(input);
 state=normalizeProcessState(retainReview(state,input,"review.md",cwd));
 assert.ok(reusableReview(state,input,cwd));
 assert.equal(reusableReview({...state,review:{...state.review,evidenceRef:"another-review.md"}},input,cwd),null);
 // Practices belong to the review contract: a security review never reuses a plain review.
 const plain=reviewInput(cwd,"task","reviewer",["a.ts"],state,requirements,[],undefined,["independent-review"])!;
 const plainState=normalizeProcessState(retainReview(state,plain,"review.md",cwd));
 assert.ok(reusableReview(plainState,reviewInput(cwd,"task","reviewer",["a.ts"],state,requirements,[],undefined,["Independent-Review"]),cwd),"the same practice set reuses");
 assert.equal(reusableReview(plainState,reviewInput(cwd,"task","reviewer",["a.ts"],state,requirements,[],undefined,["independent-review","security"]),cwd),null);
 assert.notEqual(plain.contractHash,input.contractHash,"a recorded practice set changes the contract");
 assert.equal(reusableReview(state,reviewInput(cwd,"task","reviewer",["a.ts"],state,[{...requirements[0],compilerCommand:"tsc --noEmit"}],[]),cwd),null);
 assert.equal(reusableReview(state,reviewInput(cwd,"task","reviewer",["a.ts"],state,[{...requirements[0],criticalConditions:["different requirement"]}],[]),cwd),null);
 writeFileSync(join(cwd,"unrelated.txt"),"unrelated");
 assert.equal(reusableReview(state,reviewInput(cwd,"task","reviewer",["a.ts"],state,requirements,[]),cwd),null);
 rmSync(join(cwd,"unrelated.txt"));
 writeFileSync(join(cwd,"a.ts"),"export const value=3;\n");assert.equal(reusableReview(state,reviewInput(cwd,"task","reviewer",["a.ts"],state,requirements,[]),cwd),null);
 writeFileSync(join(cwd,"review.md"),"changed evidence");assert.equal(reusableReview(state,input,cwd),null);
});
