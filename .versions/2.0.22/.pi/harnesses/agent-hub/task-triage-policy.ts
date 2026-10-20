import type { System1Result } from "../lib/system1/contracts.ts";
import { TASK_TRIAGE_MODEL, TASK_TRIAGE_POLICY_VERSION, TASK_TRIAGE_PROVIDER, TASK_TRIAGE_QUESTION_VERSION, TASK_TRIAGE_QUESTIONS, type TaskTriageAssessment, type TriageReason } from "./task-triage-contract.ts";
export const TASK_TRIAGE_THRESHOLDS = Object.freeze({ security_change: 0.80, wide_change: 0.85, irreversible_execution: 0.80 });
const valid = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 1;
/** No negative result represents safety, permission, tier, or an override of declared risk. */
export function assessTaskTriage(result: System1Result, policyVersion: string = TASK_TRIAGE_POLICY_VERSION): TaskTriageAssessment {
 if (policyVersion !== TASK_TRIAGE_POLICY_VERSION) return { status: "invalid_result", reasons: [], detail: "policy_version" };
 if (result.status !== "ok") return { status: result.status, reasons: [], detail: "reason" in result ? result.reason : result.status };
 const { metadata, answers } = result.evaluation;
 if (metadata.provider !== TASK_TRIAGE_PROVIDER || metadata.requestedModel !== TASK_TRIAGE_MODEL || metadata.returnedModel !== TASK_TRIAGE_MODEL || metadata.questionSetVersion !== TASK_TRIAGE_QUESTION_VERSION) return { status: "invalid_result", reasons: [], detail: "version_or_provider" };
 const ids = TASK_TRIAGE_QUESTIONS.map(q => q.id);
 if (answers.length !== ids.length || new Set(answers.map(a => a.questionId)).size !== ids.length || answers.some(a => !ids.includes(a.questionId) || a.type !== "predicate" || !valid(a.probabilityTrue))) return { status: "invalid_result", reasons: [], detail: "answers" };
 const p = Object.fromEntries(answers.map(a => [a.questionId, (a as { probabilityTrue: number }).probabilityTrue])) as Record<string, number>;
 const reasons = (Object.entries(TASK_TRIAGE_THRESHOLDS) as [TriageReason, number][]).filter(([id, threshold]) => p[id] >= threshold).map(([id]) => id);
 return { status: reasons.length ? "applied" : "no_additions", reasons, probabilities: { security_change: p.security_change, wide_change: p.wide_change, irreversible_execution: p.irreversible_execution }, diagnostic: { changeIntent: p.change_intent, contextSufficient: p.context_sufficient } };
}
