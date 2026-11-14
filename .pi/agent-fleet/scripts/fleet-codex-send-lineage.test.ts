import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,chmodSync,unlinkSync,symlinkSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {physicalTempRoot} from '../../../bin/test/helpers/test-temp.js';
import {createHash} from 'node:crypto';
import {AllowedSessionsStore} from './lib/fleet-codex-allowlist-store.ts';
const c={hostProfile:'desktop',principal:'synthetic',threadId:'11111111-1111-4111-8111-111111111111'};
const owner={project:'af-test',peer:'synthetic',sessionId:'22222222-2222-4222-8222-222222222222',startedAt:'2026-11-13T00:00:00.000Z'};
const alias='synthetic',hash=createHash('sha256').update(JSON.stringify([c.hostProfile,c.principal,c.threadId])).digest('hex');
async function fixture(t:any,other=false,name=alias){
 const dir=mkdtempSync(join(physicalTempRoot(),'af-send-proof-')),root=join(dir,'policy'),writer=new AllowedSessionsStore(root,c),until=Date.now()+60000;
 t.after(()=>rmSync(dir,{recursive:true,force:true}));await writer.initialize();await writer.connect({alias:name,target:owner,rights:['read'],expiresAt:until},[owner],0);
 const second={...owner,peer:'other',sessionId:'33333333-3333-4333-8333-333333333333'};
 if(other)await writer.connect({alias:'other',target:second,rights:['read'],expiresAt:until},[owner,second],1);
 const reader=new AllowedSessionsStore(root,c),snapshot=await reader.open(),policy=join(root,hash+'.json'),lineage=policy+'.send-lineage';
 const grant=async(target=owner,selected=name,current=other?[owner,second]:[owner])=>writer.grantSend(await writer.resolve(selected,current),current);
 const revoke=async()=>writer.revokeSend(name,(await writer.open()).revision);
 return {root,writer,reader,snapshot,policy,lineage,until,second,grant,revoke};
}

test('only exact issued snapshots advance through send witnesses; the strict guard stays strict',async t=>{
 const f=await fixture(t);await f.grant();assert.equal(f.reader.snapshotCurrent(f.snapshot),false);
 assert.equal(f.reader.advanceSendSnapshot(structuredClone(f.snapshot),owner),null);assert.equal(new AllowedSessionsStore(f.root,c).advanceSendSnapshot(f.snapshot,owner),null);
 const granted=f.reader.advanceSendSnapshot(f.snapshot,owner)!;assert.ok(granted);assert.deepEqual(granted.bindings[0].rights,['read','send']);assert.equal(f.reader.snapshotCurrent(granted),true);
 await f.revoke();const revoked=f.reader.advanceSendSnapshot(granted,owner)!;assert.ok(revoked);assert.deepEqual(revoked.bindings[0].rights,['read']);assert.equal(revoked.bindings[0].expiresAt,f.until);
 assert.equal(statSync(f.lineage).mode&0o777,0o600);
});

test('rapid grant/revoke plus explicit idempotent send mutations have a complete chain',async t=>{
 const f=await fixture(t);await f.grant();await f.grant();await f.revoke();await f.revoke();const next=f.reader.advanceSendSnapshot(f.snapshot,owner);assert.ok(next);assert.equal(next.revision,f.snapshot.revision+4);assert.deepEqual(next.bindings[0].rights,['read']);
});

test('approve ABA, revoke/re-enroll, lease changes and generic no-op reconnect cannot be hidden by later send',async t=>{
 for(const change of ['approve','reenroll','expiry','generic-noop']){
  const f=await fixture(t);
  if(change==='approve'){await f.writer.grantApprove(await f.writer.resolve(alias,[owner]),[owner]);await f.writer.revokeApprove(alias,(await f.writer.open()).revision);}
  else if(change==='reenroll'){await f.writer.revoke(alias,(await f.writer.open()).revision);await f.writer.connect({alias,target:owner,rights:['read'],expiresAt:f.until},[owner],(await f.writer.open()).revision);}
  else await f.writer.reconnect({alias,previousTarget:owner,target:owner,rights:['read'],expiresAt:f.until+(change==='expiry'?1000:0)},[owner],(await f.writer.open()).revision,new AbortController().signal);
  await f.grant();assert.equal(f.reader.advanceSendSnapshot(f.snapshot,owner),null,change);
 }
});

test('another binding send and hydration staleness never authorize the active owner',async t=>{
 const other=await fixture(t,true);await other.grant(other.second,'other');assert.equal(other.reader.advanceSendSnapshot(other.snapshot,owner),null);
 const hydration=await fixture(t,true),handle=await hydration.writer.resolve(alias,[owner,hydration.second]);await hydration.writer.grantSend(handle,[owner,{...hydration.second,sessionId:'44444444-4444-4444-8444-444444444444'}]);assert.equal(hydration.reader.advanceSendSnapshot(hydration.snapshot,owner),null);assert.equal(hydration.reader.snapshotCurrent(hydration.snapshot),false);
});

