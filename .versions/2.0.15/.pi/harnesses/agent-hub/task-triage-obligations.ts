import { createHash } from "node:crypto";
import { createProcessState } from "./process-obligations.ts";
import type { createTaskTriageRuntime } from "./task-triage-runtime.ts";
import { consumeWaiverGrant, type WaiverGrant } from "./task-triage-authorization.ts";
import { normalizeProcessState, effectiveProcessStage, latestProcessState, processAuditRecord, evaluateProcessObligations, type ProcessObligationState, type ProcessAddition } from "./process-obligations.ts";
import { TASK_TRIAGE_MODEL, TASK_TRIAGE_POLICY_VERSION, TASK_TRIAGE_PROVIDER, TASK_TRIAGE_QUESTION_VERSION, type TaskTriageAssessment, type TriageReason } from "./task-triage-contract.ts";
export interface EvaluationBinding { taskId: string; evaluationId: string; inputRevision: string; }
/** Retry persistence without replaying an effect or discarding a current assessment.
 * A corrupt latest entry, failed append/readback or oversized union stays blocked.
 */
export function recoverTaskTriageProcessState(options: {
 state: ProcessObligationState; current: (EvaluationBinding & { assessment: TaskTriageAssessment }) | null;
 taskId: string; budgetTier: string; append(record: ReturnType<typeof processAuditRecord>): void;
 entries(): readonly unknown[];
}): ProcessObligationState {
 const { state, current, taskId, budgetTier, append, entries } = options;
 const next = current && current.taskId === taskId
  ? applyTaskTriageAdditions(state, current.assessment, current)
  : normalizeProcessState(state);
 // Never recover by skipping a corrupt tail: it may contain additional requirements.
 const prior = latestProcessState(entries());
 const known = normalizeProcessState(state);
 if (known.additions!.some(a => a.taskId !== taskId)) throw new Error("In-memory additions belong to a different task; recovery requires session inspection");
 // A failed stage/evidence append may leave memory ahead of the journal. Permit
 // only a monotonic successor: no persisted source or baseline requirement lost.
 const coversPrior = (prior.additions ?? []).every(a => known.additions!.some(b => JSON.stringify(b) === JSON.stringify(a)))
  && (["acceptance", "review", "plan"] as const).every(stage => !prior[stage].required || known[stage].required)
  && prior.changedFiles.every(path => known.changedFiles.includes(path))
  && prior.reassessments <= known.reassessments;
 if (entries().some((entry: any) => (entry?.customType ?? entry?.type) === "agent-hub-process-state") && !coversPrior) throw new Error("Persisted process state differs from in-memory state; recovery requires session inspection");
 append(processAuditRecord(next, evaluateProcessObligations(next, { writable: true, budgetTier })));
 const restored = latestProcessState(entries());
 if (JSON.stringify(restored) !== JSON.stringify(normalizeProcessState(next))) throw new Error("Process state readback differs from recovery candidate");
 return restored;
}

