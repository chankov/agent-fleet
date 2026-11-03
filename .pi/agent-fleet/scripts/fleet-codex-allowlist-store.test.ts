import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, readdir, chmod, stat, mkdir, symlink, lstat, rename, link } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AllowedSessionsStore, StoreError } from './lib/fleet-codex-allowlist-store.ts';

const A = { hostProfile: 'fake-host', principal: 'fake-user', threadId: 'fake-A' };
const B = { ...A, threadId: 'fake-B' };
const target = { project: 'fake-project', peer: 'fake-peer', sessionId: 'fake-session-1', startedAt: '2000-01-01T00:00:00Z' };
const restarted = { ...target, sessionId: 'fake-session-2', startedAt: '2000-01-02T00:00:00Z' };
const denied = (code: string, action: () => Promise<unknown>) => assert.rejects(action,
  (e: unknown) => e instanceof StoreError && e.code === code);
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), 'fake-allowlist-s2-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('explicit initialize, same-epoch read/send persistence and fresh instance handles', async t => {
  const root = await fixture(t), store = new AllowedSessionsStore(root, A);
  await denied('STATE_MISSING', () => store.open());
  await store.initialize();
  await denied('STATE_EXISTS', () => store.initialize());
  let h = await store.enroll({ alias: 'shop', target }, [target]);
  await denied('SEND_NOT_GRANTED', () => store.authorize(h, 'send', [target]));
  h = await store.grantSend(h, [target]);
  const fresh = new AllowedSessionsStore(root, A);
  await fresh.open();
  await denied('STALE_HANDLE', () => fresh.authorize(h, 'send', [target]));
  const restored = await fresh.resolve('shop', [target]);
  assert.deepEqual(await fresh.authorize(restored, 'send', [target]), target);
  const other = new AllowedSessionsStore(root, B);
  await other.initialize();
  assert.deepEqual((await other.list([target])).bindings, []);
  await denied('STALE_HANDLE', () => other.authorize(restored, 'read', [target]));
});

test('observed target restart durably removes send; explicit rebind is read-only', async t => {
  const root = await fixture(t), store = new AllowedSessionsStore(root, A);
  await store.initialize();
  let h = await store.enroll({ alias: 'shop', target }, [target]);
  h = await store.grantSend(h, [target]);
  await denied('STALE_TARGET', () => store.authorize(h, 'send', [restarted]));
  const fresh = new AllowedSessionsStore(root, A);
  await fresh.open();
  await denied('STALE_TARGET', () => fresh.resolve('shop', [target]));
  const snapshot = await fresh.list([target]);
  assert.deepEqual(snapshot.bindings[0].rights, ['read']);
  const rebound = await fresh.rebind('shop', restarted, [restarted], snapshot.revision);
  assert.deepEqual(await fresh.authorize(rebound, 'read', [restarted]), restarted);
  await denied('SEND_NOT_GRANTED', () => fresh.authorize(rebound, 'send', [restarted]));
});

test('explicit same-epoch rebind and no-op mutation still invalidate prior revision handles', async t => {
  const { store, handle } = await setup(t);
  const before = await store.open();
  const rebound = await store.rebind('shop', target, [target], before.revision);
  assert.equal(rebound.revision, before.revision+1);
  await denied('STATE_CHANGED', () => store.authorize(handle, 'read', [target]));
  await store.revokeSend('shop', rebound.revision);
  await denied('STATE_CHANGED', () => store.authorize(rebound, 'read', [target]));
});

test('absent root needs explicit initialize; insecure or hardlinked state is not repaired', async t => {
  const parent = await fixture(t), root = join(parent, 'owned-root');
  const s = new AllowedSessionsStore(root, A);
  await denied('STATE_MISSING', () => s.open());
  assert.deepEqual(await readdir(parent), []);
  await s.initialize();
  const path = statePath(root), backup = join(parent, 'hardlink');
  await link(path, backup);
  await denied('UNSAFE_PATH', () => s.open());
  assert.equal((await stat(path)).nlink, 2);
});

const statePath = (root: string, context = A) => join(root, createHash('sha256')
  .update(JSON.stringify([context.hostProfile, context.principal, context.threadId])).digest('hex')+'.json');
async function setup(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await fixture(t), store = new AllowedSessionsStore(root, A);
  await store.initialize();
  const handle = await store.enroll({ alias: 'shop', target }, [target]);
  return { root, store, handle, path: statePath(root) };
}

