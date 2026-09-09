import { createNoProgressGuard } from "../no-progress.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { createDispatchExecutor, createResearchExecutor, prepareDispatch } from "./dispatch-execution.ts";

function prepareDeps(overrides: { agents?: string[]; research?: string[]; turn?: number } = {}) {
	let turn = overrides.turn ?? 0;
	let task = 0;
	const agents = new Map((overrides.agents ?? ["builder"]).map(name => [name.toLowerCase(), { def: { name, tools: "read" }, runCount: 0, contextPct: 0 }]));
	const turnReport = { refusals: 0, dispatches: [] as unknown[], research: 0, tier: "small" };
	const sessionTotals = { refusals: 0, dispatches: 0, research: 0, billed: 0, out: 0 };
	return {
		noProgress: createNoProgressGuard(),
		state: {
			getTurnDispatchCount: () => turn,
			setTurnDispatchCount: (v: number) => { turn = v; },
			getTurnResearchCount: () => 0,
			setTurnResearchCount() {},
			getTaskDispatchCount: () => task,
			setTaskDispatchCount: (v: number) => { task = v; },
			getTaskResearchCount: () => 0,
			setTaskResearchCount() {},
			getTaskReviewRounds: () => 0,
			setTaskReviewRounds() {},
			getTaskTier: () => "small",
			getTurnReport: () => turnReport,
			getSessionTotals: () => sessionTotals,
			getTurnDispatchFingerprints: () => new Set<string>(),
			getExternalBlockers: () => [],
			getExternalBlockerAcknowledged: () => false,
			setExternalBlockerAcknowledged() {},
			getExternalBlockerRefusedOnce: () => false,
			setExternalBlockerRefusedOnce() {},
			isAskUserAvailable: () => true,
			getUserLanguage: () => "English",
			getSessionDir: () => "/tmp",
			getAgentStates: () => agents,
			getResearchPersonas: () => (overrides.research ?? ["researcher", "deep-researcher"]).map(name => ({ name })),
			getActiveWritableDispatches: () => 0,
			setActiveWritableDispatches() {},
			getWritableOverlapCounter: () => 0,
			setWritableOverlapCounter() {},
		},
		budget: {
			ensureTaskTier() {},
			taskCounters: () => ({ dispatches: task, research: 0, reviewRounds: 0 }),
			currentTaskBudget: () => ({ maxDispatches: 8, maxResearch: 8, maxReviewRounds: 4 }),
			taskActiveElapsedMs: () => 0,
			currentBudget: () => ({ maxDispatches: 2, maxResearch: 2 }),
			turnBudgetActiveElapsedMs: () => 0,
			updateModeStatus() {},
		},
		artifacts: {
			writeRunArtifact: () => "/tmp/tool-result.md",
			loadInputArtifacts: () => [],
		},
		research: {},
		budgetRecovery: { ensure: async () => null },
		provisionalCapabilityRefusal: () => null,
		dispatchAgent: async () => ({ output: "", exitCode: 0, elapsed: 0 }),
		runReturnExtraction: async () => null,
		extractNeedsResearch: () => [],
		extractAskUserQuestions: () => [],
		contextPressure: () => false,
		displayName: (n: string) => n,
		_turn: () => turn,
		_task: () => task,
		_report: turnReport,
	};
}

test("unknown agent does not increment dispatch budget and lists available agents", () => {
	const d = prepareDeps({ agents: ["builder"] });
	const result = prepareDispatch(d as any, { agent: "not-a-real-agent", task: "do work" } as any, {} as any);
	assert.equal("agent" in result && !("content" in result), false);
	assert.equal((result as any).details.status, "unknown_agent");
	assert.match((result as any).content[0].text, /Available agents: builder/);
	assert.match((result as any).content[0].text, /Do not invent a substitute dispatch/);
	assert.equal(d._turn(), 0);
	assert.equal(d._task(), 0);
});

test("dispatch_agent researcher redirects to spawn_research without consuming budget", () => {
	const d = prepareDeps({ agents: ["builder"], research: ["researcher", "deep-researcher"] });
	const result = prepareDispatch(d as any, { agent: "researcher", task: "look around" } as any, {} as any);
	assert.equal((result as any).details.status, "research_persona_via_dispatch");
	assert.match((result as any).content[0].text, /spawn_research/);
	assert.match((result as any).content[0].text, /Available agents: builder/);
	assert.equal(d._turn(), 0);
	assert.equal(d._task(), 0);
});

