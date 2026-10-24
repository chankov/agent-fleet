import {canonicalMkdtempSync as mkdtempSync} from '../../../../bin/test/helpers/test-temp.js';
import assert from 'node:assert/strict';import {test} from 'node:test';import {mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync} from 'node:fs';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {execFileSync,spawnSync} from 'node:child_process';
import {resolveSessionRoots,targetProject,sessionGitEnv,withSessionRoots,sessionRootsFromEnv} from '../../../harnesses/lib/workspace-context.ts';import {buildSnapshot,parseSnapshot,assertSnapshotTarget} from './team-snapshot.ts';import {parseFlowCommand,parseFlowMaintenanceCommand} from './flow-command.ts';import {Run} from '../workflows/lib/run.ts';
import {FlowTrace} from '../workflows/lib/trace.ts';
const source=resolve(new URL('../../../../',import.meta.url).pathname);
test('external-target flow CLI, quality, branch/list metadata, snapshots and late acceptance stay bound to the selected checkout',async()=>{
 const root=mkdtempSync(join(tmpdir(),'fleet-target-flow-')),af=join(root,'af config'),repo=join(root,'repo'),target=join(root,'repo worktree');const git=(cwd:string,...args:string[])=>execFileSync('git',['-C',cwd,...args],{env:sessionGitEnv(),stdio:'pipe'}).toString().trim();
 const cli=(...args:string[])=>spawnSync(process.execPath,['--import',join(source,'bin/test/helpers/system1-no-network.js'),join(source,'.pi/agent-fleet/scripts/flow.ts'),...args],{cwd:af,encoding:'utf8',env:{...process.env,AF_SESSION_ROOTS:undefined,AF_TARGET_BASE_PROJECT:undefined,AF_TARGET_EFFECTIVE_PROJECT:undefined,PI_OFFLINE:'1'},timeout:20000});
 try{
  mkdirSync(join(af,'.ai'),{recursive:true});mkdirSync(repo);git(repo,'init');writeFileSync(join(repo,'marker'),'MAIN');git(repo,'add','.');git(repo,'-c','user.name=Fixture','-c','user.email=f@example.test','-c','commit.gpgsign=false','commit','-m','initial');const mainHead=git(repo,'rev-parse','HEAD'),mainBranch=git(repo,'branch','--show-current');git(repo,'worktree','add','--detach',target);writeFileSync(join(target,'marker'),'TARGET');
  writeFileSync(join(af,'.ai/agent-fleet-overrides.md'),`## workflows\nquality: ${process.execPath} -e "console.log(process.cwd())"\n`);
  const selected=resolveSessionRoots(af,{worktree:'../repo worktree'});
  const parsed=parseFlowCommand(['quality','--worktree','../repo worktree','--dry-run']);assert.equal(parsed.selection?.worktree,'../repo worktree');assert.equal(parsed.branch??false,false);
  const maintenance=parseFlowMaintenanceCommand(['merge','flow/scout-example','--target','main','--worktree','../repo worktree','--yes']);assert.equal(maintenance.target,'main');assert.equal(maintenance.selection?.worktree,'../repo worktree');
  assert.equal(cli('quality','--worktree','missing').status,3);assert.equal(cli('quality','--worktree').status,2);
  const dirty=cli('quality','--worktree','../repo worktree','--run-id','refused');assert.equal(dirty.status,3,dirty.stderr);assert.equal(existsSync(join(af,'.pi/flow-sessions')),false);assert.equal(existsSync(join(target,'.pi')),false);
  const done=cli('quality','--worktree','../repo worktree','--allow-dirty','--run-id','target-quality');assert.equal(done.status,0,done.stderr);assert.match(done.stdout+done.stderr,/FLOW ACCEPTED/);
  const state=join(af,'.pi/flow-sessions/targets',selected.targetId,'target-quality');assert.equal(JSON.parse(readFileSync(join(state,'trace.jsonl'),'utf8').split('\n')[0]).sessionTarget.executionRoot,target);assert.match(readFileSync(join(state,'command.log'),'utf8'),new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));assert.equal(existsSync(join(target,'.pi')),false);
  const branchRun=cli('quality','--worktree','../repo worktree','--allow-dirty','--branch','--dry-run','--run-id','selected-branch');assert.equal(branchRun.status,0,branchRun.stderr);assert.equal(git(target,'branch','--show-current'),'flow/quality-selected-branch');assert.equal(git(repo,'branch','--show-current'),mainBranch);assert.equal(git(repo,'rev-parse','HEAD'),mainHead);assert.equal(readFileSync(join(repo,'marker'),'utf8'),'MAIN');
  const listed=cli('cleanup','--worktree','../repo worktree');assert.equal(listed.status,0,listed.stderr);assert.match(listed.stdout,/flow\/quality-selected-branch/);assert.equal(git(target,'branch','--show-current'),'flow/quality-selected-branch');
  const snapshot=buildSnapshot({team:'review',project:targetProject('same',selected),hub:true,peers:[{name:'review',persona:'review',model:'fixture-model'}],panes:[],agents:[],sessionRoots:selected,baseProject:'same'});
  const loaded=parseSnapshot(JSON.stringify(snapshot));assertSnapshotTarget(loaded,selected);assert.throws(()=>assertSnapshotTarget(loaded),/snapshot_target_mismatch/);assert.throws(()=>assertSnapshotTarget(loaded,resolveSessionRoots(af,{worktree:repo})),/snapshot_target_mismatch/);assert.throws(()=>assertSnapshotTarget({...loaded,sessionRoots:undefined},selected),/unbound_snapshot/);
  const legacy=parseSnapshot(JSON.stringify({version:1,team:'review',hub:false,peers:[{name:'review',persona:'review',model:'fixture-model',resume:null}],workspace_label:'peers-review'}));assertSnapshotTarget(legacy);assert.equal(legacy.project,'default');
  const other=resolveSessionRoots(af,{worktree:repo});const before=sessionRootsFromEnv();await Promise.all([withSessionRoots(selected,async()=>{await new Promise(resolve=>setTimeout(resolve,5));assert.equal(sessionRootsFromEnv()!.targetId,selected.targetId);}),withSessionRoots(other,async()=>{await new Promise(resolve=>setTimeout(resolve,1));assert.equal(sessionRootsFromEnv()!.targetId,other.targetId);})]);assert.deepEqual(sessionRootsFromEnv(),before);
  await withSessionRoots(selected,async()=>{const run=new Run({cwd:target,runId:'late'});await withSessionRoots(other,async()=>{const result=run.finish({accepted:true});assert.equal(result.accepted,false);assert.equal(result.reason,'flow_target_changed');});});
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('targeted trace accepts a physical workspace alias but refuses an alias escaping storage',async()=>{
 const root=mkdtempSync(join(tmpdir(),'fleet-trace-alias-')),af=join(root,'af'),repo=join(root,'repo'),alias=join(root,'af-alias'),outside=join(root,'outside'),escape=join(root,'outside-alias');
 const git=(...args:string[])=>execFileSync('git',['-C',repo,...args],{env:sessionGitEnv(),stdio:'pipe'});
 try{
  mkdirSync(af);mkdirSync(repo);mkdirSync(outside);git('init');git('-c','user.name=Fixture','-c','user.email=f@example.test','-c','commit.gpgsign=false','commit','--allow-empty','-m','fixture');symlinkSync(af,alias,'dir');symlinkSync(outside,escape,'dir');
  await withSessionRoots(resolveSessionRoots(af,{worktree:repo}),async()=>{
   const trace=new FlowTrace({cwd:repo,runId:'aliased',directory:join(alias,'.pi/flow-sessions/aliased')});assert.equal(trace.directory,join(af,'.pi/flow-sessions/aliased'));assert.equal(trace.events()[0].type,'run_start');
   assert.throws(()=>new FlowTrace({cwd:repo,directory:join(escape,'.pi/forbidden')}),/flow_trace_outside_workspace/);assert.equal(existsSync(join(outside,'.pi')),false);
   symlinkSync(outside,join(af,'.pi/escaped'),'dir');assert.throws(()=>new FlowTrace({cwd:repo,directory:join(af,'.pi/escaped/forbidden')}),/flow_trace_outside_workspace/);assert.equal(existsSync(join(outside,'forbidden')),false);
  });
 }finally{rmSync(root,{recursive:true,force:true});}
});