for (const field of ['hostProfile', 'principal', 'threadId'] as const) {
  test(`disk namespace isolation includes ${field}`, async t => {
    const { root, path } = await setup(t);
    const changed = { ...A, [field]: '../different' };
    const other = new AllowedSessionsStore(root, changed);
    await denied('STATE_MISSING', () => other.open());
    await other.initialize();
    assert.equal((await other.open()).bindings.length, 0);
    await writeFile(statePath(root, changed), await readFile(path));
    await denied('NAMESPACE_MISMATCH', () => other.open());
  });
}

test('offline/ambiguous snapshots do not auto-retarget or drop send; reload requires exactness', async t => {
  const { root, store, handle } = await setup(t);
  const sending = await store.grantSend(handle, [target]);
  await denied('TARGET_UNAVAILABLE', () => store.authorize(sending, 'send', []));
  await denied('AMBIGUOUS_TARGET', () => store.authorize(sending, 'read', [target, target]));
  const fresh = new AllowedSessionsStore(root, A);
  const restored = await fresh.resolve('shop', [target]);
  assert.deepEqual(await fresh.authorize(restored, 'send', [target]), target);
  await denied('STALE_HANDLE', () => fresh.authorize({ ...restored }, 'read', [target]));
});

test('rights, addressed writes and project ambiguity survive disk reconstruction', async t => {
  const { store, handle } = await setup(t);
  const other = { ...target, peer: 'fake-reviewer' };
  const next = await store.enroll({ alias: 'review', target: other }, [target, other]);
  await denied('STATE_CHANGED', () => store.authorize(handle, 'read', [target]));
  await denied('AMBIGUOUS_TARGET', () => store.resolve(target.project, [target, other]));
  await denied('STALE_HANDLE', () => store.authorize(undefined as never, 'send', [target]));
  await denied('UNSUPPORTED_RIGHT', () => store.authorize(next, 'answer' as never, [target, other]));
  await denied('SEND_NOT_GRANTED', () => store.authorize(next, 'send', [target, other]));
  await denied('INVALID_INPUT', () => store.enroll({ alias: 'bad', target, confirmed: true } as never, [target]));
});

test('revoke send/all persists, cannot resurrect by stale writer or alias reenrollment', async t => {
  const { root, store, handle } = await setup(t);
  const sending = await store.grantSend(handle, [target]);
  const rival = new AllowedSessionsStore(root, A), snap = await rival.open();
  await rival.revokeSend('shop', snap.revision);
  await denied('STATE_CHANGED', () => store.grantSend(sending, [target]));
  const fresh = await store.resolve('shop', [target]);
  await denied('SEND_NOT_GRANTED', () => store.authorize(fresh, 'send', [target]));
  await denied('STATE_CHANGED', () => rival.revoke('shop', snap.revision));
  const current = await rival.open(); await rival.revoke('shop', current.revision);
  assert.equal((await store.open()).bindings.length, 0);
  assert.equal((await stat(statePath(root))).isFile(), true);
  await store.enroll({ alias: 'shop', target }, [target]);
  await denied('STATE_CHANGED', () => store.authorize(fresh, 'read', [target]));
});

test('missing, regressed or replaced store never falls back to cached grants', async t => {
  const { root, store, handle, path } = await setup(t);
  const old = await readFile(path);
  await store.grantSend(handle, [target]);
  await writeFile(path, old);
  await denied('STATE_REGRESSED', () => store.open());
  const state = JSON.parse(old.toString()); state.storeId = randomUUID();
  await writeFile(path, JSON.stringify(state)+'\n');
  await denied('STATE_CHANGED', () => store.open());
  await rm(path);
  await denied('STATE_MISSING', () => store.open());
  assert.equal((await readdir(root)).some(n => n.endsWith('.json')), false);
});

