import assert from "node:assert/strict";
import test from "node:test";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWatchdogActivity } from "./system1-activity.ts";
import { buildWatchdogReport, formatWatchdogStatus, readWatchdogEvents, watchdogEvents } from "./system1-report.ts";

const id = { dispatchId: "dispatch-1", attemptId: "attempt-1", checkId: "check-1", snapshotId: "snapshot-1", llmAttemptId: "llm-1" };
test("T10 readback counts checks, evaluations, LLM attempts separately without worker tokens or secrets", t => {
 const dir = mkdtempSync(join(tmpdir(), "af-report-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
 const activity = createWatchdogActivity({ directory: join(dir, "artifacts/watchdog"), sessionId: "session-1" });
 activity.evaluationStarted({ ...id, configuredMode: "shadow", effectiveMode: "shadow" });
 activity.llmStarted(id);
 activity.evaluationFinished({ ...id, status: "unavailable", reason: "timeout", elapsedMs: 11, usage: null });
 activity.llmFinished({ ...id, status: "unavailable" });
 activity.decision({ ...id, source: "llm", outcome: "judge_unavailable", applied: "no" });
 const events = watchdogEvents(dir);
 assert.equal(events.length, 5);
 const report = buildWatchdogReport(events, activity.live());
 assert.equal(report.checks, 1); assert.equal(report.evaluations.started, 1); assert.equal(report.llm.started, 1);
 assert.equal(report.llm.parallel, 1); assert.equal(report.llm.fallback, 0);
 assert.deepEqual(report.evaluations.byStatus, { unavailable: 1 });
 assert.deepEqual(report.usage, { known: 0, unknown: 1, inputTokens: 0, outputTokens: 0 });
 assert.equal(report.latencyMs.p95, 11);
 assert.equal(report.decisions["llm:judge_unavailable:no"], 1);
 assert.doesNotMatch(JSON.stringify(report), /task|secret|raw prompt/);
});
test("C5 malformed line and incomplete tail remain visible without leaking their contents", t => {
 const dir = mkdtempSync(join(tmpdir(), "af-report-corrupt-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
 const activity = createWatchdogActivity({ directory: join(dir, "artifacts/watchdog"), sessionId: "session-1" });
 activity.evaluationStarted(id);
 appendFileSync(activity.path!, "{broken secret-sentinel}\n{unfinished secret-sentinel");
 const trace = readWatchdogEvents(dir);
 assert.equal(trace.events.length, 1);
 assert.deepEqual(trace.integrity, { invalidRecords: 1, partialTail: true, readError: false });
 const report = buildWatchdogReport(trace.events, null, trace.integrity);
 assert.equal(report.observability.degraded, true);
 assert.equal(report.observability.invalidRecords, 1);
 assert.equal(report.observability.partialTail, true);
 assert.doesNotMatch(JSON.stringify(report), /secret-sentinel/);
});

test("T10 incomplete trace and headless/off status never claim successful inference", () => {
 const base = { schema: "watchdog-trace/v1", consumer: "watchdog", sessionId: "session-1", ...id, sequence: 1, at: 1, policyVersion: "none" } as const;
 const report = buildWatchdogReport([{ ...base, type: "evaluation_started" }]);
 assert.equal(report.evaluations.incomplete, 1); assert.equal(report.evaluations.finished, 0);
 assert.equal(report.latencyMs.p50, null);
 assert.equal(report.observability.duplicateEvents, 0);
 const duplicated = buildWatchdogReport([{ ...base, type: "evaluation_started" }, { ...base, type: "evaluation_started", sequence: 2 }]);
 assert.equal(duplicated.observability.duplicateEvents, 1);
 assert.equal(duplicated.observability.degraded, true);
 assert.match(formatWatchdogStatus(null, null), /effective off/);
});
