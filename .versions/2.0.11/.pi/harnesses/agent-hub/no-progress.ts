import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { posix, resolve } from "node:path";
import { worktreeRevision } from "./scope-gate.js";
import { checkTaskBudget, checkTurnBudget } from "./run-budget.js";
import { recoveryCategoryFromDetails, recoveryDecision, type RecoveryCategory } from "./recovery-contract.ts";
import type { DispatchExecutorDeps } from "./tools/dispatch-execution.ts";
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
interface Ticket { allowed: boolean; key: string; executorKey: string; scope: string[]; generation: object; id: object; failure?: Failure; refusal?: "busy" | "recovery"; }
interface RecordedFailure { fingerprint: string; failure: Failure; authorized: boolean; }

export function createNoProgressGuard() {
	let generation = {};
	let taskId = randomUUID();
	const pending = new Map<string, object>();
	const pendingExecutors = new Map<string, object>();
	const failures = new Map<string, RecordedFailure>();
	const cancellations = new Map<string, { executorKey: string; scope: string[]; entry: RecordedFailure }>();
	return {
		taskToken: () => generation,
		taskId: () => taskId,
		begin(key: string, fingerprint: string, executorKey = key, scope: string[] = []): Ticket {
			const cancelled = [...cancellations.values()].filter(item => item.executorKey === executorKey);
			const old = cancelled.find(item => !item.entry.authorized)?.entry ?? cancelled[0]?.entry ?? failures.get(key), id = {};
			if (pendingExecutors.has(executorKey)) return { allowed: false, key, executorKey, scope, generation, id, refusal: "busy" };
			if (old) {
				const category = old.failure.category ?? "indeterminate";
				const changed = old.fingerprint !== fingerprint || (category === "unknown_tool" && old.failure.toolStateChanged === true);
				const decision = recoveryDecision(category, {
					explicitInvocation: true,
					relevantConditionsChanged: changed || category === "busy",
					freshOneUseAuthorization: old.authorized,
					effectsEstablished: old.failure.effectsEstablished === true,
					toolStateChanged: old.failure.toolStateChanged === true,
                    executorIdle: !pendingExecutors.has(executorKey),
				});
				if (!decision.allowed) return { allowed: false, key, executorKey, scope, generation, id, failure: { ...old.failure, category }, refusal: "recovery" };
			}
			for (const item of cancelled) { cancellations.delete(item.entry.failure.dispatchId); for (const [failedKey, entry] of failures) if (entry === item.entry) failures.delete(failedKey); }
			failures.delete(key);
			pending.set(key, id);
			pendingExecutors.set(executorKey, id);
			return { allowed: true, key, executorKey, scope, generation, id };
		},
		finish(ticket: Ticket, fingerprint: string, failure?: Failure) {
			if (!ticket.allowed || ticket.generation !== generation || pending.get(ticket.key) !== ticket.id || pendingExecutors.get(ticket.executorKey) !== ticket.id) return;
			pending.delete(ticket.key);
			pendingExecutors.delete(ticket.executorKey);
			if (failure) {
				const entry = { fingerprint, failure, authorized: false };
				failures.set(ticket.key, entry);
				if (failure.category === "operator_cancelled") cancellations.set(failure.dispatchId, { executorKey: ticket.executorKey, scope: ticket.scope, entry });
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
		authorize(dispatchId: string): boolean {
			for (const { entry } of cancellations.values()) {
				if (entry.failure.dispatchId !== dispatchId || entry.authorized || entry.failure.category !== "operator_cancelled") continue;
				entry.authorized = true;
				return true;
			}
			return false;
		},
		adopt(id: string) { generation = {}; taskId = id; pending.clear(); pendingExecutors.clear(); failures.clear(); },
		reset() { this.adopt(randomUUID()); },
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
		const ticket = d.noProgress.begin(key, fingerprint(), executorKey, scope);
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
			const authorization = failure.category === "operator_cancelled"
				? `Fresh one-use authorization is required: /af-retry ${failure.dispatchId}. Scope mode, model, and prose changes are not authorization.`
				: recovery.reason;
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
			const effectsRef = (result?.details as any)?.protocolEffectsEvidenceRef;
			if (failure?.category === "tool_protocol_error" && typeof effectsRef === "string") {
				d.noProgress.establishEffects(failure.dispatchId, ticket.generation, effectsRef);
			}
		}
	};
}