test("dispatch_agent deep-researcher redirects to spawn_research without consuming budget", () => {
	const d = prepareDeps({ agents: ["builder"] });
	const result = prepareDispatch(d as any, { agent: "deep-researcher", task: "trace paths" } as any, {} as any);
	assert.equal((result as any).details.status, "research_persona_via_dispatch");
	assert.match((result as any).content[0].text, /spawn_research/);
	assert.match((result as any).content[0].text, /persona "deep-researcher"/);
	assert.equal(d._turn(), 0);
});

test("known roster agent still increments after validation", () => {
	const d = prepareDeps({ agents: ["builder"] });
	const result = prepareDispatch(d as any, { agent: "builder", task: "implement the guard" } as any, {} as any);
	assert.equal((result as any).agent, "builder");
	assert.equal(d._turn(), 1);
	assert.equal(d._task(), 1);
});

for (const operation of ["dispatch", "research"] as const) {
	test(`${operation} requests runtime budget confirmation before refusing instead of relying on model prose`, async () => {
		const d = prepareDeps({ turn: 2 });
		let asks = 0, runs = 0;
		d.budgetRecovery.ensure = async () => { asks++; d.state.setTurnDispatchCount(0); return null; };
		d.dispatchAgent = async () => { runs++; return { output: "Completed execution.", exitCode: 0, elapsed: 1 }; };
		(d.research as any).anonymousDef = () => ({ name: "researcher" });
		(d.research as any).resolveModel = () => "test/model";
		(d.research as any).createState = () => ({ id: 1 });
		(d.research as any).spawn = d.dispatchAgent;
		(d.artifacts as any).writeRunArtifact = () => "/tmp/result.md";
		const execute = operation === "dispatch" ? createDispatchExecutor(d as any) : createResearchExecutor(d as any);
		const result = await execute("call", { agent: "builder", task: "bounded work" }, undefined, undefined, { cwd: "/tmp" } as any);
		assert.equal(asks, 1, "runtime must own confirmation even when the model never invokes ask_user");
		assert.equal(runs, 1);
		assert.equal((result.details as any).exitCode, 0);
	});

	test(`${operation} cannot dispatch after runtime budget cancellation even with unused turn slots`, async () => {
		const d = prepareDeps(); let runs = 0;
		d.budgetRecovery.ensure = async () => ({ reason: "budget_stopped", message: "Human declined; stop." }) as any;
		d.dispatchAgent = async () => { runs++; return { output: "", exitCode: 0, elapsed: 0 }; };
		const execute = operation === "dispatch" ? createDispatchExecutor(d as any) : createResearchExecutor(d as any);
		const result = await execute("call", { agent: "builder", task: "(1) continue" }, undefined, undefined, {} as any);
		assert.equal((result.details as any).status, "budget_stopped");
		assert.equal(runs, 0);
		assert.equal(d._task(), 0);
	});
}

// Exercise the actual executor -> runtime recovery -> installed question wrapper ->
// addressed answer -> audit -> operation path without a provider or model tool call.
test("exhausted task -> correlated remote yes -> one audit and the original dispatch", async () => {
	const { createBudgetRecovery } = await import("../budget-recovery.ts");
	const { checkTaskBudget } = await import("../run-budget.js");
	const { buildBudgetContinuationAudit } = await import("../hub-state-audit.js");
	const { requestRuntimeAsk } = await import("../../ask-user-remote/runtime-ask.ts");
	const { installAskUserRemote } = await import("../../ask-user-remote/index.ts");
	const { QuestionChannel } = await import("../../ask-user-remote/questions.ts");
	const { createEventBus } = await import("../../../../node_modules/@earendil-works/pi-coding-agent/dist/core/event-bus.js");
	const events = createEventBus(); const owner = { project: "af", peer: "hub", sessionId: "budget-e2e", startedAt: "now" };
	const channel = new QuestionChannel(() => owner);
	installAskUserRemote({ events, registerTool() {} }, {
		questionChannel: channel, startRemote: () => null,
		stockFactory: pi => pi.registerTool({ name: "ask_user", execute: (_id, _p, signal) => new Promise(resolve => signal.addEventListener("abort", () => resolve({ details: { cancelled: true } }))) }),
	});
	const d = prepareDeps(); d.state.setTaskDispatchCount(8);
	const audit: any[] = [], tasks: string[] = [];
	d.budgetRecovery = createBudgetRecovery({
		check: operation => { const refused = checkTaskBudget(operation, d.budget.taskCounters(), d.budget.currentTaskBudget(), 0, "small"); return refused ? { ...refused, kind: "task" } : null; },
		language: () => "Bulgarian", ask: (id, params, ctx, signal) => requestRuntimeAsk(events, id, params, ctx, signal),
		startWait() {}, endWait() {}, renew: (refusal, correlation) => {
			const prior = d.budget.taskCounters(); d.state.setTaskDispatchCount(0); d.state.setTurnDispatchCount(0);
			audit.push(buildBudgetContinuationAudit({ kind: refusal.kind, reason: refusal.reason, prior, correlation }));
		},
	});
	d.dispatchAgent = async (_agent?: string, task?: string) => { tasks.push(task!); return { output: "Execution completed", exitCode: 0, elapsed: 1 }; };
	const execute = createDispatchExecutor(d as any);
	const pending = execute("dispatch-1", { agent: "builder", task: "original bounded work" }, undefined, undefined, { cwd: "/tmp", abort: () => assert.fail("unexpected abort"), ui: { notify() {} } } as any);
	await new Promise(r => setImmediate(r));
	assert.equal(tasks.length, 0); assert.equal(d._task(), 8);
	const q = channel.list(owner).questions[0]; assert.ok(q);
	assert.equal(channel.submit(owner, q.id, "yes-1", { kind: "selection", selections: [q.options[0].title] }).status, "accepted");
	assert.equal((await pending).details?.exitCode, 0);
	assert.deepEqual(tasks, ["original bounded work"]); assert.equal(d._task(), 1);
	assert.equal(audit.length, 1); assert.equal(audit[0].prior.dispatches, 8);
	assert.equal(audit[0].correlation.request_id, q.toolCallId);
	assert.notEqual(channel.submit(owner, q.id, "yes-2", { kind: "selection", selections: [q.options[0].title] }).status, "accepted");
	assert.equal(audit.length, 1);
});

