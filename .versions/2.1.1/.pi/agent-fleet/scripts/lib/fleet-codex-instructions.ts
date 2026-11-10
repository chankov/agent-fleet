// Native-context S6a intents. Historical receipts never grant fresh authority.
import { randomUUID } from 'node:crypto';
import { AllowedSessionsPolicy, type ConversationKey, type TargetEpoch } from './fleet-codex-allowlist.ts';
import { AllowedSessionsStore, type StoreHandle } from './fleet-codex-allowlist-store.ts';
import { ReadonlyFleetBridge, type RegistryReader } from './fleet-codex-readonly.ts';
import { InstructionLedger, intentDigest, targetKey, validInstruction, validInstructionTarget, type Receipt, type Outcome } from './fleet-codex-instruction-store.ts';
import type { InstructionTransport } from './fleet-codex-instruction-transport.ts';
export class InstructionError extends Error {
    readonly code: string;
    constructor(code: string) { super(code); this.code = code; }
}
function fail(code: string): never { throw new InstructionError(code); }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: unknown, required: string[], optional: string[] = []): v is Record<string, unknown> => object(v) && required.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => required.includes(k) || optional.includes(k));
const key = (c: ConversationKey) => JSON.stringify([c.hostProfile, c.principal, c.threadId]);
const requestId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(v);
export function parseInstruction(v: unknown) { if (!exact(v, ['requestId', 'target', 'instruction']) || !requestId(v.requestId) || !validInstructionTarget(v.target) || !validInstruction(v.instruction))
    fail('INVALID_ARGUMENTS'); return { requestId: v.requestId, target: structuredClone(v.target), instruction: v.instruction }; }
export function parseReceipt(v: unknown) { if (!exact(v, ['requestId'], ['refresh']) || !requestId(v.requestId) || Object.hasOwn(v, 'refresh') && typeof v.refresh !== 'boolean')
    fail('INVALID_ARGUMENTS'); return { requestId: v.requestId, refresh: v.refresh === true }; }