test('canonical writer validation rejects corruption without modifying original bytes', async t => {
  const { root, path } = await setup(t);
  const original = await readFile(path), valid = JSON.parse(original.toString());
  const bad: [string, string | Buffer, string][] = [];
  const variant = (name: string, mutate: (s: any) => void, code = 'STATE_INVALID') => {
    const s = structuredClone(valid); mutate(s); bad.push([name, JSON.stringify(s)+'\n', code]);
  };
  bad.push(['oversize', ' '.repeat(65537), 'STATE_INVALID'], ['truncated', '{', 'STATE_INVALID'],
    ['duplicate key', original.toString().replace('"version":1', '"version":1,"version":1'), 'STATE_INVALID'],
    ['pretty', JSON.stringify(valid, null, 2)+'\n', 'STATE_INVALID'], ['BOM', Buffer.concat([Buffer.from([239,187,191]), original]), 'STATE_INVALID'],
    ['invalid UTF8', Buffer.from([0xff]), 'STATE_INVALID'], ['trailing', original.toString()+'{}', 'STATE_INVALID']);
  variant('version', s => s.version = 2, 'STATE_VERSION_UNSUPPORTED');
  variant('namespace', s => s.namespace.threadId = 'fake-B', 'NAMESPACE_MISMATCH');
  variant('extra field', s => s.extra = true);
  variant('invalid UUID', s => s.storeId = 'bad');
  variant('revision', s => s.revision = -1);
  variant('fraction revision', s => s.revision = 1.5);
  variant('revision overflow', s => s.revision = Number.MAX_SAFE_INTEGER+1);
  variant('duplicate entry', s => s.bindings.push(s.bindings[0]));
  variant('duplicate target', s => s.bindings.push({ ...s.bindings[0], alias: 'different' }));
  variant('extra right', s => s.bindings[0].rights = ['read', 'answer']);
  variant('send only', s => s.bindings[0].rights = ['send']);
  variant('stale send', s => { s.bindings[0].status = 'needsRebind'; s.bindings[0].rights = ['read', 'send']; });
  variant('invalid target', s => s.bindings[0].target.startedAt = '');
  variant('deep unknown shape', s => s.bindings[0].target.project = { nested: { x: [] } });
  variant('too many bindings', s => s.bindings = Array.from({ length: 33 }, (_, i) => ({ ...s.bindings[0], alias: String(i), target: { ...target, peer: String(i) } })));
  for (const [name, bytes, code] of bad) {
    await t.test(name, async () => {
      await writeFile(path, bytes);
      const s = new AllowedSessionsStore(root, A);
      await denied(code, () => s.open());
      assert.deepEqual(await readFile(path), Buffer.from(bytes));
      await denied('STATE_EXISTS', () => s.initialize());
      assert.deepEqual(await readFile(path), Buffer.from(bytes));
    });
  }
});

test('outbound count/byte limits and revision overflow do not mutate file', async t => {
  const { root, path } = await setup(t);
  const s = JSON.parse(await readFile(path, 'utf8'));
  s.revision = Number.MAX_SAFE_INTEGER;
  await writeFile(path, JSON.stringify(s)+'\n');
  const fullRevision = new AllowedSessionsStore(root, A);
  const before = await readFile(path);
  await denied('REVISION_EXHAUSTED', () => fullRevision.revoke('shop', s.revision));
  assert.deepEqual(await readFile(path), before);
  s.revision = 0;
  s.bindings = Array.from({ length: 32 }, (_, i) => ({ ...s.bindings[0], alias: String(i).padStart(2,'0'), target: { ...target, peer: String(i) } }));
  await writeFile(path, JSON.stringify(s)+'\n');
  const full = new AllowedSessionsStore(root, A), bytes = await readFile(path);
  await denied('STATE_INVALID', () => full.enroll({ alias: 'extra', target }, [target]));
  assert.deepEqual(await readFile(path), bytes);
  s.bindings = [];
  await writeFile(path, JSON.stringify(s)+'\n');
  const wide = new AllowedSessionsStore(root, A);
  const huge = { project: 'p'.repeat(1024), peer: 'q'.repeat(1024), sessionId: 's'.repeat(1024), startedAt: 't'.repeat(1024) };
  let refused = false;
  for (let i = 0; i < 32; i++) {
    const v = { ...huge, peer: String(i)+'q'.repeat(1000) }, previous = await readFile(path);
    try { await wide.enroll({ alias: String(i), target: v }, [v]); }
    catch (e) { assert.equal((e as StoreError).code, 'STATE_INVALID'); assert.deepEqual(await readFile(path), previous); refused = true; break; }
  }
  assert.equal(refused, true);
});

for (const stage of ['beforeWrite', 'beforeFileSync', 'beforeRename', 'afterRename', 'beforeDirectorySync'] as const) {
  test(`atomic fault at ${stage}: old/new complete document, no false ack`, async t => {
    const { root, path } = await setup(t), before = await readFile(path);
    const store = new AllowedSessionsStore(root, A, { checkpoint: at => { if (at === stage) throw new Error('SECRET fault'); } });
    const other = { ...target, peer: 'other' };
    const issued = await store.resolve('shop', [target]);
    const post = stage === 'afterRename' || stage === 'beforeDirectorySync';
    await denied(post ? 'COMMIT_UNCERTAIN' : 'IO_ERROR', () => store.enroll({ alias: 'other', target: other }, [target, other]));
    const bytes = await readFile(path), snap = await new AllowedSessionsStore(root, A).open();
    assert.equal(snap.bindings.length, post ? 2 : 1);
    if (!post) {
      assert.deepEqual(bytes, before);
      assert.deepEqual(await store.authorize(issued, 'read', [target]), target);
    } else await denied('STATE_CHANGED', () => store.authorize(issued, 'read', [target]));
    assert.equal((await readdir(root)).some(n => n.endsWith('.tmp') || n.endsWith('.lock')), false);
  });
}

