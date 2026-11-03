// S6a: durable attempt reservations, not authority, delivery guarantees or an archive.
import * as fs from 'node:fs';
import { resolve, join, isAbsolute, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { ConversationKey, TargetEpoch } from './fleet-codex-allowlist.ts';
export class InstructionStoreError extends Error {
    readonly code: string;
    constructor(code: string) { super(code); this.code = code; this.name = 'InstructionStoreError'; }
}
function fail(code: string): never { throw new InstructionStoreError(code); }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, names: string[]) => Object.keys(v).length === names.length && names.every(k => Object.hasOwn(v, k));
const text = (v: unknown, max = 1024): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f]/.test(v);
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(v);
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const date = (v: unknown): v is string => typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v));
const number = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
export const targetKey = (t: TargetEpoch) => JSON.stringify([t.project, t.peer, t.sessionId, t.startedAt]);
export function validInstructionTarget(v: unknown): v is TargetEpoch { return object(v) && keys(v, ['project', 'peer', 'sessionId', 'startedAt']) && text(v.project, 128) && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(v.project) && !v.project.includes('..') && typeof v.peer === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(v.peer) && typeof v.sessionId === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(v.sessionId) && date(v.startedAt); }
export function validInstruction(v: unknown): v is string { return typeof v === 'string' && v.trim().length > 0 && Buffer.byteLength(v) <= 16384 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v); }
export const intentDigest = (target: TargetEpoch, instruction: string) => createHash('sha256').update(JSON.stringify(['instruction', targetKey(target), instruction])).digest('hex');
export type ReceiptState = 'unknown' | 'not_sent' | 'submitted' | 'queued' | 'result' | 'failed';
export type Receipt = {
    operation: 'instruction';
    requestId: string;
    target: TargetEpoch;
    digest: string;
    wireId: string;
    state: ReceiptState;
    attempted: boolean;
    createdAt: string;
    updatedAt: string;
    detail: string | null;
    result: string | null;
    truncated: boolean;
};
export type Outcome = Pick<Receipt, 'state' | 'detail' | 'result' | 'truncated'>;
export type Intent = Pick<Receipt, 'requestId' | 'target' | 'digest'>;
export type Authorization = { alias: string; policyRevision: number };
export const questionReasons = ['RESERVED_BEFORE_DELIVERY','ATTEMPT_RESERVED_BEFORE_SOCKET_WRITE','CANCELLED_BEFORE_ATTEMPT','AUTHORIZATION_CHANGED','QUESTION_CHANGED','QUESTION_NOT_PENDING','QUESTION_EXPIRED','QUESTION_REJECTED','RECEIVER_NOT_READY','RECEIVER_WINDOW_FULL','TRANSPORT_UNCERTAIN','OUTCOME_UNAVAILABLE'] as const;
export type QuestionReceipt = {
    operation: 'answer' | 'refusal'; requestId: string; target: TargetEpoch;
    questionId: string; toolCallId: string; questionDigest: string; digest: string; wireId: string;
    state: 'unknown' | 'not_sent' | 'accepted' | 'late' | 'expired' | 'rejected';
    attempted: boolean; createdAt: string; updatedAt: string;
    detail: typeof questionReasons[number] | null;
    result: null | { outcome: 'answered' | 'declined' | 'late' | 'expired' | 'rejected'; decisionAt: string; observedAt: string; source: 'pi_question_rpc_v2' };
};
export type QuestionIntent = Pick<QuestionReceipt,'operation'|'requestId'|'target'|'questionId'|'toolCallId'|'questionDigest'|'digest'>;
export type QuestionOutcome = Pick<QuestionReceipt,'state'|'detail'|'result'>;
export type ActionReceipt = Receipt | QuestionReceipt;
type Upgrade = { fromVersion: 1; fromRevision: number; sourceSha256: string; backupName: string; migratedAt: string };
type ActionRecord = { receipt: ActionReceipt; authorization: Authorization | null };
type State = { format: 'fleet-instruction-intents'; version: 1 | 2; storeId: string; namespace: ConversationKey; revision: number; upgrade: Upgrade | null; records: ActionRecord[] };
export type UpgradePreview = { storeId: string; revision: number; sourceSha256: string; recordCount: number };
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const authorizationValid = (v: unknown): v is Authorization => object(v) && keys(v,['alias','policyRevision']) && text(v.alias) && v.alias.trim()===v.alias && !/[\u007f*]/u.test(v.alias) && number(v.policyRevision);
function validQuestionReceipt(v: unknown): v is QuestionReceipt {
    if (!object(v) || !keys(v,['operation','requestId','target','questionId','toolCallId','questionDigest','digest','wireId','state','attempted','createdAt','updatedAt','detail','result']) || !['answer','refusal'].includes(v.operation as string) || !id(v.requestId) || !validInstructionTarget(v.target) || !id(v.questionId) || !text(v.toolCallId,256) || !hash(v.questionDigest) || !hash(v.digest) || !hash(v.wireId) || typeof v.attempted!=='boolean' || !date(v.createdAt) || !date(v.updatedAt) || v.detail!==null && !questionReasons.includes(v.detail as typeof questionReasons[number])) return false;
    if (v.state==='unknown' || v.state==='not_sent') return v.result===null && (v.state!=='not_sent' || v.attempted===false);
    const r=v.result;
    return ['accepted','late','expired','rejected'].includes(v.state as string) && v.attempted===true && object(r) && keys(r,['outcome','decisionAt','observedAt','source']) && r.source==='pi_question_rpc_v2' && date(r.decisionAt) && date(r.observedAt) && r.outcome===(v.state==='accepted'?(v.operation==='answer'?'answered':'declined'):v.state) && Buffer.byteLength(JSON.stringify(v))<=4096;
}
const validActionReceipt = (v: unknown): v is ActionReceipt => validReceipt(v) || validQuestionReceipt(v);
const states = ['unknown', 'not_sent', 'submitted', 'queued', 'result', 'failed'];
function contextKey(c: ConversationKey) { if (!object(c) || !keys(c, ['hostProfile', 'principal', 'threadId']) || ![c.hostProfile, c.principal, c.threadId].every(x => text(x)))
    fail('INTENT_IDENTITY_INVALID'); return JSON.stringify([c.hostProfile, c.principal, c.threadId]); }
