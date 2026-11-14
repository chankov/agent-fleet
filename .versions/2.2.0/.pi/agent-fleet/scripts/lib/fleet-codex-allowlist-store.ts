// S2: local POSIX persistence for D2-L cooperative-agent policy. No Fleet transport.
import { constants, lstatSync, openSync, fstatSync, readSync, closeSync, type Stats } from 'node:fs';
import { mkdir, lstat, open, rename, unlink, rmdir } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { AllowedSessionsPolicy, AllowlistError, type BindingHandle, type ConversationKey, type TargetEpoch, type Right } from './fleet-codex-allowlist.ts';
import {prepareSendLineage,verifySendLineage,retireFutureSendLineage} from './codex-send-lineage.ts';

export type StoreCode = 'STATE_MISSING' | 'STATE_EXISTS' | 'STATE_INVALID' | 'STATE_VERSION_UNSUPPORTED'
  | 'NAMESPACE_MISMATCH' | 'STATE_CHANGED' | 'STATE_REGRESSED' | 'STORE_BUSY' | 'UNSAFE_PATH'
  | 'IO_ERROR' | 'COMMIT_UNCERTAIN' | 'REVISION_EXHAUSTED' | 'STALE_HANDLE' | 'RIGHTS_EXPIRED';
export class StoreError extends Error {
  readonly code: StoreCode | AllowlistError['code'];
  constructor(code: StoreCode | AllowlistError['code']) { super(code); this.name = 'StoreError'; this.code = code; }
}
export type WriteStage = 'locked' | 'beforeWrite' | 'beforeFileSync' | 'beforeRename' | 'afterRename' | 'beforeDirectorySync';
export type StoreOptions = Readonly<{
  lockTimeoutMs?: number;
  /** Fault/barrier seam only; receives no filesystem, state or policy capability. */
  checkpoint?: (stage: WriteStage) => void | Promise<void>;
  now?: () => number;
}>;
export type StoreHandle = Readonly<{ alias: string; revision: number }>;
type Entry = { alias: string; target: TargetEpoch; rights: Right[]; status: 'active' | 'needsRebind'; expiresAt?: number };
type State = { format: 'fleet-local-allowlist'; version: 1 | 2 | 3; storeId: string; namespace: ConversationKey; revision: number; bindings: Entry[] };
export type StoreSnapshot = Readonly<{ revision: number; bindings: readonly Readonly<Entry>[] }>;
type Issued = { storeId: string; revision: number; alias: string };
type Policy = { policy: AllowedSessionsPolicy; handles: Map<string, BindingHandle>; blocked: Map<string, 'TARGET_UNAVAILABLE' | 'AMBIGUOUS_TARGET' | 'RIGHTS_EXPIRED'> };
const MAX_BYTES = 65536, MAX_BINDINGS = 32;
const targetKeys = ['project', 'peer', 'sessionId', 'startedAt'] as const;
function fail(code: StoreCode): never { throw new StoreError(code); }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: unknown, fields: readonly string[]): v is Record<string, unknown> => object(v)
  && Object.keys(v).length === fields.length && fields.every(k => Object.hasOwn(v, k));
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 1024
  && v.trim() === v && !/[\u0000-\u001f\u007f*]/u.test(v);
