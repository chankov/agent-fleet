// Synthetic namespace only. Never opens the real native policy or journal.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { ActionLedger, InstructionStoreError } from './lib/fleet-codex-instruction-store.ts';
import { LocalCodexMcp, TOOLS } from './lib/fleet-codex-local-mcp.ts';
const meta = { threadId: '11111111-1111-4111-8111-111111111111' };
const context = { hostProfile: 'fixture', principal: 'owner', threadId: meta.threadId };
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const hash = sha(JSON.stringify(Object.values(context)));
const target = { project: 'fixture', peer: 'orchestrator', sessionId: 'S1', startedAt: '2026-01-01T00:00:00.000Z' };
function fixture(t: any) {
 const root = fs.mkdtempSync(join(tmpdir(), 's6b-upgrade-mcp-'));
 t.after(() => fs.rmSync(root, { recursive: true, force: true }));
 const policyRoot = join(root, 'policy'), journal = policyRoot + '.instructions'; fs.mkdirSync(journal, { mode: 0o700 });
 const receipt = { operation: 'instruction', requestId: 'fixture-old', target, digest: 'a'.repeat(64), wireId: sha(JSON.stringify([JSON.stringify(Object.values(context)), 'fixture-old'])), state: 'result', attempted: true, createdAt: target.startedAt, updatedAt: target.startedAt, detail: null, result: 'FIXTURE_ACK', truncated: false };
 const raw = JSON.stringify({ format: 'fleet-instruction-intents', version: 1, storeId: '11111111-1111-4111-8111-111111111111', namespace: context, revision: 7, records: [receipt] });
 const path = join(journal, hash + '.json'), marker = 'v1:11111111-1111-4111-8111-111111111111';
 fs.writeFileSync(path, raw, { mode: 0o600 }); fs.writeFileSync(path + '.marker', marker, { mode: 0o600 });
 let clock = 0, remoteCalls = 0;
 const service = new LocalCodexMcp({ registryRoot: join(root, 'registry'), policyRoot, hostProfile: context.hostProfile, principal: context.principal, monotonic: () => clock, registryReader: async () => { remoteCalls++; throw Error('upgrade has no registry or peer access'); } });
 return { service, policyRoot, root, path, raw, marker, journal, receipt, clock: (n: number) => { clock = n; }, remoteCalls: () => remoteCalls };
}
test('upgrade source catalog has two strict tools; no model identity/root/consent parameters', () => {
 assert.equal(TOOLS.length, 24);
 for (const name of ['fleet_journal_upgrade_prepare', 'fleet_journal_upgrade_commit']) {
  const tool = TOOLS.find(t => t.name === name)!; assert.ok(tool); assert.equal(tool.inputSchema.additionalProperties, false);
  assert.match(tool.description, /human|quiescen/i);
 }
});
test('native preview is read-only; exact commit preserves old values, marker and raw backup', async t => {
 const f = fixture(t), p: any = await f.service.call('fleet_journal_upgrade_prepare', {}, meta);
 assert.equal(p.status, 'prepared'); assert.equal(p.requiresQuiescentWriters, true); assert.equal(p.requiresHumanConfirmation, true);
 assert.deepEqual(p.namespace, context); assert.equal(p.expected.revision, 7); assert.equal(p.expected.recordCount, 1); assert.equal(p.expected.sourceSha256, sha(f.raw));
 assert.equal(p.journalRoot, f.journal); assert.equal(fs.readFileSync(f.path, 'utf8'), f.raw); assert.equal(fs.readdirSync(f.journal).length, 2);
 const committed: any = await f.service.call('fleet_journal_upgrade_commit', { proposalId: p.proposalId }, meta);
 assert.equal(committed.status, 'committed'); assert.equal(committed.revision, 8); assert.equal(committed.humanProvenance, 'unknown');
 const bytes = fs.readFileSync(f.path, 'utf8'), state = JSON.parse(bytes);
 assert.equal(state.version, 2); assert.deepEqual(state.records, [{ receipt: f.receipt, authorization: null }]);
 assert.equal(fs.readFileSync(f.path + '.marker', 'utf8'), f.marker); assert.equal(fs.readFileSync(join(f.journal, state.upgrade.backupName), 'utf8'), f.raw);
 assert.equal(p.backupPath, join(f.journal, state.upgrade.backupName));
 assert.deepEqual(await f.service.call('fleet_journal_upgrade_commit', { proposalId: p.proposalId }, meta), committed);
 assert.equal(fs.readFileSync(f.path, 'utf8'), bytes); assert.equal(f.remoteCalls(), 0);
 f.clock(300000);
 for (let i = 0; i < 16; i++) await f.service.call('fleet_binding_prepare', { intent: 'initialize_empty' }, meta);
 await assert.rejects(() => f.service.call('fleet_binding_prepare', { intent: 'initialize_empty' }, meta), /BUSY/);
});
test('upgrade rejects foreign/restarted/expired proposals and cancelled commit without mutation', async t => {
 const f = fixture(t), p: any = await f.service.call('fleet_journal_upgrade_prepare', {}, meta);
 await assert.rejects(() => f.service.call('fleet_journal_upgrade_commit', { proposalId: p.proposalId }, { threadId: '22222222-2222-4222-8222-222222222222' }), /PROPOSAL_UNAVAILABLE/);
 const restarted = new LocalCodexMcp({ registryRoot: join(f.root, 'registry'), policyRoot: f.policyRoot, hostProfile: context.hostProfile, principal: context.principal });
 await assert.rejects(() => restarted.call('fleet_journal_upgrade_commit', { proposalId: p.proposalId }, meta), /PROPOSAL_UNAVAILABLE/);
 const cancelled = new AbortController(); cancelled.abort();
 await assert.rejects(() => f.service.call('fleet_journal_upgrade_commit', { proposalId: p.proposalId }, meta, cancelled.signal), /REQUEST_CANCELLED/);
 f.clock(300000);
 await assert.rejects(() => f.service.call('fleet_journal_upgrade_commit', { proposalId: p.proposalId }, meta), /PROPOSAL_UNAVAILABLE/);
 assert.equal(fs.readFileSync(f.path, 'utf8'), f.raw);
});
test('changed snapshot and busy lock fail closed; failed proposal never retries', async t => {
 const f = fixture(t), p: any = await f.service.call('fleet_journal_upgrade_prepare', {}, meta);
 fs.writeFileSync(f.path + '.lock', 'occupied', { mode: 0o600 });
 await assert.rejects(() => f.service.call('fleet_journal_upgrade_commit', { proposalId: p.proposalId }, meta), /INTENT_BUSY/);
 fs.unlinkSync(f.path + '.lock');
 await assert.rejects(() => f.service.call('fleet_journal_upgrade_commit', { proposalId: p.proposalId }, meta), /INTENT_BUSY/);
 const other: any = await f.service.call('fleet_journal_upgrade_prepare', {}, meta);
 const changed = JSON.parse(f.raw); changed.revision++; fs.writeFileSync(f.path, JSON.stringify(changed));
 await assert.rejects(() => f.service.call('fleet_journal_upgrade_commit', { proposalId: other.proposalId }, meta), /INTENT_STATE_CHANGED/);
 assert.equal(JSON.parse(fs.readFileSync(f.path, 'utf8')).version, 1);
});
test('upgrade and binding proposals cannot cross commit routes; identity and args validate before I/O', async t => {
 const f = fixture(t);
 await assert.rejects(() => f.service.call('fleet_journal_upgrade_prepare', { root: f.journal }, meta), /INVALID_ARGUMENTS/);
 await assert.rejects(() => f.service.call('fleet_journal_upgrade_prepare', {}, {}), /IDENTITY_REQUIRED/);
 const p: any = await f.service.call('fleet_journal_upgrade_prepare', {}, meta);
 await assert.rejects(() => f.service.call('fleet_binding_commit', { proposalId: p.proposalId }, meta), /PROPOSAL_UNAVAILABLE/);
 const binding: any = await f.service.call('fleet_binding_prepare', { intent: 'initialize_empty' }, meta);
 await assert.rejects(() => f.service.call('fleet_journal_upgrade_commit', { proposalId: binding.proposalId }, meta), /PROPOSAL_UNAVAILABLE/);
 assert.equal(fs.readFileSync(f.path, 'utf8'), f.raw); assert.equal(f.remoteCalls(), 0);
});
test('upgrade shares the sixteen proposal budget with binding and fails on missing journal', async t => {
 const f = fixture(t);
 for (let i = 0; i < 8; i++) await f.service.call('fleet_journal_upgrade_prepare', {}, meta);
 for (let i = 0; i < 8; i++) await f.service.call('fleet_binding_prepare', { intent: 'initialize_empty' }, meta);
 await assert.rejects(() => f.service.call('fleet_journal_upgrade_prepare', {}, meta), /BUSY/);
 await assert.rejects(() => f.service.call('fleet_binding_prepare', { intent: 'initialize_empty' }, meta), /BUSY/);
 fs.unlinkSync(f.path); fs.unlinkSync(f.path + '.marker'); f.clock(300000);
 await assert.rejects(() => f.service.call('fleet_journal_upgrade_prepare', {}, meta), /INTENT_STATE_CHANGED/);
 assert.equal(fs.readdirSync(f.journal).length, 0);
});

