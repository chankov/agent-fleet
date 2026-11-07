import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir, symlink, rename, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AllowedSessionsStore } from './lib/fleet-codex-allowlist-store.ts';
import { ReadonlyFleetBridge, ReadonlyFleetError, createReadonlyRegistryReader, type RegistrySnapshot } from './lib/fleet-codex-readonly.ts';

const A = { hostProfile: 'fake-host', principal: 'fake-user', threadId: 'fake-A' };
const B = { ...A, threadId: 'fake-B' };
const target = { project: 'fake-project', peer: 'fake-peer', sessionId: 'fake-session', startedAt: '2000-01-01T00:00:00Z' };
const timestamp = '2026-01-01T00:00:00.000Z';
const query = { project: target.project, peer: target.peer };
const snapshot = (): RegistrySnapshot => ({ status: 'complete', partial: false, reasons: [], observedAt: timestamp,
  entriesSeen: 1, candidates: [{ target: { ...target }, heartbeatAt: timestamp, presence: 'fresh' }] });
const denied = (code: string, fn: () => Promise<unknown>) => assert.rejects(fn,
  (e: unknown) => e instanceof ReadonlyFleetError && e.code === code);
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), 'fake-readonly-s3-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('context and payload spoof refusal precede all registry/store I/O', async t => {
  const root = await fixture(t); let reads = 0;
  const bridge = new ReadonlyFleetBridge({ policyBaseDir: join(root, 'absent'), now: () => Date.parse(timestamp), registryReader: async () => { reads++; return snapshot(); } });
  await denied('IDENTITY_REQUIRED', () => bridge.discoverCandidates(null, query));
  await denied('CONTEXT_CONFLICT', () => bridge.discoverCandidates({ ...A, otherThreadId: 'fake-B' }, query));
  await denied('INVALID_REQUEST', () => bridge.discoverCandidates(A, { ...query, threadId: A.threadId }));
  await denied('INVALID_REQUEST', () => bridge.checkAllowedReadTarget(A, { ...query, grant: true }));
  assert.equal(reads, 0);
});

test('candidate discovery is not enrollment and never opens/initializes the allowlist', async t => {
  const root = await fixture(t);
  const bridge = new ReadonlyFleetBridge({ policyBaseDir: join(root, 'absent'), now: () => Date.parse(timestamp), registryReader: async () => snapshot() });
  const result = await bridge.discoverCandidates(A, { project: target.project });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.remote, 'not_checked');
  assert.equal(result.source, 'registry_metadata');
  await denied('STATE_MISSING', () => bridge.checkAllowedReadTarget(A, query));
});

test('two fresh checks read only existing exact per-conversation policy', async t => {
  const root = await fixture(t), store = new AllowedSessionsStore(root, A);
  await store.initialize(); await store.enroll({ alias: 'shop', target }, [target]);
  await new AllowedSessionsStore(root, B).initialize();
  let reads = 0;
  const bridge = new ReadonlyFleetBridge({ policyBaseDir: root, now: () => Date.parse(timestamp), registryReader: async () => { reads++; return snapshot(); } });
  const result = await bridge.checkAllowedReadTarget(A, query);
  assert.deepEqual(result.target, target);
  assert.equal(result.permission, 'read');
  assert.equal(result.questions, 'not_checked');
  assert.equal(reads, 2);
  await denied('NOT_ALLOWED', () => bridge.checkAllowedReadTarget(B, query));
});

async function registry(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await fixture(t), agents = join(root, 'projects', target.project, 'agents');
  await mkdir(agents, { recursive: true });
  return { root, agents, reader: createReadonlyRegistryReader({ registryRoot: root, now: () => Date.parse(timestamp) }) };
}
const wire = (overrides: Record<string, unknown> = {}) => ({ name: target.peer, session_id: target.sessionId,
  started_at: target.startedAt, heartbeat_at: timestamp, explicit: false, ...overrides });

test('bounded filesystem reader filters explicit peers and strips private metadata without writes', async t => {
  const { root, agents, reader } = await registry(t);
  const bytes = JSON.stringify(wire({ endpoint: 'SECRET', cwd: 'SECRET', purpose: 'SECRET' }));
  await writeFile(join(agents, 'peer.json'), bytes);
  await writeFile(join(agents, 'external.json'), JSON.stringify({ explicit: true, private: 'SECRET' }));
  const before = await readdir(agents);
  const result = await reader(target.project);
  assert.equal(result.partial, false); assert.equal(result.candidates.length, 1);
  assert.deepEqual(result.candidates[0].target, target);
  assert.equal(result.candidates[0].presence, 'fresh');
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
  assert.equal(await readFile(join(agents, 'peer.json'), 'utf8'), bytes);
  assert.deepEqual(await readdir(agents), before);
  assert.deepEqual(await readdir(root), ['projects']);
});

