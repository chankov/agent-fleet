import assert from 'node:assert/strict';import {test} from 'node:test';import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {execFileSync} from 'node:child_process';
import {resolveSessionRoots,sessionGitEnv} from '../../../harnesses/lib/workspace-context.ts';import {peerTarget,targetPaneEnv,bindTargetLayout} from './peer-target.ts';
test('all pane runners inherit the selected target, af recipes, and a target-specific namespace',()=>{
 const root=mkdtempSync(join(tmpdir(),'fleet-peer-target-')),af=join(root,'af'),repo=join(root,'repo'),target=join(root,'repo.worktree'),old=process.env.AF_SESSION_ROOTS;
 const git=(...args:string[])=>execFileSync('git',['-C',repo,...args],{env:sessionGitEnv(),stdio:'pipe'});
 try{
  mkdirSync(af);mkdirSync(repo);git('init');git('-c','user.name=Fixture','-c','user.email=f@example.test','-c','commit.gpgsign=false','commit','--allow-empty','-m','initial');git('worktree','add','--detach',target);
  process.env.AF_SESSION_ROOTS=JSON.stringify(resolveSessionRoots(af,{worktree:target}));const context=peerTarget('same')!;
  const layout:any={type:'split',direction:'right',first:{type:'pane',label:'hub',command:['just','fleet','--agents','frontend','--project',context.project],cwd:af},second:{type:'split',direction:'down',first:{type:'pane',label:'review',command:['just','_claude-peer','review'],env:{EXPLICIT_PEER:'preserved'}},second:{type:'pane',label:'hermes',command:['hermes','-p','dev'],env:{MONITOR_SCOPE:'explicit'}}}};
  const bound:any=bindTargetLayout(layout,context);
  const panes=[bound.first,bound.second.first,bound.second.second];for(const pane of panes){assert.equal(pane.cwd,target);assert.equal(JSON.parse(pane.env.AF_SESSION_ROOTS).targetId,context.roots.targetId);assert.equal(pane.env.AF_TARGET_BASE_PROJECT,'same');assert.equal(pane.env.AF_TARGET_EFFECTIVE_PROJECT,context.project);}
  assert.deepEqual(bound.first.command.slice(0,5),['just','--justfile',join(af,'justfile'),'--working-directory',af]);assert.equal(bound.second.first.env.EXPLICIT_PEER,'preserved');assert.deepEqual(bound.second.second.command,['hermes','-p','dev']);
  assert.throws(()=>targetPaneEnv({AF_SESSION_ROOTS:'{}'},context.roots,'same',context.project),/context_override/);assert.throws(()=>targetPaneEnv({GIT_WORK_TREE:repo},context.roots,'same',context.project),/context_override/);
  assert.equal(peerTarget(context.project,'same')!.project,context.project);
  process.env.AF_SESSION_ROOTS=JSON.stringify(resolveSessionRoots(af,{worktree:repo}));assert.notEqual(peerTarget('same')!.project,context.project);
  delete process.env.AF_SESSION_ROOTS;assert.equal(bindTargetLayout(layout,undefined),layout);
 }finally{if(old===undefined)delete process.env.AF_SESSION_ROOTS;else process.env.AF_SESSION_ROOTS=old;rmSync(root,{recursive:true,force:true});}
});