test('failed durable stale observation returns storage error, never an allow or cached handle', async t => {
  const { root, store, handle, path } = await setup(t); await store.grantSend(handle, [target]);
  const faulty = new AllowedSessionsStore(root, A, { checkpoint: stage => { if (stage === 'beforeRename') throw new Error('private fault'); } });
  const h = await faulty.resolve('shop', [target]), before = await readFile(path);
  await denied('IO_ERROR', () => faulty.authorize(h, 'send', [restarted]));
  assert.deepEqual(await readFile(path), before);
  const normal = new AllowedSessionsStore(root, A);
  await denied('STALE_TARGET', () => normal.resolve('shop', [restarted]));
  await denied('STALE_TARGET', () => new AllowedSessionsStore(root, A).resolve('shop', [target]));
});

test('invalid/sparse snapshots and stale expected rebind cannot mutate rights', async t => {
  const { store, path } = await setup(t);
  for (const snapshot of [null, [target, null], [target, ,]]) {
    const before = await readFile(path);
    await denied('STATE_INVALID', () => store.list(snapshot as never));
    assert.deepEqual(await readFile(path), before);
  }
  const before = await store.open();
  await store.revokeSend('shop', before.revision);
  await denied('STATE_CHANGED', () => store.rebind('shop', target, [target], before.revision));
  assert.deepEqual((await store.open()).bindings[0].rights, ['read']);
});

test('open/list return detached descriptors, not serialized handles or live read grants', async t => {
  const { root, store } = await setup(t);
  const snapshot = await store.open();
  (snapshot.bindings[0].rights as string[]).push('send');
  (snapshot.bindings[0].target as { sessionId: string }).sessionId = 'altered';
  const fresh = new AllowedSessionsStore(root, A), next = await fresh.list([]);
  assert.deepEqual(next.bindings[0].rights, ['read']);
  assert.deepEqual(next.bindings[0].target, target);
  await denied('TARGET_UNAVAILABLE', () => fresh.resolve('shop', []));
  await denied('STALE_HANDLE', () => fresh.authorize(next.bindings[0] as never, 'read', [target]));
});

test('private POSIX modes and no symlink/nonregular managed paths', async t => {
  const { root, path } = await setup(t), bytes = await readFile(path);
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await chmod(path, 0o644);
  await denied('UNSAFE_PATH', () => new AllowedSessionsStore(root, A).open());
  assert.equal((await stat(path)).mode & 0o777, 0o644);
  await chmod(path, 0o600);
  const saved = join(root, 'saved'); await rename(path, saved); await symlink(saved, path);
  await denied('UNSAFE_PATH', () => new AllowedSessionsStore(root, A).open());
  assert.deepEqual(await readFile(saved), bytes);
  await rm(path); await mkdir(path, { mode: 0o700 });
  await denied('UNSAFE_PATH', () => new AllowedSessionsStore(root, A).open());
  await rm(path, { recursive: true }); await rename(saved, path);
  const link = join(root, 'root-link'); await symlink(root, link);
  await denied('UNSAFE_PATH', () => new AllowedSessionsStore(link, A).open());
  await chmod(root, 0o755);
  await denied('UNSAFE_PATH', () => new AllowedSessionsStore(root, A).open());
  await chmod(root, 0o700);
});

test('orphan/unsafe lock and temp remnants are never stolen or used for restore', async t => {
  const { root, path } = await setup(t), lock = path.replace(/\.json$/u, '.lock');
  await mkdir(lock, { mode: 0o700 });
  await denied('STORE_BUSY', () => new AllowedSessionsStore(root, A, { lockTimeoutMs: 0 }).open());
  assert.equal((await lstat(lock)).isDirectory(), true);
  await rm(lock, { recursive: true }); await symlink(path, lock);
  await denied('UNSAFE_PATH', () => new AllowedSessionsStore(root, A).open());
  await rm(lock); await writeFile(path+'.leftover.tmp', await readFile(path), { mode: 0o600 }); await rm(path);
  await denied('STATE_MISSING', () => new AllowedSessionsStore(root, A).open());
});

