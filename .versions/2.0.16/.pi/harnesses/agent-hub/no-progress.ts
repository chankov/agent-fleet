import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from 'node:util';
import { readFileSync } from "node:fs";
import { posix, resolve, relative } from "node:path";
import { worktreeRevision } from "./scope-gate.js";
import { checkTaskBudget, checkTurnBudget } from "./run-budget.js";
import { explicitProcessLifecycle, recoveryCategoryFromDetails, recoveryDecision, type RecoveryCategory } from "./recovery-contract.ts";
import { createRecoverState, type RecoverEvent } from './recover-state.ts';
import { readBackDeliverables } from './acceptance.ts';
import type { DispatchExecutorDeps } from "./tools/dispatch-execution.ts";
import { reconcileTechnical, type TechnicalEvidence } from './reconcile.ts';
import { renderRecoverCommands, renderNextInvocation } from './recover-policy.ts';
import type { ToolExecutor, DispatchAgentParams, SpawnResearchParams } from "./tools/context.ts";

interface Failure {
	dispatchId: string;
	reason: string;
	category: RecoveryCategory;
	evidencePath?: string;
	effectsEstablished?: boolean;
	catalogVersion?: string;
	toolStateChanged?: boolean;
	// Runtime-owned proof that no process launched and no effects occurred.
	// Set only from trusted lifecycle facts or an explicit no-launch port,
	// never from missing records alone.
	noLaunchEstablished?: boolean;
}
interface Ticket { allowed: boolean; key: string; executorKey: string; scope: string[]; generation: object; id: object; operationId?: string; attemptId?: string; failure?: Failure; refusal?: "busy" | "recovery"; }
interface RecordedFailure { fingerprint: string; failure: Failure; authorized: boolean; }

export const RECOVER_ENTRY = 'agent-hub-recover-event';
/** A snapshot is a checkpoint of the preceding projection, never an alternative history. */
export function projectRecoveryRows(entries: readonly unknown[]): any[] {
    const available = entries.filter((row: any) => (row?.customType ?? row?.type) === RECOVER_ENTRY).map((row: any) => row.data);
    let rows: any[] = [];
    for (const [index, row] of available.entries()) {
        if (row?.kind === 'snapshot') {
            if (!Array.isArray(row.rows) || (index > 0 && !isDeepStrictEqual(row.rows, rows))) throw new Error('Invalid recovery snapshot');
            rows = row.rows;
        } else {
            if (!row || !['ledger', 'guard'].includes(row.kind)) throw new Error('Invalid recovery history');
            rows = [...rows, row];
        }
    }
    if (rows.some(row => !row || !['ledger', 'guard'].includes(row.kind))) throw new Error('Invalid recovery history');
    return rows;
}
export type GuardHistory = { type: 'failure' | 'authorize' | 'evidence' | 'task' | 'consume' | 'invocation' | 'no_launch'; key?: string; fingerprint?: string; failure?: Failure; executorKey?: string; scope?: string[]; dispatchId?: string; taskId?: string; evidence?: DispatchEvidence; operationId?: string; evidenceRef?: string; invocation?: { tool: 'dispatch_agent' | 'spawn_research'; params: DispatchAgentParams | SpawnResearchParams } };

/** Canonical executor identity shared by the wrapper and evidence producers.
 *  Resolves the F3 mismatch: previously the wrapper used canonical([cwd, actor])
 *  while the evidence writer used raw p.agent, so production reconcile always failed. */
export function canonicalExecutor(cwd: string, actor: string): string {
	return canonical([resolve(cwd), actor.trim().toLowerCase().replace(/[\s_]+/g, "-")]);
}

/** Distinct invocation availability for exact recovery responses (T6). */
export type InvocationStatus =
 | { status: 'available'; invocation: NonNullable<GuardHistory['invocation']> }
 | { status: 'missing'; reason: string; nextActions: string[] }
 | { status: 'invalid'; reason: string; nextActions: string[] }
 | { status: 'abandoned'; reason: string; nextActions: string[] }
 | { status: 'unknown_process'; reason: string; nextActions: string[] };
