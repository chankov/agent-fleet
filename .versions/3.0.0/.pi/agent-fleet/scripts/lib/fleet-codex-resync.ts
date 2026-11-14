// S5c: bounded local observations, never source-side writes or human delivery proof.
import { setTimeout as delay } from 'node:timers/promises';
import type { ConversationKey, TargetEpoch } from './fleet-codex-allowlist.ts';
import { ObservationBridge, type ReadAuthorization } from './fleet-codex-observe.ts';
import { ObservationStore, ObservationStoreError, epochKey, type Cursor } from './fleet-codex-observation-store.ts';
import { parseOverviewTargets } from './fleet-codex-overview.ts';
import { ReadonlyFleetError } from './fleet-codex-readonly.ts';
type Selector = {
    project: string;
    peer: string;
};
type Snapshot = Awaited<ReturnType<ObservationBridge['observe']>>;
const check = (signal?: AbortSignal) => { if (signal?.aborted)
    throw new ReadonlyFleetError('REQUEST_CANCELLED'); };
const same = (a: TargetEpoch, b: TargetEpoch) => epochKey(a) === epochKey(b);
const safeCode = (e: unknown) => e instanceof ReadonlyFleetError || e instanceof ObservationStoreError ? e.code
    : e instanceof Error && (e as Error & {
        code?: string;
    }).code === 'NOT_ALLOWED' ? 'NOT_ALLOWED' : 'IO_ERROR';
