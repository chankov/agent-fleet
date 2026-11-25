import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAccessApprovalRouter } from '../agent-hub/access-approval.ts';
import { createDamageApproval } from '../agent-hub/damage-guard-approval.ts';
import { createDamageState } from '../agent-hub/damage-guard-state.ts';
import { requestRuntimeAsk } from '../ask-user-remote/runtime-ask.ts';
import type { AccessRequest } from '../lib/damage-control-shared.ts';

const hook = registerHooks({
 resolve(specifier, context, nextResolve) {
  if (specifier === '@mariozechner/pi-coding-agent') return {
   url: 'data:text/javascript,export const isToolCallEventType = (tool, event) => event.toolName === tool;', shortCircuit: true,
  };
  return nextResolve(specifier, context);
 },
});
const { default: extension } = await import('./index.ts');
hook.deregister();

type Reply = 'enter' | 'decline' | 'escape' | 'missing' | 'timeout';
function selector() {
 let reply: Reply = 'enter';
 const scripted: Reply[] = [];
 const seen: number[] = [];
 return {
  setReply(value: Reply) { reply = value; }, seen, scripted,
  async select(_title: string, options: string[], { timeout, signal }: { timeout?: number; signal?: AbortSignal }) {
   if (timeout !== undefined) seen.push(timeout);
   const action = scripted.shift() ?? reply;
   if (action === 'timeout') return new Promise<undefined>(resolve => {
    const timer = timeout === undefined ? undefined : setTimeout(resolve, timeout);
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(undefined); }, { once: true });
   });
   if (action === 'missing') return undefined;
   // Model Pi's selector: the first row has focus but produces no reply until a key is pressed.
   let focused = 0;
   const keys = action === 'escape' ? ['Escape'] : action === 'decline'
    ? [...Array(options.findIndex(option => /^(Keep blocked|Deny)/.test(option))).fill('Down'), 'Enter']
    : ['Enter'];
   for (const key of keys) {
    if (key === 'Escape') return undefined;
    if (key === 'Down') focused++;
    if (key === 'Enter') return options[focused];
   }
  },
 };
}

for (const { toolName, input, timeout } of [
 { toolName: 'read', input: { path: 'secret.txt' }, timeout: 60_000 },
 { toolName: 'bash', input: { command: 'rm -- keep.txt' }, timeout: 60_000 },
 { toolName: 'bash', input: { command: 'docker stop fixture' }, timeout: 30_000 },
]) test(`local ${JSON.stringify(input)}: Enter permits only one call; other outcomes block`, async t => {
 const cwd = mkdtempSync(join(tmpdir(), 'dc-approval-default-'));
 t.after(() => rmSync(cwd, { recursive: true, force: true }));
 mkdirSync(join(cwd, '.pi'));
 writeFileSync(join(cwd, '.pi/damage-control-rules.yaml'), JSON.stringify({
  zeroAccessPaths: ['secret.txt'], noDeletePaths: ['keep.txt'],
  bashToolPatterns: [{ pattern: '\\bdocker\\s+stop\\b', reason: 'Fixture approval required', ask: true }],
 }));
 const handlers = new Map<string, Function>();
 const records: any[] = [];
 extension({ on: (event: string, fn: Function) => handlers.set(event, fn), registerCommand() {}, appendEntry(_type: string, data: unknown) { records.push(data); } } as any);
 const keys = selector();
 const ctx = { cwd, hasUI: true, ui: { ...keys, setStatus() {}, notify() {} } };
 await handlers.get('session_start')!({ type: 'session_start' }, ctx);
 let call = 0;
 const invoke = () => handlers.get('tool_call')!({ type: 'tool_call', toolName, input, toolCallId: String(++call) }, ctx);
 assert.notEqual((await invoke())?.block, true);
 for (const reply of ['escape', 'missing', 'timeout', 'decline'] as const) {
  keys.setReply(reply);
  if (reply === 'timeout') t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = invoke();
  if (reply === 'timeout') {
   await new Promise(resolve => setImmediate(resolve));
   t.mock.timers.tick(timeout);
   t.mock.timers.reset();
  }
  assert.equal((await pending)?.block, true, reply);
 }
 assert.deepEqual(keys.seen, Array(5).fill(timeout));
 assert.equal(records.filter(r => r?.action === 'blocked_by_user').length, 1);
});

test('dispatcher legacy dialog: distinct request IDs do not share a single Enter', async () => {
 const keys = selector();
 const router = createAccessApprovalRouter({
  getContext: () => ({ hasUI: true, ui: { ...keys, notify() {} } }),
  getExemptionsFile: () => undefined, appendLog() {}, now: () => new Date().toISOString(),
 });
 const request = (id: string): AccessRequest => ({ type: 'access_request', msg_id: id,
  sender_session: 'fixture', sender_endpoint: '', agent: 'fixture', timestamp: new Date().toISOString(), hops: 0,
  tool: 'read', category: 'zero_access', rule: 'protected read', pattern: 'secret.txt', invocation: 'secret.txt',
 });
 const dispatch = async (id: string) => {
  let output = '';
  await router.handle({ write(chunk) { output += chunk; }, end() {} }, request(id));
  return JSON.parse(output).decision;
 };
 keys.scripted.push('enter', 'missing');
 const first = dispatch('one');
 const second = dispatch('two');
 assert.equal(await first, 'allow_once');
 assert.equal(await second, 'deny');
 assert.deepEqual(keys.seen, [60_000, 60_000]);
});

test('semantic permission adapter: Enter is single-use, not remembered for identical subsequent actions', async t => {
 const keys = selector();
 const input = { command: 'echo approval-fixture' };
 let current = { taskId: 'task', inputRevision: 'rev', operation: 'bash' as const,
  target: createHash('sha256').update(JSON.stringify(input)).digest('hex'), cwd: '/repo',
  actionId: 'first', owner: 'hub', attempt: 'fixture',
 };
 const ctx = { hasUI: true, ui: keys } as Parameters<typeof requestRuntimeAsk>[3];
 const approval = createDamageApproval({ current: () => current, baseline: () => true,
  state: createDamageState(() => {}),
  ask: (id, question, signal) => requestRuntimeAsk({ emit() {} }, id, question, ctx, signal, undefined, 'permission'),
 });
 const answer = await approval.request(current, input);
 assert.equal(answer.status, 'allowed');
 assert.ok(answer.status === 'allowed' && approval.consume(answer.grant, current));
 assert.equal(approval.consume(answer.grant, current), false);
 for (const reply of ['escape', 'missing', 'timeout', 'decline'] as const) {
  current = { ...current, actionId: reply };
  keys.setReply(reply);
  if (reply === 'timeout') t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = approval.request(current, input);
  if (reply === 'timeout') {
   await new Promise(resolve => setImmediate(resolve));
   t.mock.timers.tick(600_000);
   t.mock.timers.reset();
  }
  assert.equal((await pending).status, reply === 'decline' ? 'denied' : reply === 'timeout' ? 'expired' : 'cancelled');
 }
});
