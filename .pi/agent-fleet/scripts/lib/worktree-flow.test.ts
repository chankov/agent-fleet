import {canonicalMkdtempSync as mkdtempSync} from '../../../../bin/test/helpers/test-temp.js';
import assert from 'node:assert/strict';import {test} from 'node:test';import {mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, copyFileSync, chmodSync} from 'node:fs';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {execFileSync,spawnSync} from 'node:child_process';
import {resolveSessionRoots,targetProject,sessionGitEnv,withSessionRoots,sessionRootsFromEnv} from '../../../harnesses/lib/workspace-context.ts';import {buildSnapshot,parseSnapshot,assertSnapshotTarget} from './team-snapshot.ts';import {parseFlowCommand,parseFlowMaintenanceCommand} from './flow-command.ts';import {Run} from '../workflows/lib/run.ts';
import {FlowTrace} from '../workflows/lib/trace.ts';
const source=resolve(new URL('../../../../',import.meta.url).pathname);
// This is a multi-process scenario (seven CLI launches, each bounded to 20s),
// not one unit operation. Keep its aggregate test budget separate from defaults.
test('external-target flow CLI, quality, branch/list metadata, snapshots and late acceptance stay bound to the selected checkout',{timeout:90000},async()=>{
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

// Plan 7.5 (D9): a workspace whose root is a plain folder holding repositories, like rankedin.
test('a flow at a non-Git workspace root runs only inside the nested repository --worktree selects',{timeout:90000},async()=>{
 const root=mkdtempSync(join(tmpdir(),'fleet-nested-flow-'));const git=(cwd:string,...args:string[])=>execFileSync('git',['-C',cwd,...args],{env:sessionGitEnv(),stdio:'pipe'}).toString().trim();
 const cli=(...args:string[])=>spawnSync(process.execPath,['--import',join(source,'bin/test/helpers/system1-no-network.js'),join(source,'.pi/agent-fleet/scripts/flow.ts'),...args],{cwd:root,encoding:'utf8',env:{...process.env,AF_SESSION_ROOTS:undefined,AF_TARGET_BASE_PROJECT:undefined,AF_TARGET_EFFECTIVE_PROJECT:undefined,PI_OFFLINE:'1'},timeout:20000});
 try{
  for(const name of ['rin-docs','ringithub']){const repo=join(root,name);mkdirSync(repo);git(repo,'init','-q');writeFileSync(join(repo,'marker'),name);git(repo,'add','.');git(repo,'-c','user.name=Fixture','-c','user.email=f@example.test','-c','commit.gpgsign=false','commit','-qm','initial');}
  mkdirSync(join(root,'.ai'));writeFileSync(join(root,'.ai/agent-fleet-overrides.md'),`## workflows\nquality: ${process.execPath} -e "console.log('workspace '+process.cwd())"\nquality.ringithub: ${process.execPath} -e "console.log('ringithub '+process.cwd())"\n`);
  const unselected=cli('quality','--allow-dirty','--run-id','unselected');assert.equal(unselected.status,3,unselected.stderr);assert.match(unselected.stderr,/workspace root is not a Git repository[\s\S]*--worktree <path>/);assert.equal(existsSync(join(root,'.pi/flow-sessions')),false);
  const listing=cli('cleanup');assert.equal(listing.status,3,listing.stderr);assert.match(listing.stderr,/Flow cleanup refused: the workspace root is not a Git repository[\s\S]*just flow cleanup --worktree <repository>/);
  const ran=cli('quality','--worktree','ringithub','--branch','--run-id','nested-quality');assert.equal(ran.status,0,ran.stderr);assert.match(ran.stdout+ran.stderr,/FLOW ACCEPTED/);
  const ringithub=resolveSessionRoots(root,{worktree:'ringithub'});const trace=join(root,'.pi/flow-sessions/targets',ringithub.targetId,'nested-quality');
  assert.match(readFileSync(join(trace,'command.log'),'utf8'),new RegExp(`ringithub ${join(root,'ringithub').replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\n`),'the repository key runs inside the selected repository');
  assert.equal(git(join(root,'ringithub'),'branch','--show-current'),'flow/quality-nested-quality');assert.equal(git(join(root,'ringithub'),'status','--porcelain'),'');
  assert.notEqual(git(join(root,'rin-docs'),'branch','--show-current'),'flow/quality-nested-quality','the other nested repository is untouched');
  const listed=cli('cleanup','--worktree','ringithub');assert.equal(listed.status,0,listed.stderr);assert.match(listed.stdout,/flow\/quality-nested-quality/);
  const docs=cli('cleanup','--worktree','rin-docs');assert.equal(docs.status,0,docs.stderr);assert.match(docs.stdout,/No local flow\/\* branches found/);
 }finally{rmSync(root,{recursive:true,force:true});}
});

// Plan 7 acceptance, end to end: build-test in the nested repository --worktree selects. Only
// the model is replaced, by a `pi` on PATH that edits its cwd and returns a build envelope; the
// flow CLI, persona, quality command, branch and commit are the installed ones.
test('build-test at a non-Git workspace root builds, verifies and commits inside one nested repository',{timeout:90000},async()=>{
 const root=mkdtempSync(join(tmpdir(),'fleet-nested-build-')),bin=mkdtempSync(join(tmpdir(),'fleet-fake-pi-')),calls=join(bin,'calls.jsonl');const git=(cwd:string,...args:string[])=>execFileSync('git',['-C',cwd,...args],{env:sessionGitEnv(),stdio:'pipe'}).toString().trim();
 const cli=(...args:string[])=>spawnSync(process.execPath,['--import',join(source,'bin/test/helpers/system1-no-network.js'),join(source,'.pi/agent-fleet/scripts/flow.ts'),...args],{cwd:root,encoding:'utf8',env:{...process.env,PATH:`${bin}:${process.env.PATH}`,FAKE_PI_CALLS:calls,AF_SESSION_ROOTS:undefined,AF_TARGET_BASE_PROJECT:undefined,AF_TARGET_EFFECTIVE_PROJECT:undefined,PI_OFFLINE:'1'},timeout:20000});
 try{
  // The flow commits in the repository, so each one carries its own identity: CI runners have none.
  for(const name of ['rin-docs','ringithub']){const repo=join(root,name);mkdirSync(repo);git(repo,'init','-q');for(const [key,value] of [['user.name','Fixture'],['user.email','f@example.test'],['commit.gpgsign','false']])git(repo,'config',key,value);writeFileSync(join(repo,'marker'),name);git(repo,'add','.');git(repo,'commit','-qm','initial');}
  // An installed workspace: Fleet resources at the root, never inside a nested repository.
  mkdirSync(join(root,'.ai'));mkdirSync(join(root,'.pi/agents/personas'),{recursive:true});
  copyFileSync(join(source,'agents/builder.md'),join(root,'.pi/agents/personas/builder.md'));copyFileSync(join(source,'.pi/damage-control-rules.yaml'),join(root,'.pi/damage-control-rules.yaml'));symlinkSync(join(source,'.pi/harnesses'),join(root,'.pi/harnesses'));
  writeFileSync(join(root,'.ai/agent-fleet-overrides.md'),`## workflows\nquality: ${process.execPath} -e "process.exit(1)"\nquality.ringithub: ${process.execPath} -e "require('fs').accessSync('feature.txt')"\n`);
  writeFileSync(join(bin,'pi'),`#!${process.execPath}\nconst fs=require('node:fs');fs.appendFileSync(process.env.FAKE_PI_CALLS,JSON.stringify({cwd:process.cwd()})+'\\n');fs.writeFileSync('feature.txt','built\\n');\nconst report=JSON.stringify({status:'success',summary:'Feature built',artifacts:[],notes_for_next_agent:'',changed_files:['feature.txt'],commit_message:'feat: add the feature'});\nprocess.stdout.write(JSON.stringify({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:report}})+'\\n');\n`);chmodSync(join(bin,'pi'),0o755);
  const ringithub=join(root,'ringithub'),before=git(ringithub,'rev-parse','HEAD'),docsHead=git(join(root,'rin-docs'),'rev-parse','HEAD');
  for(const [args,status,message] of [[['--worktree','rin-docs','--worktree','ringithub'],2,/Duplicate --worktree/],[['--worktree','rin-docs,ringithub'],3,/rin-docs,ringithub/]] as const){
   const refused=cli('build-test',...args,'--branch','--run-id','two-repositories','add the feature');assert.equal(refused.status,status,refused.stderr);assert.match(refused.stderr,message);
  }
  assert.equal(existsSync(calls),false,'a flow over two repositories never starts the builder');
  const built=cli('build-test','--worktree','ringithub','--branch','--run-id','nested-build','add the feature');assert.equal(built.status,0,built.stdout+built.stderr);assert.match(built.stdout+built.stderr,/FLOW ACCEPTED/);
  assert.deepEqual(readFileSync(calls,'utf8').trim().split('\n').map(line=>JSON.parse(line).cwd),[ringithub],'the builder ran once, inside ringithub');
  assert.equal(git(ringithub,'branch','--show-current'),'flow/build-test-nested-build');assert.equal(git(ringithub,'rev-parse','HEAD~1'),before);
  assert.equal(git(ringithub,'log','-1','--format=%s'),'feat: add the feature');assert.equal(git(ringithub,'show','--name-only','--format=','HEAD'),'feature.txt');assert.equal(git(ringithub,'status','--porcelain'),'');
  const trace=join(root,'.pi/flow-sessions/targets',resolveSessionRoots(root,{worktree:'ringithub'}).targetId,'nested-build');assert.ok(existsSync(join(trace,'trace.jsonl')),'the trace stays at the workspace root');
  assert.equal(git(join(root,'rin-docs'),'rev-parse','HEAD'),docsHead);assert.equal(existsSync(join(root,'rin-docs/feature.txt')),false,'the other nested repository is untouched');
 }finally{rmSync(root,{recursive:true,force:true});rmSync(bin,{recursive:true,force:true});}
});
