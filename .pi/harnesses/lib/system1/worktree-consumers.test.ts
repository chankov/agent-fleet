import {canonicalMkdtempSync as mkdtempSync} from '../../../../bin/test/helpers/test-temp.js';
import assert from 'node:assert/strict';
import {describe,it,before,after} from 'node:test';
import {mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {resolveSessionRoots,sessionGitEnv} from '../workspace-context.ts';
import {CONSUMERS} from './config-v2.js';
import {loadSystem1Snapshot,readSystem1Document} from './config-loader.js';
import {approveWorktreeScope} from './worktree-scopes.ts';
import {worktreeConsumerService} from './worktree-service.ts';
import {createAgenticSources} from '../../agent-hub/agentic-sources.ts';
import {currentFileAccessAllowed} from '../damage-control-shared.ts';

// Each consumer keeps the fast lane's 30s test deadline. The suite shares one
// physical Git fixture, but must not inherit a single 30s budget for all eight
// consumers: on macOS the aggregate takes ~40s under four-worker contention.
describe('per-consumer worktree consent and real selected source',{timeout:120000,concurrency:false},()=>{
 let root:string,af:string,repo:string,target:string,file:string,raw:string;
 let services:Record<string,any>;
 const states:unknown[]=[];
 const old=process.env.AF_SESSION_ROOTS;
 const request=(state:string)=>({state,questions:[],questionSetVersion:'fixture'});
 const git=(...args:string[])=>execFileSync('git',['-C',repo,...args],{env:sessionGitEnv(),stdio:'pipe'});
 before(()=>{
  root=mkdtempSync(join(tmpdir(),'fleet-consumers-'));af=join(root,'af');repo=join(root,'repo');target=join(root,'repo.worktree');
  mkdirSync(join(af,'.ai'),{recursive:true});mkdirSync(join(af,'.pi'));mkdirSync(join(repo,'src'),{recursive:true});
  git('init');writeFileSync(join(repo,'src/sentinel.ts'),'MAIN_SENTINEL\n');git('add','.');git('-c','user.name=Fixture','-c','user.email=f@example.test','-c','commit.gpgsign=false','commit','-m','initial');git('worktree','add','--detach',target);writeFileSync(join(target,'src/sentinel.ts'),'TARGET_SENTINEL\n');
  const document=JSON.parse(readFileSync(new URL('../../../../docs/system1.example.json',import.meta.url),'utf8'));
  document.mode='auto';document.consumers.watchdog.mode='shadow';
  Object.assign(document.consumers.proactiveReview,{mode:'advisory',remoteContext:'selected-excerpts',include:['src/**'],maxEvaluationsPerSession:20});
  Object.assign(document.consumers.dispatchTriage,{mode:'advisory',remoteContextApproved:true});
  Object.assign(document.consumers.taskTriage,{mode:'experimental',remoteContextApproved:true});
  Object.assign(document.consumers.agenticAsk,{mode:'recommended',remoteContextApproved:true,include:['git:tracked']});
  Object.assign(document.consumers.fileDiscovery,{mode:'active',remoteContextApproved:true});document.consumers.fileDiscovery.semanticReads.mode='active';
  Object.assign(document.consumers.contextCompaction,{mode:'automatic',remoteContextApproved:true});
  Object.assign(document.consumers.damageGuard,{mode:'active',remoteScopes:{commands:true,edits:true,results:true}});
  raw=JSON.stringify(document);file=join(af,'.ai/system1.json');writeFileSync(file,raw);
  writeFileSync(join(af,'.pi/damage-control-rules.yaml'),JSON.stringify({bashToolPatterns:[],zeroAccessPaths:[],readOnlyPaths:[],noDeletePaths:[]}));
  process.env.AF_SESSION_ROOTS=JSON.stringify(resolveSessionRoots(af,{worktree:target}));
  const provider={async evaluate(input:any){states.push(input.state);return {status:'cancelled'};}};
  services=Object.fromEntries(CONSUMERS.map(name=>[name,worktreeConsumerService(provider,document,name)!]));
 },{timeout:30000});
 after(()=>{
  if(old===undefined)delete process.env.AF_SESSION_ROOTS;else process.env.AF_SESSION_ROOTS=old;
  if(root)rmSync(root,{recursive:true,force:true});
 });
 for(const name of CONSUMERS){
  it(`${name}: its own approval is required before any provider export`,{timeout:30000},async()=>{
   const previous=states.length;
   assert.equal(loadSystem1Snapshot(target).consumers[name].reason,'needs_worktree_consent',name);
   assert.equal((await services[name].evaluate(request('WORKTREE_METADATA'))).status,'unavailable');
   assert.equal(states.length,previous,'other consumers approvals cannot authorize this export');
   assert.equal((await approveWorktreeScope({consumer:name,readDocument:()=>readSystem1Document(target),ask:async()=>true})).status,'approved',name);
   assert.equal(loadSystem1Snapshot(target).consumers[name].status,'ready',name);
   let state='WORKTREE_METADATA';
   if(name==='agenticAsk'){
    const config=loadSystem1Snapshot(target).consumers.agenticAsk.config;
    const collect=createAgenticSources({root:target,config:config as any,canRead:path=>currentFileAccessAllowed(target,path)});
    const bundle=await collect({paths:[{path:'src/sentinel.ts'}]} as any,new AbortController().signal);
    assert.equal(bundle.sources[0].text,'TARGET_SENTINEL\n');state=JSON.stringify(bundle.sources);
   }
   await services[name].evaluate(request(state));
   assert.equal(states.length,previous+1,'exactly one approved provider call');
   assert.ok(!JSON.stringify(states).includes('MAIN_SENTINEL'));
   assert.equal(readFileSync(file,'utf8'),raw);
  });
 }
 it('off mode blocks every previously approved consumer without changing the approved scope',{timeout:30000},async()=>{
  assert.equal(states.length,CONSUMERS.length);assert.ok(JSON.stringify(states).includes('TARGET_SENTINEL'));assert.ok(!JSON.stringify(states).includes('MAIN_SENTINEL'));
  const document=JSON.parse(raw);writeFileSync(file,JSON.stringify({...document,mode:'off'}));
  for(const name of CONSUMERS)assert.equal((await services[name].evaluate(request('NO_EXPORT'))).status,'unavailable');
  assert.equal(states.length,CONSUMERS.length);
 });
});
