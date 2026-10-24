import assert from 'node:assert/strict';
import {isolateFleetTestProcess} from '../../../bin/test/helpers/test-environment.js';
import {test} from 'node:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,renameSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {execFileSync} from 'node:child_process';
import {resolveSessionRoots,sessionGitEnv} from '../lib/workspace-context.ts';
import {resolveSafetyHarness} from './safety-routing.ts';
import {resolveDelegateExtension} from './presentation.ts';
import {createDamageOwners} from './damage-guard-owners.ts';
import {loadExtensions} from '../../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js';
test('workspace safety survives target poison and stale target authority is revoked',async()=>{
 const restoreTestEnv=isolateFleetTestProcess();
 const root=mkdtempSync(join(tmpdir(),'fleet-target-safety-')),af=join(root,'af'),repo=join(root,'repo'),target=join(root,'repo.worktree'),old=process.env.AF_SESSION_ROOTS;
 const git=(...args:string[])=>execFileSync('git',['-C',repo,...args],{env:sessionGitEnv(),stdio:'pipe'});
 const put=(base:string,path:string,text:string)=>{const full=join(base,path);mkdirSync(join(full,'..'),{recursive:true});writeFileSync(full,text);};
 try{
  mkdirSync(af);mkdirSync(repo);git('init');git('-c','user.name=Fixture','-c','user.email=f@example.test','-c','commit.gpgsign=false','commit','--allow-empty','-m','initial');git('worktree','add','--detach',target);
  for(const base of [af,target]){put(base,'.pi/harnesses/damage-control-continue/index.ts','export default()=>{}');put(base,'.pi/harnesses/agent-hub/delegate.ts','export default()=>{}');}
  const policy={bashToolPatterns:[{pattern:'FORBIDDEN',reason:'workspace rule'}],zeroAccessPaths:['private/**'],readOnlyPaths:[],noDeletePaths:[]};
  put(af,'.pi/damage-control-rules.yaml',JSON.stringify(policy));put(target,'.pi/damage-control-rules.yaml','{}');
  const roots=resolveSessionRoots(af,{worktree:target});process.env.AF_SESSION_ROOTS=JSON.stringify(roots);
  assert.equal(resolveSafetyHarness(target,['pi','-e',join(target,'.pi/harnesses/damage-control-continue/index.ts')]),join(af,'.pi/harnesses/damage-control-continue/index.ts'));
  assert.equal(resolveDelegateExtension(target),join(af,'.pi/harnesses/agent-hub/delegate.ts'));
  const loaded=await loadExtensions([new URL('../damage-control-continue/index.ts',import.meta.url).pathname],target);assert.deepEqual(loaded.errors,[]);
  (loaded.runtime as any).appendEntry=()=>{};
  const ctx:any={cwd:target,hasUI:false,sessionManager:{getBranch:()=>[]},ui:{notify(){},setStatus(){}}};
  const emit=async(name:string,event:any)=>{let result;for(const handler of loaded.extensions[0].handlers.get(name)??[])result=await handler(event,ctx)??result;return result;};
  await emit('session_start',{});
  assert.equal((await emit('tool_call',{toolName:'bash',toolCallId:'policy',input:{command:'FORBIDDEN file'}})).block,true);
  assert.equal((await emit('tool_call',{toolName:'read',toolCallId:'secret',input:{path:'private/key'}})).block,true);
  const owners=createDamageOwners({current:()=>({session:'s',taskToken:'t',taskId:'task',inputRevision:'r'}),admit:()=>true});
  const child=owners.register({owner:'child',tools:['bash'],cwd:target});assert.ok(owners.validate(child,'bash',target));
  assert.throws(()=>owners.register({owner:'wrong',tools:['bash'],cwd:repo}),/target_mismatch/);
  put(af,'.pi/damage-control-rules.yaml','{}');assert.equal((await emit('tool_call',{toolName:'bash',toolCallId:'invalid',input:{command:'echo safe'}})).block,true);
  renameSync(target,target+'.old');mkdirSync(target);
  assert.equal(owners.validate(child,'bash',target),undefined);assert.equal(child.signal.aborted,true);owners.dispose();
  assert.equal((await emit('tool_call',{toolName:'read',toolCallId:'stale',input:{path:'public'}})).block,true);
  await emit('session_shutdown',{});
 }finally{if(old===undefined)delete process.env.AF_SESSION_ROOTS;else process.env.AF_SESSION_ROOTS=old;restoreTestEnv();rmSync(root,{recursive:true,force:true});}
});