test('missing differs from empty; malformed, oversized and symlink files yield honest partial data', async t => {
  const { root, agents, reader } = await registry(t);
  assert.equal((await reader('missing-project')).status, 'unavailable');
  assert.deepEqual((await reader(target.project)).candidates, []);
  await writeFile(join(agents, 'good.json'), JSON.stringify(wire()));
  await writeFile(join(agents, 'bad.json'), '{');
  await writeFile(join(agents, 'large.json'), 'x'.repeat(16385));
  await symlink(join(agents, 'good.json'), join(agents, 'link.json'));
  const result = await reader(target.project);
  assert.equal(result.status, 'complete'); assert.equal(result.partial, true);
  assert.equal(result.candidates.length, 1);
  for (const code of ['ENTRY_INVALID', 'ENTRY_TOO_LARGE', 'UNSAFE_PATH']) assert.equal(result.reasons.includes(code as never), true);
  const bridge = new ReadonlyFleetBridge({ registryReader: reader, policyBaseDir: join(root, 'absent'), now: () => Date.parse(timestamp) });
  await denied('REGISTRY_PARTIAL', () => bridge.checkAllowedReadTarget(A, query));
});

async function setup(t: { after: (fn: () => Promise<void>) => void }, send = false) {
  const root = await fixture(t), store = new AllowedSessionsStore(root, A);
  await store.initialize();
  let h = await store.enroll({ alias: 'shop', target }, [target]);
  if (send) h = await store.grantSend(h, [target]);
  const path = join(root, (await readdir(root)).find(f => f.endsWith('.json'))!);
  return { root, store, h, path };
}
const bridgeFor = (root: string, reader: () => Promise<RegistrySnapshot>) => new ReadonlyFleetBridge({
  policyBaseDir: root, registryReader: reader, now: () => Date.parse(timestamp) });
const changed = { ...target, sessionId: 'fake-restarted', startedAt: '2000-01-02T00:00:00Z' };
const withTarget = (value = target): RegistrySnapshot => ({ ...snapshot(), candidates: [{ ...snapshot().candidates[0], target: value }] });

for (const field of ['hostProfile', 'principal', 'threadId'] as const) {
  test(`host namespace separation includes ${field}; no global selection`, async t => {
    const { root } = await setup(t), other = { ...A, [field]: 'fake-other' };
    const s = new AllowedSessionsStore(root, other); await s.initialize();
    await denied('NOT_ALLOWED', () => bridgeFor(root, async () => snapshot()).checkAllowedReadTarget(other, query));
    assert.deepEqual((await s.open()).bindings, []);
    assert.deepEqual((await bridgeFor(root, async () => snapshot()).checkAllowedReadTarget(A, query)).target, target);
  });
}

test('invalid selectors/identity payloads are refused before reads; own peer is required', async t => {
  const root = await fixture(t); let reads = 0;
  const bridge = bridgeFor(root, async () => { reads++; return snapshot(); });
  for (const payload of [null, {}, { project: '../escape' }, { project: 'a..b' }, { project: '*' },
    { ...query, namespace: A }, { ...query, baseDir: root }, { ...query, rights: ['read'] },
    { ...query, confirmed: true }, { ...query, peer: '*' }, { ...query, peer: 'bad/name' }]) {
    await denied('INVALID_REQUEST', () => bridge.discoverCandidates(A, payload));
  }
  const inherited = Object.assign(Object.create({ peer: target.peer }), { project: target.project });
  await denied('INVALID_REQUEST', () => bridge.checkAllowedReadTarget(A, inherited));
  await denied('INVALID_REQUEST', () => bridge.checkAllowedReadTarget(A, { project: target.project }));
  for (const context of [undefined, {}, { ...A, threadId: '' }, { ...A, principal: null }]) {
    await denied('IDENTITY_REQUIRED', () => bridge.discoverCandidates(context, query));
  }
  assert.equal(reads, 0);
});

test('request context/payload are captured independently of later caller mutation', async t => {
  const { root } = await setup(t), outer = { ...A }, args = { ...query };
  const bridge = bridgeFor(root, async () => { outer.threadId = B.threadId; args.peer = 'different'; return snapshot(); });
  assert.deepEqual((await bridge.checkAllowedReadTarget(outer, args)).target, target);
});

