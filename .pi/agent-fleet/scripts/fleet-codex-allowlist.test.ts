import test from 'node:test';
import assert from 'node:assert/strict';
import { AllowedSessionsPolicy, AllowlistError, type ConversationKey, type TargetEpoch } from './lib/fleet-codex-allowlist.ts';

const A: ConversationKey = { hostProfile: 'fake-host', principal: 'fake-user', threadId: 'fake-A' };
const B: ConversationKey = { ...A, threadId: 'fake-B' };
const target: TargetEpoch = { project: 'fake-project', peer: 'fake-peer', sessionId: 'fake-session-1', startedAt: '2000-01-01T00:00:00Z' };
const restarted: TargetEpoch = { ...target, sessionId: 'fake-session-2', startedAt: '2000-01-02T00:00:00Z' };
const deny = (code: string, fn: () => unknown) => assert.throws(fn, (e: unknown) => e instanceof AllowlistError && e.code === code);

test('explicit enrollment defaults to read; send is a separate exact-target grant', () => {
  const p = new AllowedSessionsPolicy();
  const h = p.enroll(A, { alias: 'shop', target }, [target]);
  assert.deepEqual(p.authorize(A, h, 'read', [target]), target);
  deny('SEND_NOT_GRANTED', () => p.authorize(A, h, 'send', [target]));
  const sending = p.grantSend(A, h, [target]);
  deny('STALE_HANDLE', () => p.authorize(A, h, 'read', [target]));
  assert.deepEqual(p.authorize(A, sending, 'send', [target]), target);
});

test('conversation namespace and issued handles cannot cross A/B or instances', () => {
  const p = new AllowedSessionsPolicy();
  const h = p.enroll(A, { alias: 'shop', target }, [target]);
  p.enroll(B, { alias: 'shop', target }, [target]);
  deny('STALE_HANDLE', () => p.authorize(B, h, 'read', [target]));
  deny('STALE_HANDLE', () => p.authorize(A, { ...h }, 'read', [target]));
  const fresh = new AllowedSessionsPolicy();
  assert.deepEqual(fresh.list(A), []);
  fresh.enroll(A, { alias: 'shop', target }, [target]);
  deny('STALE_HANDLE', () => fresh.authorize(A, h, 'read', [target]));
});

test('epoch change latches stale until explicit rebind; send does not migrate', () => {
  const p = new AllowedSessionsPolicy();
  let h = p.enroll(A, { alias: 'shop', target }, [target]);
  h = p.grantSend(A, h, [target]);
  deny('STALE_TARGET', () => p.authorize(A, h, 'send', [restarted]));
  deny('STALE_TARGET', () => p.authorize(A, h, 'read', [target]));
  const rebound = p.rebind(A, h, restarted, [restarted]);
  deny('STALE_HANDLE', () => p.authorize(A, h, 'read', [restarted]));
  assert.deepEqual(p.authorize(A, rebound, 'read', [restarted]), restarted);
  deny('SEND_NOT_GRANTED', () => p.authorize(A, rebound, 'send', [restarted]));
});

for (const field of ['hostProfile', 'principal', 'threadId'] as const) {
  test(`namespace isolation includes ${field}`, () => {
    const p = new AllowedSessionsPolicy();
    const h = p.enroll(A, { alias: 'shop', target }, [target]);
    const other = { ...A, [field]: 'different' };
    assert.deepEqual(p.list(other), []);
    deny('STALE_HANDLE', () => p.authorize(other, h, 'read', [target]));
    deny('STALE_HANDLE', () => p.revoke(other, h));
    assert.equal(p.list(A).length, 1);
  });
}

for (const field of ['project', 'peer', 'sessionId', 'startedAt'] as const) {
  test(`exact target decision compares ${field}`, () => {
    const p = new AllowedSessionsPolicy();
    const h = p.enroll(A, { alias: 'shop', target }, [target]);
    const changed = { ...target, [field]: 'different' };
    deny(field === 'project' || field === 'peer' ? 'TARGET_UNAVAILABLE' : 'STALE_TARGET',
      () => p.authorize(A, h, 'read', [changed]));
    const next = p.rebind(A, h, changed, [changed]);
    deny('STALE_HANDLE', () => p.authorize(A, h, 'read', [target]));
    assert.deepEqual(p.authorize(A, next, 'read', [changed]), changed);
  });
}

