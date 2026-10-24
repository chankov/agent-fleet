import {canonicalMkdtempSync as mkdtempSync} from '../../../bin/test/helpers/test-temp.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {mkdirSync, writeFileSync, rmSync, unlinkSync} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveSessionRoots,sessionGitEnv } from './workspace-context.ts';
import { readDamagePolicy } from './damage-policy.ts';
import { currentFileAccessAllowed } from './damage-control-shared.ts';
test('targeted damage policy is strict, workspace-owned and execution-relative',()=>{
 const root=mkdtempSync(join(tmpdir(),'fleet-damage-roots-')),af=join(root,'af'),repo=join(root,'repo'),target=join(root,'repo.worktree');const old=process.env.AF_SESSION_ROOTS;
 const git=(...args:string[])=>execFileSync('git',['-C',repo,...args],{env:sessionGitEnv(),stdio:'pipe'});
 try{
  mkdirSync(join(af,'.pi'),{recursive:true});mkdirSync(repo);git('init');git('-c','user.name=Fixture','-c','user.email=f@example.test','-c','commit.gpgsign=false','commit','--allow-empty','-m','initial');git('worktree','add','--detach',target);mkdirSync(join(target,'.pi'));
  const policy={bashToolPatterns:[{pattern:'rm',reason:'destructive'}],zeroAccessPaths:['private/**'],readOnlyPaths:['protected.txt'],noDeletePaths:['keep.txt']};
  writeFileSync(join(af,'.pi/damage-control-rules.yaml'),JSON.stringify(policy));writeFileSync(join(target,'.pi/damage-control-rules.yaml'),'{}');
  process.env.AF_SESSION_ROOTS=JSON.stringify(resolveSessionRoots(af,{worktree:target}));
  assert.equal(readDamagePolicy(target)?.path,join(af,'.pi/damage-control-rules.yaml'));
  assert.deepEqual(readDamagePolicy(target)?.rules,policy);
  assert.equal(currentFileAccessAllowed(target,join(target,'private/key')),false);
  assert.equal(currentFileAccessAllowed(target,join(target,'public/file')),true);
  for(const malformed of ['{','{}',JSON.stringify({...policy,zeroAccessPaths:'private'}),JSON.stringify({...policy,bashToolPatterns:[{pattern:'[',reason:'broken'}]})]){
   writeFileSync(join(af,'.pi/damage-control-rules.yaml'),malformed);assert.throws(()=>readDamagePolicy(target));assert.equal(currentFileAccessAllowed(target,'public/file'),false);
  }
  unlinkSync(join(af,'.pi/damage-control-rules.yaml'));assert.throws(()=>readDamagePolicy(target),/missing_workspace/);assert.equal(currentFileAccessAllowed(target,'public/file'),false);
 }finally{if(old===undefined)delete process.env.AF_SESSION_ROOTS;else process.env.AF_SESSION_ROOTS=old;rmSync(root,{recursive:true,force:true});}
});