function summary(selector: Selector, s: Snapshot, previous: Cursor | null, reset: string | null) {
    const t = s.transcript, q = s.questionState, w = t.window;
    let status = 'unavailable', reason: string | null = 'SOURCE_UNAVAILABLE', gap = t.partial, advance = false, events = t.entries;
    if (t.status === 'available') {
        if (!w || t.entries.some(e => !e.id)) {
            status = 'unsupported';
            reason = 'CURSOR_METADATA_UNSUPPORTED';
            gap = true;
        }
        else {
            advance = true;
            reason = null;
            if (!previous || previous.leaf === null) {
                status = 'initial';
            }
            else if (w.leaf === previous.leaf && previous.lastEvent === (t.entries.at(-1)?.id ?? null)) {
                status = 'unchanged';
                events = [];
            }
            else if (!w.ancestry.includes(previous.leaf)) {
                status = 'gap';
                reason = 'ANCHOR_UNREACHABLE';
                gap = true;
            }
            else if (previous.lastEvent === null) {
                status = 'advanced';
            }
            else {
                const index = t.entries.findIndex(e => e.id === previous.lastEvent);
                if (index < 0) {
                    status = 'gap';
                    reason = 'EVENT_WINDOW_GAP';
                    gap = true;
                }
                else {
                    status = 'advanced';
                    events = t.entries.slice(index + 1);
                }
            }
        }
    }
    else {
        events = [];
        gap = true;
    }
    if (events.length > 12 || events.some(e => e.text.length > 256)) {
        gap = true;
        reason = 'OUTPUT_LIMIT';
    }
    const seen = previous?.questions ?? [], pending = q.questions.map(v => v.id), resolved = q.resolved.map(v => v.id);
    const newlySeen = pending.filter(id => !seen.includes(id)), allSeen = q.status === 'available' ? [...new Set([...seen, ...pending, ...resolved])] : seen;
    const questionGap = q.partial || q.status !== 'available' || allSeen.length > 256 || newlySeen.length > 8 || q.questions.length > 4 || q.resolved.length > 8;
    const result = { selector: { ...selector }, status: 'observed' as const, target: s.target, permission: s.permission, observedAt: s.observedAt,
        nonAtomic: true, observationOnly: true, reset, partial: s.partial || gap || questionGap, gap,
        cursor: { revision: previous?.revision ?? null, status, reason, committed: false },
        transcript: { status: t.status, partial: t.partial, reasons: t.reasons },
        events: events.slice(-12).map(e => ({ ...e, text: e.text.slice(0, 256) })),
        questions: { status: q.status, partial: q.partial, reasons: q.reasons, pendingCount: q.pendingCount,
            pending: q.questions.slice(0, 4).map(v => ({ id: v.id, toolCallId: v.toolCallId, preview: v.question.slice(0, 256), detailsRequired: true })),
            resolved: q.resolved.slice(0, 8).map(v => ({ ...v })),
            newQuestionIds: newlySeen.slice(0, 8), gap: questionGap, delivery: 'not_established' },
        permissions:s.permissionState,
        completion: 'not_established' as const };
    const data = { leaf: advance ? w!.leaf : previous?.leaf ?? null, lastEvent: advance ? t.entries.at(-1)?.id ?? null : previous?.lastEvent ?? null,
        questions: allSeen.slice(-256), observedAt: s.observedAt };
    return { result, data, save: advance || q.status === 'available' };
}
type TargetResult = ReturnType<typeof summary>['result'] | {
    selector: Selector;
    status: 'error';
    code: string;
    dataReleased: false;
};
export class ResyncBridge {
    readonly #observer: Pick<ObservationBridge, 'observe'>;
    readonly #authorization: ReadAuthorization;
    readonly #store: ObservationStore;
    readonly #clock: () => number;
    readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
    constructor(options: {
        observer: Pick<ObservationBridge, 'observe'>;
        authorization: ReadAuthorization;
        store: ObservationStore;
        clock?: () => number;
        sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    }) {
        this.#observer = options.observer;
        this.#authorization = options.authorization;
        this.#store = options.store;
        this.#clock = options.clock ?? (() => performance.now());
        this.#sleep = options.sleep ?? (async (ms, signal) => { await delay(ms, undefined, { signal }); });
    }
    async #one(context: ConversationKey, selector: Selector, signal?: AbortSignal): Promise<TargetResult> {
        try {
            check(signal);
            const before = await this.#authorization.checkAllowedReadTarget(context, selector);
            check(signal);
            const old = this.#store.read(context, before.target), s = await this.#observer.observe(context, selector);
            check(signal);
            if (!same(s.target, before.target))
                throw new ReadonlyFleetError('TARGET_CHANGED');
            const built = summary(selector, s, old.cursor, old.reset);
            // A bounded target result is checked BEFORE committing any observation progress.
            if (Buffer.byteLength(JSON.stringify(built.result)) + 32 > 16384)
                throw new ReadonlyFleetError('SUMMARY_LIMIT');
            const guard = async () => { check(signal); const current = await this.#authorization.checkAllowedReadTarget(context, selector); if (!same(current.target, before.target))
                throw new ReadonlyFleetError('TARGET_CHANGED'); check(signal); };
            if (built.save) {
                const saved = await this.#store.save(context, s.target, old.cursor?.revision ?? null, built.data, guard);
                built.result.cursor.revision = saved.revision;
                built.result.cursor.committed = true;
            }
            await guard();
            check(signal);
            return built.result;
        }
        catch (e) {
            check(signal);
            return { selector: { ...selector }, status: 'error' as const, code: safeCode(e), dataReleased: false as const };
        }
    }
    async resync(context: ConversationKey, args: unknown, signal?: AbortSignal) {
        const targets = parseOverviewTargets(args);
        check(signal);
        const results: TargetResult[] = [];
        let next = 0;
        const worker = async () => { while (next < targets.length) {
            check(signal);
            const index = next++;
            results[index] = await this.#one(context, targets[index], signal);
        } };
        // Await every started read before returning a cancellation; never detach source work.
        const outcomes = await Promise.allSettled(Array.from({ length: Math.min(2, targets.length) }, worker));
        check(signal);
        const failed = outcomes.find(v => v.status === 'rejected');
        if (failed?.status === 'rejected')
            throw failed.reason;
        return { scope: 'durable_observation' as const, nonAtomic: true, observationOnly: true, completion: 'not_established' as const,
            partial: results.some(r => r.status === 'error' || r.partial), results };
    }
    async watch(context: ConversationKey, args: unknown, signal?: AbortSignal) {
        if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(k => !['targets', 'durationSeconds'].includes(k)) || !Object.hasOwn(args, 'targets') || !Object.hasOwn(args, 'durationSeconds'))
            throw new ReadonlyFleetError('INVALID_ARGUMENTS');
        const a = args as {
            targets: unknown;
            durationSeconds: unknown;
        };
        if (!Number.isInteger(a.durationSeconds) || (a.durationSeconds as number) < 1 || (a.durationSeconds as number) > 10)
            throw new ReadonlyFleetError('INVALID_ARGUMENTS');
        const parsed = parseOverviewTargets({ targets: a.targets });
        check(signal);
        const start = this.#clock();
        if (!Number.isFinite(start) || start < 0)
            throw new ReadonlyFleetError('CLOCK_INVALID');
        const deadline = start + (a.durationSeconds as number) * 1000, frames: Array<Awaited<ReturnType<ResyncBridge['resync']>>> = [];
        let reason = 'frame_limit', used = 0;
        for (let i = 0; i < 6; i++) {
            check(signal);
            if (97280 - used < 70000) {
                reason = 'output_budget';
                break;
            }
            const frame = await this.resync(context, { targets: parsed }, signal), bytes = Buffer.byteLength(JSON.stringify(frame));
            if (bytes > 70000)
                throw new ReadonlyFleetError('SUMMARY_LIMIT');
            frames.push(frame);
            used += bytes;
            if (frame.results.some(r => r.status === 'error' && r.code.startsWith('CURSOR_'))) {
                reason = 'cursor_error';
                break;
            }
            const remaining = deadline - this.#clock();
            if (remaining <= 0) {
                reason = 'duration';
                break;
            }
            try {
                await this.#sleep(Math.min(2000, remaining), signal);
            }
            catch (e) {
                check(signal);
                throw e;
            }
            check(signal);
            if (this.#clock() >= deadline) {
                reason = 'duration';
                break;
            }
        }
        check(signal);
        return { scope: 'bounded_active_watch' as const, idleWake: false, backgroundWork: false, nonAtomic: true, reason, frames, completion: 'not_established' as const };
    }
}