test('uncertain post-write result is sticky and never restores or repeats the upgrade', async t => {
 const f = fixture(t), p: any = await f.service.call('fleet_journal_upgrade_prepare', {}, meta);
 const original = ActionLedger.prototype.upgradeV1; let attempts = 0;
 ActionLedger.prototype.upgradeV1 = function (c, expected) { attempts++; original.call(this, c, expected); throw new InstructionStoreError('INTENT_COMMIT_UNCERTAIN'); };
 t.after(() => { ActionLedger.prototype.upgradeV1 = original; });
 await assert.rejects(() => f.service.call('fleet_journal_upgrade_commit', { proposalId: p.proposalId }, meta), /INTENT_COMMIT_UNCERTAIN/);
 assert.equal(JSON.parse(fs.readFileSync(f.path, 'utf8')).version, 2);
 await assert.rejects(() => f.service.call('fleet_journal_upgrade_commit', { proposalId: p.proposalId }, meta), /INTENT_COMMIT_UNCERTAIN/);
 assert.equal(attempts, 1); assert.equal(JSON.parse(fs.readFileSync(f.path, 'utf8')).revision, 8);
 const observed: any = await f.service.call('fleet_journal_upgrade_prepare', {}, meta);
 assert.equal(observed.status, 'observed'); assert.equal(observed.version, 2); assert.equal(observed.upgrade.sourceSha256, sha(f.raw));
 assert.equal('proposalId' in observed, false); assert.equal(attempts, 1);
});
