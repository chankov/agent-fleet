import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync,mkdtempSync,rmSync,writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDispatchExecutor,createRecoveryResearchExecutor,createResearchExecutor,prepareDispatch,structuredResearchPrompt,validateDispatchAgent } from "./dispatch-execution.ts";
import { applyProcessClassification,createProcessState,noteProcessStage,processPreEffectGate,evaluateProcessObligations,processAuditRecord,latestProcessState,normalizeProcessState } from "../process-obligations.ts";
import { adoptTaskTriageState,applyTaskTriageAdditions } from "../task-triage-obligations.ts";
import { createActionExecutors } from "./action-executors.ts";
import { createTaskTriageRuntime } from "../task-triage-runtime.ts";
import { TASK_TRIAGE_QUESTIONS,TASK_TRIAGE_QUESTION_VERSION } from "../task-triage-contract.ts";
import { activeOrchestrationHandoff } from "../orchestration-activation.ts";

import { prepareDeps,gitDiagnosticsFixture,highRiskChangedFixture } from "./dispatch-execution.test-support.ts";

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
		if (operation === "dispatch") assert.equal((d as any).noProgress.releaseUserInterrupts(), 1, "an aborted tool call is recorded as a human interrupt");
	});
}

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

test("missing scope roots refuse before accounting or dispatch", async () => {
 const d = prepareDeps(); let invoked = false;
 d.dispatchAgent = async () => { invoked = true; return { output: "zero matches", exitCode: 0, elapsed: 0 }; };
 const result = await createDispatchExecutor(d as any)("call", { agent: "builder", task: "Clean files", scope: ["nonexistent-scope-regression/**/*.cs"] }, undefined, undefined, {} as any);
 assert.equal((result.details as any).status, "scope_preflight_failed"); assert.equal(invoked, false); assert.equal(d._task(), 0);
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

test("only a consumed continuation permit may repeat a same-turn watchdog-stopped dispatch", () => {
	const fingerprints = new Set<string>();
	const d = prepareDeps();
	d.state.getTurnDispatchFingerprints = () => fingerprints;
	const params = { agent: "builder", task: "Implement plan step 2: finish the adapter.", scope: ["package.json"] } as any;
	const first = prepareDispatch(d as any, params, { cwd: process.cwd() } as any) as any;
	// finishDispatch records exit 124/125 (turn_timeout/drift_stop) fingerprints for this turn.
	fingerprints.add(first.fingerprint);
	const duplicate = prepareDispatch(d as any, structuredClone(params), { cwd: process.cwd() } as any) as any;
	assert.equal(duplicate.details?.reason, "duplicate_refused", "an ordinary model re-dispatch stays refused");
	const guard = d.noProgress as any;
	(d as any).noProgress = { ...guard, continuing: () => true };
	const continued = prepareDispatch(d as any, structuredClone(params), { cwd: process.cwd() } as any) as any;
	assert.equal(continued.details, undefined, "the human-confirmed continuation is prepared");
	assert.equal(continued.fingerprint, first.fingerprint);
});

test("recovery analysis is not fenced by an earlier crashed analysis and refuses escaping read scope before spawn", async () => {
	const d = prepareDeps();
	let spawned = 0;
	d.research = { anonymousDef: () => ({ name: "research" }), resolveModel: () => "local/model", createState: () => ({ id: spawned + 1 }), spawn: async () => { spawned++; return { output: "SYNTHETIC failure", exitCode: 1, elapsed: 0, dispatchId: `analysis-${spawned}` }; } } as any;
	const params = { task: "Analyse the interrupted task", read_scope: ["src/adapter.ts"] } as any;
	const guarded = createResearchExecutor(d as any);
	await guarded("first", params, undefined, undefined, {} as any);
	assert.equal(((await guarded("second", params, undefined, undefined, {} as any)).details as any).status, "no_progress_refused", "ordinary spawn_research keeps its fence");
	const analysis = createRecoveryResearchExecutor(d as any);
	await analysis("analysis-1", params, undefined, undefined, {} as any);
	await analysis("analysis-2", params, undefined, undefined, {} as any);
	assert.equal(spawned, 3, "each explicit recovery analysis reaches the read-only researcher");
	const escaping = await analysis("analysis-3", { ...params, read_scope: ["/etc/passwd"] }, undefined, undefined, {} as any);
	assert.equal((escaping.details as any).status, "invalid_input");
	assert.equal(spawned, 3);
});

test("an aborted dispatch tool call stops the running child, and only while it runs", async () => {
	const d = prepareDeps() as any; const controller = new AbortController(); const stopped: string[] = [];
	let release!: () => void; const running = new Promise<void>(resolve => { release = resolve; });
	d.cancelRunningDispatch = (agent: string) => { stopped.push(agent); release(); };
	d.dispatchAgent = async () => { await running; return { output: "", exitCode: 143, elapsed: 1 }; };
	const pending = createDispatchExecutor(d)("esc", { agent: "builder", task: "Produce requested work" } as any, controller.signal, undefined, {} as any);
	await new Promise(resolve => setTimeout(resolve, 20));
	assert.deepEqual(stopped, []);
	controller.abort();
	await pending;
	assert.deepEqual(stopped, ["builder"]);
	const later = new AbortController(); d.dispatchAgent = async () => ({ output: "", exitCode: 0, elapsed: 0 });
	await createDispatchExecutor(d)("done", { agent: "builder", task: "Produce other work" } as any, later.signal, undefined, {} as any);
	later.abort();
	assert.deepEqual(stopped, ["builder"]);
});
