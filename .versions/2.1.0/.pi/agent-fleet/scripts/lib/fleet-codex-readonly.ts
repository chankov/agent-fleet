// S3: registry metadata/read-policy checks only. No peer RPC or transport identity proof.
import { constants } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { AllowedSessionsPolicy, type ConversationKey, type TargetEpoch } from './fleet-codex-allowlist.ts';
import { AllowedSessionsStore, StoreError } from './fleet-codex-allowlist-store.ts';

export type RegistryReason = 'REGISTRY_MISSING' | 'UNSAFE_PATH' | 'READ_ERROR' | 'ENTRY_INVALID'
  | 'ENTRY_TOO_LARGE' | 'ENTRY_LIMIT' | 'BYTE_LIMIT';
export type RegistryCandidate = Readonly<{ target: TargetEpoch; heartbeatAt: string; presence: 'fresh' | 'unavailable' }>;
export type RegistrySnapshot = Readonly<{ status: 'complete' | 'unavailable'; partial: boolean; reasons: readonly RegistryReason[];
  observedAt: string; entriesSeen: number; candidates: readonly RegistryCandidate[] }>;
export type RegistryReader = (project: string) => Promise<RegistrySnapshot>;
export class ReadonlyFleetError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'ReadonlyFleetError'; this.code = code; }
}
const projectPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const peerPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const reasons: readonly RegistryReason[] = ['REGISTRY_MISSING', 'UNSAFE_PATH', 'READ_ERROR', 'ENTRY_INVALID', 'ENTRY_TOO_LARGE', 'ENTRY_LIMIT', 'BYTE_LIMIT'];
const fields = ['project', 'peer', 'sessionId', 'startedAt'] as const;
function fail(code: string): never { throw new ReadonlyFleetError(code); }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exactKeys = (v: unknown, ks: readonly string[]): v is Record<string, unknown> => object(v)
  && Object.keys(v).length === ks.length && ks.every(k => Object.hasOwn(v, k));
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 1024
  && v.trim() === v && !/[\u0000-\u001f\u007f*]/u.test(v);
const projectName = (v: unknown): v is string => text(v) && projectPattern.test(v) && !v.includes('..');
const peerName = (v: unknown): v is string => typeof v === 'string' && peerPattern.test(v);
// Registry writers use zoned ISO timestamps; do not echo Date.parse-tolerated free text.
// Preserve the original representation for exact startedAt matching (no epoch coercion).
const date = (v: unknown): v is string => text(v)
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(v)
  && Number.isFinite(Date.parse(v));