for (const phase of ['R1', 'R2']) {
  test(`${phase} positive epoch change durably marks needsRebind and removes send`, async t => {
    const { root, store } = await setup(t, true); let reads = 0;
    const reader = async () => withTarget(++reads === 1 && phase === 'R2' ? target : changed);
    await denied('STALE_TARGET', () => bridgeFor(root, reader).checkAllowedReadTarget(A, query));
    const persisted = await store.open();
    assert.equal(persisted.bindings[0].status, 'needsRebind');
    assert.deepEqual(persisted.bindings[0].rights, ['read']);
    await denied('STALE_TARGET', () => bridgeFor(root, async () => snapshot()).checkAllowedReadTarget(A, query));
  });
}

for (const mode of ['partial', 'offline', 'missing', 'duplicate']) {
  test(`R2 ${mode} refuses without local downgrade or retarget`, async t => {
    const { root, path } = await setup(t, true), before = await readFile(path); let reads = 0;
    const reader = async (): Promise<RegistrySnapshot> => {
      if (++reads === 1) return snapshot();
      if (mode === 'partial') return { ...withTarget(changed), partial: true, reasons: ['READ_ERROR'] };
      if (mode === 'missing') return { ...snapshot(), status: 'unavailable', partial: true, reasons: ['REGISTRY_MISSING'], candidates: [] };
      if (mode === 'offline') return { ...withTarget(changed), candidates: [{ ...withTarget(changed).candidates[0], heartbeatAt: '2025-01-01T00:00:00Z', presence: 'unavailable' }] };
      return { ...snapshot(), entriesSeen: 2, candidates: [...snapshot().candidates, ...withTarget(changed).candidates] };
    };
    await denied({ partial: 'REGISTRY_PARTIAL', missing: 'REGISTRY_UNAVAILABLE', offline: 'TARGET_UNAVAILABLE', duplicate: 'AMBIGUOUS_TARGET' }[mode]!,
      () => bridgeFor(root, reader).checkAllowedReadTarget(A, query));
    assert.deepEqual(await readFile(path), before);
  });
}

test('unrelated duplicate peer identities never become positive unique evidence after freshness filtering', async t => {
  const { root, store, path } = await setup(t, true);
  const other = { ...target, peer: 'other', sessionId: 'other-old' };
  const old = await store.enroll({ alias: 'other', target: other }, [target, other]);
  await store.grantSend(old, [target, other]);
  const before = await readFile(path);
  const candidates = [...snapshot().candidates,
    { target: other, heartbeatAt: '2025-01-01T00:00:00Z', presence: 'unavailable' as const },
    { target: { ...other, sessionId: 'other-new' }, heartbeatAt: timestamp, presence: 'fresh' as const }];
  const bridge = bridgeFor(root, async () => ({ ...snapshot(), entriesSeen: 3, candidates }));
  assert.deepEqual((await bridge.checkAllowedReadTarget(A, query)).target, target);
  assert.deepEqual(await readFile(path), before);
});

for (const mode of ['revoke', 'alias-replacement', 'revision']) {
  test(`R1/R2 concurrent ${mode} cannot reuse old permission/target`, async t => {
    const { root, store } = await setup(t, true); let reads = 0;
    const bridge = bridgeFor(root, async () => {
      if (++reads === 2) {
        const s = await store.open();
        if (mode === 'revision') await store.revokeSend('shop', s.revision);
        else {
          await store.revoke('shop', s.revision);
          if (mode === 'alias-replacement') await store.enroll({ alias: 'shop', target: changed }, [changed]);
        }
      }
      return snapshot();
    });
    await denied('STATE_CHANGED', () => bridge.checkAllowedReadTarget(A, query));
  });
}

test('R2 may downgrade another positively stale binding; result does not claim an obsolete revision token', async t => {
  const { root, store } = await setup(t, true), other = { ...target, peer: 'other', sessionId: 'other-old' };
  const h = await store.enroll({ alias: 'other', target: other }, [target, other]); await store.grantSend(h, [target, other]);
  let reads = 0;
  const bridge = bridgeFor(root, async () => ({ ...snapshot(), entriesSeen: 2, candidates: [...snapshot().candidates,
    { target: ++reads === 1 ? other : { ...other, sessionId: 'other-new' }, heartbeatAt: timestamp, presence: 'fresh' }] }));
  const result = await bridge.checkAllowedReadTarget(A, query);
  assert.deepEqual(result.target, target);
  assert.equal(Object.hasOwn(result, 'policyRevision'), false);
  const stale = (await store.open()).bindings.find(b => b.alias === 'other')!;
  assert.equal(stale.status, 'needsRebind'); assert.deepEqual(stale.rights, ['read']);
});

