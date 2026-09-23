import assert from "node:assert/strict";
import test from "node:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateWatchdog, evaluateWatchdogSession, readHumanWatchdogLabels, type HumanWatchdogLabel } from "./watchdog-evaluation.ts";
import type { WatchdogTraceRecord } from "./system1-activity.ts";
import { WATCHDOG_POLICY_VERSION, type AcceptedWatchdogProfile } from "./drift-system1-policy.ts";
const label = (sessionId: string, checkId: string, value: HumanWatchdogLabel["label"], partition: HumanWatchdogLabel["partition"] = "held_out"): HumanWatchdogLabel => ({ sessionId, dispatchId: `d-${sessionId}`, attemptId: "a", checkId, snapshotId: `snap-${checkId}`, llmAttemptId: `llm-${checkId}`, partition, label: value, humanConfirmed: true });
const profile: AcceptedWatchdogProfile = { policyVersion: WATCHDOG_POLICY_VERSION, stateVersion: "watchdog-state/v1", questionsVersion: "watchdog-questions/v1", provider: "typesafe", model: "jev-1.13.0", rules: ["loop"], minConfidence: 0.8, maxContradiction: 0.1 };
const finished = (l: HumanWatchdogLabel): WatchdogTraceRecord => ({ schema: "watchdog-trace/v1", consumer: "watchdog", policyVersion: "none", type: "evaluation_finished", ...l, rule: "loop", sequence: 1, at: 2, status: "ok", statusChoice: "on_track", stateComplete: true, predicatesProvider: true, provider: "typesafe", statusProvenance: "provider", requestedModel: "jev-1.13.0", returnedModel: "jev-1.13.0", numerical: { status_confidence: 0.9, status_on_track: 0.9, status_drifting: 0.04, status_stuck: 0.03, status_insufficient_evidence: 0.03, repeating: 0.01, outside_task: 0.01, trail_carries_instructions: 0.01 } });
const events = (labels: HumanWatchdogLabel[]): WatchdogTraceRecord[] => labels.flatMap(l => [
 { ...finished(l), type: "evaluation_started" as const, stateVersion: "watchdog-state/v1", questionsVersion: "watchdog-questions/v1" },
 { ...finished(l), type: "llm_started" as const, sequence: 2 },
 { ...finished(l), type: "llm_finished" as const, status: "verdict", sequence: 3 },
 { ...finished(l), sequence: 4 },
]);
test("T12 zero candidates and unknown labels never grant G2", () => {
 assert.equal(evaluateWatchdog([], []).eligibility, "not_enough_evidence");
 assert.equal(evaluateWatchdog(events([label("s", "c", "unknown")]), [label("s", "c", "unknown")], profile).sessionFailure.sessions, 0);
});
test("T12 per-session bound, missed drift and held-out leakage are visible", () => {
 const s = label("s", "one", "on_track"), related = label("s", "two", "on_track"), failed = label("f", "three", "stuck");
 const data = evaluateWatchdog(events([s, related, failed]), [s, related, failed], profile);
 assert.equal(data.heldOutCandidates, 3); assert.equal(data.sessionFailure.sessions, 2); assert.equal(data.sessionFailure.failed, 1);
 assert.equal(data.sessionFailure.upper95, null); assert.equal(data.perRule.loop.missed, 1);
 const safe = evaluateWatchdog(events([s, related]), [s, related], profile);
 assert.equal(safe.sessionFailure.sessions, 1); assert.ok(Math.abs(safe.sessionFailure.upper95! - 0.95) < 1e-9);
 assert.equal(safe.activation, "closed_requires_G2");
 const incomplete = label("s", "unknown", "unknown");
 const partial = evaluateWatchdog(events([s, incomplete]), [s, incomplete], profile);
 assert.equal(partial.sessionFailure.sessions, 0, "an unknown shortcut label invalidates a seemingly successful session");
 const leak = evaluateWatchdog(events([s]), [s, label("s", "tuned", "on_track", "tuning")], profile);
 assert.deepEqual(leak.leakageSessions, ["s"]); assert.equal(leak.eligibility, "not_enough_evidence");
});
test("T12 missing labels and duplicate trace or labels cannot make a held-out run eligible", () => {
 const known = label("s", "one", "on_track"), missing = label("s", "two", "on_track");
 const good = events([known]);
 assert.equal(evaluateWatchdog(good, [known], profile).eligibility, "candidate_for_maintainer_review");
 const unlabeled = evaluateWatchdog(events([known, missing]), [known], profile);
 assert.equal(unlabeled.unlabeledCandidates, 1);
 assert.equal(unlabeled.eligibility, "not_enough_evidence");
 const duplicateLabel = evaluateWatchdog(good, [known, { ...known, label: "stuck" }], profile);
 assert.equal(duplicateLabel.duplicateLabels, 1);
 assert.equal(duplicateLabel.eligibility, "not_enough_evidence");
 const duplicateEvent = evaluateWatchdog([...good, good[3]], [known], profile);
 assert.equal(duplicateEvent.duplicateTrace, 1);
 assert.equal(duplicateEvent.eligibility, "not_enough_evidence");
 const missingLlm = evaluateWatchdog(good.filter(e => e.type !== "llm_finished"), [known], profile);
 assert.equal(missingLlm.unpaired, 1);
 assert.equal(missingLlm.eligibility, "not_enough_evidence");
 const duplicateLlm = evaluateWatchdog([...good, good[2]], [known], profile);
 assert.equal(duplicateLlm.duplicateTrace, 1);
 assert.equal(duplicateLlm.eligibility, "not_enough_evidence");
});
test("C6 session evaluation fails closed on partial and invalid trace records", t => {
 const dir = mkdtempSync(join(tmpdir(), "af-g2-trace-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
 const artifact = join(dir, "artifacts", "watchdog"); mkdirSync(artifact, { recursive: true });
 const known = label("s", "one", "on_track");
 const tracePath = join(artifact, "events.jsonl");
 writeFileSync(tracePath, `${events([known]).map(e => JSON.stringify(e)).join("\n")}\n`);
 writeFileSync(join(artifact, "labels.jsonl"), `${JSON.stringify(known)}\n`);
 assert.equal(evaluateWatchdogSession(dir, profile).eligibility, "candidate_for_maintainer_review");
 writeFileSync(join(artifact, "labels.jsonl"), `${JSON.stringify({ ...known, llmAttemptId: undefined })}\n`);
 assert.equal(readHumanWatchdogLabels(dir).length, 0, "old five-ID labels cannot silently match a new check");
 assert.equal(evaluateWatchdogSession(dir, profile).eligibility, "not_enough_evidence");
 writeFileSync(join(artifact, "labels.jsonl"), `${JSON.stringify(known)}\n`);
 appendFileSync(tracePath, "{unfinished secret-sentinel");
 const partial = evaluateWatchdogSession(dir, profile);
 assert.equal(partial.eligibility, "not_enough_evidence");
 assert.equal(partial.diagnostics.observability.partialTail, true);
 appendFileSync(tracePath, "\n");
 const invalid = evaluateWatchdogSession(dir, profile);
 assert.equal(invalid.eligibility, "not_enough_evidence");
 assert.equal(invalid.diagnostics.observability.invalidRecords, 1);
 assert.doesNotMatch(JSON.stringify(invalid), /secret-sentinel/);
});

test("T12 pairing needs identical snapshotId; retries on new snapshots remain unpaired", () => {
 const l = label("s", "c", "on_track"), recorded = events([l]);
 const llm = { ...recorded[2], snapshotId: "retry-snapshot" };
 assert.equal(evaluateWatchdog([recorded[0], recorded[1], recorded[3], llm], [l], profile).unpaired, 1);
 assert.equal(evaluateWatchdog(recorded, [l], profile).matchedPairs, 1);
 assert.equal(evaluateWatchdog([recorded[0], recorded[3], recorded[2]], [l], profile).unpaired, 1, "orphan finish is not a pair");
 assert.equal(evaluateWatchdog([recorded[0], recorded[1], recorded[3], { ...recorded[2], llmAttemptId: "other" }], [l], profile).unpaired, 1, "LLM attempt ids must match");
 const mismatchedLabel = evaluateWatchdog(recorded, [{ ...l, llmAttemptId: "different" }], profile);
 assert.equal(mismatchedLabel.unlabeledCandidates, 1);
 assert.equal(mismatchedLabel.eligibility, "not_enough_evidence", "a human label for another LLM attempt must not be joined by snapshot alone");
 const ambiguous = evaluateWatchdog([...recorded, { ...recorded[1], llmAttemptId: "second", sequence: 5 }], [l], profile);
 assert.equal(ambiguous.ambiguousLlmChecks, 1);
 assert.equal(ambiguous.eligibility, "not_enough_evidence", "two LLM attempts for one snapshot cannot establish a calibrated candidate");
});