const same = (a: TargetEpoch, b: TargetEpoch): boolean => targetKeys.every(k => a[k] === b[k]);
const tuple = (c: ConversationKey): string => JSON.stringify([c.hostProfile, c.principal, c.threadId]);
function epoch(v: unknown): TargetEpoch {
  if (!keys(v, targetKeys) || !targetKeys.every(k => text(v[k]))) fail('STATE_INVALID');
  return { project: v.project as string, peer: v.peer as string, sessionId: v.sessionId as string, startedAt: v.startedAt as string };
}
function canonical(s: State): string {
  return JSON.stringify({ format: s.format, version: s.version, storeId: s.storeId,
    namespace: { hostProfile: s.namespace.hostProfile, principal: s.namespace.principal, threadId: s.namespace.threadId },
    revision: s.revision, bindings: [...s.bindings].sort((a, b) => a.alias < b.alias ? -1 : a.alias > b.alias ? 1 : 0)
      .map(b => ({ alias: b.alias, target: { ...b.target }, rights: [...b.rights], status: b.status, ...(b.expiresAt === undefined ? {} : { expiresAt: b.expiresAt }) })) })+'\n';
}
function decode(bytes: Buffer, context: ConversationKey): State {
  if (bytes.length > MAX_BYTES) fail('STATE_INVALID');
  let v: unknown;
  try { v = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail('STATE_INVALID'); }
  if (!object(v)) fail('STATE_INVALID');
  if (Object.hasOwn(v, 'version') && v.version !== 1 && v.version !== 2 && v.version !== 3) fail('STATE_VERSION_UNSUPPORTED');
  if (!keys(v, ['format', 'version', 'storeId', 'namespace', 'revision', 'bindings']) || v.format !== 'fleet-local-allowlist'
      || (v.version !== 1 && v.version !== 2 && v.version !== 3) || typeof v.storeId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(v.storeId)
      || !Number.isSafeInteger(v.revision) || (v.revision as number) < 0 || !Array.isArray(v.bindings)
      || v.bindings.length > MAX_BINDINGS) fail('STATE_INVALID');
  try { new AllowedSessionsPolicy().list(v.namespace as ConversationKey); } catch { fail('STATE_INVALID'); }
  if (tuple(v.namespace as ConversationKey) !== tuple(context)) fail('NAMESPACE_MISMATCH');
  const aliases = new Set<string>(), targets = new Set<string>();
  const bindings: Entry[] = v.bindings.map((b: unknown) => {
    if (!(keys(b, ['alias', 'target', 'rights', 'status']) || v.version === 3 && keys(b, ['alias', 'target', 'rights', 'status', 'expiresAt']) && Number.isSafeInteger(b.expiresAt) && (b.expiresAt as number) > 0) || !text(b.alias) || !Array.isArray(b.rights)
        || !(b.rights[0] === 'read' && JSON.stringify(b.rights) === JSON.stringify(['read', ...(b.rights.includes('send') ? ['send'] : []), ...(v.version !== 1 && b.rights.includes('approve') ? ['approve'] : [])]))
        || b.status !== 'active' && b.status !== 'needsRebind' || b.status === 'needsRebind' && b.rights.length !== 1) fail('STATE_INVALID');
    const target = epoch(b.target), id = JSON.stringify(target);
    if (aliases.has(b.alias) || targets.has(id)) fail('STATE_INVALID');
    aliases.add(b.alias); targets.add(id);
    return { alias: b.alias, target, rights: [...b.rights] as Right[], status: b.status, ...(Object.hasOwn(b, 'expiresAt') ? { expiresAt: b.expiresAt as number } : {}) };
  });
  const s: State = { format: 'fleet-local-allowlist', version: v.version, storeId: v.storeId,
    namespace: { ...context }, revision: v.revision as number, bindings };
  // Fixed-depth schema is validated before stringify; rejects duplicate JSON keys/BOM/extra bytes.
  if (!Buffer.from(canonical(s)).equals(bytes)) fail('STATE_INVALID');
  return s;
}
const missing = (e: unknown): boolean => object(e) && e.code === 'ENOENT';
const normalize = (e: unknown): StoreError => e instanceof StoreError ? e
  : e instanceof AllowlistError ? new StoreError(e.code) : new StoreError('IO_ERROR');

