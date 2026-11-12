import { createNoProgressGuard } from "../no-progress.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { createDispatchExecutor, createResearchExecutor, prepareDispatch, structuredResearchPrompt, validateDispatchAgent } from "./dispatch-execution.ts";
import { applyProcessClassification, createProcessState, noteProcessStage, processPreEffectGate, evaluateProcessObligations, processAuditRecord, latestProcessState, normalizeProcessState } from "../process-obligations.ts";
import { adoptTaskTriageState, applyTaskTriageAdditions } from "../task-triage-obligations.ts";
import { createActionExecutors } from "./action-executors.ts";
import { createTaskTriageRuntime } from "../task-triage-runtime.ts";
import { TASK_TRIAGE_QUESTIONS, TASK_TRIAGE_QUESTION_VERSION } from "../task-triage-contract.ts";
import { worktreeRevision } from "../scope-gate.js";
import { extractAskUserQuestions } from "../presentation.ts";
import { activeOrchestrationHandoff } from "../orchestration-activation.ts";

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
			taskActiveElapsedMs: () => 0,
			currentBudget: () => ({ agentTurnMs: 600_000, recycleRuns: 3, delegation: false }),
			updateModeStatus() {},
		},
		artifacts: {
			writeRunArtifact: () => "/tmp/tool-result.md",
			loadInputArtifacts: () => [],
		},
		research: {},
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
	assert.match((result as any).content[0].text, /Installed agents: builder/);
	assert.match((result as any).content[0].text, /Do not invent a substitute dispatch/);
	assert.equal(d._turn(), 0);
	assert.equal(d._task(), 0);
});

test("an admitted dispatch is recorded in the task brief with its scope; a refused one is not", () => {
	const d = prepareDeps({ agents: ["builder"] });
	const recorded: any[] = [];
	(d.state as any).recordDelegation = (entry: any) => recorded.push(entry);
	prepareDispatch(d as any, { agent: "not-a-real-agent", task: "do work" } as any, {} as any);
	assert.deepEqual(recorded, [], "refusals never reach the brief");
	const prepared = prepareDispatch(d as any, { agent: "builder", task: "Implement the parser", scope: ["package.json"] } as any, { cwd: process.cwd() } as any) as any;
	assert.equal(prepared.agent, "builder", JSON.stringify(prepared.content ?? prepared.details ?? {}));
	assert.deepEqual(recorded, [{ agent: "builder", kind: "specialist", task: "Implement the parser", scope: ["package.json"] }]);
});

