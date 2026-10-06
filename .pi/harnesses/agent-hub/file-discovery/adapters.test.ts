import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync} from 'node:fs';import {join,dirname} from 'node:path';import {tmpdir} from 'node:os';import {fileURLToPath} from 'node:url';
import {adaptDiscovery,PINNED_PI_VERSION} from './adapters.ts';import {runPiFind} from './discovery.ts';import {inventory} from '../deterministic-fs.ts';
const entry=import.meta.resolve('@earendil-works/pi-coding-agent');
const {createLsToolDefinition}=await import(new URL('./core/tools/ls.js',entry).href);
const {createGrepToolDefinition}=await import(new URL('./core/tools/grep.js',entry).href);
function fixture(){const root=mkdtempSync(join(tmpdir(),'d9-adapters-'));mkdirSync(join(root,'docs/sub'),{recursive:true});writeFileSync(join(root,'docs/a.ts'),'first\nneedle\nthird\n');writeFileSync(join(root,'docs/sub/b.ts'),'needle');return root;}
const sig=new AbortController().signal;
test('actual pinned Pi 0.84.2 find and ls schemas: search root, directories, limits and exact notices',async()=>{
 assert.equal(JSON.parse(readFileSync(new URL('../package.json',entry),'utf8')).version,PINNED_PI_VERSION);
 const root=fixture();try{
  const args={path:'docs',pattern:'**',limit:100};const run=await runPiFind({cwd:root,args,signal:sig});assert.equal(run.ok,true,JSON.stringify(run));if(!run.ok)return;
  const find=adaptDiscovery({tool:'find',args,result:run.result,cwd:root,root,include:['docs']});assert.deepEqual(find.paths,['docs/a.ts','docs/sub/b.ts']);assert.equal(find.discoveryComplete,true);
  const lsResult=await createLsToolDefinition(root).execute('ls',{path:'docs'},sig);const ls=adaptDiscovery({tool:'ls',args,result:lsResult,cwd:root,root,include:['docs']});assert.deepEqual(ls.paths,['docs/a.ts']);
  const limited=await createLsToolDefinition(root).execute('ls',{path:'docs',limit:1},sig);const partial=adaptDiscovery({tool:'ls',args,result:limited,cwd:root,root,include:['docs']});assert.equal(partial.discoveryComplete,false);assert.equal(partial.remaining,'unknown');assert.equal(partial.paths.length,1);
  const capped=await runPiFind({cwd:root,args:{...args,limit:1},signal:sig});assert.equal(capped.ok,true);if(capped.ok)assert.equal(adaptDiscovery({tool:'find',args,result:capped.result,cwd:root,root,include:['docs']}).discoveryComplete,false);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('actual Pi grep matches, context, single-file root, match/line truncation preserved without rewriting evidence',async()=>{
 const previous=process.env.PI_OFFLINE;process.env.PI_OFFLINE='1';const root=fixture();try{
  const args={path:'docs',pattern:'needle',context:1,limit:1};const result=await createGrepToolDefinition(root).execute('grep',args,sig);const before=JSON.stringify(result);
  const adapted=adaptDiscovery({tool:'grep',args,result,cwd:root,root,include:['docs']});assert.equal(adapted.paths.length,1);assert.equal(adapted.discoveryComplete,false);assert.equal(JSON.stringify(result),before);
  const singleArgs={path:'docs/a.ts',pattern:'needle'};const single=await createGrepToolDefinition(root).execute('grep',singleArgs,sig);assert.deepEqual(adaptDiscovery({tool:'grep',args:singleArgs,result:single,cwd:root,root,include:['docs']}).paths,['docs/a.ts']);
  writeFileSync(join(root,'docs/a.ts'),'needle '+'x'.repeat(1000));const long=await createGrepToolDefinition(root).execute('grep',singleArgs,sig);assert.equal(long.details.linesTruncated,true);assert.deepEqual(adaptDiscovery({tool:'grep',args:singleArgs,result:long,cwd:root,root,include:['docs']}).paths,['docs/a.ts']);
 }finally{if(previous===undefined)delete process.env.PI_OFFLINE;else process.env.PI_OFFLINE=previous;rmSync(root,{recursive:true,force:true});}
});
test('real filesystem inventory schema; strict unknown, ambiguity, escape and version failures',()=>{
 const root=fixture();try{
  const value=inventory({root:join(root,'docs'),pageSize:1});const result={content:[{type:'text',text:JSON.stringify(value)}],details:{result:value}};
  const opts={args:{path:'docs',operation:'inventory'},result,cwd:root,root,include:['docs']};const inv=adaptDiscovery({...opts,tool:'filesystem'});assert.deepEqual(inv.paths,['docs/a.ts']);assert.equal(inv.discoveryComplete,false);
  for(const [tool,result] of [['bash',{content:[{type:'text',text:'a.ts'}]}],['find',{content:[{type:'text',text:'../a.ts'}]}],['find',{content:[{type:'text',text:'a.ts'}],details:{newSchema:true}}],['grep',{content:[{type:'text',text:'a.ts:not-a-line: needle'}]}]])assert.equal(adaptDiscovery({...opts,tool:tool as string,result}).discoveryComplete,false);
  assert.equal(adaptDiscovery({...opts,tool:'find',piVersion:'future'}).reason,'unsupported_pi_version');
  const plain={content:[{type:'text',text:'a.ts'}]};writeFileSync(join(root,'docs/ a.ts'),'ambiguous');assert.equal(adaptDiscovery({...opts,tool:'find',result:plain}).reason,'ambiguous_filename');
  assert.equal(adaptDiscovery({...opts,args:{path:'..'},tool:'find',result:plain}).paths.length,0);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('actual pinned Pi byte truncation retains every available full-line identity, no fabricated completion',async()=>{
 const root=fixture();try{
  for(let i=0;i<240;i++)writeFileSync(join(root,'docs',String(i).padStart(3,'0')+'x'.repeat(230)+'.ts'),'a');
  const result=await createLsToolDefinition(root).execute('large-ls',{path:'docs'},sig);
  assert.equal(result.details.truncation.truncated,true);assert.ok(result.content[0].text.endsWith('[50.0KB limit reached]'));
  const adapted=adaptDiscovery({tool:'ls',args:{path:'docs'},result,cwd:root,root,include:['docs']});
  const available=result.content[0].text.split('\n\n[')[0].split('\n').filter((p:string)=>!p.endsWith('/'));
  assert.deepEqual(adapted.paths,available.map((p:string)=>'docs/'+p).sort());assert.ok(adapted.paths.length>200);assert.equal(adapted.discoveryComplete,false);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('N8 ambiguous grep context containing match delimiters is explicitly refused without rewriting evidence',async()=>{
 const root=fixture();try{
  writeFileSync(join(root,'docs/a.ts'),'context :2: looks like a match\nneedle\nthird\n');
  const args={path:'docs/a.ts',pattern:'needle',context:1};const result=await createGrepToolDefinition(root).execute('grep',args,sig);const before=JSON.stringify(result);
  const adapted=adaptDiscovery({tool:'grep',args,result,cwd:root,root,include:['docs']});assert.equal(adapted.reason,'ambiguous_filename');assert.equal(adapted.discoveryComplete,false);assert.deepEqual(adapted.paths,[]);assert.equal(JSON.stringify(result),before);
  const matchOnly={content:[{type:'text',text:'a.ts:2: text has -3- context markers'}]};assert.deepEqual(adaptDiscovery({tool:'grep',args,result:matchOnly,cwd:root,root,include:['docs']}).paths,['docs/a.ts']);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('N2 strict traversal adapter counts forbidden and out-of-include regular files only as exclusions',()=>{
 const root=fixture();try{
  writeFileSync(join(root,'docs/key.pem'),'secret');
  const adapted=adaptDiscovery({tool:'find',args:{path:'docs'},result:{content:[{type:'text',text:'a.ts\nkey.pem\nsub/\nsub/b.ts'}]},cwd:root,root,include:['docs/sub']});
  assert.deepEqual(adapted.paths,['docs/sub/b.ts']);assert.equal(adapted.excluded,2);assert.equal(adapted.discoveryComplete,true);assert.equal(JSON.stringify(adapted).includes('key.pem'),false);
 }finally{rmSync(root,{recursive:true,force:true});}
});
