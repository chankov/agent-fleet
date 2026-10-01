import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { buildRuntimeResult } from "./acceptance.ts";
import { buildBudgetContinuationAudit } from "./hub-state-audit.js";
import { buildSessionAudit, formatSessionAudit, showSessionAudit, projectTaskTriageActions } from "./session-audit.ts";
import { registerAudit } from "./commands/audit.ts";
import { createNoProgressGuard } from './no-progress.ts';
import { createTaskTriageActivity } from "./system1-activity.ts";
import { createProcessState, applyProcessClassification, evaluateProcessObligations, processAuditRecord, noteProcessStage } from "./process-obligations.ts";
import { applyTaskTriageAdditions } from "./task-triage-obligations.ts";
import { confirmTaskTriageWaiver, taskTriageActionAuditRecord } from "./task-triage-authorization.ts";

const triageTask = "11111111-1111-4111-8111-111111111111", triageEvaluation = "22222222-2222-4222-8222-222222222222";
function triageRecord(review: string = "waived") {
 return { schema: "agent-fleet.process-obligations/v1", risk: "low", scope: "small", budgetTier: "small", currentStage: "complete",
  obligations: { risk: { status: "satisfied" }, acceptance: { status: "satisfied" }, plan: { status: "satisfied" }, review: { status: review }, confirmation: { status: "open" } },
  additions: [{ id: "b".repeat(64), taskId: triageTask, evaluationId: triageEvaluation, inputRevision: "a".repeat(64), reason: "security_change", status: "waived", waiverReason: "PRIVATE_REASON" }],
  auditScope: ["PRIVATE_PATH"], explanation: "PRIVATE_EXPLANATION", state: { lastReason: "PRIVATE_TASK" } };
}
test("task-triage audit exposes persisted waived additions and per-effect confirmation separately", t => {
 const sessionDir = fixture(t);
 const audit = buildSessionAudit({ entries: [{ customType: "agent-hub-process-state", data: triageRecord() }], sessionDir });
 const event = audit.events.find(e => e.kind === "process_obligation")!;
 assert.equal(event.obligations!.review, "waived"); assert.equal(event.obligations!.confirmation, "open");
 assert.equal(event.status, "accepted", "process completion permits task-level closure, not future effects or semantic A1 acceptance");
 const view = (audit as any).taskTriage;
 assert.equal(view.process.additions[0].status, "waived"); assert.equal(view.taskAcceptance, "not_recorded");
 assert.equal(view.assessment.status, "unknown", "a process addition does not reconstruct a missing classifier result");
 assert.equal(view.process.completion, "process_complete"); assert.ok(view.process.blockers.includes("action_confirmation"));
 assert.doesNotMatch(formatSessionAudit(audit), /PRIVATE_/);
});
test("task-triage audit reads metadata trace without turning provider success into acceptance", t => {
 const sessionDir = fixture(t);
 const activity = createTaskTriageActivity({ directory: join(sessionDir, "artifacts/task-triage-activity") });
 const identity = { taskId: triageTask, evaluationId: triageEvaluation, inputRevision: "a".repeat(64) };
 activity.evaluationStarted(identity, true);
 activity.evaluationFinished(identity, { assessment: { status: "applied", reasons: ["security_change"] } });
 const audit = buildSessionAudit({ entries: [], sessionDir });
 assert.equal((audit as any).taskTriage.metrics.assessments.finished, 1);
 assert.equal((audit as any).taskTriage.process.availability, "unavailable");
 assert.equal((audit as any).taskTriage.taskAcceptance, "not_recorded");
 appendFileSync(activity.path!, "{PRIVATE_TAIL");
 const corrupt = buildSessionAudit({ entries: [], sessionDir });
 assert.ok(corrupt.unavailable.includes("task_triage_trace_integrity"));
 assert.doesNotMatch(formatSessionAudit(corrupt), /PRIVATE_/);
});
test("task-triage audit latest malformed process state cannot fall back to an older complete state", t => {
 const sessionDir = fixture(t);
 const entries = [{ customType: "agent-hub-process-state", data: triageRecord() },
  { customType: "agent-hub-process-state", data: { ...triageRecord(), additions: [{ id: "PRIVATE_ID", status: "waived" }] } }];
 const audit = buildSessionAudit({ entries, sessionDir });
 assert.equal((audit as any).taskTriage.process.availability, "unavailable");
 assert.ok(audit.unavailable.includes("task_triage_process_integrity"));
 assert.doesNotMatch(formatSessionAudit(audit), /PRIVATE_/);
});