export interface DispatchEvidence { dispatchId: string; taskId: string; executor: string; revision: string; changedScope: string[]; readback: TechnicalEvidence['readback']; concurrentWriters: boolean; effectsRef?: string; completed: boolean; blockingFindings: number; coveredScope: string[]; edited: boolean; evidenceRef: string; openRequirements: string[] };
const EFFECT_FENCE = new Set<RecoveryCategory>(["operator_cancelled", "indeterminate", "tool_protocol_error", "unknown_tool"]);
const NO_EFFECT_CATEGORY = new Set<RecoveryCategory>(["not_started", "invalid_input"]);
type FenceAttempt = { category?: RecoveryCategory; dispatchId: string; completed?: boolean };
function latestEffectFenceIndex(attempts: readonly FenceAttempt[] | undefined): number {
	if (!attempts) return -1;
	for (let i = attempts.length - 1; i >= 0; i--) {
		const category = attempts[i].category;
		if (category && EFFECT_FENCE.has(category)) return i;
	}
	return -1;
}
function laterAttemptLaunched(attempts: readonly FenceAttempt[], index: number): boolean {
	return attempts.slice(index + 1).some(attempt => {
		const category = attempt.category;
		return attempt.completed || (!!category && !NO_EFFECT_CATEGORY.has(category));
	});
}
/** A new task may drop a contract only when every attempt is a proven no-effect refusal. */
function phantomSafeAttempts(attempts: readonly FenceAttempt[] | undefined, noLaunchEstablished: boolean): boolean {
	if (!attempts?.length || attempts.some(attempt => { const category = attempt.category; return !category || !NO_EFFECT_CATEGORY.has(category); })) return false;
	if (attempts.some(attempt => attempt.category === "invalid_input") && !noLaunchEstablished) return false;
	return true;
}
function retainedFenceFailure(attempt: FenceAttempt, previous?: Failure): Failure {
	return {
		dispatchId: attempt.dispatchId,
		reason: previous?.dispatchId === attempt.dispatchId ? previous.reason : "effect_fence_retained",
		category: attempt.category as RecoveryCategory,
		evidencePath: previous?.dispatchId === attempt.dispatchId ? previous.evidencePath : undefined,
		// A no-launch retry must not spend a prior effects/catalog unlock.
		effectsEstablished: false,
		toolStateChanged: false,
		noLaunchEstablished: false,
		catalogVersion: previous?.dispatchId === attempt.dispatchId ? previous.catalogVersion : undefined,
	};
}
function validInvocation(value: NonNullable<GuardHistory['invocation']>): boolean {
 if (!value || !['dispatch_agent', 'spawn_research'].includes(value.tool) || !value.params || typeof value.params !== 'object' || Array.isArray(value.params)) return false;
 const params = value.params as unknown as Record<string, unknown>;
 const keys = value.tool === 'dispatch_agent' ? ['agent','task','artifacts','scope','scope_mode','deliverables','watchdog','review_reason','backend'] : ['task','persona','model','artifacts','read_scope','goal','expected_result'];
 if (Object.keys(params).some(key => !keys.includes(key)) || typeof params.task !== 'string' || !params.task.trim()) return false;
 if (value.tool === 'dispatch_agent' && (typeof params.agent !== 'string' || !params.agent.trim())) return false;
 return Object.entries(params).every(([key, item]) => item === undefined || (['artifacts','scope','deliverables','read_scope'].includes(key) ? Array.isArray(item) && item.every(s => typeof s === 'string') : key === 'watchdog' ? typeof item === 'boolean' : typeof item === 'string'));
}
export function createNoProgressGuard(persist?: (type: string, data: unknown) => void) {
 let recovery = createRecoverState([], event => persist?.(RECOVER_ENTRY, { kind: 'ledger', event }));
	let generation = {};
	let taskId: string = randomUUID();
	let taskIdentityPersisted = false;
	const pending = new Map<string, object>();
	const pendingExecutors = new Map<string, object>();
	const pendingLineages = new Map<string, { operationId: string; attemptId: string }>();
	const failures = new Map<string, RecordedFailure>();
	const heldFences = new Map<string, RecordedFailure>();
    const dispatchEvidence = new Map<string, DispatchEvidence>();
    const invocations = new Map<string, NonNullable<GuardHistory['invocation']>>();
	const cancellations = new Map<string, { executorKey: string; scope: string[]; entry: RecordedFailure }>();
	const userGrants: { dispatchId: string; question: string; taskId: string; scope: string[]; used: boolean; cancelled: boolean }[] = [];
	const sameScope = (left: string[], right: string[]) => JSON.stringify([...left].map(path => path.replace(/\\/g, "/")).sort()) === JSON.stringify([...right].map(path => path.replace(/\\/g, "/")).sort());
	return {
		taskToken: () => generation,
		taskId: () => taskId,
		/** The first task has no reset event. Save its identity before binding any
		 * pre-model assessment so a resumed session cannot mint another task ID. */
		persistTaskIdentity() {
			if (taskIdentityPersisted) return;
			persist?.(RECOVER_ENTRY, { kind: 'guard', event: { type: 'task', taskId } satisfies GuardHistory });
			taskIdentityPersisted = true;
		},
		begin(key: string, fingerprint: string, executorKey = key, scope: string[] = [], currentRevision?: string): Ticket {
			let userGrant: (typeof userGrants)[number] | undefined;
			const cancelled = [...cancellations.values()].filter(item => item.executorKey === executorKey);
			const old = cancelled.find(item => !item.entry.authorized)?.entry ?? cancelled[0]?.entry ?? failures.get(key), id = {};
			if (pendingExecutors.has(executorKey)) return { allowed: false, key, executorKey, scope, generation, id, refusal: "busy" };
            // An interrupted append can leave a ledger failure without its guard snapshot.
            // Never treat that as a fresh contract or an unlocked replay.
            if (!old) {
                const op = recovery.findContract(key);
                const fenceIndex = latestEffectFenceIndex(op?.attempts);
                const fence = op && fenceIndex >= 0 ? op.attempts[fenceIndex] : undefined;
                if (op && fence?.category && !laterAttemptLaunched(op.attempts, fenceIndex)) {
                    return { allowed: false, key, executorKey, scope, generation, id, refusal: 'recovery', failure: { category: fence.category, dispatchId: fence.dispatchId, reason: 'effect_fence_retained' } };
                }
                const last = op?.attempts.at(-1);
                if (last?.category) return { allowed: false, key, executorKey, scope, generation, id, refusal: 'recovery', failure: { category: last.category, dispatchId: last.dispatchId, reason: 'guard_history_missing' } };
            }
			if (old) {
				const category = old.failure.category ?? "indeterminate";
				const changed = old.fingerprint !== fingerprint || old.failure.noLaunchEstablished === true || (category === "unknown_tool" && old.failure.toolStateChanged === true);
				userGrant = category === "blocked_on_user" ? userGrants.find(grant => grant.dispatchId === old.failure.dispatchId && !grant.used && !grant.cancelled && grant.taskId === taskId && sameScope(grant.scope, scope)) : undefined;
				const decision = recoveryDecision(category, {
					explicitInvocation: true,
					relevantConditionsChanged: changed || category === "busy" || (category === 'verification_failed' && !!currentRevision && recovery.findContract(key)?.technical?.status === 'cleared' && recovery.findContract(key)?.technical?.revision === currentRevision),
					freshOneUseAuthorization: old.authorized || !!userGrant || (category === 'indeterminate' && recovery.findContract(key)?.grantedAttemptId === recovery.findContract(key)?.attempts.at(-1)?.attemptId),
					processSettled: category === 'indeterminate' && !!recovery.findContract(key)?.attempts.at(-1)?.settled,
					indeterminateGrantUsed: category === 'indeterminate' && recovery.findContract(key)?.grantedAttemptId === recovery.findContract(key)?.attempts.at(-1)?.attemptId,
					effectsEstablished: old.failure.effectsEstablished === true,
					toolStateChanged: old.failure.toolStateChanged === true,
					noLaunchEstablished: old.failure.noLaunchEstablished === true,
                    executorIdle: !pendingExecutors.has(executorKey),
				});
				if (!decision.allowed) return { allowed: false, key, executorKey, scope, generation, id, failure: { ...old.failure, category }, refusal: "recovery" };
			}
			// T2: task-scoped logical identity vs persistent effect fence.
			// A phantom not_started attempt from another task never had a process or effects,
			// so a truly new safe task must not inherit it. Cancel/unknown-write/indeterminate
			// fences survive task/model/scope changes and are reused via the old taskId.
			const existing = recovery.findContract(key);
			const phantomFromOtherTask = !!existing && existing.taskId !== taskId && phantomSafeAttempts(existing.attempts, failures.get(key)?.failure.noLaunchEstablished === true);
			const lineageTaskId = phantomFromOtherTask ? taskId : (existing?.taskId ?? taskId);
			const lineage = recovery.start(lineageTaskId, key, executorKey, randomUUID());
			if (!lineage) return { allowed: false, key, executorKey, scope, generation, id, refusal: 'recovery' };
			if (userGrant) userGrant.used = true;
            for (const item of cancelled) {
                const failedKey = [...failures].find(([, entry]) => entry === item.entry)?.[0];
                if (failedKey) persist?.(RECOVER_ENTRY, { kind: 'guard', event: { type: 'consume', key: failedKey, dispatchId: item.entry.failure.dispatchId } satisfies GuardHistory });
                cancellations.delete(item.entry.failure.dispatchId);
                if (failedKey) failures.delete(failedKey);
            }
            if (failures.has(key)) {
                const prior = failures.get(key)!;
                if (EFFECT_FENCE.has(prior.failure.category)) heldFences.set(key, prior);
                else heldFences.delete(key);
                persist?.(RECOVER_ENTRY, { kind: 'guard', event: { type: 'consume', key, dispatchId: prior.failure.dispatchId } satisfies GuardHistory });
                failures.delete(key);
            } else heldFences.delete(key);
			pending.set(key, id);
			pendingExecutors.set(executorKey, id);
			pendingLineages.set(executorKey, lineage);
			return { allowed: true, key, executorKey, scope, generation, id, ...lineage };
		},
		finish(ticket: Ticket, fingerprint: string, failure?: Failure) {
			if (!ticket.allowed || ticket.generation !== generation || pending.get(ticket.key) !== ticket.id || pendingExecutors.get(ticket.executorKey) !== ticket.id) return;
			pending.delete(ticket.key);
			pendingExecutors.delete(ticket.executorKey);
			pendingLineages.delete(ticket.executorKey);
			const held = heldFences.get(ticket.key);
			heldFences.delete(ticket.key);
			if (failure && ticket.operationId && ticket.attemptId) {
				recovery.bindDispatch(ticket.operationId, ticket.attemptId, failure.dispatchId);
				recovery.fail(ticket.operationId, ticket.attemptId, failure.category);
			} else if (!failure && ticket.operationId && ticket.attemptId) recovery.complete(ticket.operationId, ticket.attemptId);
			const attempts = recovery.findContract(ticket.key)?.attempts;
			const fenceIndex = latestEffectFenceIndex(attempts);
			const fence = fenceIndex >= 0 ? attempts![fenceIndex] : undefined;
			const retain = !!failure && NO_EFFECT_CATEGORY.has(failure.category) && !!fence?.category && !laterAttemptLaunched(attempts!, fenceIndex);
			if (retain && fence?.category) {
				const retained = retainedFenceFailure(fence, held?.failure);
				const entry = { fingerprint: held?.fingerprint ?? fingerprint, failure: retained, authorized: false };
				failures.set(ticket.key, entry);
				if (retained.category === "operator_cancelled") cancellations.set(retained.dispatchId, { executorKey: ticket.executorKey, scope: held ? ticket.scope : ticket.scope, entry });
				persist?.(RECOVER_ENTRY, { kind: 'guard', event: { type: 'failure', key: ticket.key, fingerprint: entry.fingerprint, failure: retained, executorKey: ticket.executorKey, scope: ticket.scope } satisfies GuardHistory });
				return;
			}
			if (failure) {
				const entry = { fingerprint, failure, authorized: false };
				failures.set(ticket.key, entry);
				if (failure.category === "operator_cancelled") cancellations.set(failure.dispatchId, { executorKey: ticket.executorKey, scope: ticket.scope, entry });
				persist?.(RECOVER_ENTRY, { kind: 'guard', event: { type: 'failure', key: ticket.key, fingerprint, failure, executorKey: ticket.executorKey, scope: ticket.scope } satisfies GuardHistory });
			}
		},
        /** Internal runtime port, not model input. Caller must retain an effects inspection artifact;
         * unchanged conditions still cannot retry or replay observed effects. */
        establishEffects(dispatchId: string, token: object, evidenceRef: string): boolean {
            if (token !== generation || !evidenceRef.trim()) return false;
            for (const entry of failures.values()) {
                if (entry.failure.dispatchId !== dispatchId || entry.failure.category !== "tool_protocol_error") continue;
                entry.failure.effectsEstablished = true;
                entry.failure.evidencePath = evidenceRef;
                return true;
            }
            return false;
        },
        /** Runtime-owned no-launch proof (T8). Frees a phantom preflight entry only with
         *  positive evidence of no process/dispatch/effects — never from missing records.
         *  Unknown-write/cancel/indeterminate-with-possible-effects are never freed here. */
        establishNoLaunch(dispatchId: string, token: object, evidenceRef: string): boolean {
            if (token !== generation || !evidenceRef.trim()) return false;
            for (const [key, entry] of failures) {
                if (entry.failure.dispatchId !== dispatchId) continue;
                if (entry.failure.category !== "not_started" && entry.failure.category !== "invalid_input") return false;
                entry.failure.noLaunchEstablished = true;
                entry.failure.evidencePath = evidenceRef;
                persist?.(RECOVER_ENTRY, { kind: 'guard', event: { type: 'no_launch', key, dispatchId, evidenceRef } satisfies GuardHistory });
                return true;
            }
            return false;
        },
        /** Exact invocation availability (T6): missing/invalid/abandoned/unknown-process differ. */
        invocationStatus(operationId: string): InvocationStatus {
            const op = recovery.inspect(operationId);
            if (!op) return { status: 'missing', reason: 'unknown_operation', nextActions: ['inspect the operation id', 're-establish the contract before dispatching'] };
            if (op.abandoned) return { status: 'abandoned', reason: 'operation_abandoned', nextActions: ['abandon closed the operation; parent obligations remain open', 'start a new task for new work; do not replay the abandoned invocation'] };
            const attempt = op.attempts.at(-1);
            if (!attempt?.category) return { status: 'unknown_process', reason: 'pending_or_unknown_process', nextActions: ['settle the live process before recovery', 'independent inspection is allowed; replay is not'] };
            const invocation = invocations.get(operationId);
            if (!invocation) return { status: 'missing', reason: 'missing_original_runtime_invocation', nextActions: ['re-establish the validated contract', 'independent inspection is allowed; replay without a contract is not'] };
            if (!validInvocation(invocation)) return { status: 'invalid', reason: 'invalid_original_invocation', nextActions: ['correct the invocation shape before dispatching'] };
            return { status: 'available', invocation: structuredClone(invocation) };
        },
		establishToolStateChange(previousCatalogVersion: string, nextCatalogVersion: string, evidenceRef: string): number {
			if (!previousCatalogVersion || !nextCatalogVersion || previousCatalogVersion === nextCatalogVersion || !evidenceRef.trim()) return 0;
			let established = 0;
			for (const entry of failures.values()) {
				if (entry.failure.category !== "unknown_tool" || entry.failure.catalogVersion !== previousCatalogVersion) continue;
				entry.failure.toolStateChanged = true;
				entry.failure.evidencePath = evidenceRef;
				established++;
			}
			return established;
		},
        prepareSessionRestore() { /* Keep the previous guard installed until a validated restore can replace it. */ },
        compact(entries: readonly unknown[]) {
            const rows = projectRecoveryRows(entries);
            persist?.(RECOVER_ENTRY, { kind: 'snapshot', rows: structuredClone(rows) });
        },
        restore(entries: readonly unknown[], initialTaskId?: string) {
            const rows = projectRecoveryRows(entries);
            const ledger = rows.filter(row => row?.kind === 'ledger').map(row => row.event as RecoverEvent);
            const validated = createRecoverState(ledger, event => persist?.(RECOVER_ENTRY, { kind: 'ledger', event }));
            const nextFailures = new Map<string, RecordedFailure>();
            const nextCancellations = new Map<string, { executorKey: string; scope: string[]; entry: RecordedFailure }>();
            const nextEvidence = new Map<string, DispatchEvidence>();
            const nextInvocations = new Map<string, NonNullable<GuardHistory['invocation']>>();
            // Legacy pre-model sessions may have process additions but no dispatch,
            // reset, or recovery event yet. Their sole persisted task binding is
            // authoritative only when there is no recovery history to contradict it.
            let nextTaskId = rows.length === 0 && initialTaskId ? initialTaskId : taskId;
            for (const row of rows.filter(row => row?.kind === 'guard')) {
                const event = row.event as GuardHistory;
                if (event.type === 'failure' && event.failure && event.key && event.fingerprint && event.executorKey && validated.byDispatch(event.failure.dispatchId)?.contract === event.key && validated.byDispatch(event.failure.dispatchId)?.executor === event.executorKey && validated.byDispatch(event.failure.dispatchId)?.attempts.some(a => a.dispatchId === event.failure!.dispatchId && a.category === event.failure!.category)) {
                    const existing = nextFailures.get(event.key);
                    const keepFence = existing && EFFECT_FENCE.has(existing.failure.category) && NO_EFFECT_CATEGORY.has(event.failure.category);
                    if (!keepFence) {
                    const entry = { fingerprint: event.fingerprint, failure: event.failure, authorized: false };
                    nextFailures.set(event.key, entry);
                    if (event.failure.category === 'operator_cancelled') nextCancellations.set(event.failure.dispatchId, { executorKey: event.executorKey, scope: event.scope ?? [], entry });
                    }
                } else if (event.type === 'consume' && event.key && event.dispatchId && nextFailures.get(event.key)?.failure.dispatchId === event.dispatchId) {
                    nextFailures.delete(event.key);
                    for (const [id, item] of nextCancellations) if (item.entry.failure.dispatchId === event.dispatchId) nextCancellations.delete(id);
                } else if (event.type === 'authorize' && event.dispatchId && event.key && nextFailures.get(event.key)?.failure.dispatchId === event.dispatchId) {
                    nextFailures.get(event.key)!.authorized = true;
                } else if (event.type === 'no_launch' && event.dispatchId && event.key && event.evidenceRef && nextFailures.get(event.key)?.failure.dispatchId === event.dispatchId && (nextFailures.get(event.key)!.failure.category === 'not_started' || nextFailures.get(event.key)!.failure.category === 'invalid_input')) {
                    nextFailures.get(event.key)!.failure.noLaunchEstablished = true;
                    nextFailures.get(event.key)!.failure.evidencePath = event.evidenceRef;
                } else if (event.type === 'task' && event.taskId) {
                    nextTaskId = event.taskId;
                } else if (event.type === 'invocation' && event.operationId && event.key && event.invocation && validated.inspect(event.operationId)?.contract === event.key && !nextInvocations.has(event.operationId) && validInvocation(event.invocation)) {
                    nextInvocations.set(event.operationId, structuredClone(event.invocation));
                } else if (event.type === 'evidence' && event.evidence && event.evidence.dispatchId && event.evidence.taskId) {
                    nextEvidence.set(event.evidence.dispatchId, event.evidence);
                } else throw new Error('Invalid recovery guard history');
            }
            if (!rows.some(row => row?.kind === 'guard' && row.event?.type === 'task')) {
                const latest = [...ledger].reverse().find(event => event.type === 'start');
                if (latest?.type === 'start') nextTaskId = latest.taskId;
            }
            for (const operationId of new Set(validated.events().filter(event => event.type === 'start').map(event => event.operationId))) {
                const op = validated.inspect(operationId);
                const fenceIndex = latestEffectFenceIndex(op?.attempts);
                if (!op || fenceIndex < 0 || laterAttemptLaunched(op.attempts, fenceIndex)) continue;
                const current = nextFailures.get(op.contract);
                if (current && EFFECT_FENCE.has(current.failure.category)) continue;
                const failure = retainedFenceFailure(op.attempts[fenceIndex], current?.failure);
                const entry = { fingerprint: current?.fingerprint ?? '', failure, authorized: false };
                nextFailures.set(op.contract, entry);
                if (failure.category === 'operator_cancelled') nextCancellations.set(failure.dispatchId, { executorKey: op.executor, scope: [], entry });
            }
            recovery = validated; taskId = nextTaskId;
            taskIdentityPersisted = rows.some(row => row?.kind === 'guard' && row.event?.type === 'task' && row.event.taskId === nextTaskId);
            failures.clear(); for (const [key, value] of nextFailures) failures.set(key, value);
            cancellations.clear(); for (const [key, value] of nextCancellations) cancellations.set(key, value);
            dispatchEvidence.clear(); for (const [key, value] of nextEvidence) dispatchEvidence.set(key, value);
            invocations.clear(); for (const [key, value] of nextInvocations) invocations.set(key, value);
            generation = {}; pending.clear(); pendingExecutors.clear(); pendingLineages.clear();
        },
        reviewCoverage(taskId: string) { return [...dispatchEvidence.values()].filter(row => row.taskId === taskId && !row.completed).flatMap(row => row.changedScope); },
        recordDispatchEvidence(evidence: DispatchEvidence) {
            if (!evidence.dispatchId || !evidence.taskId || dispatchEvidence.has(evidence.dispatchId)) return false;
            persist?.(RECOVER_ENTRY, { kind: 'guard', event: { type: 'evidence', evidence } satisfies GuardHistory });
            dispatchEvidence.set(evidence.dispatchId, structuredClone(evidence)); return true;
        },
        reconcile(operationId: string, attemptId: string, currentRevision: string, roots: { cwd: string; sessionDir: string }) {
            const op = recovery.inspect(operationId), attempt = op?.attempts.find(a => a.attemptId === attemptId);
            const original = attempt && dispatchEvidence.get(attempt.dispatchId);
            if (!op || !attempt || !original || original.taskId !== op.taskId || original.executor !== op.executor) return { cleared: false as const, reason: 'missing_original_runtime_evidence' };
            if (currentRevision === 'unavailable' || worktreeRevision(roots.cwd, []) !== currentRevision) return { cleared: false as const, reason: 'stale_or_unavailable_revision' };
            const currentReadback = readBackDeliverables({ files: original.readback.map(row => ({ input: row.path, path: row.path, before: row.sha256 ?? null })), scopeRoots: [] }, roots);
            if (original.readback.some((row, i) => row.status !== 'read' || !row.sha256 || currentReadback[i]?.status !== 'read' || currentReadback[i]?.sha256 !== row.sha256)) return { cleared: false as const, reason: 'readback_changed_or_unsafe' };
            const verifiedReadback = original.readback.map((row, i) => ({ ...row, path: relative(roots.cwd, row.path).replace(/\\/g, '/'), sha256: currentReadback[i]!.sha256 }));
            const reviewer = [...dispatchEvidence.values()].find(row => row.taskId === op.taskId && row.executor !== op.executor && row.completed && row.revision === currentRevision && !row.edited && row.blockingFindings === 0 && row.changedScope.length === 0 && original.changedScope.every(path => row.coveredScope.includes(path)));
            return reconcileTechnical(recovery, { taskId: op.taskId, operationId, attemptId, currentRevision, observedRevision: original.revision, originalExecutor: original.executor, changedScope: original.changedScope, readback: verifiedReadback, concurrentWriters: original.concurrentWriters, effectsRef: original.effectsRef, reviewer: reviewer && { taskId: reviewer.taskId, executor: reviewer.executor, revision: reviewer.revision, completed: reviewer.completed, blockingFindings: reviewer.blockingFindings, coveredScope: reviewer.coveredScope, edited: reviewer.edited, evidenceRef: reviewer.evidenceRef }, openRequirements: original.openRequirements });
        },
        inspect(operationId: string) { return recovery.inspect(operationId); },
        invocation(operationId: string) { const item = invocations.get(operationId); return item ? structuredClone(item) : null; },
        recordInvocation(operationId: string, key: string, invocation: NonNullable<GuardHistory['invocation']>) {
            if (recovery.inspect(operationId)?.contract !== key || invocations.has(operationId) || !validInvocation(invocation)) return false;
            persist?.(RECOVER_ENTRY, { kind: 'guard', event: { type: 'invocation', operationId, key, invocation: structuredClone(invocation) } satisfies GuardHistory });
            invocations.set(operationId, structuredClone(invocation)); return true;
        },
        byDispatch(dispatchId: string) { return recovery.byDispatch(dispatchId); },
        assess(operationId: string, attemptId: string, revision: string, status: 'open' | 'cleared', evidence: string) { return recovery.assess(operationId, attemptId, revision, status, evidence); },
        abandon(operationId: string, attemptId: string, nonce: string) { return recovery.abandon(operationId, attemptId, nonce); },
        isIdle(executor: string) { return !pendingExecutors.has(executor); },
		/** Only independent runtime process settlement evidence may call this port. */
		settle(operationId: string, attemptId: string, evidence: string) { return recovery.settle(operationId, attemptId, evidence); },
		authorizeIndeterminate(operationId: string, attemptId: string, nonce: string): boolean {
            const op = recovery.inspect(operationId);
            if (!op || op.attempts.at(-1)?.attemptId !== attemptId || !op.attempts.at(-1)?.settled || pendingExecutors.has(op.executor) || op.abandoned || op.indeterminateGrantUsed) return false;
			return recovery.grant(operationId, attemptId, nonce);
		},
        canAuthorize(operationId: string, attemptId: string) {
            const op = recovery.inspect(operationId), attempt = op?.attempts.at(-1);
            return !!op && op.taskId === taskId && !op.abandoned && attempt?.attemptId === attemptId && !!attempt.category && !pendingExecutors.has(op.executor) && (attempt.category === 'indeterminate' ? !!attempt.settled && !op.indeterminateGrantUsed : attempt.category === 'operator_cancelled' && !!cancellations.get(attempt.dispatchId) && !cancellations.get(attempt.dispatchId)!.entry.authorized);
        },
		recordUserAnswer(input: { dispatchId: string; question: string; scope: string[]; prose?: string }): boolean {
			const failure = [...failures.values()].find(entry => entry.failure.dispatchId === input.dispatchId && entry.failure.category === "blocked_on_user");
			if (!failure || !input.question.trim() || userGrants.some(grant => grant.dispatchId === input.dispatchId && !grant.used && !grant.cancelled)) return false;
			userGrants.push({ dispatchId: input.dispatchId, question: input.question.trim(), taskId, scope: [...input.scope], used: false, cancelled: false });
			return true;
		},
		cancelUserAnswer(dispatchId: string): boolean {
			const grant = userGrants.find(item => item.dispatchId === dispatchId && !item.used && !item.cancelled);
			if (!grant) return false;
			grant.cancelled = true;
			return true;
		},
		userAnswerCapabilities() { return { filesystem: false, network: false, cloud: false, secrets: false } as const; },
		authorize(dispatchId: string): boolean {
			for (const { entry } of cancellations.values()) {
				if (entry.failure.dispatchId !== dispatchId || entry.authorized || entry.failure.category !== "operator_cancelled") continue;
                const key = [...failures].find(([, value]) => value === entry)?.[0];
                if (!key) return false;
                persist?.(RECOVER_ENTRY, { kind: 'guard', event: { type: 'authorize', key, dispatchId } satisfies GuardHistory });
				entry.authorized = true;
				return true;
			}
			return false;
		},
		adopt(id: string, persistIdentity = true) { /* A live process is never synthesized as completed during reset. */ pendingLineages.clear(); generation = {}; if (persistIdentity) persist?.(RECOVER_ENTRY, { kind: 'guard', event: { type: 'task', taskId: id } satisfies GuardHistory }); taskId = id; taskIdentityPersisted = persistIdentity; pending.clear(); pendingExecutors.clear(); /* Preserve failure/fence lineage across task reset. */ },
		reset(persistIdentity = true) { this.adopt(randomUUID(), persistIdentity); },
	};
}
export type NoProgressGuard = ReturnType<typeof createNoProgressGuard>;

