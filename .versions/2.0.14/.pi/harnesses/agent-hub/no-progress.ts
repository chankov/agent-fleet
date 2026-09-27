import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from 'node:util';
import { readFileSync } from "node:fs";
import { posix, resolve, relative } from "node:path";
import { worktreeRevision } from "./scope-gate.js";
import { checkTaskBudget, checkTurnBudget } from "./run-budget.js";
import { recoveryCategoryFromDetails, recoveryDecision, type RecoveryCategory } from "./recovery-contract.ts";
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
export type GuardHistory = { type: 'failure' | 'authorize' | 'evidence' | 'task' | 'consume' | 'invocation'; key?: string; fingerprint?: string; failure?: Failure; executorKey?: string; scope?: string[]; dispatchId?: string; taskId?: string; evidence?: DispatchEvidence; operationId?: string; invocation?: { tool: 'dispatch_agent' | 'spawn_research'; params: DispatchAgentParams | SpawnResearchParams } };
export interface DispatchEvidence { dispatchId: string; taskId: string; executor: string; revision: string; changedScope: string[]; readback: TechnicalEvidence['readback']; concurrentWriters: boolean; effectsRef?: string; completed: boolean; blockingFindings: number; coveredScope: string[]; edited: boolean; evidenceRef: string; openRequirements: string[] };
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
	const pending = new Map<string, object>();
	const pendingExecutors = new Map<string, object>();
	const pendingLineages = new Map<string, { operationId: string; attemptId: string }>();
	const failures = new Map<string, RecordedFailure>();
    const dispatchEvidence = new Map<string, DispatchEvidence>();
    const invocations = new Map<string, NonNullable<GuardHistory['invocation']>>();
	const cancellations = new Map<string, { executorKey: string; scope: string[]; entry: RecordedFailure }>();
	return {
		taskToken: () => generation,
		taskId: () => taskId,
		begin(key: string, fingerprint: string, executorKey = key, scope: string[] = [], currentRevision?: string): Ticket {
			const cancelled = [...cancellations.values()].filter(item => item.executorKey === executorKey);
			const old = cancelled.find(item => !item.entry.authorized)?.entry ?? cancelled[0]?.entry ?? failures.get(key), id = {};
			if (pendingExecutors.has(executorKey)) return { allowed: false, key, executorKey, scope, generation, id, refusal: "busy" };
            // An interrupted append can leave a ledger failure without its guard snapshot.
            // Never treat that as a fresh contract or an unlocked replay.
            if (!old && recovery.findContract(key)?.attempts.at(-1)?.category) {
                const last = recovery.findContract(key)!.attempts.at(-1)!;
                return { allowed: false, key, executorKey, scope, generation, id, refusal: 'recovery', failure: { category: last.category!, dispatchId: last.dispatchId, reason: 'guard_history_missing' } };
            }
			if (old) {
				const category = old.failure.category ?? "indeterminate";
				const changed = old.fingerprint !== fingerprint || (category === "unknown_tool" && old.failure.toolStateChanged === true);
				const decision = recoveryDecision(category, {
					explicitInvocation: true,
					relevantConditionsChanged: changed || category === "busy" || (category === 'verification_failed' && !!currentRevision && recovery.findContract(key)?.technical?.status === 'cleared' && recovery.findContract(key)?.technical?.revision === currentRevision),
					freshOneUseAuthorization: old.authorized || (category === 'indeterminate' && recovery.findContract(key)?.grantedAttemptId === recovery.findContract(key)?.attempts.at(-1)?.attemptId),
					processSettled: category === 'indeterminate' && !!recovery.findContract(key)?.attempts.at(-1)?.settled,
					indeterminateGrantUsed: category === 'indeterminate' && recovery.findContract(key)?.grantedAttemptId === recovery.findContract(key)?.attempts.at(-1)?.attemptId,
					effectsEstablished: old.failure.effectsEstablished === true,
					toolStateChanged: old.failure.toolStateChanged === true,
                    executorIdle: !pendingExecutors.has(executorKey),
				});
				if (!decision.allowed) return { allowed: false, key, executorKey, scope, generation, id, failure: { ...old.failure, category }, refusal: "recovery" };
			}
			const lineage = recovery.start(recovery.findContract(key)?.taskId ?? taskId, key, executorKey, randomUUID());
			if (!lineage) return { allowed: false, key, executorKey, scope, generation, id, refusal: 'recovery' };
            for (const item of cancelled) {
                const failedKey = [...failures].find(([, entry]) => entry === item.entry)?.[0];
                if (failedKey) persist?.(RECOVER_ENTRY, { kind: 'guard', event: { type: 'consume', key: failedKey, dispatchId: item.entry.failure.dispatchId } satisfies GuardHistory });
                cancellations.delete(item.entry.failure.dispatchId);
                if (failedKey) failures.delete(failedKey);
            }
            if (failures.has(key)) persist?.(RECOVER_ENTRY, { kind: 'guard', event: { type: 'consume', key, dispatchId: failures.get(key)!.failure.dispatchId } satisfies GuardHistory });
            failures.delete(key);
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
			if (failure) {
				if (ticket.operationId && ticket.attemptId) {
                    recovery.bindDispatch(ticket.operationId, ticket.attemptId, failure.dispatchId);
                    recovery.fail(ticket.operationId, ticket.attemptId, failure.category);
                }
				const entry = { fingerprint, failure, authorized: false };
				failures.set(ticket.key, entry);
				if (failure.category === "operator_cancelled") cancellations.set(failure.dispatchId, { executorKey: ticket.executorKey, scope: ticket.scope, entry });
                persist?.(RECOVER_ENTRY, { kind: 'guard', event: { type: 'failure', key: ticket.key, fingerprint, failure, executorKey: ticket.executorKey, scope: ticket.scope } satisfies GuardHistory });
			} else if (ticket.operationId && ticket.attemptId) recovery.complete(ticket.operationId, ticket.attemptId);
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
        restore(entries: readonly unknown[]) {
            const rows = projectRecoveryRows(entries);
            const ledger = rows.filter(row => row?.kind === 'ledger').map(row => row.event as RecoverEvent);
            const validated = createRecoverState(ledger, event => persist?.(RECOVER_ENTRY, { kind: 'ledger', event }));
            const nextFailures = new Map<string, RecordedFailure>();
            const nextCancellations = new Map<string, { executorKey: string; scope: string[]; entry: RecordedFailure }>();
            const nextEvidence = new Map<string, DispatchEvidence>();
            const nextInvocations = new Map<string, NonNullable<GuardHistory['invocation']>>();
            let nextTaskId = taskId;
            for (const row of rows.filter(row => row?.kind === 'guard')) {
                const event = row.event as GuardHistory;
                if (event.type === 'failure' && event.failure && event.key && event.fingerprint && event.executorKey && validated.byDispatch(event.failure.dispatchId)?.contract === event.key && validated.byDispatch(event.failure.dispatchId)?.executor === event.executorKey && validated.byDispatch(event.failure.dispatchId)?.attempts.some(a => a.dispatchId === event.failure!.dispatchId && a.category === event.failure!.category)) {
                    const entry = { fingerprint: event.fingerprint, failure: event.failure, authorized: false };
                    nextFailures.set(event.key, entry);
                    if (event.failure.category === 'operator_cancelled') nextCancellations.set(event.failure.dispatchId, { executorKey: event.executorKey, scope: event.scope ?? [], entry });
                } else if (event.type === 'consume' && event.key && event.dispatchId && nextFailures.get(event.key)?.failure.dispatchId === event.dispatchId) {
                    nextFailures.delete(event.key);
                    for (const [id, item] of nextCancellations) if (item.entry.failure.dispatchId === event.dispatchId) nextCancellations.delete(id);
                } else if (event.type === 'authorize' && event.dispatchId && event.key && nextFailures.get(event.key)?.failure.dispatchId === event.dispatchId) {
                    nextFailures.get(event.key)!.authorized = true;
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
            recovery = validated; taskId = nextTaskId;
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
		adopt(id: string, persistIdentity = true) { /* A live process is never synthesized as completed during reset. */ pendingLineages.clear(); generation = {}; taskId = id; if (persistIdentity) persist?.(RECOVER_ENTRY, { kind: 'guard', event: { type: 'task', taskId: id } satisfies GuardHistory }); pending.clear(); pendingExecutors.clear(); /* Preserve failure/fence lineage across task reset. */ },
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

/** Wording and scope_mode are intentionally absent: neither can manufacture changed execution conditions. */
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
		});
		const executorKey = canonical([resolve(cwd), actor]);
		const ticket = d.noProgress.begin(key, fingerprint(), executorKey, scope, worktreeRevision(cwd, []));
        if (ticket.allowed && ticket.operationId && !d.noProgress.invocation(ticket.operationId)) d.noProgress.recordInvocation(ticket.operationId, key, { tool: kind === 'dispatch' ? 'dispatch_agent' : 'spawn_research', params: structuredClone(params) });
		if (!ticket.allowed) {
			if (ticket.refusal === "busy") {
				const recovery = recoveryDecision("busy", { explicitInvocation: true, relevantConditionsChanged: false, executorIdle: false });
				return { content: [{ type: "text", text: "Busy refusal: the same operation is already in flight. Nothing was queued or retried. Re-invoke explicitly only after the executor is evidenced idle; existing budgets still apply." }], details: { status: "busy", reason: "busy", recoveryCategory: "busy", recovery, exitCode: 1, started: false } };
			}
			const failure = ticket.failure!;
            if (d.budget && d.state) {
                const b = d.budget, s = d.state;
                b.ensureTaskTier();
                s.getTurnReport().refusals++; s.getSessionTotals().refusals++;
                const block = checkTaskBudget(kind, b.taskCounters(), b.currentTaskBudget(), b.taskActiveElapsedMs(), s.getTaskTier())
                    ?? checkTurnBudget(kind, { dispatches: s.getTurnDispatchCount(), research: s.getTurnResearchCount() }, b.currentBudget(), b.turnBudgetActiveElapsedMs(), s.getTaskTier());
                if (block) return { content: [{ type: "text", text: block.message }], details: { status: "budget_refused", reason: block.reason, started: false, recoveryCategory: failure.category, exitCode: 1 } };
                if (kind === "dispatch") { s.setTurnDispatchCount(s.getTurnDispatchCount() + 1); s.setTaskDispatchCount(s.getTaskDispatchCount() + 1); s.getTurnReport().dispatches.push({ agent: actor, status: "no_progress_refused", elapsed: 0, billed: 0, out: 0 }); }
                else { s.setTurnResearchCount(s.getTurnResearchCount() + 1); s.setTaskResearchCount(s.getTaskResearchCount() + 1); s.getTurnReport().research++; }
                b.updateModeStatus();
            }
			const recovery = recoveryDecision(failure.category, { explicitInvocation: true });
            const operation = d.noProgress.byDispatch(failure.dispatchId);
            const attempt = operation?.attempts.find(a => a.dispatchId === failure.dispatchId);
            const rendered = operation && attempt && renderRecoverCommands(d.noProgress, operation.operationId, attempt.attemptId);
            const commands = rendered ? `Commands (subject to prerequisites): ${rendered}; legacy: /af-retry ${failure.dispatchId}. ${renderNextInvocation(d.noProgress, operation!.operationId) ? `Original-contract invocation after authorization: ${renderNextInvocation(d.noProgress, operation!.operationId)}.` : 'Original validated invocation unavailable.'} These commands do not start a dispatch.` : '';
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
            if (failure?.category === 'indeterminate' && ticket.operationId && ticket.attemptId && result?.details?.pending !== true && Number.isInteger(result?.details?.exitCode) && result?.details?.dispatchId) {
                d.noProgress.settle(ticket.operationId, ticket.attemptId, `runtime-exit:${result.details.dispatchId}:${result.details.exitCode}`);
            }
			const effectsRef = (result?.details as any)?.protocolEffectsEvidenceRef;
			if (failure?.category === "tool_protocol_error" && typeof effectsRef === "string") {
				d.noProgress.establishEffects(failure.dispatchId, ticket.generation, effectsRef);
			}
		}
	};
}
