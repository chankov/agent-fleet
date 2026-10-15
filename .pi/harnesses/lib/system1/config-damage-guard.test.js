import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDamageGuardConfig, DAMAGE_GUARD_LIMITS } from './config-damage-guard.js';
import { normalizeSystem1Config } from './config-v2.js';
const root = { version:2, mode:'auto', provider:'typesafe', model:'jev-1.13.0', apiKeyEnv:'TYPESAFE_API_KEY', consumers:{} };
const active = { mode:'active', remoteScopes:{commands:true,edits:true,results:true}, include:['git:tracked'] };
test('D6 defaults deny remote scopes independently, without inherited consent', () => {
 const config = parseDamageGuardConfig({mode:'off'});
 assert.deepEqual(config.remoteScopes,{commands:false,edits:false,results:false});
 assert.deepEqual(config.limits,DAMAGE_GUARD_LIMITS);
 for(const scope of ['commands','edits','results']) {
  const row=parseDamageGuardConfig({...active,remoteScopes:{[scope]:true}});
  assert.equal(row.remoteScopes[scope],true);
  assert.equal(Object.values(row.remoteScopes).filter(Boolean).length,1);
 }
 const snap=normalizeSystem1Config({...root,consumers:{agenticAsk:{mode:'recommended',remoteContextApproved:true,allowToolOutputs:true,include:['git:tracked']},damageGuard:{mode:'active'}}});
 assert.equal(snap.consumers.damageGuard.status,'off');
});
test('D6 requires explicit include for active export and validates selectors', () => {
 assert.throws(()=>parseDamageGuardConfig({...active,include:[]}));
 for(const path of ['/tmp','../src','src/../x','src//x','src/**','git:all','C:\\x','src\0x']) assert.throws(()=>parseDamageGuardConfig({...active,include:[path]}));
 assert.deepEqual(parseDamageGuardConfig({...active,include:['src/','git:tracked']}).include,['src/','git:tracked']);
});
test('D6 rejects unknown sections, scopes and invalid limit values', () => {
 for(const value of [null,[],{}, {...active,mode:'shadow'},{...active,extra:true},{...active,remoteScopes:[]},{...active,remoteScopes:{commands:1}},{...active,remoteScopes:{unknown:true}},{...active,limits:{unknown:1}}]) assert.throws(()=>parseDamageGuardConfig(value));
 for(const [key,max] of Object.entries(DAMAGE_GUARD_LIMITS)) for(const n of [0,-1,1.5,max+1,Infinity,'1']) assert.throws(()=>parseDamageGuardConfig({...active,limits:{[key]:n}}));
});
test('D6 missing/off/invalid states remain isolated and immutable', () => {
 assert.equal(normalizeSystem1Config(root).consumers.damageGuard.status,'off');
 assert.equal(normalizeSystem1Config({...root,mode:'off',consumers:{damageGuard:active}}).status,'off');
 const invalid=normalizeSystem1Config({...root,consumers:{watchdog:{mode:'active'},contextCompaction:{mode:'off'},damageGuard:{...active,extra:true}}});
 assert.equal(invalid.consumers.damageGuard.status,'invalid');
 assert.equal(invalid.consumers.watchdog.status,'ready');
 assert.equal(invalid.consumers.contextCompaction.status,'off');
 const input=structuredClone(active), snapshot=normalizeSystem1Config({...root,consumers:{damageGuard:input}});
 assert.equal(snapshot.consumers.damageGuard.status,'ready');
 input.remoteScopes.commands=false;
 assert.equal(snapshot.consumers.damageGuard.config.remoteScopes.commands,true);
 assert.throws(()=>{snapshot.consumers.damageGuard.config.remoteScopes.commands=false;},TypeError);
});
