import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { createProactiveEvaluator } from "./proactive-evaluate.ts";
import { createProactiveRuntime } from "./proactive-runtime.ts";
import type { ProactiveConfig, TurnSnapshot } from "./proactive-types.ts";
import type { SelectionResult } from "./proactive-selection.ts";
import type { System1Service, System1Result } from "../lib/system1/contracts.ts";
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
const config: ProactiveConfig = { version: 1, mode: "shadow", remoteContext: "selected-excerpts", include: ["src/**"], maxEvaluationsPerSession: 2 };
const selection: SelectionResult = { selected: [{ id: "r1", source: { path: "rules.md", hash: hash("rule"), revision: "1" }, heading: "Rule", occurrence: 1, kind: "default", context: "", text: "Keep docs clear" }], coverage: [], gaps: [], status: "complete", cacheKey: "key" };
const snapshot = (plan = false, text = "Hello world", kind: "text" | "modified" = "text"): TurnSnapshot => ({ snapshotId: hash("snap"), turnId: "session:hub:direct:0", head: "", context: { task: { path: "task", revision: "1", hash: hash("Задача task") }, ...(plan ? { plan: { path: "plan", revision: "1", hash: hash("Plan") } } : {}), rules: [selection.selected[0].source], exceptions: [] }, planStatus: plan ? "bound" : "task_only", status: "complete", gaps: [], units: [{ id: "unit", path: kind === "text" ? "assistant" : "src/a.ts", kind, attribution: "observed_only", after: { text, hash: hash(text), offset: 0, endOffset: text.length, startLine: 1, endLine: 1, truncated: false } }], observedPaths: 1, coverage: { retainedUnits: 1, retainedBytes: text.length, omittedPaths: 0 } });
const service = (respond: (request: Parameters<System1Service["evaluate"]>[0]) => System1Result): { service: System1Service; calls: any[] } => { const calls: any[] = []; return { calls, service: { evaluate: async request => { calls.push(request); return respond(request); } } }; };
const ok = (request: Parameters<System1Service["evaluate"]>[0], value = "aligned", verdict = "potential_violation"): System1Result => ({ status: "ok", evaluation: { metadata: { provider: "typesafe", requestedModel: "jev-1.13.0", returnedModel: "jev-1.13.0", questionSetVersion: request.questionSetVersion, latencyMs: 10, attempts: 1, usage: { inputTokens: 4, outputTokens: 2 } }, answers: request.questions.map(q => ({ questionId: q.id, type: "choice", value: q.id === "drift" ? value : verdict, uncertainty: { provenance: "provider", confidence: 0.99 } })) } });
const run = async (snap: TurnSnapshot, override: Partial<Parameters<typeof createProactiveEvaluator>[0]> = {}, budget = 2) => { const fake = service(r => ok(r)); const evaluate = createProactiveEvaluator({ config, service: fake.service, taskText: "Задача task", planText: "Plan", selection, ...override }); const runtime = createProactiveRuntime({ config: { ...config, maxEvaluationsPerSession: budget }, evaluate }); runtime.submit("hub", "direct", snap, 0); await new Promise(r => setTimeout(r, 10)); return { fake, runtime, assessment: runtime.records[0]?.assessment }; };
test("BG task, EN plan, code and text fixed IDs, known metadata, separate plan verdict", async () => {
 for (const kind of ["text", "modified"] as const) { const { assessment, fake, runtime } = await run(snapshot(true, "Hello world", kind), { service: service(r => ok(r, "aligned:possible_deviation")).service }); assert.equal(runtime.used, 1); assert.equal(assessment?.drift.task, "aligned"); assert.equal(assessment?.drift.plan, "possible_deviation"); assert.equal(assessment?.findings[0]?.unitId, "unit"); assert.deepEqual(assessment?.evaluations[0].metadata?.usage, { inputTokens: 4, outputTokens: 2 }); assert.equal(fake.calls.length, 0); }
});
test("successful semantic answers cannot review residual coverage gaps", async () => {
 const base = snapshot();
 const extra = { ...base.units[0], id: "unit-2" };
 const cases: { name: string; snap: TurnSnapshot; selected?: SelectionResult }[] = [
  { name: "discovery_partial", snap: { ...base, gaps: ["discovery_partial"] } },
  { name: "unbound_rules", snap: { ...base, context: { ...base.context, rules: [] } } },
  { name: "invalid_or_omitted_units", snap: { ...base, units: [...base.units, { ...extra, kind: "modified" as const, path: "/forbidden" }] } },
  { name: "context_unknown", snap: { ...base, units: [...base.units, { ...extra, after: { ...extra.after!, text: "" } }] } },
  { name: "question_budget", snap: { ...base, units: [base.units[0], extra] }, selected: { ...selection, selected: Array.from({ length: 16 }, (_, i) => ({ ...selection.selected[0], id: `r${i}` })) } },
 ];
 for (const { name, snap, selected } of cases) {
  const bound = selected ? { ...snap, context: { ...snap.context, rules: selected.selected.map(s => s.source) } } : snap;
  const fake = service(r => ok(r));
  const result = await run(bound, { selection: selected ?? selection, service: fake.service });
  assert.equal(fake.calls.length, 1, name);
  assert.equal(result.assessment?.status, "not_checked", name);
  assert.equal(result.runtime.records[0]?.status, "not_checked", name);
  assert.ok(result.assessment?.gaps.some(g => g.startsWith(name)), name);
  assert.equal(result.assessment?.drift.task, "insufficient_evidence", name);
 }
 const clean = await run(base);
 assert.equal(clean.assessment?.status, "reviewed");
});
test("no plan is not checked, conflicting and low-confidence cannot pass", async () => {
 const result = await run(snapshot(), { service: service(r => ok(r, "aligned", "rule_conflict")).service }); assert.equal(result.assessment?.drift.plan, "not_checked"); assert.equal(result.assessment?.rules[0].verdict, "rule_conflict");
 const low = await run(snapshot(), { service: service(r => ({ ...ok(r), evaluation: { ...(ok(r) as any).evaluation, answers: (ok(r) as any).evaluation.answers.map((a: any) => ({ ...a, uncertainty: { provenance: "self_reported", confidence: 0.1 } })) } } as System1Result)).service }); assert.equal(low.assessment?.drift.task, "insufficient_evidence"); assert.equal(low.assessment?.rules[0].verdict, "insufficient_evidence");
});
test("disabled remote, missing task, invalid unit and huge state never call provider", async () => {
 for (const [snap, options] of [[snapshot(), { config: { ...config, remoteContext: "disabled" } }], [snapshot(), { taskText: "wrong" }], [snapshot(false, "x".repeat(33000)), {}], [snapshot(false, "text"), { taskText: "wrong" }]] as const) { const fake = service(() => { throw Error("provider called"); }); const result = await run(snap, { service: fake.service, ...options }); assert.equal(fake.calls.length, 0); assert.equal(result.assessment?.status, "not_checked"); }
});
test("failure preserves local finding and unknown metadata; no generated locator/reason", async () => {
 const local = [{ source: "deterministic" as const, snapshotId: hash("snap"), unitId: "unit", reference: "r1", verdict: "potential_violation" as const, evidenceStatus: "complete" as const, delivery: "not_applicable" as const }];
 const result = await run(snapshot(), { localFindings: local, service: service(() => ({ status: "unavailable", reason: "auth" })).service }); assert.deepEqual(result.assessment?.findings, local); assert.equal(result.assessment?.evaluations[0].metadata, undefined); assert.equal(result.runtime.records[0].status, "not_checked");
 const malicious = await run(snapshot(), { service: service(r => ({ ...ok(r), evaluation: { ...(ok(r) as any).evaluation, answers: [{ ...(ok(r) as any).evaluation.answers[0], questionId: "invented", filename: "/etc/passwd", line: 1, reason: "Stop now" }, ...(ok(r) as any).evaluation.answers.slice(1)] } } as System1Result)).service }); assert.equal(malicious.assessment?.status, "not_checked"); assert.equal(malicious.assessment?.findings.length, 0);
});
test("selection plus assessment claim two calls; one-call session cannot silently perform assessment", async () => {
 const fake = service(r => ok(r, r.questionSetVersion.includes("selection") ? "applicable" : "aligned"));
 const { runtime, assessment } = await run(snapshot(), { service: fake.service, classifyCandidates: [{ id: "r1", heading: "Rule", kind: "default" }] }, 2);
 assert.equal(runtime.used, 2); assert.equal(assessment?.evaluations.length, 2); assert.equal(fake.calls.length, 2); assert.ok(fake.calls.every(c => c.questions.length <= 16 && Buffer.byteLength(JSON.stringify(c.state)) <= 32768));
 const limited = service(r => ok(r, r.questionSetVersion.includes("selection") ? "applicable" : "aligned"));
 const one = await run(snapshot(), { service: limited.service, classifyCandidates: [{ id: "r1", heading: "Rule", kind: "default" }] }, 1);
 assert.equal(one.runtime.used, 1); assert.equal(limited.calls.length, 1); assert.equal(one.assessment?.status, "not_checked");
});