test('missing, unsafe, malformed, gapped or tampered sidecars fail closed',async t=>{
 for(const change of ['missing','unsafe','malformed','gap','digest','extra','symlink']){
  const f=await fixture(t);await f.grant();await f.revoke();
  if(change==='missing')unlinkSync(f.lineage);
  else if(change==='unsafe')chmodSync(f.lineage,0o666);
  else if(change==='malformed')writeFileSync(f.lineage,Buffer.from([0xff]));
  else if(change==='symlink'){const bytes=readFileSync(f.lineage);unlinkSync(f.lineage);writeFileSync(f.lineage+'.other',bytes,{mode:0o600});symlinkSync(f.lineage+'.other',f.lineage);}
  else{const data=JSON.parse(readFileSync(f.lineage,'utf8'));if(change==='gap')data.steps.shift();if(change==='digest')data.steps[0].after='f'.repeat(64);if(change==='extra')data.ready=true;writeFileSync(f.lineage,JSON.stringify(data));}
  assert.equal(f.reader.advanceSendSnapshot(f.snapshot,owner),null,change);
 }
});

test('prepublished witness cannot advance a failed policy write and a later no-op cannot inherit it',async t=>{
 const f=await fixture(t),writer=new AllowedSessionsStore(f.root,c,{checkpoint:stage=>{if(stage==='beforeRename')throw Error('owned synthetic failure');}});
 await assert.rejects(writer.grantSend(await writer.resolve(alias,[owner]),[owner]));assert.ok(statSync(f.lineage));assert.equal(f.reader.snapshotCurrent(f.snapshot),true);assert.equal(f.reader.advanceSendSnapshot(f.snapshot,owner),null);
 await f.revoke();const next=f.reader.advanceSendSnapshot(f.snapshot,owner);assert.ok(next);assert.deepEqual(next.bindings[0].rights,['read']);
});

test('post-rename uncertainty is not replayed and exact committed send still preserves read',async t=>{
 const f=await fixture(t);let renames=0;const writer=new AllowedSessionsStore(f.root,c,{checkpoint:stage=>{if(stage==='afterRename'){renames++;throw Error('owned uncertain sync');}}});
 await assert.rejects(writer.grantSend(await writer.resolve(alias,[owner]),[owner]),(e:any)=>e.code==='COMMIT_UNCERTAIN');assert.equal(renames,1);assert.ok(f.reader.advanceSendSnapshot(f.snapshot,owner));
});

test('long aliases are byte-bounded and never prevent explicit revoke',async t=>{
 const f=await fixture(t,false,'a'.repeat(1024));let anchor=f.snapshot;
 for(let i=0;i<40;i++){if(i%2===0)await f.grant();else await f.revoke();const next=f.reader.advanceSendSnapshot(anchor,owner);assert.ok(next);anchor=next;}
 assert.ok(statSync(f.lineage).size<=32768);assert.deepEqual((await f.writer.open()).bindings[0].rights,['read']);
});

test('corrupt continuity metadata cannot block revoking send, read or approve',async t=>{
 for(const capability of ['send','read','approve']){
  const f=await fixture(t);await f.grant();if(capability==='approve')await f.writer.grantApprove(await f.writer.resolve(alias,[owner]),[owner]);writeFileSync(f.lineage,'{broken');const state=await f.writer.open();
  if(capability==='send')await f.writer.revokeSend(alias,state.revision);if(capability==='read')await f.writer.revoke(alias,state.revision);if(capability==='approve')await f.writer.revokeApprove(alias,state.revision);
  const after=await f.writer.open();assert.ok(capability==='read'?after.bindings.length===0:!after.bindings[0].rights.includes(capability as 'send'|'approve'));assert.equal(f.reader.advanceSendSnapshot(f.snapshot,owner),null);
 }
});

test('generic reconnect cannot inherit an interrupted send proof, directly or through a later send',async t=>{
 const f=await fixture(t),writer=new AllowedSessionsStore(f.root,c,{checkpoint:stage=>{if(stage==='beforeRename')throw Error('owned failure');}});
 await assert.rejects(writer.grantSend(await writer.resolve(alias,[owner]),[owner]));
 await f.writer.reconnect({alias,previousTarget:owner,target:owner,rights:['read','send'],expiresAt:f.until},[owner],f.snapshot.revision,new AbortController().signal);
 assert.equal(f.reader.advanceSendSnapshot(f.snapshot,owner),null);await f.revoke();assert.equal(f.reader.advanceSendSnapshot(f.snapshot,owner),null);
});

test('generic idempotent reconnect cannot inherit a failed explicit no-op witness',async t=>{
 const f=await fixture(t),writer=new AllowedSessionsStore(f.root,c,{checkpoint:stage=>{if(stage==='beforeRename')throw Error('owned failure');}});
 await assert.rejects(writer.revokeSend(alias,f.snapshot.revision));
 await f.writer.reconnect({alias,previousTarget:owner,target:owner,rights:['read'],expiresAt:f.until},[owner],f.snapshot.revision,new AbortController().signal);
 assert.equal(f.reader.advanceSendSnapshot(f.snapshot,owner),null);await f.grant();assert.equal(f.reader.advanceSendSnapshot(f.snapshot,owner),null);
});

test('bounded lineage cannot bridge a pruned gap',async t=>{
 const f=await fixture(t);for(let i=0;i<66;i++)if(i%2===0)await f.grant();else await f.revoke();
 assert.equal(JSON.parse(readFileSync(f.lineage,'utf8')).steps.length,64);assert.equal(f.reader.advanceSendSnapshot(f.snapshot,owner),null);
});