/** Host-context derived backup identity shared by preview and the locked write. */
export function journalUpgradeBackupName(c: ConversationKey, sourceSha256: string): string {
    if (!hash(sourceSha256)) fail('INTENT_INVALID');
    return sha(contextKey(c)) + '.v1.' + sourceSha256 + '.snapshot';
}
function validOutcome(v: unknown): v is Outcome { return object(v) && keys(v, ['state', 'detail', 'result', 'truncated']) && states.includes(v.state as string) && (v.detail === null || text(v.detail, 256)) && (v.result === null || typeof v.result === 'string' && Buffer.byteLength(v.result) <= 4096) && typeof v.truncated === 'boolean'; }
function validReceipt(v: unknown): v is Receipt { return object(v) && keys(v, ['operation', 'requestId', 'target', 'digest', 'wireId', 'state', 'attempted', 'createdAt', 'updatedAt', 'detail', 'result', 'truncated']) && v.operation === 'instruction' && id(v.requestId) && validInstructionTarget(v.target) && hash(v.digest) && hash(v.wireId) && typeof v.attempted === 'boolean' && date(v.createdAt) && date(v.updatedAt) && validOutcome({ state: v.state, detail: v.detail, result: v.result, truncated: v.truncated }) && (!['submitted', 'queued', 'result', 'failed'].includes(v.state as string) || v.attempted === true); }
export class InstructionLedger {
    readonly #root: string;
    readonly #now: () => number;
    readonly #checkpoint?: (stage: string) => void;
    readonly #known = new Map<string, number>();
    constructor(root: string, options: {
        now?: () => number;
        checkpoint?: (stage: string) => void;
    } = {}) { if (!isAbsolute(root) || resolve(root) !== root)
        fail('INTENT_UNSAFE_PATH'); this.#root = root; this.#now = options.now ?? Date.now; this.#checkpoint = options.checkpoint; }
    #path(c: ConversationKey) { return join(this.#root, createHash('sha256').update(contextKey(c)).digest('hex') + '.json'); }
    #safe(path: string, dir = false): fs.Stats | null { for (let parent = dirname(path);; parent = dirname(parent)) {
        try {
            const p = fs.lstatSync(parent);
            if (p.isSymbolicLink() || !p.isDirectory())
                fail('INTENT_UNSAFE_PATH');
        }
        catch (e) {
            if (e instanceof InstructionStoreError)
                throw e;
            if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
                fail('INTENT_IO_ERROR');
        }
        if (parent === dirname(parent))
            break;
    } let s: fs.Stats; try {
        s = fs.lstatSync(path);
    }
    catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT')
            return null;
        fail('INTENT_IO_ERROR');
    } if (s.isSymbolicLink() || !(dir ? s.isDirectory() : s.isFile()) || process.getuid && s.uid !== process.getuid() || (s.mode & 0o077) !== 0 || !dir && s.nlink !== 1)
        fail('INTENT_UNSAFE_PATH'); return s; }
    #marker(path: string): string | null {
        const st = this.#safe(path + '.marker');
        if (!st)
            return null;
        if (st.size > 48)
            fail('INTENT_STATE_INVALID');
        let fd: number | undefined;
        try {
            fd = fs.openSync(path + '.marker', fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
            const opened = fs.fstatSync(fd);
            if (opened.dev !== st.dev || opened.ino !== st.ino)
                fail('INTENT_STATE_CHANGED');
            const value = fs.readFileSync(fd, 'utf8');
            if (!value.startsWith('v1:'))
                fail('INTENT_STATE_VERSION');
            if (!/^v1:[a-f0-9-]{36}$/.test(value))
                fail('INTENT_STATE_INVALID');
            return value.slice(3);
        }
        catch (e) {
            if (e instanceof InstructionStoreError)
                throw e;
            return fail('INTENT_IO_ERROR');
        }
        finally {
            if (fd !== undefined)
                fs.closeSync(fd);
        }
    }
    #load(c: ConversationKey, source?: { bytes?: Buffer }): State | null {
        const path = this.#path(c), root = this.#safe(this.#root, true), st = root ? this.#safe(path) : null, marker = root ? this.#marker(path) : null;
        if (!st) {
            if (marker || this.#known.has(path))
                fail('INTENT_STATE_MISSING');
            return null;
        }
        if (!marker)
            fail('INTENT_STATE_INVALID');
        if (st.size > 8388608)
            fail('INTENT_LIMIT');
        let value: unknown, fd: number | undefined;
        try {
            fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
            const opened = fs.fstatSync(fd);
            if (opened.dev !== st.dev || opened.ino !== st.ino)
                fail('INTENT_STATE_CHANGED');
            const bytes = fs.readFileSync(fd), after = fs.fstatSync(fd);
            if (bytes.length > 8388608)
                fail('INTENT_LIMIT');
            const rootAfter = this.#safe(this.#root, true), pathAfter = this.#safe(path);
            if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || rootAfter?.dev !== root!.dev || rootAfter?.ino !== root!.ino || pathAfter?.dev !== opened.dev || pathAfter?.ino !== opened.ino)
                fail('INTENT_STATE_CHANGED');
            try {
                const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
                value = JSON.parse(decoded);
                if (source) source.bytes = bytes;
                if (object(value) && value.version===2 && JSON.stringify(value)!==decoded) fail('INTENT_STATE_INVALID');
            }
            catch {
                fail('INTENT_STATE_INVALID');
            }
        }
        catch (e) {
            if (e instanceof InstructionStoreError)
                throw e;
            fail('INTENT_IO_ERROR');
        }
        finally {
            if (fd !== undefined)
                fs.closeSync(fd);
        }
        if (!object(value))
            fail('INTENT_STATE_INVALID');
        if (value.version !== 1 && value.version !== 2) fail('INTENT_STATE_VERSION');
        if (!keys(value, value.version===1?['format','version','storeId','namespace','revision','records']:['format','version','storeId','namespace','revision','upgrade','records']) || value.format !== 'fleet-instruction-intents' || !number(value.revision) || !object(value.namespace) || !keys(value.namespace, ['hostProfile', 'principal', 'threadId']) || !['hostProfile', 'principal', 'threadId'].every(k => text((value.namespace as Record<string, unknown>)[k])) || !Array.isArray(value.records) || value.records.length > 256) fail('INTENT_STATE_INVALID');
        if (value.version===1) {
            if (!value.records.every(validReceipt)) fail('INTENT_STATE_INVALID');
            value.records=value.records.map(receipt=>({receipt,authorization:null})); value.upgrade=null;
        } else {
            if (!value.records.every(v=>object(v)&&keys(v,['receipt','authorization'])&&validActionReceipt(v.receipt)&&(v.authorization===null?object(v.receipt)&&v.receipt.operation==='instruction':authorizationValid(v.authorization)))) fail('INTENT_STATE_INVALID');
            const u=value.upgrade;
            if (u!==null && (!object(u)||!keys(u,['fromVersion','fromRevision','sourceSha256','backupName','migratedAt'])||u.fromVersion!==1||!number(u.fromRevision)||u.fromRevision>=(value.revision as number)||!hash(u.sourceSha256)||u.backupName!==sha(contextKey(c))+'.v1.'+u.sourceSha256+'.snapshot'||!date(u.migratedAt))) fail('INTENT_STATE_INVALID');
        }
        if (contextKey(value.namespace as unknown as ConversationKey) !== contextKey(c))
            fail('INTENT_NAMESPACE_MISMATCH');
        const s = value as unknown as State;
        if (s.storeId !== marker)
            fail('INTENT_STATE_CHANGED');
        if (new Set(s.records.map(v => v.receipt.requestId)).size !== s.records.length || s.records.some(({receipt:r}) => r.wireId !== createHash('sha256').update(JSON.stringify([contextKey(c), r.requestId])).digest('hex')))
            fail('INTENT_STATE_INVALID');
        if (s.revision < (this.#known.get(path) ?? 0))
            fail('INTENT_STATE_CHANGED');
        this.#known.set(path, s.revision);
        return s;
    }
    #mutate<T>(c: ConversationKey, fn: (s: State, source: {bytes?:Buffer}) => {
        value: T; write: boolean; backup?: {name:string;bytes:Buffer};
    }, upgrade = false): T {
        const path = this.#path(c);
        if (!this.#safe(this.#root, true)) {
            try {
                fs.mkdirSync(this.#root, { recursive: true, mode: 0o700 });
                const parent = fs.openSync(dirname(this.#root), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
                try {
                    fs.fsyncSync(parent);
                }
                finally {
                    fs.closeSync(parent);
                }
            }
            catch {
                fail('INTENT_IO_ERROR');
            }
        }
        const root = this.#safe(this.#root, true)!, lock = path + '.lock';
        let fd: number;
        try {
            fd = fs.openSync(lock, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        }
        catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'EEXIST')
                fail('INTENT_BUSY');
            fail('INTENT_IO_ERROR');
        }
        const owned = fs.fstatSync(fd), tmp = path + '.' + randomUUID() + '.tmp';
        try {
            const source: {bytes?:Buffer} = {};
            let s = this.#load(c, source);
            const originalVersion = s?.version;
            if (!s) {
                const storeId = randomUUID();
                let markerFd: number | undefined;
                try {
                    markerFd = fs.openSync(path + '.marker', fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
                    fs.writeFileSync(markerFd, 'v1:' + storeId);
                    fs.fsyncSync(markerFd);
                    const dir = fs.openSync(this.#root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
                    try {
                        fs.fsyncSync(dir);
                    }
                    finally {
                        fs.closeSync(dir);
                    }
                }
                catch {
                    fail('INTENT_COMMIT_UNCERTAIN');
                }
                finally {
                    if (markerFd !== undefined)
                        fs.closeSync(markerFd);
                }
                s = { format: 'fleet-instruction-intents', version: 2, storeId, namespace: { ...c }, revision: 0, upgrade: null, records: [] };
            }
            const out = fn(s, source);
            if (!out.write) return structuredClone(out.value);
            if (originalVersion===1 && !upgrade) fail('INTENT_FORMAT_UPGRADE_REQUIRED');
            if (s.revision >= Number.MAX_SAFE_INTEGER)
                fail('INTENT_LIMIT');
            s.revision++;
            const bytes = JSON.stringify(s);
            if (Buffer.byteLength(bytes) > 8388608)
                fail('INTENT_LIMIT');
            const current = this.#safe(this.#root, true);
            if (!current || current.dev !== root.dev || current.ino !== root.ino)
                fail('INTENT_UNSAFE_PATH');
            if (out.backup) {
                const backup=join(this.#root,out.backup.name), existing=this.#safe(backup);
                if (existing) {
                    const file=fs.openSync(backup,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
                    try {const st=fs.fstatSync(file);if(st.dev!==existing.dev||st.ino!==existing.ino||st.size>8388608||!fs.readFileSync(file).equals(out.backup.bytes))fail('INTENT_STATE_CHANGED');}finally{fs.closeSync(file);}
                } else {
                    const file=fs.openSync(backup,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
                    try {fs.writeFileSync(file,out.backup.bytes);fs.fsyncSync(file);}finally{fs.closeSync(file);}
                }
                const dir=fs.openSync(this.#root,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
            }
            let renamed = false;
            try {
                const file = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
                try {
                    fs.writeFileSync(file, bytes);
                    fs.fsyncSync(file);
                }
                finally {
                    fs.closeSync(file);
                }
                this.#checkpoint?.('beforeRename');
                const again=this.#safe(this.#root,true);
                if (!again || again.dev!==root.dev || again.ino!==root.ino || this.#marker(path)!==s.storeId) fail('INTENT_STATE_CHANGED');
                if (source.bytes) {const check:{bytes?:Buffer}={};this.#load(c,check);if(!check.bytes?.equals(source.bytes))fail('INTENT_STATE_CHANGED');}
                else if(this.#safe(path)) fail('INTENT_STATE_CHANGED');
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
            catch (e) {
                if (!renamed && e instanceof InstructionStoreError) throw e;
                fail(renamed ? 'INTENT_COMMIT_UNCERTAIN' : 'INTENT_IO_ERROR');
            }
            try {const readback=this.#load(c);if(!readback||JSON.stringify(readback)!==bytes)fail('INTENT_COMMIT_UNCERTAIN');}
            catch {fail('INTENT_COMMIT_UNCERTAIN');}
            this.#known.set(path, s.revision);
            return structuredClone(out.value);
        }
        finally {
            try {
                fs.rmSync(tmp, { force: true });
            }
            finally {
                fs.closeSync(fd);
                const own = this.#safe(lock);
                if (own?.dev === owned.dev && own.ino === owned.ino)
                    fs.unlinkSync(lock);
            }
        }
    }
    #time() { const now = this.#now(); if (!Number.isFinite(now) || now < 0)
        fail('INTENT_CLOCK_INVALID'); return new Date(now).toISOString(); }
    lookupAction(c: ConversationKey, requestId: string): ActionReceipt | null {
        contextKey(c); if (!id(requestId)) fail('INTENT_INVALID');
        return structuredClone(this.#load(c)?.records.find(v=>v.receipt.requestId===requestId)?.receipt??null);
    }
    lookup(c: ConversationKey, requestId: string): Receipt | null {
        const r=this.lookupAction(c,requestId); if(r&&r.operation!=='instruction')fail('INTENT_CONFLICT'); return r as Receipt|null;
    }
    assertWritable(c: ConversationKey): void {if(this.#load(c)?.version===1)fail('INTENT_FORMAT_UPGRADE_REQUIRED');}
    /** Validated metadata only, including read-only reconciliation after an uncertain upgrade. */
    inspectJournal(c: ConversationKey) {
        const s=this.#load(c); if(!s)fail('INTENT_STATE_CHANGED');
        return {version:s.version,storeId:s.storeId,revision:s.revision,recordCount:s.records.length,upgrade:structuredClone(s.upgrade)};
    }
    previewUpgrade(c: ConversationKey): UpgradePreview {
        const source:{bytes?:Buffer}={},s=this.#load(c,source);
        if(!s||s.version!==1||!source.bytes)fail('INTENT_STATE_CHANGED');
        return {storeId:s.storeId,revision:s.revision,sourceSha256:sha(source.bytes),recordCount:s.records.length};
    }
    /** Locked CAS primitive; native preview/commit supplies the exact expected snapshot. No automatic migration. */
    upgradeV1(c: ConversationKey, expected: UpgradePreview): void {
        if(!this.#load(c))fail('INTENT_STATE_CHANGED');
        this.#mutate(c,(s,source)=>{
            if(!object(expected)||!keys(expected,['storeId','revision','sourceSha256','recordCount'])||s.version!==1||!source.bytes||s.storeId!==expected.storeId||s.revision!==expected.revision||sha(source.bytes)!==expected.sourceSha256||s.records.length!==expected.recordCount)fail('INTENT_STATE_CHANGED');
            const name=journalUpgradeBackupName(c,sha(source.bytes));
            s.upgrade={fromVersion:1,fromRevision:s.revision,sourceSha256:sha(source.bytes),backupName:name,migratedAt:this.#time()};s.version=2;
            return {value:undefined,write:true,backup:{name,bytes:source.bytes}};
        },true);
    }
    reserveAction(c: ConversationKey, intent: QuestionIntent | (Intent & {operation:'instruction'}), authorization: Authorization|null) {
        contextKey(c);
        if(!object(intent)||!id(intent.requestId)||!validInstructionTarget(intent.target)||!hash(intent.digest)||intent.operation!=='instruction'&&authorization===null||authorization!==null&&!authorizationValid(authorization))fail('INTENT_INVALID');
        const now=this.#time(), common={...structuredClone(intent),wireId:sha(JSON.stringify([contextKey(c),intent.requestId])),state:'unknown' as const,attempted:false,createdAt:now,updatedAt:now,result:null};
        const receipt:ActionReceipt=intent.operation==='instruction'?{...common,operation:'instruction',detail:'reserved_before_delivery',truncated:false} as Receipt:{...common,detail:'RESERVED_BEFORE_DELIVERY'} as QuestionReceipt;
        if(!validActionReceipt(receipt))fail('INTENT_INVALID');
        return this.#mutate(c,s=>{
            const old=s.records.find(v=>v.receipt.requestId===intent.requestId)?.receipt;
            if(old){
                if(old.operation!==intent.operation||old.digest!==intent.digest||targetKey(old.target)!==targetKey(intent.target)||old.operation!=='instruction'&&(intent.operation==='instruction'||old.questionId!==intent.questionId||old.toolCallId!==intent.toolCallId||old.questionDigest!==intent.questionDigest))fail('INTENT_CONFLICT');
                return {value:{created:false,receipt:old},write:false};
            }
            if(s.records.length>=256)fail('INTENT_LIMIT');
            s.records.push({receipt,authorization:structuredClone(authorization)});
            return {value:{created:true,receipt},write:true};
        });
    }
    reserve(c: ConversationKey, intent: Intent, authorization: Authorization|null = null) {
        if(!object(intent)||!keys(intent,['requestId','target','digest']))fail('INTENT_INVALID');
        const out=this.reserveAction(c,{operation:'instruction',...intent},authorization);
        return {created:out.created,receipt:out.receipt as Receipt};
    }
    markActionAttempt(c: ConversationKey, requestId: string): ActionReceipt {
        if(!this.lookupAction(c,requestId))fail('INTENT_UNAVAILABLE');
        return this.#mutate(c,s=>{
            const r=s.records.find(v=>v.receipt.requestId===requestId)?.receipt;if(!r)fail('INTENT_UNAVAILABLE');
            if(r.attempted||r.state!=='unknown')fail('INTENT_ALREADY_ATTEMPTED');
            r.attempted=true;r.updatedAt=this.#time();r.detail=r.operation==='instruction'?'attempt_reserved_before_socket_write':'ATTEMPT_RESERVED_BEFORE_SOCKET_WRITE';
            return {value:r,write:true};
        });
    }
    markAttempt(c: ConversationKey, requestId: string): Receipt {
        this.lookup(c,requestId);return this.markActionAttempt(c,requestId) as Receipt;
    }
    recordAction(c: ConversationKey, requestId: string, outcome: QuestionOutcome): QuestionReceipt {
        const old=this.lookupAction(c,requestId);if(!old)fail('INTENT_UNAVAILABLE');if(old.operation==='instruction')fail('INTENT_CONFLICT');
        return this.#mutate(c,s=>{
            const r=s.records.find(v=>v.receipt.requestId===requestId)?.receipt;if(!r||r.operation==='instruction')fail('INTENT_CONFLICT');
            if(!object(outcome)||!keys(outcome,['state','detail','result']))fail('INTENT_INVALID');
            if(!['unknown','not_sent'].includes(r.state))return {value:r,write:false};
            if(r.state==='not_sent')return {value:r,write:false};
            const next={...r,...structuredClone(outcome),updatedAt:this.#time()};
            if(r.attempted&&next.state==='not_sent')next.state='unknown';
            if(!validQuestionReceipt(next))fail('INTENT_INVALID');Object.assign(r,next);return {value:r,write:true};
        });
    }
    record(c: ConversationKey, requestId: string, outcome: Outcome): Receipt {
        if(!id(requestId)||!validOutcome(outcome))fail('INTENT_INVALID');
        if(!this.lookup(c,requestId))fail('INTENT_UNAVAILABLE');
        return this.#mutate(c,s=>{
            const r=s.records.find(v=>v.receipt.requestId===requestId)?.receipt;
            if(!r)fail('INTENT_UNAVAILABLE');if(r.operation!=='instruction')fail('INTENT_CONFLICT');
            if(r.state==='not_sent'||r.state==='result'||r.state==='failed')return {value:r,write:false};
            if(['submitted','queued','result','failed'].includes(outcome.state)&&!r.attempted)fail('INTENT_INVALID');
            const next={...outcome};if(r.attempted&&next.state==='not_sent')next.state='unknown';
            if(['submitted','queued'].includes(r.state)&&next.state==='unknown')next.state=r.state;
            Object.assign(r,next,{updatedAt:this.#time()});return {value:r,write:true};
        });
    }
}
/** One shared namespace/file/lock for all operation families. */
export class ActionLedger extends InstructionLedger {}
