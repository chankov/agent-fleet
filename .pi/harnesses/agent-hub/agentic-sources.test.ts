import test from 'node:test';import assert from 'node:assert/strict';
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

test('whole request framing overflows refuse before transport and corrupt policy is fail-closed',async()=>{
 const root=fixture();try{
 const config=parseAgenticConfig({mode:'advisory',remoteContextApproved:true,include:['docs']});
 writeFileSync(join(root,'docs/a'),'a'.repeat(65536));writeFileSync(join(root,'docs/b'),'б'.repeat(32768));
 let calls=0;const runtime=createAgenticRuntime({config,sessionId:'s',context:()=> 't',persist(){},collect:createAgenticSources({root,config,canRead:()=>true}),service:{evaluate:async()=>{calls++;return {status:'cancelled'};}}});
 const result=await runtime.evaluate({questions:input.questions,paths:[{path:'docs/a'},{path:'docs/b'}]});assert.equal((result as any).reason,'state_too_large');assert.ok(result.breakdown!.total>config.limits.maxRequestBytes);assert.ok(result.breakdown!.framing>0);assert.equal(calls,0);assert.equal(runtime.calls,0);
 mkdirSync(join(root,'.pi'));for(const yaml of ['[]','zeroAccessPaths: 5','zeroAccessPaths: [5]','[invalid:']){writeFileSync(join(root,'.pi/damage-control-rules.yaml'),yaml);assert.equal(currentFileAccessAllowed(root,join(root,'docs/a')),false);}
 }finally{rmSync(root,{recursive:true,force:true});}
});
