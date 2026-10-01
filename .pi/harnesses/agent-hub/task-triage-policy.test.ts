import test from "node:test";
import assert from "node:assert/strict";
import { assessTaskTriage } from "./task-triage-policy.ts";
import { TASK_TRIAGE_QUESTION_VERSION, TASK_TRIAGE_MODEL, TASK_TRIAGE_PROVIDER, TASK_TRIAGE_QUESTIONS } from "./task-triage-contract.ts";
function batch(p: Record<string, number> = {}) { return { status: "ok" as const, evaluation: { metadata: { provider: TASK_TRIAGE_PROVIDER, requestedModel: TASK_TRIAGE_MODEL, returnedModel: TASK_TRIAGE_MODEL, questionSetVersion: TASK_TRIAGE_QUESTION_VERSION, latencyMs: 1, attempts: 1 }, answers: TASK_TRIAGE_QUESTIONS.map(q => ({ questionId: q.id, type: "predicate" as const, probabilityTrue: p[q.id] ?? 0, uncertainty: { provenance: "provider" as const } })) } }; }
test("inclusive independent thresholds below/at/above with no provider confidence", () => {
 for (const [id, values] of [["security_change", [.799, .800, .801]], ["wide_change", [.849, .850, .851]], ["irreversible_execution", [.799, .800, .801]]] as const) values.forEach((v, i) => assert.deepEqual(assessTaskTriage(batch({ [id]: v })).reasons, i ? [id] : []));
 for (let mask = 0; mask < 8; mask++) { const ids = ["security_change", "wide_change", "irreversible_execution"]; const p = Object.fromEntries(ids.map((id, i) => [id, mask & (1 << i) ? 1 : 0])); assert.deepEqual(assessTaskTriage(batch(p)).reasons, ids.filter((_, i) => mask & (1 << i))); }
});
test("diagnostic contradictions cannot veto positive signal; negatives never mean safe", () => { const yes = assessTaskTriage(batch({ security_change: .8, change_intent: 0, context_sufficient: 0 })); assert.deepEqual(yes.reasons, ["security_change"]); assert.equal(assessTaskTriage(batch()).status, "no_additions"); });
test("invalid versions, model, provider, duplicate/missing/nonfinite answers fail closed", () => {
 const good = batch({ security_change: 1 });
 for (const changed of [ { ...good, evaluation: { ...good.evaluation, metadata: { ...good.evaluation.metadata, returnedModel: "other" } } }, { ...good, evaluation: { ...good.evaluation, metadata: { ...good.evaluation.metadata, provider: "other" } } }, { ...good, evaluation: { ...good.evaluation, metadata: { ...good.evaluation.metadata, questionSetVersion: "other" } } }, { ...good, evaluation: { ...good.evaluation, answers: good.evaluation.answers.slice(1) } }, { ...good, evaluation: { ...good.evaluation, answers: [...good.evaluation.answers.slice(1), good.evaluation.answers[1]] } }, ...[NaN, Infinity, -1, 1.1].map(v => ({ ...good, evaluation: { ...good.evaluation, answers: [{ ...good.evaluation.answers[0], probabilityTrue: v }, ...good.evaluation.answers.slice(1)] } })) ]) assert.equal(assessTaskTriage(changed as any).status, "invalid_result");
 assert.equal(assessTaskTriage(good, "old").status, "invalid_result");
});
