import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile, writeFile, chmod, mkdir, stat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ObservationStore } from './lib/fleet-codex-observation-store.ts';
const a = { hostProfile: 'fixture', principal: 'owner', threadId: '11111111-1111-4111-8111-111111111111' }, b = { ...a, threadId: '22222222-2222-4222-8222-222222222222' };
const target = { project: 'fixture', peer: 'orchestrator', sessionId: 'session1', startedAt: '2026-01-01T00:00:00.000Z' };
const next = { leaf: 'a'.repeat(64), lastEvent: 'b'.repeat(64), questions: ['question1'], observedAt: target.startedAt };
async function fixture(t: {
    after: (fn: () => Promise<void>) => void;
}, checkpoint?: (stage: string) => void) { const root = await mkdtemp(join(tmpdir(), 's5c-store-')); t.after(() => rm(root, { recursive: true, force: true })); const dir = join(root, 'observations'); return { root, dir, store: new ObservationStore(dir, { checkpoint }), file: async () => join(dir, (await readdir(dir)).find(x => x.endsWith('.json'))!) }; }
const guard = async () => { };
test('cursor read is side-effect-free; save is private, durable across instances and contains metadata only', async (t) => {
    const f = await fixture(t);
    assert.equal(f.store.read(a, target).cursor, null);
    assert.deepEqual(await readdir(f.root), []);
    const saved = await f.store.save(a, target, null, next, guard);
    assert.equal(saved.revision, 1);
    assert.deepEqual(new ObservationStore(f.dir).read(a, target).cursor, saved);
    assert.equal((await stat(f.dir)).mode & 0o777, 0o700);
    assert.equal((await stat(await f.file())).mode & 0o777, 0o600);
    const text = await readFile(await f.file(), 'utf8');
    assert.equal(text.includes('transcript'), false);
    assert.equal(text.includes('rights'), false);
});
test('conversation, target and exact epoch are independent; epoch reset never copies questions', async (t) => {
    const f = await fixture(t);
    await f.store.save(a, target, null, next, guard);
    assert.equal(f.store.read(b, target).cursor, null);
    const other = { ...target, project: 'other' }, epoch = { ...target, sessionId: 'session2' };
    assert.equal(f.store.read(a, other).cursor, null);
    assert.equal(f.store.read(a, epoch).reset, 'epoch_changed');
    await f.store.save(a, epoch, null, { ...next, questions: [] }, guard);
    assert.deepEqual(f.store.read(a, epoch).cursor!.questions, []);
    assert.deepEqual(f.store.read(a, target).cursor!.questions, ['question1']);
});
test('merge under lock preserves another target while stale same-target update is refused', async (t) => {
    const f = await fixture(t), other = { ...target, project: 'other' };
    await f.store.save(a, target, null, next, guard);
    await f.store.save(a, other, null, { ...next, questions: [] }, guard);
    await assert.rejects(() => f.store.save(a, target, null, next, guard), { code: 'CURSOR_STATE_CHANGED' });
    assert.equal(f.store.read(a, other).cursor!.revision, 1);
});
test('guard failure writes no cursor and never initializes a policy', async (t) => {
    const f = await fixture(t);
    await assert.rejects(() => f.store.save(a, target, null, next, async () => { throw Object.assign(Error('NOT_ALLOWED'), { code: 'NOT_ALLOWED' }); }), { code: 'NOT_ALLOWED' });
    assert.equal(f.store.read(a, target).cursor, null);
    assert.deepEqual(await readdir(f.root), []);
});
test('existing lock is never stolen or removed by another writer', async (t) => {
    const f = await fixture(t);
    await f.store.save(a, target, null, next, guard);
    const file = await f.file(), lock = file + '.lock';
    await writeFile(lock, 'existing-owner', { mode: 0o600 });
    await assert.rejects(() => new ObservationStore(f.dir).save(a, target, 1, next, guard), { code: 'CURSOR_BUSY' });
    assert.equal(await readFile(lock, 'utf8'), 'existing-owner');
    assert.equal(f.store.read(a, target).cursor!.revision, 1);
});
test('corrupt and future-version state is refused without healing', async (t) => {
    const f = await fixture(t);
    await f.store.save(a, target, null, next, guard);
    const file = await f.file();
    await writeFile(file, '{bad');
    assert.throws(() => f.store.read(a, target), { code: 'CURSOR_STATE_INVALID' });
    assert.equal(await readFile(file, 'utf8'), '{bad');
    await writeFile(file, JSON.stringify({ version: 2 }));
    assert.throws(() => f.store.read(a, target), { code: 'CURSOR_STATE_VERSION' });
});
test('known state loss and namespace substitution are refused', async (t) => {
    const f = await fixture(t);
    await f.store.save(a, target, null, next, guard);
    const file = await f.file(), raw = JSON.parse(await readFile(file, 'utf8'));
    raw.namespace = b;
    await writeFile(file, JSON.stringify(raw));
    assert.throws(() => f.store.read(a, target), { code: 'CURSOR_NAMESPACE_MISMATCH' });
    await rm(file);
    assert.throws(() => f.store.read(a, target), { code: 'CURSOR_STATE_MISSING' });
});
test('unsafe root, symlink and broad file permissions never become successful reads', async (t) => {
    const f = await fixture(t);
    await mkdir(f.dir, { mode: 0o755 });
    await chmod(f.dir, 0o755);
    assert.throws(() => f.store.read(a, target), { code: 'CURSOR_UNSAFE_PATH' });
    await chmod(f.dir, 0o700);
    await f.store.save(a, target, null, next, guard);
    const file = await f.file();
    await chmod(file, 0o644);
    assert.throws(() => f.store.read(a, target), { code: 'CURSOR_UNSAFE_PATH' });
    await chmod(file, 0o600);
    await rm(file);
    await symlink(join(f.root, 'elsewhere'), file);
    assert.throws(() => new ObservationStore(f.dir).read(a, target), { code: 'CURSOR_UNSAFE_PATH' });
});
test('finite target slots refuse new state rather than evicting old cursors', async (t) => {
    const f = await fixture(t);
    for (let i = 0; i < 32; i++)
        await f.store.save(a, { ...target, project: 'p' + i }, null, next, guard);
    await assert.rejects(() => f.store.save(a, { ...target, project: 'full' }, null, next, guard), { code: 'CURSOR_LIMIT' });
    assert.equal(f.store.read(a, { ...target, project: 'p0' }).cursor!.revision, 1);
});
for (const stage of ['beforeRename', 'afterRename'])
    test('atomic ' + stage + ' failure is truthful and not silently retried', async (t) => {
        let calls = 0;
        const f = await fixture(t, s => { if (s === stage) {
            calls++;
            throw Error('PRIVATE_FS_ERROR');
        } });
        await assert.rejects(() => f.store.save(a, target, null, next, guard), { code: stage === 'afterRename' ? 'CURSOR_COMMIT_UNCERTAIN' : 'CURSOR_IO_ERROR' });
        assert.equal(calls, 1);
        const read = new ObservationStore(f.dir).read(a, target);
        assert.equal(read.cursor?.revision ?? null, stage === 'afterRename' ? 1 : null);
    });
test('invalid context, record and root arguments fail before creating files', async (t) => {
    const f = await fixture(t);
    assert.throws(() => new ObservationStore('relative'), { code: 'CURSOR_UNSAFE_PATH' });
    assert.throws(() => f.store.read({ ...a, threadId: '' }, target), { code: 'CURSOR_IDENTITY_INVALID' });
    await assert.rejects(() => f.store.save(a, target, null, { ...next, questions: Array(257).fill('q') }, guard), { code: 'CURSOR_STATE_INVALID' });
    assert.deepEqual(await readdir(f.root), []);
});