test('existing S2 alias/project collision is honest ambiguity, not a new alias or fallback', async t => {
  const { root, store } = await setup(t);
  const other = { ...target, project: 'shop', peer: 'other' };
  await store.enroll({ alias: 'review', target: other }, [other]);
  await denied('AMBIGUOUS_TARGET', () => bridgeFor(root, async () => snapshot()).checkAllowedReadTarget(A, query));
  assert.equal((await store.open()).bindings.length, 2);
});

test('bridge never calls grant-management methods, even with persisted send rights', async t => {
  const { root } = await setup(t, true);
  for (const method of ['initialize', 'enroll', 'grantSend', 'rebind', 'revoke', 'revokeSend'] as const) {
    t.mock.method(AllowedSessionsStore.prototype, method, () => { throw new Error('forbidden management call'); });
  }
  const result = await bridgeFor(root, async () => snapshot()).checkAllowedReadTarget(A, query);
  assert.equal(result.permission, 'read');
  assert.equal(Object.hasOwn(result, 'handle'), false);
  for (const method of ['initialize', 'enroll', 'grantSend', 'rebind', 'revoke', 'revokeSend'] as const) {
    assert.equal((AllowedSessionsStore.prototype[method] as unknown as { mock: { callCount(): number } }).mock.callCount(), 0);
  }
});

test('missing/corrupt/busy policy refuses with original data preserved and sanitized errors', async t => {
  const { root, path } = await setup(t);
  for (const [invalid, error] of [['{"version":3,"private":"SECRET"}', 'STATE_VERSION_UNSUPPORTED'], ['{"version":2,"private":"SECRET"}', 'STATE_INVALID']] as const) {
    await writeFile(path, invalid);
    await denied(error, () => bridgeFor(root, async () => snapshot()).checkAllowedReadTarget(A, query));
    assert.equal(await readFile(path, 'utf8'), invalid);
  }
  await mkdir(path.replace(/\.json$/u, '.lock'), { mode: 0o700 });
  await denied('STORE_BUSY', () => bridgeFor(root, async () => snapshot()).checkAllowedReadTarget(A, query));
});

test('storage failure during a required downgrade never returns allow or corrupts original', async t => {
  const { root, path } = await setup(t, true), before = await readFile(path);
  t.mock.method(AllowedSessionsStore.prototype, 'list', () => { throw new Error('SECRET low-level storage failure'); });
  await denied('POLICY_UNAVAILABLE', () => bridgeFor(root, async () => withTarget(changed)).checkAllowedReadTarget(A, query));
  assert.deepEqual(await readFile(path), before);
});

test('injected reader boundary refuses malformed/stale/cross-project data and scrubs failures', async t => {
  const root = await fixture(t);
  const bad = [null, { ...snapshot(), observedAt: '2025-01-01T00:00:00Z' }, { ...snapshot(), candidates: [,] },
    { ...snapshot(), partial: true, reasons: [,] }, { ...snapshot(), reasons: ['SECRET'] },
    { ...snapshot(), candidates: [{ ...snapshot().candidates[0], target: { ...target, project: 'different' } }] }];
  for (const value of bad) {
    await denied('REGISTRY_INVALID', () => bridgeFor(root, async () => value as RegistrySnapshot).checkAllowedReadTarget(A, query));
  }
  await denied('REGISTRY_UNAVAILABLE', () => bridgeFor(root, async () => { throw new Error('SECRET registry path'); }).discoverCandidates(A, query));
  await denied('REGISTRY_UNAVAILABLE', () => bridgeFor(root, async () => { throw new ReadonlyFleetError('SECRET registry path'); }).discoverCandidates(A, query));
});

for (const [delta, expected] of [[-5001, 'unavailable'], [-5000, 'fresh'], [90000, 'fresh'], [90001, 'unavailable']] as const) {
  test(`heartbeat boundary ${delta}ms gives ${expected}, no PID/socket probe`, async t => {
    const { agents, reader } = await registry(t);
    await writeFile(join(agents, 'peer.json'), JSON.stringify(wire({ heartbeat_at: new Date(Date.parse(timestamp)-delta).toISOString() })));
    assert.equal((await reader(target.project)).candidates[0].presence, expected);
  });
}

