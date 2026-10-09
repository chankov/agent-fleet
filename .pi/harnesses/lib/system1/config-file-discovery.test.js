import test from 'node:test';
import assert from 'node:assert/strict';
import {parseFileDiscoveryConfig,FILE_DISCOVERY_LIMITS} from './config-file-discovery.js';
import {normalizeSystem1Config} from './config-v2.js';
const root={version:2,mode:'auto',provider:'typesafe',model:'jev-1.13.0',apiKeyEnv:'TYPESAFE_API_KEY',consumers:{agenticAsk:{mode:'recommended',remoteContextApproved:true,include:['src']}}};
test('D9 independent v2 readiness, consent, isolation and immutable snapshot',()=>{
 for(const [section,status] of [[undefined,'off'],[{mode:'off'},'off'],[{mode:'active'},'off'],[{mode:'active',remoteContextApproved:true,include:['src']},'ready'],[{mode:'other'},'invalid']]) {
  const snapshot=normalizeSystem1Config({...root,consumers:{...root.consumers,...(section?{fileDiscovery:section}:{})}});
  assert.equal(snapshot.status,'ready');assert.equal(snapshot.consumers.fileDiscovery.status,status);assert.equal(snapshot.consumers.agenticAsk.status,'ready');
  assert.ok(Object.isFrozen(snapshot.consumers.fileDiscovery));
 }
 assert.equal(parseFileDiscoveryConfig({mode:'active'}).remoteContextApproved,false);
});
test('N1 approved active D9 requires explicit nonempty include for readiness',()=>{
 for(const include of [undefined,[]]){
  const section={mode:'active',remoteContextApproved:true,...(include?{include}:{})};
  assert.throws(()=>parseFileDiscoveryConfig(section),/Explicit include scope required/);
  const snapshot=normalizeSystem1Config({...root,consumers:{...root.consumers,fileDiscovery:section}});
  assert.equal(snapshot.consumers.fileDiscovery.status,'invalid');
  assert.ok(snapshot.errors.some(e=>e.path==='$.consumers.fileDiscovery.include'));
  assert.equal(snapshot.consumers.agenticAsk.status,'ready');
 }
 assert.equal(parseFileDiscoveryConfig({mode:'off',remoteContextApproved:true}).mode,'off');
});
test('D9 defaults and every bound and invalid scope strictly validated',()=>{
 assert.deepEqual(parseFileDiscoveryConfig({mode:'off'}).limits,FILE_DISCOVERY_LIMITS);
 for(const [key,max] of Object.entries(FILE_DISCOVERY_LIMITS)) {
  for(const n of [0,-1,1.5,max+1,NaN,'1']) assert.throws(()=>parseFileDiscoveryConfig({mode:'active',limits:{[key]:n}}));
  assert.equal(parseFileDiscoveryConfig({mode:'active',limits:{[key]:1}}).limits[key],1);
 }
 for(const section of [{mode:'active',provider:'new'},{mode:'active',limits:{unknown:1}},{mode:'active',remoteContextApproved:'true'},...['../src','/src','src/**','src\\x','src//x'].map(p=>({mode:'active',include:[p]}))]) assert.throws(()=>parseFileDiscoveryConfig(section));
});
test('D8 nested opt-in preserves root and consumer readiness, consent and include boundaries',()=>{
 assert.deepEqual(parseFileDiscoveryConfig({mode:'off'}).semanticReads,{mode:'off'});
 for(const semanticReads of [null,{},[],{mode:'bad'},{mode:'active',include:['other']}])assert.throws(()=>parseFileDiscoveryConfig({mode:'active',semanticReads}));
 for(const mode of ['off','active']){
  const section={mode:'active',remoteContextApproved:true,include:['src'],semanticReads:{mode}};
  const snapshot=normalizeSystem1Config({...root,consumers:{fileDiscovery:section}});assert.equal(snapshot.consumers.fileDiscovery.status,'ready');assert.equal(snapshot.consumers.fileDiscovery.config.semanticReads.mode,mode);
  assert.equal(normalizeSystem1Config({...root,mode:'off',consumers:{fileDiscovery:section}}).status,'off');
  assert.equal(normalizeSystem1Config({...root,consumers:{fileDiscovery:{...section,remoteContextApproved:false}}}).consumers.fileDiscovery.status,'off');
  assert.equal(normalizeSystem1Config({...root,consumers:{fileDiscovery:{...section,include:[]}}}).consumers.fileDiscovery.status,'invalid');
 }
});
