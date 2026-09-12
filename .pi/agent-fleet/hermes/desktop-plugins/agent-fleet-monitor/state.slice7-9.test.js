import test from 'node:test';
import assert from 'node:assert/strict';
import * as state from './state.js';

test('active Desktop view polls metadata once each second, fetches only advanced output cursor bytes, and stops hidden polling', async (t) => {
  assert.equal(typeof state.createActiveViewController, 'function', 'Slice 7 requires an active-view controller');
  t.mock.timers.enable({ apis: ['setInterval'] });
  const metadata = []; const output = [];
  const controller = state.createActiveViewController({
    pollMetadata: async () => { metadata.push('metadata'); return [{ id: 'child', generation: 1, outputSequence: 2 }]; },
    fetchOutput: async (_hub, _id, _generation, afterSequence) => { output.push(afterSequence); return { sequence: 2, text: 'new' }; },
  });
  controller.setVisible(true); t.mock.timers.tick(1000); await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(output, [0]);
  t.mock.timers.tick(1000); await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(output, [0], 'unchanged cursor must not refetch output');
  controller.setVisible(false); t.mock.timers.tick(5000); await Promise.resolve();
  assert.equal(metadata.length, 2, 'hidden view must not poll');
  controller.dispose();
});

test('controller fences overlapping and stale visibility requests',async()=>{let resolveMeta;let calls=0,applied=0;const c=state.createActiveViewController({pollMetadata:()=>{calls++;return new Promise(r=>resolveMeta=r)},fetchOutput:async()=>({sequence:1,text:'x'}),onOutput:()=>applied++});c.setVisible(true);const first=c.poll(),second=c.poll();assert.equal(first,second);c.setVisible(false);resolveMeta([{hubInstanceId:'h',id:'x',generation:1,outputSequence:1}]);await first;assert.equal(applied,0);c.setVisible(true);let meta=0;const fresh=c.poll();assert.ok(fresh);c.dispose();assert.equal(calls,2);});
test('Desktop hierarchy aggregates parent and child terminal states while blocked continuation creates a new generation', () => {
  assert.equal(typeof state.aggregateTaskHierarchy, 'function', 'Slice 8 requires hierarchy aggregation for Desktop state');
  assert.deepEqual(state.aggregateTaskHierarchy([
    { id: 'parent', generation: 1, kind: 'parent', state: 'running' },
    { id: 'child', generation: 1, parentId: 'parent', parentGeneration: 1, kind: 'child', state: 'blocked' },
    { id: 'child', generation: 2, parentId: 'parent', parentGeneration: 1, kind: 'child', state: 'starting' },
  ]), [{ id: 'parent', state: 'running', children: [{ id: 'child', generation: 1, state: 'blocked' }, { id: 'child', generation: 2, state: 'starting' }] }]);
});
