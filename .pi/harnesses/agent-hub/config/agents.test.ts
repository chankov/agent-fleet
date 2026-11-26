import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadAgentConfiguration, parseAgentFile, scanAgentDirs } from './agents.ts';
import { applyRoleCeiling, selectRoleDefinitions } from './roles.ts';
import { parseAgentTeamOverrides } from './overrides.ts';
import { resolveSessionRoots, sessionGitEnv } from '../../lib/workspace-context.ts';

test('targeted configuration belongs to af, never a target-local Fleet copy', () => {
 const root=mkdtempSync(join(tmpdir(),'fleet-config-roots-')), af=join(root,'af'), repo=join(root,'repo'), target=join(root,'repo.worktree');
 const old=process.env.AF_SESSION_ROOTS;
 const git=(...args:string[])=>execFileSync('git',['-C',repo,...args],{env:sessionGitEnv(),stdio:'pipe'});
 const put=(base:string,path:string,text:string)=>{const full=join(base,path);mkdirSync(join(full,'..'),{recursive:true});writeFileSync(full,text);};
 try {
  mkdirSync(af);mkdirSync(repo);git('init');git('-c','user.name=Fixture','-c','user.email=f@example.test','-c','commit.gpgsign=false','commit','--allow-empty','-m','initial');git('worktree','add','--detach',target);
  for(const [base,name] of [[af,'workspace-editor'],[target,'poison-editor']]) {
   put(base,`.pi/agents/personas/editor.md`,`---\nname: editor\ndescription: ${name}\n---\nUse the selected checkout.\n`);
   put(base,'.ai/agent-fleet-overrides.md',`## Agent-Hub\nlanguage: ${name}\n`);
  }
  process.env.AF_SESSION_ROOTS=JSON.stringify(resolveSessionRoots(af,{worktree:target}));
  assert.deepEqual(scanAgentDirs(target).map(def=>def.description),['workspace-editor']);
  const got:any={};
  loadAgentConfiguration(target,{
   setSessionDir(value){got.session=value;},getSessionDir(){return got.session;},archivePreviousRun(){},ensureArtifactsLayout(){},resetAssertions(){},
   setAgentDefs(value){got.defs=value;},setModelProfiles(value){got.profiles=value;},setDispatchPolicy(value){got.policy=value;},setDispatchPolicyWarnings(value){got.warnings=value;},
  });
  assert.deepEqual(got.defs.map((def:any)=>[def.name,def.description]),[['editor','workspace-editor']]);
  assert.ok(got.session.startsWith(af+'/'));
  assert.equal(parseAgentTeamOverrides(target).language,'workspace-editor');
  delete process.env.AF_SESSION_ROOTS;
  assert.deepEqual(scanAgentDirs(target).map(def=>def.description),['poison-editor']);
 } finally { if(old===undefined)delete process.env.AF_SESSION_ROOTS;else process.env.AF_SESSION_ROOTS=old;rmSync(root,{recursive:true,force:true}); }
});

test('practice_models parses inline and nested entries, diagnoses unknown practices and survives the role ceiling', () => {
 const dir=mkdtempSync(join(tmpdir(),'fleet-practice-models-'));
 try {
  const file=join(dir,'editor.md');
  writeFileSync(file,['---','name: editor','description: fixture','model: p/role','practice_models:','  planning: { model: p/astra, thinking: HIGH }','  independent-review: { model: p/x }','  testing:','    model: p/grok','    thinking: low','  planing: { model: p/typo }','  release: { thinking: low }','  documentation: { model: p/sol, thinking: loud }','delegate_depth: 1','---','Prompt.',''].join('\n'));
  const def=parseAgentFile(file)!;
  assert.deepEqual(def.practiceModels,{
   planning:{model:'p/astra',thinking:'high'},
   'independent-review':{model:'p/x'},
   testing:{model:'p/grok',thinking:'low'},
   documentation:{model:'p/sol'},
  });
  assert.equal(def.delegateDepth,1,'the block ends at the next top-level key');
  assert.ok(def.warnings?.some(w=>/practice_models "planing" is not a known practice \(research, architecture, planning/.test(w)),def.warnings?.join('\n'));
  assert.ok(def.warnings?.some(w=>/practice_models "release" declares no model — skipped/.test(w)));
  assert.ok(def.warnings?.some(w=>/practice_models "documentation" thinking "loud" is not a valid level/.test(w)));
  assert.deepEqual(applyRoleCeiling(def).practiceModels,def.practiceModels);
  assert.equal(parseAgentFile(file.replace('editor.md','missing.md')),null);
 } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('the shipped role files keep the retired personas\' practice models and list them as candidates', () => {
 const { roles } = selectRoleDefinitions(['editor','reviewer','researcher'].map(name=>parseAgentFile(`agents/${name}.md`)!));
 const byName=Object.fromEntries(roles.map(def=>[def.name,def]));
 assert.deepEqual(byName.editor.practiceModels,{
  planning:{model:'openai-codex/gpt-6.2-astra',thinking:'high'},
  architecture:{model:'openai-codex/gpt-6.2-sol',thinking:'high'},
  testing:{model:'xai/grok-4.7',thinking:'low'},
  documentation:{model:'openai-codex/gpt-6.2-sol',thinking:'minimal'},
  release:{model:'openai-codex/gpt-6.2-sol',thinking:'low'},
 });
 assert.deepEqual(byName.reviewer.practiceModels,{
  security:{model:'openai-codex/gpt-6.2-sol',thinking:'high'},
  performance:{model:'openai-codex/gpt-6-luna',thinking:'high'},
  architecture:{model:'openai-codex/gpt-6.2-sol',thinking:'high'},
 });
 assert.equal(byName.researcher.practiceModels,undefined,'D10: one researcher model');
 for (const def of roles) {
  assert.equal(def.warnings,undefined,`${def.name}: ${def.warnings?.join('; ')}`);
  for (const entry of Object.values(def.practiceModels??{})) assert.ok([def.model,...(def.models??[])].includes(entry.model),`${def.name} lists ${entry.model}`);
 }
});
