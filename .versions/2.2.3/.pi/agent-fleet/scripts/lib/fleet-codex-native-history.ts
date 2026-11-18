// Native-only local history. No CLI imports, environment discovery, grants or peer writes.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { AllowedSessionsPolicy, type ConversationKey, type TargetEpoch } from './fleet-codex-allowlist.ts';
import { redactSecrets } from '../../../harnesses/lib/fleet-transcript-store.ts';
export class HistoryError extends Error {
    readonly code: string;
    constructor(code: string) { super(code); this.code = code; }
}
function fail(code: string): never { throw new HistoryError(code); }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const hash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const MAX = 4 * 1024 * 1024;
function redactedJson(value: unknown) { let nodes = 0; return JSON.stringify(value, (key, v: unknown) => { if (++nodes > 131072)
    fail('HISTORY_LIMIT'); if (/(?:api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|pwd|token|secret|authorization)$/i.test(key))
    return '[REDACTED]'; if (typeof v === 'string')
    return v.length > 4096 ? '[HISTORY_TEXT_WITHHELD:SIZE_LIMIT]' : redactSecrets(v); return v; }); }
function contextKey(c: ConversationKey) { try {
    new AllowedSessionsPolicy().list(c);
}
catch {
    fail('HISTORY_IDENTITY_INVALID');
} return JSON.stringify([c.hostProfile, c.principal, c.threadId]); }
function identity(c: ConversationKey) { contextKey(c); if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(c.threadId))
    fail('HISTORY_IDENTITY_INVALID'); return c.threadId.toLowerCase(); }
function selector(v: unknown): {
    project: string;
    peer: string;
} { if (!object(v) || Object.keys(v).some(k => !['project', 'peer'].includes(k)) || typeof v.project !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(v.project) || v.project.includes('..') || typeof v.peer !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(v.peer))
    fail('INVALID_ARGUMENTS'); return { project: v.project, peer: v.peer }; }
