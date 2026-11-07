import test from 'node:test';
import assert from 'node:assert/strict';
import {PermissionChannel,type PermissionTarget,type MachinePrincipal} from './permission-channel.ts';
const target:PermissionTarget={owner:{project:'p',peer:'hub',sessionId:'s',startedAt:'now'},taskId:'task',inputRevision:'r1',actionDigest:'a'.repeat(64)};
const principal:MachinePrincipal={actor:'codex',bindingId:'b1',bindingEpoch:'e1',threadId:'t1',turnId:'turn1',approve:true,current:()=>true};

test('machine winner has explicit provenance, reason, exact target and does not become an applied grant',async()=>{
 const channel=new PermissionChannel(()=>true);const request=channel.open(target,Date.now()+1000)!;
 assert.equal(channel.machine(request.snapshot,'allow_once','Required to run the task-specific fixture',principal).status,'accepted_by_latch');
 assert.equal(request.human('deny','operator'),false);
 const result=await request.result;
 assert.deepEqual(result,{status:'decided',decision:'allow_once',source:'codex_machine',actor:'codex',bindingId:'b1',bindingEpoch:'e1',threadId:'t1',turnId:'turn1',reason:'Required to run the task-specific fixture'});
 assert.equal(channel.machine(request.snapshot,'allow_once','retry',principal).status,'late');
 assert.deepEqual(channel.inspect(request.snapshot),result);
 channel.reset();assert.equal(channel.inspect(request.snapshot).status,'unknown');
});

test('local human and machine share one latch; local denial never becomes machine approval',async()=>{
 const channel=new PermissionChannel(()=>true);const request=channel.open(target,Date.now()+1000)!;
 assert.equal(request.human('deny','operator'),true);
 assert.equal(channel.machine(request.snapshot,'allow_once','needed',principal).status,'late');
 assert.deepEqual(await request.result,{status:'decided',decision:'deny',source:'local_human',actor:'operator'});
 channel.reset();
});

test('missing approve, missing reason, wrong action/owner/deadline/epoch and stale principal do not win',async()=>{
 const channel=new PermissionChannel(()=>true);const request=channel.open(target,Date.now()+1000)!;
 for(const changed of [
  {...request.snapshot,actionDigest:'b'.repeat(64)},
  {...request.snapshot,owner:{...target.owner,sessionId:'s2'}},
  {...request.snapshot,expiresAt:request.snapshot.expiresAt+1},
  {...request.snapshot,epoch:'other'},
 ])assert.equal(channel.machine(changed,'allow_once','needed',principal).status,'unknown');
 assert.equal(channel.machine(request.snapshot,'allow_once','needed',{...principal,approve:false}).status,'rejected');
 assert.equal(channel.machine(request.snapshot,'allow_once','',principal).status,'rejected');
 assert.equal(channel.machine(request.snapshot,'allow_once','needed',{...principal,current:()=>false}).status,'stale');
 assert.equal(channel.inspect(request.snapshot).status,'pending');
 request.cancel();assert.deepEqual(await request.result,{status:'cancelled'});
});

test('expiry, task/revision changes and reset fail closed without masquerading as denial',async()=>{
 let current=true;const channel=new PermissionChannel(()=>current);
 const expired=channel.open(target,Date.now()+30)!;
 assert.deepEqual(await expired.result,{status:'expired'});
 assert.equal(expired.human('allow_once','operator'),false);
 const stale=channel.open(target,Date.now()+1000)!;current=false;
 assert.equal(channel.machine(stale.snapshot,'allow_once','needed',principal).status,'late');
 assert.deepEqual(await stale.result,{status:'stale'});
 current=true;const reset=channel.open(target,Date.now()+1000)!;channel.reset();
 assert.deepEqual(await reset.result,{status:'stale'});
});

test('capacity fails closed without evicting winner evidence or leaving unresolved waits',async()=>{
 const channel=new PermissionChannel(()=>true,1);const first=channel.open(target,Date.now()+1000)!;
 first.human('deny','operator');await first.result;
 assert.equal(channel.open(target,Date.now()+1000),null);
 assert.equal(channel.inspect(first.snapshot).status,'decided');
 channel.reset();const next=channel.open(target,Date.now()+1000)!;next.cancel();await next.result;
});
