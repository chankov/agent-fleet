import assert from 'node:assert/strict';
import test from 'node:test';
import { createRecoverState } from './recover-state.ts';
import { createNoProgressGuard } from './no-progress.ts';

test('continuation audit distinguishes operator attestation from runtime settlement and replays without a grant', () => {
 const events: any[] = [];
 const state = createRecoverState([], event => events.push(event));
 const first = state.start('task', 'contract', 'builder', 'dispatch-1')!;
 state.fail(first.operationId, first.attemptId, 'indeterminate');
 const record = { nonce: 'approval-1', revision: 'revision', reportRef: '/report.json', reportHash: 'a'.repeat(64), settlement: 'operator_attested' as const };
 assert.equal(state.recordContinuation(first.operationId, first.attemptId, { ...record, settlement: 'runtime' }), false);
 assert.equal(state.recordContinuation(first.operationId, first.attemptId, record), true);
 assert.equal(state.recordContinuation(first.operationId, first.attemptId, record), false, 'approval nonce is one-use');
 const restored = createRecoverState(events);
 assert.equal(restored.inspect(first.operationId)?.attempts[0].settled, undefined);
 assert.equal(restored.inspect(first.operationId)?.indeterminateGrantUsed, false);
 assert.equal(restored.inspect(first.operationId)?.attempts[0].continuations?.[0].settlement, 'operator_attested');
});

test('only an opaque continuation permit starts the same operation once; a new crash needs a fresh approval', async () => {
 const entries: any[] = [];
 const guard = createNoProgressGuard((customType, data) => entries.push({ customType, data }));
 const first = guard.begin('contract', 'revision', 'builder');
 guard.recordInvocation(first.operationId!, 'contract', { tool: 'dispatch_agent', params: { agent: 'builder', task: 'original task' } });
 guard.finish(first, 'revision', { category: 'indeterminate', reason: 'lost', dispatchId: 'dispatch-1' });
 const permission = { nonce: 'approval-1', revision: 'revision', reportRef: '/report.json', reportHash: 'a'.repeat(64), settlement: 'operator_attested' as const, report: 'Research report', admit: () => true };
 const permit = guard.authorizeContinuation(first.operationId!, first.attemptId!, permission)!;
 assert.ok(permit);
 assert.equal(guard.begin('contract', 'revision', 'builder').allowed, false, 'a persisted audit is not a general retry grant');
 await assert.rejects(guard.runContinuation({}, async () => {}), /permit/i);
 const second = await guard.runContinuation(permit, async () => guard.begin('contract', 'revision', 'builder'));
 assert.equal(second.allowed, true);
 assert.equal(second.operationId, first.operationId);
 assert.notEqual(second.attemptId, first.attemptId);
 assert.equal(second.continuation?.report, 'Research report');
 await assert.rejects(guard.runContinuation(permit, async () => {}), /permit/i);
 guard.finish(second, 'revision', { category: 'indeterminate', reason: 'another crash', dispatchId: 'dispatch-2' });
 const thirdPermit = guard.authorizeContinuation(first.operationId!, second.attemptId!, { ...permission, nonce: 'approval-2' });
 assert.ok(thirdPermit, 'continuation is not permanently capped by the first crash');
 const replay = createNoProgressGuard();
 replay.restore(entries);
 assert.equal(replay.begin('contract', 'changed', 'builder').allowed, false, 'replay cannot recreate an in-memory permit');
 assert.equal(replay.inspect(first.operationId!)?.attempts[1].settled, undefined);
});

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

test('a late outcome from the original owner of an interrupted attempt stays inspection data, never settlement', () => {
 const events: any[] = [];
 const owner = createRecoverState([], event => events.push(event));
 const first = owner.start('task', 'contract', 'builder', 'placeholder-1')!;
 // A second process restores the unlocked session while the owner is still running.
 const restorer = createRecoverState(structuredClone(events), event => events.push(event));
 assert.equal(restorer.interrupt(first.operationId, first.attemptId), true);
 // The owner never saw that row and appends its own outcome afterwards.
 assert.equal(owner.bindDispatch(first.operationId, first.attemptId, 'late-dispatch'), true);
 assert.equal(owner.fail(first.operationId, first.attemptId, 'verification_failed'), true);
 const replay = createRecoverState(events);
 const attempt = replay.inspect(first.operationId)!.attempts[0];
 assert.equal(attempt.category, 'indeterminate');
 assert.equal(attempt.interrupted, true);
 assert.equal(attempt.settled, undefined);
 assert.equal(attempt.lateOutcome, 'verification_failed');
 assert.equal(replay.byDispatch('late-dispatch')?.operationId, first.operationId);
 assert.ok(replay.continuationBasis(first.operationId, first.attemptId), 'uncertainty remains continuable only through research and approval');
 assert.ok(replay.start('task', 'contract', 'builder', 'next-dispatch'), 'the executor is not held by the late owner');
 assert.throws(() => createRecoverState([...events, { type: 'complete', operationId: first.operationId, attemptId: first.attemptId }]), /Invalid recovery history/, 'only one late outcome is accepted');
 assert.throws(() => createRecoverState([events[0], { type: 'failure', operationId: first.operationId, attemptId: first.attemptId, category: 'verification_failed', interrupted: true }]), /Invalid recovery history/, 'an interruption is always indeterminate');
});