const same = (a: TargetEpoch, b: TargetEpoch): boolean => fields.every(k => a[k] === b[k]);
function clock(now: () => number): number {
  const ms = now();
  if (!Number.isFinite(ms) || ms < 0 || ms > 8.64e15) fail('CLOCK_INVALID');
  return ms;
}
function presence(heartbeat: string, at: number): RegistryCandidate['presence'] {
  const age = at-Date.parse(heartbeat);
  return age >= -5000 && age <= 90000 ? 'fresh' : 'unavailable';
}
function hostContext(v: unknown): ConversationKey {
  if (!object(v) || !['hostProfile', 'principal', 'threadId'].every(k => Object.hasOwn(v, k) && text(v[k]))) fail('IDENTITY_REQUIRED');
  if (!exactKeys(v, ['hostProfile', 'principal', 'threadId'])) fail('CONTEXT_CONFLICT');
  try { new AllowedSessionsPolicy().list(v as ConversationKey); } catch { fail('CONTEXT_CONFLICT'); }
  return Object.freeze({ hostProfile: v.hostProfile as string, principal: v.principal as string, threadId: v.threadId as string });
}
function request(v: unknown, requirePeer: boolean): { project: string; peer?: string } {
  if (!object(v) || !Object.hasOwn(v, 'project') || !projectName(v.project)
      || Object.keys(v).some(k => k !== 'project' && k !== 'peer')
      || Object.hasOwn(v, 'peer') && !peerName(v.peer) || requirePeer && (!Object.hasOwn(v, 'peer') || !peerName(v.peer))) fail('INVALID_REQUEST');
  return { project: v.project, ...(Object.hasOwn(v, 'peer') ? { peer: v.peer as string } : {}) };
}
function target(v: unknown, project: string): TargetEpoch {
  if (!exactKeys(v, fields) || v.project !== project || !projectName(v.project) || !peerName(v.peer)
      || !text(v.sessionId) || !date(v.startedAt)) fail('REGISTRY_INVALID');
  return { project, peer: v.peer, sessionId: v.sessionId, startedAt: v.startedAt };
}
function snapshot(v: unknown, project: string, now: number): RegistrySnapshot {
  if (!object(v) || v.status !== 'complete' && v.status !== 'unavailable' || typeof v.partial !== 'boolean'
      || !date(v.observedAt) || Math.abs(now-Date.parse(v.observedAt)) > 5000
      || !Number.isInteger(v.entriesSeen) || (v.entriesSeen as number) < 0 || (v.entriesSeen as number) > 65
      || !Array.isArray(v.reasons) || v.reasons.length > reasons.length || Array.from(v.reasons).some(r => !reasons.includes(r))
      || !Array.isArray(v.candidates) || v.candidates.length > 64 || v.candidates.length > (v.entriesSeen as number)
      || v.status === 'unavailable' && !v.partial || v.reasons.length > 0 && !v.partial) fail('REGISTRY_INVALID');
  const candidates = Array.from(v.candidates, c => {
    if (!object(c) || !date(c.heartbeatAt) || c.presence !== 'fresh' && c.presence !== 'unavailable') fail('REGISTRY_INVALID');
    return { target: target(c.target, project), heartbeatAt: c.heartbeatAt, presence: presence(c.heartbeatAt, now) };
  });
  return { status: v.status, partial: v.partial, reasons: [...new Set(v.reasons as RegistryReason[])],
    observedAt: v.observedAt, entriesSeen: v.entriesSeen as number, candidates };
}
function choose(s: RegistrySnapshot, peer: string): RegistryCandidate {
  if (s.status !== 'complete') fail('REGISTRY_UNAVAILABLE');
  if (s.partial) fail('REGISTRY_PARTIAL');
  const matches = s.candidates.filter(c => c.target.peer === peer);
  if (!matches.length) fail('TARGET_UNAVAILABLE');
  if (matches.length !== 1) fail('AMBIGUOUS_TARGET');
  if (matches[0].presence !== 'fresh') fail('TARGET_UNAVAILABLE');
  return matches[0];
}
// Filtering stale candidates must never turn duplicate identity into unique positive evidence.
function currentEpochs(s: RegistrySnapshot): TargetEpoch[] {
  const counts = new Map<string, number>();
  for (const c of s.candidates) counts.set(c.target.peer, (counts.get(c.target.peer) ?? 0)+1);
  return s.candidates.filter(c => c.presence === 'fresh' && counts.get(c.target.peer) === 1).map(c => c.target);
}
const unchecked = { source: 'registry_metadata', remote: 'not_checked', transcript: 'not_checked', questions: 'not_checked' } as const;

/** Caller/launcher owns the outer host envelope, reader and fixed local policy root.
 * Arguments cannot choose identity/root/rights. Inputs are not human/auth attestations.
 */