test('real temp reader plus S2 bridge closes the discovery/read/stale-downgrade path', async t => {
  const { root, agents, reader } = await registry(t), policyRoot = join(root, 'policies');
  const bridge = new ReadonlyFleetBridge({ registryReader: reader, policyBaseDir: policyRoot, now: () => Date.parse(timestamp) });
  const path = join(agents, 'peer.json'); await writeFile(path, JSON.stringify(wire()));
  assert.equal((await bridge.discoverCandidates(A, query)).candidates.length, 1);
  assert.equal((await readdir(root)).includes('policies'), false);
  const store = new AllowedSessionsStore(policyRoot, A); await store.initialize();
  let h = await store.enroll({ alias: 'shop', target }, [target]); h = await store.grantSend(h, [target]);
  assert.deepEqual((await bridge.checkAllowedReadTarget(A, query)).target, target);
  const bytes = JSON.stringify(wire({ session_id: changed.sessionId, started_at: changed.startedAt }));
  await writeFile(path, bytes);
  await denied('STALE_TARGET', () => bridge.checkAllowedReadTarget(A, query));
  assert.equal(await readFile(path, 'utf8'), bytes);
  assert.deepEqual((await store.open()).bindings[0].rights, ['read']);
});

test('ambiguous allowlist epochs for one project/peer are refused, never newest-selected', async t => {
  const { root, store } = await setup(t, true);
  await store.enroll({ alias: 'other-epoch', target: changed }, [changed]);
  await denied('AMBIGUOUS_TARGET', () => bridgeFor(root, async () => withTarget(changed)).checkAllowedReadTarget(A, query));
});

test('reader rejects non-ISO time payloads even if Date.parse tolerates unrelated text', async t => {
  const { agents, reader } = await registry(t);
  await writeFile(join(agents, 'peer.json'), JSON.stringify(wire({ heartbeat_at: 'January 1, 2026 00:00:00 UTC' })));
  const result = await reader(target.project);
  assert.equal(result.partial, true); assert.equal(result.candidates.length, 0);
});

test('reader caps at 64 entries/1MiB aggregate and reports truncation, never unique success', async t => {
  const { root, agents, reader } = await registry(t);
  for (let i = 0; i < 64; i++) {
    const row = JSON.stringify(wire({ name: 'peer_'+i }));
    await writeFile(join(agents, i+'.json'), row+' '.repeat(16384-Buffer.byteLength(row)));
  }
  const full = await reader(target.project);
  assert.equal(full.partial, false); assert.equal(full.candidates.length, 64);
  assert.equal(full.entriesSeen, 64);
  await writeFile(join(agents, 'extra.json'), JSON.stringify(wire()));
  const partial = await reader(target.project);
  assert.equal(partial.partial, true); assert.equal(partial.entriesSeen, 65);
  assert.equal(partial.reasons.includes('ENTRY_LIMIT'), true);
  await denied('REGISTRY_PARTIAL', () => new ReadonlyFleetBridge({ policyBaseDir: join(root, 'absent'), registryReader: reader,
    now: () => Date.parse(timestamp) }).checkAllowedReadTarget(A, query));
});

test('duplicate peer epochs are not collapsed; invalid heartbeat is partial, not a usable target', async t => {
  const { agents, reader } = await registry(t);
  await writeFile(join(agents, 'one.json'), JSON.stringify(wire()));
  await writeFile(join(agents, 'two.json'), JSON.stringify(wire({ session_id: 'different', heartbeat_at: '2025-01-01T00:00:00Z' })));
  assert.equal((await reader(target.project)).candidates.length, 2);
  await writeFile(join(agents, 'two.json'), JSON.stringify(wire({ heartbeat_at: 'invalid' })));
  assert.equal((await reader(target.project)).partial, true);
});

for (const component of ['root', 'projects', 'project', 'agents']) {
  test(`managed ${component} directory symlink is unavailable, never followed`, async t => {
    const { root, agents, reader } = await registry(t);
    const path = { root, projects: join(root, 'projects'), project: join(root, 'projects', target.project), agents }[component]!;
    const moved = path+'.saved';
    if (component === 'root') t.after(() => rm(moved, { recursive: true, force: true }));
    await rename(path, moved); await symlink(moved, path);
    const result = await reader(target.project);
    assert.equal(result.status, 'unavailable'); assert.equal(result.partial, true);
    assert.equal(result.reasons.includes('UNSAFE_PATH'), true);
  });
}

test('reader treats permission errors as partial without raw content', { skip: process.getuid?.() === 0 }, async t => {
  const { agents, reader } = await registry(t), path = join(agents, 'peer.json');
  await writeFile(path, JSON.stringify(wire())); await chmod(path, 0);
  const result = await reader(target.project);
  assert.equal(result.partial, true); assert.equal(result.reasons.includes('READ_ERROR'), true);
  await chmod(path, 0o600);
});