test('project ambiguity and alias/project collision require clarification; no focus/broadcast', () => {
  const p = new AllowedSessionsPolicy();
  const other = { ...target, peer: 'fake-reviewer' };
  const current = [target, other];
  const first = p.enroll(A, { alias: 'shop', target }, current);
  p.enroll(A, { alias: 'review', target: other }, current);
  deny('AMBIGUOUS_TARGET', () => p.resolve(A, target.project, current));
  assert.deepEqual(p.authorize(A, p.resolve(A, 'shop', current), 'read', current), target);
  for (const selector of ['', '*', ['shop', 'review'], null]) {
    deny('INVALID_INPUT', () => p.resolve(A, selector as string, current));
    deny('STALE_HANDLE', () => p.authorize(A, selector as never, 'send', current));
  }
  const third = { ...target, project: 'another-fake-project' };
  p.enroll(A, { alias: target.project, target: third }, [...current, third]);
  deny('AMBIGUOUS_TARGET', () => p.resolve(A, target.project, [...current, third]));
  assert.deepEqual(p.authorize(A, first, 'read', current), target);
});

test('revoke send preserves read, invalidates old handle and cannot affect other grants', () => {
  const p = new AllowedSessionsPolicy();
  const a = p.enroll(A, { alias: 'shop', target }, [target]);
  let b = p.enroll(B, { alias: 'shop', target }, [target]);
  b = p.grantSend(B, b, [target]);
  const sending = p.grantSend(A, a, [target]);
  const readOnly = p.revokeSend(A, sending);
  deny('STALE_HANDLE', () => p.authorize(A, sending, 'send', [target]));
  deny('SEND_NOT_GRANTED', () => p.authorize(A, readOnly, 'send', [target]));
  assert.deepEqual(p.authorize(A, readOnly, 'read', [target]), target);
  assert.deepEqual(p.authorize(B, b, 'send', [target]), target);
  p.revoke(A, readOnly);
  deny('STALE_HANDLE', () => p.authorize(A, readOnly, 'read', [target]));
  const reEnrolled = p.enroll(A, { alias: 'shop', target }, [target]);
  deny('STALE_HANDLE', () => p.authorize(A, readOnly, 'read', [target]));
  deny('SEND_NOT_GRANTED', () => p.authorize(A, reEnrolled, 'send', [target]));
});

test('lookup never enrolls and unknown or human-question rights are not provided', () => {
  const p = new AllowedSessionsPolicy();
  deny('NOT_ALLOWED', () => p.resolve(A, 'shop', [target]));
  assert.deepEqual(p.list(A), []);
  const h = p.enroll(A, { alias: 'shop', target }, [target]);
  for (const right of ['answer', 'cancel', '*', undefined, ['read', 'send']]) {
    deny('UNSUPPORTED_RIGHT', () => p.authorize(A, h, right as never, [target]));
  }
});

test('invalid contexts/targets/scopes/booleans do not create or replace grants', () => {
  const p = new AllowedSessionsPolicy();
  for (const ctx of [null, {}, { ...A, threadId: '' }, { ...A, principal: ' bad' }, { ...A, extra: 'x' }]) {
    deny('INVALID_CONTEXT', () => p.enroll(ctx as never, { alias: 'shop', target }, [target]));
  }
  for (const proposal of [true, { confirmed: true }, { alias: '*', target },
    { alias: 'shop', target: { ...target, startedAt: '' } }, { alias: 'shop', target, rights: ['send'] },
    { alias: 'shop', target, confirmed: true }, { alias: 'bad\nname', target }, { alias: 'x'.repeat(1025), target }]) {
    deny('INVALID_INPUT', () => p.enroll(A, proposal as never, [target]));
  }
  assert.deepEqual(p.list(A), []);
  const h = p.enroll(A, { alias: 'shop', target }, [target]);
  const other = { ...target, peer: 'other' };
  deny('INVALID_INPUT', () => p.enroll(A, { alias: 'shop', target: other }, [other]));
  deny('INVALID_INPUT', () => p.enroll(A, { alias: 'duplicate', target }, [target]));
  assert.deepEqual(p.authorize(A, h, 'read', [target]), target);
});