function ancestors(p: string) { if (typeof process.getuid !== 'function')
    fail('HISTORY_UNSUPPORTED_PLATFORM'); const uid = process.getuid(); for (let current = p;; current = path.dirname(current)) {
    const s = fs.lstatSync(current);
    if (s.isSymbolicLink() || !s.isDirectory() || s.uid !== uid && s.uid !== 0 || (s.mode & 0o022) !== 0 && (s.mode & 0o1000) === 0)
        fail('HISTORY_UNSAFE_PATH');
    if (current === path.dirname(current))
        break;
} }
function stat(p: string, directory: boolean) { try {
    const s = fs.lstatSync(p);
    if (s.isSymbolicLink() || !(directory ? s.isDirectory() : s.isFile()) || s.uid !== process.getuid?.() || (s.mode & 0o077) || !directory && s.nlink !== 1)
        fail('HISTORY_UNSAFE_PATH');
    if (directory) {
        ancestors(p);
        if (fs.realpathSync(p) !== p)
            fail('HISTORY_UNSAFE_PATH');
    }
    return s;
}
catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT')
        return null;
    throw e;
} }
function read(root: string, name: string) { const dir = stat(root, true); if (!dir)
    return null; const p = path.join(root, name), before = stat(p, false); if (!before)
    return null; if (before.size > MAX)
    fail('HISTORY_LIMIT'); const fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); try {
    const opened = fs.fstatSync(fd);
    if (opened.ino !== before.ino || opened.dev !== before.dev)
        fail('HISTORY_STATE_CHANGED');
    const bytes = fs.readFileSync(fd);
    if (bytes.length > MAX)
        fail('HISTORY_LIMIT');
    const after = fs.fstatSync(fd), current = stat(p, false), end = stat(root, true);
    if (!current || !end || current.ino !== opened.ino || current.dev !== opened.dev || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || end.ino !== dir.ino || end.dev !== dir.dev)
        fail('HISTORY_STATE_CHANGED');
    return bytes;
}
finally {
    fs.closeSync(fd);
} }
function json(bytes: Buffer) { try {
    const value = JSON.parse(bytes.toString('utf8'));
    if (!object(value))
        fail('LEGACY_STATE_INVALID');
    return value;
}
catch (e) {
    if (e instanceof HistoryError)
        throw e;
    return fail('LEGACY_STATE_INVALID');
} }
export class NativeHistory {
    readonly #root: string;
    readonly #legacy?: string;
    constructor(policyRoot: string, legacyRoot?: string) { if (!path.isAbsolute(policyRoot) || path.resolve(policyRoot) !== policyRoot)
        fail('HISTORY_UNSAFE_PATH'); this.#root = policyRoot + '.reports'; this.#legacy = legacyRoot; if (legacyRoot) {
        if (!path.isAbsolute(legacyRoot) || path.resolve(legacyRoot) !== legacyRoot || [policyRoot, policyRoot + '.instructions', policyRoot + '.observations', this.#root].some(p => p === legacyRoot || p.startsWith(legacyRoot + path.sep) || legacyRoot.startsWith(p + path.sep)))
            fail('HISTORY_UNSAFE_PATH');
    } }
    #archive(c: ConversationKey) { const id = identity(c); if (!this.#legacy)
        fail('LEGACY_NOT_CONFIGURED'); if (!stat(this.#legacy, true))
        fail('LEGACY_ARCHIVE_MISSING'); const bindingBytes = read(this.#legacy, id + '.json'), runtimeBytes = read(this.#legacy, id + '.json.runtime'); if (!bindingBytes && !runtimeBytes)
        return null; const binding = bindingBytes ? json(bindingBytes) : null; if (bindingBytes && bindingBytes.length > 8192)
        fail('LEGACY_STATE_INVALID'); if (binding) {
        if (binding.version !== 1 || binding.clientId !== id || !['project', 'peer', 'sessionId', 'startedAt', 'selectedAt'].every(k => text(binding[k])) || !Number.isFinite(Date.parse(binding.startedAt as string)) || !Number.isFinite(Date.parse(binding.selectedAt as string)))
            fail('LEGACY_STATE_INVALID');
        selector({ project: binding.project, peer: binding.peer });
    } let runtime: Record<string, unknown> | null = null; if (runtimeBytes) {
        runtime = json(runtimeBytes);
        if (runtime.version !== 1 || !Array.isArray(runtime.receipts) || runtime.receipts.length > 1000 || !object(runtime.cursor) || runtime.receipts.some(r => !object(r) || !['commandId', 'target', 'digest', 'at'].every(k => text(r[k])) || !['unknown', 'submitted', 'queued', 'result', 'failed'].includes(r.state as string)))
            fail('LEGACY_STATE_INVALID');
        if (runtime.questionReceipts !== undefined && (!Array.isArray(runtime.questionReceipts) || runtime.questionReceipts.length > 1000 || runtime.questionReceipts.some(r => !object(r) || !['requestId', 'wireId', 'target', 'questionId', 'digest', 'status', 'at'].every(k => text(r[k])))))
            fail('LEGACY_STATE_INVALID');
    } return { binding, bindingBytes, runtime, runtimeBytes }; }
    legacy(c: ConversationKey, input: unknown) {
        if (!object(input) || Object.keys(input).some(k => !['section', 'offset', 'limit', 'sourceSha256'].includes(k)) || !['selection', 'runtime'].includes(input.section as string)) fail('INVALID_ARGUMENTS');
        const offset=input.offset??0,limit=input.limit??8192,expected=input.sourceSha256;
        if(!Number.isSafeInteger(offset)||(offset as number)<0||!Number.isSafeInteger(limit)||(limit as number)<1||(limit as number)>8192||expected!==undefined&&(typeof expected!=='string'||! /^[a-f0-9]{64}$/.test(expected))||(offset as number)>0&&expected===undefined)fail('INVALID_ARGUMENTS');
        const archive=this.#archive(c),bytes=archive&&(input.section==='selection'?archive.bindingBytes:archive.runtimeBytes);
        if(!bytes){if(expected!==undefined)fail('HISTORY_STATE_CHANGED');return {status:'unavailable',scope:'historical_only',remote:'not_checked',text:'',nextOffset:null};}
        const sourceSha256=hash(bytes);if(expected!==undefined&&expected!==sourceSha256)fail('HISTORY_STATE_CHANGED');
        const redacted=redactedJson(json(bytes));if(redacted.length>MAX)fail('HISTORY_LIMIT');if((offset as number)>redacted.length)fail('INVALID_ARGUMENTS');
        const end=Math.min(redacted.length,(offset as number)+(limit as number));
        return {status:'historical',scope:'historical_only',remote:'not_checked',humanProvenance:'unknown',encoding:'redacted_json_fragment',offset,text:redacted.slice(offset as number,end),nextOffset:end<redacted.length?end:null,sourceSha256,totalCharacters:redacted.length};
    }
    assertNewAction(c: ConversationKey, id: string) { const thread = identity(c); if (!this.#legacy)
        return; for (const suffix of ['.json.lock', '.json.runtime.lock']) {
        try {
            fs.lstatSync(path.join(this.#legacy, thread + suffix));
            fail('LEGACY_WRITER_ACTIVE');
        }
        catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
                throw e;
        }
    } const a = this.#archive(c); if (!a?.runtime)
        return; const receipts = a.runtime.receipts as Record<string, unknown>[], questions = (a.runtime.questionReceipts ?? []) as Record<string, unknown>[]; if (receipts.some(r => r.commandId === id) || questions.some(r => r.requestId === id))
        fail('LEGACY_REQUEST_ID_RESERVED'); }
    #name(c: ConversationKey, s: unknown) { identity(c); return hash(JSON.stringify([contextKey(c), selector(s)])) + '.json'; }
    save(c: ConversationKey, t: TargetEpoch, report: unknown) {
        const s = selector({ project: t.project, peer: t.peer }), name = this.#name(c, s);
        if (!object(report))
            fail('INVALID_ARGUMENTS');
        const value = { version: 1, context: contextKey(c), selector: s, target: t, observedAt: new Date().toISOString(), report };
        if (Buffer.byteLength(JSON.stringify(value)) > 98304)
            fail('HISTORY_LIMIT');
        const bytes = Buffer.from(JSON.stringify({ ...value, report: JSON.parse(redactedJson(report)) }));
        if (bytes.length > 98304)
            fail('HISTORY_LIMIT');
        ancestors(path.dirname(this.#root));
        if (!stat(this.#root, true)) {
            try {
                fs.mkdirSync(this.#root, { mode: 0o700 });
            }
            catch (e) {
                if ((e as NodeJS.ErrnoException).code !== 'EEXIST')
                    throw e;
            }
        }
        const root = stat(this.#root, true)!;
        const file = path.join(this.#root, name), lock = file + '.lock';
        let lockfd: number;
        try {
            lockfd = fs.openSync(lock, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        }
        catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'EEXIST')
                fail('HISTORY_BUSY');
            throw e;
        }
        const held = fs.fstatSync(lockfd), tmp = file + '.' + randomUUID() + '.tmp';
        let renamed = false;
        try {
            const previous = stat(file, false);
            if (previous)
                this.replay(c, s);
            const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
            try {
                fs.writeFileSync(fd, bytes);
                fs.fsyncSync(fd);
            }
            finally {
                fs.closeSync(fd);
            }
            const current = stat(file, false), directory = stat(this.#root, true), owned = stat(lock, false);
            if (!directory || directory.ino !== root.ino || directory.dev !== root.dev || !owned || owned.ino !== held.ino || owned.dev !== held.dev || !!previous !== !!current || previous && current && (previous.ino !== current.ino || previous.dev !== current.dev || previous.mtimeMs !== current.mtimeMs || previous.ctimeMs !== current.ctimeMs))
                fail('HISTORY_STATE_CHANGED');
            fs.renameSync(tmp, file);
            renamed = true;
            const dir = fs.openSync(this.#root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
            try {
                fs.fsyncSync(dir);
            }
            finally {
                fs.closeSync(dir);
            }
        }
        catch (e) {
            if (renamed)
                fail('HISTORY_COMMIT_UNCERTAIN');
            throw e;
        }
        finally {
            fs.closeSync(lockfd);
            try {
                fs.unlinkSync(tmp);
            }
            catch (e) {
                if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
                    throw e;
            }
            const current = stat(lock, false);
            if (current && current.ino === held.ino && current.dev === held.dev)
                fs.unlinkSync(lock);
        }
        return { status: 'saved', scope: 'historical_only', target: t };
    }
    replay(c: ConversationKey, input: unknown) { const s = selector(input), bytes = read(this.#root, this.#name(c, s)); if (!bytes)
        fail('REPORT_UNAVAILABLE'); const value = json(bytes); if (value.version !== 1 || value.context !== contextKey(c) || JSON.stringify(value.selector) !== JSON.stringify(s) || !object(value.target) || value.target.project !== s.project || value.target.peer !== s.peer || !object(value.report) || typeof value.observedAt !== 'string')
        fail('LEGACY_STATE_INVALID'); return { scope: 'historical_only', remote: 'not_checked', completion: 'not_established', observedAt: value.observedAt, target: value.target, report: value.report }; }
}
