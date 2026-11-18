// Observation metadata only. Never policy/grants, payload archive or delivery receipts.
import * as fs from 'node:fs';
import { resolve, join, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { ConversationKey, TargetEpoch } from './fleet-codex-allowlist.ts';
export class ObservationStoreError extends Error {
    readonly code: string;
    constructor(code: string) { super(code); this.code = code; this.name = 'ObservationStoreError'; }
}
function fail(code: string): never { throw new ObservationStoreError(code); }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, names: string[]) => Object.keys(v).length === names.length && names.every(k => Object.hasOwn(v, k));
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 1024 && !/[\u0000-\u001f]/.test(v);
const token = (v: unknown) => v === null || typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const date = (v: unknown): v is string => typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v));
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
export type CursorData = {
    leaf: string | null;
    lastEvent: string | null;
    questions: string[];
    observedAt: string;
};
export type Cursor = CursorData & {
    target: TargetEpoch;
    revision: number;
};
type State = {
    format: 'fleet-observations';
    version: 1;
    namespace: ConversationKey;
    revision: number;
    targets: Cursor[];
};
export const epochKey = (t: TargetEpoch) => JSON.stringify([t.project, t.peer, t.sessionId, t.startedAt]);
const contextKey = (c: ConversationKey) => {
    if (!object(c) || !keys(c, ['hostProfile', 'principal', 'threadId']) || ![c.hostProfile, c.principal, c.threadId].every(text))
        fail('CURSOR_IDENTITY_INVALID');
    return JSON.stringify([c.hostProfile, c.principal, c.threadId]);
};
function validTarget(v: unknown): v is TargetEpoch { return object(v) && keys(v, ['project', 'peer', 'sessionId', 'startedAt']) && text(v.project) && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(v.project) && !v.project.includes('..') && typeof v.peer === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(v.peer) && text(v.sessionId) && date(v.startedAt); }
function validData(v: unknown): v is CursorData { return object(v) && keys(v, ['leaf', 'lastEvent', 'questions', 'observedAt']) && token(v.leaf) && token(v.lastEvent) && date(v.observedAt) && Array.isArray(v.questions) && v.questions.length <= 256 && v.questions.every(q => typeof q === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(q)) && new Set(v.questions).size === v.questions.length; }
function validCursor(v: unknown): v is Cursor { return object(v) && keys(v, ['leaf', 'lastEvent', 'questions', 'observedAt', 'target', 'revision']) && validTarget(v.target) && positive(v.revision) && validData({ leaf: v.leaf, lastEvent: v.lastEvent, questions: v.questions, observedAt: v.observedAt }); }
const MAX_BYTES = 1048576;
export class ObservationStore {
    readonly #root: string;
    readonly #checkpoint?: (stage: string) => void;
    readonly #known = new Map<string, number>();
    constructor(root: string, options: {
        checkpoint?: (stage: string) => void;
    } = {}) { if (!isAbsolute(root) || resolve(root) !== root)
        fail('CURSOR_UNSAFE_PATH'); this.#root = root; this.#checkpoint = options.checkpoint; }
    #path(c: ConversationKey) { return join(this.#root, createHash('sha256').update(contextKey(c)).digest('hex') + '.json'); }
    #safe(path: string, directory = false): fs.Stats | null {
        let s: fs.Stats;
        try {
            s = fs.lstatSync(path);
        }
        catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'ENOENT')
                return null;
            throw new ObservationStoreError('CURSOR_IO_ERROR');
        }
        if (s.isSymbolicLink() || !(directory ? s.isDirectory() : s.isFile()) || process.getuid && s.uid !== process.getuid() || (s.mode & 0o077) !== 0 || !directory && s.nlink !== 1)
            fail('CURSOR_UNSAFE_PATH');
        return s;
    }
    #load(c: ConversationKey): State | null {
        const path = this.#path(c), root = this.#safe(this.#root, true), st = root ? this.#safe(path) : null;
        if (!st) {
            if (this.#known.has(path))
                fail('CURSOR_STATE_MISSING');
            return null;
        }
        if (st.size > MAX_BYTES)
            fail('CURSOR_LIMIT');
        let raw: unknown, fd: number | undefined;
        try {
            fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
            const opened = fs.fstatSync(fd);
            if (opened.dev !== st.dev || opened.ino !== st.ino)
                fail('CURSOR_STATE_CHANGED');
            const bytes = fs.readFileSync(fd);
            if (bytes.length > MAX_BYTES)
                fail('CURSOR_LIMIT');
            const after = fs.fstatSync(fd);
            if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs)
                fail('CURSOR_STATE_CHANGED');
            try {
                raw = JSON.parse(bytes.toString('utf8'));
            }
            catch {
                fail('CURSOR_STATE_INVALID');
            }
        }
        catch (e) {
            if (e instanceof ObservationStoreError)
                throw e;
            throw new ObservationStoreError('CURSOR_IO_ERROR');
        }
        finally {
            if (fd !== undefined)
                fs.closeSync(fd);
        }
        if (!object(raw))
            fail('CURSOR_STATE_INVALID');
        if (raw.version !== 1)
            fail('CURSOR_STATE_VERSION');
        if (!keys(raw, ['format', 'version', 'namespace', 'revision', 'targets']) || raw.format !== 'fleet-observations' || !positive(raw.revision) || !object(raw.namespace) || !keys(raw.namespace, ['hostProfile', 'principal', 'threadId']) || !['hostProfile', 'principal', 'threadId'].every(k => text((raw.namespace as Record<string, unknown>)[k])) || !Array.isArray(raw.targets) || raw.targets.length > 32 || !raw.targets.every(validCursor))
            fail('CURSOR_STATE_INVALID');
        if (contextKey(raw.namespace as unknown as ConversationKey) !== contextKey(c))
            fail('CURSOR_NAMESPACE_MISMATCH');
        const state = raw as unknown as State;
        if (new Set(state.targets.map(v => epochKey(v.target))).size !== state.targets.length)
            fail('CURSOR_STATE_INVALID');
        if (state.revision < (this.#known.get(path) ?? 0))
            fail('CURSOR_STATE_CHANGED');
        this.#known.set(path, state.revision);
        return state;
    }
    read(c: ConversationKey, target: TargetEpoch) {
        if (!validTarget(target))
            fail('CURSOR_STATE_INVALID');
        const s = this.#load(c), cursor = s?.targets.find(v => epochKey(v.target) === epochKey(target)) ?? null;
        return { cursor: structuredClone(cursor), reset: cursor ? null : s?.targets.some(v => v.target.project === target.project && v.target.peer === target.peer) ? 'epoch_changed' : 'initial' };
    }
    async save(c: ConversationKey, target: TargetEpoch, expectedRevision: number | null, next: CursorData, guard: () => Promise<void>): Promise<Cursor> {
        const path = this.#path(c);
        if (!validTarget(target) || !validData(next) || expectedRevision !== null && !positive(expectedRevision))
            fail('CURSOR_STATE_INVALID');
        // Await remote/local authorization BEFORE the synchronous lock section. Different
        // targets merge under one fresh disk read; no async lock holder blocks its sibling.
        await guard();
        if (!this.#safe(this.#root, true)) {
            try {
                fs.mkdirSync(this.#root, { recursive: true, mode: 0o700 });
            }
            catch {
                fail('CURSOR_IO_ERROR');
            }
        }
        const root = this.#safe(this.#root, true)!, lock = path + '.lock';
        let fd: number;
        try {
            fd = fs.openSync(lock, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        }
        catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'EEXIST')
                fail('CURSOR_BUSY');
            throw new ObservationStoreError('CURSOR_IO_ERROR');
        }
        const lockStat = fs.fstatSync(fd), tmp = path + '.' + randomUUID() + '.tmp';
        try {
            const s = this.#load(c) ?? { format: 'fleet-observations' as const, version: 1 as const, namespace: { ...c }, revision: 0, targets: [] }, old = s.targets.find(v => epochKey(v.target) === epochKey(target));
            if ((old?.revision ?? null) !== expectedRevision)
                fail('CURSOR_STATE_CHANGED');
            if (!old && s.targets.length >= 32 || s.revision >= Number.MAX_SAFE_INTEGER || (old?.revision ?? 0) >= Number.MAX_SAFE_INTEGER)
                fail('CURSOR_LIMIT');
            const cursor: Cursor = { ...structuredClone(next), target: { ...target }, revision: (old?.revision ?? 0) + 1 };
            s.targets = s.targets.filter(v => epochKey(v.target) !== epochKey(target));
            s.targets.push(cursor);
            s.revision++;
            const bytes = JSON.stringify(s);
            if (Buffer.byteLength(bytes) > MAX_BYTES)
                fail('CURSOR_LIMIT');
            const currentRoot = this.#safe(this.#root, true);
            if (!currentRoot || currentRoot.dev !== root.dev || currentRoot.ino !== root.ino)
                fail('CURSOR_UNSAFE_PATH');
            let renamed = false;
            try {
                const output = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
                try {
                    fs.writeFileSync(output, bytes);
                    fs.fsyncSync(output);
                }
                finally {
                    fs.closeSync(output);
                }
                this.#checkpoint?.('beforeRename');
                fs.renameSync(tmp, path);
                renamed = true;
                this.#checkpoint?.('afterRename');
                const dir = fs.openSync(this.#root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
                try {
                    fs.fsyncSync(dir);
                }
                finally {
                    fs.closeSync(dir);
                }
            }
            catch {
                throw new ObservationStoreError(renamed ? 'CURSOR_COMMIT_UNCERTAIN' : 'CURSOR_IO_ERROR');
            }
            this.#known.set(path, s.revision);
            return structuredClone(cursor);
        }
        finally {
            try {
                fs.rmSync(tmp, { force: true });
            }
            finally {
                fs.closeSync(fd);
                const own = this.#safe(lock);
                if (own?.dev === lockStat.dev && own.ino === lockStat.ino)
                    fs.unlinkSync(lock);
            }
        }
    }
}
