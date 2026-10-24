import assert from 'node:assert/strict';import {test} from 'node:test';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {execFileSync} from 'node:child_process';
import {resolveSessionRoots,sessionGitEnv} from './workspace-context.ts';import {createSessionTargetGuard} from './session-target.ts';
test('session history binds only to its explicit physical target and never proves source consent',async()=>{
 const root=mkdtempSync(join(tmpdir(),'fleet-session-target-')),af=join(root,'af'),repo=join(root,'repo'),target=join(root,'repo.worktree'),old=process.env.AF_SESSION_ROOTS;
 const git=(...args:string[])=>execFileSync('git',['-C',repo,...args],{env:sessionGitEnv(),stdio:'pipe'});
 try{
  mkdirSync(af);mkdirSync(repo);git('init');git('-c','user.name=Fixture','-c','user.email=f@example.test','-c','commit.gpgsign=false','commit','--allow-empty','-m','initial');git('worktree','add','--detach',target);
  const roots=resolveSessionRoots(af,{worktree:target});const branch:any[]=[];const commands=new Map<string,any>();let confirms=0;
  const pi:any={appendEntry(customType:string,data:any){branch.push({type:'custom',customType,data});},registerCommand(name:string,command:any){commands.set(name,command);}};
  const ctx:any={cwd:target,hasUI:false,sessionManager:{getBranch:()=>branch},ui:{notify(){},confirm(){confirms++;return true;}}};
  process.env.AF_SESSION_ROOTS=JSON.stringify(roots);const first=createSessionTargetGuard(pi);
  assert.equal(first.current(target),'session_target_not_initialized');await first.start(ctx);assert.equal(first.current(target),undefined);assert.equal(branch.length,1);
  assert.equal(branch[0].data.targetId,roots.targetId);assert.equal(branch[0].data.approved,undefined);
  const resumed=createSessionTargetGuard(pi);await resumed.start(ctx);assert.equal(resumed.current(target),undefined);assert.equal(branch.length,1);
  await commands.get('af-worktree-consent').handler('agenticAsk',ctx);assert.equal(confirms,0);
  process.env.AF_SESSION_ROOTS=JSON.stringify(resolveSessionRoots(af,{worktree:repo}));assert.ok(first.current(target));
  const wrong=createSessionTargetGuard(pi);await wrong.start({...ctx,cwd:repo});assert.equal(wrong.current(repo),'resume_target_mismatch');
  delete process.env.AF_SESSION_ROOTS;const absent=createSessionTargetGuard(pi);await absent.start(ctx);assert.equal(absent.current(target),'resume_target_mismatch');
  branch.length=0;const legacy=createSessionTargetGuard(pi);await legacy.start({...ctx,cwd:af});assert.equal(legacy.current(af),undefined);assert.equal(branch.length,0);
  branch.push({type:'message'});process.env.AF_SESSION_ROOTS=JSON.stringify(roots);const unbound=createSessionTargetGuard(pi);await unbound.start(ctx);assert.equal(unbound.current(target),'unbound_resume_requires_new_session');
  process.env.AF_SESSION_ROOTS='{}';const malformed=createSessionTargetGuard(pi);await malformed.start(ctx);assert.ok(malformed.current(target));
 }finally{if(old===undefined)delete process.env.AF_SESSION_ROOTS;else process.env.AF_SESSION_ROOTS=old;rmSync(root,{recursive:true,force:true});}
});