for (const operation of ["dispatch", "research"] as const) {
	test(`${operation} rechecks cancellation after awaiting budget authorization`, async () => {
		const d = prepareDeps(); const controller = new AbortController(); let runs = 0;
		d.budgetRecovery.ensure = async () => { controller.abort(); return null; };
		d.dispatchAgent = async () => { runs++; return { output: "", exitCode: 0, elapsed: 0 }; };
		const execute = operation === "dispatch" ? createDispatchExecutor(d as any) : createResearchExecutor(d as any);
		const result = await execute("cancel-after-ask", { agent: "builder", task: "work" }, controller.signal, undefined, {} as any);
		assert.equal((result.details as any).status, "cancelled"); assert.equal(runs, 0); assert.equal(d._task(), 0);
	});
}

test("native diagnostic details survive the tool boundary and full failure artifact", async t => {
	const { mkdtempSync, mkdirSync, readFileSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
	const { createAssertionsArtifactsContext } = await import("../context/assertions-artifacts.ts");
	const dir = mkdtempSync(join(tmpdir(), "native-diagnostic-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
	mkdirSync(join(dir, "src"));
	const d = prepareDeps();
	d.state.getSessionDir = () => dir;
	d.artifacts = createAssertionsArtifactsContext({ getAssertions: () => [], getSessionDir: () => dir, getRunHistoryKeep: () => 2, setStatus() {} });
	const diagnostics = { reason: "assistant_error", assistantError: "SYNTHETIC: provider failed", stderr: "stderr beginning " + "x".repeat(4000) + " end", modelUsed: "actual/model", toolCallsStarted: 0, termination: null, processExitCode: 1 };
	d.dispatchAgent = async () => ({ output: "Agent failed", exitCode: 1, elapsed: 1, dispatchId: "diagnostic-run-1", transcriptPath: join(dir, "transcript.jsonl"), diagnostics });
	const result = await createDispatchExecutor(d as any)("call", { agent: "builder", task: "bounded task", scope: ["src/*.ts"] }, undefined, undefined, { cwd: dir } as any);
	const details = result.details as any;
	assert.deepEqual(details.diagnostics, diagnostics);
	assert.equal(details.dispatchId, "diagnostic-run-1");
	assert.equal(details.returnPath, null);
	const body = readFileSync(details.failurePath, "utf8");
	assert.ok(body.includes(diagnostics.stderr), "artifact preserves complete stderr, not only the display tail");
	assert.ok(body.includes(diagnostics.assistantError));
	assert.ok(body.includes("diagnostic-run-1")); assert.ok(body.includes("bounded task")); assert.ok(body.includes("src/*.ts"));
	assert.ok(details.failurePath.includes("diagnostic-run-1"));
});

for (const kind of ["dispatch", "research"] as const) test(`${kind}: failed unchanged work is blocked across turns and rewording before budget confirmation`, async () => {
 const { createNoProgressGuard } = await import("../no-progress.ts");
 const d = prepareDeps(); (d as any).noProgress = createNoProgressGuard();
 let executions = 0, budgetChecks = 0;
 d.budgetRecovery.ensure = async () => { budgetChecks++; return null; };
 (d.artifacts as any).writeRunArtifact = () => "/tmp/retained-failure.md";
 const failed = async () => { executions++; return { output: "SYNTHETIC failure", exitCode: 1, elapsed: 0, dispatchId: `${kind}-failed`, evidencePath: "/tmp/retained-failure.json" }; };
 d.dispatchAgent = failed;
 d.research = { anonymousDef: () => ({ name: "research" }), resolveModel: () => "local/model", createState: () => ({ id: 1 }), spawn: failed };
 const run = kind === "dispatch" ? createDispatchExecutor(d as any) : createResearchExecutor(d as any);
 const params: any = kind === "dispatch" ? { agent: "builder", task: "Fix original task" } : { task: "Investigate original failure" };
 await run("first", params, undefined, undefined, {} as any);
 d.state.setTurnDispatchCount(0); // Ordinary turn renewal must not reset task progress.
 const refused = await run("second", { ...params, task: "Completely different wording of the same bounded work" }, undefined, undefined, {} as any);
 assert.equal((refused.details as any).status, "no_progress_refused");
 assert.equal(executions, 1); assert.equal(budgetChecks, 1);
 assert.equal((d as any).noProgress.authorize(`${kind}-failed`), true);
 await run("third", params, undefined, undefined, {} as any); assert.equal(executions, 2);
});

test("exit zero without assertions is execution completion, not acceptance", async () => {
 const d = prepareDeps(); (d.artifacts as any).writeRunArtifact = () => "/tmp/full-return.md";
 d.dispatchAgent = async () => ({ output: "Done! <write>not a real tool call</write>", exitCode: 0, elapsed: 0 });
 const result = await createDispatchExecutor(d as any)("call", { agent: "builder", task: "Produce requested work" }, undefined, undefined, {} as any);
 assert.equal((result.details as any).executionStatus, "completed"); assert.equal((result.details as any).accepted, false);
 assert.equal((result.details as any).status, "completed_unverified"); assert.ok((result.details as any).returnPath);
});

test("missing scope roots refuse before budget confirmation or dispatch", async () => {
 const d = prepareDeps(); let invoked = false;
 d.budgetRecovery.ensure = async () => { invoked = true; return null; };
 d.dispatchAgent = async () => { invoked = true; return { output: "zero matches", exitCode: 0, elapsed: 0 }; };
 const result = await createDispatchExecutor(d as any)("call", { agent: "builder", task: "Clean files", scope: ["nonexistent-scope-regression/**/*.cs"] }, undefined, undefined, {} as any);
 assert.equal((result.details as any).status, "scope_preflight_failed"); assert.equal(invoked, false); assert.equal(d._task(), 0);
});

for (const writes of [false, true]) test(`explicit deliverable readback and retained content (file written=${writes})`, async t => {
 const { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync, rmSync } = await import("node:fs");
 const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
 const { createAssertionsArtifactsContext } = await import("../context/assertions-artifacts.ts");
 const cwd = mkdtempSync(join(tmpdir(), "deliverable-boundary-")); t.after(() => rmSync(cwd, { recursive: true, force: true }));
 const sessionDir = join(cwd, ".pi/session"); mkdirSync(sessionDir, { recursive: true }); mkdirSync(join(cwd, "src"));
 const target = join(cwd, "src/report.md"); const d = prepareDeps();
 d.state.getSessionDir = () => sessionDir;
 d.artifacts = createAssertionsArtifactsContext({ getSessionDir: () => sessionDir, getAssertions: () => [], getRunHistoryKeep: () => 2, setStatus() {} }) as any;
 d.dispatchAgent = async (_agent: string, task: string) => {
  assert.ok(task.includes(target), "worker receives the explicit absolute output contract");
  if (writes) writeFileSync(target, "actual delivered body");
  return { output: "<write path='src/report.md'>claimed work</write>", exitCode: 0, elapsed: 0 };
 };
 const result = await createDispatchExecutor(d as any)("call", { agent: "builder", task: "Produce report", scope: ["src/report.md"], deliverables: ["src/report.md"] }, undefined, undefined, { cwd } as any);
 const details = result.details as any;
 assert.equal(details.accepted, false); assert.equal(details.executionStatus, "completed");
 assert.equal(details.acceptanceStatus, writes ? "needs_verification" : "deliverable_failed");
 assert.equal(existsSync(target), writes, "XML prose is never executed as a tool");
 const assessment = JSON.parse(readFileSync(details.assessmentPath, "utf8"));
 assert.equal(assessment.readback[0].status, writes ? "read" : "missing");
 assert.ok(existsSync(details.returnPath));
 if (writes) {
  writeFileSync(target, "later edit");
  assert.equal(readFileSync(details.deliverableReadback[0].retainedPath, "utf8"), "actual delivered body");
 } else {
  const refused = await createDispatchExecutor(d as any)("retry", { agent: "builder", task: "Reworded report request", scope: ["src/report.md"], deliverables: ["src/report.md"] }, undefined, undefined, { cwd } as any);
  assert.equal((refused.details as any).status, "no_progress_refused", "missing deliverable still blocks unchanged retry");
 }
});

test("successful unverified completion permits a same-scope follow-up without parent abort", async () => {
 const d = prepareDeps(); let runs = 0, aborts = 0;
 d.dispatchAgent = async () => { runs++; return { output: "completed work", exitCode: 0, elapsed: 0, dispatchId: `success-${runs}` }; };
 const run = createDispatchExecutor(d as any); const ctx = { abort: () => { aborts++; } } as any;
 await run("first", { agent: "builder", task: "Implement work" }, undefined, undefined, ctx);
 const followup = await run("second", { agent: "builder", task: "Address review feedback" }, undefined, undefined, ctx);
 assert.equal((followup.details as any).status, "completed_unverified"); assert.equal(runs, 2); assert.equal(aborts, 0);
});

test("first failed-work refusal permits correction; second unchanged refusal stops parent", async () => {
 const d = prepareDeps(); let runs = 0, aborts = 0;
 d.dispatchAgent = async () => { runs++; return { output: "failure", exitCode: 1, elapsed: 0, dispatchId: "failure" }; };
 const run = createDispatchExecutor(d as any); const ctx = { abort: () => { aborts++; } } as any;
 const params = { agent: "builder", task: "Original work" };
 await run("first", params, undefined, undefined, ctx);
 const first = await run("second", { ...params, task: "Rephrased work" }, undefined, undefined, ctx);
 assert.equal((first.details as any).status, "no_progress_refused"); assert.equal(aborts, 0);
 const second = await run("third", { ...params, task: "Again rephrased work" }, undefined, undefined, ctx);
 assert.equal((second.details as any).status, "no_progress_refused"); assert.equal(aborts, 1); assert.equal(runs, 1);
});

test("late result artifacts stay with the originating session namespace", async t => {
 const { mkdtempSync, mkdirSync, rmSync } = await import("node:fs"); const { join } = await import("node:path"); const { tmpdir } = await import("node:os");
 const { createAssertionsArtifactsContext } = await import("../context/assertions-artifacts.ts");
 const cwd = mkdtempSync(join(tmpdir(), "late-session-")); t.after(() => rmSync(cwd, { recursive: true, force: true }));
 const original = join(cwd, "original"), next = join(cwd, "next"); mkdirSync(original); mkdirSync(next);
 let current = original; const d = prepareDeps(); d.state.getSessionDir = () => current;
 d.artifacts = createAssertionsArtifactsContext({ getSessionDir: () => current, getAssertions: () => [], getRunHistoryKeep: () => 2, setStatus() {} }) as any;
 d.dispatchAgent = async () => { current = next; return { output: "old session result", exitCode: 0, elapsed: 0 }; };
 const result = await createDispatchExecutor(d as any)("call", { agent: "builder", task: "original work" }, undefined, undefined, { cwd } as any);
 assert.ok((result.details as any).returnPath.startsWith(original));
 assert.ok((result.details as any).assessmentPath.startsWith(original));
});

test("late old-task completion cannot auto-resume research or mutate new-task report", async () => {
 const d = prepareDeps(); let researchCalls = 0;
 d.extractNeedsResearch = () => ["old task question"];
 d.research = { spawn: async () => { researchCalls++; return { output: "findings", exitCode: 0 }; } };
 d.dispatchAgent = async () => { d.noProgress.reset(); d.state.setTaskDispatchCount(0); return { output: "NEEDS_RESEARCH: old task question", exitCode: 0, elapsed: 0 }; };
 const result = await createDispatchExecutor(d as any)("call", { agent: "builder", task: "old task" }, undefined, undefined, {} as any);
 assert.equal((result.details as any).staleTask, true); assert.equal(researchCalls, 0);
 assert.equal(d._task(), 0); assert.equal(d._report.dispatches.length, 0);
});