test("task-triage audit projects actual process/authorized-waiver producer without free-form reason leakage", async t => {
 const sessionDir = fixture(t), inputRevision = "a".repeat(64), entries: unknown[] = [];
 const classification = applyProcessClassification(createProcessState(), { risk: "low", scope: "small", reason: "PRIVATE_CLASSIFICATION" });
 assert.equal(classification.ok, true);
 let state = applyTaskTriageAdditions(classification.state, { status: "applied", reasons: ["security_change"] },
  { taskId: triageTask, evaluationId: triageEvaluation, inputRevision });
 state = noteProcessStage(state, "acceptance", { evidenceRef: "/PRIVATE_EVIDENCE", revision: "PRIVATE_REVISION" });
 const emit = () => entries.push({ customType: "agent-hub-process-state", data: processAuditRecord(state, evaluateProcessObligations(state, { writable: true, budgetTier: "small" })) });
 emit();
 const before = buildSessionAudit({ sessionDir, entries, taskTriage: { taskId: triageTask, inputRevision } } as any);
 assert.equal((before as any).taskTriage.process.obligations.review, "open");
 const next = await confirmTaskTriageWaiver(state, { taskId: triageTask, evaluationId: triageEvaluation, inputRevision, additionId: state.additions![0].id, reason: "PRIVATE_WAIVER_REASON" }, {
  taskId: () => triageTask, inputRevision: () => inputRevision, startWait() {}, endWait() {}, persist: value => { state = value; emit(); },
  ask: async (id, question) => ({ details: { runtimeAsk: { requestId: id }, response: { kind: "selection", selections: [question.options[0]] } } }),
 }, {} as any);
 assert.ok(next);
 const after = buildSessionAudit({ sessionDir, entries, taskTriage: { taskId: triageTask, inputRevision } } as any);
 assert.equal((after as any).taskTriage.process.obligations.review, "waived");
 assert.equal((after as any).taskTriage.process.additions[0].binding, "current");
 assert.equal((after as any).taskTriage.process.completion, "process_complete");
 assert.equal((after as any).taskTriage.taskAcceptance, "not_recorded");
 assert.doesNotMatch(formatSessionAudit(after), /PRIVATE_/);
});

test("task-triage audit preserves source waiver history while baseline review remains open", t => {
 const sessionDir = fixture(t);
 const common = { ...triageRecord("open"), risk: "high", currentStage: "review" };
 const active = { ...common, additions: common.additions.map(a => ({ ...a, status: "active" })) };
 const audit = buildSessionAudit({ sessionDir, entries: [
  { customType: "agent-hub-process-state", data: active }, { customType: "agent-hub-process-state", data: common },
 ] });
 const events = audit.events.filter(e => e.kind === "process_obligation");
 assert.equal(events.length, 2, "distinct source states must not collapse into one repeated review-open event");
 assert.equal((events[0] as any).processAdditions[0].status, "active");
 assert.equal((events[1] as any).processAdditions[0].status, "waived");
 assert.equal(audit.taskTriage.process.obligations!.review, "open");
 assert.equal(audit.taskTriage.process.completion, "not_complete");
 assert.doesNotMatch(formatSessionAudit(audit), /PRIVATE_/);
});

test("task-triage audit exposes live observer degradation even when no trace file was written", t => {
 const sessionDir = fixture(t), activity = createTaskTriageActivity({ write() { throw Error("PRIVATE_DISK_ERROR"); } });
 const identity = { taskId: triageTask, evaluationId: triageEvaluation, inputRevision: "a".repeat(64) };
 activity.evaluationStarted(identity, true);
 activity.evaluationFinished(identity, { assessment: { status: "unavailable", reasons: [], detail: "timeout" } });
 const audit = buildSessionAudit({ sessionDir, entries: [], taskTriage: { taskId: triageTask, inputRevision: identity.inputRevision, activity: activity.live() } } as any);
 assert.equal(audit.taskTriage.metrics.assessments.finished, 1);
 assert.equal(audit.taskTriage.metrics.observability.degraded, true);
 assert.ok(audit.unavailable.includes("task_triage_trace_integrity"));
 assert.doesNotMatch(formatSessionAudit(audit), /PRIVATE_DISK_ERROR/);
});

