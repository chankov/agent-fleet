import test from 'node:test';
import assert from 'node:assert/strict';
import { driveClaude, respondToClaudePrompt, type ClaudeDrivePorts } from './coms-claude-bridge.ts';
import { completionSentinel, REPLY_TIMEOUT_HARD_CAP_MS } from './lib/claude-bridge-core.ts';

function fixture(kind: string) {
 let now = 0, prompt = '', submitted = 0, enters = 0, polls = 0;
 const sent: any[] = [], logs: string[] = [];
 const env: any = { msg_id: 'current', prompt: 'Make a plan', sender_name: 'hub', sender_cwd: '/repo', sender_endpoint: '/fake' };
 const d: ClaudeDrivePorts = {
  paneId: 'fake', replyTimeoutMs: 5000, hookSeen: () => kind === 'hook', markHookSeen() {},
  readHook: () => kind === 'hook' ? { mtime: submitted ? 2 : 1, raw: '{"text":"hook reply"}' } : kind === 'unchanged' ? { mtime: 1, raw: '{"text":"stale"}' } : kind === 'malformed' ? { mtime: submitted ? 2 : 1, raw: '{' } : null,
  paneStatus: async () => {
   if (kind === 'busy') return 'working';
   if (!submitted) return 'idle';
   polls++; if (kind === 'blocked') return 'blocked';
   return polls === 1 ? 'working' : 'idle';
  },
  readPane: async () => kind === 'valid' || kind === 'late' && now > 5000 ? `${prompt}\n● Actual reply\nsecond line\n${completionSentinel(env.msg_id)}\n❯` : kind === 'quoted' ? `${prompt}\nexplained\n> ${completionSentinel(env.msg_id)}` : kind === 'foreign' ? `${prompt}\nforeign reply\n${completionSentinel('other')}` : kind === 'stale' ? `stale reply\n${completionSentinel(env.msg_id)}` : prompt,
  sendText: async text => { prompt = text; submitted++; }, sendEnter: async () => { enters++; },
  now: () => now, sleep: async ms => { now += ms; }, log: text => logs.push(text),
 };
 return { env, d, sent, logs, stats: () => ({ now, submitted, enters }), run: () => respondToClaudePrompt(env, {} as any, () => driveClaude(env, d), async (_endpoint, envelope) => { sent.push(envelope); }, text => logs.push(text)) };
}
for (const kind of ['echo', 'foreign', 'stale', 'quoted', 'unchanged', 'malformed']) test(`${kind} status transition never emits success`, async () => {
 const f = fixture(kind); await f.run(); assert.equal(f.sent.length, 0);
 assert.equal(f.stats().submitted, 1); assert.equal(f.stats().enters, 1);
 assert.ok(f.stats().now >= REPLY_TIMEOUT_HARD_CAP_MS); assert.match(f.logs.join('\n'), /pending/);
});
for (const kind of ['valid', 'late', 'hook']) test(`${kind} completes original request exactly once`, async () => {
 const f = fixture(kind); await f.run(); assert.equal(f.sent.length, 1);
 assert.equal(f.sent[0].msg_id, 'current'); assert.equal(f.stats().submitted, 1);
 assert.equal(f.sent[0].error, null);
 if (kind === 'late') assert.match(f.logs.join('\n'), /pending/);
});
for (const kind of ['busy', 'blocked']) test(`${kind} remains a distinct bounded error`, async () => {
 const f = fixture(kind); await f.run(); assert.equal(f.sent.length, 1);
 assert.match(f.sent[0].error, kind === 'busy' ? /mid-turn/ : /permission prompt/);
 assert.equal(f.stats().submitted, kind === 'busy' ? 0 : 1);
 assert.ok(f.stats().now < REPLY_TIMEOUT_HARD_CAP_MS);
});

test('hook changed during busy waiting is pre-request, not fresh completion', async () => {
 const f = fixture('unchanged'); let probes = 0;
 f.d.paneStatus = async () => ++probes === 1 ? 'working' : probes === 3 ? 'working' : 'idle';
 f.d.readHook = () => ({ mtime: probes > 0 ? 2 : 1, raw: '{"text":"previous turn"}' });
 await f.run(); assert.equal(f.sent.length, 0); assert.equal(f.stats().submitted, 1);
});