test("dispatch_agent researcher redirects to spawn_research without consuming budget", () => {
	const d = prepareDeps({ agents: ["builder"], research: ["researcher", "deep-researcher"] });
	const result = prepareDispatch(d as any, { agent: "researcher", task: "look around" } as any, {} as any);
	assert.equal((result as any).details.status, "research_persona_via_dispatch");
	assert.match((result as any).content[0].text, /spawn_research/);
	assert.match((result as any).content[0].text, /Installed agents: builder/);
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

test("busy dispatch refuses immediately before usage accounting and does not abort parent", async () => {
	const d = prepareDeps(); let runs = 0, aborts = 0; let release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	d.dispatchAgent = async () => { runs++; await gate; return { output: "done", exitCode: 0, elapsed: 1 }; };
	const execute = createDispatchExecutor(d as any); const params = { agent: "builder", task: "same operation", scope: [] };
	const first = execute("one", params, undefined, undefined, { abort: () => { aborts++; } } as any);
	await new Promise(resolve => setImmediate(resolve));
	const busy = await execute("two", { ...params, task: "paraphrased" }, undefined, undefined, { abort: () => { aborts++; } } as any);
	assert.equal((busy.details as any).status, "busy"); assert.equal((busy.details as any).started, false);
	assert.equal((busy.details as any).recoveryCategory, "busy"); assert.equal(d._turn(), 1, "only the running dispatch is counted"); assert.equal(runs, 1); assert.equal(aborts, 0);
	release(); await first;
});

for (const operation of ["dispatch", "research"] as const) {
	test(`${operation} honors cancellation before launch and charges nothing`, async () => {
		const d = prepareDeps(); const controller = new AbortController(); let runs = 0;
		controller.abort();
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
 let executions = 0;
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
 assert.equal(executions, 1);
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

test("missing scope roots refuse before accounting or dispatch", async () => {
 const d = prepareDeps(); let invoked = false;
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

/** Stub stand-in for a launched native settlement. Production spawn always publishes parser-owned capture integrity (see the real-spawn tests below); a stub without it now fails closed at the parent, for fresh checks as well as receipt reuse. */
const nativeCleanLifecycle={launched:true,closeSeen:true,runtimeCaptureIntegrity:'complete' as const};

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

test("a missing submit_result is recovered by extraction only when the profile opts in", async () => {
 for (const optIn of [false, true]) {
  const d = prepareDeps(); let extracted = 0;
  d.dispatchAgent = async () => ({ output: "prose-only report", exitCode: 0, elapsed: 1, specialistResultTool: true, dispatchId: `missing-${optIn}` });
  d.runReturnExtraction = async () => { extracted++; return { changed_files: [], assertions_proven: [], assertions_unproven: [{ id: "A1", note: "report leaves it open" }], assertions_failed: [], tests_run: [], open_risks: [], requires_user_decision: [] }; };
  (d as any).returnExtractionAssist = () => optIn;
  const result = await createDispatchExecutor(d as any)("call", { agent: "builder", task: "A1 bounded work" }, undefined, undefined, {} as any);
  assert.equal(extracted, optIn ? 1 : 0);
  assert.equal((result.details as any).returnExtracted, optIn);
  assert.equal((result.details as any).resultProtocol, "submission_missing", "an extracted report is never relabelled as a submission");
 }
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

test("a writable dispatch observes the worktree once before and once after the run", () => {
 const source = readFileSync(new URL("./dispatch-execution.ts", import.meta.url), "utf8");
 const prepare = source.slice(source.indexOf("export function prepareDispatch"), source.indexOf("function startTracking"));
 assert.equal((prepare.match(/snapshotWorktree\(|worktreeRevision\(/g) ?? []).length, 1, "revision baseline and delta base share one snapshot");
 assert.match(source, /tracking\.snapshot = prepared\.beforeSnapshot \?\?/);
 assert.match(source, /compilerInspectedRevision = observation && !observation\.skipped && observation\.snapshot \? snapshotRevision\(observation\.snapshot\)/);
 assert.match(source, /repositoryAfterRevision = compilerRan \? worktreeRevision\(cwd, \[\], p\.scopeGlobs\) : compilerInspectedRevision/, "only an awaited compiler run re-observes");
 assert.match(source, /const afterRevision = p\.privateConfig \? privateConfigRevision\(cwd, repositoryAfterRevision, p\.privateConfig\) : repositoryAfterRevision/, "old modes retain the repository observation unchanged");
});

test("real native executor finishDispatch times workflows compiler and demotes on changed-file errors", async t => {
 const sourceRepo = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
 const repo = mkdtempSync(join(tmpdir(), "finish-hook-repo-")); t.after(() => rmSync(repo, { recursive: true, force: true }));
 const workflowDir = join(repo, ".pi/agent-fleet/scripts/workflows"); mkdirSync(join(repo, ".pi/agent-fleet/scripts"), { recursive: true });
 cpSync(join(sourceRepo, ".pi/agent-fleet/scripts/workflows"), workflowDir, { recursive: true });
 // Workflows resolve shared policy roots relative to their installed runtime tree.
 const harnessLibDir = join(repo, ".pi/harnesses/lib"); mkdirSync(harnessLibDir, { recursive: true });
 for(const file of ['policy-roots.ts','policy-roots.js','safe-source-read.js','workspace-context.ts','workspace-context.js'])cpSync(join(sourceRepo,'.pi/harnesses/lib',file),join(harnessLibDir,file));
 // Mirror the installed scripts-local dependencies as well as the root compiler.
 symlinkSync(join(sourceRepo, ".pi/agent-fleet/scripts/node_modules"), join(repo, ".pi/agent-fleet/scripts/node_modules"), "dir");
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
  return { output: "This prose grants nothing", exitCode: 0, elapsed: 1, dispatchId: "semantic", lifecycle: nativeCleanLifecycle, runtimeTests: [{ command: "node --test utc.test.js", exitCode: 0, beforeRevision: revision, afterRevision: revision }] };
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
   return { output: "delivered", exitCode: 0, elapsed: 1, dispatchId: `t4-check-${scenario}`, lifecycle: nativeCleanLifecycle, runtimeTests: [{
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

test("already-running agent rejected before prepare consumes usage or poisons the next task", async () => {
 const d = prepareDeps(); let runs = 0;
 d.dispatchAgent = async () => { runs++; return { output: "done", exitCode: 0, elapsed: 0 }; };
 d.state.getAgentStates().get("builder").status = "running";
 const result = await createDispatchExecutor(d as any)("busy", { agent: "builder", task: "work" }, undefined, undefined, {} as any);
 assert.equal((result.details as any).status, "busy"); assert.equal(d.state.getTurnDispatchCount(), 0); assert.equal(runs, 0);
 d.state.getAgentStates().get("builder").status = "idle";
 const next = await createDispatchExecutor(d as any)("next", { agent: "builder", task: "new task after idle" }, undefined, undefined, {} as any);
 assert.equal((next.details as any).exitCode, 0); assert.equal(d.state.getTurnDispatchCount(), 1); assert.equal(runs, 1);
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

test("T4 wide small: optional plan artifact and covered review preserve accounting", async t => {
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
 let output = "Plan: inspect and update src/api.ts, then test and independently review the changed scope.";
 d.dispatchAgent = async () => ({ output, exitCode: 0, elapsed: 1, dispatchId: output.startsWith("Plan") ? "plan-run" : "review-run" });
 const execute = createDispatchExecutor(d as any);
 assert.equal(processPreEffectGate(process, "child", "builder")?.reason, undefined);
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
 assert.equal(evaluateProcessObligations(process, { writable: true, budgetTier: "small", currentRevision: revision }).obligations.plan.status, "satisfied");
 // Runtime acceptance of an artifact is still not independent semantic review of the plan or approval.
});

test("T4 an empty optional planner result cannot fabricate plan evidence", async t => {
 const { cwd, d } = await gitDiagnosticsFixture(t);
 let process = applyTaskTriageAdditions(createProcessState(), { status: "applied", reasons: ["wide_change"] }, { taskId: "t", evaluationId: "e", inputRevision: "r" });
 d.state.getProcessState = () => process; d.state.setProcessState = (value: any) => { process = value; };
 d._agents.set("planner", { def: { name: "planner", tools: "read" }, runCount: 0, lastBackend: "native" });
 d.dispatchAgent = async () => ({ output: "  ", exitCode: 0, elapsed: 1, dispatchId: "empty-plan" });
 const result = await createDispatchExecutor(d as any)("plan", { agent: "planner", task: "Plan" }, undefined, undefined, { cwd } as any);
 assert.ok((result.details as any).returnPath, "the empty dispatch still has a run artifact");
 assert.equal(process.plan.evidenceRef, null, "artifact existence alone is not plan evidence");
 assert.equal(processPreEffectGate(process, "write")?.reason, undefined);
 assert.equal((result.details as any).accepted, false);
});

test("T4 optional planner refusal and missing artifact cannot fabricate plan evidence", async t => {
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
 assert.equal(processPreEffectGate(process, "write")?.reason, undefined);
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
 assert.equal(processPreEffectGate(process, "write")?.reason, undefined);
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
  assert.equal(details.processVerdict.obligations.plan.status, "satisfied", scenario);
  assert.equal(processPreEffectGate(process, "write")?.reason, undefined, scenario);
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
  return { output: "README fixed", exitCode: 0, elapsed: 1, dispatchId: "build-evidence", lifecycle: nativeCleanLifecycle, runtimeTests: [{ command, exitCode: 0, beforeRevision: revision, afterRevision: revision }] };
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

test("an area review beside a running parallel writer never closes the task review; the final one does", async t => {
 const { cwd, d, process } = await highRiskChangedFixture(t);
 const writers: any[] = [{ agent: "builder", scope: ["src/other"], isolated: true }];
 (d.state as any).getActiveWriters = () => writers;
 (d.state as any).beginWriter = (entry: any) => { writers.push(entry); return () => { writers.splice(writers.indexOf(entry), 1); }; };
 d.dispatchAgent = async () => ({ output: "verdict: APPROVE", exitCode: 0, elapsed: 1, dispatchId: "rev-area" });
 const area = await createDispatchExecutor(d as any)("rev-a", { agent: "code-reviewer", task: "review the api area", scope: ["src/api.ts"], parallel: true }, undefined, undefined, { cwd } as any) as any;
 assert.ok(!process().review.evidenceRef, "an area review is not the task's review");
 assert.match(area.content[0].text, /Area review: builder was still writing/);
 assert.deepEqual(writers.map(w => w.agent), ["builder"], "the reviewer's own registration was released");

 writers.length = 0;
 d.dispatchAgent = async () => ({ output: "verdict: APPROVE", exitCode: 0, elapsed: 1, dispatchId: "rev-final" });
 const final = await createDispatchExecutor(d as any)("rev-f", { agent: "code-reviewer", task: "final review of the whole change", scope: ["src/api.ts"] }, undefined, undefined, { cwd } as any) as any;
 assert.ok(process().review.evidenceRef, "the final review with no writer active closes it");
 assert.doesNotMatch(final.content[0].text, /Area review/);
});

test("T11 reviewer APPROVE covering current changed files records review at current revision", async t => {
 const { cwd, d, process } = await highRiskChangedFixture(t);
 d.dispatchAgent = async () => ({ output: "verdict: APPROVE", exitCode: 0, elapsed: 1, dispatchId: "rev-ok" });
 await createDispatchExecutor(d as any)("rev", { agent: "code-reviewer", task: "review", scope: ["src/api.ts"] }, undefined, undefined, { cwd } as any);
 assert.ok(process().review.evidenceRef);
 assert.equal(process().review.revision, process().acceptance.revision);
});

test("an installed agent outside the active team is added on first dispatch and notified", async t => {
 const { d } = await highRiskChangedFixture(t);
 d.state.getAgentStates().clear();
 d.state.getAgentStates().set("builder", { def: { name: "builder" } });
 const added: string[] = [], notices: string[] = [];
 (d.state as any).getInstalledAgentNames = () => ["builder", "code-reviewer", "planner"];
 (d.state as any).addInstalledAgent = (name: string) => {
  if (!["code-reviewer", "planner"].includes(name)) return null;
  added.push(name); d.state.getAgentStates().set(name, { def: { name } });
  return { ok: true, message: `${name} added to the active team` };
 };
 const ctx = { ui: { notify: (text: string) => notices.push(text) } } as any;
 for (const role of ["planner", "code-reviewer"]) assert.equal(validateDispatchAgent(d as any, role, "required stage", ctx), null, role);
 assert.deepEqual(added, ["planner", "code-reviewer"]);
 assert.ok(notices.every(text => /added to the active team/.test(text)) && notices.length === 2);
 assert.equal(validateDispatchAgent(d as any, "planner", "again", ctx), null, "already on the team: no second add");
 assert.equal(added.length, 2);
});

test("an agent that is not installed is refused with the installed list and no human slash recovery", async t => {
 const { d } = await highRiskChangedFixture(t);
 d.state.getAgentStates().clear();
 (d.state as any).getInstalledAgentNames = () => ["builder", "code-reviewer"];
 (d.state as any).addInstalledAgent = () => null;
 const refusal = validateDispatchAgent(d as any, "made-up-reviewer", "review");
 assert.equal((refusal!.details as any).status, "unknown_agent");
 assert.match((refusal!.content[0] as any).text, /Installed agents: builder, code-reviewer/);
 assert.doesNotMatch((refusal!.content[0] as any).text, /\/af-agents-add/);
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

function planningGateDeps(bound = true) {
 const d = prepareDeps({ agents: ["planner", "builder"] });
 let state = applyProcessClassification(createProcessState(), { scope: "wide", risk: "high", reason: "planning gate regression" }).state;
 if (bound) state = noteProcessStage(state, "plan", { evidenceRef: "plan:bound", revision: "input" });
 d.state.getProcessState = () => state;
 d.state.setProcessState = (value: any) => { state = value; };
 return d;
}

for (const task of [
 "no cloud/deploy/SQL/commits",
 "without printing or copying credentials",
 "No localserve/version bumps, package downloads, cloud calls, SQL execution or secrets writes",
 "- NO CLOUD/DEPLOY/SQL/COMMITS!\n* Without printing or copying credentials.",
]) test(`post-plan-admission: bound wide/high plan admits explicit prohibitions: ${task}`, async () => {
 const d = planningGateDeps(); let runs = 0;
 d.dispatchAgent = async () => { runs++; return { output: "local work complete", exitCode: 0, elapsed: 1 }; };
 const result = await createDispatchExecutor(d as any)("build", { agent: "builder", task }, undefined, undefined, { cwd: tmpdir() } as any);
 assert.equal(runs, 1);
 assert.equal((result.details as any).exitCode, 0);
 assert.equal(d.state.getProcessState().review.evidenceRef, null);
 assert.equal(d.state.getProcessState().acceptance.evidenceRef, null);
 const handoff = activeOrchestrationHandoff({ agent: "builder", task, scope: [], revision: "r", changes: [], exitCode: 0, questions: [], evidenceRefs: [], approvedPlan: true, risk: "low", scopeBreadth: "narrow", sharedCode: false });
 assert.deepEqual(handoff.route.stages, ["builder", "reviewer"]);
});

test("post-plan-admission: sensitive wording and missing plans do not require Planner", () => {
 for (const bound of [true, false]) for (const task of [
  "rotate the cloud credential", "Do not expose credentials; rotate the cloud credential",
  "no cloud/deploy, then read credentials", "without not copying credentials",
  "No need to avoid AWS", "No cloud calls unless needed", "Small change: rotate the cloud credential",
 ]) {
  const d = planningGateDeps(bound);
  assert.ok(!("details" in (prepareDispatch(d as any, { agent: "builder", task }, { cwd: tmpdir() } as any) as any)), task);
 }
 const d = planningGateDeps(false);
 assert.ok(!("details" in (prepareDispatch(d as any, { agent: "builder", task: "no cloud/deploy/SQL/commits" }, { cwd: tmpdir() } as any) as any)));
});

for (const scenario of ["complete", "gap", "compiler-failure", "compiler-skipped", "compiler-incomplete", "late-edit"] as const) test(`post-plan-admission: nested dispatch observes and compiles each declared repository: ${scenario}`, async t => {
 const { cwd, d } = await gitDiagnosticsFixture(t, false);
 for (const name of ["app", "docs"]) {
  const root = join(cwd, name); mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/api.ts"), "export const value = 1;\n");
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "fixture"], { cwd: root, stdio: "ignore" });
 }
 const scopes = ["app/src", "docs/src", ...(scenario === "gap" ? ["loose/file.ts"] : [])];
 if (scenario === "gap") { mkdirSync(join(cwd, "loose")); writeFileSync(join(cwd, "loose/file.ts"), "non-Git scope\n"); }
 const calls: any[] = [];
 d.diagnoseChangedTypeScript = async (paths: readonly string[], options: any) => {
  calls.push({ paths: [...paths], cwd: options.cwd });
  if (scenario === "compiler-failure" && options.cwd === join(cwd, "app")) throw Error("fixture compiler unavailable");
  if (scenario === "compiler-skipped" && options.cwd === join(cwd, "app")) return { status: "skipped", changedFiles: [...paths], attribution: "no_observed_overlap", projects: [], uncoveredFiles: [...paths], reason: "No compiler project" };
  if (scenario === "late-edit") writeFileSync(join(cwd, "app/src/api.ts"), "later unchecked change\n");
  return { status: scenario === "compiler-incomplete" && options.cwd === join(cwd, "app") ? "incomplete" : "completed", changedFiles: [...paths], attribution: "no_observed_overlap", uncoveredFiles: [], projects: [{ project: join(options.cwd, "tsconfig.json"), status: "passed", exitCode: 0, argv: ["node", "tsc"], stdout: "", stderr: "", diagnostics: [{ file: "src/api.ts", code: 1, message: "fixture path" }], changedFiles: [...paths] }] } as any;
 };
 d.dispatchAgent = async () => {
  for (const name of ["app", "docs"]) writeFileSync(join(cwd, name, "src/api.ts"), "export const value = 2;\n");
  return { output: "local changes complete", exitCode: 0, elapsed: 1, dispatchId: `nested-${scenario}` };
 };
 const result = await createDispatchExecutor(d as any)("nested", { agent: "builder", task: "Implement local changes", scope: scopes }, undefined, undefined, { cwd } as any);
 const details = result.details as any;
 assert.deepEqual(calls, [{ paths: ["src/api.ts"], cwd: join(cwd, "app") }, { paths: ["src/api.ts"], cwd: join(cwd, "docs") }]);
 assert.deepEqual(details.changeResult.paths, ["app/src/api.ts", "docs/src/api.ts"]);
 assert.equal(details.scopeViolations.skipped, undefined);
 assert.equal(details.scopeViolations.repositories.length, 2);
 assert.equal(details.scopeViolations.gaps.length, scenario === "gap" ? 1 : 0);
 assert.equal(details.compilerDiagnostics.status, scenario === "gap" || scenario.startsWith("compiler-") ? "incomplete" : "completed");
 assert.equal(details.accepted, scenario === "complete");
 if (scenario === "complete") {
  assert.deepEqual(details.compilerDiagnostics.changedFiles, ["app/src/api.ts", "docs/src/api.ts"]);
  assert.deepEqual(details.compilerDiagnostics.projects.map((p: any) => p.diagnostics[0].file), ["app/src/api.ts", "docs/src/api.ts"]);
  assert.match(details.taskIdentity.revision.after, /^[a-f0-9]{64}$/);
 }
 if (scenario === "gap") {
  assert.equal(details.changeResult.attribution, "uncertain");
  assert.match(result.content[0].text, /loose\/file.ts/);
 }
 if (scenario === "late-edit") assert.equal(details.verificationResult.status, "stale");
});

for (const task of [
 "Do not read secrets or credentials; no cloud or AWS operations",
 "DO NOT READ SECRETS OR CREDENTIALS; NO CLOUD OR AWS OPERATIONS!",
 "- Do not read secrets or credentials.\n* No cloud or AWS operations.",
 "Implement the local routing repair",
]) test(`planning-gate: bound wide/high plan permits negative-only or plain task: ${task}`, async () => {
 const d = planningGateDeps(); let runs = 0;
 d.dispatchAgent = async () => { runs++; return { output: "local work complete", exitCode: 0, elapsed: 1 }; };
 const result = await createDispatchExecutor(d as any)("build", { agent: "builder", task }, undefined, undefined, { cwd: tmpdir() } as any);
 assert.equal(runs, 1);
 assert.equal((result.details as any).exitCode, 0);
 assert.notEqual((result.details as any).status, "planner_required");
});

for (const task of [
 "Read secrets", "Rotate the credential", "Perform cloud operations", "Use AWS",
 "Small change: read secrets",
 "Do not expose credentials; rotate the cloud credential",
 "Do not read secrets and rotate the cloud credential",
 "No cloud operations, read credentials instead",
 "Do not avoid reading secrets", "Not no cloud operations", "No need to avoid AWS",
 "Do not read secrets unless needed", "Avoid credentials", "No secrets?",
]) test(`planning-gate: affirmative or ambiguous sensitive intent does not mandate a planner: ${task}`, () => {
 for (const classification of ["bound-high", "small-low"] as const) {
  const d = classification === "bound-high" ? planningGateDeps() : prepareDeps();
  if (classification === "small-low") d.state.setProcessState(noteProcessStage(d.state.getProcessState(), "plan", { evidenceRef: "plan:bound", revision: "input" }));
  const result = prepareDispatch(d as any, { agent: "builder", task }, { cwd: tmpdir() } as any) as any;
  assert.ok(!("details" in result), classification);
  assert.equal(d._task(), 1);
 }
});

test("planning-gate: missing plan does not add a pre-effect obligation", () => {
 for (const highRisk of [true, false]) {
  const d = planningGateDeps(false);
  if (!highRisk) d.state.setProcessState(applyTaskTriageAdditions(createProcessState(), { status: "applied", reasons: ["wide_change"] }, { taskId: "t", evaluationId: "e", inputRevision: "r" }));
  const result = prepareDispatch(d as any, { agent: "builder", task: "Do not read secrets; no AWS operations" }, { cwd: tmpdir() } as any) as any;
  assert.ok(!("details" in result));
  assert.equal(d._task(), 1);
 }
});

test("planning-gate: handoff shares conservative signals without weakening general route policy", () => {
 const handoff = (task: string, risk: "low" | "high" = "low", scopeBreadth: "narrow" | "wide" = "narrow") => activeOrchestrationHandoff({ agent: "builder", task, scope: [], revision: "r", changes: [], exitCode: 0, questions: [], evidenceRefs: [], approvedPlan: true, risk, scopeBreadth, sharedCode: false });
 assert.deepEqual(handoff("Do not read secrets or credentials; no cloud or AWS operations").route.stages, ["builder", "reviewer"]);
 for (const task of ["Read secrets", "Do not expose credentials; rotate the cloud credential", "Do not avoid secrets", "No cloud operations and use AWS"]) assert.equal(handoff(task).route.stages[0], "builder");
 assert.equal(handoff("Do not read secrets", "high", "wide").route.stages[0], "builder");
});

test("planning-gate: real planner readback binds only a delivered plan before builder", async t => {
 for (const scenario of ["delivered", "missing", "refused"] as const) {
  const cwd = mkdtempSync(join(tmpdir(), "planning-gate-")); t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const d = planningGateDeps(false); d.state.getSessionDir = () => cwd;
  d.artifacts.writeRunArtifact = () => { const path = join(cwd, "return.md"); writeFileSync(path, "retained child response"); return path; };
  const planPath = join(cwd, "plan.md"); let runs = 0;
  d.dispatchAgent = async () => {
   runs++;
   if (scenario === "delivered") writeFileSync(planPath, "Plan: repair local routing, test, independently review.");
   return { output: scenario === "refused" ? "Plan pending.\nrequires_user_decision: [Grant plan permission]" : "Plan: repair local routing, test, independently review.", exitCode: 0, elapsed: 1 };
  };
  const execute = createDispatchExecutor(d as any);
  const result = await execute("plan", { agent: "planner", task: "Produce local repair plan", deliverables: [planPath] }, undefined, undefined, { cwd } as any);
  assert.equal((result.details as any).accepted, false, "plan does not accept the task");
  assert.equal(d.state.getProcessState().review.evidenceRef, null);
  assert.equal(d.state.getProcessState().acceptance.evidenceRef, null);
  if (scenario === "delivered") {
   assert.equal((result.details as any).deliverableReadback[0].status, "read");
   assert.equal(d.state.getProcessState().plan.evidenceRef, (result.details as any).returnPath);
  } else assert.equal(d.state.getProcessState().plan.evidenceRef, null);
  await execute("build", { agent: "builder", task: "Do not read secrets or credentials; no cloud or AWS operations" }, undefined, undefined, { cwd } as any);
  assert.equal(runs, 2);
 }
});

test("high-risk work without an approved plan can execute directly", async () => {
 const d = prepareDeps({ agents: ["builder"] });
 let process = applyProcessClassification(createProcessState(), { risk: "high", scope: "small", reason: "sensitive" }).state;
 d.state.getProcessState = () => process;
 const result = await createDispatchExecutor(d as any)("high", { agent: "builder", task: "change the boundary" }, undefined, undefined, { cwd: "/tmp" } as any);
 assert.notEqual((result.details as any).status, "planner_required");
});

test("sensitive wording does not require a planner", async () => {
 const d = prepareDeps({ agents: ["builder"] });
 const result = await createDispatchExecutor(d as any)("secret", { agent: "builder", task: "small change to the cloud credential" }, undefined, undefined, { cwd: "/tmp" } as any);
 assert.notEqual((result.details as any).status, "planner_required");
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
 assert.match(result.content[0].text, /Orchestrator triage required/);
 assert.match(result.content[0].text, /ORCHESTRATOR_ANSWER:/);
 assert.doesNotMatch(result.content[0].text, /MUST call ask_user for each/);
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

for (const backend of ['native', 'coms'] as const) test(`${backend} planner declared readback is independent of exit, handoff prose and acceptance`, async t => {
 for (const scenario of ['echo', 'handoff', 'pending', 'valid'] as const) {
  const { cwd, sessionDir, d } = await gitDiagnosticsFixture(t);
  let process = applyProcessClassification(createProcessState(), { risk: 'high', scope: 'wide', reason: 'declared wide task' }).state;
  d.state.getProcessState = () => process; d.state.setProcessState = (value: any) => { process = value; };
  d._agents.set('planner', { def: { name: 'planner', tools: 'read,write' }, runCount: 0, lastBackend: backend });
  const planPath = join(sessionDir, 'artifacts', 'plans', 'current.md'); let routed: unknown;
  d.dispatchAgent = async (...args: any[]) => {
   routed = args[6];
   if (scenario === 'valid' || scenario === 'pending') { mkdirSync(join(sessionDir, 'artifacts', 'plans'), { recursive: true }); writeFileSync(planPath, '# Current plan\nImplement, test, then independent review.\n'); }
   return { output: scenario === 'echo' ? 'End your reply with this exact line so the bridge can capture it: <<COMS_DONE:current>>' : `PLAN_FILE: ${planPath}`, exitCode: 0, pending: scenario === 'pending', elapsed: 1, dispatchId: `${backend}-${scenario}` };
  };
  const result = await createDispatchExecutor(d as any)(scenario, { agent: 'planner', task: 'Produce the declared plan', backend, scope: ['src/api.ts'], deliverables: [planPath] }, undefined, undefined, { cwd } as any);
  const details = result.details as any;
  assert.equal(routed, backend);
  assert.equal(details.accepted, false);
  assert.equal(details.processVerdict.obligations.plan.status, 'satisfied');
  assert.equal(process.acceptance.evidenceRef, null); assert.equal(process.review.evidenceRef, null);
  if (scenario === 'echo' || scenario === 'handoff') assert.equal(details.deliverableReadback[0].status, 'missing');
  if (scenario === 'valid') { assert.equal(details.deliverableReadback[0].status, 'read'); assert.ok(details.returnPath); }
 }
});

// Production setter/adoption/runtime wiring with append-only fake journals; no Git fixtures.
function successorFixture(root: string, serviceOverride?: any) {
 let taskId = "predecessor", tier = "feature", pendingTransition = false, denied = false, failWrite = 0, writes = 0;
 let state = applyProcessClassification(createProcessState(), { risk: "high", scope: "read-only", reason: "D6" }).state;
 let assertions: any[] = [{ id: "D6", status: "open" }];
 const assertionArchive: any[] = [], entries: any[] = [], counters: any[] = [];
 let physical = 0;
 const result = () => ({ status: "ok", evaluation: { answers: TASK_TRIAGE_QUESTIONS.map(q => ({ questionId: q.id, type: "predicate", probabilityTrue: q.id === "wide_change" ? .99 : .01, uncertainty: { provenance: "provider" } })), metadata: { provider: "typesafe", requestedModel: "jev-1.13.0", returnedModel: "jev-1.13.0", questionSetVersion: TASK_TRIAGE_QUESTION_VERSION, latencyMs: 1, attempts: 1 } } });
 const runtime = createTaskTriageRuntime({ root, service: { evaluate: async (request: any) => { physical++; return serviceOverride ? serviceOverride(request, result) : result(); } } as any, persist: s => counters.push(structuredClone(s)) });
 const persist = (s: any) => { if (++writes === failWrite) throw Error("disk full"); entries.push({ customType: "agent-hub-process-state", data: processAuditRecord(s, evaluateProcessObligations(s, { writable: true, budgetTier: tier })) }); };
 const budget = { taskResetSnapshot: () => ({}), resetTaskWindow() {}, appendTaskResetEntry() {}, currentBudget: () => ({}), updateModeStatus() {} };
 const tools = createActionExecutors({ budget, artifacts: { persistAssertions() {} }, hubState: {}, provisionalCapabilityRefusal: () => null,
  getTaskTier: () => tier, setTaskTier: (v: string) => { tier = v; }, getTaskTierAssumed: () => false, setTaskTierAssumed() {}, getProcessState: () => state,
  adoptTaskTriage: async (id: string, newTask: boolean, expandedScope?: string) => { const s = await adoptTaskTriageState({ runtime, taskId: id, newTask, expandedScope, pendingTransition, state, persist, onPostCommitFailure() {} }); pendingTransition = false; return s; },
  setProcessState: (s: any) => { state = s; }, persistProcessState: persist, getTaskDispatchCount: () => 0, getTaskResearchCount: () => 0, getTurnReport: () => ({}), getAssertions: () => assertions, setAssertions: (v: any[]) => { assertionArchive.push(structuredClone(assertions)); assertions = v; },
  currentTaskId: () => taskId, currentRevision: () => "rev", confirmTaskSupersession: async () => !denied,
  adoptReservedTaskId: (id: string, reset: () => void) => { taskId = id; reset(); },
 } as any);
 return { runtime, entries, counters, assertionArchive, result, get state() { return state; }, get taskId() { return taskId; }, get assertions() { return assertions; }, get physical() { return physical; },
  pending: () => { pendingTransition = true; }, deny: () => { denied = true; }, fail: (n: number) => { failWrite = writes + n; },
  seed: async () => { runtime.input("Change many modules", "interactive"); runtime.scope("wide"); const c = await runtime.evaluate(taskId); assert.ok(c); state = applyTaskTriageAdditions(state, c.assessment, { taskId, evaluationId: c.evaluationId, inputRevision: c.revision }); persist(state); assert.equal(processPreEffectGate(state, "write")?.reason, undefined); },
  set: (new_task = true) => tools.executeSetTaskTier("set", { tier: "feature", risk: "high", scope: "read-only", reason: "Different read-only task", new_task }, undefined, undefined, {} as any),
  hook: async () => { const c = await runtime.evaluate(taskId); if (c) state = applyTaskTriageAdditions(state, c.assessment, { taskId, evaluationId: c.evaluationId, inputRevision: c.revision }); },
 };
}

test("planning-gate: authorized successor retires consumed assessment and next-hook replay, archives D6", async t => {
 const root = mkdtempSync(join(tmpdir(), "successor-")); t.after(() => rmSync(root, { recursive: true, force: true }));
 const f = successorFixture(root); await f.seed(); const archived = structuredClone(f.entries[0]);
 const r = await f.set(); assert.equal(r.details?.status, "ok"); assert.notEqual(f.taskId, "predecessor");
 assert.equal(processPreEffectGate(f.state, "write"), null); assert.deepEqual(f.state.additions, []); assert.equal(f.state.plan.evidenceRef, null);
 assert.equal(f.state.review.evidenceRef, null); assert.equal(f.state.acceptance.evidenceRef, null);
 assert.equal(evaluateProcessObligations(f.state, { writable: true, budgetTier: "feature" }).obligations.review.status, "open");
 assert.deepEqual(latestProcessState(f.entries), normalizeProcessState(f.state)); assert.deepEqual(f.entries[0], archived); assert.equal(archived.data.state.additions[0].status, "active");
 assert.deepEqual(f.assertionArchive, [[{ id: "D6", status: "open" }]]);
 assert.equal(f.runtime.current, null); assert.equal(f.runtime.inputRevision, undefined); await f.hook();
 assert.equal(processPreEffectGate(f.state, "write"), null); assert.equal(f.physical, 1); assert.equal(f.runtime.calls, 1);
 // Explicit fresh input may legitimately reuse the durable cache, not stale ownership/scope.
 f.runtime.input("Change many modules", "interactive"); f.pending(); await f.set();
 assert.equal(processPreEffectGate(f.state, "write")?.reason, undefined); assert.equal(f.physical, 2);
 f.runtime.input("Change many modules", "interactive"); f.pending(); await f.set();
 assert.equal(f.physical, 2, "explicit fresh input reuses the successor-scope cache");
 assert.ok(f.state.additions?.every(a => a.taskId === f.taskId));
});

test("planning-gate: denied and failed successor persistence leave predecessor binding ledger and gate intact", async t => {
 const root = mkdtempSync(join(tmpdir(), "successor-")); t.after(() => rmSync(root, { recursive: true, force: true }));
 for (const mode of ["denied", "failed"] as const) {
  const f = successorFixture(root); await f.seed(); const c = f.runtime.current, before = structuredClone(f.entries);
  if (mode === "denied") f.deny(); else f.fail(1);
  const r = await f.set(); assert.equal(r.details?.status, "refused"); assert.equal(f.taskId, "predecessor"); assert.equal(f.runtime.current, c);
  assert.deepEqual(f.entries, before); assert.deepEqual(f.assertions, [{ id: "D6", status: "open" }]);
  await f.hook(); assert.equal(processPreEffectGate(f.state, "write")?.reason, undefined); assert.equal(f.physical, 1);
 }
});

test("planning-gate: fresh successor input is bound to reserved identity and same-task contraction keeps obligations", async t => {
 const root = mkdtempSync(join(tmpdir(), "successor-")); t.after(() => rmSync(root, { recursive: true, force: true }));
 const f = successorFixture(root); await f.seed(); const old = structuredClone(f.entries[0]);
 f.runtime.input("New wide successor work", "interactive"); f.pending(); assert.equal((await f.set()).details?.status, "ok");
 assert.ok(f.state.additions?.length); assert.ok(f.state.additions?.every(a => a.taskId === f.taskId && a.inputRevision === f.runtime.inputRevision));
 assert.equal(f.runtime.current?.taskId, f.taskId); assert.equal(processPreEffectGate(f.state, "write")?.reason, undefined); assert.deepEqual(f.entries[0], old);
 const bound = structuredClone(f.state.additions); await f.set(false); await f.hook(); assert.deepEqual(f.state.additions, bound); assert.equal(f.physical, 2);
});

test("planning-gate: successor fences late predecessor completion and cancelled fresh binding cannot commit", async t => {
 const root = mkdtempSync(join(tmpdir(), "successor-")); t.after(() => rmSync(root, { recursive: true, force: true }));
 let finish!: (value: any) => void;
 const f = successorFixture(root, () => new Promise(resolve => { finish = resolve; }));
 f.runtime.input("Old inflight work", "interactive"); const flight = f.runtime.evaluate("predecessor");
 assert.equal((await f.set()).details?.status, "ok"); const state = structuredClone(f.state), journal = structuredClone(f.entries), counters = structuredClone(f.counters);
 finish(f.result()); assert.equal(await flight, null); await f.hook(); assert.deepEqual(f.state, state); assert.deepEqual(f.entries, journal); assert.deepEqual(f.counters, counters); assert.equal(f.runtime.current, null);
 f.runtime.input("Fresh inflight work", "interactive"); f.pending(); const transition = f.set();
 await new Promise(resolve => setImmediate(resolve)); f.runtime.invalidate();
 assert.equal((await transition).details?.status, "refused"); assert.deepEqual(f.state, state); assert.deepEqual(latestProcessState(f.entries), normalizeProcessState(state));
 finish(f.result());
});

test("planning-gate: failed fresh successor append never commits staged runtime ownership", async t => {
 const root = mkdtempSync(join(tmpdir(), "successor-")); t.after(() => rmSync(root, { recursive: true, force: true }));
 for (const failedWrite of [1, 2]) {
  const f = successorFixture(root); await f.seed();
  f.runtime.input("Fresh wide input awaiting adoption", "interactive");
  const current = await f.runtime.evaluate("predecessor"); f.pending();
  const state = structuredClone(f.state), before = structuredClone(f.entries), revision = f.runtime.inputRevision;
  f.fail(failedWrite); assert.equal((await f.set()).details?.status, "refused");
  assert.equal(f.taskId, "predecessor"); assert.equal(f.runtime.current, current); assert.equal(f.runtime.inputRevision, revision);
  assert.deepEqual(f.state, state); assert.deepEqual(latestProcessState(f.entries), latestProcessState(before));
  assert.deepEqual(f.assertions, [{ id: "D6", status: "open" }]); assert.equal(processPreEffectGate(f.state, "write")?.reason, undefined);
  assert.deepEqual(f.entries[0], before[0]);
 }
});

test("review reuse: unchanged covered scope survives rewording and restoration without another child",async t=>{
 const {cwd,d,process}=await highRiskChangedFixture(t);let runs=0;
 d.budget.currentBudget=()=>({maxDispatches:null,maxResearch:null}) as any;
 d.dispatchAgent=async()=>({output:"verdict: APPROVE",exitCode:0,elapsed:1,dispatchId:`review-${++runs}`});
 const execute=createDispatchExecutor(d as any),params={agent:"code-reviewer",task:"Review changed code",scope:["src/api.ts"]};
 const first=await execute("first",params,undefined,undefined,{cwd} as any);assert.ok(process().review.evidenceRef);
 const charged=d._task();
 d.state.setProcessState(latestProcessState([{customType:"agent-hub-process-state",data:processAuditRecord(process(),evaluateProcessObligations(process(),{writable:true,budgetTier:"small"}))}]));
 writeFileSync(join(cwd,"README.md"),"unrelated follow-up\n");
 const second=await execute("second",{...params,task:"Independently check the completed change again"},undefined,undefined,{cwd} as any);
 assert.equal((second.details as any).status,"review_reused");assert.equal(runs,1);assert.equal(d._task(),charged);
 assert.equal((second.details as any).returnPath,(first.details as any).returnPath);
 assert.equal((second.details as any).started,false);
});

for(const change of ["source","requirements","accepted-input","evidence","new-task","explicit-reason","new-scope"] as const) test(`review reuse: ${change} requires fresh review`,async t=>{
 const {cwd,d,process}=await highRiskChangedFixture(t);let runs=0;
 d.budget.currentBudget=()=>({maxDispatches:null,maxResearch:null}) as any;
 d.dispatchAgent=async()=>({output:"verdict: APPROVE",exitCode:0,elapsed:1,dispatchId:`review-${++runs}`});
 const execute=createDispatchExecutor(d as any),params:any={agent:"code-reviewer",task:"Review code",scope:["src/api.ts"]};
 await execute("first",params,undefined,undefined,{cwd} as any);
 if(change==="source")writeFileSync(join(cwd,"src/api.ts"),"export const value = 10;\n");
 if(change==="requirements")d.state.getAssertions=()=>[{id:"NEW",tag:"test",text:"New security requirement",source:"user",status:"open"}] as any;
 if(change==="accepted-input")(d.state as any).getAcceptedUserInput=()=>"Also inspect the newly requested concurrency behavior";
 if(change==="evidence")writeFileSync(process().review.evidenceRef!,"changed review artifact");
 if(change==="new-task")d.noProgress.reset();
 if(change==="explicit-reason")params.review_reason="Inspect a new concurrency concern";
 if(change==="new-scope")params.scope=["src/api.ts","README.md"];
 const second=await execute("second",{...params,task:"Fresh independent review"},undefined,undefined,{cwd} as any);
 assert.notEqual((second.details as any).status,"review_reused",change);assert.equal(runs,2,change);
});

test("review reuse: security audit is reused only as security coverage, and a fresh rejection invalidates it",async t=>{
 const {cwd,d,process}=await highRiskChangedFixture(t);let runs=0,reject=false;
 d.budget.currentBudget=()=>({maxDispatches:null,maxResearch:null}) as any;
 d._agents.set("security-auditor",{def:{name:"security-auditor",tools:"read"},runCount:0,lastBackend:"native"});
 d.dispatchAgent=async()=>({output:`verdict: ${reject?"REJECT":"APPROVE"}`,exitCode:0,elapsed:1,dispatchId:`audit-${++runs}`});
 const execute=createDispatchExecutor(d as any),params={agent:"security-auditor",task:"Audit security",scope:["src/api.ts"]};
 await execute("audit",params,undefined,undefined,{cwd} as any);
 const cached=await execute("cached",{...params,task:"Check security once more"},undefined,undefined,{cwd} as any);
 assert.equal((cached.details as any).status,"review_reused");assert.equal(runs,1);
 await execute("code",{...params,agent:"code-reviewer",task:"Review code"},undefined,undefined,{cwd} as any);assert.equal(runs,2,"a security audit does not replace a different review role");
 reject=true;
 await execute("reject",{...params,task:"Fresh audit",review_reason:"New concern"},undefined,undefined,{cwd} as any);
 assert.equal(process().review.evidenceRef,null,"fresh rejection cannot leave old approval active");
 assert.equal(process().reviews?.some(r=>r.agent==="security-auditor"),false);
});

for(const condition of ["question","blocking-finding","source-changed-during-review"] as const) test(`review reuse: ${condition} never records reusable approval`,async t=>{
 const {cwd,d,process}=await highRiskChangedFixture(t);
 if(condition==="question")d.extractAskUserQuestions=()=>["Which behavior is required?"];
 d.dispatchAgent=async()=>{if(condition==="source-changed-during-review")writeFileSync(join(cwd,"src/api.ts"),"export const value=42;\n");return {output:"verdict: APPROVE"+(condition==="blocking-finding"?"\n### Blocking findings\n- An unresolved correctness defect remains.":""),exitCode:0,elapsed:1,dispatchId:"review"};};
 await createDispatchExecutor(d as any)("review",{agent:"code-reviewer",task:"Review code",scope:["src/api.ts"]},undefined,undefined,{cwd} as any);
 assert.equal(process().review.evidenceRef,null);assert.equal(process().reviews?.length??0,0);
});

test("fresh review receives prior rejection and actual delta without inheriting approval",async t=>{
 const {cwd,d,process}=await highRiskChangedFixture(t);const prompts:string[]=[];
 d.budget.currentBudget=()=>({maxDispatches:null,maxResearch:null}) as any;
 d.dispatchAgent=async(_agent:string,task:string)=>{prompts.push(task);return {output:"verdict: REJECT\nBlocking finding: wrong constant",exitCode:0,elapsed:1,dispatchId:"history-"+prompts.length};};
 const execute=createDispatchExecutor(d as any),params={agent:"code-reviewer",task:"Review current code",scope:["src/api.ts"]};
 await execute("first",params,undefined,undefined,{cwd} as any);
 assert.equal(process().review.evidenceRef,null);
 writeFileSync(join(cwd,"src/api.ts"),"export const value=123;\n");
 await execute("second",{...params,task:"Review the fixed constant"},undefined,undefined,{cwd} as any);
 assert.match(prompts[1],/Incremental review context/);
 assert.match(prompts[1],/Previous findings\/report/);
 assert.match(prompts[1],/\+export const value=123/);
 assert.equal(process().review.evidenceRef,null);
});

test("native structured report bypasses extraction but does not replace task evidence",async t=>{
 const {cwd,d}=await gitDiagnosticsFixture(t);let extracted=0;
 d.runReturnExtraction=async()=>{extracted++;throw new Error("must not extract");};
 const report={status:"completed",summary:"Specialist finished",changed_files:[],assertions_proven:[],assertions_unproven:[{id:"A1",reason:"not checked"}],assertions_failed:[],tests_run:[],open_risks:[],requires_user_decision:[],evidence:[]};
 d.dispatchAgent=async()=>({output:"Short final",exitCode:0,elapsed:1,dispatchId:"structured",specialistResultTool:true,specialistResult:report});
 const result=await createDispatchExecutor(d as any)("call",{agent:"builder",task:"A1 inspect"},undefined,undefined,{cwd} as any);
 const details=result.details as any;
 assert.equal(extracted,0);
 assert.equal(details.resultProtocol,"submit_result");
 assert.equal(details.specialistCompletion,"completed");
 assert.equal(details.taskAccepted,false);
 assert.equal(details.structuredReturn.assertions_unproven[0].id,"A1");
});

// layout 'nested': the workspace root is not a repository and the edited file lives in a
// nested one (rankedin: rin-docs/ and ringithub/ under a plain folder).
async function operatorStateFixture(t:any,scenario='pass',layout:'single'|'nested'='single',scope=['a.ts']) {
 const cwd=mkdtempSync(join(tmpdir(),'operator-review-'));t.after(()=>rmSync(cwd,{recursive:true,force:true}));
 if(layout==='single'){execFileSync('git',['init','-q'],{cwd});writeFileSync(join(cwd,'a.ts'),'export const a=1;\n');}
 else {
  const docs=join(cwd,'rin-docs');mkdirSync(docs);execFileSync('git',['init','-q'],{cwd:docs});
  writeFileSync(join(docs,'prd.md'),'# PRD\n');writeFileSync(join(docs,'clean.md'),'unchanged\n');
  execFileSync('git',['-c','user.email=fixture@example.test','-c','user.name=Fixture','add','.'],{cwd:docs});
  execFileSync('git',['-c','user.email=fixture@example.test','-c','user.name=Fixture','commit','-qm','base'],{cwd:docs});
  writeFileSync(join(docs,'prd.md'),'# PRD\n\nEdited by the operator.\n');writeFileSync(join(cwd,'loose.md'),'not in any repository\n');
 }
 const d=prepareDeps({agents:['code-reviewer'],tools:'read,bash'});d._agents.get('code-reviewer')!.lastBackend='native';
 const session=mkdtempSync(join(tmpdir(),'operator-session-'));t.after(()=>rmSync(session,{recursive:true,force:true}));d.state.getSessionDir=()=>session;
 const {createAssertionsArtifactsContext}=await import('../context/assertions-artifacts.ts');
 d.artifacts.writeRunArtifact=createAssertionsArtifactsContext({getAssertions:()=>[],getSessionDir:()=>session,getRunHistoryKeep:()=>null,setStatus:()=>{}}).writeRunArtifact;
 let state=applyProcessClassification(createProcessState(),{risk:'high',scope:'wide',reason:'fixture'}).state;
 state=noteProcessStage(state,'plan',{evidenceRef:'fixture:plan',revision:worktreeRevision(cwd,[])});
 d.state.getProcessState=()=>state;d.state.setProcessState=(value:any)=>{state=value;};
 const command='node --test candidate.test.js';
 d.state.getAssertions=()=>[{id:'A2',tag:'test',text:'candidate check',source:'fixture',testCommand:command,status:'open'},{id:'A1',tag:'manual',text:'relay recorded',source:'fixture',status:'open'}];
 d.dispatchAgent=async()=>{
  if(scenario==='modified')writeFileSync(join(cwd,'a.ts'),'export const a=2;\n');
  if(scenario==='overlap')d._setOverlap(1);
  // The child observes the same declared scope the Hub does (AGENT_FLEET_RUNTIME_TEST_SCOPES).
  const revision=worktreeRevision(cwd,[],layout==='nested'?scope:[]);
  const {validateSpecialistResult}=await import('../specialist-result.ts');
  const submission=validateSpecialistResult({status:['partial','blocked'].includes(scenario)?scenario:'completed',summary:'Read-only current-state fixture',changed_files:[],assertions_proven:[],assertions_unproven:[],assertions_failed:scenario==='assertion-failed'?[{id:'A2',reason:'Unresolved assertion'}]:[],tests_run:['full scoped regression'],open_risks:[],requires_user_decision:scenario==='question'?['Choose behavior']:[],evidence:[]},cwd);
  return {output:scenario==='reject'?'**Verdict:** REJECT':'**Verdict:** APPROVE\ntests_run: full regression',exitCode:0,elapsed:1,dispatchId:'current-state',
   // Production native settlement always publishes parser-owned capture integrity; 'tainted' and 'no-integrity' model a lossy/absent capture.
   ...(scenario==='no-integrity'?{}:{lifecycle:{launched:true,closeSeen:true,runtimeCaptureIntegrity:scenario==='tainted'?'tainted' as const:'complete' as const}}),
   ...(scenario==='legacy'?{}:{specialistResultTool:true,...(scenario==='missing-submission'?{}:{specialistResult:submission})}),
   runtimeTests:scenario==='no-checks'?[]:[{command,exitCode:scenario==='failed'?1:0,beforeRevision:scenario==='stale'?'other':revision,afterRevision:revision}]};
 };
 return {cwd,d,state:()=>state,run:createDispatchExecutor(d as any)};
}
test('explicit native current-state review closes scope-bound process without historical changes or manual proof',async t=>{
 const f=await operatorStateFixture(t);const r=await f.run('current',{agent:'code-reviewer',task:'A2 current state, not authorship',scope:['a.ts'],backend:'native',review_mode:'operator-current-state'},undefined,undefined,{cwd:f.cwd} as any);
 const details=r.details as any;assert.ok(details.processVerdict,JSON.stringify(r));assert.equal(details.processVerdict.obligations.review.status,'satisfied',JSON.stringify({operator:details.operatorStateVerification,verification:details.verificationResult,process:details.processVerdict}));assert.equal(details.processVerdict.obligations.acceptance.status,'satisfied');
 assert.equal(details.processVerdict.path,'operator-current-state');assert.deepEqual(details.processVerdict.auditScope,['a.ts']);
 assert.equal(details.resultProtocol,'submit_result');assert.equal(details.structuredReturn.status,'completed');
 assert.equal(details.operatorStateVerification.status,'accepted');assert.equal(details.operatorStateVerification.historicalAttribution,'not_claimed');
 assert.equal(details.taskAccepted,false);assert.equal(details.changeResult.status,'unchanged');assert.equal(f.d.state.getAssertions()[1].status,'open');
});
test('current-state review fails closed on missing/failed/stale checks, reject, source mutation and overlap',async t=>{
 for(const scenario of ['no-checks','failed','stale','reject','modified','overlap','partial','blocked','missing-submission','assertion-failed','question','tainted','no-integrity']){
  const f=await operatorStateFixture(t,scenario);const r=await f.run(scenario,{agent:'code-reviewer',task:'A2 inspect '+scenario,scope:['a.ts'],backend:'native',review_mode:'operator-current-state'},undefined,undefined,{cwd:f.cwd} as any);
  assert.equal((r.details as any).operatorStateVerification.status,'unproven',scenario);assert.equal(f.state().review.evidenceRef,null,scenario);assert.equal(f.state().acceptance.evidenceRef,null,scenario);
 }
});
test('current-state mode is explicit, native-only, exact observed files and never a normal builder bypass',async t=>{
 for(const patch of [{backend:'coms'},{backend:'auto'},{review_mode:'invented'},{scope:['*.ts']},{scope:['a.ts','a.ts']},{scope:['clean.ts']},{scope_mode:'create'}]){
  const f=await operatorStateFixture(t);const r=await f.run('invalid',{agent:'code-reviewer',task:'A2 invalid current state',scope:['a.ts'],backend:'native',review_mode:'operator-current-state',...patch} as any,undefined,undefined,{cwd:f.cwd} as any);
  assert.equal((r.details as any).started,false);assert.equal(f.d._task(),0);
 }
 const f=await operatorStateFixture(t);const normal=await f.run('default',{agent:'code-reviewer',task:'A2 ordinary review',scope:['a.ts'],backend:'native'},undefined,undefined,{cwd:f.cwd} as any);
 assert.equal((normal.details as any).operatorStateVerification,undefined);assert.equal(f.state().acceptance.evidenceRef,null);
});

test('current-state review closes operator edits in a nested repository under a plain workspace folder',async t=>{
 const scope=['rin-docs/prd.md'];
 const f=await operatorStateFixture(t,'pass','nested',scope);
 const r=await f.run('nested',{agent:'code-reviewer',task:'A2 current state of the operator PRD edit',scope,backend:'native',review_mode:'operator-current-state'},undefined,undefined,{cwd:f.cwd} as any);
 const details=r.details as any;assert.ok(details.processVerdict,JSON.stringify(r));
 assert.equal(details.operatorStateVerification.status,'accepted',JSON.stringify(details.operatorStateVerification));
 assert.equal(details.processVerdict.obligations.review.status,'satisfied');assert.equal(details.processVerdict.obligations.acceptance.status,'satisfied');
 assert.deepEqual(details.processVerdict.auditScope,scope);assert.deepEqual(f.state().changedFiles,scope);
});

test('nested current-state still refuses files outside a nested repository, clean files and a changed file during review',async t=>{
 for(const scope of [['loose.md'],['rin-docs/clean.md'],['rin-docs/prd.md','loose.md']]){
  const f=await operatorStateFixture(t,'pass','nested',scope);
  const r=await f.run('nested-invalid',{agent:'code-reviewer',task:'A2 nested invalid '+scope.join(','),scope,backend:'native',review_mode:'operator-current-state'},undefined,undefined,{cwd:f.cwd} as any);
  assert.equal((r.details as any).started,false,scope.join(','));assert.equal(f.d._task(),0);
 }
 const scope=['rin-docs/prd.md'];
 const f=await operatorStateFixture(t,'modified-nested','nested',scope);
 f.d.dispatchAgent=(original=>async(...args:any[])=>{writeFileSync(join(f.cwd,'rin-docs/prd.md'),'# PRD\n\nChanged during the review.\n');return original(...args);})(f.d.dispatchAgent);
 const r=await f.run('nested-modified',{agent:'code-reviewer',task:'A2 nested modified',scope,backend:'native',review_mode:'operator-current-state'},undefined,undefined,{cwd:f.cwd} as any);
 assert.equal((r.details as any).operatorStateVerification.status,'unproven');assert.equal(f.state().review.evidenceRef,null);assert.equal(f.state().acceptance.evidenceRef,null);
});

test('current-state mode cannot omit an active automated assertion by naming only another ID',async t=>{
 const f=await operatorStateFixture(t),prior=f.d.state.getAssertions();f.d.state.getAssertions=()=>[...prior,{id:'A3',tag:'test',text:'second required check',source:'fixture',testCommand:'node --test second.test.js',status:'open'}];
 const r=await f.run('all-tests',{agent:'code-reviewer',task:'A2 only in prose',scope:['a.ts'],backend:'native',review_mode:'operator-current-state'},undefined,undefined,{cwd:f.cwd} as any);
 assert.equal((r.details as any).operatorStateVerification.status,'unproven');assert.equal(f.state().acceptance.evidenceRef,null);
});

test('current-state acceptance persists real evidence payload in captured session namespace',async t=>{
 const f=await operatorStateFixture(t);const own=mkdtempSync(join(tmpdir(),'operator-owner-')),foreign=mkdtempSync(join(tmpdir(),'operator-foreign-'));
 t.after(()=>{rmSync(own,{recursive:true,force:true});rmSync(foreign,{recursive:true,force:true});});f.d.state.getSessionDir=()=>own;
 const {createAssertionsArtifactsContext}=await import('../context/assertions-artifacts.ts');
 const artifacts=createAssertionsArtifactsContext({getAssertions:()=>[],getSessionDir:()=>foreign,getRunHistoryKeep:()=>null,setStatus:()=>{}});
 let proofCall:any[]=[];f.d.artifacts.writeRunArtifact=(...args:any[])=>{
  if(String(args[0]).startsWith('operator-state')){proofCall=args;assert.equal(typeof args[1],'number');assert.equal(args[3],'evidence');assert.equal(args[5],own);}
  return (artifacts.writeRunArtifact as any)(...args);
 };
 const r=await f.run('real-evidence',{agent:'code-reviewer',task:'A2 current state with real writer',scope:['a.ts'],backend:'native',review_mode:'operator-current-state'},undefined,undefined,{cwd:f.cwd} as any);
 const proof=(r.details as any).operatorStateVerification;assert.equal(proof?.status,'accepted',JSON.stringify(r));
 assert.ok(proof.evidenceRef.startsWith(join(own,'artifacts','evidence')));assert.equal(proofCall.length,6);
 const persisted=JSON.parse(readFileSync(proof.evidenceRef,'utf8'));assert.equal(persisted.schema,'agent-fleet.operator-state-verification/v1');assert.equal(persisted.historicalAttribution,'not_claimed');
 assert.deepEqual(persisted.paths,['a.ts']);assert.equal(persisted.revision,worktreeRevision(f.cwd,[]));assert.ok(persisted.checks.some((c:any)=>c.producer==='runtime'&&c.status==='passed'));
});

test('missing or hollow current-state evidence cannot register acceptance or review',async t=>{
 for(const failure of ['hollow','missing','wrong-kind']){
  const f=await operatorStateFixture(t),writer=f.d.artifacts.writeRunArtifact;
  f.d.artifacts.writeRunArtifact=(...args:any[])=>{
   if(args[0]==='operator-state'){
    if(failure==='missing')return join(f.d.state.getSessionDir(),'artifacts','evidence','absent.md');
    if(failure==='hollow')args[2]='evidence';else args[3]='returns';
   }
   return (writer as any)(...args);
  };
  const r=await f.run(failure,{agent:'code-reviewer',task:'A2 bad evidence '+failure,scope:['a.ts'],backend:'native',review_mode:'operator-current-state'},undefined,undefined,{cwd:f.cwd} as any);
  assert.equal((r.details as any).operatorStateVerification.status,'unproven');assert.equal((r.details as any).operatorStateVerification.reason,'evidence_readback_failed');
  assert.equal(f.state().acceptance.evidenceRef,null);assert.equal(f.state().review.evidenceRef,null);
 }
});

test('current-state preflight rejects inspection-only or source-writing reviewer tool sets',async t=>{
 for(const tools of ['read,grep','read,bash,edit','read,bash,write']){
  const f=await operatorStateFixture(t);f.d._agents.get('code-reviewer')!.def.tools=tools;
  const r=await f.run('tools',{agent:'code-reviewer',task:'A2 invalid tool set',scope:['a.ts'],backend:'native',review_mode:'operator-current-state'},undefined,undefined,{cwd:f.cwd} as any);
  assert.equal((r.details as any).started,false);assert.equal(f.d._task(),0);
 }
});

test('current-state legacy return compatibility still requires actual checks and independent approval',async t=>{
 const f=await operatorStateFixture(t,'legacy');
 const r=await f.run('legacy',{agent:'code-reviewer',task:'A2 legacy current state',scope:['a.ts'],backend:'native',review_mode:'operator-current-state'},undefined,undefined,{cwd:f.cwd} as any);
 assert.equal((r.details as any).operatorStateVerification.status,'accepted');
 assert.notEqual((r.details as any).resultProtocol,'submit_result');
 assert.equal(f.d.state.getAssertions()[1].status,'open');
});

test('receipt recovery: test-pass then guard-timeout then compiler-pass across two dispatches and journal reload', async t => {
 const { cwd, d } = await gitDiagnosticsFixture(t);
 writeFileSync(join(cwd, 'README.md'), 'current dirty candidate\n');
 d._agents.get('builder').def.tools = 'read,bash';
 const testCommand = 'node --test harness-only.test.js', compilerCommand = 'tsc --noEmit harness-only.ts';
 d.state.getAssertions = () => [
  { id: 'A1', tag: 'test', text: 'both exact producers', source: 'approved', testCommand, compilerCommand, status: 'open' },
  { id: 'AF-MIN-CHANGE', tag: 'test', text: 'Inspect the actual changed state and run an applicable verification command against it.', source: 'runtime:minimal-change-contract', reference: 'T2a', testCommand, criticalConditions: ['Historical logs are not imported as current runtime checks.'], status: 'open' },
 ];
 let launches = 0;
 d.dispatchAgent = async () => {
  const revision = worktreeRevision(cwd, [], ['README.md']);
  const command = ++launches === 1 ? testCommand : compilerCommand;
  return { output: 'report', exitCode: 0, elapsed: 1, dispatchId: `recovery-${launches}`, lifecycle: nativeCleanLifecycle, runtimeTests: [{ producer: 'agent-fleet.runtime-test/v1', command, exitCode: 0, beforeRevision: revision, afterRevision: revision }, ...(launches === 1 ? [{ producer: 'agent-fleet.runtime-test/v1', command: compilerCommand, exitCode: null, beforeRevision: 'unavailable', afterRevision: 'unavailable' }] : [])] };
 };
 const execute = createDispatchExecutor(d as any);
 const first: any = await execute('one', { agent: 'builder', task: 'A1 inspect', scope: ['README.md'] }, undefined, undefined, { cwd } as any);
 assert.equal(first.details.accepted, false);
 const journal = processAuditRecord(d.state.getProcessState(), evaluateProcessObligations(d.state.getProcessState(), { writable: true, budgetTier: 'small' }));
 d.state.setProcessState(latestProcessState([{ customType: 'agent-hub-process-state', data: JSON.parse(JSON.stringify(journal)) }]));
 const second: any = await execute('two', { agent: 'builder', task: 'A1 finish compiler only', scope: ['README.md'] }, undefined, undefined, { cwd } as any);
 const requirements = second.details.verificationResult.requirements;
 assert.equal(requirements.filter((r: any) => r.id === 'AF-MIN-CHANGE').length, 1);
 assert.ok(requirements.find((r: any) => r.id === 'AF-MIN-CHANGE').criticalConditions.includes('Historical logs are not imported as current runtime checks.'));
 assert.equal(requirements.find((r: any) => r.id === 'A1').status, 'passed');
 assert.equal(second.details.verificationResult.checks.length, 2);
 const originalCheck = first.details.verificationResult.checks.find((c: any) => c.command[0] === testCommand);
 const retainedCheck = second.details.verificationResult.checks.find((c: any) => c.command[0] === testCommand);
 assert.deepEqual(JSON.parse(JSON.stringify(retainedCheck)), JSON.parse(JSON.stringify(originalCheck)), 'journal JSON retains original evidence path, command, coverage and revision');
 assert.equal(JSON.parse(readFileSync(retainedCheck.evidenceRef, 'utf8')).declaration.dispatchId, 'recovery-1');
 assert.equal(requirements.find((r: any) => r.id === 'AF-MIN-CHANGE').testCommand, testCommand);
 assert.equal(launches, 2, 'no implicit test producer rerun');
 assert.equal(second.details.accepted, false, 'read-only current inspection does not claim changed-task authorship');
});

for (const negative of ['revision', 'scope', 'task', 'declaration', 'compiler-declaration', 'coverage', 'accepted-input', 'input-artifact', 'backend', 'overlap', 'child-overlap', 'integrity', 'legacy', 'origin', 'unknown', 'failure'] as const) test(`receipt continuation refuses ${negative}`, async t => {
 const { cwd, d } = await gitDiagnosticsFixture(t);
 writeFileSync(join(cwd, 'README.md'), 'dirty candidate\n');
 d._agents.get('builder').def.tools = 'read,bash';
 let requirement = { id: 'A1', tag: 'test', text: 'exact', source: 'request', testCommand: 'test-exact', compilerCommand: 'compile-exact', criticalConditions: ['preserve'], status: 'open' };
 d.state.getAssertions = () => [requirement];
 const inputFile = join(d.state.getSessionDir(), 'input.md');
 if (negative === 'input-artifact') { writeFileSync(inputFile, 'original input'); d.artifacts.loadInputArtifacts = () => [{path:inputFile,input:inputFile,displayPath:inputFile,preview:'input'}]; }
 let run = 0;
 d.dispatchAgent = async () => {
  const revision = worktreeRevision(cwd, [], ['README.md']);
  const command = ++run === 1 ? 'test-exact' : requirement.compilerCommand;
  return { output: 'report', exitCode: 0, elapsed: 1, dispatchId: negative === 'origin' && run === 1 ? undefined : `negative-${negative}-${run}`, lifecycle: nativeCleanLifecycle, runtimeTests: [{ producer: 'agent-fleet.runtime-test/v1', command, exitCode: 0, beforeRevision: revision, afterRevision: revision, ...(negative === 'child-overlap' && run === 1 ? { exclusive: false } : {}) }] };
 };
 const execute = createDispatchExecutor(d as any);
 const invoke = (name: string, scope = ['README.md']) => execute(name, { agent: 'builder', task: `A1 ${name}`, scope }, undefined, undefined, { cwd } as any) as Promise<any>;
 await invoke('capture');
 const receipts = d.state.getProcessState().runtimeReceipts;
 if (negative === 'revision') writeFileSync(join(cwd, 'README.md'), 'new revision\n');
 if (negative === 'task') d.noProgress.adopt('different-task');
 if (negative === 'declaration') requirement = { ...requirement, text: 'new declaration' };
 if (negative === 'compiler-declaration') requirement = { ...requirement, compilerCommand: 'compile-new' };
 if (negative === 'coverage') requirement = { ...requirement, criticalConditions: ['new condition'] };
 if (negative === 'accepted-input') (d.state as any).getAcceptedUserInput = () => 'changed accepted input';
 if (negative === 'input-artifact') writeFileSync(inputFile, 'changed input');
 if (negative === 'integrity') writeFileSync(receipts.records[0].check.evidenceRef, 'forged same filename');
 if (negative === 'legacy') d.state.setProcessState({ ...d.state.getProcessState(), runtimeReceipts: undefined });
 if (negative === 'overlap') d.state.setActiveWritableDispatches(1);
 if (negative === 'backend') d._agents.get('builder').lastBackend = 'coms';
 if (negative === 'unknown' || negative === 'failure') {
  const { runtimeTestObservationFromResult } = await import('../runtime-test-check.ts');
  const original = d.dispatchAgent;
  d.dispatchAgent = async () => ({ output: 'unknown/failed check', exitCode: 0, elapsed: 1, dispatchId: `invalidate-${negative}`, runtimeTests: [negative === 'unknown' ? runtimeTestObservationFromResult(true, 'test-exact', 'bash', {}) : { producer: 'agent-fleet.runtime-test/v1', command: 'test-exact', exitCode: 1, beforeRevision: worktreeRevision(cwd, []), afterRevision: worktreeRevision(cwd, []) }] });
  await invoke('invalidate');
  d.dispatchAgent = original;
 }
 const result = await invoke('compiler-only', negative === 'scope' ? ['README.md', 'src/api.ts'] : ['README.md']);
 assert.notEqual(result.details.verificationResult?.requirements.find((r: any) => r.id === 'A1')?.status, 'passed', negative);
 assert.notEqual(result.details.accepted, true);
 if (negative === 'unknown' || negative === 'failure') assert.equal(d.state.getProcessState().runtimeReceipts.records.some((r: any) => r.check.command[0] === 'test-exact'), false);
});

/** Fresh in-dispatch observations must obey capture integrity at the parent, even when the record itself does not carry exclusive:false (stub adapter, foreign producer, or a lost integrity value). Only an explicit 'complete' stream is eligible. */
for (const integrity of ['complete', 'tainted', 'missing'] as const) test(`fresh runtime-test check is eligible for acceptance only on a complete capture stream: ${integrity}`, async t => {
 const { cwd, d } = await gitDiagnosticsFixture(t);
 writeFileSync(join(cwd, 'README.md'), 'fresh candidate\n');
 d._agents.get('builder').def.tools = 'read,bash';
 const testCommand = 'node --test fresh-only.test.js';
 d.state.getAssertions = () => [{ id: 'A1', tag: 'test', text: 'exact producer', source: 'approved', testCommand, status: 'open' }];
 d.dispatchAgent = async () => {
  const revision = worktreeRevision(cwd, [], ['README.md']);
  return { output: 'report', exitCode: 0, elapsed: 1, dispatchId: `fresh-${integrity}`,
   ...(integrity === 'missing' ? {} : { lifecycle: { launched: true, closeSeen: true, runtimeCaptureIntegrity: integrity } }),
   runtimeTests: [{ producer: 'agent-fleet.runtime-test/v1', command: testCommand, exitCode: 0, beforeRevision: revision, afterRevision: revision }] };
 };
 const result: any = await createDispatchExecutor(d as any)(`fresh-${integrity}`, { agent: 'builder', task: 'A1 fresh check', scope: ['README.md'] }, undefined, undefined, { cwd } as any);
 const check = result.details.verificationResult.checks.find((c: any) => c.command[0] === testCommand);
 assert.ok(check, 'fresh observation is still reported as a check');
 const requirement = result.details.verificationResult.requirements.find((r: any) => r.id === 'A1');
 if (integrity === 'complete') {
  assert.match(check.inspectedRevision, /^[a-f0-9]{64}$/, 'clean stream keeps the inspected revision');
  assert.equal(requirement.status, 'passed');
 } else {
  assert.equal(check.inspectedRevision, 'unavailable', `${integrity} stream must not expose a usable inspected revision`);
  assert.equal(requirement.status, 'stale', `${integrity} stream must not pass the bound requirement`);
  assert.notEqual(result.details.accepted, true);
 }
});

test('operator same-task recovery combines only anchored producers and leaves manual acceptance unsupported', async t => {
 const f=await operatorStateFixture(t); const prior=f.d.state.getAssertions();
 f.d.state.getAssertions=()=>prior.map(r=>r.id==='A2'?{...r,compilerCommand:'compile-exact'}:r);
 let runs=0; const original=f.d.dispatchAgent;
 f.d.dispatchAgent=async()=>{
  const response:any=await original();const revision=worktreeRevision(f.cwd,[]);
  response.dispatchId=`operator-continuation-${++runs}`;response.lifecycle=nativeCleanLifecycle;
  response.runtimeTests=runs===1?[{producer:'agent-fleet.runtime-test/v1',command:'node --test candidate.test.js',exitCode:0,beforeRevision:revision,afterRevision:revision},{producer:'agent-fleet.runtime-test/v1',command:'compile-exact',exitCode:null,beforeRevision:'unavailable',afterRevision:'unavailable'}]:[{producer:'agent-fleet.runtime-test/v1',command:'compile-exact',exitCode:0,beforeRevision:revision,afterRevision:revision}];
  return response;
 };
 const params:any={agent:'code-reviewer',task:'A2 inspect candidate',scope:['a.ts'],backend:'native',review_mode:'operator-current-state'};
 const one:any=await f.run('first',params,undefined,undefined,{cwd:f.cwd} as any);
 assert.equal(one.details.operatorStateVerification.status,'unproven');assert.equal(f.state().acceptance.evidenceRef,null);
 const journal=processAuditRecord(f.state(),evaluateProcessObligations(f.state(),{writable:true,budgetTier:'small'}));
 f.d.state.setProcessState(latestProcessState([{customType:'agent-hub-process-state',data:JSON.parse(JSON.stringify(journal))}]));
 const two:any=await f.run('second',{...params,task:'A2 complete explicit compiler'},undefined,undefined,{cwd:f.cwd} as any);
 assert.equal(two.details.operatorStateVerification.status,'accepted',JSON.stringify(two.details));
 assert.equal(two.details.taskAccepted,false);assert.equal(two.details.changeResult.status,'unchanged');
 assert.equal(two.details.verificationResult.requirements.find((r:any)=>r.id==='A1').status,'unsupported');
 assert.equal(two.details.verificationResult.requirements.find((r:any)=>r.id==='A2').status,'passed');
 assert.equal(two.details.verificationResult.checks.length,2);assert.equal(runs,2);
});

/** Production transport: native spawn settlement -> completion adapter -> dispatcher. A test that spreads the raw spawn result skips the adapter and cannot prove end-to-end integrity propagation. */
async function throughNativeCompletion(native:any,dispatchId:string){
 const {completeNativeRun}=await import('../dispatch-native-complete.ts');
 const state:any={def:{name:'builder'},status:'running',killedByOperator:false,restarting:false,timeline:[]};
 const run:any={deps:{displayName:(n:string)=>n,finalizeMonitorChild:async()=>{},updateWidget(){},appendTimelineText(){},flushTimelineStore(){},executionHistory:{end(){}},bumpDriftStop(){}},state,ctx:{ui:{notify(){}}},histEntry:{id:'hist'},monitorStart:undefined,startTime:Date.now(),key:'builder',agentKey:'builder',effectiveTools:'read,bash',evidenceDir:'/tmp',dispatchId,transcriptPath:'/tmp/transcript.jsonl',resumeContract:{},agentSessionFile:'/tmp/session.json'};
 return completeNativeRun(run,{res:native,runBilled:0,runOut:0,sessionRecycled:false,sessionReset:null,driftStop:null,driftAdvisories:[]});
}

for(const scenario of ['serial','overlap','unfinished','stale'] as const) test(`bound IDs and native interval attribution reach dispatcher: ${scenario} (offline only)`,async t=>{
 const {cwd,d}=await gitDiagnosticsFixture(t);
 const {spawnPiAgent}=await import('../spawn.ts');
 const command='test-exact';const ids=['B1','A1','A4','R2'];
 d.state.getAssertions=()=>ids.map(id=>({id,tag:id==='B1'?'test':'manual',text:'parent obligation',source:'fixture',status:'open',...(id==='B1'?{testCommand:command}:{})})) as any;
 let captured:any;let completed:any;
 d.dispatchAgent=async(...args:any[])=>{
  captured=args[8];
  assert.deepEqual(captured.boundAssertionIds,[...ids,'AF-MIN-CHANGE']);
  writeFileSync(join(cwd,'README.md'),`candidate ${scenario}\n`);
  const revision=worktreeRevision(cwd,[],['README.md']);
  const start=(id:string,toolName:string)=>({type:'tool_execution_start',toolName,toolCallId:id,args:{command}});
  const end=(id:string,toolName:string)=>({type:'tool_execution_end',toolName,toolCallId:id,result:toolName==='bash'?{details:{runtimeTest:{producer:'agent-fleet.runtime-test/v1',command,exitCode:0,beforeRevision:scenario==='stale'?'old':revision,afterRevision:revision}}}:{}});
  const events=[start('r','read'),start('g','grep'),end('r','read'),end('g','grep'),start('b','bash'),...(scenario==='overlap'?[start('x','read')]:[]),end('b','bash'),...(scenario==='overlap'?[end('x','read')]:[]),...(scenario==='unfinished'?[start('lost','read')]:[])];
  const bin=mkdtempSync(join(tmpdir(),'dispatch-events-'));t.after(()=>rmSync(bin,{recursive:true,force:true}));
  writeFileSync(join(bin,'pi'),`#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(events.map(e=>JSON.stringify(e)).join('\n')+'\n')});\n`,{mode:0o755});
  const native=await spawnPiAgent({model:'fake/offline',tools:'bash',thinking:'off',systemPrompt:'offline',sessionFile:join(bin,'session.json'),prompt:'fixture',cwd,env:{PATH:`${bin}:${process.env.PATH??''}`},runtimeTestObserver:true});
  completed=await throughNativeCompletion(native,`interval-${scenario}`);
  return {...completed,elapsed:1,output:JSON.stringify({changed_files:['README.md'],assertions_proven:ids.map(id=>({id,evidence:'untrusted claim'})),assertions_unproven:[{id:'AF-MIN-CHANGE'}],assertions_failed:[],tests_run:[],open_risks:[],requires_user_decision:[]})};
 };
 const result:any=await createDispatchExecutor(d as any)(scenario,{agent:'builder',task:'B1 A1 A4 R2 verify',scope:['README.md']},undefined,undefined,{cwd} as any);
 assert.ok(captured);
 assert.equal(completed.lifecycle?.runtimeCaptureIntegrity,scenario==='unfinished'?'tainted':'complete','completion adapter must forward parser-owned integrity');
 const requirements=result.details.verificationResult.requirements;
 assert.equal(requirements.find((r:any)=>r.id==='B1').status,scenario==='serial'?'passed':'stale',JSON.stringify(requirements));
 for(const id of ['A1','A4','R2']) assert.equal(requirements.find((r:any)=>r.id===id).status,'unsupported');
 assert.notEqual(result.details.accepted,true);
 assert.equal(result.details.contractNotices.some((n:any)=>n.type==='missing'||n.type==='unknown'),false,JSON.stringify(result.details.contractNotices));
});


test("dispatch binding distinguishes an absent parent ledger from an exact parent contract", () => {
 for (const tools of ["read", "read,write"]) {
  const legacy = prepareDeps({ tools });
  const legacyPrepared = prepareDispatch(legacy as any, { agent: "builder", task: "A1 legacy compiler claim" }, { cwd: process.cwd() } as any) as any;
  assert.equal(legacyPrepared.resumeContract.boundAssertionIds, undefined);
  const bound = prepareDeps({ tools });
  bound.state.getAssertions = () => [{ id: "B1", tag: "manual", text: "parent-owned", source: "fixture", status: "open" }] as any;
  const boundPrepared = prepareDispatch(bound as any, { agent: "builder", task: "B1 exact parent contract; A1 is not a member" }, { cwd: process.cwd() } as any) as any;
  assert.deepEqual(boundPrepared.resumeContract.boundAssertionIds, tools === "read" ? [] : ["B1", "AF-MIN-CHANGE"]);
  assert.ok(Object.isFrozen(boundPrepared.resumeContract.boundAssertionIds));
 }
});

for (const scenario of ['clean-empty', 'clean-read', 'open-read', 'open-write', 'open-unknown', 'open-bash', 'orphan-end', 'missing-id', 'duplicate-start', 'malformed-bash', 'mismatched-name'] as const) test(`native empty-completed stream receipt continuation: ${scenario} (offline only)`, async t => {
 const {cwd,d}=await gitDiagnosticsFixture(t);
 const {spawnPiAgent}=await import('../spawn.ts');
 const command='test-exact';
 d._agents.get('builder').def.tools='read,bash';
 d.state.getAssertions=()=>[{id:'B1',tag:'test',text:'exact parent obligation',source:'fixture',testCommand:command,status:'open'},...['A1','A4','R2'].map(id=>({id,tag:'manual',text:'manual stays open',source:'fixture',status:'open'}))] as any;
 const bin=mkdtempSync(join(tmpdir(),'receipt-stream-'));t.after(()=>rmSync(bin,{recursive:true,force:true}));
 const start=(toolName:string,id:any='x',args:any={})=>({type:'tool_execution_start',toolName,toolCallId:id,args});
 const end=(toolName:string,id='x',result:any={})=>({type:'tool_execution_end',toolName,toolCallId:id,result});
 const streams:Record<string,any[]>={
  'clean-empty':[], 'clean-read':[start('read'),end('read')],
  'open-read':[start('read')], 'open-write':[start('write')], 'open-unknown':[start('unknown')],
  'open-bash':[start('bash','x',{command:'other-command'})], 'orphan-end':[end('read')],
  'missing-id':[start('read',undefined)], 'duplicate-start':[start('read'),start('read'),end('read')],
  'malformed-bash':[start('bash'),end('bash')], 'mismatched-name':[start('read'),end('grep')],
 };
 // Default parameters would supply an ID; explicitly remove it for this case.
 delete streams['missing-id'][0].toolCallId;
 let run=0;let native:any;let completed:any;
 d.dispatchAgent=async()=>{
  const revision=worktreeRevision(cwd,[],['README.md']);
  const events=++run===1?[start('bash','seed',{command}),end('bash','seed',{details:{runtimeTest:{producer:'agent-fleet.runtime-test/v1',command,exitCode:0,beforeRevision:revision,afterRevision:revision}}})]:run===2?streams[scenario]:[];
  writeFileSync(join(bin,'pi'),`#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(events.map(e=>JSON.stringify(e)).join('\n')+'\n')});\n`,{mode:0o755});
  native=await spawnPiAgent({model:'fake/offline',tools:'bash',thinking:'off',systemPrompt:'offline',sessionFile:join(bin,'session.json'),prompt:'fixture',cwd,env:{PATH:`${bin}:${process.env.PATH??''}`},runtimeTestObserver:true});
  completed=await throughNativeCompletion(native,`empty-stream-${scenario}-${run}`);
  return {...completed,elapsed:1,output:'report'};
 };
 const execute=createDispatchExecutor(d as any);
 const invoke=()=>execute('inspect',{agent:'builder',task:'B1 A1 A4 R2 inspect',scope:['README.md']},undefined,undefined,{cwd} as any) as Promise<any>;
 const first=await invoke();
 assert.equal(first.details.verificationResult.requirements.find((r:any)=>r.id==='B1').status,'passed');
 assert.equal(d.state.getProcessState().runtimeReceipts.records.length,1,'seed is eligible');
 const original=JSON.parse(JSON.stringify(d.state.getProcessState().runtimeReceipts.records[0]));
 const current=await invoke();
 assert.equal(native.runtimeTests.filter((r:any)=>r.finishedAt!==undefined).length,0,'current stream has zero completed observations');
 assert.equal(native.runtimeTests.length,scenario==='open-bash'?1:0,'no fabricated test record');
 const clean=scenario.startsWith('clean-');
 assert.equal(current.details.verificationResult.checks.some((c:any)=>c.command[0]===command),clean,'parent must not reuse prior check after tainted stream');
 assert.equal(native.lifecycle.runtimeCaptureIntegrity,clean?'complete':'tainted');
 assert.equal(completed.lifecycle?.runtimeCaptureIntegrity,clean?'complete':'tainted','completion adapter must not strip parser-owned integrity');
 assert.equal(d.state.getProcessState().runtimeReceipts.records.length,clean?1:0);
 if(clean) assert.deepEqual(JSON.parse(JSON.stringify(d.state.getProcessState().runtimeReceipts.records[0])),original,'original receipt unchanged');
 assert.notEqual(current.details.accepted,true);
 for(const id of ['A1','A4','R2']) assert.equal(current.details.verificationResult.requirements.find((r:any)=>r.id===id).status,'unsupported');
 const later=await invoke();
 assert.equal(later.details.verificationResult.checks.some((c:any)=>c.command[0]===command),clean,'tainted capture cannot reappear on a later clean stream');
});

test('native completion without an explicit capture integrity fails closed for receipt reuse (offline only)', async t => {
 const {cwd,d}=await gitDiagnosticsFixture(t);
 const {spawnPiAgent}=await import('../spawn.ts');
 const command='test-exact';
 d._agents.get('builder').def.tools='read,bash';
 d.state.getAssertions=()=>[{id:'B1',tag:'test',text:'exact parent obligation',source:'fixture',testCommand:command,status:'open'}] as any;
 const bin=mkdtempSync(join(tmpdir(),'receipt-absent-'));t.after(()=>rmSync(bin,{recursive:true,force:true}));
 let run=0;
 d.dispatchAgent=async()=>{
  const revision=worktreeRevision(cwd,[],['README.md']);
  const events=++run===1?[{type:'tool_execution_start',toolName:'bash',toolCallId:'seed',args:{command}},{type:'tool_execution_end',toolName:'bash',toolCallId:'seed',result:{details:{runtimeTest:{producer:'agent-fleet.runtime-test/v1',command,exitCode:0,beforeRevision:revision,afterRevision:revision}}}}]:[];
  writeFileSync(join(bin,'pi'),`#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(events.map(e=>JSON.stringify(e)).join('\n')+'\n')});\n`,{mode:0o755});
  const native=await spawnPiAgent({model:'fake/offline',tools:'bash',thinking:'off',systemPrompt:'offline',sessionFile:join(bin,'session.json'),prompt:'fixture',cwd,env:{PATH:`${bin}:${process.env.PATH??''}`},runtimeTestObserver:true});
  const completed=await throughNativeCompletion(run===1?native:{...native,lifecycle:{launched:true,closeSeen:true}},`absent-integrity-${run}`);
  assert.equal(completed.lifecycle?.runtimeCaptureIntegrity,run===1?'complete':undefined,'adapter must not invent an integrity value');
  return {...completed,elapsed:1,output:'report'};
 };
 const execute=createDispatchExecutor(d as any);
 const invoke=()=>execute('inspect',{agent:'builder',task:'B1 inspect',scope:['README.md']},undefined,undefined,{cwd} as any) as Promise<any>;
 const first=await invoke();
 assert.equal(first.details.verificationResult.requirements.find((r:any)=>r.id==='B1').status,'passed');
 assert.equal(d.state.getProcessState().runtimeReceipts.records.length,1,'seed is eligible');
 const current=await invoke();
 assert.equal(current.details.verificationResult.checks.some((c:any)=>c.command[0]===command),false,'absent integrity on an expected native capture must not reuse the prior check');
 assert.equal(d.state.getProcessState().runtimeReceipts.records.length,0,'absent integrity clears reusable records');
 assert.notEqual(current.details.accepted,true);
});

/** Offline composed regression. Fake Pi JSONL only; commands are receipt identities, never executed. */
const COMPOSED_SHARED = 'node --test --test-timeout=15000 .pi/agent-fleet/scripts/fleet-codex-actions-compat.test.ts';
const COMPOSED_B2 = 'node --test b2-offline-fixture.test.js';
const COMPOSED_B3 = 'node --test b3-offline-fixture.test.js';
const COMPOSED_B4 = 'node --test b4-offline-fixture.test.js';
const COMPOSED_COMPILER = 'node --check b4-offline-fixture.js';
const COMPOSED_TASK = 'AF-MIN-CHANGE B1 B2 B3 B4 A1 A4 R2 inspect current candidate';

function composedLedger() {
 return [
  { id: 'AF-MIN-CHANGE', tag: 'test', text: 'Inspect the actual changed state and run an applicable verification command against it.', source: 'runtime:minimal-change-contract', reference: 'T2a', testCommand: COMPOSED_SHARED, criticalConditions: ['Historical logs are not imported as current runtime checks.'], status: 'open' },
  { id: 'B1', tag: 'test', text: 'B1 exact producer', source: 'fixture', testCommand: COMPOSED_SHARED, status: 'open' },
  { id: 'B2', tag: 'test', text: 'B2 exact producer', source: 'fixture', testCommand: COMPOSED_B2, status: 'open' },
  { id: 'B3', tag: 'test', text: 'B3 exact producer', source: 'fixture', testCommand: COMPOSED_B3, status: 'open' },
  { id: 'B4', tag: 'test', text: 'B4 test and compiler producers', source: 'fixture', testCommand: COMPOSED_B4, compilerCommand: COMPOSED_COMPILER, status: 'open' },
  { id: 'A1', tag: 'manual', text: 'relay recorded', source: 'fixture', status: 'open' },
  { id: 'A4', tag: 'manual', text: 'independent review', source: 'fixture', status: 'open' },
  { id: 'R2', tag: 'manual', text: 'manual obligation', source: 'fixture', status: 'open' },
 ];
}

function composedEvents(kind, revision) {
 const start = (id, toolName, args = {}) => ({ type: 'tool_execution_start', toolName, toolCallId: id, args });
 const end = (id, toolName, extra = {}) => ({ type: 'tool_execution_end', toolName, toolCallId: id, ...extra });
 const reads = (prefix) => [start(prefix + 'r', 'read', { path: 'a.ts' }), start(prefix + 'g', 'grep', { path: 'a.ts' }), start(prefix + 'l', 'ls'), end(prefix + 'r', 'read'), end(prefix + 'g', 'grep'), end(prefix + 'l', 'ls')];
 const ok = (id, command) => [start(id, 'bash', { command }), end(id, 'bash', { result: { details: { runtimeTest: { producer: 'agent-fleet.runtime-test/v1', command, exitCode: 0, beforeRevision: revision, afterRevision: revision } } } })];
 const text = { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '**Verdict:** APPROVE\ntests_run: full regression\n' } };
 if (kind === 'compiler-prep') return [text, start('prep-read', 'read'), ...ok('prep-status', 'git status --porcelain'), end('prep-read', 'read'), ...ok('compiler', COMPOSED_COMPILER)];
 if (kind === 'compiler') return [text, ...reads('pre'), ...ok('compiler', COMPOSED_COMPILER), ...reads('post')];
 const tests = [COMPOSED_SHARED, COMPOSED_B2, COMPOSED_B3, COMPOSED_B4];
 const body: any[] = [text, ...reads('before')];
 tests.forEach((command, index) => {
  const id = 'b' + (index + 1);
  body.push(start(id, 'bash', { command }));
  if (kind === 'overlap' && index === 0) body.push(start('w', 'write', { path: 'a.ts' }));
  body.push(end(id, 'bash', { result: { details: { runtimeTest: { producer: 'agent-fleet.runtime-test/v1', command, exitCode: 0, beforeRevision: revision, afterRevision: revision } } } }));
  if (kind === 'overlap' && index === 0) body.push(end('w', 'write'));
  body.push(...reads('between' + index));
 });
 body.push(start('compiler', 'bash', { command: COMPOSED_COMPILER }), end('compiler', 'bash', { isError: true, result: { isError: true } }));
 return body;
}

async function composedFixture(t: any) {
 const cwd = mkdtempSync(join(tmpdir(), 'composed-review-')); t.after(() => rmSync(cwd, { recursive: true, force: true }));
 execFileSync('git', ['init', '-q'], { cwd });
 writeFileSync(join(cwd, 'a.ts'), 'export const a=1;\n');
 const d = prepareDeps({ agents: ['code-reviewer'], tools: 'read,bash' });
 d._agents.get('code-reviewer')!.lastBackend = 'native';
 const session = mkdtempSync(join(tmpdir(), 'composed-session-')); t.after(() => rmSync(session, { recursive: true, force: true }));
 d.state.getSessionDir = () => session;
 const { createAssertionsArtifactsContext } = await import('../context/assertions-artifacts.ts');
 d.artifacts.writeRunArtifact = createAssertionsArtifactsContext({ getAssertions: () => [], getSessionDir: () => session, getRunHistoryKeep: () => null, setStatus: () => {} }).writeRunArtifact;
 let state = applyProcessClassification(createProcessState(), { risk: 'high', scope: 'wide', reason: 'composed fixture' }).state;
 state = noteProcessStage(state, 'plan', { evidenceRef: 'fixture:plan', revision: worktreeRevision(cwd, []) });
 d.state.getProcessState = () => state; d.state.setProcessState = (value: any) => { state = value; };
 const journalPath = join(session, 'process-journal.json');
 // Offline stand-in only: writes processAuditRecord bytes. Does not call pi.appendEntry and is not a process restart.
 d.state.persistProcessVerdict = (next: any, verdict: any) => {
  const prior = existsSync(journalPath) ? JSON.parse(readFileSync(journalPath, 'utf8')) : [];
  prior.push({ customType: 'agent-hub-process-state', data: processAuditRecord(next, verdict) });
  writeFileSync(journalPath, JSON.stringify(prior));
 };
 const ledger = composedLedger();
 d.state.getAssertions = () => ledger as any;
 const bin = mkdtempSync(join(tmpdir(), 'composed-events-')); t.after(() => rmSync(bin, { recursive: true, force: true }));
 const { spawnPiAgent } = await import('../spawn.ts');
 let runs = 0; const completed: any[] = []; const commandsSeen: string[][] = []; const observedTests: any[][] = [];
 const runKind = { current: 'interrupted' as 'interrupted' | 'compiler' | 'overlap', stdoutExtra: '' };
 d.dispatchAgent = async () => {
  const revision = worktreeRevision(cwd, []);
  const events = composedEvents(runKind.current, revision);
  const stdout = events.map((event: any) => JSON.stringify(event)).join('\n') + '\n' + runKind.stdoutExtra;
  writeFileSync(join(bin, 'pi'), '#!/usr/bin/env node\nprocess.stdout.write(' + JSON.stringify(stdout) + ');\n', { mode: 0o755 });
  const native = await spawnPiAgent({ model: 'fake/offline', tools: 'bash', thinking: 'off', systemPrompt: 'offline', sessionFile: join(bin, 'session.json'), prompt: 'fixture', cwd, env: { PATH: bin + ':' + (process.env.PATH ?? '') }, runtimeTestObserver: true });
  commandsSeen.push((native.runtimeTests ?? []).map((row: any) => row.command));
  observedTests.push(native.runtimeTests ?? []);
  const adapted = await throughNativeCompletion(native, 'composed-' + runKind.current + '-' + (++runs));
  completed.push(adapted);
  return { ...adapted, elapsed: 1 };
 };
 return {
  cwd, d, ledger, journalPath, completed, commandsSeen, observedTests, runKind, runs: () => runs,
  state: () => state,
  reloadFromDisk() {
   const disk = JSON.parse(readFileSync(journalPath, 'utf8'));
   state = latestProcessState(disk);
   return state;
  },
  run: createDispatchExecutor(d as any),
  params: { agent: 'code-reviewer', task: COMPOSED_TASK, scope: ['a.ts'], backend: 'native', review_mode: 'operator-current-state' } as any,
 };
}

test('composed native interruption then compiler reuses original receipts for operator acceptance (offline only)', async t => {
 const f = await composedFixture(t);
 f.runKind.current = 'interrupted';
 const one: any = await f.run('dispatch1', f.params, undefined, undefined, { cwd: f.cwd } as any);
 assert.equal(f.completed[0].lifecycle?.runtimeCaptureIntegrity, 'complete');
 assert.notEqual(one.details.processVerdict?.accepted, true);
 assert.equal(one.details.operatorStateVerification.status, 'unproven');
 assert.equal(one.details.taskAccepted, false);
 const receipts = f.state().runtimeReceipts.records;
 assert.equal(receipts.length, 4, JSON.stringify(receipts.map((r: any) => r.check.command)));
 const origin = receipts.map((r: any) => ({ command: r.check.command[0], id: r.originDispatchId, at: r.capturedAt }));
 assert.ok(origin.every((row: any) => row.id === 'composed-interrupted-1' && Number.isSafeInteger(row.at) && row.at > 0));
 const shared = receipts.find((r: any) => r.check.command[0] === COMPOSED_SHARED);
 assert.ok(shared.check.requirementIds.includes('AF-MIN-CHANGE') && shared.check.requirementIds.includes('B1'));
 assert.equal(f.commandsSeen[0].filter((command: string) => command === COMPOSED_SHARED).length, 1);
 const memoryBeforeReload = f.state();
 const diskBytes = readFileSync(f.journalPath, 'utf8');
 const parsedJournal = JSON.parse(diskBytes);
 const reloaded = f.reloadFromDisk();
 assert.equal(reloaded.runtimeReceipts.records.length, 4);
 assert.notEqual(reloaded, memoryBeforeReload, 'reload must be a distinct object from the pre-disk state');
 assert.deepEqual(reloaded, latestProcessState(parsedJournal), 'reloaded state must be the normalized journal bytes');
 assert.notEqual(reloaded, latestProcessState(parsedJournal), 'a second parse must not alias the reloaded object');
 const persistedReceipts = parsedJournal.at(-1).data.state.runtimeReceipts.records;
 assert.deepEqual(reloaded.runtimeReceipts.records.map((row: any) => row.originDispatchId), persistedReceipts.map((row: any) => row.originDispatchId));
 const savedOrigin = reloaded.runtimeReceipts.records[0].originDispatchId;
 reloaded.runtimeReceipts.records[0].originDispatchId = 'mutated-in-memory';
 assert.equal(readFileSync(f.journalPath, 'utf8'), diskBytes, 'mutating the reloaded object must not rewrite the journal');
 assert.notEqual(latestProcessState(JSON.parse(diskBytes)).runtimeReceipts.records[0].originDispatchId, 'mutated-in-memory');
 reloaded.runtimeReceipts.records[0].originDispatchId = savedOrigin;
 f.runKind.current = 'compiler';
 f.runKind.stdoutExtra = '';
 const two: any = await f.run('dispatch2', f.params, undefined, undefined, { cwd: f.cwd } as any);
 assert.equal(f.completed[1].lifecycle?.runtimeCaptureIntegrity, 'complete');
 assert.deepEqual(f.commandsSeen[1], [COMPOSED_COMPILER]);
 assert.equal(f.commandsSeen[1][0], COMPOSED_COMPILER);
 for (const banned of [COMPOSED_SHARED, COMPOSED_B2, COMPOSED_B3, COMPOSED_B4]) assert.equal(f.commandsSeen[1].includes(banned), false, banned);
 const retained = f.state().runtimeReceipts.records.filter((r: any) => r.check.command[0] !== COMPOSED_COMPILER);
 assert.equal(retained.length, 4);
 for (const row of origin) {
  const again = retained.find((r: any) => r.check.command[0] === row.command);
  assert.equal(again.originDispatchId, row.id);
  assert.equal(again.capturedAt, row.at);
  assert.equal(JSON.parse(readFileSync(again.check.evidenceRef, 'utf8')).declaration.dispatchId, row.id);
 }
 const requirements = two.details.verificationResult.requirements;
 for (const id of ['AF-MIN-CHANGE', 'B1', 'B2', 'B3', 'B4']) assert.equal(requirements.find((r: any) => r.id === id).status, 'passed', id);
 for (const id of ['A1', 'A4', 'R2']) assert.equal(requirements.find((r: any) => r.id === id).status, 'unsupported', id);
 assert.equal(two.details.taskAccepted, false);
 assert.equal(two.details.processVerdict.accepted, true, JSON.stringify(two.details.processVerdict));
 assert.equal(two.details.processVerdict.obligations.acceptance.status, 'satisfied');
 assert.equal(two.details.processVerdict.obligations.review.status, 'satisfied');
 assert.equal(two.details.operatorStateVerification.status, 'accepted');
 const proof = JSON.parse(readFileSync(two.details.operatorStateVerification.evidenceRef, 'utf8'));
 const proofDispatchIds = proof.checks.map((check: any) => JSON.parse(readFileSync(check.evidenceRef, 'utf8')).declaration.dispatchId);
 assert.ok(proofDispatchIds.includes('composed-interrupted-1') && proofDispatchIds.includes('composed-compiler-2'), JSON.stringify(proofDispatchIds));
 assert.equal(f.runs(), 2);
});

for (const negative of ['overlap', 'revision', 'ledger', 'tamper', 'tainted'] as const) test('composed native receipt regression refuses ' + negative + ' independently (offline only)', async t => {
 const f = await composedFixture(t);
 f.runKind.current = negative === 'overlap' ? 'overlap' : 'interrupted';
 const one: any = await f.run('dispatch1', f.params, undefined, undefined, { cwd: f.cwd } as any);
 if (negative === 'overlap') assert.equal(f.state().runtimeReceipts.records.length, 0, 'overlap clears reusable receipts');
 else assert.equal(f.state().runtimeReceipts.records.length, 4);
 f.reloadFromDisk();
 if (negative === 'revision') writeFileSync(join(f.cwd, 'a.ts'), 'export const a=2;\n');
 if (negative === 'ledger') f.ledger.find((row: any) => row.id === 'B4')!.compilerCommand = 'node --check changed-contract.js';
 if (negative === 'tamper') {
  const evidence = f.state().runtimeReceipts.records[0].check.evidenceRef;
  writeFileSync(evidence, readFileSync(evidence, 'utf8') + '\n');
 }
 f.runKind.current = 'compiler';
 f.runKind.stdoutExtra = negative === 'tainted' ? 'not-json-taint-outside-compiler-interval\n' : '';
 const two: any = await f.run('dispatch2', f.params, undefined, undefined, { cwd: f.cwd } as any);
 assert.notEqual(two.details.processVerdict?.accepted, true, negative);
 assert.notEqual(two.details.operatorStateVerification?.status, 'accepted', negative);
 assert.equal(two.details.taskAccepted, false);
 const reused = (f.state().runtimeReceipts?.records ?? []).filter((r: any) => r.originDispatchId === 'composed-interrupted-1');
 if (negative === 'overlap') assert.equal(reused.length, 0);
 if (negative === 'revision' || negative === 'ledger' || negative === 'tamper') assert.equal(two.details.verificationResult.checks.some((c: any) => c.command[0] === COMPOSED_SHARED && c.status === 'passed'), false, negative);
 if (negative === 'tainted') {
  assert.equal(f.completed[1].lifecycle?.runtimeCaptureIntegrity, 'tainted');
  const compiler = f.observedTests[1].find((row: any) => row.command === COMPOSED_COMPILER);
  assert.equal(compiler?.exitCode, 0, 'taint must sit on a compiler success that would otherwise be eligible');
  assert.deepEqual(f.commandsSeen[1], [COMPOSED_COMPILER], 'unparseable line must not be a second tool overlapping the compiler');
  const control = await composedFixture(t);
  control.runKind.current = 'interrupted';
  control.runKind.stdoutExtra = '';
  await control.run('dispatch1', control.params, undefined, undefined, { cwd: control.cwd } as any);
  control.reloadFromDisk();
  control.runKind.current = 'compiler';
  const accepted: any = await control.run('dispatch2', control.params, undefined, undefined, { cwd: control.cwd } as any);
  assert.equal(control.completed[1].lifecycle?.runtimeCaptureIntegrity, 'complete');
  assert.equal(control.observedTests[1].find((row: any) => row.command === COMPOSED_COMPILER)?.exitCode, 0);
  assert.deepEqual(control.commandsSeen[1], [COMPOSED_COMPILER]);
  assert.equal(accepted.details.processVerdict.accepted, true, 'identical compiler-success stream without the unparseable line must be accepted');
  assert.equal(accepted.details.operatorStateVerification.status, 'accepted');
 }
 assert.notEqual(one.details.processVerdict?.accepted, true);
});


test('compiler continuation retains checks after overlapping preparatory inspection (offline only)', async t => {
 const f = await composedFixture(t);
 await f.run('prep-origin', f.params, undefined, undefined, { cwd: f.cwd } as any);
 assert.equal(f.state().runtimeReceipts.records.length, 4);
 (f.runKind as any).current = 'compiler-prep';
 const result: any = await f.run('prep-continuation', f.params, undefined, undefined, { cwd: f.cwd } as any);
 assert.equal(f.completed[1].runtimeTests[0].exclusive, false);
 assert.equal(f.state().runtimeReceipts.records.length, 5);
 assert.equal(result.details.processVerdict.accepted, true);
});

for (const marker of ['Full-regression marker: all suites passed', 'full regression', 'tests_run: full']) test('review closure accepts regression marker: ' + marker, async () => {
 const { reviewMayClose } = await import('../orchestration-activation.ts');
 assert.equal(reviewMayClose({ revision: 'a'.repeat(64), scope: ['a.ts'], output: '**Verdict:** APPROVE\n' + marker, evidenceRef: 'evidence:current', declared: true, wide: true }), true);
});

test('unrelated clean inspection preserves receipts without borrowing their evidence (offline only)', async t => {
 const f = await composedFixture(t);
 await f.run('preserve-origin', f.params, undefined, undefined, { cwd: f.cwd } as any);
 const original = JSON.parse(JSON.stringify(f.state().runtimeReceipts.records));
 assert.equal(original.length, 4);
 const dispatch = f.d.dispatchAgent;
 f.d.dispatchAgent = async () => ({ output: '**Verdict:** APPROVE\nFull-regression marker: inspection only', exitCode: 0, elapsed: 1, dispatchId: 'unrelated-inspection', lifecycle: nativeCleanLifecycle, runtimeTests: [] });
 f.ledger[1].text = 'Different inspection contract';
 const inspection: any = await f.run('preserve-inspection', f.params, undefined, undefined, { cwd: f.cwd } as any);
 assert.equal(inspection.details.verificationResult.checks.length, 0, 'unrelated contract cannot borrow checks');
 assert.notEqual(inspection.details.processVerdict.accepted, true);
 assert.deepEqual(f.reloadFromDisk().runtimeReceipts.records, original, 'unused receipts survive journal reload byte-for-byte');
 f.ledger[1].text = 'B1 exact producer';
 f.d.dispatchAgent = dispatch;
 f.runKind.current = 'compiler';
 const final: any = await f.run('preserve-finish', f.params, undefined, undefined, { cwd: f.cwd } as any);
 assert.equal(final.details.verificationResult.checks.length, 5);
 assert.equal(final.details.processVerdict.accepted, true);
});

test('regression marker cannot replace evidence or approve a partial regression', async () => {
 const { reviewMayClose } = await import('../orchestration-activation.ts');
 const input = { revision: 'a'.repeat(64), scope: ['a.ts'], output: '**Verdict:** APPROVE\nFull-regression marker: passed', declared: true, wide: true };
 assert.equal(reviewMayClose(input), false);
 for (const marker of ['partial regression', 'full regressionish', 'tests_run: fullish']) {
  assert.equal(reviewMayClose({ ...input, output: '**Verdict:** APPROVE\n' + marker, evidenceRef: 'evidence:current' }), false);
 }
});
