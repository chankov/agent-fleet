import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, renameSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readInstallationState, validateInstallationOwner } from './installation-owner.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'fleet-owner-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const owner = join(root, 'child');
  mkdirSync(join(root, '.ai')); mkdirSync(join(owner, '.ai'), { recursive: true });
  mkdirSync(join(owner, '.pi')); symlinkSync(join(owner, '.pi'), join(root, '.pi'));
  writeFileSync(join(root, '.ai/agent-fleet.json'), JSON.stringify({ installationOwner: 'child' }));
  const state = join(owner, '.ai/agent-fleet-state.json');
  writeFileSync(state, JSON.stringify({ schemaVersion: 2, taskTriageSelected: true }));
  return { root, owner, state };
}

test('owner path is concrete normalized relative directory', () => {
  assert.equal(validateInstallationOwner('nested/child'), 'nested/child');
  for (const value of ['', '.', '..', '../child', '/child', 'child/', 'a//b', 'a/../b', 'a/./b', 'a\\b', 1, null, 'child\n', 'a'.repeat(4097)]) {
    assert.throws(() => validateInstallationOwner(value));
  }
});
test('single owner ledger is re-read and a parent copy is only diagnosed', t => {
  const { root, owner, state } = fixture(t);
  writeFileSync(join(root, '.ai/agent-fleet-state.json'), '{stale');
  let result = readInstallationState(root);
  assert.equal(result.status, 'shared'); assert.equal(result.ownerRoot, owner);
  assert.equal(result.statePath, state); assert.equal(result.localStatePresent, true);
  assert.equal(result.state.taskTriageSelected, true);
  writeFileSync(state, JSON.stringify({ schemaVersion: 2, taskTriageSelected: false }));
  assert.equal(readInstallationState(root).state.taskTriageSelected, false);
});
test('no owner and no state retains manual configuration compatibility', t => {
  const { root } = fixture(t);
  rmSync(join(root, '.ai/agent-fleet.json'));
  assert.equal(readInstallationState(root).status, 'missing');
  writeFileSync(join(root, '.ai/agent-fleet-state.json'), '{"schemaVersion":1}');
  assert.equal(readInstallationState(root).status, 'local');
});
for (const kind of ['missing', 'malformed', 'schema', 'oversized', 'directory', 'state-link', 'ai-link', 'owner-link', 'unrelated', 'chain']) {
  test(`explicit owner fails closed: ${kind}`, t => {
    const { root, owner, state } = fixture(t);
    if (kind === 'missing') rmSync(state);
    if (kind === 'malformed') writeFileSync(state, '{');
    if (kind === 'schema') writeFileSync(state, '{"schemaVersion":99}');
    if (kind === 'oversized') writeFileSync(state, ' '.repeat(1024 * 1024 + 1));
    if (kind === 'directory') { rmSync(state); mkdirSync(state); }
    if (kind === 'state-link') { renameSync(state, state + '.real'); symlinkSync(state + '.real', state); }
    if (kind === 'ai-link') { renameSync(join(owner, '.ai'), join(owner, 'ai-real')); symlinkSync(join(owner, 'ai-real'), join(owner, '.ai')); }
    if (kind === 'owner-link') { renameSync(owner, owner + '-real'); symlinkSync(owner + '-real', owner); }
    if (kind === 'unrelated') { unlinkSync(join(root, '.pi')); mkdirSync(join(root, '.pi')); }
    if (kind === 'chain') writeFileSync(join(owner, '.ai/agent-fleet.json'), '{"installationOwner":"other"}');
    const result = readInstallationState(root);
    assert.equal(result.status, kind === 'missing' ? 'missing' : 'invalid');
    assert.equal(result.explicitOwner, true); assert.equal(result.state, undefined);
  });
}
test('owner configuration changed during state read is refused', t => {
  const { root, owner } = fixture(t);
  const result = readInstallationState(root, { afterStateRead: () => {
    writeFileSync(join(owner, '.ai/agent-fleet.json'), '{"installationOwner":"other"}');
  } });
  assert.equal(result.status, 'invalid'); assert.equal(result.reason, 'source_changed');
});

test('replacement during bounded read is refused', t => {
  const { root, state } = fixture(t);
  const result = readInstallationState(root, { afterStateRead: () => {
    renameSync(state, state + '.old'); writeFileSync(state, '{"schemaVersion":2}');
  } });
  assert.equal(result.status, 'invalid'); assert.equal(result.reason, 'source_changed');
});
