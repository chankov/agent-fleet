import {canonicalMkdtempSync as mkdtempSync} from '../../../bin/test/helpers/test-temp.js';
import assert from 'node:assert/strict';import {test} from 'node:test';import {existsSync, mkdirSync, readFileSync, rmSync, renameSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {execFileSync} from 'node:child_process';
import {resolveSessionRoots,sessionGitEnv} from '../lib/workspace-context.ts';import {createEvidenceSession,beginExecutionEvidence,finishExecutionEvidence,closeEvidenceSession,pruneEvidenceSessions} from './execution-evidence.ts';
test('evidence is workspace-owned, target-partitioned and cannot accept stale or cross-target completion',()=>{
 const root=mkdtempSync(join(tmpdir(),'fleet-evidence-target-')),af=join(root,'af'),repo=join(root,'repo'),target=join(root,'repo.worktree'),old=process.env.AF_SESSION_ROOTS;const git=(...args:string[])=>execFileSync('git',['-C',repo,...args],{env:sessionGitEnv(),stdio:'pipe'});
 try{
  mkdirSync(af);mkdirSync(repo);git('init');git('-c','user.name=Fixture','-c','user.email=f@example.test','-c','commit.gpgsign=false','commit','--allow-empty','-m','initial');git('worktree','add','--detach',target);
  const a=resolveSessionRoots(af,{worktree:target}),b=resolveSessionRoots(af,{worktree:repo});process.env.AF_SESSION_ROOTS=JSON.stringify(a);
  const first=createEvidenceSession(af),second=createEvidenceSession(af);assert.notEqual(first,second);assert.ok(first.startsWith(join(af,'.pi/agent-sessions/targets',a.targetId,'sessions')+'/'));assert.equal(existsSync(join(target,'.pi/agent-sessions')),false);
  const metadata=JSON.parse(readFileSync(join(first,'session.json'),'utf8'));assert.equal(metadata.cwd,target);assert.equal(metadata.workspaceRoot,af);assert.equal(metadata.targetId,a.targetId);
  const pending=beginExecutionEvidence(first,'dispatch-a',{task:'fixture'});assert.equal(JSON.parse(readFileSync(join(pending,'request.json'),'utf8')).sessionTarget.executionRoot,target);
  process.env.AF_SESSION_ROOTS=JSON.stringify(b);const other=createEvidenceSession(af);assert.ok(!other.startsWith(join(af,'.pi/agent-sessions/targets',a.targetId)+'/'));assert.throws(()=>finishExecutionEvidence(pending,{done:true}),/target_mismatch/);closeEvidenceSession(other);
  process.env.AF_SESSION_ROOTS=JSON.stringify(a);const completed:any=finishExecutionEvidence(pending,{done:true});assert.equal(completed.sessionTarget.targetId,a.targetId);closeEvidenceSession(first);pruneEvidenceSessions(second,0,()=>false);assert.equal(existsSync(first),false);assert.equal(existsSync(other),true);
  const late=beginExecutionEvidence(second,'late',{task:'fixture'});renameSync(target,target+'.old');mkdirSync(target);assert.throws(()=>finishExecutionEvidence(late,{done:true}));assert.equal(existsSync(join(late,'result.json')),false);
  delete process.env.AF_SESSION_ROOTS;const legacy=createEvidenceSession(af);assert.ok(legacy.startsWith(join(af,'.pi/agent-sessions/sessions')+'/'));assert.equal(JSON.parse(readFileSync(join(legacy,'session.json'),'utf8')).targetId,undefined);
 }finally{if(old===undefined)delete process.env.AF_SESSION_ROOTS;else process.env.AF_SESSION_ROOTS=old;rmSync(root,{recursive:true,force:true});}
});