export interface ResearchContract {
	readScope: string[];
	goal?: string;
	expectedResult?: string;
}

export function normalizePaths(paths: readonly string[] | undefined): string[] {
	return [...new Set((paths ?? []).map(path => posix.normalize(String(path).trim().replace(/\\/g, "/")).replace(/\/+$/, "")).filter(Boolean))].sort();
}

export function normalizeResearchContract(params: Pick<SpawnResearchParams, "read_scope" | "goal" | "expected_result">): ResearchContract {
	const text = (value: string | undefined) => value?.trim().replace(/\s+/g, " ") || undefined;
	for (const path of (params.read_scope ?? []).map(value => value.trim().replace(/\\/g, "/"))) if (/^(?:\/|[A-Za-z]:)/.test(path) || path.split("/").includes("..")) throw new Error("read_scope must be repository-relative and cannot escape through ..");
 const readScope = normalizePaths(params.read_scope);
 return { readScope, goal: text(params.goal), expectedResult: text(params.expected_result) };
}

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
	return JSON.stringify(value);
}

/** Wording and scope_mode are intentionally absent: neither can manufacture changed execution conditions.
 *  Tier and tool-catalog revision ARE included: a tier correction (small→feature) or catalog
 *  change is a material prerequisite change that must unblock a not_started retry (T1). */
