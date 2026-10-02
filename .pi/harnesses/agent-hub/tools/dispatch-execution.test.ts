import { createNoProgressGuard } from "../no-progress.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { createDispatchExecutor, createResearchExecutor, prepareDispatch, structuredResearchPrompt, validateDispatchAgent } from "./dispatch-execution.ts";
import { applyProcessClassification, createProcessState, noteProcessStage, processPreEffectGate, evaluateProcessObligations } from "../process-obligations.ts";
import { applyTaskTriageAdditions } from "../task-triage-obligations.ts";
import { worktreeRevision } from "../scope-gate.js";
import { extractAskUserQuestions } from "../presentation.ts";

function prepareDeps(overrides: { agents?: string[]; research?: string[]; turn?: number; tools?: string } = {}) {
	let turn = overrides.turn ?? 0;
	let task = 0, activeWriters = 0, overlapCounter = 0;
	let processState = applyProcessClassification(createProcessState(), { risk: "low", scope: "small", reason: "test fixture" }).state;
	const agents = new Map((overrides.agents ?? ["builder"]).map(name => [name.toLowerCase(), { def: { name, tools: overrides.tools ?? "read" }, runCount: 0, contextPct: 0, lastBackend: null as string | null }]));
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
			getProcessState: () => processState,
			setProcessState: (value: any) => { processState = value; },
			persistProcessVerdict() {},
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
			getAssertions: () => [],
			getResearchPersonas: () => (overrides.research ?? ["researcher", "deep-researcher"]).map(name => ({ name })),
			getActiveWritableDispatches: () => activeWriters,
			setActiveWritableDispatches(v: number) { activeWriters = v; },
			getWritableOverlapCounter: () => overlapCounter,
			setWritableOverlapCounter(v: number) { overlapCounter = v; },
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
		_agents: agents,
		_setOverlap: (v: number) => { overlapCounter = v; },
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

test("every tier machine-appends the minimal changed-task contract and verbatim critical requirements", () => {
 for (const tier of ["trivial", "small", "feature", "project"]) {
  const d = prepareDeps({ tools: "read,write" });
  d.state.getTaskTier = () => tier;
  d.state.getAssertions = () => [{ id: "A1", tag: "test", text: "Use UTC calendar day", source: "user request", reference: "PLAN.md:42", criticalConditions: ["UTC day, not current instant"], status: "open" }];
  const prepared = prepareDispatch(d as any, { agent: "builder", task: "Implement A1" } as any, { cwd: process.cwd() } as any) as any;
  assert.match(prepared.task, /Runtime acceptance contract/); assert.match(prepared.task, /user request · PLAN\.md:42/);
  assert.match(prepared.task, /UTC day, not current instant/); assert.equal(prepared.requirements[0].source, "user request");
 }
});

test("low-tier PLAN54 and prose-free write operations derive minimal acceptance from operation capabilities", () => {
 for (const tier of ["trivial", "small"] as const) for (const task of ["fully implement PLAN54", "", "hello"] as const) {
  const d = prepareDeps({ tools: "read,edit" });
  d.state.getTaskTier = () => tier;
  const prepared = prepareDispatch(d as any, { agent: "builder", task } as any, { cwd: process.cwd() } as any) as any;
  assert.deepEqual(prepared.requirements.map((requirement: any) => requirement.id), ["AF-MIN-CHANGE"]);
  assert.match(prepared.task, /Runtime acceptance contract \(machine-appended\)/);
  assert.match(prepared.task, /AF-MIN-CHANGE \[test\]/);
 }
});

test("genuine read-only operations stay lightweight regardless of task prose", () => {
 for (const task of ["Read PLAN54 and summarize it", "Провери критериите за приемане", "hello", ""] as const) {
  const d = prepareDeps({ tools: "read,grep,find,ls" });
  d.state.getTaskTier = () => "project";
  const prepared = prepareDispatch(d as any, { agent: "builder", task } as any, { cwd: process.cwd() } as any) as any;
  assert.deepEqual(prepared.requirements, []);
  assert.doesNotMatch(prepared.task, /Runtime acceptance contract/);
 }
});

test("structured research prompt is additive and task-only calls remain byte-compatible", () => {
	assert.equal(structuredResearchPrompt({ task: "legacy task" }), "legacy task");
	const prompt = structuredResearchPrompt({ task: "legacy task", read_scope: ["./src/", "docs\\a.md"], goal: " find   API ", expected_result: " path:line " });
	assert.match(prompt, /## Structured research contract/);
	assert.match(prompt, /- docs\/a\.md\n- src/);
	assert.match(prompt, /Goal: find API/);
	assert.match(prompt, /Expected result: path:line/);
});

test("busy dispatch refuses immediately before budget accounting and does not abort parent", async () => {
	const d = prepareDeps(); let budgetChecks = 0, runs = 0, aborts = 0; let release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	d.budgetRecovery.ensure = async () => { budgetChecks++; return null; };
	d.dispatchAgent = async () => { runs++; await gate; return { output: "done", exitCode: 0, elapsed: 1 }; };
	const execute = createDispatchExecutor(d as any); const params = { agent: "builder", task: "same operation", scope: [] };
	const first = execute("one", params, undefined, undefined, { abort: () => { aborts++; } } as any);
	await new Promise(resolve => setImmediate(resolve));
	const busy = await execute("two", { ...params, task: "paraphrased" }, undefined, undefined, { abort: () => { aborts++; } } as any);
	assert.equal((busy.details as any).status, "busy"); assert.equal((busy.details as any).started, false);
	assert.equal((busy.details as any).recoveryCategory, "busy"); assert.equal(budgetChecks, 1); assert.equal(runs, 1); assert.equal(aborts, 0);
	release(); await first;
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
		// T2: research invocations use the research contract shape (no agent field);
		// dispatch-style params are an invalid invocation and must refuse before launch.
		const params = operation === "dispatch" ? { agent: "builder", task: "bounded work" } : { task: "bounded work" };
		const result = await execute("call", params as any, undefined, undefined, { cwd: "/tmp" } as any);
		assert.equal(asks, 1, "runtime must own confirmation even when the model never invokes ask_user");
		assert.equal(runs, 1);
		assert.equal((result.details as any).exitCode, 0);
	});

	test(`${operation} cannot dispatch after runtime budget cancellation even with unused turn slots`, async () => {
		const d = prepareDeps(); let runs = 0;
		d.budgetRecovery.ensure = async () => ({ reason: "budget_stopped", message: "Human declined; stop." }) as any;
		d.dispatchAgent = async () => { runs++; return { output: "", exitCode: 0, elapsed: 0 }; };
		const execute = operation === "dispatch" ? createDispatchExecutor(d as any) : createResearchExecutor(d as any);
		const params = operation === "dispatch" ? { agent: "builder", task: "(1) continue" } : { task: "(1) continue" };
		const result = await execute("call", params as any, undefined, undefined, {} as any);
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
		const params = operation === "dispatch" ? { agent: "builder", task: "work" } : { task: "work" };
		const result = await execute("cancel-after-ask", params as any, controller.signal, undefined, {} as any);
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

for (const kind of ["dispatch", "research"] as const) test(`${kind}: indeterminate failed work is blocked across turns, rewording, and unsupported authorization`, async () => {
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
 d.state.setTurnDispatchCount(0);
 const refused = await run("second", { ...params, task: "Completely different wording of the same bounded work" }, undefined, undefined, {} as any);
 assert.equal((refused.details as any).status, "no_progress_refused");
 assert.equal((refused.details as any).recoveryCategory, "indeterminate");
 assert.equal(executions, 1); assert.equal(budgetChecks, 1);
 assert.equal((d as any).noProgress.authorize(`${kind}-failed`), false, "unknown cause cannot be authorized as a retry");
 const stillRefused = await run("third", params, undefined, undefined, {} as any);
 assert.equal((stillRefused.details as any).status, "no_progress_refused"); assert.equal(executions, 1);
});

test("exit zero without assertions is execution completion, not acceptance", async () => {
 const d = prepareDeps(); (d.artifacts as any).writeRunArtifact = () => "/tmp/full-return.md";
 d.dispatchAgent = async () => ({ output: "Done! <write>not a real tool call</write>", exitCode: 0, elapsed: 0 });
 const result = await createDispatchExecutor(d as any)("call", { agent: "builder", task: "Produce requested work" }, undefined, undefined, {} as any);
 assert.equal((result.details as any).executionStatus, "completed"); assert.equal((result.details as any).accepted, false);
 assert.equal((result.details as any).status, "completed_unverified"); assert.ok((result.details as any).returnPath);
});

test("exit-zero pseudo-write becomes evidenced tool_protocol_error and unchanged retry never replays partial effects", async t => {
 const cwd = mkdtempSync(join(tmpdir(), "pseudo-tool-partial-")); t.after(() => rmSync(cwd, { recursive: true, force: true }));
 const sessionDir = join(cwd, ".pi", "agent-sessions", "sessions", "test"); mkdirSync(sessionDir, { recursive: true }); mkdirSync(join(cwd, "docs"));
 execFileSync("git", ["init"], { cwd, stdio: "ignore" });
 execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "fixture"], { cwd, stdio: "ignore" });
 const d = prepareDeps({ tools: "read,write" }); d.state.getSessionDir = () => sessionDir;
 const { createAssertionsArtifactsContext } = await import("../context/assertions-artifacts.ts");
 d.artifacts = createAssertionsArtifactsContext({ getSessionDir: () => sessionDir, getAssertions: () => [], getRunHistoryKeep: () => 2, setStatus() {} }) as any;
 (d._agents.get("builder") as any).lastBackend = "native";
 let runs = 0;
 d.dispatchAgent = async () => {
  runs++;
  writeFileSync(join(cwd, "docs", "one.md"), "completed effect\n");
  return {
   output: "One file is done.\n<tool_call><function=write>docs/two.md</function></tool_call>",
   exitCode: 0, elapsed: 1, dispatchId: "pseudo-partial",
   toolEvents: [{ toolName: "write", toolCallId: "write-one", args: JSON.stringify({ path: "docs/one.md", content: "completed effect" }), completed: true, isError: false }],
  };
 };
 const execute = createDispatchExecutor(d as any);
 const params = { agent: "builder", task: "Produce both files", scope: ["docs/**"], deliverables: ["docs/one.md", "docs/two.md"] };
 const first = await execute("first", params, undefined, undefined, { cwd } as any); const details = first.details as any;
 assert.equal(details.executionStatus, "completed"); assert.equal(details.accepted, false);
 assert.equal(details.changeResult.status, "changed"); assert.equal(details.verificationResult.status, "failed");
 assert.equal(details.status, "tool_protocol_error"); assert.equal(details.recoveryCategory, "tool_protocol_error");
 assert.equal(details.protocolDiagnostic.effects.status, "partial"); assert.ok(existsSync(details.protocolEvidencePath));
 assert.match((first.content[0] as any).text, /No matching write event.*docs\/two\.md.*missing/i);
 const second = await execute("second", { ...params, task: "Please try those same two files again" }, undefined, undefined, { cwd } as any);
 assert.equal((second.details as any).status, "no_progress_refused"); assert.equal((second.details as any).recoveryCategory, "tool_protocol_error");
 assert.equal(runs, 1, "the already-executed first write is never replayed blindly");
});

test("executed write with failed deliverable readback stays verification_failed, not tool_protocol_error", async t => {
 const cwd = mkdtempSync(join(tmpdir(), "executed-write-readback-")); t.after(() => rmSync(cwd, { recursive: true, force: true }));
 const sessionDir = join(cwd, ".pi", "agent-sessions", "sessions", "test"); mkdirSync(sessionDir, { recursive: true }); mkdirSync(join(cwd, "docs"));
 const d = prepareDeps({ tools: "read,write" }); d.state.getSessionDir = () => sessionDir;
 const { createAssertionsArtifactsContext } = await import("../context/assertions-artifacts.ts");
 d.artifacts = createAssertionsArtifactsContext({ getSessionDir: () => sessionDir, getAssertions: () => [], getRunHistoryKeep: () => 2, setStatus() {} }) as any;
 (d._agents.get("builder") as any).lastBackend = "native";
 d.dispatchAgent = async () => ({
  output: "<tool_call><function=write>docs/out.md</function></tool_call>", exitCode: 0, elapsed: 1, dispatchId: "write-readback-failed",
  toolEvents: [{ toolName: "write", toolCallId: "write-out", args: JSON.stringify({ path: "docs/out.md", content: "x" }), completed: true, isError: false }],
 });
 const result = await createDispatchExecutor(d as any)("call", { agent: "builder", task: "Write output", scope: ["docs/**"], deliverables: ["docs/out.md"] }, undefined, undefined, { cwd } as any);
 assert.equal((result.details as any).status, "verification_failed");
 assert.equal((result.details as any).recoveryCategory, undefined);
 assert.equal((result.details as any).protocolDiagnostic, null);
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
 const sessionDir = join(cwd, ".pi/agent-sessions/sessions/test"); mkdirSync(sessionDir, { recursive: true }); mkdirSync(join(cwd, "src"));
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

test("repeated failed-work refusals stop only the requested operation, not the parent", async () => {
 const d = prepareDeps(); let runs = 0, aborts = 0;
 d.dispatchAgent = async () => { runs++; return { output: "failure", exitCode: 1, elapsed: 0, dispatchId: "failure" }; };
 const run = createDispatchExecutor(d as any); const ctx = { abort: () => { aborts++; } } as any;
 const params = { agent: "builder", task: "Original work" };
 await run("first", params, undefined, undefined, ctx);
 const first = await run("second", { ...params, task: "Rephrased work" }, undefined, undefined, ctx);
 assert.equal((first.details as any).status, "no_progress_refused");
 const second = await run("third", { ...params, task: "Again rephrased work" }, undefined, undefined, ctx);
 // T1/F7 Checkpoint C: refusals use explicit separate accounting and never consume
 // physical launch counters. The anti-loop boundary stays in the guard (same
 // fingerprint stays refused); budgets still fail closed on real launches.
 assert.equal((second.details as any).status, "no_progress_refused"); assert.equal(aborts, 0); assert.equal(runs, 1);
 assert.equal(d.state.getTurnDispatchCount(), 1, "no-progress refusals never consume launch counters");
 assert.equal(d.state.getTurnReport().refusals, 2);
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

function gitDiagnosticsFixture(t: any, git = true) {
 const cwd = mkdtempSync(join(tmpdir(), "dispatch-compiler-")); t.after(() => rmSync(cwd, { recursive: true, force: true }));
 const sessionDir = join(cwd, ".pi", "agent-sessions", "sessions", "test"); mkdirSync(sessionDir, { recursive: true }); mkdirSync(join(cwd, "src"));
 writeFileSync(join(cwd, "src", "api.ts"), "export const value = 1;\n"); writeFileSync(join(cwd, "README.md"), "fixture\n");
 if (git) {
  execFileSync("git", ["init"], { cwd, stdio: "ignore" }); execFileSync("git", ["add", "."], { cwd, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "fixture"], { cwd, stdio: "ignore" });
 }
 const d = prepareDeps({ tools: "read,write" }); d.state.getSessionDir = () => sessionDir;
 const assertions = [{ id: "A1", status: "open" }];
 return import("../context/assertions-artifacts.ts").then(({ createAssertionsArtifactsContext }) => {
  d.artifacts = createAssertionsArtifactsContext({ getSessionDir: () => sessionDir, getAssertions: () => assertions as any, getRunHistoryKeep: () => 2, setStatus() {} }) as any;
  (d._agents.get("builder") as any).lastBackend = "native";
  return { cwd, sessionDir, d, assertions };
 });
}

function compilerErrors(changedFiles: string[], overrides: Record<string, unknown> = {}) {
 return {
  status: "completed", changedFiles, attribution: "no_observed_overlap", uncoveredFiles: [],
  projects: [{
   project: "/fixture/tsconfig.json", status: "errors", exitCode: 2, compilerVersion: "5.9.3",
   argv: [process.execPath, "/fixture/node_modules/typescript/bin/tsc", "--project", "/fixture/tsconfig.json", "--noEmit", "--pretty", "false", "--incremental", "--tsBuildInfoFile", "/tmp/cache"],
   stdout: "raw compiler stdout " + "x".repeat(9000), stderr: "raw compiler stderr",
   diagnostics: [
    { file: changedFiles[0], line: 1, code: 2322, message: "changed error" },
    { file: "src/consumer.ts", line: 3, code: 2339, message: "downstream error" },
    { code: 5083, message: "global error" },
   ],
  }],
  ...overrides,
 } as any;
}

test("native writable finish uses one no-scope delta and compiler facts survive digest, truncation, details, and evidence", async t => {
 const { cwd, sessionDir, d, assertions } = await gitDiagnosticsFixture(t); let calls = 0; let observed: string[] = [];
 d.diagnoseChangedTypeScript = async (paths: readonly string[]) => { calls++; observed = [...paths]; return compilerErrors([...paths]); };
 d.dispatchAgent = async () => {
  writeFileSync(join(cwd, "src", "api.ts"), "export const value: number = 'bad';\n");
  return { output: `assertions_proven:\n- A1: current claim — evidence: focused test\n- A9: foreign claim — evidence: other test\nassertions_unproven: []\nassertions_failed: []\n${"specialist raw ".repeat(700)}`, exitCode: 0, elapsed: 1, dispatchId: "compiler-visible" };
 };
 const result = await createDispatchExecutor(d as any)("call", { agent: "builder", task: "A1 implement diagnostics" }, undefined, undefined, { cwd } as any);
 const details = result.details as any; const text = (result.content[0] as any).text;
 assert.equal(calls, 1); assert.deepEqual(observed, ["src/api.ts"]); assert.equal(details.scopeViolations, null, "no scope globs still snapshots without inventing a scope violation");
 assert.equal(details.accepted, false); assert.equal(details.changeResult.status, "changed"); assert.equal(details.verificationResult.status, "failed");
 assert.equal(details.runtimeResult.task.current, true); assert.equal(details.runtimeResult.execution.status, "completed");
 assert.ok(details.fullOutput.length > 8000); assert.equal(details.compilerDiagnostics.projects[0].diagnostics.length, 3);
 assert.match(text, /Observed changed files:/); assert.match(text, /Elsewhere:/); assert.match(text, /global — TS5083/); assert.match(text, /Full compiler evidence:/);
 assert.deepEqual(details.structuredReturn.assertions_proven.map((entry: any) => entry.id), ["A9"]);
 const demoted = details.structuredReturn.assertions_unproven.find((entry: any) => entry.id === "A1");
 assert.equal(demoted.evidence, "focused test"); assert.equal(demoted.reason, "compiler_diagnostics");
 assert.ok(details.contractNotices.some((notice: any) => notice.type === "compiler_diagnostics" && notice.id === "A1"));
 assert.deepEqual(assertions, [{ id: "A1", status: "open" }], "global ledger is untouched");
 const evidence = readFileSync(details.compilerEvidencePath, "utf8"); assert.match(evidence, /raw compiler stdout/); assert.match(evidence, /raw compiler stderr/); assert.match(evidence, /tsBuildInfoFile/);
 const assessment = JSON.parse(readFileSync(details.assessmentPath, "utf8")); assert.equal(assessment.schema, "agent-fleet.runtime-result/v1"); assert.equal(assessment.accepted, false); assert.equal(assessment.structuredReturn.assertions_unproven.at(-1).reason, "compiler_diagnostics");
 assert.equal(assessment.compilerEvidencePath, details.compilerEvidencePath); assert.ok(assessment.verification.evidenceRefs.includes(details.compilerEvidencePath)); assert.ok(details.returnPath.startsWith(sessionDir));
});

test("T6b out-of-scope attempts remain an advisory and are not reported as sandbox confinement", async t => {
 const { cwd, d } = await gitDiagnosticsFixture(t);
 d.dispatchAgent = async () => { writeFileSync(join(cwd, "outside.txt"), "attempted outside scope\n"); return { output: "done", exitCode: 0, elapsed: 1, dispatchId: "scope-advisory" }; };
 const result = await createDispatchExecutor(d as any)("call", { agent: "builder", task: "edit one file", scope: ["src/api.ts"] }, undefined, undefined, { cwd } as any);
 const details = result.details as any; const text = (result.content[0] as any).text;
 assert.deepEqual(details.scopeViolations.outOfScope, ["outside.txt"]);
 assert.match(text, /Scope advisory/); assert.match(text, /hub did not revert anything/);
 assert.doesNotMatch(text, /sandbox|confined|blocked the write/i);
 assert.equal(readFileSync(join(cwd, "outside.txt"), "utf8"), "attempted outside scope\n");
});

test("runtime accepts a changed task only with a current recorded command and passing exit", async t => {
 const { cwd, d } = await gitDiagnosticsFixture(t);
 d.dispatchAgent = async () => { writeFileSync(join(cwd, "src", "api.ts"), "export const value = 2;\n"); return { output: "Done! tests pass", exitCode: 0, elapsed: 1, dispatchId: "compiler-pass" }; };
 d.diagnoseChangedTypeScript = async (paths: readonly string[]) => ({
  status: "completed", changedFiles: [...paths], attribution: "no_observed_overlap", uncoveredFiles: [],
  projects: [{ project: "/fixture/tsconfig.json", status: "passed", exitCode: 0, compilerVersion: "5.9.3", argv: ["node", "tsc", "-p", "tsconfig.json", "--noEmit"], stdout: "", stderr: "", diagnostics: [], changedFiles: [...paths] }],
 } as any);
 const result = await createDispatchExecutor(d as any)("call", { agent: "builder", task: "change implementation" }, undefined, undefined, { cwd } as any);
 const details = result.details as any;
 assert.equal(details.status, "accepted"); assert.equal(details.accepted, true); assert.equal(details.acceptanceStatus, "accepted");
 assert.equal(details.changeResult.status, "changed"); assert.equal(details.verificationResult.status, "passed");
 assert.deepEqual(details.verificationResult.checks[0].command, ["node", "tsc", "-p", "tsconfig.json", "--noEmit"]);
 assert.equal(details.verificationResult.checks[0].exitCode, 0); assert.equal(details.verificationResult.checks[0].inspectedRevision, details.taskIdentity.revision.after);
});

test("T11 real dispatch consumer refuses unknown/high-risk acceptance independently of tier", async t => {
 for (const tier of ["trivial", "project"] as const) {
  const { cwd, d } = await gitDiagnosticsFixture(t); let process = createProcessState();
  d.state.getTaskTier = () => tier; d.state.getProcessState = () => process; d.state.setProcessState = (value: any) => { process = value; }; d.state.persistProcessVerdict = () => {};
  d.dispatchAgent = async () => { writeFileSync(join(cwd, "src", "api.ts"), `export const value = ${tier === "trivial" ? 2 : 3};\n`); return { output: "done", exitCode: 0, elapsed: 1, dispatchId: `unknown-${tier}` }; };
  d.diagnoseChangedTypeScript = async (paths: readonly string[]) => ({ status: "completed", changedFiles: [...paths], attribution: "no_observed_overlap", uncoveredFiles: [], projects: [{ status: "passed", exitCode: 0, argv: ["node", "tsc"], diagnostics: [], changedFiles: [...paths] }] } as any);
  const unknown = await createDispatchExecutor(d as any)("unknown", { agent: "builder", task: "change" }, undefined, undefined, { cwd } as any);
  assert.equal((unknown.details as any).accepted, false); assert.equal((unknown.details as any).processVerdict.obligations.risk.status, "open");
 }
 const { cwd, d } = await gitDiagnosticsFixture(t); let process = applyProcessClassification(createProcessState(), { risk: "high", scope: "small", reason: "sensitive boundary" }).state;
 process = { ...process, plan: { ...process.plan, evidenceRef: "plan:approved", revision: "approved" } };
 d.state.getTaskTier = () => "small"; d.state.getProcessState = () => process; d.state.setProcessState = (value: any) => { process = value; }; d.state.persistProcessVerdict = () => {};
 d.dispatchAgent = async () => { writeFileSync(join(cwd, "src", "api.ts"), "export const value = 4;\n"); return { output: "done", exitCode: 0, elapsed: 1, dispatchId: "high-small" }; };
 d.diagnoseChangedTypeScript = async (paths: readonly string[]) => ({ status: "completed", changedFiles: [...paths], attribution: "no_observed_overlap", uncoveredFiles: [], projects: [{ status: "passed", exitCode: 0, argv: ["node", "tsc"], diagnostics: [], changedFiles: [...paths] }] } as any);
 const high = await createDispatchExecutor(d as any)("high", { agent: "builder", task: "high risk change" }, undefined, undefined, { cwd } as any);
 assert.equal((high.details as any).accepted, false); assert.equal((high.details as any).processVerdict.obligations.review.status, "open");
 assert.ok(process.acceptance.evidenceRef, "the valid T2 acceptance stage persists while independent review stays open");
});

test("compiler correction runs after return extraction", async t => {
 const { cwd, d } = await gitDiagnosticsFixture(t); let extracted = 0;
 d.dispatchAgent = async () => { writeFileSync(join(cwd, "src", "api.ts"), "broken\n"); return { output: "prose-only result", exitCode: 0, elapsed: 1, dispatchId: "compiler-extracted" }; };
 d.runReturnExtraction = async () => { extracted++; return { changed_files: [], assertions_proven: [{ id: "A1", note: "extracted", evidence: "report line" }], assertions_unproven: [], assertions_failed: [], tests_run: [], open_risks: [], requires_user_decision: [] }; };
 d.diagnoseChangedTypeScript = async (paths: readonly string[]) => compilerErrors([...paths]);
 const result = await createDispatchExecutor(d as any)("call", { agent: "builder", task: "A1 extracted contract" }, undefined, undefined, { cwd } as any);
 assert.equal(extracted, 1); assert.equal((result.details as any).returnExtracted, true);
 assert.equal((result.details as any).structuredReturn.assertions_proven.length, 0);
 assert.equal((result.details as any).structuredReturn.assertions_unproven[0].reason, "compiler_diagnostics");
});

for (const scenario of ["read-only", "remote", "failed", "cancelled", "pending", "stale", "no-change", "no-ts"] as const) {
 test(`compiler skips ineligible ${scenario} completion`, async t => {
  const writable = scenario !== "read-only"; const fixture = await gitDiagnosticsFixture(t); const { cwd, d } = fixture;
  if (!writable) (d._agents.get("builder") as any).def.tools = "read";
  if (scenario === "remote") (d._agents.get("builder") as any).lastBackend = "coms";
  let calls = 0; d.diagnoseChangedTypeScript = async () => { calls++; return compilerErrors(["src/api.ts"]); };
  d.dispatchAgent = async () => {
   if (!["no-change", "read-only"].includes(scenario)) {
    const file = scenario === "no-ts" ? "README.md" : join("src", "api.ts");
    writeFileSync(join(cwd, file), `${scenario}\n`);
   }
   if (scenario === "stale") d.noProgress.reset();
   return { output: "completed output", exitCode: scenario === "failed" ? 1 : scenario === "cancelled" ? 125 : 0, pending: scenario === "pending", elapsed: 1, dispatchId: `skip-${scenario}` };
  };
  const result = await createDispatchExecutor(d as any)("call", { agent: "builder", task: `scenario ${scenario}` }, undefined, undefined, { cwd } as any);
  assert.equal(calls, 0); assert.equal((result.details as any).compilerDiagnostics, null);
  if (scenario === "no-ts") { assert.equal((result.details as any).changeResult.status, "changed"); assert.equal((result.details as any).verificationResult.status, "missing"); assert.equal((result.details as any).accepted, false); }
 });
}

test("invalid non-git and changed-HEAD observations are incomplete and preserve specialist output", async t => {
 for (const mode of ["non-git", "head-change"] as const) {
  const { cwd, d } = await gitDiagnosticsFixture(t, mode !== "non-git"); let calls = 0;
  d.diagnoseChangedTypeScript = async () => { calls++; return compilerErrors(["src/api.ts"]); };
  d.dispatchAgent = async () => {
   writeFileSync(join(cwd, "src", "api.ts"), `${mode}\n`);
   if (mode === "head-change") { execFileSync("git", ["add", "."], { cwd }); execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "head change"], { cwd, stdio: "ignore" }); }
   return { output: `specialist output ${mode}`, exitCode: 0, elapsed: 1, dispatchId: `invalid-${mode}` };
  };
  const result = await createDispatchExecutor(d as any)("call", { agent: "builder", task: mode }, undefined, undefined, { cwd } as any);
  const details = result.details as any; assert.equal(calls, 0); assert.equal(details.compilerDiagnostics.status, "incomplete");
  assert.match(details.compilerDiagnostics.reason, /worktree observation unavailable/); assert.match(details.fullOutput, new RegExp(`specialist output ${mode}`));
  assert.ok(existsSync(details.compilerEvidencePath)); assert.match((result.content[0] as any).text, /Compiler diagnostics incomplete/);
 }
});

test("pre-existing dirty paths trigger only when content changes during the dispatch", async t => {
 const { cwd, d } = await gitDiagnosticsFixture(t); writeFileSync(join(cwd, "src", "api.ts"), "dirty before dispatch\n");
 const calls: string[][] = []; d.diagnoseChangedTypeScript = async (paths: readonly string[]) => { calls.push([...paths]); return { status: "skipped", changedFiles: [...paths], attribution: "no_observed_overlap", projects: [] } as any; };
 d.dispatchAgent = async (_agent: string, task: string) => { if (task.includes("change-now")) writeFileSync(join(cwd, "src", "api.ts"), "changed during dispatch\n"); return { output: "done", exitCode: 0, elapsed: 1, dispatchId: task.includes("change-now") ? "dirty-two" : "dirty-one" }; };
 const run = createDispatchExecutor(d as any);
 await run("one", { agent: "builder", task: "leave-dirty" }, undefined, undefined, { cwd } as any); assert.equal(calls.length, 0);
 await run("two", { agent: "builder", task: "change-now" }, undefined, undefined, { cwd } as any); assert.deepEqual(calls, [["src/api.ts"]]);
});

test("overlap observed during compiler checking makes attribution uncertain and prevents demotion", async t => {
 const { cwd, d } = await gitDiagnosticsFixture(t);
 d.dispatchAgent = async () => { writeFileSync(join(cwd, "src", "api.ts"), "overlap\n"); return { output: "assertions_proven: [A1: done — evidence: test]", exitCode: 0, elapsed: 1, dispatchId: "compiler-overlap" }; };
 d.diagnoseChangedTypeScript = async (paths: readonly string[]) => { d._setOverlap(1); return compilerErrors([...paths]); };
 const result = await createDispatchExecutor(d as any)("call", { agent: "builder", task: "A1 overlap" }, undefined, undefined, { cwd } as any);
 const details = result.details as any; assert.equal(details.compilerDiagnostics.attribution, "uncertain");
 assert.equal(details.changeResult.status, "changed"); assert.equal(details.changeResult.attribution, "uncertain"); assert.equal(details.verificationResult.status, "unsupported"); assert.equal(details.accepted, false);
 assert.deepEqual(details.structuredReturn.assertions_proven.map((entry: any) => entry.id), ["A1"]); assert.match((result.content[0] as any).text, /attribution is uncertain/);
});

test("task staleness arising during async compiler work prevents contract correction and current-task accounting", async t => {
 const { cwd, d } = await gitDiagnosticsFixture(t);
 d.dispatchAgent = async () => { writeFileSync(join(cwd, "src", "api.ts"), "late stale\n"); return { output: "assertions_proven: [A1: done — evidence: test]", exitCode: 0, elapsed: 1, dispatchId: "compiler-late-stale" }; };
 d.diagnoseChangedTypeScript = async (paths: readonly string[]) => { await new Promise(resolve => setImmediate(resolve)); d.noProgress.reset(); return compilerErrors([...paths]); };
 const result = await createDispatchExecutor(d as any)("call", { agent: "builder", task: "A1 late stale" }, undefined, undefined, { cwd } as any);
 const details = result.details as any; assert.equal(details.staleTask, true); assert.equal(details.taskIdentity.current, false); assert.equal(details.verificationResult.status, "stale"); assert.equal(details.accepted, false); assert.deepEqual(details.structuredReturn.assertions_proven.map((entry: any) => entry.id), ["A1"]);
 assert.equal(d._report.dispatches.length, 0); assert.ok(existsSync(details.compilerEvidencePath), "old-task compiler evidence remains in the original namespace");
});

test("auto-research continuation triggers one compiler check for the final logical dispatch", async t => {
 const { cwd, d } = await gitDiagnosticsFixture(t); let dispatches = 0, compilerCalls = 0;
 d.extractNeedsResearch = (output: string) => output.includes("NEEDS_RESEARCH") ? ["where is the type?"] : [];
 (d.research as any).anonymousDef = () => ({ name: "researcher" }); (d.research as any).resolveModel = () => "test/model"; (d.research as any).createState = () => ({ id: 1 });
 (d.research as any).spawn = async () => ({ output: "finding", exitCode: 0, dispatchId: "finding-one" });
 d.dispatchAgent = async () => { dispatches++; if (dispatches === 1) { writeFileSync(join(cwd, "src", "api.ts"), "research change\n"); return { output: "NEEDS_RESEARCH: where is the type?", exitCode: 0, elapsed: 1, dispatchId: "research-initial" }; } return { output: "final delivered output", exitCode: 0, elapsed: 1, dispatchId: "research-final" }; };
 d.diagnoseChangedTypeScript = async (paths: readonly string[]) => { compilerCalls++; return compilerErrors([...paths]); };
 const result = await createDispatchExecutor(d as any)("call", { agent: "builder", task: "one logical run" }, undefined, undefined, { cwd } as any);
 assert.equal(dispatches, 2); assert.equal(compilerCalls, 1); assert.equal((result.details as any).dispatchId, "research-final");
});

test("downstream-only compiler errors remain visible without demoting current claims", async t => {
 const { cwd, d } = await gitDiagnosticsFixture(t);
 d.dispatchAgent = async () => { writeFileSync(join(cwd, "src", "api.ts"), "api changed\n"); return { output: "assertions_proven: [A1: done — evidence: test]", exitCode: 0, elapsed: 1, dispatchId: "compiler-downstream" }; };
 d.diagnoseChangedTypeScript = async (paths: readonly string[]) => compilerErrors([...paths], { projects: [{ project: "/fixture/tsconfig.json", status: "errors", exitCode: 2, argv: ["node", "tsc"], stdout: "consumer output", stderr: "", diagnostics: [{ file: "src/consumer.ts", line: 4, code: 2339, message: "consumer broke" }] }] });
 const result = await createDispatchExecutor(d as any)("call", { agent: "builder", task: "A1 downstream" }, undefined, undefined, { cwd } as any);
 assert.deepEqual((result.details as any).structuredReturn.assertions_proven.map((entry: any) => entry.id), ["A1"]); assert.match((result.content[0] as any).text, /Elsewhere:/); assert.match((result.content[0] as any).text, /consumer broke/);
});

test("unexpected diagnostics failure becomes incomplete without losing delivered output", async t => {
 const { cwd, d } = await gitDiagnosticsFixture(t);
 d.dispatchAgent = async () => { writeFileSync(join(cwd, "src", "api.ts"), "changed\n"); return { output: "valuable delivered output", exitCode: 0, elapsed: 1, dispatchId: "compiler-throws" }; };
 d.diagnoseChangedTypeScript = async () => { throw new Error("synthetic diagnostics failure"); };
 const result = await createDispatchExecutor(d as any)("call", { agent: "builder", task: "safe failure" }, undefined, undefined, { cwd } as any);
 const details = result.details as any; assert.equal(details.compilerDiagnostics.status, "incomplete"); assert.match(details.compilerDiagnostics.reason, /synthetic diagnostics failure/);
 assert.equal(details.fullOutput, "valuable delivered output"); assert.match((result.content[0] as any).text, /Compiler diagnostics incomplete/);
});

test("dispatch execution contains exactly one shared diffAgainst call", () => {
 const source = readFileSync(new URL("./dispatch-execution.ts", import.meta.url), "utf8");
 assert.equal((source.match(/diffAgainst\(/g) ?? []).length, 1);
});

test("real native executor finishDispatch times workflows compiler and demotes on changed-file errors", async t => {
 const sourceRepo = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
 const repo = mkdtempSync(join(tmpdir(), "finish-hook-repo-")); t.after(() => rmSync(repo, { recursive: true, force: true }));
 const workflowDir = join(repo, ".pi/agent-fleet/scripts/workflows"); mkdirSync(join(repo, ".pi/agent-fleet/scripts"), { recursive: true });
 cpSync(join(sourceRepo, ".pi/agent-fleet/scripts/workflows"), workflowDir, { recursive: true });
 cpSync(join(sourceRepo, "package.json"), join(repo, "package.json"));
 symlinkSync(join(sourceRepo, "node_modules"), join(repo, "node_modules"), "dir");
 execFileSync("git", ["init", "-q"], { cwd: repo }); execFileSync("git", ["add", "."], { cwd: repo }); execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"], { cwd: repo });
 const target = join(workflowDir, "wf-quality.ts"); const original = readFileSync(target);
 const sessionDir = mkdtempSync(join(tmpdir(), "finish-hook-")); t.after(() => rmSync(sessionDir, { recursive: true, force: true }));
 const d = prepareDeps({ agents: ["checkpoint-timer"], tools: "read,write" });
 d.budget.currentBudget = () => ({ maxDispatches: 8, maxResearch: 2 });
 d.state.getSessionDir = () => sessionDir;
 const assertions = [{ id: "A1", status: "open" }];
 const { createAssertionsArtifactsContext } = await import("../context/assertions-artifacts.ts");
 d.artifacts = createAssertionsArtifactsContext({ getSessionDir: () => sessionDir, getAssertions: () => assertions as any, getRunHistoryKeep: () => 2, setStatus() {} }) as any;
 (d._agents.get("checkpoint-timer") as any).lastBackend = "native";
 const timings: Array<Record<string, unknown>> = [];
 async function run(label: string, mutate: () => void, output: string) {
  d.dispatchAgent = async () => { mutate(); return { output, exitCode: 0, elapsed: 1, dispatchId: `finish-${label}` }; };
  const t0 = performance.now();
  const result = await createDispatchExecutor(d as any)("call", { agent: "checkpoint-timer", task: `A1 finish-path compiler ${label}` }, undefined, undefined, { cwd: repo } as any);
  const wallMs = performance.now() - t0;
  const details = result.details as any;
  const project = details.compilerDiagnostics?.projects?.[0];
  timings.push({ label, wallMs, durationMs: project?.durationMs, status: details.compilerDiagnostics?.status, projectStatus: project?.status, exitCode: project?.exitCode, argv: project?.argv, compilerVersion: project?.compilerVersion });
  return { result, details, wallMs, project };
 }
 const cold = await run("cold", () => writeFileSync(target, Buffer.concat([original, Buffer.from("\n// finish-path-cold\n")])), "assertions_proven: [A1: clean — evidence: comment]\nassertions_unproven: []\nassertions_failed: []");
 assert.equal(cold.details.backendUsed, "native", JSON.stringify({ backend: cold.details.backendUsed, status: cold.details.status, compiler: cold.details.compilerDiagnostics, keys: Object.keys(cold.details), text: String((cold.result.content[0] as any).text).slice(0, 800) }, null, 2));
 assert.equal(cold.details.compilerDiagnostics?.status, "completed", JSON.stringify(cold.details.compilerDiagnostics, null, 2));
 assert.equal(cold.project?.status, "passed", JSON.stringify(cold.details.compilerDiagnostics, null, 2));
 assert.equal(cold.project.exitCode, 0);
 const compilerVersion = JSON.parse(readFileSync(join(sourceRepo, "node_modules/typescript/package.json"), "utf8")).version;
 assert.equal(cold.project.compilerVersion, compilerVersion);
 assert.ok(cold.project.argv.includes("--noEmit") && cold.project.argv.includes("--incremental"));
 const cacheParts = relative(join(tmpdir(), "agent-fleet-diagnostics"), cold.project.argv.at(-1)).split(sep);
 assert.equal(cacheParts.length, 4);
 assert.match(cacheParts[0], /^[a-f0-9]{16}$/);
 assert.match(cacheParts[1], /^[a-f0-9]{16}$/);
 assert.equal(cacheParts[2], `typescript-${compilerVersion}`);
 assert.equal(cacheParts[3], "checkpoint-timer.tsbuildinfo");
 assert.match(String(cold.project.argv), /scripts\/workflows\/tsconfig\.json/);
 const warm = await run("warm", () => writeFileSync(target, Buffer.concat([original, Buffer.from("\n// finish-path-warm\n")])), "assertions_proven: [A1: clean — evidence: comment]\nassertions_unproven: []\nassertions_failed: []");
 assert.equal(warm.project.status, "passed");
 const changed = await run("changed", () => writeFileSync(target, Buffer.concat([original, Buffer.from("\n// finish-path-changed\n")])), "assertions_proven: [A1: clean — evidence: comment]\nassertions_unproven: []\nassertions_failed: []");
 assert.equal(changed.project.status, "passed");
 const errored = await run("error", () => writeFileSync(target, Buffer.concat([original, Buffer.from("\nexport const __finishPathBad: number = 'x';\n")])), "assertions_proven: [A1: claimed — evidence: specialist]\nassertions_unproven: []\nassertions_failed: []");
 assert.equal(errored.project.status, "errors");
 assert.ok(errored.project.exitCode !== 0);
 assert.equal(errored.details.structuredReturn.assertions_proven.length, 0);
 assert.equal(errored.details.structuredReturn.assertions_unproven[0].reason, "compiler_diagnostics");
 assert.match((errored.result.content[0] as any).text, /Observed changed files:/);
 assert.ok(errored.details.compilerEvidencePath);
 writeFileSync(target, original);
 const uncovered = await run("uncovered", () => {}, "no typescript delta");
 assert.equal(uncovered.details.compilerDiagnostics, null);
 writeFileSync(join(tmpdir(), "finish-path-timings.json"), JSON.stringify(timings, null, 2));
});

for (const tag of ["test", "code-grep"]) test(`explicit ${tag} runtime evidence satisfies ledger requirements without compiler substitution`, async t => {
 const { cwd, d } = await gitDiagnosticsFixture(t);
 const { worktreeRevision } = await import("../scope-gate.js");
 d.state.getAssertions = () => [{ id: "A1", tag, text: "UTC day semantics", source: "request", testCommand: "node --test utc.test.js", status: "open", evidence: "untrusted all green" }];
 d.dispatchAgent = async () => {
  writeFileSync(join(cwd, "semantic.js"), "export const utc = true;\n");
  const revision = worktreeRevision(cwd, []);
  return { output: "This prose grants nothing", exitCode: 0, elapsed: 1, dispatchId: "semantic", runtimeTests: [{ command: "node --test utc.test.js", exitCode: 0, beforeRevision: revision, afterRevision: revision }] };
 };
 const result = await createDispatchExecutor(d as any)("call", { agent: "builder", task: "A1 semantic check" }, undefined, undefined, { cwd } as any);
 const details = result.details as any;
 assert.equal(details.accepted, true);
 assert.equal(details.verificationResult.checks[0].kind, tag);
 assert.equal(details.verificationResult.checks[0].taskId, details.taskIdentity.id);
 assert.equal(details.verificationResult.evidenceRefs.includes("untrusted all green"), false);
 assert.deepEqual(details.verificationResult.requirements[0].claimedEvidenceRefs, ["untrusted all green"]);
 assert.ok(existsSync(details.verificationResult.checks[0].evidenceRef));
});

test("T4 check evidence separates observed command, declared coverage, and evaluated acceptance", async t => {
 for (const scenario of ["passed", "failed", "stale", "uncovered"] as const) {
  const { cwd, d } = await gitDiagnosticsFixture(t);
  const command = "node --test README.test.js";
  d.state.getAssertions = () => [{ id: "A1", tag: "test", text: "README corrected", source: "fixture", testCommand: command, status: "open", evidence: "untrusted claim" }];
  d.dispatchAgent = async () => {
   writeFileSync(join(cwd, "README.md"), `corrected ${scenario}\n`);
   const revision = worktreeRevision(cwd, []);
   return { output: "delivered", exitCode: 0, elapsed: 1, dispatchId: `t4-check-${scenario}`, runtimeTests: [{
    producer: "agent-fleet.runtime-test/v1",
    command: scenario === "uncovered" ? "node --test other.test.js" : command,
    exitCode: scenario === "failed" ? 1 : 0,
    beforeRevision: scenario === "stale" ? "prior-revision" : revision,
    afterRevision: revision,
   }] };
  };
  const result = await createDispatchExecutor(d as any)(scenario, { agent: "builder", task: `A1 check ${scenario}`, scope: ["README.md"] }, undefined, undefined, { cwd } as any);
  const details = result.details as any;
  const assessment = JSON.parse(readFileSync(details.assessmentPath, "utf8"));
  const requirement = assessment.verification.requirements.find((item: any) => item.id === "A1");
  assert.equal(assessment.execution.status, "completed", scenario);
  assert.deepEqual(requirement.claimedEvidenceRefs, ["untrusted claim"], scenario);
  assert.equal(assessment.verification.evidenceRefs.includes("untrusted claim"), false, scenario);
  if (scenario === "uncovered") {
   assert.deepEqual(assessment.verification.checks, [], "uncovered command is not approved check evidence");
   assert.equal(requirement.status, "missing");
   assert.deepEqual(requirement.evidenceRefs, []);
  } else {
   const check = assessment.verification.checks[0];
   const artifact = JSON.parse(readFileSync(check.evidenceRef, "utf8"));
   assert.equal(artifact.schema, "agent-fleet.runtime-test-evidence/v1");
   assert.equal(artifact.observation.producer, "agent-fleet.runtime-test/v1");
   assert.equal(artifact.observation.command, command);
   assert.equal(artifact.observation.exitCode, scenario === "failed" ? 1 : 0);
   assert.equal(artifact.declaration.taskId, assessment.task.id);
   assert.deepEqual(artifact.declaration.coverage, check.coverage);
   assert.deepEqual(artifact.declaration.coverage.map((item: any) => item.id), ["A1"]);
   assert.equal(artifact.requirements, undefined, "no pre-evaluation requirement status or evidence refs");
   assert.equal(artifact.evaluationSource, "agent-fleet.runtime-result/v1 verification.checks and verification.requirements");
   assert.equal(check.status, scenario);
   assert.equal(requirement.status, scenario);
   assert.deepEqual(requirement.evidenceRefs, [check.evidenceRef]);
   assert.ok(assessment.verification.evidenceRefs.includes(check.evidenceRef));
  }
  assert.equal(assessment.verification.status, scenario === "passed" ? "passed" : scenario === "uncovered" ? "missing" : scenario);
  assert.equal(assessment.acceptance.accepted, scenario === "passed", scenario);
  assert.equal(details.accepted, scenario === "passed", scenario);
 }
});

test("compiler evidence cannot be relabelled with a revision changed during verification", async t => {
 const { cwd, d } = await gitDiagnosticsFixture(t);
 d.dispatchAgent = async () => { writeFileSync(join(cwd, "src/api.ts"), "export const value = 2;\n"); return { output: "done", exitCode: 0, elapsed: 1 }; };
 d.diagnoseChangedTypeScript = async () => { writeFileSync(join(cwd, "src/api.ts"), "later unverified state\n"); return { status: "completed", projects: [{ argv: ["node", "tsc"], exitCode: 0, status: "passed", diagnostics: [] }], changedFiles: ["src/api.ts"], uncoveredFiles: [], attribution: "no_observed_overlap" } as any; };
 const result = await createDispatchExecutor(d as any)("call", { agent: "builder", task: "change" }, undefined, undefined, { cwd } as any);
 assert.equal((result.details as any).accepted, false); assert.equal((result.details as any).verificationResult.status, "stale");
});

test("already-running agent rejected before prepare consumes budget or poisons the next task", async () => {
 const d = prepareDeps(); let budgetChecks = 0, runs = 0; d.budgetRecovery.ensure = async () => { budgetChecks++; return null; };
 d.dispatchAgent = async () => { runs++; return { output: "done", exitCode: 0, elapsed: 0 }; };
 d.state.getAgentStates().get("builder").status = "running";
 const result = await createDispatchExecutor(d as any)("busy", { agent: "builder", task: "work" }, undefined, undefined, {} as any);
 assert.equal((result.details as any).status, "busy"); assert.equal(d.state.getTurnDispatchCount(), 0); assert.equal(budgetChecks, 0); assert.equal(runs, 0);
 d.state.getAgentStates().get("builder").status = "idle";
 const next = await createDispatchExecutor(d as any)("next", { agent: "builder", task: "new task after idle" }, undefined, undefined, {} as any);
 assert.equal((next.details as any).exitCode, 0); assert.equal(budgetChecks, 1); assert.equal(runs, 1);
});

async function highRiskChangedFixture(t: any) {
 const { cwd, d } = await gitDiagnosticsFixture(t);
 let process = applyProcessClassification(createProcessState(), { risk: "high", scope: "small", reason: "sensitive boundary" }).state;
 process = { ...process, plan: { ...process.plan, evidenceRef: "plan:approved", revision: "approved" } };
 d.state.getProcessState = () => process; d.state.setProcessState = (value: any) => { process = value; }; d.state.persistProcessVerdict = () => {};
 d._agents.set("code-reviewer", { def: { name: "code-reviewer", tools: "read" }, runCount: 0, lastBackend: "native" });
 d.diagnoseChangedTypeScript = async (paths: readonly string[]) => ({ status: "completed", changedFiles: [...paths], attribution: "no_observed_overlap", uncoveredFiles: [], projects: [{ status: "passed", exitCode: 0, argv: ["node", "tsc"], diagnostics: [], changedFiles: [...paths] }] } as any);
 d.dispatchAgent = async () => { writeFileSync(join(cwd, "src", "api.ts"), "export const value = 9;\n"); return { output: "done", exitCode: 0, elapsed: 1, dispatchId: "high-build" }; };
 await createDispatchExecutor(d as any)("build", { agent: "builder", task: "high risk change" }, undefined, undefined, { cwd } as any);
 assert.equal(process.review.required, true); assert.ok(process.changedFiles.includes("src/api.ts"));
 return { cwd, d, process: () => process };
}

test("T4 wide small: actual dispatch artifacts close plan then covered review without changing the two-dispatch cap", async t => {
 const { cwd, d } = await gitDiagnosticsFixture(t);
 const binding = { taskId: d.noProgress.taskId(), evaluationId: "evaluation", inputRevision: "input" };
 const revision = worktreeRevision(cwd, []);
 let process = applyTaskTriageAdditions(
  applyProcessClassification(createProcessState(), { risk: "low", scope: "small", reason: "declared" }).state,
  { status: "applied", reasons: ["wide_change"] }, binding);
 process = noteProcessStage(process, "acceptance", { evidenceRef: "test:verified", revision, changedFiles: ["src/api.ts"] });
 d.state.getProcessState = () => process; d.state.setProcessState = (value: any) => { process = value; };
 d._agents.set("planner", { def: { name: "planner", tools: "read" }, runCount: 0, lastBackend: "native" });
 d._agents.set("code-reviewer", { def: { name: "code-reviewer", tools: "read" }, runCount: 0, lastBackend: "native" });
 d.budget.currentTaskBudget = () => ({ maxDispatches: 2, maxResearch: 2, maxReviewRounds: 1 });
 d.budget.currentBudget = () => ({ maxDispatches: 2, maxResearch: 2 });
 let output = "Plan: inspect and update src/api.ts, then test and independently review the changed scope.";
 d.dispatchAgent = async () => ({ output, exitCode: 0, elapsed: 1, dispatchId: output.startsWith("Plan") ? "plan-run" : "review-run" });
 const execute = createDispatchExecutor(d as any);
 assert.equal(processPreEffectGate(process, "child", "builder")?.reason, "process_plan_open");
 const plan = await execute("plan", { agent: "planner", task: "Produce a plan" }, undefined, undefined, { cwd } as any);
 assert.ok((plan.details as any).returnPath, "the Hub persisted the actual producer response");
 assert.equal(process.plan.evidenceRef, (plan.details as any).returnPath);
 assert.equal((plan.details as any).processVerdict.obligations.review.status, "open");
 assert.equal((plan.details as any).accepted, false, "plan occurrence does not finish the task");
 output = "verdict: APPROVE\nCurrent src/api.ts changed scope inspected.\ntests_run: full regression";
 const review = await execute("review", { agent: "code-reviewer", task: "Review changed scope", scope: ["src/api.ts"] }, undefined, undefined, { cwd } as any);
 assert.equal(process.review.evidenceRef, (review.details as any).returnPath);
 assert.equal((review.details as any).processVerdict.accepted, true);
 assert.equal(d._task(), 2); assert.equal(d._turn(), 2);
 assert.equal(d.state.getTaskTier(), "small");
 assert.equal(d.budget.currentTaskBudget().maxDispatches, 2);
 assert.equal(evaluateProcessObligations(process, { writable: true, budgetTier: "small", currentRevision: revision }).obligations.plan.status, "satisfied");
 // Runtime acceptance of an artifact is still not independent semantic review of the plan or approval.
});

test("T4 human refusal at spent small dispatch cap leaves S1 review and proof open", async t => {
 const { cwd, d } = await gitDiagnosticsFixture(t);
 let process = applyTaskTriageAdditions(
  applyProcessClassification(createProcessState(), { risk: "low", scope: "small", reason: "declared" }).state,
  { status: "applied", reasons: ["security_change"] }, { taskId: "task", evaluationId: "evaluation", inputRevision: "input" });
 d.state.getProcessState = () => process; d.state.setProcessState = (value: any) => { process = value; };
 d._agents.set("code-reviewer", { def: { name: "code-reviewer", tools: "read" }, runCount: 0, lastBackend: "native" });
 d.state.setTaskDispatchCount(2);
 d.budget.currentTaskBudget = () => ({ maxDispatches: 2, maxResearch: 2, maxReviewRounds: 1 });
 let asks = 0, launches = 0;
 d.budgetRecovery.ensure = async () => { asks++; return { reason: "budget_stopped", message: "Human declined budget continuation." }; };
 d.dispatchAgent = async () => { launches++; return { output: "verdict: APPROVE", exitCode: 0, elapsed: 1 }; };
 const refusal = await createDispatchExecutor(d as any)("review", { agent: "code-reviewer", task: "review", scope: ["src/api.ts"] }, undefined, undefined, { cwd } as any);
 assert.equal((refusal.details as any).reason, "budget_stopped");
 assert.equal(asks, 1); assert.equal(launches, 0); assert.equal(d._task(), 2);
 assert.equal(process.review.evidenceRef, null);
 assert.equal(processPreEffectGate(process, "prove")?.reason, "process_obligations_open");
 assert.equal(evaluateProcessObligations(process, { writable: true, budgetTier: "small", t2Accepted: true }).accepted, false);
});

test("T4 an empty planner result cannot close the wide-small pre-effect gate", async t => {
 const { cwd, d } = await gitDiagnosticsFixture(t);
 let process = applyTaskTriageAdditions(createProcessState(), { status: "applied", reasons: ["wide_change"] }, { taskId: "t", evaluationId: "e", inputRevision: "r" });
 d.state.getProcessState = () => process; d.state.setProcessState = (value: any) => { process = value; };
 d._agents.set("planner", { def: { name: "planner", tools: "read" }, runCount: 0, lastBackend: "native" });
 d.dispatchAgent = async () => ({ output: "  ", exitCode: 0, elapsed: 1, dispatchId: "empty-plan" });
 const result = await createDispatchExecutor(d as any)("plan", { agent: "planner", task: "Plan" }, undefined, undefined, { cwd } as any);
 assert.ok((result.details as any).returnPath, "the empty dispatch still has a run artifact");
 assert.equal(process.plan.evidenceRef, null, "artifact existence alone is not plan evidence");
 assert.equal(processPreEffectGate(process, "write")?.reason, "process_plan_open");
 assert.equal((result.details as any).accepted, false);
});

test("T4 planner refusal with a missing declared plan cannot close the pre-effect gate", async t => {
 const { cwd, sessionDir, d } = await gitDiagnosticsFixture(t);
 let process = applyTaskTriageAdditions(createProcessState(), { status: "applied", reasons: ["wide_change"] }, { taskId: "t", evaluationId: "e", inputRevision: "r" });
 d.state.getProcessState = () => process; d.state.setProcessState = (value: any) => { process = value; };
 d._agents.set("planner", { def: { name: "planner", tools: "read,write" }, runCount: 0, lastBackend: "native" });
 const planPath = join(sessionDir, "artifacts", "plan", "synthetic-readme-fix.md");
 d.dispatchAgent = async () => ({ output: "I cannot provide a compliant plan handoff.\nrequires_user_decision: [Grant permission to create the plan artifact]", exitCode: 0, elapsed: 1, dispatchId: "refused-plan" });
 const result = await createDispatchExecutor(d as any)("plan", { agent: "planner", task: "Produce a plan", deliverables: [planPath] }, undefined, undefined, { cwd } as any);
 const details = result.details as any;
 assert.ok(details.returnPath, "a nonempty exit-0 refusal still has a retained return");
 assert.equal(details.deliverableReadback[0].status, "missing");
 assert.equal(details.acceptanceStatus, "deliverable_failed");
 assert.deepEqual(details.structuredReturn.requires_user_decision, ["Grant permission to create the plan artifact"]);
 assert.equal(process.plan.evidenceRef, null);
 assert.equal(processPreEffectGate(process, "write")?.reason, "process_plan_open");
});

test("T4 planner substantive parsed user decision blocks even without a declared deliverable", async t => {
 const { cwd, d } = await gitDiagnosticsFixture(t);
 let process = applyTaskTriageAdditions(createProcessState(), { status: "applied", reasons: ["wide_change"] }, { taskId: "t", evaluationId: "e", inputRevision: "r" });
 d.state.getProcessState = () => process; d.state.setProcessState = (value: any) => { process = value; };
 d._agents.set("planner", { def: { name: "planner", tools: "read" }, runCount: 0, lastBackend: "native" });
 d.dispatchAgent = async () => ({ output: "Plan pending decision.\nrequires_user_decision: [Which file should be edited?]", exitCode: 0, elapsed: 1, dispatchId: "decision-plan" });
 const result = await createDispatchExecutor(d as any)("plan", { agent: "planner", task: "Plan" }, undefined, undefined, { cwd } as any);
 assert.deepEqual((result.details as any).structuredReturn.requires_user_decision, ["Which file should be edited?"]);
 assert.equal(process.plan.evidenceRef, null);
 assert.equal(processPreEffectGate(process, "write")?.reason, "process_plan_open");
});

test("T4 fenced empty planner decision closes only with a readback plan and no real question", async t => {
 for (const scenario of ["empty", "question", "ask", "missing"] as const) {
  const { cwd, sessionDir, d } = await gitDiagnosticsFixture(t);
  let process = applyTaskTriageAdditions(createProcessState(), { status: "applied", reasons: ["wide_change"] }, { taskId: "t", evaluationId: "e", inputRevision: "r" });
  d.state.getProcessState = () => process; d.state.setProcessState = (value: any) => { process = value; };
  d._agents.set("planner", { def: { name: "planner", tools: "read,write" }, runCount: 0, lastBackend: "native" });
  d.extractAskUserQuestions = extractAskUserQuestions;
  const planPath = join(sessionDir, "artifacts", "plans", "synthetic-readme-fix.md");
  d.dispatchAgent = async () => {
   if (scenario !== "missing") {
    mkdirSync(join(sessionDir, "artifacts", "plans"), { recursive: true });
    writeFileSync(planPath, "Correct only the synthetic typo; builder verifies.\n");
   }
   return { output: `Artifact: artifacts/plans/synthetic-readme-fix.md\n\nStructured return:\n\`\`\`text\nchanged_files: [artifacts/plans/synthetic-readme-fix.md — typo-only plan]\nassertions_proven: []\nassertions_unproven: [A1 — builder verifies]\nassertions_failed: []\ntests_run: []\nopen_risks: []\nrequires_user_decision: ${scenario === "question" ? "[Which file should be edited?]" : "[]"}\n\`\`\`${scenario === "ask" ? "\nASK_USER: Which file should be edited?" : ""}`, exitCode: 0, elapsed: 1, dispatchId: `fenced-${scenario}` };
  };
  const result = await createDispatchExecutor(d as any)(scenario, { agent: "planner", task: "Produce a plan", deliverables: [planPath] }, undefined, undefined, { cwd } as any);
  const details = result.details as any;
  assert.equal(details.deliverableReadback[0].status, scenario === "missing" ? "missing" : "read", scenario);
  assert.deepEqual(details.structuredReturn.requires_user_decision, scenario === "question" ? ["Which file should be edited?"] : [], scenario);
  assert.equal(process.plan.evidenceRef, scenario === "empty" ? details.returnPath : null, scenario);
  assert.equal(details.processVerdict.obligations.plan.status, scenario === "empty" ? "satisfied" : "open", scenario);
  assert.equal(processPreEffectGate(process, "write")?.reason, scenario === "empty" ? undefined : "process_plan_open", scenario);
 }
});

test("T4 planner with a real declared plan and literal none decision still closes plan", async t => {
 const { cwd, sessionDir, d } = await gitDiagnosticsFixture(t);
 let process = applyTaskTriageAdditions(createProcessState(), { status: "applied", reasons: ["wide_change"] }, { taskId: "t", evaluationId: "e", inputRevision: "r" });
 d.state.getProcessState = () => process; d.state.setProcessState = (value: any) => { process = value; };
 d._agents.set("planner", { def: { name: "planner", tools: "read,write" }, runCount: 0, lastBackend: "native" });
 const planPath = join(sessionDir, "artifacts", "plan", "synthetic-readme-fix.md");
 d.dispatchAgent = async () => {
  mkdirSync(join(sessionDir, "artifacts", "plan"), { recursive: true });
  writeFileSync(planPath, "Inspect README, correct the typo, run the declared check.\n");
  return { output: "Plan: correct only the README typo and check.\nrequires_user_decision: [none]", exitCode: 0, elapsed: 1, dispatchId: "valid-plan" };
 };
 const result = await createDispatchExecutor(d as any)("plan", { agent: "planner", task: "Produce a plan", deliverables: [planPath] }, undefined, undefined, { cwd } as any);
 const details = result.details as any;
 assert.equal(details.deliverableReadback[0].status, "read");
 assert.equal(details.deliverableReadback[0].changed, true);
 assert.deepEqual(details.structuredReturn.requires_user_decision, ["none"]);
 assert.equal(process.plan.evidenceRef, details.returnPath);
 assert.equal(details.processVerdict.obligations.plan.status, "satisfied");
});

async function runtimeEvidenceReviewFixture(t: any, unrelated = false, protectEvidence = false) {
 const { cwd, sessionDir, d } = await gitDiagnosticsFixture(t);
 let process = applyProcessClassification(createProcessState(), { risk: "low", scope: "wide", reason: "review task change" }).state;
 process = noteProcessStage(process, "plan", { evidenceRef: "test:plan", revision: worktreeRevision(cwd, []) });
 d.state.getProcessState = () => process; d.state.setProcessState = (value: any) => { process = value; };
 d._agents.set("code-reviewer", { def: { name: "code-reviewer", tools: "read" }, runCount: 0, lastBackend: "native" });
 d.budget.currentBudget = () => ({ maxDispatches: 8, maxResearch: 2 });
 const command = "node --test README.test.js";
 if (protectEvidence) {
  mkdirSync(join(sessionDir, "artifacts", "watchdog"), { recursive: true });
  writeFileSync(join(sessionDir, "artifacts", "watchdog", "events.jsonl"), "");
 }
 d.state.getAssertions = () => [{ id: "A1", tag: "test", text: "README edit", source: "fixture", testCommand: command, status: "open" }];
 d.dispatchAgent = async () => {
  writeFileSync(join(cwd, "README.md"), "fixed fixture\n");
  mkdirSync(join(sessionDir, "artifacts", "watchdog"), { recursive: true });
  mkdirSync(join(sessionDir, "dispatches", "run"), { recursive: true });
  writeFileSync(join(sessionDir, "artifacts", "watchdog", "events.jsonl"), "event\n");
  writeFileSync(join(sessionDir, "dispatches", "run", "result.json"), "{}\n");
  if (unrelated) writeFileSync(join(cwd, "src", "new-source.js"), "unrelated\n");
  const revision = worktreeRevision(cwd, []);
  return { output: "README fixed", exitCode: 0, elapsed: 1, dispatchId: "build-evidence", runtimeTests: [{ command, exitCode: 0, beforeRevision: revision, afterRevision: revision }] };
 };
 const execute = createDispatchExecutor(d as any);
 const build = await execute("build", { agent: "builder", task: "A1 README change", scope: ["README.md", ...(protectEvidence ? [".pi/agent-sessions/sessions/test/artifacts/watchdog/events.jsonl"] : [])] }, undefined, undefined, { cwd } as any);
 assert.equal((build.details as any).verificationResult.status, "passed");
 assert.equal(process.acceptance.evidenceRef != null, true);
 return { cwd, sessionDir, d, execute, process: () => process };
}

test("T11 approved README review closes over generated current-session runtime evidence", async t => {
 const { cwd, d, execute, process } = await runtimeEvidenceReviewFixture(t);
 assert.deepEqual(process().changedFiles, ["README.md"]);
 d.dispatchAgent = async () => ({ output: "VERDICT: APPROVE\ntests_run: full regression", exitCode: 0, elapsed: 1, dispatchId: "review-evidence" });
 const result = await execute("review", { agent: "code-reviewer", task: "review README", scope: ["README.md"] }, undefined, undefined, { cwd } as any);
 assert.equal((result.details as any).processVerdict.obligations.review.status, "satisfied");
 assert.equal((result.details as any).processVerdict.accepted, true);
 assert.deepEqual((result.details as any).processVerdict.auditScope, ["README.md"]);
});

test("T11 explicitly scoped edits to runtime-path evidence still require review coverage", async t => {
 const { cwd, d, execute, process } = await runtimeEvidenceReviewFixture(t, false, true);
 assert.deepEqual(process().changedFiles, [".pi/agent-sessions/sessions/test/artifacts/watchdog/events.jsonl", "README.md"]);
 d.dispatchAgent = async () => ({ output: "VERDICT: APPROVE", exitCode: 0, elapsed: 1, dispatchId: "review-task-evidence" });
 const result = await execute("review", { agent: "code-reviewer", task: "review README only", scope: ["README.md"] }, undefined, undefined, { cwd } as any);
 assert.equal((result.details as any).processVerdict.obligations.review.status, "open");
 assert.equal(process().review.evidenceRef, null);
});

test("T11 runtime evidence exclusion does not hide unrelated user source or bypass verdict/scope/staleness", async t => {
 // Separate task fixtures prevent an earlier review's guard/budget state from deciding a later case.
 const partialFixture = await runtimeEvidenceReviewFixture(t, true);
 assert.deepEqual(partialFixture.process().changedFiles, ["README.md", "src/new-source.js"]);
 partialFixture.d.dispatchAgent = async () => ({ output: "VERDICT: APPROVE", exitCode: 0, elapsed: 1, dispatchId: "review-partial" });
 const partial = await partialFixture.execute("partial", { agent: "code-reviewer", task: "partial", scope: ["README.md"] }, undefined, undefined, { cwd: partialFixture.cwd } as any);
 assert.equal((partial.details as any).executionStatus, "completed", "partial review must reach the reviewer");
 assert.deepEqual((partial.details as any).processVerdict.auditScope, ["README.md", "src/new-source.js"]);
 assert.equal((partial.details as any).processVerdict.obligations.review.status, "open");
 assert.equal((partial.details as any).processVerdict.accepted, false);
 assert.equal(partialFixture.process().review.evidenceRef, null);

 const rejectFixture = await runtimeEvidenceReviewFixture(t, true);
 assert.deepEqual(rejectFixture.process().changedFiles, ["README.md", "src/new-source.js"]);
 rejectFixture.d.dispatchAgent = async () => ({ output: "VERDICT: REJECT", exitCode: 0, elapsed: 1, dispatchId: "review-reject" });
 const rejected = await rejectFixture.execute("reject", { agent: "code-reviewer", task: "reject", scope: ["README.md", "src/new-source.js"] }, undefined, undefined, { cwd: rejectFixture.cwd } as any);
 assert.equal((rejected.details as any).executionStatus, "completed", "REJECT must reach the reviewer");
 assert.deepEqual((rejected.details as any).processVerdict.auditScope, ["README.md", "src/new-source.js"]);
 assert.equal((rejected.details as any).processVerdict.obligations.review.status, "open");
 assert.equal((rejected.details as any).processVerdict.accepted, false);
 assert.equal(rejectFixture.process().review.evidenceRef, null);

 const staleFixture = await runtimeEvidenceReviewFixture(t, true);
 assert.deepEqual(staleFixture.process().changedFiles, ["README.md", "src/new-source.js"]);
 const verifiedRevision = staleFixture.process().acceptance.revision;
 writeFileSync(join(staleFixture.cwd, "README.md"), "changed after verified revision\n");
 staleFixture.d.dispatchAgent = async () => ({ output: "VERDICT: APPROVE\ntests_run: full regression", exitCode: 0, elapsed: 1, dispatchId: "review-stale" });
 const stale = await staleFixture.execute("stale", { agent: "code-reviewer", task: "stale", scope: ["README.md", "src/new-source.js"] }, undefined, undefined, { cwd: staleFixture.cwd } as any);
 assert.equal((stale.details as any).executionStatus, "completed", "stale review must reach the reviewer");
 assert.deepEqual((stale.details as any).processVerdict.auditScope, ["README.md", "src/new-source.js"]);
 assert.notEqual(worktreeRevision(staleFixture.cwd, []), verifiedRevision);
 assert.equal(staleFixture.process().acceptance.revision, verifiedRevision);
 assert.equal((stale.details as any).processVerdict.obligations.review.status, "satisfied");
 assert.equal(staleFixture.process().review.revision, worktreeRevision(staleFixture.cwd, []));
 assert.equal((stale.details as any).processVerdict.obligations.acceptance.status, "open");
 assert.equal((stale.details as any).processVerdict.accepted, false);
});

test("T11 reviewer REJECT cannot satisfy the open review obligation", async t => {
 const { cwd, d, process } = await highRiskChangedFixture(t);
 d.dispatchAgent = async () => ({ output: "verdict: REJECT\nfindings remain", exitCode: 0, elapsed: 1, dispatchId: "rev-reject" });
 await createDispatchExecutor(d as any)("rev", { agent: "code-reviewer", task: "review", scope: ["src/api.ts"] }, undefined, undefined, { cwd } as any);
 assert.equal(process().review.evidenceRef, null);
 assert.equal(process().review.required, true);
});

test("T11 reviewer APPROVE with partial changed-file overlap cannot satisfy review", async t => {
 const { cwd, d, process } = await highRiskChangedFixture(t);
 d.dispatchAgent = async () => ({ output: "verdict: APPROVE", exitCode: 0, elapsed: 1, dispatchId: "rev-partial" });
 await createDispatchExecutor(d as any)("rev", { agent: "code-reviewer", task: "review", scope: ["README.md"] }, undefined, undefined, { cwd } as any);
 assert.equal(process().review.evidenceRef, null);
});

test("T11 reviewer APPROVE covering current changed files records review at current revision", async t => {
 const { cwd, d, process } = await highRiskChangedFixture(t);
 d.dispatchAgent = async () => ({ output: "verdict: APPROVE", exitCode: 0, elapsed: 1, dispatchId: "rev-ok" });
 await createDispatchExecutor(d as any)("rev", { agent: "code-reviewer", task: "review", scope: ["src/api.ts"] }, undefined, undefined, { cwd } as any);
 assert.ok(process().review.evidenceRef);
 assert.equal(process().review.revision, process().acceptance.revision);
});

test("empty roster names explicit human role recovery without tier escalation", async t => {
 const { d } = await highRiskChangedFixture(t);
 d.state.getAgentStates().clear();
 const refusal = validateDispatchAgent(d as any, "code-reviewer", "review");
 assert.match((refusal!.content[0] as any).text, /\/af-agents-add code-reviewer|\/af-agents-team/);
 assert.equal((refusal!.details as any).status, "unknown_agent");
});

test("partial roster still names the missing required role recovery", async t => {
 const { d } = await highRiskChangedFixture(t);
 d.state.getAgentStates().clear();
 d.state.getAgentStates().set("builder", { def: { name: "builder" } });
 for (const role of ["planner", "code-reviewer"]) {
  const refusal = validateDispatchAgent(d as any, role, "required stage");
  assert.match((refusal!.content[0] as any).text, new RegExp(`/af-agents-add ${role}`));
 }
});

test("process-required reviewer is not refused by docs-lane hint", async t => {
 const { cwd, d } = await highRiskChangedFixture(t);
 const blocked = await createDispatchExecutor(d as any)("docs", { agent: "code-reviewer", task: "review docs", scope: ["README.md"] }, undefined, undefined, { cwd } as any);
 assert.notEqual((blocked.details as any).status, "docs_only_lane");
 const allowed = await createDispatchExecutor(d as any)("docs-ok", { agent: "code-reviewer", task: "review docs", scope: ["README.md"], review_reason: "docs-only closeout" }, undefined, undefined, { cwd } as any);
 assert.notEqual((allowed.details as any).status, (blocked.details as any).status);
});

test("T11 unknown risk still allows research and still refuses changed-task acceptance", async t => {
 const { cwd, d } = await gitDiagnosticsFixture(t);
 let process = createProcessState();
 d.state.getProcessState = () => process; d.state.setProcessState = (value: any) => { process = value; };
 (d.research as any).anonymousDef = () => ({ name: "researcher" });
 (d.research as any).resolveModel = () => "test/model";
 (d.research as any).createState = () => ({ id: 7 });
 let spawned = 0;
 (d.research as any).spawn = async () => { spawned++; return { output: "notes", exitCode: 0, elapsed: 1 }; };
 const research = await createResearchExecutor(d as any)("r", { task: "trace callers" }, undefined, undefined, { cwd } as any);
 assert.equal(spawned, 1); assert.equal((research.details as any).exitCode, 0);
 d.dispatchAgent = async () => { writeFileSync(join(cwd, "src", "api.ts"), "export const value = 8;\n"); return { output: "done", exitCode: 0, elapsed: 1, dispatchId: "unk" }; };
 d.diagnoseChangedTypeScript = async (paths: readonly string[]) => ({ status: "completed", changedFiles: [...paths], attribution: "no_observed_overlap", uncoveredFiles: [], projects: [{ status: "passed", exitCode: 0, argv: ["node", "tsc"], diagnostics: [], changedFiles: [...paths] }] } as any);
 const changed = await createDispatchExecutor(d as any)("b", { agent: "builder", task: "change" }, undefined, undefined, { cwd } as any);
 assert.equal((changed.details as any).accepted, false);
 assert.equal((changed.details as any).processVerdict.obligations.risk.status, "open");
});

test("high-risk work without an approved plan cannot skip the planner", async () => {
 const d = prepareDeps({ agents: ["builder"] });
 let process = applyProcessClassification(createProcessState(), { risk: "high", scope: "small", reason: "sensitive" }).state;
 d.state.getProcessState = () => process;
 const result = await createDispatchExecutor(d as any)("high", { agent: "builder", task: "change the boundary" }, undefined, undefined, { cwd: "/tmp" } as any);
 assert.equal((result.details as any).status, "planner_required");
});

test("secret work cannot skip the planner by calling itself small", async () => {
 const d = prepareDeps({ agents: ["builder"] });
 const result = await createDispatchExecutor(d as any)("secret", { agent: "builder", task: "small change to the cloud credential" }, undefined, undefined, { cwd: "/tmp" } as any);
 assert.equal((result.details as any).status, "planner_required");
});

test("ASK_USER blocks the dispatch without a verification failure", async () => {
 const d = prepareDeps({ agents: ["builder"] });
 d.extractAskUserQuestions = extractAskUserQuestions;
 let calls = 0;
 d.dispatchAgent = async () => { calls++; return { output: "Need a decision.\nASK_USER: Which file should be edited?", exitCode: 0, elapsed: 1, dispatchId: "ask-1" }; };
 const result = await createDispatchExecutor(d as any)("ask", { agent: "builder", task: "edit" }, undefined, undefined, { cwd: "/tmp" } as any);
 const details = result.details as any;
 assert.equal(details.status, "blocked_on_user");
 assert.notEqual(details.status, "verification_failed");
 assert.equal(details.recoveryCategory, "blocked_on_user");
 assert.equal(details.orchestration.routingChanged, false);
 assert.ok(details.orchestration.manifest);
 assert.equal(calls, 1);
 assert.deepEqual(details.questions, ["Which file should be edited?"]);
});

test("missing report stays a contract gap when ASK_USER is also present", async () => {
 const d = prepareDeps({ agents: ["builder"] });
 d.extractAskUserQuestions = extractAskUserQuestions;
 d.dispatchAgent = async () => ({ output: "ASK_USER: Where is the report?", exitCode: 0, elapsed: 1, dispatchId: "ask-missing" });
 const result = await createDispatchExecutor(d as any)("missing", { agent: "builder", task: "edit", deliverables: ["/tmp/missing-report.md"] }, undefined, undefined, { cwd: "/tmp" } as any);
 const details = result.details as any;
 assert.equal(details.status, "blocked_on_user");
 assert.equal(details.acceptanceStatus, "deliverable_failed");
 assert.equal(details.contractGap, "missing_deliverable");
 assert.notEqual(details.recoveryCategory, "verification_failed");
});
