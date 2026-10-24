import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadAgentConfiguration, scanAgentDirs } from './agents.ts';
import { parseAgentTeamOverrides } from './overrides.ts';
import { resolveSessionRoots, sessionGitEnv } from '../../lib/workspace-context.ts';

test('targeted configuration belongs to af, never a target-local Fleet copy', () => {
 const root=mkdtempSync(join(tmpdir(),'fleet-config-roots-')), af=join(root,'af'), repo=join(root,'repo'), target=join(root,'repo.worktree');
 const old=process.env.AF_SESSION_ROOTS;
 const git=(...args:string[])=>execFileSync('git',['-C',repo,...args],{env:sessionGitEnv(),stdio:'pipe'});
 const put=(base:string,path:string,text:string)=>{const full=join(base,path);mkdirSync(join(full,'..'),{recursive:true});writeFileSync(full,text);};
 try {
  mkdirSync(af);mkdirSync(repo);git('init');git('-c','user.name=Fixture','-c','user.email=f@example.test','-c','commit.gpgsign=false','commit','--allow-empty','-m','initial');git('worktree','add','--detach',target);
  for(const [base,name] of [[af,'workspace-builder'],[target,'poison-builder']]) {
   put(base,`.pi/agents/personas/${name}.md`,`---\nname: ${name}\ndescription: fixture\n---\nUse the selected checkout.\n`);
   put(base,'.pi/agents/teams.yaml',`fixture:\n  - ${name}\n`);
   put(base,'.ai/agent-fleet-overrides.md',`## Agent-Hub\nlanguage: ${name}\n`);
  }
  process.env.AF_SESSION_ROOTS=JSON.stringify(resolveSessionRoots(af,{worktree:target}));
  assert.deepEqual(scanAgentDirs(target).map(def=>def.name),['workspace-builder']);
  const got:any={};
  loadAgentConfiguration(target,{
   setSessionDir(value){got.session=value;},getSessionDir(){return got.session;},archivePreviousRun(){},ensureArtifactsLayout(){},resetAssertions(){},
   setAgentDefs(value){got.defs=value;},setTeams(value){got.teams=value;},setModelProfiles(value){got.profiles=value;},setDispatchPolicy(value){got.policy=value;},setDispatchPolicyWarnings(value){got.warnings=value;},
  });
  assert.deepEqual(got.defs.map((def:any)=>def.name),['workspace-builder']);
  assert.deepEqual(got.teams.fixture,['workspace-builder']);
  assert.ok(got.session.startsWith(af+'/'));
  assert.equal(parseAgentTeamOverrides(target).language,'workspace-builder');
  delete process.env.AF_SESSION_ROOTS;
  assert.deepEqual(scanAgentDirs(target).map(def=>def.name),['poison-builder']);
 } finally { if(old===undefined)delete process.env.AF_SESSION_ROOTS;else process.env.AF_SESSION_ROOTS=old;rmSync(root,{recursive:true,force:true}); }
});