export function withNoProgress<P extends DispatchAgentParams | SpawnResearchParams>(
	d: Pick<DispatchExecutorDeps, "noProgress" | "artifacts"> & Partial<Pick<DispatchExecutorDeps, "budget" | "state" | "getToolCatalogVersion">>,
	kind: "dispatch" | "research",
	execute: ToolExecutor<P>,
	executionConditions: (params: P, ctx: any, result?: any) => Record<string, unknown> = () => ({}),
): ToolExecutor<P> {
	return async (id, params, signal, onUpdate, ctx) => {
		const cwd = ctx.cwd || process.cwd();
		let research: ResearchContract | null;
        try { research = "agent" in params ? null : normalizeResearchContract(params); }
        catch (error) { return { content: [{ type: "text", text: String(error) }], details: { status: "invalid_input", recoveryCategory: "invalid_input", started: false, exitCode: 1 } }; }
		const scope = "agent" in params ? normalizePaths(params.scope) : research!.readScope;
		const actor = "agent" in params ? params.agent.trim().toLowerCase().replace(/[\s_]+/g, "-") : (params.persona ?? "research").trim().toLowerCase().replace(/[\s_]+/g, "-");
		let inputs: { path: string }[];
		try { inputs = d.artifacts.loadInputArtifacts(params.artifacts, ctx); }
		catch { return execute(id, params, signal, onUpdate, ctx); }
		const artifactRevision = () => inputs.map(input => {
			try { return [input.path, createHash("sha256").update(readFileSync(input.path)).digest("hex")]; }
			catch { return [input.path, "unreadable"]; }
		}).sort(([a], [b]) => a.localeCompare(b));
		const contractIdentity = "agent" in params ? normalizePaths(params.deliverables) : scope;
		const key = canonical([kind, resolve(cwd), actor, scope, inputs.map(input => input.path).sort(), contractIdentity]);
		const conditions = executionConditions(params, ctx);
		const fingerprint = () => canonical({
			worktree: worktreeRevision(cwd, scope),
			artifacts: artifactRevision(),
			structuredContract: research ? { readScope: research.readScope, goalDeclared: !!research.goal, expectedResultDeclared: !!research.expectedResult } : { scope, deliverables: contractIdentity },
			conditions,
			// Authoritative prerequisite snapshot: tier/catalog changes unblock not_started.
			// Task identity is deliberately excluded so reset cannot bypass cancel/unknown-write fences.
			tier: (d as any).state?.getTaskTier?.() ?? null,
			catalogVersion: (d as any).getToolCatalogVersion?.() ?? null,
		});
		const executorKey = canonicalExecutor(cwd, actor);
		const userAnswer = "agent" in params ? params.task.match(/^USER_ANSWER:\s*(\S+)\s*::\s*(.+)$/m) : null;
		if (userAnswer) d.noProgress.recordUserAnswer({ dispatchId: userAnswer[1], question: userAnswer[2].trim(), scope, prose: params.task });
		const ticket = d.noProgress.begin(key, fingerprint(), executorKey, scope, worktreeRevision(cwd, []));
        // T2: invalid/unpersisted invocation refuses before launch with an exact reason.
        // Concurrency, interrupted append, and restore never produce duplicate execution.
        if (ticket.allowed && ticket.operationId) {
            const invocation = { tool: kind === 'dispatch' ? 'dispatch_agent' : 'spawn_research', params: structuredClone(params) } as NonNullable<GuardHistory['invocation']>;
            if (!validInvocation(invocation)) {
                const invalidFailure: Failure = { dispatchId: randomUUID(), reason: 'invalid_invocation_shape', category: 'invalid_input' };
                d.noProgress.finish(ticket, fingerprint(), invalidFailure);
                return { content: [{ type: "text", text: `Invalid invocation shape: the original contract could not be persisted. Correct the parameters and re-invoke explicitly. No process launched and no effects occurred.` }], details: { status: "invalid_input", reason: "invalid_invocation_shape", recoveryCategory: "invalid_input" as const, exitCode: 1, started: false, notStarted: true, effects: "none" } };
            }
            if (!d.noProgress.invocation(ticket.operationId)) d.noProgress.recordInvocation(ticket.operationId, key, invocation);
        }
		if (!ticket.allowed) {
			if (ticket.refusal === "busy") {
				const recovery = recoveryDecision("busy", { explicitInvocation: true, relevantConditionsChanged: false, executorIdle: false });
				return { content: [{ type: "text", text: "Busy refusal: the same operation is already in flight. Nothing was queued or retried. Re-invoke explicitly only after the executor is evidenced idle; existing budgets still apply." }], details: { status: "busy", reason: "busy", recoveryCategory: "busy", recovery, exitCode: 1, started: false } };
			}
			// Defensive: a reservation failure without a recorded cause (e.g. concurrent
				// start race) stays fail-closed and never synthesizes execution.
			const failure = ticket.failure ?? { dispatchId: randomUUID(), reason: 'reservation_refused', category: 'indeterminate' as const };
            if (d.budget && d.state) {
                const b = d.budget, s = d.state;
                b.ensureTaskTier();
                // T1/F7: refusals are accounted separately from physical launches.
                // A no-progress refusal never spent a child execution, so it must not
                // consume turn/task launch counters. Anti-loop protection stays in the
                // guard (same fingerprint stays refused); budgets still fail closed.
                s.getTurnReport().refusals++; s.getSessionTotals().refusals++;
                const block = checkTaskBudget(kind, b.taskCounters(), b.currentTaskBudget(), b.taskActiveElapsedMs(), s.getTaskTier())
                    ?? checkTurnBudget(kind, { dispatches: s.getTurnDispatchCount(), research: s.getTurnResearchCount() }, b.currentBudget(), b.turnBudgetActiveElapsedMs(), s.getTaskTier());
                if (block) return { content: [{ type: "text", text: block.message }], details: { status: "budget_refused", reason: block.reason, started: false, recoveryCategory: failure.category, exitCode: 1 } };
                b.updateModeStatus();
            }
			const recovery = recoveryDecision(failure.category, { explicitInvocation: true });
            const operation = d.noProgress.byDispatch(failure.dispatchId);
            const attempt = operation?.attempts.find(a => a.dispatchId === failure.dispatchId);
            const rendered = operation && attempt && renderRecoverCommands(d.noProgress, operation.operationId, attempt.attemptId);
            // T6: missing/invalid/abandoned/unknown-process each get their own reason.
            const invocationNote = (() => {
                if (!operation) return 'Original validated invocation unavailable: unknown operation; re-establish the contract before dispatching.';
                const status = (d.noProgress as any).invocationStatus?.(operation.operationId);
                if (!status || status.status === 'available') {
                    const next = renderNextInvocation(d.noProgress, operation.operationId);
                    return next ? `Original-contract invocation after authorization: ${next}.` : 'Original validated invocation unavailable.';
                }
                if (status.status === 'abandoned') return 'Original invocation abandoned: abandon closed the operation and never satisfies parent work; start a new task for new work.';
                if (status.status === 'unknown_process') return 'Original validated invocation unavailable: pending or unknown process; settle before recovery. Independent inspection is allowed.';
                if (status.status === 'invalid') return 'Original invocation invalid: correct the invocation shape before dispatching.';
                return 'Original validated invocation unavailable: missing contract; re-establish the contract before dispatching. Independent inspection is allowed.';
            })();
            const commands = rendered ? `Commands (subject to prerequisites): ${rendered}; legacy: /af-retry ${failure.dispatchId}. ${invocationNote} These commands do not start a dispatch.` : '';
			const authorization = failure.category === "operator_cancelled"
				? `Fresh one-use authorization is required. Scope mode, model, and prose changes are not authorization. ${commands}`
                : `${recovery.reason} ${commands}`;
			return { content: [{ type: "text", text: `No-progress refusal after ${failure.category}: ${failure.reason}. Previous attempt: ${failure.dispatchId}${failure.evidencePath ? ` (${failure.evidencePath})` : ""}. ${authorization} No automatic retry or waiting was performed.` }], details: { status: "no_progress_refused", reason: "unchanged_or_unauthorized", recoveryCategory: failure.category, recovery, exitCode: 1, previousDispatchId: failure.dispatchId, evidencePath: failure.evidencePath } };
		}
		let failure: Failure | undefined;
		let result: any;
		try {
			result = await execute(id, params, signal, onUpdate, ctx);
			const details = result.details as any;
			const category = recoveryCategoryFromDetails(details);
			// A busy refusal never started work, so it must not become no-progress history.
			// A runtime-owned not_started refusal DID reach the guard reservation but never
				// launched: record it as not_started (0 launches, 0 indeterminate) so a corrected
				// prerequisite can proceed without reset, grant, or reconcile.
			if (category && category !== "busy") failure = {
				dispatchId: details.dispatchId ?? randomUUID(),
				evidencePath: details.evidencePath ?? details.failurePath ?? details.protocolEvidencePath ?? undefined,
				reason: details.diagnostics?.reason ?? details.reason ?? details.status ?? "execution_failure",
				category,
				catalogVersion: category === "unknown_tool" ? d.getToolCatalogVersion?.() : undefined,
			};
			return result;
		} catch (error) {
			failure = { dispatchId: randomUUID(), reason: "execution_exception", category: "indeterminate" };
			throw error;
		} finally {
			d.noProgress.finish(ticket, fingerprint(), failure);
            // T4: integer exit + dispatchId is not settlement. Missing lifecycle stays unsettled.
            const lifecycle = explicitProcessLifecycle((result?.details as any)?.lifecycle);
            if (failure?.category === 'indeterminate' && ticket.operationId && ticket.attemptId && result?.details?.pending !== true && lifecycle?.launched === true && lifecycle.closeSeen === true) {
                d.noProgress.settle(ticket.operationId, ticket.attemptId, `runtime-lifecycle:${result.details.dispatchId}:launched:${lifecycle.launched}:closeSeen:${lifecycle.closeSeen}`);
            }
			const effectsRef = (result?.details as any)?.protocolEffectsEvidenceRef;
			if (failure?.category === "tool_protocol_error" && typeof effectsRef === "string") {
				d.noProgress.establishEffects(failure.dispatchId, ticket.generation, effectsRef);
			}
		}
	};
}
