import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, renameSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readInstallationState, assertLocalInstallation, INSTALLATION_STATE_MAX_BYTES } from './installation-state.js';

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fleet-state-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.ai'));
  const state = join(root, '.ai/agent-fleet-state.json');
  writeFileSync(state, JSON.stringify({ schemaVersion: 2, taskTriageSelected: true }));
  return { root, state };
}
test('local ledger is re-read without Git or runtime identity requirements', t => {
  const { root, state } = fixture(t);
  assert.equal(readInstallationState(root).status, 'local');
  assert.equal(readInstallationState(root).statePath, state);
  writeFileSync(state, '{"schemaVersion":2,"taskTriageSelected":false}');
  assert.equal(readInstallationState(root).state.taskTriageSelected, false);
  assert.equal(readInstallationState(root).explicitOwner, undefined);
});
test('missing local state preserves manual configuration, without searching children', t => {
  const { root, state } = fixture(t);
  rmSync(state);
  mkdirSync(join(root, 'child/.ai'), { recursive: true });
  writeFileSync(join(root, 'child/.ai/agent-fleet-state.json'), '{"schemaVersion":2}');
  assert.equal(readInstallationState(root).status, 'missing');
  assert.doesNotThrow(() => assertLocalInstallation(root));
  writeFileSync(state, '{"schemaVersion":1}');
  assert.equal(readInstallationState(root).status, 'local');
});
test('retired owner field refuses regardless of value or local state', t => {
  const { root, state } = fixture(t);
  for (const value of ['child', '../child', null, false, '']) {
    writeFileSync(join(root, '.ai/agent-fleet.json'), JSON.stringify({ installationOwner: value }));
    const result = readInstallationState(root);
    assert.equal(result.status, 'invalid');
    assert.equal(result.reason, 'installation_owner_removed');
    assert.equal(result.state, undefined);
    assert.throws(() => assertLocalInstallation(root), /installationOwner is no longer supported/);
  }
  rmSync(state);
  assert.equal(readInstallationState(root).status, 'invalid');
});
for (const kind of ['malformed', 'schema', 'oversized', 'directory', 'state-link', 'ai-link', 'selection', 'nul', 'utf8']) {
  test(`local state fails closed: ${kind}`, t => {
    const { root, state } = fixture(t);
    if (kind === 'malformed') writeFileSync(state, '{private-fragment');
    if (kind === 'schema') writeFileSync(state, '{"schemaVersion":99}');
    if (kind === 'oversized') writeFileSync(state, ' '.repeat(INSTALLATION_STATE_MAX_BYTES + 1));
    if (kind === 'directory') { rmSync(state); mkdirSync(state); }
    if (kind === 'state-link') { renameSync(state, state + '.real'); symlinkSync(state + '.real', state); }
    if (kind === 'ai-link') { renameSync(join(root, '.ai'), join(root, 'ai-real')); symlinkSync(join(root, 'ai-real'), join(root, '.ai')); }
    if (kind === 'selection') writeFileSync(state, '{"schemaVersion":2,"taskTriageSelected":"yes"}');
    if (kind === 'nul') writeFileSync(state, Buffer.from([0]));
    if (kind === 'utf8') writeFileSync(state, Buffer.from([0xff]));
    const result = readInstallationState(root);
    assert.equal(result.status, 'invalid');
    assert.equal(result.state, undefined);
    assert.ok(!JSON.stringify(result).includes('private-fragment'));
  });
}
test('linked human config refuses even if local state is missing', t => {
  const { root, state } = fixture(t);
  rmSync(state);
  writeFileSync(join(root, 'desired.json'), '{}');
  symlinkSync(join(root, 'desired.json'), join(root, '.ai/agent-fleet.json'));
  assert.equal(readInstallationState(root).reason, 'source_denied');
});
test('a corrupt human configuration is named as such, never as installation evidence', t => {
  const { root } = fixture(t);
  for (const text of ['{private-fragment', '[]', 'null']) {
    writeFileSync(join(root, '.ai/agent-fleet.json'), text);
    const result = readInstallationState(root);
    assert.equal(result.status, 'invalid'); assert.equal(result.reason, 'invalid_desired');
    assert.ok(!JSON.stringify(result).includes('private-fragment'));
    assert.throws(() => assertLocalInstallation(root), /\.ai\/agent-fleet\.json is not a JSON object/);
  }
});
test('configuration changed during state read is refused', t => {
  const { root } = fixture(t);
  writeFileSync(join(root, '.ai/agent-fleet.json'), '{}');
  const result = readInstallationState(root, { afterStateRead: () => {
    writeFileSync(join(root, '.ai/agent-fleet.json'), '{"features":{}}');
  } });
  assert.equal(result.status, 'invalid'); assert.equal(result.reason, 'source_changed');
});
test('replacement during bounded state read is refused', t => {
  const { root, state } = fixture(t);
  const result = readInstallationState(root, { afterStateRead: () => {
    renameSync(state, state + '.old'); writeFileSync(state, '{"schemaVersion":2}');
  } });
  assert.equal(result.status, 'invalid'); assert.equal(result.reason, 'source_changed');
});