/** Persist the transition before changing a runtime scope or reserving a scoped evaluation. */
export async function adoptTaskTriageState(options: {
 runtime: ReturnType<typeof createTaskTriageRuntime> | null; taskId: string; newTask: boolean;
 expandedScope?: string; pendingTransition: boolean; state: ProcessObligationState;
 persist(state: ProcessObligationState): void; onPostCommitFailure(): void;
}): Promise<ProcessObligationState> {
 const { runtime, taskId, expandedScope, pendingTransition, persist } = options;
 const base = options.newTask ? createProcessState() : options.state;
 // Before binding, persist only the *current* obligations. A refused new-task
 // transition must leave the journal safe to restore even if binding is cancelled.
 const needsBinding = !!(pendingTransition && runtime && !runtime.current);
 if (needsBinding) persist(options.newTask ? options.state : base);
 const bound = needsBinding ? await runtime!.bindInput(taskId) : runtime?.current;
 if (pendingTransition && runtime && !bound) throw new Error("pending input was not evaluated");
 const next = bound ? applyTaskTriageAdditions(base, bound.assessment, { taskId, evaluationId: bound.evaluationId, inputRevision: bound.revision }) : base;
 if (needsBinding) {
  try { persist(next); } catch {
   options.onPostCommitFailure();
   // The old task is still in memory and in the preflight journal entry. Do
   // not reset task identity/assertions on a failed new-task process append.
   if (options.newTask) throw new Error("new-task process state could not be persisted");
   return base;
  }
 } else persist(next);
 // A scope change starts only after the first durable process entry. Any later
 // persistence failure is post-commit: keep the gate closed, never report it as
 // a rejected adoption whose reservation could be rolled back.
 if (expandedScope && runtime?.scope(expandedScope)) {
  try {
   const scoped = await runtime.evaluate(taskId);
   if (!scoped) throw new Error("scoped input was not evaluated");
   const revised = applyTaskTriageAdditions(next, scoped.assessment, { taskId, evaluationId: scoped.evaluationId, inputRevision: scoped.revision });
   persist(revised);
   runtime.adopt(taskId);
   return revised;
  } catch { options.onPostCommitFailure(); return next; }
 }
 runtime?.adopt(taskId);
 return next;
}
export function applyTaskTriageAdditions(state: ProcessObligationState, assessment: TaskTriageAssessment, binding: EvaluationBinding): ProcessObligationState {
 const next = normalizeProcessState(state);
 if (assessment.status !== "applied" || !binding.taskId || !binding.evaluationId || !binding.inputRevision) return next;
 const existing = new Set(next.additions?.map(a => a.id));
 for (const reason of assessment.reasons) {
  if (!["security_change", "wide_change", "irreversible_execution"].includes(reason)) continue;
  const id = createHash("sha256").update(JSON.stringify([binding.taskId, binding.inputRevision, reason, TASK_TRIAGE_POLICY_VERSION, TASK_TRIAGE_QUESTION_VERSION, TASK_TRIAGE_PROVIDER, TASK_TRIAGE_MODEL])).digest("hex");
  if (existing.has(id)) continue;
  const addition: ProcessAddition = { id, source: "system1", ...binding, policyVersion: TASK_TRIAGE_POLICY_VERSION, questionVersion: TASK_TRIAGE_QUESTION_VERSION, provider: TASK_TRIAGE_PROVIDER, model: TASK_TRIAGE_MODEL, reason: reason as TriageReason, status: "active", waiverReason: null };
  next.additions!.push(addition); existing.add(id);
  // A newly required stage cannot inherit unrelated, uncovered old evidence.
  if (reason === "wide_change") next.plan = { ...next.plan, evidenceRef: null, revision: null };
  if (reason === "wide_change" || reason === "security_change") next.review = { ...next.review, evidenceRef: null, revision: null };
 }
 // Never persist a partial union or silently discard the last active requirement.
 if (next.additions!.length > 300 || Buffer.byteLength(JSON.stringify(next.additions)) > 64 * 1024) throw new Error("Process additions exceed the persistence limit; dependent effects are blocked.");
 return next;
}
/** A private, one-use human grant is required; model-provided flags have no authority. */
export function waiveTaskTriageAddition(state: ProcessObligationState, input: EvaluationBinding & { additionId: string; reason: string }, grant: WaiverGrant): ProcessObligationState | null {
 if (!input.reason?.trim() || input.reason.length > 512) return null;
 const next = normalizeProcessState(state);
 const addition = next.additions?.find(a => a.id === input.additionId && a.taskId === input.taskId && a.evaluationId === input.evaluationId && a.inputRevision === input.inputRevision && a.status === "active");
 if (!addition || !consumeWaiverGrant(grant, input)) return null;
 addition.status = "waived"; addition.waiverReason = input.reason.trim();
 return next;
}
export function pendingActionConfirmation(state: ProcessObligationState): ProcessAddition[] { const s = normalizeProcessState(state); return effectiveProcessStage(s, "confirmation") ? s.additions!.filter(a => a.reason === "irreversible_execution" && a.status === "active") : []; }
