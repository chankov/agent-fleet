import test from 'node:test';
import assert from 'node:assert/strict';
import {parseContextCompactionConfig} from './config-context-compaction.js';
import {normalizeSystem1Config} from './config-v2.js';
const root={version:2,mode:'auto',provider:'typesafe',model:'jev-1.13.0',apiKeyEnv:'TYPESAFE_API_KEY',consumers:{}};
test('D7 consent and mode are independent and default to off',()=>{
 assert.equal(normalizeSystem1Config(root).consumers.contextCompaction.status,'off');
 for(const section of [{mode:'off',remoteContextApproved:true},{mode:'automatic',remoteContextApproved:false}])assert.equal(normalizeSystem1Config({...root,consumers:{contextCompaction:section}}).consumers.contextCompaction.status,'off');
 const normalized=normalizeSystem1Config({...root,consumers:{contextCompaction:{mode:'automatic',remoteContextApproved:true}}});
 assert.equal(normalized.consumers.contextCompaction.status,'ready');
 assert.deepEqual(normalized.consumers.contextCompaction.config.limits,{timeoutMs:1000,maxStateBytes:8192});
 assert.equal(normalized.consumers.contextCompaction.config.earlyOpportunityPercent,60);
});
test('invalid D7 section disables only this consumer',()=>{
 for(const section of [{mode:'active'},{mode:'automatic',remoteContextApproved:'yes'},{mode:'automatic',limits:{timeoutMs:0}},{mode:'automatic',earlyOpportunityPercent:90},{mode:'automatic',include:['**']}]){
  const n=normalizeSystem1Config({...root,consumers:{watchdog:{mode:'shadow'},contextCompaction:section}});
  assert.equal(n.status,'ready');assert.equal(n.consumers.watchdog.status,'ready');assert.equal(n.consumers.contextCompaction.status,'invalid');
 }
 assert.throws(()=>parseContextCompactionConfig({mode:'automatic',limits:{maxStateBytes:8193}}));
});

test('early opportunity configuration stays inside approved 50–70 band',()=>{
 for(const earlyOpportunityPercent of [49,0,71,80]) {
  const n=normalizeSystem1Config({...root,consumers:{contextCompaction:{mode:'automatic',remoteContextApproved:true,earlyOpportunityPercent}}});
  assert.equal(n.consumers.contextCompaction.status,'invalid');
 }
 for(const earlyOpportunityPercent of [50,60,70]) {
  const n=normalizeSystem1Config({...root,consumers:{contextCompaction:{mode:'automatic',remoteContextApproved:true,earlyOpportunityPercent}}});
  assert.equal(n.consumers.contextCompaction.status,'ready');
 }
});
