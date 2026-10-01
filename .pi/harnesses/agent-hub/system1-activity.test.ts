import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createWatchdogActivity, projectWatchdogReadback, readWatchdogTrace, type WatchdogTraceRecord } from "./system1-activity.ts";
import * as activities from "./system1-activity.ts";

const taskIdentity = { taskId: "11111111-1111-4111-8111-111111111111", evaluationId: "22222222-2222-4222-8222-222222222222", inputRevision: "a".repeat(64) };
test("task-triage activity writes sanitized metadata once and leaves unknown counters unknown", () => {
 const lines: string[] = [];
 const activity = activities.createTaskTriageActivity({ sessionId: "PRIVATE_SESSION", write: (line: string) => lines.push(line), now: () => 10 });
 activity.evaluationStarted(taskIdentity, true); activity.evaluationStarted(taskIdentity, true);
 activity.evaluationFinished(taskIdentity, { assessment: { status: "applied", reasons: ["security_change", "PRIVATE_REASON"],
  probabilities: { security_change: .9, wide_change: .1, irreversible_execution: .1, PRIVATE_KEY: 1 }, detail: "PRIVATE_ERROR", task: "PRIVATE_TASK" },
  result: { status: "ok", evaluation: { metadata: { returnedModel: "jev-1.13.0", attempts: 2, latencyMs: 12,
   usage: { inputTokens: 3, outputTokens: 1, secret: "PRIVATE_USAGE" }, rawBody: "PRIVATE_PROVIDER_BODY" } } } } as any);
 activity.evaluationFinished(taskIdentity, { assessment: { status: "no_additions", reasons: [] } });
 assert.equal(lines.length, 2);
 const finished = JSON.parse(lines[1]);
 assert.equal(finished.consumer, "task-triage"); assert.equal(finished.status, "applied");
 assert.equal(finished.providerStatus, "ok"); assert.equal(finished.logicalCall, true); assert.equal(finished.attempts, 2);
 assert.equal(finished.reason, "unknown"); assert.deepEqual(finished.reasons, ["security_change"]);
 assert.deepEqual(finished.usage, { inputTokens: 3, outputTokens: 1 });
 assert.doesNotMatch(lines.join(""), /PRIVATE_/);
 const copy = activity.live(); copy.events[1].reasons.push("PRIVATE_MUTATION");
 assert.doesNotMatch(JSON.stringify(activity.live()), /PRIVATE_MUTATION/);
 activity.dispose(); activity.dispose(); assert.equal(lines.length, 2);
});
test("task-triage activity dispose and writer failure are bounded observational failures", () => {
 const lines: string[] = [];
 const activity = activities.createTaskTriageActivity({ write: (line: string) => { lines.push(line); throw Error("PRIVATE_DISK_ERROR"); } });
 assert.doesNotThrow(() => activity.evaluationStarted(taskIdentity, null));
 activity.dispose(); activity.dispose(); activity.evaluationStarted({ ...taskIdentity, evaluationId: "33333333-3333-4333-8333-333333333333" }, true);
 assert.equal(lines.length, 2); assert.equal(activity.live().degraded, true);
 const finished = JSON.parse(lines[1]); assert.equal(finished.status, "cancelled");
 assert.equal(finished.attempts, null); assert.equal(finished.usage, null); assert.equal(finished.logicalCall, null);
});
test("task-triage disk reader rejects payload-bearing records, incomplete tails and linked files", t => {
 const dir = mkdtempSync(join(tmpdir(), "task-triage-trace-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
 const activity = activities.createTaskTriageActivity({ directory: dir }); activity.evaluationStarted(taskIdentity, false);
 const raw = readFileSync(activity.path!, "utf8");
 appendFileSync(activity.path!, JSON.stringify({ ...JSON.parse(raw), task: "PRIVATE_TASK" }) + "\n");
 appendFileSync(activity.path!, raw.trimEnd());
 const page = activities.readTaskTriageTrace(activity.path!);
 assert.equal(page.events.length, 1); assert.equal(page.invalidRecords, 1); assert.equal(page.partialTail, true);
 assert.doesNotMatch(JSON.stringify(page), /PRIVATE_TASK/);
 const link = join(dir, "link.jsonl"); symlinkSync(activity.path!, link);
 assert.equal(activities.readTaskTriageTrace(link).readError, true);
 const alias = join(dir, "parent-link"); symlinkSync(dir, alias);
 assert.equal(activities.readTaskTriageTrace(join(alias, "task-triage-events.jsonl")).readError, true);
 for (const extra of [{ usage: { inputTokens: 1, outputTokens: 2, raw: "PRIVATE_USAGE" } }, { attempts: -1 },
  { probabilities: { security_change: 2 } }, { taskId: null }]) {
  assert.equal(activities.isTaskTriageTraceRecord({ ...JSON.parse(raw), ...extra }), false);
 }
 assert.equal(readFileSync(activity.path!, "utf8").endsWith("\n"), false, "readback never repairs trace files");
});

test("task-triage observer caps retained spans and sanitizes hostile numeric metadata", () => {
 const activity = activities.createTaskTriageActivity();
 const result = { status: "ok", evaluation: { metadata: { attempts: -1, latencyMs: NaN, returnedModel: "/PRIVATE_MODEL",
  usage: { inputTokens: -2, outputTokens: 3 } } } } as any;
 activity.evaluationStarted(taskIdentity, true);
 activity.evaluationFinished(taskIdentity, { assessment: { status: "unavailable", reasons: [],
  probabilities: { security_change: Infinity, wide_change: -1, irreversible_execution: 2 } }, result });
 const record = activity.live().events[1];
 assert.equal(record.attempts, null); assert.equal(record.latencyMs, null); assert.equal(record.usage, null);
 assert.equal(record.returnedModel, null); assert.equal(record.probabilities, null);
 assert.doesNotMatch(JSON.stringify(record), /PRIVATE_MODEL/);
 for (let index = 0; index < 101; index++) {
  const identity = { ...taskIdentity, evaluationId: `${index.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000` };
  activity.evaluationStarted(identity, false); activity.evaluationFinished(identity, { assessment: { status: "skipped", reasons: [] } });
 }
 assert.equal(activity.live().events.length, 200); assert.equal(activity.degraded, true);
 activity.dispose(); assert.equal(activity.live().events.length, 200);
});
test("task-triage activity retains exact shared-service readiness reasons without free-form errors", () => {
 for (const reason of ["shared_service_disabled", "shared_service_missing_config", "shared_service_missing_key", "shared_service_invalid_config", "shared_service_unavailable"]) {
  const activity = activities.createTaskTriageActivity();
  activity.evaluationStarted(taskIdentity, false);
  activity.evaluationFinished(taskIdentity, { assessment: { status: "unavailable", reasons: [], detail: reason } });
  assert.equal(activity.live().events[1].reason, reason);
 }
});

test("task-triage late result cannot overwrite cancelled or another revision", () => {
 const activity = activities.createTaskTriageActivity();
 activity.evaluationStarted(taskIdentity, true);
 activity.evaluationFinished({ ...taskIdentity, inputRevision: "b".repeat(64) }, { assessment: { status: "applied", reasons: ["security_change"] } });
 assert.equal(activity.live().events.length, 1);
 activity.dispose();
 activity.evaluationFinished(taskIdentity, { assessment: { status: "applied", reasons: ["security_change"] } });
 assert.equal(activity.live().events.length, 2); assert.equal(activity.live().events[1].status, "cancelled");
});

const SECRET = "sk-abcdefghijklmnopqrstuvwxyz";
const ABSOLUTE = "/tmp/watchdog-secret-source";

function event(checkId: string, snapshotId = `snap-${checkId}`) {
	return { dispatchId: "dispatch-1", attemptId: "attempt-1", checkId, snapshotId, llmAttemptId: `llm-${checkId}`, rule: "loop" };
}

test("A11 exactly-once finish, dispose, duplicates and crash readback", () => {
	const lines: string[] = [];
	const activity = createWatchdogActivity({ write: (line) => lines.push(line), now: () => 10 });
	activity.evaluationStarted({ ...event("a"), configuredMode: "shadow", effectiveMode: "shadow", stateVersion: "watchdog-state/v1", questionsVersion: "watchdog-questions/v1" });
	activity.llmStarted(event("a"));
	activity.evaluationStarted(event("a"));
	activity.evaluationFinished({ ...event("a"), status: "ok", elapsedMs: 12, usage: null, returnedModel: null, attempts: null });
	activity.evaluationFinished({ ...event("a"), status: "ok", elapsedMs: 99, unused: true });
	activity.llmFinished({ ...event("a"), status: "verdict", verdict: "on_track" });
	activity.llmFinished({ ...event("a"), status: "verdict", verdict: "stuck" });
	activity.dispose();
	activity.dispose();
	const types = lines.map((line) => JSON.parse(line).type);
	assert.deepEqual(types, ["evaluation_started", "llm_started", "evaluation_finished", "llm_finished"]);
	const finished = JSON.parse(lines[2]);
	assert.equal(finished.usage, null);
	assert.equal(finished.attempts, null);
	assert.equal(finished.returnedModel, null);
	assert.equal(JSON.stringify(lines).includes("0"), true);
	assert.equal(finished.usage === 0, false);

	const open = createWatchdogActivity({ write: (line) => lines.push(line) });
	open.evaluationStarted(event("b"));
	open.llmStarted(event("b"));
	open.dispose();
	const closed = lines.filter((line) => line.includes("\"checkId\":\"b\"")).map((line) => JSON.parse(line));
	assert.equal(closed.filter((item) => item.type === "evaluation_finished").length, 1);
	assert.equal(closed.find((item) => item.type === "evaluation_finished").status, "cancelled");
	assert.equal(closed.find((item) => item.type === "llm_finished").llmAttemptId, "llm-b", "disposal closes the same LLM span, not an anonymous attempt");
	const readback = projectWatchdogReadback([{ schema: "watchdog-trace/v1", type: "evaluation_started", sessionId: "s", dispatchId: "d", attemptId: "a", checkId: "c", snapshotId: "snap", sequence: 1, at: 1, consumer: "watchdog", policyVersion: "none" }]);
	assert.equal(readback[0].evaluation, "interrupted");
	assert.equal(readback[0].status, "unknown");
	assert.notEqual(readback[0].status, "ok");
	assert.equal(readback[0].usage, "unknown");
});

test("C5 complete-looking JSON without newline is not a durable trace event", t => {
 const dir = mkdtempSync(join(tmpdir(), "watchdog-tail-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
 const activity = createWatchdogActivity({ directory: dir, sessionId: "s" });
 activity.evaluationStarted(event("a"));
 const raw = readFileSync(activity.path!, "utf8");
 appendFileSync(activity.path!, raw.trimEnd());
 const partial = readWatchdogTrace(activity.path!);
 assert.equal(partial.events.length, 1);
 assert.equal(partial.partialTail, true);
 appendFileSync(activity.path!, "\n");
 const complete = readWatchdogTrace(activity.path!);
 assert.equal(complete.events.length, 2);
 assert.equal(complete.partialTail, false);
});

test("A12 allowlisted JSONL readback, concurrent checks, write failure and the live cap", () => {
	const dir = mkdtempSync(join(tmpdir(), "watchdog-trace-"));
	try {
		const activity = createWatchdogActivity({ directory: dir, sessionId: "session-a", now: () => 20 });
		activity.evaluationStarted({ ...event("a"), configuredMode: "shadow", effectiveMode: "shadow" });
		activity.evaluationStarted({ ...event("b", "snap-b"), dispatchId: "dispatch-2", attemptId: "attempt-2" });
		activity.evaluationFinished({
			...event("a"),
			status: "ok",
			reason: SECRET,
			elapsedMs: 4,
			returnedModel: "jev-1.13.0",
			attempts: 1,
			usage: { inputTokens: 2, outputTokens: 1 },
			numerical: { status_confidence: 0.5, [SECRET]: 1 },
		});
		assert.equal(activity.live().active.length, 1);
		assert.equal(activity.live().active[0].checkId, "b");
		assert.equal(activity.live().completed.length, 1);
		const text = readFileSync(activity.path!, "utf8");
		assert.equal(text.includes(SECRET), false);
		assert.equal(text.includes(ABSOLUTE), false);
		assert.equal(text.includes(dir), false);
		assert.equal(text.includes("task"), false);
		assert.equal(text.includes("trail"), false);
		const page = readWatchdogTrace(activity.path!, { limit: 2 });
		assert.equal(page.events.length, 2);
		assert.equal(page.nextOffset, 2);
		const projected = projectWatchdogReadback(readWatchdogTrace(activity.path!, { limit: 10 }).events);
		const finished = projected.find((item) => item.checkId === "a");
		assert.equal(finished?.reason, "unknown");
		assert.equal(finished?.usage === "unknown" || (typeof finished?.usage === "object" && finished.usage.inputTokens === 2), true);
		assert.equal(JSON.stringify(projected).includes(SECRET), false);

		const failing = createWatchdogActivity({ write: () => { throw new Error("full"); } });
		assert.doesNotThrow(() => failing.evaluationStarted(event("z")));
		assert.equal(failing.degraded, true);
		assert.equal(failing.live().active.length, 1);

		const capped = createWatchdogActivity({ write: () => undefined });
		for (let index = 0; index < 101; index++) {
			const id = `c${index}`;
			capped.llmStarted(event(id));
			capped.llmFinished({ ...event(id), status: "verdict", verdict: "on_track" });
		}
		assert.equal(capped.live().completed.length, 100);
		assert.equal(capped.live().active.length, 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("late output does not rewrite the finished check or the new check", () => {
	const activity = createWatchdogActivity({ write: () => undefined });
	activity.evaluationStarted(event("old"));
	activity.evaluationStarted({ ...event("new"), dispatchId: "dispatch-2" });
	activity.evaluationFinished({ ...event("old"), status: "cancelled", reason: "cancelled", elapsedMs: 1 });
	activity.evaluationFinished({ ...event("old"), status: "ok", elapsedMs: 5, unused: true });
	const live = activity.live();
	assert.equal(live.completed[0].unused, false);
	assert.equal(live.completed[0].status, "cancelled");
	assert.equal(live.active[0].checkId, "new");
	assert.equal(live.active[0].status, "unknown");
	void (0 as WatchdogTraceRecord | undefined);
});

test("F-11 duplicate terminal events do not rewrite a used record", () => {
	const lines: string[] = [];
	const activity = createWatchdogActivity({ write: (line) => lines.push(line), now: () => 1 });
	activity.evaluationStarted(event("used"));
	activity.llmStarted(event("used"));
	activity.evaluationFinished({
		...event("used"),
		status: "ok",
		reason: "unknown",
		elapsedMs: 4,
		unused: false,
		returnedModel: "jev-1.13.0",
		attempts: 1,
		usage: { inputTokens: 5, outputTokens: 2 },
	});
	activity.evaluationFinished({ ...event("used"), status: "cancelled", reason: "disposed", elapsedMs: 9, unused: true, returnedModel: null, attempts: null, usage: null });
	activity.llmFinished({ ...event("used"), status: "verdict", verdict: "on_track" });
	activity.llmFinished({ ...event("used"), status: "cancelled" });
	activity.decision({ ...event("used"), source: "llm", applied: "no", outcome: "continue" });
	activity.decision({ ...event("used"), source: "llm", applied: "yes", outcome: "drift_stop" });
	const record = activity.live().completed[0];
	assert.equal(record.status, "ok");
	assert.equal(record.unused, false);
	assert.equal(record.returnedModel, "jev-1.13.0");
	assert.deepEqual(record.usage, { inputTokens: 5, outputTokens: 2 });
	assert.equal(record.outcome, "continue");
	assert.equal(record.applied, "no");
	const parsed = lines.map((line) => JSON.parse(line));
	assert.equal(parsed.filter((item) => item.type === "evaluation_finished").length, 1);
	assert.equal(parsed.filter((item) => item.type === "llm_finished").length, 1);
	assert.equal(parsed.filter((item) => item.type === "decision").length, 1);
	assert.equal(parsed.find((item) => item.type === "evaluation_finished").unused, false);
	assert.equal(parsed.find((item) => item.type === "evaluation_finished").status, "ok");
});

test("BLK-1 endDispatch closes only that dispatch; session dispose still closes the rest", () => {
	const lines: string[] = [];
	const activity = createWatchdogActivity({ write: (line) => lines.push(line), now: () => 2 });
	activity.evaluationStarted(event("a"));
	activity.llmStarted(event("a"));
	activity.evaluationStarted({ ...event("b"), dispatchId: "dispatch-B", attemptId: "attempt-B" });
	activity.llmStarted({ ...event("b"), dispatchId: "dispatch-B", attemptId: "attempt-B" });
	activity.endDispatch("dispatch-1");
	const afterA = activity.live();
	assert.equal(afterA.active.length, 1);
	assert.equal(afterA.active[0].dispatchId, "dispatch-B");
	assert.equal(afterA.active[0].evaluation, "evaluating");
	assert.equal(afterA.completed[0].dispatchId, "dispatch-1");
	assert.equal(afterA.completed[0].status, "cancelled");
	assert.equal(afterA.completed[0].reason, "disposed");
	activity.evaluationFinished({
		...event("b"),
		dispatchId: "dispatch-B",
		attemptId: "attempt-B",
		status: "ok",
		elapsedMs: 3,
		returnedModel: "jev-1.13.0",
		attempts: 1,
		usage: { inputTokens: 5, outputTokens: 2 },
		unused: false,
	});
	const finished = activity.live().active[0];
	assert.equal(finished.status, "ok");
	assert.equal(finished.unused, false);
	assert.equal(finished.returnedModel, "jev-1.13.0");
	assert.equal(lines.some((line) => line.includes("dispatch-B") && line.includes("disposed")), false);
	activity.dispose();
	assert.equal(activity.live().active.length, 0);
});

test("A10 proactive jobs and evaluations close once with sanitized metadata and interrupted readback", async () => {
 const { createHash } = await import("node:crypto");
 const { createProactiveActivity, projectProactiveReadback } = await import("./system1-activity.ts");
 const id = (s: string) => createHash("sha256").update(s).digest("hex");
 const lines: string[] = [];
 const activity = createProactiveActivity({ sessionId: "session", write: line => lines.push(line), now: () => 7 });
 const job = id("job"), evaluation = id("eval");
 activity.jobStarted(job); activity.jobStarted(job);
 activity.evaluationStarted(job, evaluation); activity.evaluationStarted(job, evaluation);
 const interrupted = projectProactiveReadback(lines.map(line => JSON.parse(line)));
 assert.equal(interrupted[0].status, "unavailable"); assert.equal(interrupted[0].evaluations[0].status, "unavailable");
 activity.evaluationFinished(job, evaluation, SECRET as "ok"); activity.evaluationFinished(job, evaluation, "ok");
 activity.jobFinished(job, "cancelled"); activity.jobFinished(job, "reviewed"); activity.dispose();
 assert.deepEqual(lines.map(line => JSON.parse(line).type), ["job_started", "evaluation_started", "evaluation_finished", "job_finished"]);
 assert.equal(JSON.stringify(lines).includes(SECRET), false);
 assert.equal(projectProactiveReadback(lines.map(line => JSON.parse(line)))[0].status, "cancelled");
 const abandoned = createProactiveActivity({ write: line => lines.push(line) });
 abandoned.jobStarted(id("abandoned")); abandoned.evaluationStarted(id("abandoned"), id("abandoned-eval")); abandoned.dispose(); abandoned.dispose();
 assert.equal(lines.filter(line => line.includes(id("abandoned")) && line.includes('"job_finished"')).length, 1);
});

test("A10 proactive crash disk readback ignores partial and payload-bearing records", async t => {
 const { createHash } = await import("node:crypto");
 const { createProactiveActivity, readProactiveTrace, projectProactiveReadback } = await import("./system1-activity.ts");
 const dir = mkdtempSync(join(tmpdir(), "p8-trace-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
 const a = createProactiveActivity({ directory: dir }); const id = createHash("sha256").update("job").digest("hex");
 a.jobStarted(id);
 appendFileSync(a.path!, JSON.stringify({ schema: "proactive-review-trace/v1", consumer: "proactive-review", type: "job_finished", sessionId: "00000000-0000-0000-0000-000000000000", jobId: id, sequence: 2, at: 2, status: "reviewed", payload: SECRET }) + "\n");
 appendFileSync(a.path!, JSON.stringify({ type: "job_finished", status: "reviewed" }));
 const page = readProactiveTrace(a.path!);
 assert.equal(page.events.length, 1); assert.equal(page.invalidRecords, 1); assert.equal(page.partialTail, true);
 assert.equal(projectProactiveReadback(page.events)[0].status, "unavailable");
});
