import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync,mkdirSync,mkdtempSync,rmSync,writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDispatchExecutor } from "./dispatch-execution.ts";
import { extractAskUserQuestions } from "../presentation.ts";

import { prepareDeps,gitDiagnosticsFixture } from "./dispatch-execution.test-support.ts";

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
	const result = await createDispatchExecutor(d as any)("call", { agent: "editor", task: "bounded task", scope: ["src/*.ts"] }, undefined, undefined, { cwd: dir } as any);
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

test("exit zero without assertions is execution completion, not acceptance", async () => {
 const d = prepareDeps(); (d.artifacts as any).writeRunArtifact = () => "/tmp/full-return.md";
 d.dispatchAgent = async () => ({ output: "Done! <write>not a real tool call</write>", exitCode: 0, elapsed: 0 });
 const result = await createDispatchExecutor(d as any)("call", { agent: "editor", task: "Produce requested work" }, undefined, undefined, {} as any);
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
 (d._agents.get("editor") as any).lastBackend = "native";
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
 const params = { agent: "editor", task: "Produce both files", scope: ["docs/**"], deliverables: ["docs/one.md", "docs/two.md"] };
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
 (d._agents.get("editor") as any).lastBackend = "native";
 d.dispatchAgent = async () => ({
  output: "<tool_call><function=write>docs/out.md</function></tool_call>", exitCode: 0, elapsed: 1, dispatchId: "write-readback-failed",
  toolEvents: [{ toolName: "write", toolCallId: "write-out", args: JSON.stringify({ path: "docs/out.md", content: "x" }), completed: true, isError: false }],
 });
 const result = await createDispatchExecutor(d as any)("call", { agent: "editor", task: "Write output", scope: ["docs/**"], deliverables: ["docs/out.md"] }, undefined, undefined, { cwd } as any);
 assert.equal((result.details as any).status, "verification_failed");
 assert.equal((result.details as any).recoveryCategory, undefined);
 assert.equal((result.details as any).protocolDiagnostic, null);
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
 const result = await createDispatchExecutor(d as any)("call", { agent: "editor", task: "Produce report", scope: ["src/report.md"], deliverables: ["src/report.md"] }, undefined, undefined, { cwd } as any);
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
  const refused = await createDispatchExecutor(d as any)("retry", { agent: "editor", task: "Reworded report request", scope: ["src/report.md"], deliverables: ["src/report.md"] }, undefined, undefined, { cwd } as any);
  assert.equal((refused.details as any).status, "no_progress_refused", "missing deliverable still blocks unchanged retry");
 }
});

test("late result artifacts stay with the originating session namespace", async t => {
 const { mkdtempSync, mkdirSync, rmSync } = await import("node:fs"); const { join } = await import("node:path"); const { tmpdir } = await import("node:os");
 const { createAssertionsArtifactsContext } = await import("../context/assertions-artifacts.ts");
 const cwd = mkdtempSync(join(tmpdir(), "late-session-")); t.after(() => rmSync(cwd, { recursive: true, force: true }));
 const original = join(cwd, "original"), next = join(cwd, "next"); mkdirSync(original); mkdirSync(next);
 let current = original; const d = prepareDeps(); d.state.getSessionDir = () => current;
 d.artifacts = createAssertionsArtifactsContext({ getSessionDir: () => current, getAssertions: () => [], getRunHistoryKeep: () => 2, setStatus() {} }) as any;
 d.dispatchAgent = async () => { current = next; return { output: "old session result", exitCode: 0, elapsed: 0 }; };
 const result = await createDispatchExecutor(d as any)("call", { agent: "editor", task: "original work" }, undefined, undefined, { cwd } as any);
 assert.ok((result.details as any).returnPath.startsWith(original));
 assert.ok((result.details as any).assessmentPath.startsWith(original));
});

test("late old-task completion cannot auto-resume research or mutate new-task report", async () => {
 const d = prepareDeps(); let researchCalls = 0;
 d.extractNeedsResearch = () => ["old task question"];
 d.research = { spawn: async () => { researchCalls++; return { output: "findings", exitCode: 0 }; } };
 d.dispatchAgent = async () => { d.noProgress.reset(); d.state.setTaskDispatchCount(0); return { output: "NEEDS_RESEARCH: old task question", exitCode: 0, elapsed: 0 }; };
 const result = await createDispatchExecutor(d as any)("call", { agent: "editor", task: "old task" }, undefined, undefined, {} as any);
 assert.equal((result.details as any).staleTask, true); assert.equal(researchCalls, 0);
 assert.equal(d._task(), 0); assert.equal(d._report.dispatches.length, 0);
});

test("ASK_USER blocks the dispatch without a verification failure", async () => {
 const d = prepareDeps({ agents: ["editor"] });
 d.extractAskUserQuestions = extractAskUserQuestions;
 let calls = 0;
 d.dispatchAgent = async () => { calls++; return { output: "Need a decision.\nASK_USER: Which file should be edited?", exitCode: 0, elapsed: 1, dispatchId: "ask-1" }; };
 const result = await createDispatchExecutor(d as any)("ask", { agent: "editor", task: "edit" }, undefined, undefined, { cwd: "/tmp" } as any);
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
 const d = prepareDeps({ agents: ["editor"] });
 d.extractAskUserQuestions = extractAskUserQuestions;
 d.dispatchAgent = async () => ({ output: "ASK_USER: Where is the report?", exitCode: 0, elapsed: 1, dispatchId: "ask-missing" });
 const result = await createDispatchExecutor(d as any)("missing", { agent: "editor", task: "edit", deliverables: ["/tmp/missing-report.md"] }, undefined, undefined, { cwd: "/tmp" } as any);
 const details = result.details as any;
 assert.equal(details.status, "blocked_on_user");
 assert.equal(details.acceptanceStatus, "deliverable_failed");
 assert.equal(details.contractGap, "missing_deliverable");
 assert.notEqual(details.recoveryCategory, "verification_failed");
});

test("native structured report bypasses extraction but does not replace task evidence",async t=>{
 const {cwd,d}=await gitDiagnosticsFixture(t);let extracted=0;
 d.runReturnExtraction=async()=>{extracted++;throw new Error("must not extract");};
 const report={status:"completed",summary:"Specialist finished",changed_files:[],assertions_proven:[],assertions_unproven:[{id:"A1",reason:"not checked"}],assertions_failed:[],tests_run:[],open_risks:[],requires_user_decision:[],evidence:[]};
 d.dispatchAgent=async()=>({output:"Short final",exitCode:0,elapsed:1,dispatchId:"structured",specialistResultTool:true,specialistResult:report});
 const result=await createDispatchExecutor(d as any)("call",{agent:"editor",task:"A1 inspect"},undefined,undefined,{cwd} as any);
 const details=result.details as any;
 assert.equal(extracted,0);
 assert.equal(details.resultProtocol,"submit_result");
 assert.equal(details.specialistCompletion,"completed");
 assert.equal(details.taskAccepted,false);
 assert.equal(details.structuredReturn.assertions_unproven[0].id,"A1");
});
