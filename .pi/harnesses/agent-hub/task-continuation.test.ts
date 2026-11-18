import assert from "node:assert/strict";
import test from "node:test";
import { isTaskContinuation, latestAcceptedTaskInput, TASK_INPUT_ENTRY_TYPE, TASK_INPUT_MAX_CHARS } from "./task-continuation.ts";

test("only explicit control continuations preserve the already accepted task input",()=>{
 for(const text of ["continue"," Continue. ","resume","продължи","Моля, продължи.","Окей, моля те продължи.","ok continue","Добре, продължавай"])assert.equal(isTaskContinuation(text),true,text);
 for(const text of ["yes","да","ok","окей","Да, моля продължи с предложената следваща стъпка","continue and deploy","продължи, но промени поведението","delete file","/continue","resume production deployment"])assert.equal(isTaskContinuation(text),false,text);
});

test("resume restores the last journaled task input and nothing else",()=>{
 const entry=(text:unknown)=>({type:"custom",customType:TASK_INPUT_ENTRY_TYPE,data:{text}});
 assert.equal(latestAcceptedTaskInput([]),undefined);
 assert.equal(latestAcceptedTaskInput([{type:"message",message:{role:"user",content:"Fix the importer"}}]),undefined);
 assert.equal(latestAcceptedTaskInput([entry("Fix the importer"),{type:"message",message:{role:"user",content:"continue"}},entry("Add paging")]),"Add paging");
 assert.equal(latestAcceptedTaskInput([entry("Fix the importer"),entry(42)]),undefined);
 assert.equal(latestAcceptedTaskInput([entry("x".repeat(TASK_INPUT_MAX_CHARS+1))]),undefined);
});