test("action audit joins durable grant, one-use consumption and tool result without implying acceptance", t => {
 const sessionDir = fixture(t);
 const contract = { taskId: triageTask, inputRevision: "a".repeat(64), actionId: "PRIVATE_CALL_ID", operation: "write", target: "/PRIVATE_TARGET", nonce: "PRIVATE_NONCE" };
 const grant = { customType: "agent-hub-task-triage-action-grant", data: contract };
 const consumed = { customType: "agent-hub-task-triage-action-consumed", data: contract };
 const result = { type: "message", message: { role: "toolResult", toolCallId: contract.actionId, toolName: "write", isError: false, content: [{ type: "text", text: "PRIVATE_OUTPUT" }] } };
 const entries = [grant, consumed, result, { ...result, message: { ...result.message, toolCallId: "UNRELATED_CALL" } }];
 const audit = buildSessionAudit({ sessionDir, entries, taskTriage: { taskId: triageTask, inputRevision: contract.inputRevision } });
 const history = (audit.taskTriage as any).actions;
 assert.equal(history.availability, "recorded"); assert.equal(history.records.length, 1);
 assert.equal(history.records[0].authorization, "recorded_grant"); assert.equal(history.records[0].consumption, "recorded_once");
 assert.equal(history.records[0].execution, "tool_result_ok"); assert.equal(history.records[0].binding, "current");
 assert.equal(audit.taskTriage.taskAcceptance, "not_recorded");
 assert.doesNotMatch(formatSessionAudit(audit), /PRIVATE_|UNRELATED_CALL/);
 const reopened = buildSessionAudit({ sessionDir, entries });
 assert.equal((reopened.taskTriage as any).actions.records[0].binding, "unbound");
});
test("action audit preserves missing results, duplicates, conflicting bindings and unsupported calls as unknown", t => {
 const sessionDir = fixture(t), base = { taskId: triageTask, inputRevision: "a".repeat(64), actionId: "PRIVATE_CALL", operation: "write", target: "a".repeat(64) };
 const grant = { customType: "agent-hub-task-triage-action-grant", data: base }, consume = { customType: "agent-hub-task-triage-action-consumed", data: base };
 for (const [entries, expected] of [ [[grant], "not_recorded"], [[grant, consume], "recorded_once"], [[grant, consume, consume], "ambiguous"],
  [[consume], "ambiguous"], [[grant, { ...consume, data: { ...base, target: "b".repeat(64) } }], "ambiguous"] ] as const) {
  const audit = buildSessionAudit({ sessionDir, entries }); const history = (audit.taskTriage as any).actions;
  assert.equal(history.records[0].consumption, expected); assert.equal(history.records[0].execution, "not_recorded");
  assert.doesNotMatch(formatSessionAudit(audit), /PRIVATE_CALL/);
 }
 const malformed = buildSessionAudit({ sessionDir, entries: [{ ...grant, data: { ...base, taskId: "PRIVATE_ID" } }] });
 assert.equal((malformed.taskTriage as any).actions.invalidRecords, 1);
 assert.ok(malformed.unavailable.includes("task_triage_action_integrity"));
});

test("action audit rejects contradictory consumption and hostile observation extras", t => {
 const sessionDir = fixture(t), contract = { taskId: triageTask, inputRevision: "a".repeat(64), actionId: "PRIVATE_CALL", operation: "write", target: "a".repeat(64) };
 const grant = { customType: "agent-hub-task-triage-action-grant", data: contract }, consumed = { customType: "agent-hub-task-triage-action-consumed", data: contract };
 const failed = { customType: "agent-hub-task-triage-action-observation", data: taskTriageActionAuditRecord(contract, "consumption_failed") };
 for (const entries of [[grant, consumed, failed], [grant, failed, consumed]]) {
  const history = buildSessionAudit({ sessionDir, entries }).taskTriage.actions;
  assert.equal(history.ambiguous, 1); assert.equal(history.records[0].execution, "not_recorded");
 }
 const result = { type: "message", message: { role: "toolResult", toolCallId: contract.actionId, toolName: "write", isError: true, content: "PRIVATE_ERROR" } };
 const error = buildSessionAudit({ sessionDir, entries: [grant, consumed, result] }).taskTriage.actions;
 assert.equal(error.records[0].execution, "tool_result_error");
 const duplicate = buildSessionAudit({ sessionDir, entries: [grant, consumed, result, result] }).taskTriage.actions;
 assert.equal(duplicate.records[0].execution, "not_recorded"); assert.equal(duplicate.ambiguous, 1);
 const hostile = { customType: failed.customType, data: { ...failed.data, rawBody: "PRIVATE_BODY" } };
 const invalid = buildSessionAudit({ sessionDir, entries: [hostile] });
 assert.equal(invalid.taskTriage.actions.invalidRecords, 1); assert.doesNotMatch(formatSessionAudit(invalid), /PRIVATE_/);
});

