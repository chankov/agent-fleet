import assert from "node:assert/strict";
import test from "node:test";
import { buildWatchdogState } from "./drift-system1.ts";
import { decideSystem1, WATCHDOG_POLICY_VERSION, type AcceptedWatchdogProfile } from "./drift-system1-policy.ts";
import { APPROVED_WATCHDOG_PROFILES } from "./system1-runtime.ts";
import { createDriftRuntime } from "./drift-runtime.ts";
import { createShadowCoordinator } from "./drift-judge.ts";

const profile: AcceptedWatchdogProfile = { policyVersion: WATCHDOG_POLICY_VERSION, stateVersion: "watchdog-state/v1", questionsVersion: "watchdog-questions/v1", provider: "typesafe", model: "jev-1.13.0", rules: ["loop"], minConfidence: 0.8, maxContradiction: 0.1 };
const observation = { events: [], counters: { tool_calls: 1, failures: 0, consecutive_failures: 0, elapsed_ms: 1 }, coverage: { events_seen: 0, dropped_by_window: 0, dropped_incomplete: 0, unparsed_events: 0, missing_tool_end: 0 } };
const state = buildWatchdogState({ task: "task", signal: { rule: "loop", terminal: true }, observation });
const answers = [
 { questionId: "status", type: "choice", value: "on_track", uncertainty: { provenance: "provider", confidence: 0.9, distribution: { on_track: 0.9, drifting: 0.04, stuck: 0.03, insufficient_evidence: 0.03 } } },
 ...["repeating", "outside_task", "trail_carries_instructions"].map(questionId => ({ questionId, type: "predicate", probabilityTrue: 0.01, uncertainty: { provenance: "provider" } })),
];
const ok = { status: "ok", evaluation: { answers, metadata: { provider: "typesafe", requestedModel: "jev-1.13.0", returnedModel: "jev-1.13.0", questionSetVersion: "watchdog-questions/v1", latencyMs: 100, attempts: 1 } } };
const snapshot = { state, rule: "loop", live: true, requestedModel: "jev-1.13.0" };
test("T11 no production profiles; active shortcut requires the exact accepted profile and complete evidence", () => {
 assert.equal(APPROVED_WATCHDOG_PROFILES.length, 0);
 assert.equal(decideSystem1(ok, snapshot, null).action, "llm");
 assert.deepEqual(decideSystem1(ok, snapshot, profile), { action: "continue", reason: "accepted_on_track", source: "system1" });
 for (const candidate of [
  { ...snapshot, live: false }, { ...snapshot, rule: "toolcap" },
  { ...snapshot, state: buildWatchdogState({ task: "task", signal: { rule: "loop" } }) },
 ]) assert.notEqual(decideSystem1(ok, candidate, profile).action, "continue");
 for (const result of [null, { status: "cancelled" }, { status: "unavailable", reason: "timeout" },
  { ...ok, evaluation: { ...ok.evaluation, metadata: { ...ok.evaluation.metadata, returnedModel: "jev-other" } } },
  { ...ok, evaluation: { ...ok.evaluation, answers: [{ ...answers[0], value: "stuck" }, ...answers.slice(1)] } },
  { ...ok, evaluation: { ...ok.evaluation, answers: [{ ...answers[0], uncertainty: { ...answers[0].uncertainty, confidence: 0.7 } }, ...answers.slice(1)] } },
  { ...ok, evaluation: { ...ok.evaluation, answers: [answers[0], { ...answers[1], probabilityTrue: 0.4 }, ...answers.slice(2)] } },
 ]) assert.equal(decideSystem1(result, snapshot, profile).action, "llm");
});
test("T11 uncertain active result falls back to LLM; stale result starts no new judge", async () => {
 let release!: (result: unknown) => void, calls = 0;
 const coordinator = createShadowCoordinator({ armed: true, task: "task", scopeGlobs: [], hubOwnedGlobs: [], session: {
  configuredMode: "active", effectiveMode: "active", approvedProfiles: [profile], requestedModel: "jev-1.13.0", evaluate: () => new Promise(resolve => { release = resolve; }),
 } });
 const drift = createDriftRuntime({ dispatchId: "d", agentKey: "builder", agentLabel: "Builder", task: "task", scopeGlobs: [], hubOwnedGlobs: [], armed: true, ctx: {},
  monitor: { onToolStart: () => null, onToolEnd: () => null, trail: () => [], structuredObservation: () => observation } as any,
  runDriftJudge: async () => { calls++; return { status: "verdict", verdict: "on_track" }; }, launchShadow: coordinator.launch });
 drift.attemptLifecycle.beforePhysicalSpawn({ generation: 1 }); drift.escalate({ rule: "loop", terminal: true, detail: "loop" });
 assert.equal(calls, 0);
 release({ ...ok, evaluation: { ...ok.evaluation, answers: [{ ...answers[0], value: "stuck" }, ...answers.slice(1)] } });
 await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 1);
 drift.dispose();
 let staleJudge = 0, late!: (result: unknown) => void;
 const other = createShadowCoordinator({ armed: true, task: "task", scopeGlobs: [], hubOwnedGlobs: [], session: {
  configuredMode: "active", effectiveMode: "active", approvedProfiles: [profile], requestedModel: "jev-1.13.0", evaluate: () => new Promise(resolve => { late = resolve; }),
 } });
 const child = createDriftRuntime({ dispatchId: "d", agentKey: "builder", agentLabel: "Builder", task: "task", scopeGlobs: [], hubOwnedGlobs: [], armed: true, ctx: {},
  monitor: { onToolStart: () => null, onToolEnd: () => null, trail: () => [], structuredObservation: () => observation } as any,
  runDriftJudge: async () => { staleJudge++; return null; }, launchShadow: other.launch });
 child.attemptLifecycle.beforePhysicalSpawn({ generation: 1 }); child.escalate({ rule: "loop", terminal: true, detail: "loop" });
 child.attemptLifecycle.afterPhysicalSpawn({ generation: 1 }); child.attemptLifecycle.beforePhysicalSpawn({ generation: 2 });
 late({ status: "unavailable", reason: "timeout" }); await new Promise(resolve => setImmediate(resolve));
 assert.equal(staleJudge, 0); child.dispose();
});

test("T11 injected test profile can avoid LLM only for accepted on_track; never terminates", async () => {
 let llm = 0, stops = 0;
 const coordinator = createShadowCoordinator({ armed: true, task: "task", scopeGlobs: [], hubOwnedGlobs: [], session: {
  configuredMode: "active", effectiveMode: "active", approvedProfiles: [profile], requestedModel: "jev-1.13.0", evaluate: async () => ok,
 } });
 const drift = createDriftRuntime({ dispatchId: "d", agentKey: "builder", agentLabel: "Builder", task: "task", scopeGlobs: [], hubOwnedGlobs: [], armed: true, ctx: {},
  monitor: { onToolStart: () => null, onToolEnd: () => null, trail: () => [], structuredObservation: () => observation } as any,
  runDriftJudge: async () => { llm++; return { status: "verdict", verdict: "stuck" }; }, launchShadow: coordinator.launch });
 drift.attemptLifecycle.beforePhysicalSpawn({ generation: 1 }); drift.bindControl({ terminate: () => { stops++; } }); drift.escalate({ rule: "loop", terminal: true, detail: "loop" });
 await new Promise(resolve => setImmediate(resolve));
 assert.equal(llm, 0); assert.equal(stops, 0); assert.equal(drift.attempts[0].checks[0].settled, true);
 drift.outcomeFor({}); drift.dispose();
});
