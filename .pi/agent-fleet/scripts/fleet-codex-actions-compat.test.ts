// B1 only: synthetic fixtures on owned temp roots; NEVER the real native journal.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { AllowedSessionsStore } from './lib/fleet-codex-allowlist-store.ts';
import { InstructionBridge } from './lib/fleet-codex-instructions.ts';
import type { RegistryReader } from './lib/fleet-codex-readonly.ts';
import { ActionLedger, InstructionLedger, intentDigest } from './lib/fleet-codex-instruction-store.ts';
const c={hostProfile:'fixture',principal:'owner',threadId:'fixture-A'};
const t={project:'fixture',peer:'orchestrator',sessionId:'S1',startedAt:'2026-01-01T00:00:00.000Z'};
const sha=(v:string)=>createHash('sha256').update(v).digest('hex');
const wire=(id:string)=>sha(JSON.stringify([JSON.stringify(Object.values(c)),id]));
function fixture(fn:(root:string)=>void){const root=fs.mkdtempSync(join(tmpdir(),'s6b-b1-'));try{fn(root);}finally{fs.rmSync(root,{recursive:true,force:true});}}
function old(root:string){
 const path=join(root,sha(JSON.stringify(Object.values(c)))+'.json');
 // Explicit synthetic copy of the protected shape; not copied/read from live state.
 const receipt={operation:'instruction' as const,requestId:'S6A_NATIVE_20261030_01',target:t,digest:intentDigest(t,'fixture-only'),wireId:wire('S6A_NATIVE_20261030_01'),state:'result' as const,attempted:true,createdAt:'2026-01-01T00:00:00.001Z',updatedAt:'2026-01-01T00:00:00.002Z',detail:null,result:'S6A_NATIVE_ACK_20261030_01',truncated:false};
 const state={format:'fleet-instruction-intents',version:1,storeId:'11111111-1111-4111-8111-111111111111',namespace:c,revision:7,records:[receipt]};
 const raw=JSON.stringify(state);fs.writeFileSync(path,raw,{mode:0o600});fs.writeFileSync(path+'.marker','v1:'+state.storeId,{mode:0o600});return{path,raw,receipt};
}
const question=(id='q-action')=>({operation:'answer' as const,requestId:id,target:t,questionId:'Q1',toolCallId:'TC1',questionDigest:sha('snapshot'),digest:sha('payload')});
const code=(expected:string)=>(e:unknown)=>!!e&&typeof e==='object'&&'code'in e&&e.code===expected;
test('B1 v1 is exact read-only history; prepare writable check has no mutation',()=>fixture(root=>{
 const f=old(root),l=new ActionLedger(root);assert.deepEqual(l.lookup(c,f.receipt.requestId),f.receipt);
 assert.throws(()=>l.assertWritable(c),code('INTENT_FORMAT_UPGRADE_REQUIRED'));
 assert.throws(()=>l.reserve(c,{requestId:'new',target:t,digest:sha('new')}),code('INTENT_FORMAT_UPGRADE_REQUIRED'));
 assert.equal(fs.readFileSync(f.path,'utf8'),f.raw);assert.equal(fs.readdirSync(root).length,2);
}));
test('B1 explicit fixture upgrade preserves ALL old values/marker/raw backup and facade',()=>fixture(root=>{
 const f=old(root),l=new ActionLedger(root);const p=l.previewUpgrade(c);assert.equal(p.sourceSha256,sha(f.raw));
 l.upgradeV1(c,p);assert.deepEqual(new InstructionLedger(root).lookup(c,f.receipt.requestId),f.receipt);
 const state=JSON.parse(fs.readFileSync(f.path,'utf8'));assert.equal(state.version,2);assert.equal(state.revision,8);
 assert.deepEqual(state.records[0],{receipt:f.receipt,authorization:null});
 assert.equal(fs.readFileSync(join(root,state.upgrade.backupName),'utf8'),f.raw);
 assert.equal(fs.readFileSync(f.path+'.marker','utf8'),'v1:11111111-1111-4111-8111-111111111111');
 assert.throws(()=>l.upgradeV1(c,p),code('INTENT_STATE_CHANGED'));
}));
test('B1 upgrade CAS mismatch refuses without backup or source rewrite',()=>fixture(root=>{
 const f=old(root),l=new ActionLedger(root),p=l.previewUpgrade(c);
 assert.throws(()=>l.upgradeV1(c,{...p,sourceSha256:sha('wrong')}),code('INTENT_STATE_CHANGED'));
 assert.equal(fs.readFileSync(f.path,'utf8'),f.raw);assert.equal(fs.readdirSync(root).length,2);
}));
test('B1 common index conflicts across operations, target, question and payload; restart dedup',()=>fixture(root=>{
 const l=new ActionLedger(root),q=question();const first=l.reserveAction(c,q,{alias:'fixture',policyRevision:2});assert.equal(first.created,true);
 assert.equal(new ActionLedger(root).reserveAction(c,q,{alias:'fixture',policyRevision:2}).created,false);
 assert.throws(()=>l.reserve(c,{requestId:q.requestId,target:t,digest:q.digest}),code('INTENT_CONFLICT'));
 for(const change of [{operation:'refusal'},{toolCallId:'TC2'},{digest:sha('different')},{target:{...t,sessionId:'S2'}}]) assert.throws(()=>l.reserveAction(c,{...q,...change} as typeof q,{alias:'fixture',policyRevision:2}),code('INTENT_CONFLICT'));
 assert.throws(()=>l.lookup(c,q.requestId),code('INTENT_CONFLICT'));
 const other={...c,threadId:'fixture-B'};assert.equal(l.lookupAction(other,q.requestId),null);
}));
test('B1 sticky not_sent and durable attempt cannot be reset into a resend',()=>fixture(root=>{
 const l=new ActionLedger(root);l.reserveAction(c,question(),{alias:'f',policyRevision:1});
 l.recordAction(c,'q-action',{state:'not_sent',detail:'CANCELLED_BEFORE_ATTEMPT',result:null});
 l.recordAction(c,'q-action',{state:'unknown',detail:'TRANSPORT_UNCERTAIN',result:null});
 assert.throws(()=>l.markActionAttempt(c,'q-action'),code('INTENT_ALREADY_ATTEMPTED'));
 l.reserveAction(c,question('second'),{alias:'f',policyRevision:1});l.markActionAttempt(c,'second');
 assert.equal(l.recordAction(c,'second',{state:'not_sent',detail:'TRANSPORT_UNCERTAIN',result:null}).state,'unknown');
 assert.throws(()=>new ActionLedger(root).markActionAttempt(c,'second'),code('INTENT_ALREADY_ATTEMPTED'));
}));
test('B1 BUSY no steal, missing-after-marker and future schema fail closed',()=>fixture(root=>{
 const f=old(root),l=new ActionLedger(root),p=l.previewUpgrade(c);fs.writeFileSync(f.path+'.lock','owned',{mode:0o600});
 assert.throws(()=>l.upgradeV1(c,p),code('INTENT_BUSY'));assert.equal(fs.readFileSync(f.path+'.lock','utf8'),'owned');fs.unlinkSync(f.path+'.lock');
 const s=JSON.parse(f.raw);s.version=99;fs.writeFileSync(f.path,JSON.stringify(s));assert.throws(()=>new ActionLedger(root).lookupAction(c,'x'),code('INTENT_STATE_VERSION'));
 fs.unlinkSync(f.path);assert.throws(()=>new ActionLedger(root).lookupAction(c,'x'),code('INTENT_STATE_MISSING'));
}));
test('B1 capacity and malformed v2 cannot drop old dedup knowledge',()=>fixture(root=>{
 const l=new ActionLedger(root);for(let i=0;i<256;i++)l.reserveAction(c,question('capacity-'+i),{alias:'f',policyRevision:1});
 assert.throws(()=>l.reserveAction(c,question('overflow'),{alias:'f',policyRevision:1}),code('INTENT_LIMIT'));
 const path=join(root,sha(JSON.stringify(Object.values(c)))+'.json'),s=JSON.parse(fs.readFileSync(path,'utf8'));s.records[0].receipt.attempted=true;s.records[0].receipt.state='accepted';
 fs.writeFileSync(path,JSON.stringify(s));assert.throws(()=>new ActionLedger(root).lookupAction(c,'capacity-0'),code('INTENT_STATE_INVALID'));
}));
test('B1 foreign backup and before-rename failure never replace authoritative v1',()=>fixture(root=>{
 const f=old(root),l=new ActionLedger(root),p=l.previewUpgrade(c),backup=join(root,sha(JSON.stringify(Object.values(c)))+'.v1.'+sha(f.raw)+'.snapshot');fs.writeFileSync(backup,'wrong fixture',{mode:0o600});
 assert.throws(()=>l.upgradeV1(c,p),code('INTENT_STATE_CHANGED'));assert.equal(fs.readFileSync(f.path,'utf8'),f.raw);fs.unlinkSync(backup);
 const fault=new ActionLedger(root,{checkpoint:stage=>{if(stage==='beforeRename')throw Error('fixture only');}});
 assert.throws(()=>fault.upgradeV1(c,p),code('INTENT_IO_ERROR'));assert.equal(fs.readFileSync(f.path,'utf8'),f.raw);assert.equal(fs.readFileSync(backup,'utf8'),f.raw);
}));
test('B1 after-rename uncertainty never restores v1 or loses original history',()=>fixture(root=>{
 const f=old(root),l=new ActionLedger(root,{checkpoint:stage=>{if(stage==='afterRename')throw Error('fixture crash');}}),p=l.previewUpgrade(c);
 assert.throws(()=>l.upgradeV1(c,p),code('INTENT_COMMIT_UNCERTAIN'));
 assert.equal(JSON.parse(fs.readFileSync(f.path,'utf8')).version,2);assert.deepEqual(new ActionLedger(root).lookup(c,f.receipt.requestId),f.receipt);
}));
test('B1 actual instruction bridge keeps formulas/facade; v1 gates all new remote actions',async()=>{
 const root=fs.mkdtempSync(join(tmpdir(),'s6b-instruction-'));try{
  const policyRoot=join(root,'policy'),journal=policyRoot+'.instructions',store=new AllowedSessionsStore(policyRoot,c);await store.initialize();const h=await store.enroll({alias:'fixture',target:t},[t]);await store.grantSend(h,[t]);
  const at=Date.parse(t.startedAt)+60000;const reader:RegistryReader=async()=>({status:'complete',partial:false,reasons:[],observedAt:new Date(at).toISOString(),entriesSeen:1,candidates:[{target:t,heartbeatAt:new Date(at).toISOString(),presence:'fresh'}]});let calls=0;
  const transport={capability:async()=>{calls++;return true;},send:async(_t:typeof t,_wire:string,_text:string,o:{beforeWrite:()=>Promise<void>})=>{await o.beforeWrite();calls++;return {state:'result' as const,detail:null,result:'synthetic-result',truncated:false};},receipt:async()=>{calls++;return null;}};
  const bridge=new InstructionBridge({policyRoot,registryReader:reader,transport,now:()=>at});const p=await bridge.prepare(c,{requestId:'fresh-instruction',target:t,instruction:'fixture-only'});const result=await bridge.commit(c,p.proposalId as string);const r=result.receipt as {wireId:string;digest:string;result:string};assert.equal(r.wireId,wire('fresh-instruction'));assert.equal(r.digest,intentDigest(t,'fixture-only'));assert.equal(r.result,'synthetic-result');assert.equal(calls,2);
  // Separate synthetic v1 root; never downgrade a root that has v2 knowledge.
  const otherPolicy=join(root,'legacy-policy'),otherJournal=otherPolicy+'.instructions';fs.mkdirSync(otherJournal,{mode:0o700});const f=old(otherJournal);const legacy=new InstructionBridge({policyRoot:otherPolicy,registryReader:reader,transport,now:()=>at});
  assert.deepEqual((await legacy.prepare(c,{requestId:f.receipt.requestId,target:t,instruction:'fixture-only'})).receipt,f.receipt);
  await assert.rejects(()=>legacy.prepare(c,{requestId:'new',target:t,instruction:'fixture-only'}),/INTENT_FORMAT_UPGRADE_REQUIRED/);await assert.rejects(()=>legacy.receipt(c,{requestId:f.receipt.requestId,refresh:true}),/INTENT_FORMAT_UPGRADE_REQUIRED/);assert.equal(calls,2);
  assert.equal(JSON.parse(fs.readFileSync(join(journal,sha(JSON.stringify(Object.values(c)))+'.json'),'utf8')).records[0].authorization.policyRevision,2);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('B1 independent processes serialize on the SAME lock without lock stealing',async()=>{
 const root=fs.mkdtempSync(join(tmpdir(),'s6b-process-'));
 const module=new URL('./lib/fleet-codex-instruction-store.ts',import.meta.url).href;
 const script=`import {ActionLedger} from ${JSON.stringify(module)};new ActionLedger(process.argv[1],{checkpoint:s=>{if(s==='beforeRename'){process.send('locked');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,150);}}}).reserveAction(${JSON.stringify(c)},${JSON.stringify(question('child'))},{alias:'f',policyRevision:1});`;
 const child=spawn(process.execPath,['--input-type=module','-e',script,root],{stdio:['ignore','ignore','pipe','ipc']});let stderr='';child.stderr?.on('data',b=>stderr+=b.toString());const exit=once(child,'exit');try{await Promise.race([once(child,'message'),exit.then(()=>{throw Error('child exited before lock: '+stderr);})]);assert.throws(()=>new ActionLedger(root).reserveAction(c,question('parent'),{alias:'f',policyRevision:1}),code('INTENT_BUSY'));const [status]=await exit;assert.equal(status,0);assert.ok(new ActionLedger(root).lookupAction(c,'child'));assert.equal(new ActionLedger(root).lookupAction(c,'parent'),null);}finally{await exit;fs.rmSync(root,{recursive:true,force:true});}
});
test('B1 readback failure after rename is COMMIT_UNCERTAIN, never an apparent uncommitted failure',()=>fixture(root=>{
 const f=old(root),p=new ActionLedger(root).previewUpgrade(c),l=new ActionLedger(root,{checkpoint:stage=>{if(stage==='afterRename')fs.writeFileSync(f.path,'{}');}});assert.throws(()=>l.upgradeV1(c,p),code('INTENT_COMMIT_UNCERTAIN'));
}));
test('B1 question records require actual diagnostic guard metadata, not imported-null provenance',()=>fixture(root=>{
 const l=new ActionLedger(root);assert.throws(()=>l.reserveAction(c,question(),null),code('INTENT_INVALID'));
}));
