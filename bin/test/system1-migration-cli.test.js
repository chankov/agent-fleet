import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// macOS temporary paths can contain system symlinks (/var -> /private/var).
// Canonicalize test roots without weakening migration path safety.
function fixture(t) {
 const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'system1-cli-')));
 t.after(() => rmSync(workspace, { recursive: true, force: true }));
 mkdirSync(join(workspace, '.ai'));
 const path = join(workspace, '.ai/system1.json');
 const before = JSON.stringify({ version: 1, mode: 'off', provider: 'typesafe', model: 'jev-1.13.0', apiKeyEnv: 'TYPESAFE_API_KEY' });
 writeFileSync(path, before);
 const cli = fileURLToPath(new URL('../cli.js', import.meta.url));
 const run = (...flags) => spawnSync(process.execPath, [cli, 'setup', '--workspace', workspace, '--migrate-system1-config', ...flags], { encoding: 'utf8', env: { PI_OFFLINE: '1' } });
 return { workspace, path, before, run };
}
test('public migration preview/apply is local, explicit and idempotent', t => {
 const { path, before, run } = fixture(t);
 const preview = run('--dry-run', '--json');
 assert.equal(preview.status, 0, preview.stderr);
 const plan = JSON.parse(preview.stdout);
 assert.equal(plan.target.version, 2);
 assert.match(plan.digest, /^[a-f0-9]{64}$/);
 assert.equal(readFileSync(path, 'utf8'), before);
 assert.equal(run().status, 1);
 assert.equal(run('--yes').status, 1, 'yes alone cannot apply an unseen migration');
 assert.equal(readFileSync(path, 'utf8'), before);
 const applied = run('--yes', '--expect-digest', plan.digest);
 assert.equal(applied.status, 0, applied.stderr);
 assert.equal(JSON.parse(applied.stdout).result.status, 'migrated');
 assert.equal(JSON.parse(readFileSync(path, 'utf8')).mode, 'off');
 const noop = JSON.parse(run('--dry-run').stdout);
 assert.equal(JSON.parse(run('--yes', '--expect-digest', noop.digest).stdout).result.status, 'noop');
});
test('digest refuses even formatting-only edits between separate preview/apply runs', t => {
 const { workspace, path, before, run } = fixture(t);
 const preview = JSON.parse(run('--dry-run').stdout);
 writeFileSync(path, before + '\n');
 const stale = run('--yes', '--expect-digest', preview.digest);
 assert.equal(stale.status, 3, stale.stderr);
 assert.match(stale.stderr, /digest mismatch/);
 assert.doesNotMatch(stale.stderr, /\n\s+at /);
 assert.equal(readFileSync(path, 'utf8'), before + '\n');
 assert.equal(existsSync(join(workspace, '.ai/.agent-fleet-recovery')), false);
 assert.equal(existsSync(join(workspace, '.ai/agent-fleet.lock')), false);
 const fresh = JSON.parse(run('--dry-run').stdout);
 assert.notEqual(fresh.digest, preview.digest);
 assert.equal(run('--yes', '--expect-digest', fresh.digest).status, 0);
});
test('migration conflict exits 3 without stack trace; malformed input exits 1', t => {
 const { workspace, path, run } = fixture(t);
 writeFileSync(path, JSON.stringify({ version: 2, mode: 'off', provider: 'typesafe', model: 'jev-1.13.0', apiKeyEnv: 'TYPESAFE_API_KEY', consumers: {} }));
 writeFileSync(join(workspace, '.ai/proactive-review.json'), '{"version":1,"mode":"off"}');
 const conflict = run('--dry-run');
 assert.equal(conflict.status, 3);
 assert.match(conflict.stderr, /v2 plus legacy/);
 assert.doesNotMatch(conflict.stderr, /\n\s+at /);
 writeFileSync(path, 'null');
 const malformed = run('--dry-run');
 assert.equal(malformed.status, 1);
 assert.match(malformed.stderr, /Invalid provider document/);
 assert.doesNotMatch(malformed.stderr, /\n\s+at /);
});
test('migration preview/apply never print unchanged private Markdown write buffers', t => {
 const { workspace, run } = fixture(t);
 const path = join(workspace, '.ai/agent-fleet-overrides.md');
 const privateValue = 'synthetic-private-markdown-sentinel';
 writeFileSync(path, `## Agent-Team\nWatchdog-System1: shadow\nprivate-note: ${privateValue}\n`);
 const preview = run('--dry-run');
 assert.equal(preview.status, 0, preview.stderr);
 assert.doesNotMatch(preview.stdout, new RegExp(privateValue));
 const plan = JSON.parse(preview.stdout);
 assert.equal(plan.target.consumers.watchdog.mode, 'shadow');
 assert.equal(plan.operations.some(op => Object.hasOwn(op, 'text')), false);
 const applied = run('--yes', '--expect-digest', plan.digest);
 assert.equal(applied.status, 0, applied.stderr);
 assert.doesNotMatch(applied.stdout, new RegExp(privateValue));
 assert.equal(readFileSync(path, 'utf8'), `## Agent-Team\nprivate-note: ${privateValue}\n`);
});

test('consumer-only legacy workspace is refused with manual v2 instructions and no changes', t => {
 const { workspace, path, run } = fixture(t);
 rmSync(path);
 const legacyPath = join(workspace, '.ai/proactive-review.json');
 const legacy = '{"version":1,"mode":"shadow","include":["src/**"]}';
 writeFileSync(legacyPath, legacy);
 const result = run('--dry-run');
 assert.equal(result.status, 1);
 assert.match(result.stderr, /consumer-only-legacy-workspaces/);
 assert.doesNotMatch(result.stderr, /\n\s+at /);
 assert.equal(existsSync(path), false);
 assert.equal(readFileSync(legacyPath, 'utf8'), legacy);
});
