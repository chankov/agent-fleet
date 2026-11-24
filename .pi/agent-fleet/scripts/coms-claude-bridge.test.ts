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
 return { env, d, sent, logs, stats: () => ({ now, submitted, enters, prompt }), run: () => respondToClaudePrompt(env, {} as any, () => driveClaude(env, d), async (_endpoint, envelope) => { sent.push(envelope); }, text => logs.push(text)) };
}
for (const kind of ['echo', 'foreign', 'stale', 'quoted', 'unchanged', 'malformed', 'blocked']) test(`${kind} status transition never emits success`, async () => {
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
for (const finishes of [true, false]) test(`P16 review hook waits for same-request final: ${finishes}`, async () => {
 const f = fixture('hook'); f.env.review_protocol = 'v1';
 f.d.readHook = () => {
  const { now, submitted } = f.stats();
  const frame = { msg_id: finishes || now < 5000 ? 'current' : 'foreign', phase: now > 5000 ? 'final' : 'progress', verdict: 'REJECT', report: 'findings' };
  return { mtime: submitted ? now + 2 : 1, raw: JSON.stringify({ text: JSON.stringify(frame) }) };
 };
 await f.run(); assert.match(f.logs.join('\n'), /pending/);
 assert.equal(f.stats().submitted, 1); assert.equal(f.sent.length, finishes ? 1 : 0);
 if (finishes) assert.equal(JSON.parse(f.sent[0].response).phase, 'final');
});
for (const transport of ['hook', 'pane']) test(`P16 ${transport}: latest standalone correlated frame completes after timeout`, async () => {
 const f = fixture(transport); f.env.review_protocol = 'v1';
 const frame = JSON.stringify({ msg_id: 'current', phase: 'final', verdict: 'REJECT', report: 'late findings' });
 const reply = () => {
  const now = f.stats().now;
  if (now < 4000) return `Example only:\n${frame}`;
  if (now < 6000) return frame.replace('current', 'foreign');
  if (now < 8000) return `${frame}\n${frame}`;
  if (now < 10000) return frame.replace('"current"', '"foreign","msg_id":"current"');
  return '```json\n' + (transport === 'pane' ? frame.replace('findings', 'find\nings') : frame) + '\n```';
 };
 f.d.readHook = () => transport === 'hook' ? { mtime: f.stats().now + 1, raw: JSON.stringify({ text: reply() }) } : null;
 f.d.readPane = async () => `${f.stats().prompt}\n● {"msg_id":"current","phase":"progress"}\n● ${reply()}\n${completionSentinel('current')}\n❯`;
 await f.run();
 assert.equal(f.sent.length, 1); assert.deepEqual(JSON.parse(f.sent[0].response), JSON.parse(frame));
 assert.equal(f.stats().submitted, 1); assert.ok(f.stats().now >= 10000); assert.match(f.logs.join(' '), /wrong_id/);
});

for (const marked of [true, false]) test(`P16 cumulative pane: final follows prose progress (marked=${marked})`, async () => {
 const f = fixture('pane'); f.env.review_protocol = 'v1';
 const marker = completionSentinel('current');
 const report = 'Two findings\nSecond paragraph';
 const final = JSON.stringify({msg_id:'current',phase:'final',verdict:'APPROVE',report});
 f.d.readPane = async () => `${f.stats().prompt}\n● Checking tests${marked ? '\n'+marker : ''}${f.stats().now > 7000 ? '\n● '+final.replace('Two findings','Two\n  findings')+'\n'+marker : ''}\n❯`;
 await f.run();
 assert.equal(f.stats().submitted, 1); assert.equal(f.sent.length, 1);
 assert.equal(JSON.parse(f.sent[0].response).report, report); assert.match(f.logs.join(' '), /pending/);
});

for (const token of ['report','current-id','phase','final']) test(`P16 narrow macOS pane hard-wraps compact frame inside ${token}`, async () => {
 const f = fixture('pane'); f.env.review_protocol = 'v1'; f.env.msg_id = '01M8236ZTSA3VYMFX9WZZCRJ2T';
 const frame = JSON.stringify({msg_id:f.env.msg_id,phase:'final',verdict:'REJECT',report:'remaining blocker'});
 const cut = frame.indexOf(token === 'current-id' ? f.env.msg_id : token) + 3;
 f.d.readPane = async () => `${f.stats().prompt}\n⏺ Checking\n⏺ ${frame.slice(0,cut)}\n  ${frame.slice(cut)}\n${completionSentinel(f.env.msg_id)}\n❯`;
 await f.run(); assert.equal(f.stats().submitted,1); assert.equal(f.sent.length,1); assert.deepEqual(JSON.parse(f.sent[0].response),JSON.parse(frame));
});

test('busy before submission remains a bounded error', async () => {
 const f = fixture('busy'); await f.run(); assert.equal(f.sent.length, 1);
 assert.match(f.sent[0].error, /mid-turn/);
 assert.equal(f.stats().submitted, 0);
 assert.ok(f.stats().now < REPLY_TIMEOUT_HARD_CAP_MS);
});

test('hook changed during busy waiting is pre-request, not fresh completion', async () => {
 const f = fixture('unchanged'); let probes = 0;
 f.d.paneStatus = async () => ++probes === 1 ? 'working' : probes === 3 ? 'working' : 'idle';
 f.d.readHook = () => ({ mtime: probes > 0 ? 2 : 1, raw: '{"text":"previous turn"}' });
 await f.run(); assert.equal(f.sent.length, 0); assert.equal(f.stats().submitted, 1);
});
