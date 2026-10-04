import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeSystem1Config } from './config-v2.js';
const root = { version: 2, mode: 'auto', provider: 'typesafe', model: 'jev-1.13.0', apiKeyEnv: 'TYPESAFE_API_KEY', consumers: {} };
test('root outcomes and strict provider contract', () => {
 assert.equal(normalizeSystem1Config(undefined).status, 'missing');
 const { consumers, ...provider } = root;
 assert.equal(normalizeSystem1Config({...provider, version:1}).status, 'migration_required');
 assert.equal(normalizeSystem1Config({...root, version:1}).status, 'invalid');
 for (const value of [null, {}, {...root, extra:true}, {...root, model:'other'}, {...root, consumers:null}]) assert.equal(normalizeSystem1Config(value).status,'invalid');
 assert.equal(normalizeSystem1Config(root).status,'ready');
 assert.equal(normalizeSystem1Config({...root,mode:'off'}).status,'off');
});
test('immutable isolated consumer snapshots and missing consumers off', () => {
 const value = {...root, consumers:{watchdog:{mode:'active'}, proactiveReview:{mode:'off',include:['src/**']}, strange:{mode:'active'}}};
 const snapshot = normalizeSystem1Config(value);
 assert.equal(snapshot.consumers.watchdog.status,'ready');
 assert.equal(snapshot.consumers.proactiveReview.status,'invalid');
 assert.equal(snapshot.consumers.taskTriage.status,'off');
 assert.ok(snapshot.errors.some(e=>e.path==='$.consumers.strange'));
 assert.throws(()=>{snapshot.document.consumers.watchdog.mode='off'},TypeError);
 value.consumers.watchdog.mode='off';
 assert.equal(snapshot.consumers.watchdog.config.mode,'active');
});
