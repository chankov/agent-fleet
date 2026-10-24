import {canonicalMkdtempSync as mkdtempSync} from '../../../../../bin/test/helpers/test-temp.js';
import assert from 'node:assert/strict';import {test} from 'node:test';import {mkdirSync, writeFileSync, rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {execFileSync} from 'node:child_process';
import {resolveSessionRoots,sessionGitEnv,withSessionRoots,sessionRootsFromEnv} from '../../../../harnesses/lib/workspace-context.ts';import {qualityCommand,executeQuality} from './quality.ts';import {resolveProjectPolicy} from './project-policy.ts';import {listPersonas} from './personas.ts';import {loadEnv} from './env.ts';
test('workflow config/personas/env remain in af, policy is canonical, and quality executes in the external checkout',async()=>{
 const root=mkdtempSync(join(tmpdir(),'fleet-flow-config-')),af=join(root,'af'),repo=join(root,'repo'),target=join(root,'repo.worktree'),docs=join(root,'docs');const git=(...args:string[])=>execFileSync('git',['-C',repo,...args],{env:sessionGitEnv(),stdio:'pipe'});
 const put=(base:string,path:string,text:string)=>{const full=join(base,path);mkdirSync(join(full,'..'),{recursive:true});writeFileSync(full,text);};
 try{
  mkdirSync(af);mkdirSync(repo);mkdirSync(docs);git('init');git('-c','user.name=Fixture','-c','user.email=f@example.test','-c','commit.gpgsign=false','commit','--allow-empty','-m','initial');git('worktree','add','--detach',target);
  put(af,'.ai/agent-fleet-overrides.md',`## Agent-Hub\nrules: .ai/rules\ndocs: ../docs\n## workflows\nquality: ${process.execPath} -e "console.log(process.cwd())"\n`);put(af,'.ai/rules/check.md','# Workspace rule');put(af,'.env','FLEET_FLOW_FIXTURE=WORKSPACE\n');put(target,'.env','FLEET_FLOW_FIXTURE=POISON\n');put(target,'.ai/agent-fleet-overrides.md','## workflows\nquality: poison\n');
  put(af,'.pi/agents/personas/workspace.md','---\nname: workspace\ndescription: fixture\nmodel: fixture-model\n---\nWorkspace persona');put(target,'.pi/agents/personas/poison.md','---\nname: poison\ndescription: fixture\nmodel: poison\n---\nPoison persona');
  const before=process.env.AF_SESSION_ROOTS,roots=resolveSessionRoots(af,{worktree:target});
  await withSessionRoots(roots,async()=>{
   assert.equal(sessionRootsFromEnv()!.targetId,roots.targetId);assert.equal(process.env.AF_SESSION_ROOTS,before);
   assert.equal(loadEnv(target,{}).FLEET_FLOW_FIXTURE,'WORKSPACE');assert.deepEqual(listPersonas(target).map(persona=>persona.name),['workspace']);
   const policy=resolveProjectPolicy(target);assert.deepEqual(policy.rulesPaths,[join(af,'.ai/rules')]);assert.deepEqual(policy.docsPaths,[docs]);
   const argv=qualityCommand(target);assert.equal(argv[0],process.execPath);const result=await executeQuality(argv,{cwd:target,logPath:join(af,'quality.log')});assert.equal(result.exitCode,0);assert.equal(result.stdout.trim(),target);
  });assert.equal(process.env.AF_SESSION_ROOTS,before);
 }finally{rmSync(root,{recursive:true,force:true});}
});
