import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { actionPresentation, confirmTaskTriageAction, consumeActionGrant } from './task-triage-authorization.ts';
import { containsCommunicationSecret } from './system1-communication-store.ts';
import { resetIdenticalDialogs } from '../lib/identical-dialog.ts';

const cwd = '/synthetic/workspace';
function bound(content: string) {
 const input = { path: 'example.py', content };
 return { input, action: { taskId: 't1', inputRevision: 'r1', actionId: 'call1', operation: 'write', cwd,
  target: createHash('sha256').update(JSON.stringify(input)).digest('hex') } };
}
test('Python constructor indirection reaches exact one-use approval without changing diagnostic redaction', async () => {
 resetIdenticalDialogs();
 const content = 'class Client:\n def __init__(self, authorization):\n  self.authorization = authorization\n  self.base=base;self.authorization=authorization\n';
 const { input, action } = bound(content);
 assert.equal(containsCommunicationSecret(content), true, 'diagnostic copies remain conservative');
 assert.ok(actionPresentation(action, { input, cwd }));
 let asks = 0, persisted = 0;
 const grant = await confirmTaskTriageAction(action, {
  taskId: () => 't1', inputRevision: () => 'r1', startWait() {}, endWait() {},
  ask: async (id, question) => { asks++; assert.ok(question.context.includes(content.split('\n')[2]));
   return { details: { runtimeAsk: { requestId: id }, response: { kind: 'selection', selections: [question.options[0]] } } }; },
 }, {} as any, () => { persisted++; return true; }, undefined, { input, cwd });
 assert.ok(grant); assert.equal(asks, 1); assert.equal(persisted, 1);
 assert.equal(consumeActionGrant(grant, action), true);
 assert.equal(consumeActionGrant(grant, action), false);
});
test('indirection exception does not hide literals, other values or neighboring secrets', () => {
 for (const content of [
  'self.authorization = "synthetic-value"',
  'self.authorization = syntheticValue',
  'authorization = authorization',
  'self.authorization = authorization + "synthetic-value"',
  'self.authorization = authorization; password=synthetic-value',
  'self.authorization = authorization\npassword=synthetic-value',
  'self.authorization = authorization\nBearer synthetic-value',
  'self.authorization = authorization\nghp_syntheticvalue',
 ]) {
  const { input, action } = bound(content);
  assert.equal(actionPresentation(action, { input, cwd }), null, content);
 }
});
test('unsafe inputs report refusal before any approval or persisted grant', async () => {
 const { input, action } = bound('self.authorization = "synthetic-value"');
 let reason = '';
 const grant = await confirmTaskTriageAction(action, {
  taskId: () => 't1', inputRevision: () => 'r1', startWait() {}, endWait() {},
  presentationRefused: value => { reason = value; },
  ask: async () => { assert.fail('unsafe input must not reach the dialog'); },
 }, {} as any, () => { assert.fail('unsafe input must not persist authority'); }, undefined, { input, cwd });
 assert.equal(grant, null); assert.equal(reason, 'unsafe_text');
});
test('source indirection is presentable in bash heredocs and edits too', () => {
 const code = 'self.base=base;self.authorization=authorization';
 for (const [operation, input] of [
  ['bash', { command: `python3 - <<'PY'\n${code}\nPY` }],
  ['edit', { path: 'example.py', oldText: code, newText: `${code}\nprint(1)` }],
 ] as const) {
  const action = { ...bound('').action, operation, target: createHash('sha256').update(JSON.stringify(input)).digest('hex') };
  assert.ok(actionPresentation(action, { input, cwd }));
 }
});
test('refusal diagnostics identify unsafe text, size and hash without disclosing input', () => {
 for (const [content, expected] of [['password=synthetic-value', 'unsafe_text'], ['x'.repeat(9000), 'presentation_too_large']] as const) {
  const { input, action } = bound(content); let reason = '';
  assert.equal(actionPresentation(action, { input, cwd }, r => { reason = r; }), null);
  assert.equal(reason, expected);
 }
 const { input, action } = bound('safe'); let reason = '';
 assert.equal(actionPresentation({ ...action, target: 'wrong' }, { input, cwd }, r => { reason = r; }), null);
 assert.equal(reason, 'input_binding_mismatch');
});