export class ReadonlyFleetBridge {
  readonly #read: RegistryReader;
  readonly #root: string;
  readonly #now: () => number;
  constructor(options: Readonly<{ registryReader: RegistryReader; policyBaseDir: string; now?: () => number }>) {
    this.#read = options.registryReader; this.#root = options.policyBaseDir; this.#now = options.now ?? Date.now;
  }
  async #registry(project: string): Promise<RegistrySnapshot> {
    try { return snapshot(await this.#read(project), project, clock(this.#now)); }
    catch (e) {
      if (e instanceof ReadonlyFleetError && ['REGISTRY_INVALID', 'CLOCK_INVALID', 'INVALID_REQUEST'].includes(e.code)) throw e;
      fail('REGISTRY_UNAVAILABLE');
    }
  }
  async discoverCandidates(outerHostContext: unknown, arguments_: unknown) {
    hostContext(outerHostContext); // Guard precedes even discovery; no policy file is opened here.
    const q = request(arguments_, false), s = await this.#registry(q.project);
    return { ...s, candidates: s.candidates.filter(c => !q.peer || c.target.peer === q.peer), ...unchecked };
  }
  async checkAllowedReadTarget(outerHostContext: unknown, arguments_: unknown) {
    const context = hostContext(outerHostContext), q = request(arguments_, true);
    const first = await this.#registry(q.project), candidate = choose(first, q.peer!).target;
    try {
      const store = new AllowedSessionsStore(this.#root, context);
      const current = currentEpochs(first);
      const list = await store.list(current);
      const matches = list.bindings.filter(b => b.target.project === q.project && b.target.peer === q.peer);
      if (!matches.length) fail('NOT_ALLOWED');
      if (matches.length !== 1) fail('AMBIGUOUS_TARGET');
      const handle = await store.resolve(matches[0].alias, current);
      if (!same(await store.authorize(handle, 'read', current), candidate)) fail('TARGET_CHANGED');
      const second = await this.#registry(q.project), selected = choose(second, q.peer!).target;
      const checked = await store.authorize(handle, 'read', currentEpochs(second));
      if (!same(selected, candidate) || !same(checked, candidate)) fail('TARGET_CHANGED');
      return { target: { ...checked }, permission: 'read' as const, checkedAt: second.observedAt,
        scope: 'snapshot_only' as const, ...unchecked };
    } catch (e) {
      if (e instanceof ReadonlyFleetError) throw e;
      if (e instanceof StoreError) fail(e.code);
      fail('POLICY_UNAVAILABLE');
    }
  }
}

/** Read-only leaf: explicit trusted root/clock, no environment/path discovery or peer probes.
 * Ancestors are deployment-trusted. No claim of hostile same-user race isolation.
 */
export function createReadonlyRegistryReader(options: Readonly<{ registryRoot: string; now?: () => number }>): RegistryReader {
  const root = options.registryRoot, now = options.now ?? Date.now;
  if (typeof root !== 'string' || !isAbsolute(root) || resolve(root) !== root) fail('INVALID_READER_OPTIONS');
  return async project => {
    if (!projectName(project)) fail('INVALID_REQUEST');
    const found: { target: TargetEpoch; heartbeatAt: string }[] = [];
    const problems = new Set<RegistryReason>();
    let entriesSeen = 0, bytesRead = 0, status: RegistrySnapshot['status'] = 'complete';
    const finish = (): RegistrySnapshot => {
      const at = clock(now);
      return { status, partial: problems.size > 0, reasons: [...problems], entriesSeen, observedAt: new Date(at).toISOString(),
        candidates: found.map(c => ({ ...c, presence: presence(c.heartbeatAt, at) }))
          .sort((a, b) => JSON.stringify(a.target) < JSON.stringify(b.target) ? -1 : JSON.stringify(a.target) > JSON.stringify(b.target) ? 1 : 0) };
    };
    const dirs = [root, join(root, 'projects'), join(root, 'projects', project), join(root, 'projects', project, 'agents')];
    try {
      for (const dir of dirs) {
        const s = await lstat(dir);
        if (!s.isDirectory()) { problems.add('UNSAFE_PATH'); status = 'unavailable'; return finish(); }
      }
    } catch (e) {
      problems.add(object(e) && e.code === 'ENOENT' ? 'REGISTRY_MISSING' : 'READ_ERROR');
      status = 'unavailable'; return finish();
    }
    let directory;
    try {
      directory = await opendir(dirs[3], { bufferSize: 8 });
      for (;;) {
        const entry = await directory.read();
        if (!entry) break;
        if (++entriesSeen > 64) { problems.add('ENTRY_LIMIT'); break; }
        if (!entry.name.endsWith('.json')) continue;
        const filePath = join(dirs[3], entry.name);
        let file;
        try {
          const stat = await lstat(filePath);
          if (!stat.isFile()) { problems.add('UNSAFE_PATH'); continue; }
          if (stat.size > 16384) { problems.add('ENTRY_TOO_LARGE'); continue; }
          if (bytesRead+stat.size > 1048576) { problems.add('BYTE_LIMIT'); break; }
          file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          const actual = await file.stat();
          if (!actual.isFile()) { problems.add('UNSAFE_PATH'); continue; }
          if (actual.size > 16384) { problems.add('ENTRY_TOO_LARGE'); continue; }
          const buffer = Buffer.alloc(Math.min(16384, 1048576-bytesRead)+1);
          let used = 0;
          while (used < buffer.length) {
            const part = await file.read(buffer, used, buffer.length-used, null);
            if (!part.bytesRead) break;
            used += part.bytesRead;
          }
          bytesRead += used;
          if (bytesRead > 1048576) { problems.add('BYTE_LIMIT'); break; }
          if (used > 16384) { problems.add('ENTRY_TOO_LARGE'); continue; }
          let raw: unknown;
          try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, used))); }
          catch { problems.add('ENTRY_INVALID'); continue; }
          if (!object(raw)) { problems.add('ENTRY_INVALID'); continue; }
          if (raw.explicit === true) continue; // Explicit non-Pi participants are not candidates.
          if (raw.explicit !== undefined && raw.explicit !== false || Object.hasOwn(raw, 'project') && raw.project !== project
              || !peerName(raw.name) || !text(raw.session_id) || !date(raw.started_at) || !date(raw.heartbeat_at)) {
            problems.add('ENTRY_INVALID'); continue;
          }
          found.push({ target: { project, peer: raw.name, sessionId: raw.session_id, startedAt: raw.started_at }, heartbeatAt: raw.heartbeat_at });
        } catch { problems.add('READ_ERROR'); }
        finally { try { await file?.close(); } catch { problems.add('READ_ERROR'); } }
      }
    } catch { problems.add('READ_ERROR'); status = 'unavailable'; }
    finally { try { await directory?.close(); } catch { problems.add('READ_ERROR'); } }
    return finish();
  };
}