type Wire = Pick<InstructionTransport, 'capability' | 'send' | 'receipt'>;
type Access = {
    store: AllowedSessionsStore;
    handle: StoreHandle;
};
type Proposal = {
    context: string;
    expires: number;
    args: ReturnType<typeof parseInstruction>;
    access: Access;
    promise?: Promise<Record<string, unknown>>;
    outcome?: {
        result?: Record<string, unknown>;
        error?: unknown;
    };
};
export type InstructionBridgeOptions = {
    policyRoot: string;
    assertNewAction?: (context: ConversationKey, requestId: string) => void;
    registryReader: RegistryReader;
    transport: Wire;
    now?: () => number;
    monotonic?: () => number;
    pendingBudget?: (context: string) => {
        total: number;
        context: number;
    };
};
export class InstructionBridge {
    readonly #options: InstructionBridgeOptions;
    readonly #auth: ReadonlyFleetBridge;
    readonly #ledger: InstructionLedger;
    readonly #pending = new Map<string, Proposal>();
    constructor(options: InstructionBridgeOptions) { this.#options = options; this.#auth = new ReadonlyFleetBridge({ registryReader: options.registryReader, policyBaseDir: options.policyRoot, now: options.now }); this.#ledger = new InstructionLedger(options.policyRoot + '.instructions', { now: options.now }); }
    #context(c: ConversationKey) { new AllowedSessionsPolicy().list(c); if (!exact(c, ['hostProfile', 'principal', 'threadId']))
        fail('IDENTITY_REQUIRED'); }
    #time() { const n = (this.#options.monotonic ?? (() => performance.now()))(); if (!Number.isFinite(n) || n < 0)
        fail('CLOCK_INVALID'); return n; }
    #prune() { const n = this.#time(); for (const [id, p] of this.#pending)
        if (!p.promise && p.expires <= n)
            this.#pending.delete(id); }
    pendingCount(context?: string) { this.#prune(); return context === undefined ? this.#pending.size : [...this.#pending.values()].filter(p => p.context === context).length; }
    #history(receipt: Receipt) { return { status: 'historical', source: 'local_intent_ledger', scope: 'historical_only', completion: 'not_established', receipt }; }
    async #selected(c: ConversationKey, target: TargetEpoch) { const s = await this.#auth.discoverCandidates(c, { project: target.project }); if (s.status !== 'complete' || s.partial)
        fail('REGISTRY_UNAVAILABLE'); const matches = s.candidates.filter(v => v.target.peer === target.peer); if (matches.length !== 1 || matches[0].presence !== 'fresh')
        fail('TARGET_UNAVAILABLE'); if (targetKey(matches[0].target) !== targetKey(target))
        fail('TARGET_CHANGED'); const counts = new Map<string, number>(); for (const v of s.candidates)
        counts.set(v.target.peer, (counts.get(v.target.peer) ?? 0) + 1); return s.candidates.filter(v => v.presence === 'fresh' && counts.get(v.target.peer) === 1).map(v => v.target); }
    async #read(c: ConversationKey, target: TargetEpoch) { const checked = await this.#auth.checkAllowedReadTarget(c, { project: target.project, peer: target.peer }); if (targetKey(checked.target) !== targetKey(target))
        fail('TARGET_CHANGED'); }
    async #sendAccess(c: ConversationKey, target: TargetEpoch, access?: Access): Promise<Access> { await this.#read(c, target); const current = await this.#selected(c, target); if (!access) {
        const store = new AllowedSessionsStore(this.#options.policyRoot, c, {now:this.#options.now}), state = await store.list(current), matches = state.bindings.filter(b => targetKey(b.target) === targetKey(target));
        if (matches.length !== 1)
            fail('NOT_ALLOWED');
        access = { store, handle: await store.resolve(matches[0].alias, current) };
    } if (targetKey(await access.store.authorize(access.handle, 'send', current)) !== targetKey(target))
        fail('TARGET_CHANGED'); return access; }
    async prepare(c: ConversationKey, input: unknown): Promise<Record<string, unknown>> {
        this.#context(c);
        const args = parseInstruction(input), digest = intentDigest(args.target, args.instruction), existing = this.#ledger.lookup(c, args.requestId);
        if (existing) {
            if (existing.digest !== digest || targetKey(existing.target) !== targetKey(args.target))
                fail('INTENT_CONFLICT');
            return this.#history(existing);
        }
        this.#options.assertNewAction?.(c,args.requestId);
        this.#ledger.assertWritable(c);
        const access = await this.#sendAccess(c, args.target);
        await this.#options.transport.capability(args.target);
        this.#prune();
        const budget = this.#options.pendingBudget?.(key(c)) ?? { total: 0, context: 0 };
        if (this.#pending.size + budget.total >= 64 || this.pendingCount(key(c)) + budget.context >= 16)
            fail('BUSY');
        const proposalId = randomUUID();
        this.#pending.set(proposalId, { context: key(c), expires: this.#time() + 300000, args, access });
        return { status: 'prepared', source: 'local_instruction_proposal', proposalId, expiresInSeconds: 300, requestId: args.requestId, target: args.target, instruction: args.instruction, digest, effect: 'one addressed prompt may trigger a Pi turn under receiver permissions; not steering or completion', expectedRevision: access.handle.revision, humanProvenance: 'unknown' };
    }
    async commit(c: ConversationKey, proposalId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
        this.#context(c);
        this.#prune();
        const p = this.#pending.get(proposalId);
        if (!p || p.context !== key(c) || p.expires <= this.#time())
            fail('PROPOSAL_UNAVAILABLE');
        if (p.outcome) {
            if (p.outcome.error)
                throw p.outcome.error;
            return structuredClone(p.outcome.result!);
        }
        if (p.promise)
            return p.promise;
        p.promise = (async () => {
            let reserved: Receipt | undefined;
            try {
                const { args } = p, digest = intentDigest(args.target, args.instruction), old = this.#ledger.lookup(c, args.requestId);
                if (old) {
                    if (old.digest !== digest || targetKey(old.target) !== targetKey(args.target))
                        fail('INTENT_CONFLICT');
                    return this.#history(old);
                }
                if (signal?.aborted)
                    fail('REQUEST_CANCELLED');
                this.#options.assertNewAction?.(c,args.requestId);
                await this.#sendAccess(c, args.target, p.access);
                if (signal?.aborted)
                    fail('REQUEST_CANCELLED');
                const reservation = this.#ledger.reserve(c, { requestId: args.requestId, target: args.target, digest }, {alias:p.access.handle.alias,policyRevision:p.access.handle.revision});
                if (!reservation.created)
                    return this.#history(reservation.receipt);
                reserved = reservation.receipt;
                let result = await this.#options.transport.send(args.target, reserved.wireId, args.instruction, { signal, beforeWrite: async () => { await this.#sendAccess(c, args.target, p.access); if (signal?.aborted)
                        fail('REQUEST_CANCELLED'); this.#options.assertNewAction?.(c,args.requestId); this.#ledger.markAttempt(c, args.requestId); } });
                try {
                    await this.#read(c, args.target);
                }
                catch {
                    result = { state: 'unknown', detail: 'AUTHORIZATION_CHANGED', result: null, truncated: false };
                }
                const receipt = this.#ledger.record(c, args.requestId, result);
                return { ...this.#history(receipt), status: 'recorded', source: 'local_intent_receipt' };
            }
            catch (e) {
                if (reserved) {
                    try {
                        this.#ledger.record(c, reserved.requestId, { state: 'not_sent', detail: 'DELIVERY_REFUSED_OR_UNCERTAIN', result: null, truncated: false });
                    }
                    catch { /* Original uncertain state remains; never retry. */ }
                }
                throw e;
            }
        })();
        try {
            const result = await p.promise;
            p.outcome = { result };
            return structuredClone(result);
        }
        catch (error) {
            p.outcome = { error };
            throw error;
        }
        finally {
            p.promise = undefined;
        }
    }
    async receipt(c: ConversationKey, input: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> { this.#context(c); const q = parseReceipt(input); let local = this.#ledger.lookup(c, q.requestId); if (!local)
        fail('INTENT_UNAVAILABLE'); if (!q.refresh)
        return this.#history(local); this.#ledger.assertWritable(c); if (signal?.aborted)
        fail('REQUEST_CANCELLED'); await this.#read(c, local.target); if (!local.attempted)
        return this.#history(local); const remote = await this.#options.transport.receipt(local.target, local.wireId, signal); await this.#read(c, local.target); if (signal?.aborted)
        fail('REQUEST_CANCELLED'); if (remote) {
        const result: Outcome = { state: remote.state, detail: null, result: remote.text, truncated: remote.truncated };
        local = this.#ledger.record(c, q.requestId, result);
    } return { ...this.#history(local), refresh: remote ? 'terminal_observed' : 'unknown' }; }
}
