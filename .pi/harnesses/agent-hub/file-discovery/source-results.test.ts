import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync,readdirSync,statSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {parseFileDiscoveryConfig} from '../../lib/system1/config-file-discovery.js';
import {createDiscoverySources,rankCandidates} from './sources.ts';import {createResult,writeResultPages,readResultPage} from './results.ts';
import {currentFileAccessAllowed} from '../../lib/damage-control-shared.ts';
import {sourceHash} from '../agentic-sources.ts';import {safeSourceRead} from '../../lib/safe-source-read.js';
import type {System1Service} from '../../lib/system1/contracts.ts';
function fixture(){const root=mkdtempSync(join(tmpdir(),'d9-sources-'));mkdirSync(join(root,'docs'));return root;}
const config=parseFileDiscoveryConfig({mode:'active',remoteContextApproved:true,include:['docs']});
const signal=()=>new AbortController().signal;
const service:System1Service={evaluate:async r=>({status:'ok',evaluation:{answers:[{questionId:'d9_relevance',type:'ordinal',value:0,levels:['unrelated','supporting','directly relevant','primary'],uncertainty:{provenance:'provider',confidence:0.1}},{questionId:'d9_role',type:'choice',value:'documentation',uncertainty:{provenance:'provider'}}],metadata:{provider:'fake',requestedModel:'fake',returnedModel:'fake',attempts:1,latencyMs:0,questionSetVersion:r.questionSetVersion}}})};
test('real guarded Unicode sources; current permission, hash, alias, secret, binary, oversized and symlink fences',async()=>{
 const root=fixture();try{
  const path=join(root,'docs/code');writeFileSync(path,'Български evidence');let allowed=true;
  const collect=createDiscoverySources({root,config,canRead:()=>allowed});const source=await collect('docs/code',signal());assert.equal(source.text,'Български evidence');assert.equal(await source.current(),true);
  allowed=false;assert.equal(await source.current(),false);await assert.rejects(collect('docs/code',signal()),/source_denied/);allowed=true;
  writeFileSync(path,'changed');assert.equal(await source.current(),false);
  for(const body of ['password=abc',Buffer.from([0xff]),Buffer.from([0]),'a'.repeat(65537)]){
   writeFileSync(path,body);await assert.rejects(collect('docs/code',signal()));
  }
  symlinkSync('/etc/passwd',join(root,'docs/link'));for(const p of ['docs/link','docs/../docs/code','docs/key.pem'])await assert.rejects(collect(p,signal()));
  writeFileSync(path,'before');const raced=createDiscoverySources({root,config,canRead:()=>true,read:async(root,paths,max)=>paths.map(p=>safeSourceRead(root,p,max,()=>{},()=>writeFileSync(p,'after')))});
  await assert.rejects(raced('docs/code',signal()),/source_changed/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('all low, failed, denied, oversized, changed and unevaluated rows retained without bodies; hidden metadata only aggregate',async()=>{
 const root=fixture();try{
  for(const [p,b] of Object.entries({low:'PRIVATE BODY LOW',fail:'PRIVATE BODY FAIL',denied:'PRIVATE BODY DENIED',large:'a'.repeat(65537),changed:'before',hidden:'private'}))writeFileSync(join(root,'docs',p),b);
  const mixed:System1Service={evaluate:async r=>{const path=(r.state as any).source.path;if(path==='docs/fail')return {status:'unavailable',reason:'network'};if(path==='docs/changed')writeFileSync(join(root,path),'after');return service.evaluate(r);}};
  const ranked=await rankCandidates({root,config,paths:['docs/low','docs/fail','docs/denied','docs/large','docs/changed','docs/hidden','docs/low'],task:'task',service:mixed,signal:signal(),canDisplay:p=>!p.endsWith('hidden'),canRead:p=>!p.endsWith('denied')});
  assert.equal(ranked.hidden,1);assert.equal(ranked.rows.length,5);const map=Object.fromEntries(ranked.rows.map(r=>[r.path,r]));assert.equal(map['docs/low'].relevance,0);
  for(const [p,reason] of [['fail','network'],['denied','denied'],['large','oversized'],['changed','changed']])assert.equal(map['docs/'+p].reason,reason);
  const result=createResult({...ranked,identity:{taskHash:sourceHash('task'),queryHash:sourceHash('query'),model:'fake'},discoveryComplete:true});assert.equal(result.rows[0].path,'docs/low');assert.equal(JSON.stringify(result).includes('PRIVATE BODY'),false);
  const limited=await rankCandidates({root,config:{...config,limits:{...config.limits,maxEvaluationsPerJob:1}},paths:['docs/low','docs/fail'],task:'task',service,signal:signal(),canDisplay:()=>true});assert.equal(limited.rows.length,2);assert.equal(limited.rows[1].reason,'not_evaluated');
  const aborted=new AbortController();aborted.abort();const cancelled=await rankCandidates({root,config,paths:['docs/low'],task:'task',service,signal:aborted.signal,canDisplay:()=>true});assert.equal(cancelled.rows[0].reason,'cancelled');
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('current zeroAccess and revoked metadata refuse before read/export and preserve only allowed aggregates',async()=>{
 const root=fixture();try{
  writeFileSync(join(root,'docs/private'),'private');mkdirSync(join(root,'.pi'));writeFileSync(join(root,'.pi/damage-control-rules.yaml'),'zeroAccessPaths:\n  - docs/private\n');let reads=0,calls=0;
  const rows=await rankCandidates({root,config,paths:['docs/private'],task:'task',signal:signal(),canDisplay:()=>true,read:async()=>{reads++;return [];},service:{evaluate:async()=>{calls++;return {status:'cancelled'};}}});
  assert.equal(rows.rows[0].reason,'denied');assert.equal(reads,0);assert.equal(calls,0);assert.equal(currentFileAccessAllowed(root,join(root,'docs/private')),false);
  writeFileSync(join(root,'docs/public'),'body');let display=true;
  const revoked=await rankCandidates({root,config,paths:['docs/public'],task:'task',signal:signal(),canDisplay:()=>display,service:{evaluate:async r=>{display=false;return service.evaluate(r);}}});assert.equal(revoked.rows.length,0);assert.equal(revoked.hidden,1);
  const allFailed=createResult({rows:rows.rows,identity:{taskHash:sourceHash('task'),queryHash:sourceHash('query'),model:'fake'},discoveryComplete:true});assert.equal(allFailed.status,'unavailable');
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('more than 255 full-list rows, deterministic separate bounded chained pages and identity/hash tamper checks',()=>{
 const root=fixture();try{
  const rows=Array.from({length:600},(_,i)=>({path:`docs/${i===0?'__proto__':i===1?'constructor':String(i).padStart(4,'0')}`,status:'scored' as const,relevance:i%4,role:'test',hash:sourceHash(String(i)),text:'RAW BODY'}));
  const result=createResult({rows,identity:{taskHash:sourceHash('task'),queryHash:sourceHash('query'),model:'fake'},discoveryComplete:false});assert.equal(result.remaining,'unknown');assert.equal(result.status,'partial');assert.equal(JSON.stringify(result).includes('RAW BODY'),false);
  const first=writeResultPages(root,result,2048);let locator:any=first;const delivered:any[]=[];let pages=0;
  while(locator){assert.ok(statSync(locator.path).size<=2048);const page=readResultPage(root,locator,2048);assert.equal(page.offset,delivered.length);assert.equal(page.total,600);delivered.push(...page.rows);locator=page.next;pages++;}
  assert.ok(pages>1);assert.deepEqual(delivered,result.rows);assert.equal(readdirSync(join(root,'file-discovery-'+result.resultId)).length,pages);
  assert.throws(()=>createResult({rows:[rows[0],rows[0]],identity:result,discoveryComplete:true}),/duplicate_identity/);
  assert.throws(()=>readResultPage(root,{...first,pageIndex:1},2048),/artifact_denied/);
  const body=JSON.stringify({...readResultPage(root,first,2048),pageIndex:1});writeFileSync(first.path,body);assert.throws(()=>readResultPage(root,{...first,hash:sourceHash(body)},2048),/page_identity/);
  writeFileSync(first.path,'tamper');assert.throws(()=>readResultPage(root,first,2048),/page_changed/);
  assert.throws(()=>writeResultPages(root,{...result,resultId:'00000000-0000-0000-0000-000000000000'},100),/result_page_too_small/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('C1 finding 1 publication rechecks earlier scored and hashed rows after later evaluation revokes read or export',async()=>{
 for(const revoke of ['read','policy','export']){
  const root=fixture();const local={...config,include:[...config.include]};let readable=true;
  try{
   for(const p of ['a','b'])writeFileSync(join(root,'docs',p),'PRIVATE BODY '+p);
   const ranked=await rankCandidates({root,config:local,paths:['docs/a','docs/b'],task:'task',signal:signal(),canDisplay:()=>true,...(revoke==='policy'?{}:{canRead:(p:string)=>!p.endsWith('/a')||readable}),service:{evaluate:async r=>{
    if((r.state as any).source.path==='docs/b'){
     if(revoke==='export')local.include.splice(0);
     else if(revoke==='policy'){mkdirSync(join(root,'.pi'));writeFileSync(join(root,'.pi/damage-control-rules.yaml'),'zeroAccessPaths:\n  - docs/a\n');}
     else readable=false;
    }
    return service.evaluate(r);
   }}});
   assert.deepEqual(ranked.rows.find(r=>r.path==='docs/a'),{path:'docs/a',status:'unscored',reason:'denied'},revoke);
  }finally{rmSync(root,{recursive:true,force:true});}
 }
 // Even a failed evaluation's retained source hash must be stripped on revocation.
 const root=fixture();let readable=true;try{
  for(const p of ['a','b'])writeFileSync(join(root,'docs',p),'body');
  const ranked=await rankCandidates({root,config,paths:['docs/a','docs/b'],task:'task',signal:signal(),canDisplay:()=>true,canRead:p=>!p.endsWith('/a')||readable,service:{evaluate:async r=>{if((r.state as any).source.path==='docs/b')readable=false;return {status:'unavailable',reason:'network'};}}});
  assert.deepEqual(ranked.rows[0],{path:'docs/a',status:'unscored',reason:'denied'});
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('N4 page locators are bound to trusted managed root, result directory and page index with symlink fencing',()=>{
 const root=fixture(),foreign=fixture();try{
  const result=createResult({rows:[{path:'docs/a',status:'unscored',reason:'denied'}],identity:{taskHash:sourceHash('task'),queryHash:sourceHash('query'),model:'fake'},discoveryComplete:true});
  const locator=writeResultPages(root,result,2048),body=readResultPage(root,locator,2048);
  const other=writeResultPages(foreign,result,2048);
  assert.equal(other.hash,locator.hash);assert.throws(()=>readResultPage(root,other,2048),/artifact_denied/);
  const arbitrary=join(root,'arbitrary.json');writeFileSync(arbitrary,JSON.stringify(body));assert.throws(()=>readResultPage(root,{...locator,path:arbitrary},2048),/artifact_denied/);
  for(const pageIndex of [-1,0.5,NaN,1])assert.throws(()=>readResultPage(root,{...locator,pageIndex},2048),/artifact_denied/);
  assert.throws(()=>readResultPage(root,{...locator,path:join(root,'file-discovery-'+result.resultId,'page-01.json')},2048),/artifact_denied/);
  rmSync(locator.path);symlinkSync(other.path,locator.path);assert.throws(()=>readResultPage(root,locator,2048),/source_denied/);
  rmSync(join(root,'file-discovery-'+result.resultId),{recursive:true});symlinkSync(join(foreign,'file-discovery-'+result.resultId),join(root,'file-discovery-'+result.resultId));assert.throws(()=>readResultPage(root,locator,2048),/source_denied/);
 }finally{rmSync(root,{recursive:true,force:true});rmSync(foreign,{recursive:true,force:true});}
});
test('N5 consumer off and unapproved only rows report skipped; failures and cancellation remain distinct',()=>{
 const identity={taskHash:sourceHash('task'),queryHash:sourceHash('query'),model:'fake'};
 for(const reasons of [['consumer_off'],['not_approved'],['consumer_off','not_approved']])assert.equal(createResult({rows:reasons.map((reason,i)=>({path:'docs/'+i,status:'unscored',reason})),identity,discoveryComplete:true}).status,'skipped');
 assert.equal(createResult({rows:[{path:'docs/a',status:'unscored',reason:'network'}],identity,discoveryComplete:true}).status,'unavailable');
 assert.equal(createResult({rows:[{path:'docs/a',status:'unscored',reason:'consumer_off'}],identity,discoveryComplete:true,cancelled:true}).status,'cancelled');
});
