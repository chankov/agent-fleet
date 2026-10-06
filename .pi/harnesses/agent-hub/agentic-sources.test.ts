import test from 'node:test';import assert from 'node:assert/strict';import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {createAgenticSources,exportPathAllowed} from './agentic-sources.ts';import {safeSourceRead} from '../lib/safe-source-read.js';import {currentFileAccessAllowed} from '../lib/damage-control-shared.ts';
import {createAgenticRuntime} from './agentic-runtime.ts';import {parseAgenticConfig} from '../lib/system1/config-agentic.js';
const input={questions:[{id:'q',type:'predicate' as const,instructions:'Classify'}],paths:[{path:'docs/code.ts',startLine:2,endLine:2}]};
function fixture(){const root=mkdtempSync(join(tmpdir(),'agentic-sources-'));mkdirSync(join(root,'docs'));writeFileSync(join(root,'docs/code.ts'),'one\nБългарски\nthree\n');return root;}
test('ranges, metadata-only response, hashes and changed sources',async()=>{
 const root=fixture();try{const config=parseAgenticConfig({mode:'advisory',remoteContextApproved:true,include:['docs']});const collect=createAgenticSources({root,config,canRead:()=>true});const c=await collect(input,new AbortController().signal);assert.equal(c.sources[0].text,'Български');assert.equal(c.sources[0].summary.totalLines,3);assert.equal(await c.current(),true);
 let payload:any;const runtime=createAgenticRuntime({config,sessionId:'s',context:()=> 't',persist(){},collect,service:{evaluate:async req=>{payload=req;return {status:'unavailable',reason:'auth'};}}});const result=await runtime.evaluate(input);assert.equal(payload.state.sources[0].text,'Български');assert.equal(JSON.stringify(result).includes('Български'),false);
 writeFileSync(join(root,'docs/code.ts'),'changed');assert.equal(await c.current(),false);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('zeroAccess denies before content read despite export include',async()=>{
 const root=fixture();try{mkdirSync(join(root,'.pi'));writeFileSync(join(root,'.pi/damage-control-rules.yaml'),'zeroAccessPaths:\n  - docs/private.txt\n');writeFileSync(join(root,'docs/private.txt'),'private');let reads=0,calls=0;
 const config=parseAgenticConfig({mode:'advisory',remoteContextApproved:true,include:['docs']});const collect=createAgenticSources({root,config,canRead:p=>currentFileAccessAllowed(root,p),read:async()=>{reads++;return [];}});
 const runtime=createAgenticRuntime({config,sessionId:'s',context:()=> 't',persist(){},collect,service:{evaluate:async()=>{calls++;return {status:'cancelled'};}}});const result=await runtime.evaluate({...input,paths:[{path:'docs/private.txt'}]});assert.equal((result as any).reason,'source_denied');assert.equal(reads,0);assert.equal(calls,0);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('fences, UTF8, caps and concurrent changes refuse without truncation',async()=>{
 const root=fixture();try{const path=join(root,'docs/code.ts');assert.throws(()=>safeSourceRead(root,path,1),/state_too_large/);assert.throws(()=>safeSourceRead(root,path,65536,()=>{},()=>writeFileSync(path,'new')),/source_changed/);
 writeFileSync(path,Buffer.from([0xff]));assert.throws(()=>safeSourceRead(root,path,65536),/source_denied/);symlinkSync('/etc/passwd',join(root,'docs/link'));assert.throws(()=>safeSourceRead(root,join(root,'docs/link'),65536),/source_denied/);
 for(const p of ['../x','.env','.git/config','.pi/agent-sessions/x','.ai/system1.json','docs/key.pem'])assert.equal(exportPathAllowed(p,['docs','.pi','.ai']),false);
 assert.equal(exportPathAllowed('.pi/harnesses/source.ts',['.pi/harnesses']),true);
 const config=parseAgenticConfig({mode:'advisory',remoteContextApproved:true,include:['docs']});writeFileSync(path,'password=abc');await assert.rejects(createAgenticSources({root,config,canRead:()=>true})({...input,paths:[{path:'docs/code.ts'}]},new AbortController().signal),/source_denied/);
 }finally{rmSync(root,{recursive:true,force:true});}
});

function git(root:string,...args:string[]){return execFileSync('git',args,{cwd:root,env:Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_')))});}
function trackedFixture(){const root=fixture();git(root,'init','-q');git(root,'add','--','docs/code.ts');return root;}
const gitConfig=()=>parseAgenticConfig({mode:'advisory',remoteContextApproved:true,include:['git:tracked']});
test('git:tracked allows indexed files across roots and rechecks index membership',async()=>{
 const root=trackedFixture();try{
 const path='.pi/agent-fleet/scripts/lib/claude-bridge-core.ts';mkdirSync(join(root,'.pi/agent-fleet/scripts/lib'),{recursive:true});writeFileSync(join(root,path),'bridge\n');git(root,'add','--',path);
 const collect=createAgenticSources({root,config:gitConfig(),canRead:()=>true});
 const c=await collect({...input,paths:[{path}]},new AbortController().signal);assert.equal(c.sources[0].text,'bridge\n');assert.equal(await c.current(),true);
 git(root,'rm','--cached','--',path);assert.equal(await c.current(),false);
 // Untracked -> indexed is discovered dynamically; no initial inventory cache.
 git(root,'add','--',path);assert.equal((await collect({...input,paths:[{path}]},new AbortController().signal)).sources.length,1);
 writeFileSync(join(root,'docs/code.ts'),'working tree edit\n');const changed=await collect({...input,paths:[{path:'docs/code.ts'}]},new AbortController().signal);assert.equal(changed.sources[0].text,'working tree edit\n');
 assert.equal(exportPathAllowed(path,['git:tracked']),false); // Other consumers do not resolve Git selectors.
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('git:tracked runtime exports tracked code and marks mid-inference index removal stale',async()=>{
 const root=trackedFixture();try{
 const config=gitConfig();let calls=0;
 const runtime=createAgenticRuntime({config,sessionId:'s',context:()=> 't',persist(){},collect:createAgenticSources({root,config,canRead:()=>true}),service:{evaluate:async req=>{
  calls++;assert.equal((req.state as any).sources[0].text,'Български');
  if(calls===2)git(root,'rm','--cached','--','docs/code.ts');
  return {status:'ok',evaluation:{answers:[],metadata:{provider:'fake',requestedModel:'fake',returnedModel:'fake',questionSetVersion:'agentic-ask/v1',latencyMs:0,attempts:1}}};
 }}});
 assert.equal((await runtime.evaluate(input)).status,'ok');const stale=await runtime.evaluate(input);assert.equal(stale.status,'stale');assert.equal((stale as any).reason,'source_changed');assert.equal(calls,2);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('git:tracked denies untracked and ignored files before content reads or provider calls',async()=>{
 const root=trackedFixture();try{
 writeFileSync(join(root,'docs/new.ts'),'new');writeFileSync(join(root,'.gitignore'),'docs/ignored.ts\n');writeFileSync(join(root,'docs/ignored.ts'),'ignored');
 let reads=0,calls=0;const config=gitConfig();const collect=createAgenticSources({root,config,canRead:()=>true,read:async()=>{reads++;return [];}});
 const runtime=createAgenticRuntime({config,sessionId:'s',context:()=> 't',persist(){},collect,service:{evaluate:async()=>{calls++;return {status:'cancelled'};}}});
 for(const path of ['docs/new.ts','docs/ignored.ts']){const result=await runtime.evaluate({...input,paths:[{path}]});assert.equal((result as any).reason,'source_denied');assert.deepEqual(result.sourceSummary,[]);}
 assert.equal(reads,0);assert.equal(calls,0);assert.equal(runtime.calls,0);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('git:tracked preserves sensitive-path, secret, symlink and local-access guards',async()=>{
 const root=trackedFixture();try{
 mkdirSync(join(root,'.ai'));writeFileSync(join(root,'.ai/config.json'),'safe');writeFileSync(join(root,'.env'),'safe');writeFileSync(join(root,'docs/key.pem'),'safe');symlinkSync('code.ts',join(root,'docs/link.ts'));
 git(root,'add','-f','--','.ai/config.json','.env','docs/key.pem','docs/link.ts');
 const config=gitConfig();let reads=0;const collect=createAgenticSources({root,config,canRead:()=>true,read:async()=>{reads++;return [];}});
 for(const path of ['.ai/config.json','.env','docs/key.pem','docs/link.ts'])await assert.rejects(collect({...input,paths:[{path}]},new AbortController().signal),/source_denied/);
 assert.equal(reads,0);
 await assert.rejects(createAgenticSources({root,config,canRead:()=>false,read:async()=>{reads++;return [];}})(input,new AbortController().signal),/source_denied/);assert.equal(reads,0);
 writeFileSync(join(root,'docs/code.ts'),'password=abc');await assert.rejects(createAgenticSources({root,config,canRead:()=>true})(input,new AbortController().signal),/source_denied/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('git:tracked composes as a union with explicit prefixes',async()=>{
 const root=trackedFixture();try{
 writeFileSync(join(root,'docs/new.ts'),'untracked');
 const config=parseAgenticConfig({mode:'advisory',remoteContextApproved:true,include:['git:tracked','docs']});
 assert.equal((await createAgenticSources({root,config,canRead:()=>true})({...input,paths:[{path:'docs/new.ts'}]},new AbortController().signal)).sources[0].text,'untracked');
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('git:tracked supports linked worktree roots and ignores inherited Git index overrides',async()=>{
 const root=trackedFixture(),worktree=root+'-linked',other=trackedFixture(),prior=process.env.GIT_INDEX_FILE;try{
 git(root,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','fixture');git(root,'worktree','add','-q','--detach',worktree);
 writeFileSync(join(other,'docs/untracked.ts'),'indexed elsewhere');git(other,'add','--','docs/untracked.ts');
 process.env.GIT_INDEX_FILE=join(other,'.git/index');
 const c=await createAgenticSources({root:worktree,config:gitConfig(),canRead:()=>true})(input,new AbortController().signal);assert.equal(c.sources[0].text,'Български');assert.equal(await c.current(),true);
 writeFileSync(join(worktree,'docs/untracked.ts'),'untracked');await assert.rejects(createAgenticSources({root:worktree,config:gitConfig(),canRead:()=>true})({...input,paths:[{path:'docs/untracked.ts'}]},new AbortController().signal),/source_denied/);
 }finally{if(prior===undefined)delete process.env.GIT_INDEX_FILE;else process.env.GIT_INDEX_FILE=prior;rmSync(root,{recursive:true,force:true});rmSync(worktree,{recursive:true,force:true});rmSync(other,{recursive:true,force:true});}
});
test('git:tracked uses literal pathspecs and fails closed outside a repository root',async()=>{
 const root=trackedFixture(),plain=fixture();try{
 const config=gitConfig(),collect=createAgenticSources({root,config,canRead:()=>true});
 for(const path of ['docs/[code].ts','docs/:magic.ts','--file.ts','docs/Български.ts']){writeFileSync(join(root,path),'literal');git(root,'add','--',path);assert.equal((await collect({...input,paths:[{path}]},new AbortController().signal)).sources[0].text,'literal');}
 await assert.rejects(createAgenticSources({root:plain,config,canRead:()=>true})(input,new AbortController().signal),/source_denied/);
 await assert.rejects(createAgenticSources({root:join(root,'docs'),config,canRead:()=>true})({...input,paths:[{path:'code.ts'}]},new AbortController().signal),/source_denied/);
 const controller=new AbortController();controller.abort();await assert.rejects(collect(input,controller.signal),/cancelled/);
 }finally{rmSync(root,{recursive:true,force:true});rmSync(plain,{recursive:true,force:true});}
});

test('whole request framing overflows refuse before transport and corrupt policy is fail-closed',async()=>{
 const root=fixture();try{
 const config=parseAgenticConfig({mode:'advisory',remoteContextApproved:true,include:['docs']});
 writeFileSync(join(root,'docs/a'),'a'.repeat(65536));writeFileSync(join(root,'docs/b'),'б'.repeat(32768));
 let calls=0;const runtime=createAgenticRuntime({config,sessionId:'s',context:()=> 't',persist(){},collect:createAgenticSources({root,config,canRead:()=>true}),service:{evaluate:async()=>{calls++;return {status:'cancelled'};}}});
 const result=await runtime.evaluate({questions:input.questions,paths:[{path:'docs/a'},{path:'docs/b'}]});assert.equal((result as any).reason,'state_too_large');assert.ok(result.breakdown!.total>config.limits.maxRequestBytes);assert.ok(result.breakdown!.framing>0);assert.equal(calls,0);assert.equal(runtime.calls,0);
 mkdirSync(join(root,'.pi'));for(const yaml of ['[]','zeroAccessPaths: 5','zeroAccessPaths: [5]','[invalid:']){writeFileSync(join(root,'.pi/damage-control-rules.yaml'),yaml);assert.equal(currentFileAccessAllowed(root,join(root,'docs/a')),false);}
 }finally{rmSync(root,{recursive:true,force:true});}
});
