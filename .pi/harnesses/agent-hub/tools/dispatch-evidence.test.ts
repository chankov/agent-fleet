import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { cpSync,existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,symlinkSync,writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join,relative,sep } from "node:path";
import { createDispatchExecutor,prepareDispatch } from "./dispatch-execution.ts";
import { applyProcessClassification,createProcessState,noteProcessStage,evaluateProcessObligations,processAuditRecord,latestProcessState } from "../process-obligations.ts";
import { worktreeRevision } from "../scope-gate.js";

import { prepareDeps,gitDiagnosticsFixture,nativeCleanLifecycle,operatorStateFixture } from "./dispatch-execution.test-support.ts";

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
 const execution = readFileSync(new URL("./dispatch-execution.ts", import.meta.url), "utf8");
 const evidence = readFileSync(new URL("./dispatch-evidence.ts", import.meta.url), "utf8");
 assert.equal((execution.match(/diffAgainst\(/g) ?? []).length, 0);
 assert.equal((evidence.match(/diffAgainst\(/g) ?? []).length, 1);
});

test("a writable dispatch observes the worktree once before and once after the run", () => {
 const source = readFileSync(new URL("./dispatch-execution.ts", import.meta.url), "utf8");
 const evidence = readFileSync(new URL("./dispatch-evidence.ts", import.meta.url), "utf8");
 const prepare = source.slice(source.indexOf("export function prepareDispatch"), source.indexOf("function startTracking"));
 assert.equal((prepare.match(/snapshotWorktree\(|worktreeRevision\(/g) ?? []).length, 1, "revision baseline and delta base share one snapshot");
 assert.match(source, /tracking\.snapshot = prepared\.beforeSnapshot \?\?/);
 assert.match(evidence, /compilerInspectedRevision = observation && !observation\.skipped && observation\.snapshot \? snapshotRevision\(observation\.snapshot\)/);
 assert.match(evidence, /repositoryAfterRevision = isSourceReview \|\| p\.revisionScopes\.length \? revisionOf\(cwd, p\.revisionScopes\) : compilerRan \? worktreeRevision\(cwd, \[\], p\.scopeGlobs\) : compilerInspectedRevision/, "reviews re-observe before approval; builders share the existing root snapshot unless the compiler ran");
 assert.match(prepare, /const basisFor=\(snapshot:any\):string\[\]=>snapshot\?\.nested\?nestedRevisionScopes\(/, "the basis is read off the dispatch's own snapshot, so a root repository costs no extra git call");
 assert.match(evidence, /const afterRevision = p\.privateConfig \? privateConfigRevision\(cwd, repositoryAfterRevision, p\.privateConfig\) : repositoryAfterRevision/, "old modes retain the repository observation unchanged");
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
   if (scenario === "stale") {
    const text = (result.content[0] as any).text;
    for (const phrase of [command, assessment.task.revision.after, "changed-during-check", "Paths changed since check: unknown", "Finish all edits first"]) assert.ok(text.includes(phrase), phrase);
   }
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
