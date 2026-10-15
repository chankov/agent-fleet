import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createDamageGuard} from './system1-guard.ts';
import {createDamageState} from '../agent-hub/damage-guard-state.ts';
import {parseDamageGuardConfig} from '../lib/system1/config-damage-guard.js';
test('proposed edits resolve against actual operation cwd, not the configured project root',async t=>{
 const root=mkdtempSync(join(tmpdir(),'d6-cwd-'));for(const path of ['docs','sub/docs'])mkdirSync(join(root,path),{recursive:true});t.after(()=>rmSync(root,{recursive:true,force:true}));let calls=0;
 const guard=createDamageGuard({root,config:parseDamageGuardConfig({mode:'active',remoteScopes:{edits:true},include:['docs']}),state:createDamageState(()=>{}),binding:()=>({taskId:'task',inputRevision:'rev',owner:'hub',attempt:'run'}),canRead:()=>true,approve:async()=>false,service:{evaluate:async()=>{calls++;return {status:'unavailable',reason:'network'};}}});
 assert.equal((await guard.call({toolName:'write',toolCallId:'a',input:{path:'docs/new.txt',content:'public fixture'}},{cwd:join(root,'sub'),revalidateBaseline:()=>true})).block,false);assert.equal(calls,0);guard.dispose();
});
test('duplicate in-flight observers share assessment but cannot duplicate effect admission',async()=>{
 let finish!:(value:any)=>void;const evaluated=new Promise<any>(resolve=>finish=resolve);
 const guard=createDamageGuard({root:process.cwd(),config:parseDamageGuardConfig({mode:'active',remoteScopes:{commands:true},include:['docs']}),state:createDamageState(()=>{}),binding:()=>({taskId:'task',inputRevision:'rev',owner:'hub',attempt:'run'}),canRead:()=>true,approve:async()=>false,service:{evaluate:()=>evaluated}}),event={toolName:'bash',toolCallId:'same',input:{command:'echo public'}},ctx={cwd:process.cwd(),revalidateBaseline:()=>true};
 const first=guard.call(event,ctx),duplicate=guard.call(event,ctx);finish({status:'unavailable',reason:'network'});assert.equal((await first).block,false);assert.equal((await duplicate).block,true);guard.dispose();
});