test('unavailable/ambiguous/invalid snapshots refuse enroll, grant, access and rebind', () => {
  const p = new AllowedSessionsPolicy();
  deny('TARGET_UNAVAILABLE', () => p.enroll(A, { alias: 'shop', target }, []));
  const h = p.enroll(A, { alias: 'shop', target }, [target]);
  for (const [code, snapshot] of [
    ['TARGET_UNAVAILABLE', []], ['AMBIGUOUS_TARGET', [target, target]],
    ['INVALID_INPUT', [target, null]], ['INVALID_INPUT', null], ['INVALID_INPUT', [target, ,]],
  ] as const) {
    deny(code, () => p.authorize(A, h, 'read', snapshot as never));
    deny(code, () => p.grantSend(A, h, snapshot as never));
    deny(code, () => p.rebind(A, h, target, snapshot as never));
  }
  assert.deepEqual(p.authorize(A, h, 'read', [target]), target);
  deny('SEND_NOT_GRANTED', () => p.authorize(A, h, 'send', [target]));
});

test('failed/stale send grant and rebind cannot expand or silently replace rights', () => {
  const p = new AllowedSessionsPolicy();
  const h = p.enroll(A, { alias: 'shop', target }, [target]);
  const other = { ...target, peer: 'other' };
  const otherHandle = p.enroll(A, { alias: 'other', target: other }, [other]);
  deny('INVALID_INPUT', () => p.rebind(A, h, other, [other]));
  assert.deepEqual(p.authorize(A, otherHandle, 'read', [other]), other);
  deny('STALE_TARGET', () => p.grantSend(A, h, [restarted]));
  deny('STALE_TARGET', () => p.grantSend(A, h, [target]));
  const bound = p.rebind(A, h, restarted, [restarted]);
  deny('SEND_NOT_GRANTED', () => p.authorize(A, bound, 'send', [restarted]));
});

test('input and returned view mutations cannot mutate internal policy state', () => {
  const p = new AllowedSessionsPolicy();
  const context = { ...A }, supplied = { ...target };
  const h = p.enroll(context, { alias: 'shop', target: supplied }, [supplied]);
  supplied.sessionId = 'mutated'; context.threadId = 'mutated';
  // Deliberately bypass readonly types to test runtime copy isolation.
  const views = p.list(A) as unknown as { target: { sessionId: string }; rights: string[] }[];
  views[0].target.sessionId = 'mutated'; views[0].rights.push('send'); views.length = 0;
  const decision = p.authorize(A, h, 'read', [target]) as { sessionId: string };
  decision.sessionId = 'mutated';
  assert.deepEqual(p.authorize(A, h, 'read', [target]), target);
  deny('SEND_NOT_GRANTED', () => p.authorize(A, h, 'send', [target]));
  assert.equal(Object.isFrozen(h), true);
});

test('namespace tuple encoding is collision-safe and errors reveal no foreign state', () => {
  const p = new AllowedSessionsPolicy();
  const c1 = { hostProfile: 'a|b', principal: 'c', threadId: 'd' };
  const c2 = { hostProfile: 'a', principal: 'b|c', threadId: 'd' };
  const h = p.enroll(c1, { alias: 'private-alias', target }, [target]);
  assert.deepEqual(p.list(c2), []);
  deny('STALE_HANDLE', () => p.authorize(c2, h, 'read', [target]));
  try { p.resolve(c2, 'private-alias', [target]); }
  catch (e) { assert.equal((e as Error).message, 'NOT_ALLOWED'); }
});
