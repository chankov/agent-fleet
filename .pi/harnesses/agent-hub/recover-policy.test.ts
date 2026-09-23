import assert from 'node:assert/strict';
import test from 'node:test';
import { RECOVERY_CATEGORIES } from './recovery-contract.ts';
import { assessRecovery, renderRecoveryInvocation } from './recover-policy.ts';
import { createRecoverState } from './recover-state.ts';

test('all categories prohibit automatic execution; settled indeterminate requires consumed one-use human grant, not changed fingerprint', () => {
 for (const category of RECOVERY_CATEGORIES) {
  const d = assessRecovery(category, { explicitInvocation: true });
  assert.equal(d.automaticRetry, false); assert.equal(d.waitOrQueue, false); assert.equal(d.allowed, false);
 }
 for (const changed of [true, false]) {
  const base = { explicitInvocation: true, relevantConditionsChanged: changed, executorIdle: true, processSettled: true, freshOneUseAuthorization: true, indeterminateGrantUsed: true };
  assert.equal(assessRecovery('indeterminate', base).allowed, true);
  for (const missing of ['explicitInvocation','executorIdle','processSettled','freshOneUseAuthorization','indeterminateGrantUsed'] as const) {
   assert.equal(assessRecovery('indeterminate', { ...base, [missing]: false }).allowed, false, missing);
  }
 }
 assert.equal(assessRecovery('tool_protocol_error', { explicitInvocation: true, relevantConditionsChanged: true, freshOneUseAuthorization: true }).allowed, false);
 assert.equal(assessRecovery('unknown_tool', { explicitInvocation: true, relevantConditionsChanged: true, freshOneUseAuthorization: true }).allowed, false);
});

test('renderer only emits exact validated code-owned commands, without starting work', () => {
 const s = createRecoverState(); const a = s.start('task', 'contract', 'builder', 'dispatch')!;
 assert.equal(renderRecoveryInvocation(s, a.operationId, a.attemptId), `/af-recover retry ${a.operationId} ${a.attemptId}`);
 assert.equal(renderRecoveryInvocation(s, a.operationId, a.attemptId, 'inspect'), `/af-recover inspect ${a.operationId}`);
 assert.equal(renderRecoveryInvocation(s, a.operationId, 'other'), null);
 assert.equal(renderRecoveryInvocation(s, a.operationId, 'x;echo'), null);
 assert.equal(s.inspect(a.operationId)?.attempts.length, 1);
});
