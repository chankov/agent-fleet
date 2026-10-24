import assert from 'node:assert/strict';import {test} from 'node:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {isolatedFleetTestEnv} from './helpers/test-environment.js';
import {inspectPiRuntime,resolvePiTestRuntime} from './helpers/pi-runtime.js';
const put=(file,text)=>{mkdirSync(join(file,'..'),{recursive:true});writeFileSync(file,text);};
function sdk(root,version='1.1.0'){put(join(root,'package.json'),JSON.stringify({name:'@earendil-works/pi-coding-agent',version,exports:{'.':{import:'./dist/index.js'}}}));put(join(root,'dist/index.js'),'export {};');put(join(root,'dist/bundle/cli.js'),'// fixture, never executed');return root;}
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'af-sdk-resolution-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;}
test('Pi test runtime prefers the pinned repository ESM dependency, not PATH/global version',t=>{
 const dir=fixture(t),repo=join(dir,'repo'),dependency=sdk(join(dir,'sdk')),managed=join(dir,'managed');put(join(repo,'package.json'),JSON.stringify({devDependencies:{'@earendil-works/pi-coding-agent':'1.1.0'}}));mkdirSync(join(repo,'node_modules/@earendil-works'),{recursive:true});symlinkSync(dependency,join(repo,'node_modules/@earendil-works/pi-coding-agent'),'dir');put(join(managed,'current-version'),'1.4.0');sdk(join(managed,'releases/1.4.0/node_modules/@earendil-works/pi-coding-agent'),'1.4.0');
 const result=resolvePiTestRuntime({root:repo,env:{PI_MANAGED_INSTALL_ROOT:managed}});assert.equal(result.root,dependency);assert.equal(result.version,'1.1.0');assert.equal(result.source,'repository_dependency');
 put(join(dependency,'package.json'),JSON.stringify({name:'@earendil-works/pi-coding-agent',version:'1.4.0'}));assert.throws(()=>resolvePiTestRuntime({root:repo,env:{}}),/SDK mismatch/);
});
test('explicit SDK override is authoritative, and invalid explicit override never silently falls back',t=>{
 const dir=fixture(t),external=sdk(join(dir,'external'),'1.3.0');const result=resolvePiTestRuntime({env:{CONTEXT_CONTINUITY_PI_RUNTIME:external}});assert.equal(result.version,'1.3.0');assert.equal(result.source,'explicit');assert.throws(()=>resolvePiTestRuntime({env:{CONTEXT_CONTINUITY_PI_RUNTIME:join(dir,'absent'),PI_MANAGED_INSTALL_ROOT:dir}}));
});
test('managed fallback reads package metadata rather than mistaking a release label for SDK version',t=>{
 const dir=fixture(t);put(join(dir,'current-version'),'release-label');const actual=sdk(join(dir,'releases/release-label/node_modules/@earendil-works/pi-coding-agent'),'1.1.0');assert.equal(resolvePiTestRuntime({env:{PI_MANAGED_INSTALL_ROOT:dir}}).root,actual);assert.equal(resolvePiTestRuntime({env:{PI_MANAGED_INSTALL_ROOT:dir}}).version,'1.1.0');put(join(dir,'current-version'),'../escape');assert.throws(()=>resolvePiTestRuntime({env:{PI_MANAGED_INSTALL_ROOT:dir}}),/Invalid managed/);
});
test('test subprocesses cannot borrow parent roles, roots or access exemptions',()=>{
 const base={PATH:'/fixture',HOME:'/fixture/home',NODE_OPTIONS:'--fixture-guard',AGENT_HUB_EXEMPTIONS_FILE:'/parent/grants',AGENT_HUB_AGENT_ID:'reviewer',AGENT_HUB_CONTEXT_CHANNEL:'parent-token',AF_SESSION_ROOTS:'parent-roots',AF_TARGET_BASE_PROJECT:'parent',AF_TARGET_EFFECTIVE_PROJECT:'parent-target'};
 assert.deepEqual(isolatedFleetTestEnv(base),{PATH:base.PATH,HOME:base.HOME,NODE_OPTIONS:base.NODE_OPTIONS});assert.equal(base.AGENT_HUB_EXEMPTIONS_FILE,'/parent/grants');
});
test('missing bundled CLI, foreign package and unavailable SDK are explicit test failures',t=>{
 const dir=fixture(t);put(join(dir,'package.json'),JSON.stringify({name:'foreign',version:'1.1.0'}));assert.throws(()=>inspectPiRuntime(dir),/Invalid Pi/);put(join(dir,'package.json'),JSON.stringify({name:'@earendil-works/pi-coding-agent',version:'1.1.0'}));assert.throws(()=>inspectPiRuntime(dir),/bundled CLI missing/);assert.throws(()=>resolvePiTestRuntime({env:{PI_MANAGED_INSTALL_ROOT:join(dir,'empty')}}),/SDK unavailable/);
});
