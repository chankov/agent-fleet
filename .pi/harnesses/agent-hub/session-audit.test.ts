import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { buildRuntimeResult } from "./acceptance.ts";
import { buildBudgetContinuationAudit } from "./hub-state-audit.js";
import { buildSessionAudit, formatSessionAudit, showSessionAudit } from "./session-audit.ts";
import { registerAudit } from "./commands/audit.ts";

function fixture(t: any) {
	const dir = mkdtempSync(join(tmpdir(), "af-audit-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
	writeFileSync(join(dir, "session.json"), JSON.stringify({ sessionId: "root-1", cwd: "/private/repo", env: { API_KEY: "secret" } }));
	mkdirSync(join(dir, "dispatches", "child-1"), { recursive: true });
	writeFileSync(join(dir, "dispatches", "child-1", "result.json"), JSON.stringify({ dispatchId: "child-1", sessionPath: "/private/sessions/child-session.jsonl", output: "raw prompt and sk-secret-value", fullOutput: "private model text" }));
	return dir;
}

function runtimeDetails() {
	return {
		status: "verification_failed", recoveryCategory: "verification_failed",
		runtimeResult: buildRuntimeResult({
			task: { id: "task-1", current: true, beforeRevision: "before", afterRevision: "after" },
			execution: { status: "completed", exitCode: 0, dispatchId: "child-1" },
			changes: { status: "changed", paths: ["private/file"], attribution: "certain" }, requirements: [], deliverables: [], checks: [], evidenceRefs: ["/private/evidence"],
		}),
		fullOutput: "password=hunter2 raw private response",
	};
}

test("T9 audit derives T1/T2/T8 events, separates identities, and collapses snapshot repeats", (t) => {
	const sessionDir = fixture(t), details = runtimeDetails();
	const budget = buildBudgetContinuationAudit({ correlation: { taskId: "task-1", tranche: 1, requestId: "question-1", operation: "dispatch" }, continuation: 1, secret: "do-not-copy" });
	const entries = [
		{ type: "custom", customType: "agent-hub-budget-continuation", data: budget },
		{ type: "custom", customType: "agent-hub-retry-authorized", data: { dispatchId: "child-1", correlation: { taskId: "task-1", requestId: "question-2", operation: "retry" }, rawAnswer: "private" } },
		{ type: "message", id: "tool-result-1", message: { role: "toolResult", details } },
		{ type: "message", id: "tool-result-1", message: { role: "toolResult", details } },
		{ type: "compaction", id: "snapshot-1", summary: "private prompt snapshot" },
	];
	const audit = buildSessionAudit({ entries, sessionDir });
	assert.equal(audit.identity.rootSessionId, "root-1");
	assert.deepEqual(audit.identity.children, [{ dispatchId: "child-1", sessionId: "child-session" }]);
	assert.deepEqual(audit.identity.snapshots, [{ snapshotId: "snapshot-1" }]);
	assert.equal(audit.events.find(event => event.kind === "verification")?.status, "missing");
	assert.equal(audit.events.find(event => event.kind === "verification")?.repeatCount, 2, "snapshot/replay copies do not inflate incidence");
	assert.equal(audit.events.find(event => event.kind === "refusal")?.category, "verification_failed");
	assert.equal(audit.events.find(event => event.kind === "budget_permission")?.requestId, "question-1");
	assert.equal(audit.events.find(event => event.kind === "retry_permission")?.requestId, "question-2");
});

test("T9 audit exports only allowlisted metadata and marks absent evidence unavailable", (t) => {
	const sessionDir = fixture(t);
	rmSync(join(sessionDir, "dispatches", "child-1", "result.json"));
	const audit = buildSessionAudit({ entries: [
		{ type: "message", message: { role: "toolResult", details: { status: "raw secret status", runtimeResult: { schema: "wrong", prompt: "SECRET" } } } },
		{ type: "custom", customType: "agent-hub-budget-continuation", data: { correlation: { task_id: "task-1", request_id: "sk-abcdefghijklmnop", operation: "dispatch" } } },
	], sessionDir });
	const exported = formatSessionAudit(audit);
	assert.match(exported, /child_result:child-1/);
	for (const secret of ["sk-secret-value", "sk-abcdefghijklmnop", "hunter2", "raw prompt", "private model", "SECRET", "\/private\/repo"]) assert.doesNotMatch(exported, new RegExp(secret));
});

test("T11 audit explains process obligations and budget-tier independence without copying reasons", (t) => {
 const sessionDir = fixture(t);
 const entries = [{ type: "custom", customType: "agent-hub-process-state", data: {
  schema: "agent-fleet.process-obligations/v1", risk: "high", scope: "small", budgetTier: "trivial",
  obligations: { risk: { status: "satisfied" }, acceptance: { status: "satisfied" }, review: { status: "open" }, plan: { status: "unsupported" } },
  appliedRuleIds: ["risk-high-independent-review"], currentStage: "review", admissibleNextAction: "dispatch an independent reviewer", auditScope: ["src/auth.ts"],
  explanation: "high risk requires independent review while budget tier trivial only limits spend",
  state: { lastReason: "secret customer context" },
 } }];
 const audit = buildSessionAudit({ entries, sessionDir });
 const process = audit.events.find(event => event.kind === "process_obligation") as any;
 assert.equal(process.risk, "high"); assert.equal(process.scope, "small"); assert.equal(process.budgetTier, "trivial");
 assert.equal(process.currentStage, "review"); assert.deepEqual(process.appliedRuleIds, ["risk-high-independent-review"]); assert.deepEqual(process.auditScope, ["src/auth.ts"]);
 assert.deepEqual(process.obligations, { risk: "satisfied", acceptance: "satisfied", review: "open", plan: "unsupported" });
 assert.match(process.explanation, /budget tier trivial/); assert.doesNotMatch(formatSessionAudit(audit), /secret customer context/);
});

test("T10 /af-audit shows unavailable judge and interrupted trace without payload", (t) => {
 const sessionDir = fixture(t);
 const dir = join(sessionDir, "artifacts", "watchdog"); mkdirSync(dir, { recursive: true });
 writeFileSync(join(dir, "events.jsonl"), [
  { schema: "watchdog-trace/v1", type: "llm_started", sessionId: "s", dispatchId: "child-1", attemptId: "a", checkId: "c", snapshotId: "snap", sequence: 1, at: 1, consumer: "watchdog", policyVersion: "none", prompt: "secret payload" },
  { schema: "watchdog-trace/v1", type: "llm_finished", sessionId: "s", dispatchId: "child-1", attemptId: "a", checkId: "c", snapshotId: "snap", sequence: 2, at: 2, consumer: "watchdog", policyVersion: "none", status: "unavailable" },
  { schema: "watchdog-trace/v1", type: "decision", sessionId: "s", dispatchId: "child-1", attemptId: "a", checkId: "c", snapshotId: "snap", sequence: 3, at: 3, consumer: "watchdog", policyVersion: "none", source: "llm", outcome: "judge_unavailable", applied: "no" },
 ].map(x => JSON.stringify(x)).join("\n") + "\n");
 const audit = formatSessionAudit(buildSessionAudit({ sessionDir, entries: [] }));
 assert.match(audit, /judge_unavailable/); assert.doesNotMatch(audit, /secret payload/);
 appendFileSync(join(dir, "events.jsonl"), "{unfinished secret sentinel");
 const truncated = formatSessionAudit(buildSessionAudit({ sessionDir, entries: [] }));
 assert.match(truncated, /watchdog_trace_integrity/);
 assert.doesNotMatch(truncated, /secret sentinel/);
});

test("actual /af-audit registration executes against runtime producer records without tool/model execution", async (t) => {
	const sessionDir = fixture(t), details = runtimeDetails(), notices: string[] = [];
	let registration: any;
	registerAudit({ registerCommand: (name: string, spec: any) => { registration = { name, spec }; } } as any, {
		handleAudit: async (ctx: any) => showSessionAudit(ctx, sessionDir),
	} as any);
	const ctx = { sessionManager: { getEntries: () => [{ type: "message", message: { role: "toolResult", details } }] }, ui: { notify: (message: string) => notices.push(message) } };
	assert.equal(registration.name, "af-audit");
	await registration.spec.handler("ignored", ctx);
	const audit = JSON.parse(notices[0]);
	assert.equal(audit.events[0].kind, "verification");
	assert.equal(audit.events[0].childDispatchId, "child-1");
	assert.equal(audit.readOnly, true);
});