test('lock cleanup does not remove replacement lock owned by another actor', async t => {
  const { root, path } = await setup(t), lock = path.replace(/\.json$/u, '.lock');
  const moved = lock+'.original';
  const s = new AllowedSessionsStore(root, A, { checkpoint: async stage => {
    if (stage === 'locked') { await rename(lock, moved); await mkdir(lock, { mode: 0o700 }); }
  } });
  await denied('UNSAFE_PATH', () => s.open());
  assert.equal((await lstat(lock)).isDirectory(), true);
  assert.equal((await lstat(moved)).isDirectory(), true);
});

async function child(t: { after: (fn: () => Promise<void>) => void }, root: string, mode: string, alias = 'child', phase = '') {
  const script = fileURLToPath(new URL('./fixtures/fleet-codex-allowlist-store-child.ts', import.meta.url));
  const p = spawn(process.execPath, [script, root, mode, alias, phase], { env: {}, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = createInterface({ input: p.stdout }), iterator = lines[Symbol.asyncIterator]();
  let stderr = ''; p.stderr.on('data', b => { stderr += b.toString(); });
  const exit = new Promise<void>((resolve, reject) => { p.once('error', reject); p.once('exit', () => resolve()); });
  t.after(async () => { if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL'); await exit; lines.close(); });
  return {
    next: async () => { const line = await iterator.next(); assert.equal(line.done, false, stderr); return JSON.parse(line.value!); },
    go: () => p.stdin.write('go\n'),
    kill: async () => { p.kill('SIGKILL'); await exit; },
    done: async () => { await exit; assert.equal(stderr, ''); },
  };
}

test('new process roundtrip restores explicit send on same exact epoch', async t => {
  const { root, store, handle } = await setup(t); await store.grantSend(handle, [target]);
  const c = await child(t, root, 'roundtrip'); assert.equal((await c.next()).ready, true); c.go();
  assert.deepEqual(await c.next(), { ok: true, decision: target }); await c.done();
});

test('two processes serialize disjoint writes without lost updates', async t => {
  const { root } = await setup(t);
  const one = await child(t, root, 'mutate', 'one'), two = await child(t, root, 'mutate', 'two');
  assert.equal((await one.next()).ready, true); assert.equal((await two.next()).ready, true);
  one.go(); two.go(); assert.equal((await one.next()).ok, true); assert.equal((await two.next()).ok, true);
  await one.done(); await two.done();
  assert.deepEqual((await new AllowedSessionsStore(root, A).open()).bindings.map(b => b.alias), ['one', 'shop', 'two']);
});

test('two processes same-alias enroll has exactly one success and one conflict', async t => {
  const { root } = await setup(t);
  const one = await child(t, root, 'mutate', 'same'), two = await child(t, root, 'mutate', 'same');
  await one.next(); await two.next(); one.go(); two.go();
  const results = [await one.next(), await two.next()];
  assert.equal(results.filter(r => r.ok).length, 1); assert.equal(results.find(r => !r.ok).code, 'STATE_INVALID');
  await one.done(); await two.done();
});

test('process retaining pre-revoke handle cannot resurrect send after revoke commit', async t => {
  const { root, store, handle } = await setup(t); await store.grantSend(handle, [target]);
  const c = await child(t, root, 'stale'); assert.equal((await c.next()).ready, true);
  const snap = await store.open(); await store.revokeSend('shop', snap.revision);
  c.go(); assert.deepEqual(await c.next(), { ok: false, code: 'STATE_CHANGED' }); await c.done();
  const h = await store.resolve('shop', [target]); await denied('SEND_NOT_GRANTED', () => store.authorize(h, 'send', [target]));
});

for (const stage of ['beforeRename', 'afterRename']) {
  test(`abrupt child death at ${stage}: complete state and orphan lock blocks access`, async t => {
    const { root, path } = await setup(t);
    const c = await child(t, root, 'interrupt', 'crash', stage); await c.next(); c.go();
    assert.equal((await c.next()).stage, stage); await c.kill();
    const raw = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(raw.bindings.length, stage === 'beforeRename' ? 1 : 2);
    await denied('STORE_BUSY', () => new AllowedSessionsStore(root, A, { lockTimeoutMs: 0 }).open());
    // No production recovery: test cleanup removes only this test's owned temporary root.
  });
}

test('one namespace lock does not block another; no lock service or stale lock stealing', async t => {
  const { root } = await setup(t), b = new AllowedSessionsStore(root, B); await b.initialize();
  const c = await child(t, root, 'hold'); assert.equal((await c.next()).stage, 'locked');
  assert.equal((await b.open()).revision, 0);
  await denied('STORE_BUSY', () => new AllowedSessionsStore(root, A, { lockTimeoutMs: 20 }).open());
  c.go(); assert.equal((await c.next()).ok, true); await c.done();
});
