import assert from "node:assert/strict";
import test from "node:test";
import { isTaskContinuation } from "./task-continuation.ts";

test("only explicit control continuations preserve the already accepted task input",()=>{
 for(const text of ["continue"," Continue. ","resume","продължи","Моля, продължи."])assert.equal(isTaskContinuation(text),true,text);
 for(const text of ["yes","да","ok","continue and deploy","продължи, но промени поведението","delete file","/continue","resume production deployment"])assert.equal(isTaskContinuation(text),false,text);
});
