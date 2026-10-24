import {canonicalMkdtempSync as mkdtempSync} from '../../../bin/test/helpers/test-temp.js';
import assert from 'node:assert/strict';import {test} from 'node:test';import {createHash} from 'node:crypto';
import {mkdirSync, writeFileSync, readFileSync, rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {execFileSync} from 'node:child_process';
import {resolveSessionRoots,sessionGitEnv} from '../lib/workspace-context.ts';import {resolvePolicyRoots} from '../lib/policy-roots.ts';import {loadProactiveConfig} from './proactive-config.ts';import {discoverRules} from './proactive-rules.ts';import {beginTurnCore,finishTurnCore,readSnapshotUnit} from './proactive-snapshot.ts';import {assessLocal} from './proactive-local.ts';
test('unchanged workspace binding validates only changed worktree files, not main or poisoned target rules',()=>{
 const root=mkdtempSync(join(tmpdir(),'fleet-local-rules-')),af=join(root,'af'),repo=join(root,'repo'),target=join(root,'repo.worktree'),old=process.env.AF_SESSION_ROOTS;const git=(...args:string[])=>execFileSync('git',['-C',repo,...args],{env:sessionGitEnv(),stdio:'pipe'});
 try{
  mkdirSync(join(af,'.ai/rules'),{recursive:true});mkdirSync(join(af,'.pi'));mkdirSync(repo);git('init');git('-c','user.name=Fixture','-c','user.email=f@example.test','-c','commit.gpgsign=false','commit','--allow-empty','-m','initial');git('worktree','add','--detach',target);
  const ruleText='# Placement\nNew source files must be placed under src/new.\n',rulePath='.ai/rules/placement.md';writeFileSync(join(af,rulePath),ruleText);
  mkdirSync(join(target,'.ai/rules'),{recursive:true});writeFileSync(join(target,rulePath),'# Placement\nPOISON TARGET RULE\n');
  const document={version:2,mode:'auto',provider:'typesafe',model:'jev-1.13.0',apiKeyEnv:'TYPESAFE_API_KEY',consumers:{proactiveReview:{mode:'shadow',remoteContext:'disabled',include:['src/**'],localBindings:[{version:1,validator:'new-file-placement',rule:{path:rulePath,heading:'Placement',occurrence:1,hash:createHash('sha256').update(ruleText).digest('hex')},applicability:{paths:['src/**'],kinds:['added']},exceptions:{paths:[],legacy:true},placement:{prefix:'src/new'}}]}}};
  const raw=JSON.stringify(document);writeFileSync(join(af,'.ai/system1.json'),raw);writeFileSync(join(af,'.pi/damage-control-rules.yaml'),JSON.stringify({bashToolPatterns:[],zeroAccessPaths:[],readOnlyPaths:[],noDeletePaths:[]}));
  process.env.AF_SESSION_ROOTS=JSON.stringify(resolveSessionRoots(af,{worktree:target}));
  const roots=resolvePolicyRoots(target,{rulesDirs:['.ai/rules']},af),config=loadProactiveConfig(target,undefined,roots),catalog=discoverRules(target,['.ai/rules'],roots);
  assert.equal(config.remoteContext,'disabled');assert.equal(config.mode,'shadow');assert.deepEqual(config.localBindings,document.consumers.proactiveReview.localBindings);assert.equal(catalog.files.length,1);assert.equal(catalog.sections[0].text.includes('POISON'),false);
  const baseline=beginTurnCore({root:target,config,turnId:'session:hub:direct:1',context:{task:{path:'task',revision:'r',hash:'r'},rules:catalog.files,exceptions:[]}});assert.ok(baseline);
  mkdirSync(join(repo,'src'));writeFileSync(join(repo,'src/outside.ts'),'MAIN CHECKOUT');mkdirSync(join(target,'src'));writeFileSync(join(target,'src/outside.ts'),'TARGET CHANGE');
  const snapshot=finishTurnCore(baseline!);assert.ok(snapshot);assert.ok(snapshot!.units.some(unit=>unit.path==='src/outside.ts'));assert.ok(!JSON.stringify(snapshot).includes('MAIN CHECKOUT'));
  const local=assessLocal(snapshot!,catalog.sections,config.localBindings!,undefined,roots);assert.equal(local.findings.length,1);assert.equal(readFileSync(join(repo,'src/outside.ts'),'utf8'),'MAIN CHECKOUT');assert.equal(readFileSync(join(af,'.ai/system1.json'),'utf8'),raw);
  const binding=resolveSessionRoots(af,{worktree:target});assert.equal(snapshot!.targetId,binding.targetId);assert.equal(snapshot!.workspaceRoot,af);assert.equal(snapshot!.executionRoot,target);
  const unit=snapshot!.units.find(unit=>unit.path==='src/outside.ts')!;assert.match(readSnapshotUnit(snapshot!,snapshot!.snapshotId,unit.id,unit.after!.hash)!,/TARGET CHANGE/);
  process.env.AF_SESSION_ROOTS=JSON.stringify(resolveSessionRoots(af,{worktree:repo}));assert.equal(readSnapshotUnit(snapshot!,snapshot!.snapshotId,unit.id,unit.after!.hash),null);assert.equal(finishTurnCore(baseline!),null);
 }finally{if(old===undefined)delete process.env.AF_SESSION_ROOTS;else process.env.AF_SESSION_ROOTS=old;rmSync(root,{recursive:true,force:true});}
});
