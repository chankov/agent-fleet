import assert from 'node:assert/strict';
import test from 'node:test';
import { createRecoverState } from './recover-state.ts';

test('logical operations retain distinct physical attempts; busy is not an attempt and inspect is read-only', () => {
 const events: any[] = []; const s = createRecoverState(events, e => events.push(e));
 const first = s.start('task', 'contract', 'builder', 'dispatch-1');
 assert.ok(first); assert.equal(s.start('task', 'contract', 'builder', 'busy'), null);
 assert.ok(s.start('task', 'other', 'reviewer', 'dispatch-other'));
 const before = events.length;
 assert.equal(s.inspect(first!.operationId)?.attempts.length, 1); assert.equal(events.length, before);
 s.fail(first!.operationId, first!.attemptId, 'indeterminate');
 const second = s.start('task', 'contract', 'builder', 'dispatch-2');
 assert.ok(second); assert.equal(second!.operationId, first!.operationId);
 assert.notEqual(second!.attemptId, first!.attemptId);
 assert.equal(s.inspect(first!.operationId)?.attempts[0].category, 'indeterminate');
});

test('validated append-only restore rejects corrupt lineage and preserves one-use grant and technical status', () => {
 const events: any[] = []; const s = createRecoverState(events, e => events.push(e));
 const a = s.start('task', 'contract', 'builder', 'd')!;
 s.fail(a.operationId, a.attemptId, 'indeterminate');
 assert.equal(s.grant(a.operationId, a.attemptId, 'nonce'), false);
 assert.equal(s.settle(a.operationId, a.attemptId, 'process-exit'), true);
 assert.equal(s.grant(a.operationId, a.attemptId, 'nonce'), true);
 assert.equal(s.grant(a.operationId, a.attemptId, 'other'), false);
 assert.equal(s.assess(a.operationId, a.attemptId, 'rev-1', 'cleared', 'independent-readback'), true);
 const restored = createRecoverState(events);
 assert.equal(restored.inspect(a.operationId)?.indeterminateGrantUsed, true);
 assert.equal(restored.inspect(a.operationId)?.technical?.status, 'cleared');
 assert.equal(restored.grant(a.operationId, a.attemptId, 'again'), false);
 const other=s.start('task','other-contract','reviewer','d-other')!;
 s.fail(other.operationId,other.attemptId,'indeterminate'); s.settle(other.operationId,other.attemptId,'other-exit');
 assert.equal(s.grant(other.operationId,other.attemptId,'nonce'),false,'issued nonce cannot be replayed across operations');
 assert.equal(s.grant(other.operationId,other.attemptId,'fresh-nonce'),true);
 assert.throws(() => createRecoverState([...events, events[0]]), /invalid recovery history/i);
 assert.throws(() => createRecoverState([...events.slice(0, 1), { type: 'grant', operationId: a.operationId, attemptId: a.attemptId, nonce: 'fake' }]), /invalid recovery history/i);
});

test('uncertain append blocks another grant or abandon until durable history is reloaded', () => {
 const durable: any[] = []; let fail = false;
 const state = createRecoverState([], event => { durable.push(event); if (fail) throw new Error('append acknowledgement lost'); });
 const first = state.start('task', 'contract', 'builder', 'd')!;
 state.fail(first.operationId, first.attemptId, 'indeterminate');
 state.settle(first.operationId, first.attemptId, 'trusted-exit');
 fail = true;
 assert.equal(state.grant(first.operationId, first.attemptId, 'nonce-1'), false);
 assert.equal(state.grant(first.operationId, first.attemptId, 'nonce-2'), false);
 assert.equal(state.abandon(first.operationId, first.attemptId, 'nonce-3'), false);
 assert.equal(durable.filter(event => event.type === 'grant').length, 1);
 const restored = createRecoverState(durable);
 assert.equal(restored.inspect(first.operationId)?.indeterminateGrantUsed, true);
 assert.equal(restored.grant(first.operationId, first.attemptId, 'nonce-2'), false);
});