test("action audit caps retained records, preserves stale bindings and never treats early results as execution", () => {
 const base = { taskId: triageTask, inputRevision: "a".repeat(64), actionId: "one", operation: "write", target: "a".repeat(64) };
 const grant = { customType: "agent-hub-task-triage-action-grant", data: base }, consumed = { customType: "agent-hub-task-triage-action-consumed", data: base };
 const result = { message: { role: "toolResult", toolCallId: "one", toolName: "write", isError: false } };
 const early = projectTaskTriageActions([grant, result, consumed], { taskId: triageTask, inputRevision: "b".repeat(64) });
 assert.equal(early.records[0].execution, "not_recorded"); assert.equal(early.records[0].binding, "stale");
 const capped = projectTaskTriageActions(Array.from({ length: 301 }, (_, i) => ({ ...grant, data: { ...base, actionId: `call-${i}` } })));
 assert.equal(capped.records.length, 300); assert.equal(capped.overflow, true);
 assert.doesNotMatch(JSON.stringify(capped), /call-/);
});

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

test('recover ledger audit survives compaction, retains immutable failure and redacts original contract, nonce, revision and paths', t => {
 const sessionDir=fixture(t), entries:any[]=[];
 const guard=createNoProgressGuard((type,data)=>entries.push({customType:type,data}));
 const ticket=guard.begin('private contract','before','builder');
 guard.recordInvocation(ticket.operationId!,'private contract',{tool:'dispatch_agent',params:{agent:'builder',task:'password=hunter2 secret task'}});
 guard.finish(ticket,'before',{dispatchId:'original-fail',reason:'secret failure',category:'indeterminate'});
 guard.settle(ticket.operationId!,ticket.attemptId!,'runtime-exit:original-fail:1');
 guard.authorizeIndeterminate(ticket.operationId!,ticket.attemptId!,'secret-nonce');
 guard.assess(ticket.operationId!,ticket.attemptId!,'private-revision','cleared','/private/evidence');
 guard.compact(entries);
 const restored=createNoProgressGuard(); restored.restore([entries.at(-1)]);
 assert.equal(restored.inspect(ticket.operationId!)?.attempts[0].category,'indeterminate');
 const audit=buildSessionAudit({entries:[entries.at(-1)],sessionDir});
 const events=audit.events.filter(event=>event.kind==='recovery');
 assert.deepEqual(events.map(event=>event.status),['open','failed','settled','authorized_once','cleared']);
 assert.equal(events.at(-1)?.technicalBlock,'cleared');
 const rendered=formatSessionAudit(audit);
 for(const secret of ['hunter2','secret-nonce','private-revision','/private/evidence','private contract','secret failure']) assert.doesNotMatch(rendered,new RegExp(secret));
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

test('audit refuses malformed or conflicting recovery snapshots without erasing failures into a clean history', t => {
 const sessionDir = fixture(t), entries: any[] = [];
 const guard = createNoProgressGuard((type, data) => entries.push({ customType: type, data }));
 const first = guard.begin('contract', 'same', 'builder');
 guard.finish(first, 'same', { dispatchId: 'ind-1', reason: 'failed', category: 'indeterminate' });
 guard.settle(first.operationId!, first.attemptId!, 'runtime-exit');
 guard.authorizeIndeterminate(first.operationId!, first.attemptId!, 'nonce-1');
 const malformed = { customType: 'agent-hub-recover-event', data: { kind: 'snapshot' } };
 const conflicting = { customType: 'agent-hub-recover-event', data: { kind: 'snapshot', rows: entries.slice(0, -1).map(row => row.data) } };
 for (const snapshot of [malformed, conflicting]) {
  const audit = buildSessionAudit({ entries: [...entries, snapshot], sessionDir });
  assert.ok(audit.unavailable.includes('recovery_history_integrity'));
  assert.equal(audit.events.filter(event => event.kind === 'recovery').length, 0);
 }
 guard.compact(entries);
 const intact = buildSessionAudit({ entries: [entries.at(-1)], sessionDir });
 assert.equal(intact.unavailable.includes('recovery_history_integrity'), false);
 assert.ok(intact.events.some(event => event.kind === 'recovery' && event.category === 'indeterminate' && event.status === 'failed'));
});

test("P12 audit includes separate proactive readonly aggregate, not evidence payload", t => {
 const sessionDir=fixture(t);
 const proactive:any={records:[{turnId:"p1",owner:"SECRET_PAYLOAD",attempt:"a",status:"not_checked",paths:["SECRET_PAYLOAD"],uncheckedPaths:[]}],history:[],current:[],activity:[]};
 const audit=buildSessionAudit({entries:[],sessionDir,proactive});
 assert.equal(audit.proactive.consumer,"proactive-review");assert.equal(audit.proactive.readOnly,true);assert.equal(audit.proactive.turns.reviewed,0);assert.equal(audit.proactive.turns.partial,1);
 assert.doesNotMatch(JSON.stringify(audit.proactive),/SECRET_PAYLOAD/);
 const reopened=buildSessionAudit({entries:[],sessionDir});assert.equal(reopened.proactive.availability,"unavailable");assert.equal(reopened.proactive.turns.reviewed,null);
});
