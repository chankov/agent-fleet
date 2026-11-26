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

for (const marked of [true, false]) test(`P16 cumulative pane: ambiguous final waits for exact hook after prose progress (marked=${marked})`, async () => {
 const f = fixture('pane'); f.env.review_protocol = 'v1';
 const marker = completionSentinel('current');
 const report = 'Two findings\nSecond paragraph';
 const final = JSON.stringify({msg_id:'current',phase:'final',verdict:'APPROVE',extra:[':'],report});
 f.d.readPane = async () => `${f.stats().prompt}\n● Checking tests${marked ? '\n'+marker : ''}${f.stats().now > 2200 ? '\n● '+final.replace('Two findings','Two\n  findings')+'\n'+marker : ''}\n❯`;
 f.d.readHook = () => f.stats().now > 4000 ? { mtime: 2, raw: JSON.stringify({text:final}) } : null;
 await f.run();
 assert.equal(f.stats().submitted, 1); assert.equal(f.sent.length, 1);
 assert.equal(JSON.parse(f.sent[0].response).report, report); assert.match(f.logs.join(' '), /pending/);
});

test('ambiguous wrap inside a review path reports failure without delivering altered findings', async () => {
 const f = fixture('pane'); f.env.review_protocol = 'v1';
 const frame = JSON.stringify({ msg_id: 'current', phase: 'final', verdict: 'REJECT', report: 'Fix src/worker.ts' });
 f.d.readPane = async () => `${f.stats().prompt}\n● ${frame.replace('current','cur\n  rent').replace('worker.ts','wor\n  ker.ts')}\n${completionSentinel('current')}\n❯`;
 await f.run();
 assert.equal(f.sent.length, 1);
 assert.equal(f.sent[0].response, null);
 assert.match(f.sent[0].error, /ambiguous.*wrap/i);
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

// ── read-only launch (PLAN-11-01, decision D3) ──
import {
 bridgeRegistryEntry, bridgeRegistryIdentity, claudeArgvIsReadOnly, claudeReadOnlyArgv, parseBridgeArgs,
 CLAUDE_READ_ONLY_DENIED_TOOLS, CLAUDE_READ_ONLY_TOOLS,
} from './coms-claude-bridge.ts';

const RESTRICTED = ['--tools', 'Read,Grep,Glob', '--disallowedTools', 'Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch', '--strict-mcp-config', '--permission-mode', 'dontAsk'];
const REG = { sessionId: '01KYFW92KPDGDYT3MAAM6JA6JN', name: 'code-reviewer', purpose: 'Claude Code (bridged pane, read-only)', endpoint: '/x.sock', cwd: '/repo', startedAt: '2026-07-26T18:00:00.000Z' };

test('the read-only claude argv keeps only Read/Grep/Glob, no MCP servers, mutating tools denied, nothing prompts', () => {
 assert.deepEqual(claudeReadOnlyArgv(), RESTRICTED);
 assert.deepEqual(claudeReadOnlyArgv({ model: 'opus', resume: 'abc-123' }), [...RESTRICTED, '--model', 'opus', '--resume', 'abc-123']);
 assert.deepEqual([...CLAUDE_READ_ONLY_TOOLS], ['Read', 'Grep', 'Glob']);
 for (const writer of ['Bash', 'Edit', 'Write', 'NotebookEdit']) assert.ok((CLAUDE_READ_ONLY_DENIED_TOOLS as readonly string[]).includes(writer), writer);
 assert.throws(() => claudeReadOnlyArgv({ model: '--dangerously-skip-permissions' }), /plain value/);
 assert.throws(() => claudeReadOnlyArgv({ resume: 'a\nb' }), /plain value/);
});

test('only --read-only makes the bridge launch Claude; the default bridge launches nothing', () => {
 const plain = parseBridgeArgs(['--name', 'code-reviewer', '--project', 'af']);
 assert.equal(plain.launch, null);
 assert.equal(plain.project, 'af');
 const ro = parseBridgeArgs(['--name', 'code-reviewer', '--project', 'af', '--read-only', '--model', 'opus']);
 assert.deepEqual(ro.launch, { argv: [...RESTRICTED, '--model', 'opus'] });
 assert.throws(() => parseBridgeArgs(['--name', 'x', '--model', 'opus']), /only with --read-only/);
 assert.throws(() => parseBridgeArgs(['--read-only']), /--name/);
});

test('the bridge declares read_only only for a Claude it launched with the restricted argv', () => {
 const recipeStarted = bridgeRegistryIdentity(REG);
 assert.equal(Object.hasOwn(recipeStarted, 'read_only'), false, 'no launch → no claim (today\'s _claude-peer)');
 assert.equal(Object.hasOwn(bridgeRegistryIdentity({ ...REG, launchedArgv: null }), 'read_only'), false);

 const launched = bridgeRegistryIdentity({ ...REG, launchedArgv: parseBridgeArgs(['--name', 'x', '--read-only', '--resume', 's1']).launch!.argv });
 assert.equal(launched.read_only, true);
 for (const now of ['2026-07-26T18:00:30.000Z', '2026-07-26T20:00:00.000Z']) {
  const entry = bridgeRegistryEntry(launched, { now, pid: 4242, queueDepth: 1 });
  assert.equal(entry.read_only, true, 'keepalive rebuilds carry the claim');
 }
 assert.equal(Object.hasOwn(bridgeRegistryEntry(recipeStarted, { now: 't', pid: 1, queueDepth: 0 }), 'read_only'), false, 'keepalive never invents it');

 // Anything short of the full restriction is not a claim.
 const weaker = [
  RESTRICTED.filter(arg => arg !== '--strict-mcp-config'),
  ['--tools', 'Read,Grep,Glob,Bash', ...RESTRICTED.slice(2)],
  [...RESTRICTED, '--dangerously-skip-permissions'],
  [...RESTRICTED, '--model'],
  [...RESTRICTED, '--model', 'a', '--model', 'b'],
  [...RESTRICTED, '--mcp-config', 'servers.json'],
  ['--model', 'opus'],
 ];
 for (const argv of weaker) {
  assert.equal(claudeArgvIsReadOnly(argv), false, argv.join(' '));
  assert.equal(Object.hasOwn(bridgeRegistryIdentity({ ...REG, launchedArgv: argv }), 'read_only'), false, argv.join(' '));
 }
});