/** No default path/env discovery. Ancestors must be trusted; only local POSIX filesystems. */
export class AllowedSessionsStore {
  readonly #root: string;
  readonly #context: ConversationKey;
  readonly #path: string;
  readonly #lockPath: string;
  readonly #timeout: number;
  readonly #now: () => number;
  readonly #checkpoint: NonNullable<StoreOptions['checkpoint']>;
  #seen?: { storeId: string; revision: number };
  readonly #snapshots=new WeakMap<StoreSnapshot,State>();
  #issued = new WeakMap<object, Issued>();
  constructor(baseDir: string, context: ConversationKey, options: StoreOptions = {}) {
    if (process.platform === 'win32' || !process.getuid || !isAbsolute(baseDir) || resolve(baseDir) !== baseDir) fail('UNSAFE_PATH');
    new AllowedSessionsPolicy().list(context);
    this.#root = baseDir; this.#context = { ...context };
    const hash = createHash('sha256').update(tuple(this.#context)).digest('hex');
    this.#path = join(baseDir, hash+'.json'); this.#lockPath = join(baseDir, hash+'.lock');
    this.#timeout = options.lockTimeoutMs ?? 2000;
    if (!Number.isFinite(this.#timeout) || this.#timeout < 0 || this.#timeout > 2000) fail('STATE_INVALID');
    this.#checkpoint = options.checkpoint ?? (() => {});
    this.#now = options.now ?? Date.now;
  }
  #safe(stat: Stats, directory: boolean): void {
    if ((directory ? !stat.isDirectory() : !stat.isFile()) || stat.uid !== process.getuid!()
        || (stat.mode & 0o7777) !== (directory ? 0o700 : 0o600) || !directory && stat.nlink !== 1) fail('UNSAFE_PATH');
  }
  async #rootReady(create: boolean): Promise<void> {
    if (create) {
      try { await mkdir(this.#root, { mode: 0o700 }); } catch (e) { if (!object(e) || e.code !== 'EEXIST') throw e; }
    }
    try { this.#safe(await lstat(this.#root), true); } catch (e) { if (missing(e)) fail('STATE_MISSING'); throw e; }
  }
  async #withLock<T>(create: boolean, fn: () => Promise<T>): Promise<T> {
    let owned: Stats | undefined;
    try {
      await this.#rootReady(create);
      const deadline = performance.now()+this.#timeout;
      while (!owned) {
        try {
          await mkdir(this.#lockPath, { mode: 0o700 });
          owned = await lstat(this.#lockPath); this.#safe(owned, true);
        } catch (e) {
          if (!object(e) || e.code !== 'EEXIST') throw e;
          try { this.#safe(await lstat(this.#lockPath), true); }
          catch (check) {
            if (!missing(check)) throw check;
            if (performance.now() >= deadline) fail('STORE_BUSY');
            continue;
          }
          if (performance.now() >= deadline) fail('STORE_BUSY'); // May be orphaned: never auto-steal.
          await delay(Math.min(10, Math.max(0, deadline-performance.now())));
        }
      }
      await this.#checkpoint('locked');
      return await fn();
    } catch (e) { throw normalize(e); }
    finally {
      if (owned) {
        // Never remove a different owner's lock; an orphan remains fail-closed.
        try {
          const now = await lstat(this.#lockPath);
          if (now.ino !== owned.ino || now.dev !== owned.dev) fail('UNSAFE_PATH');
          this.#safe(now, true); await rmdir(this.#lockPath);
        } catch (e) { throw normalize(e); }
      }
    }
  }
  async #read(): Promise<State> {
    let file;
    try {
      this.#safe(await lstat(this.#path), false);
      file = await open(this.#path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = await file.stat(); this.#safe(stat, false);
      if (stat.size > MAX_BYTES) fail('STATE_INVALID');
      const buf = Buffer.alloc(MAX_BYTES+1); let used = 0;
      while (used < buf.length) {
        const { bytesRead } = await file.read(buf, used, buf.length-used, null);
        if (!bytesRead) break;
        used += bytesRead;
      }
      const state = decode(buf.subarray(0, used), this.#context);
      if (this.#seen && state.storeId !== this.#seen.storeId) fail('STATE_CHANGED');
      if (this.#seen && state.revision < this.#seen.revision) fail('STATE_REGRESSED');
      this.#seen = { storeId: state.storeId, revision: state.revision };
      return state;
    } catch (e) { if (missing(e)) fail('STATE_MISSING'); throw e; }
    finally { await file?.close(); }
  }
  #notCancelled(signal?: AbortSignal): void { if (signal?.aborted) fail('STATE_CHANGED'); }
  async #write(state: State, initial = false, signal?: AbortSignal): Promise<void> {
    const bytes = Buffer.from(canonical(state));
    decode(bytes, this.#context); // Same limits/invariants on outbound state, before any disk mutation.
    const temp = this.#path+'.'+randomUUID()+'.tmp';
    let file, owned: Stats | undefined, renamed = false;
    try {
      this.#notCancelled(signal);
      file = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      owned = await file.stat(); this.#safe(owned, false);
      await this.#checkpoint('beforeWrite'); this.#notCancelled(signal); await file.writeFile(bytes);
      await this.#checkpoint('beforeFileSync'); await file.sync(); await file.close(); file = undefined;
      await this.#checkpoint('beforeRename'); await this.#rootReady(false);
      let dest: Stats | undefined;
      try { dest = await lstat(this.#path); } catch (e) { if (!missing(e)) throw e; }
      if (initial && dest) fail('STATE_EXISTS');
      if (!initial && !dest) fail('STATE_MISSING');
      if (dest) this.#safe(dest, false);
      this.#notCancelled(signal);
      await rename(temp, this.#path); renamed = true;
      await this.#checkpoint('afterRename'); await this.#checkpoint('beforeDirectorySync');
      const directory = await open(this.#root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { this.#safe(await directory.stat(), true); await directory.sync(); } finally { await directory.close(); }
      this.#notCancelled(signal);
      this.#seen = { storeId: state.storeId, revision: state.revision };
    } catch (e) { if (renamed) fail('COMMIT_UNCERTAIN'); throw normalize(e); }
    finally {
      await file?.close();
      if (owned && !renamed) {
        try {
          const now = await lstat(temp);
          if (now.ino !== owned.ino || now.dev !== owned.dev) fail('UNSAFE_PATH');
          await unlink(temp);
        } catch (e) { if (!missing(e)) throw normalize(e); }
      }
    }
  }
  #snapshot(s: State): StoreSnapshot { const result=structuredClone({revision:s.revision,bindings:s.bindings});this.#snapshots.set(result,structuredClone(s));return result; }
  #issue(s: State, alias: string): StoreHandle {
    const h = Object.freeze({ alias, revision: s.revision });
    this.#issued.set(h, { alias, revision: s.revision, storeId: s.storeId }); return h;
  }
  #entry(s: State, h: StoreHandle): Entry {
    const issued = object(h) ? this.#issued.get(h) : undefined;
    if (!issued) fail('STALE_HANDLE');
    if (issued.storeId !== s.storeId || issued.revision !== s.revision) fail('STATE_CHANGED');
    const entry = s.bindings.find(b => b.alias === issued.alias);
    if (!entry) fail('STALE_HANDLE');
    return entry;
  }
  #expected(s: State, revision: number): void {
    if (!Number.isSafeInteger(revision) || revision < 0 || revision !== s.revision) fail('STATE_CHANGED');
  }
  #hydrate(s: State, current: readonly TargetEpoch[]): Policy {
    if (!Array.isArray(current)) fail('STATE_INVALID');
    const now=this.#now();if(!Number.isSafeInteger(now)||now<0)fail('STATE_INVALID');
    const snapshots = Array.from(current, v => epoch(v));
    const policy = new AllowedSessionsPolicy(), handles = new Map<string, BindingHandle>();
    const blocked = new Map<string, 'TARGET_UNAVAILABLE' | 'AMBIGUOUS_TARGET' | 'RIGHTS_EXPIRED'>();
    for (const b of s.bindings) {
      if (b.status !== 'active') continue;
      if (b.expiresAt !== undefined && b.expiresAt <= now) { blocked.set(b.alias, 'RIGHTS_EXPIRED'); continue; }
      const matches = snapshots.filter(v => v.project === b.target.project && v.peer === b.target.peer);
      if (matches.length === 1 && !same(matches[0], b.target)) { b.status = 'needsRebind'; b.rights = ['read']; continue; }
      if (matches.length !== 1) { blocked.set(b.alias, matches.length ? 'AMBIGUOUS_TARGET' : 'TARGET_UNAVAILABLE'); continue; }
      let h = policy.enroll(this.#context, { alias: b.alias, target: b.target }, snapshots);
      if (b.rights.includes('send')) h = policy.grantSend(this.#context, h, snapshots);
      if (b.rights.includes('approve')) h = policy.grantApprove(this.#context, h, snapshots);
      handles.set(b.alias, h);
    }
    return { policy, handles, blocked };
  }
  #active(b: Entry, p: Policy): BindingHandle {
    if (b.status === 'needsRebind') throw new AllowlistError('STALE_TARGET');
    const h = p.handles.get(b.alias);
    if (!h) { if (p.blocked.get(b.alias) === 'RIGHTS_EXPIRED') fail('RIGHTS_EXPIRED'); throw new AllowlistError(p.blocked.get(b.alias) as 'TARGET_UNAVAILABLE' | 'AMBIGUOUS_TARGET' ?? 'TARGET_UNAVAILABLE'); }
    return h;
  }
  async #run<T>(current: readonly TargetEpoch[] | undefined,
    action: (s: State, p: Policy) => (committed: State) => T, mutation = false, signal?: AbortSignal, send?:{alias:string;enabled:boolean}): Promise<T> {
    this.#notCancelled(signal);
    return this.#withLock(false, async () => {
      const original = await this.#read(), baseline = structuredClone(original);
      this.#notCancelled(signal);
      const p: Policy = current === undefined ? { policy: new AllowedSessionsPolicy(), handles: new Map<string, BindingHandle>(), blocked: new Map() }
        : this.#hydrate(baseline, current);
      const work = structuredClone(baseline);
      let result: (committed: State) => T;
      try { result = action(work, p); }
      catch (e) {
        // Persist positively observed staleness even when access/transition refuses.
        if (canonical(baseline) !== canonical(original)) await this.#commit(baseline,original);
        throw e;
      }
      if (mutation || canonical(work) !== canonical(original)) await this.#commit(work,original,signal,send);
      return result(work);
    });
  }
  async #commit(s: State,before:State,signal?:AbortSignal,send?:{alias:string;enabled:boolean}): Promise<void> {
    if (s.revision === Number.MAX_SAFE_INTEGER) fail('REVISION_EXHAUSTED');
    this.#notCancelled(signal);
    s.revision++;
    if(send){
      // Continuity is optional; its failure must never prevent explicit revoke.
      // The exact read guard rejects any missing/untrusted proof afterwards.
      try{await prepareSendLineage(this.#path+'.send-lineage',before,s,send.alias,send.enabled,state=>createHash('sha256').update(canonical(state)).digest('hex'),signal);}catch{/* Policy authority remains independent of its continuity witness. */}
    }else await retireFutureSendLineage(this.#path+'.send-lineage',before,s,signal);
    this.#notCancelled(signal);
    await this.#write(s, false, signal);
  }
  async initialize(): Promise<StoreSnapshot> {
    return this.#withLock(true, async () => {
      try { await lstat(this.#path); fail('STATE_EXISTS'); } catch (e) { if (!missing(e)) throw e; }
      const s: State = { format: 'fleet-local-allowlist', version: 1, storeId: randomUUID(), namespace: { ...this.#context }, revision: 0, bindings: [] };
      await this.#write(s, true); return this.#snapshot(s);
    });
  }
  /** Bounded read-only pre-byte CAS check; never repairs state, locks, grants
   * or treats an absent file as authority. Only snapshots issued by this store
   * instance are current; caller separately checks rights/lease/current owner. */
  snapshotCurrent(expected: StoreSnapshot | null): boolean {
    let fd: number | undefined;
    try {
      if (expected === null) { if (this.#seen) return false; try { const root = lstatSync(this.#root); this.#safe(root, true); } catch (e) { if (!missing(e)) return false; } try { lstatSync(this.#path); return false; } catch (e) { return missing(e); } }
      if (!this.#seen) return false;
      const root = lstatSync(this.#root); this.#safe(root, true);
      const before = lstatSync(this.#path); this.#safe(before, false);
      fd = openSync(this.#path, constants.O_RDONLY | constants.O_NOFOLLOW); const held = fstatSync(fd); this.#safe(held, false);
      if (held.dev !== before.dev || held.ino !== before.ino) return false;
      const buffer = Buffer.alloc(MAX_BYTES + 1), count = readSync(fd, buffer, 0, buffer.length, 0); if (count > MAX_BYTES || count !== held.size) return false;
      const state = decode(buffer.subarray(0, count), this.#context), after = fstatSync(fd), at = lstatSync(this.#path), parent = lstatSync(this.#root);
      if (after.dev !== held.dev || after.ino !== held.ino || after.mtimeMs !== held.mtimeMs || after.ctimeMs !== held.ctimeMs || after.size !== held.size || at.dev !== held.dev || at.ino !== held.ino || parent.dev !== root.dev || parent.ino !== root.ino) return false;
      this.#safe(after, false); this.#safe(at, false); this.#safe(parent, true);
      return state.storeId === this.#seen.storeId && state.revision === this.#seen.revision && JSON.stringify(this.#snapshot(state)) === JSON.stringify(expected);
    } catch { return false; } finally { if (fd !== undefined) closeSync(fd); }
  }
  /** Read-only advancement of an issued snapshot through explicit send writes.
   * Exact snapshots stay the default; unproved/gapped/other mutations fail closed. */
  advanceSendSnapshot(expected:StoreSnapshot|null,owner:TargetEpoch):StoreSnapshot|null{
    if(!expected)return null;const before=this.#snapshots.get(expected);
    if(!before||!this.#seen||this.#seen.storeId!==before.storeId||this.#seen.revision!==before.revision||JSON.stringify(expected)!==JSON.stringify({revision:before.revision,bindings:before.bindings}))return null;
    let fd:number|undefined;
    try{
      const root=lstatSync(this.#root);this.#safe(root,true);const at=lstatSync(this.#path);this.#safe(at,false);
      fd=openSync(this.#path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);const held=fstatSync(fd);this.#safe(held,false);
      if(held.dev!==at.dev||held.ino!==at.ino||held.size>MAX_BYTES)return null;
      const bytes=Buffer.alloc(MAX_BYTES+1);let count=0;while(count<bytes.length){const n=readSync(fd,bytes,count,bytes.length-count,null);if(!n)break;count+=n;}
      if(count!==held.size)return null;const state=decode(bytes.subarray(0,count),this.#context);
      if(!verifySendLineage(this.#path+'.send-lineage',before,state,owner,s=>createHash('sha256').update(canonical(s)).digest('hex')))return null;
      const after=fstatSync(fd),linked=lstatSync(this.#path),parent=lstatSync(this.#root);this.#safe(after,false);this.#safe(linked,false);this.#safe(parent,true);
      const stamp=(s:Stats)=>[s.dev,s.ino,s.mode,s.uid,s.nlink,s.size,s.mtimeMs,s.ctimeMs].join(':');
      if(stamp(after)!==stamp(held)||stamp(linked)!==stamp(held)||parent.dev!==root.dev||parent.ino!==root.ino)return null;
      this.#seen={storeId:state.storeId,revision:state.revision};return this.#snapshot(state);
    }catch{return null;}finally{if(fd!==undefined)closeSync(fd);}
  }
  async open(): Promise<StoreSnapshot> { return this.#run(undefined, () => committed => this.#snapshot(committed)); }
  async list(current: readonly TargetEpoch[]): Promise<StoreSnapshot> { return this.#run(current, () => committed => this.#snapshot(committed)); }
  async enroll(proposal: Readonly<{ alias: string; target: TargetEpoch }>, current: readonly TargetEpoch[], expectedRevision?: number): Promise<StoreHandle> {
    return this.#run(current, (s, p) => {
      // Optional S4 preview/commit CAS; legacy callers retain their existing behavior.
      if (expectedRevision !== undefined) this.#expected(s, expectedRevision);
      if (!keys(proposal, ['alias', 'target']) || !text(proposal.alias)) throw new AllowlistError('INVALID_INPUT');
      if (s.bindings.length >= MAX_BINDINGS) fail('STATE_INVALID');
      const proposedTarget = epoch(proposal.target);
      if (s.bindings.some(b => b.alias === proposal.alias || same(b.target, proposedTarget))) fail('STATE_INVALID');
      p.policy.enroll(this.#context, proposal, current);
      s.bindings.push({ alias: proposal.alias, target: epoch(proposal.target), rights: ['read'], status: 'active' });
      return committed => this.#issue(committed, proposal.alias);
    }, true);
  }
  /** Create-only atomic reviewed lease; existing bindings never change implicitly. */
  async connect(proposal: { alias: string; target: TargetEpoch; rights: readonly Right[]; expiresAt: number }, current: readonly TargetEpoch[], expectedRevision: number, signal?: AbortSignal): Promise<StoreSnapshot> {
    if (signal !== undefined && !(signal instanceof AbortSignal)) fail('STATE_INVALID');
    proposal = structuredClone(proposal); current = Array.from(current, v => epoch(v));
    const result = await this.#run(current, (s, p) => {
      this.#expected(s, expectedRevision);
      if (!keys(proposal, ['alias','target','rights','expiresAt']) || !text(proposal.alias) || !Number.isSafeInteger(proposal.expiresAt) || proposal.expiresAt <= this.#now()
        || !Array.isArray(proposal.rights) || JSON.stringify(proposal.rights) !== JSON.stringify(['read', ...(proposal.rights.includes('send') ? ['send'] : []), ...(proposal.rights.includes('approve') ? ['approve'] : [])])) fail('STATE_INVALID');
      if (s.bindings.length >= MAX_BINDINGS || s.bindings.some(b => b.alias === proposal.alias || same(b.target, proposal.target))) fail('STATE_CHANGED');
      p.policy.enroll(this.#context, { alias: proposal.alias, target: proposal.target }, current);
      s.version = 3;
      s.bindings.push({ alias: proposal.alias, target: epoch(proposal.target), rights: [...proposal.rights], status: 'active', expiresAt: proposal.expiresAt });
      return committed => this.#snapshot(committed);
    }, true, signal);
    if (signal?.aborted) fail('COMMIT_UNCERTAIN');
    return result;
  }
  /** Explicit reviewed replacement/renewal, never alias-based discovery or consent.
   * Codex writer only: caller owns human authorization, fresh owner/presence and
   * quiescent-writer checks. Old target and namespace revision are both CAS pins.
   * Cancellation before rename leaves the old lease; after rename is uncertain. */
  async reconnect(proposal: { alias: string; previousTarget: TargetEpoch; target: TargetEpoch; rights: readonly Right[]; expiresAt: number }, current: readonly TargetEpoch[], expectedRevision: number, signal: AbortSignal): Promise<StoreSnapshot> {
    if (!(signal instanceof AbortSignal) || !keys(proposal, ['alias','previousTarget','target','rights','expiresAt']) || !text(proposal.alias)
      || !Number.isSafeInteger(proposal.expiresAt) || !Array.isArray(proposal.rights) || proposal.rights.length > 3
      || JSON.stringify(proposal.rights) !== JSON.stringify(['read', ...(proposal.rights.includes('send') ? ['send'] : []), ...(proposal.rights.includes('approve') ? ['approve'] : [])])
      || !Array.isArray(current) || current.length > 128) fail('STATE_INVALID');
    const owned = { alias: proposal.alias, previousTarget: epoch(proposal.previousTarget), target: epoch(proposal.target), rights: Array.from(proposal.rights), expiresAt: proposal.expiresAt };
    const snapshots = Array.from(current, v => epoch(v));
    const result = await this.#run(snapshots, s => {
      this.#expected(s, expectedRevision);
      const now = this.#now();
      if (!Number.isSafeInteger(now) || now < 0 || owned.expiresAt <= now) fail('STATE_INVALID');
      const binding = s.bindings.find(b => b.alias === owned.alias);
      if (!binding) throw new AllowlistError('NOT_ALLOWED');
      if (!same(binding.target, owned.previousTarget) || s.bindings.some(b => b !== binding && same(b.target, owned.target))) fail('STATE_CHANGED');
      // A new policy validates the exact live replacement even if the old lease
      // is expired or has already been marked needsRebind. No old rights migrate.
      new AllowedSessionsPolicy().enroll(this.#context, { alias: owned.alias, target: owned.target }, snapshots);
      s.version = 3;
      binding.target = owned.target; binding.rights = owned.rights; binding.expiresAt = owned.expiresAt; binding.status = 'active';
      return committed => this.#snapshot(committed);
    }, true, signal);
    if (signal.aborted) fail('COMMIT_UNCERTAIN');
    return result;
  }
  async resolve(selector: string, current: readonly TargetEpoch[]): Promise<StoreHandle> {
    return this.#run(current, (s, p) => {
      if (!text(selector)) throw new AllowlistError('INVALID_INPUT');
      const matches = s.bindings.filter(b => b.alias === selector || b.target.project === selector);
      if (!matches.length) throw new AllowlistError('NOT_ALLOWED');
      if (matches.length !== 1) throw new AllowlistError('AMBIGUOUS_TARGET');
      this.#active(matches[0], p);
      return committed => this.#issue(committed, matches[0].alias);
    });
  }
  async authorize(handle: StoreHandle, right: Right, current: readonly TargetEpoch[]): Promise<TargetEpoch> {
    return this.#run(current, (s, p) => {
      const b = this.#entry(s, handle);
      const target = p.policy.authorize(this.#context, this.#active(b, p), right, current);
      return () => target;
    });
  }
  async grantSend(handle: StoreHandle, current: readonly TargetEpoch[]): Promise<StoreHandle> {
    return this.#run(current, (s, p) => {
      const b = this.#entry(s, handle);
      p.policy.grantSend(this.#context, this.#active(b, p), current); b.rights = ['read', 'send', ...(b.rights.includes('approve') ? ['approve' as const] : [])];
      return committed => this.#issue(committed, b.alias);
    }, true,undefined,{alias:handle.alias,enabled:true});
  }
  /** Explicit upgrade-on-grant: v1 rights are preserved; old writers fail closed on v2. */
  async grantApprove(handle: StoreHandle, current: readonly TargetEpoch[]): Promise<StoreHandle> {
    return this.#run(current, (s, p) => {
      const b = this.#entry(s, handle);
      p.policy.grantApprove(this.#context, this.#active(b, p), current);
      if (s.version < 2) s.version = 2;
      b.rights = ['read', ...(b.rights.includes('send') ? ['send' as const] : []), 'approve'];
      return committed => this.#issue(committed, b.alias);
    }, true);
  }
  async revokeApprove(alias: string, expectedRevision: number): Promise<StoreSnapshot> {
    return this.#run(undefined, s => {
      this.#expected(s, expectedRevision);
      const b = s.bindings.find(b => b.alias === alias); if (!b) throw new AllowlistError('NOT_ALLOWED');
      b.rights = b.rights.filter(r => r !== 'approve');
      return committed => this.#snapshot(committed);
    }, true);
  }
  async revokeSend(alias: string, expectedRevision: number): Promise<StoreSnapshot> {
    return this.#run(undefined, s => {
      this.#expected(s, expectedRevision);
      const b = s.bindings.find(b => b.alias === alias); if (!b) throw new AllowlistError('NOT_ALLOWED');
      b.rights = b.rights.filter(r => r !== 'send'); return committed => this.#snapshot(committed);
    }, true,undefined,{alias,enabled:false});
  }
  async revoke(alias: string, expectedRevision: number): Promise<StoreSnapshot> {
    return this.#run(undefined, s => {
      this.#expected(s, expectedRevision);
      const index = s.bindings.findIndex(b => b.alias === alias); if (index < 0) throw new AllowlistError('NOT_ALLOWED');
      s.bindings.splice(index, 1); return committed => this.#snapshot(committed);
    }, true);
  }
  async rebind(alias: string, target: TargetEpoch, current: readonly TargetEpoch[], expectedRevision: number): Promise<StoreHandle> {
    return this.#run(current, s => {
      this.#expected(s, expectedRevision);
      const b = s.bindings.find(b => b.alias === alias); if (!b) throw new AllowlistError('NOT_ALLOWED');
      // A stale/offline descriptor cannot be imported into S1; validate the new exact epoch independently.
      const validation = new AllowedSessionsPolicy(); validation.enroll(this.#context, { alias, target }, current);
      if (s.bindings.some(other => other !== b && same(other.target, target))) fail('STATE_INVALID');
      b.target = epoch(target); b.rights = ['read']; b.status = 'active';
      return committed => this.#issue(committed, alias);
    }, true);
  }
}
