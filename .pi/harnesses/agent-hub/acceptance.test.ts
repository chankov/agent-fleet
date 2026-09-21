import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildRuntimeResult, mapCompatibilityStatus, minimalChangeRequirement, preflightDeliverables, readBackDeliverables } from "./acceptance.ts";
import { applyProcessClassification, createProcessState, evaluateProcessObligations, latestProcessState, noteProcessStage, processAuditRecord, processPreEffectGate } from "./process-obligations.ts";

function fixture(t: any) {
 const cwd = mkdtempSync(join(tmpdir(), "fleet-acceptance-")); t.after(() => rmSync(cwd, { recursive: true, force: true }));
 const sessionDir = join(cwd, ".pi/session"); mkdirSync(sessionDir, { recursive: true }); mkdirSync(join(cwd, "src"));
 return { cwd, sessionDir };
}

test("missing root is distinct from zero matches; new roots require explicit create", t => {
 const f = fixture(t);
 assert.throws(() => preflightDeliverables({ scope: ["Application/RIN.Video/**/*.cs"] }, f), /Missing scope root/);
 assert.equal(preflightDeliverables({ scope: ["src/**/*.cs"] }, f).scopeRoots.length, 1);
 assert.doesNotThrow(() => preflightDeliverables({ scope: ["new/**/*.ts"], scope_mode: "create" }, f));
 assert.throws(() => preflightDeliverables({ scope: ["RIN.Video"] }, f), /Missing scope root/);
 assert.doesNotThrow(() => preflightDeliverables({ scope: ["src/new.ts"], deliverables: ["src/new.ts"] }, f));
 assert.throws(() => preflightDeliverables({ scope: ["../outside/**"], scope_mode: "create" }, f), /outside/);
});

test("deliverables are read back; missing, unchanged and changed files remain distinct", t => {
 const f = fixture(t); writeFileSync(join(f.cwd, "src/existing.ts"), "before");
 const contract = preflightDeliverables({ deliverables: ["src/existing.ts", "src/missing.ts"] }, f);
 let readback = readBackDeliverables(contract, f);
 assert.equal(readback[0].changed, false); assert.equal(readback[1].status, "missing");
 writeFileSync(join(f.cwd, "src/existing.ts"), "after"); writeFileSync(join(f.cwd, "src/missing.ts"), "created");
 readback = readBackDeliverables(contract, f);
 assert.ok(readback.every(file => file.status === "read" && file.changed));
 assert.equal(readback[0].preview, "after"); assert.equal(readback[0].bytes, 5);
 assert.match(readback[0].sha256!, /^[a-f0-9]{64}$/);
});

test("deliverable readback refuses symlink escape and does not guess between artifact kinds", t => {
 const f = fixture(t), outside = mkdtempSync(join(tmpdir(), "fleet-outside-")); t.after(() => rmSync(outside, { recursive: true, force: true }));
 writeFileSync(join(outside, "file"), "outside"); symlinkSync(outside, join(f.cwd, "escape"));
 assert.throws(() => preflightDeliverables({ deliverables: ["escape/file"] }, f), /outside/);
 mkdirSync(join(f.sessionDir, "artifacts/returns"), { recursive: true });
 writeFileSync(join(f.sessionDir, "artifacts/returns/report.md"), "old return, not requested review");
 const contract = preflightDeliverables({ deliverables: ["artifacts/reviews/report.md"] }, f);
 assert.equal(readBackDeliverables(contract, f)[0].status, "missing");
});

function runtime(overrides: any = {}) {
 const requirement = minimalChangeRequirement();
 return buildRuntimeResult({
  task: { id: "task-1", current: true, beforeRevision: "rev-before", afterRevision: "rev-after" },
  execution: { status: "completed", exitCode: 0, dispatchId: "run-1" },
  changes: { status: "changed", paths: ["src/a.ts"], attribution: "certain" },
  requirements: [requirement], deliverables: [], checks: [], evidenceRefs: [],
  ...overrides,
 });
}

test("empty assertions stay unaccepted without runtime checks", () => {
 const result = runtime();
 assert.equal(result.execution.status, "completed"); assert.equal(result.changes.status, "changed");
 assert.equal(result.verification.status, "missing"); assert.equal(result.acceptance.accepted, false);
 assert.equal(result.compatibility.hubAcceptanceStatus, "needs_verification");
});

test("missing and unchanged deliverables remain distinct and neither implies acceptance", () => {
 const missing = runtime({ deliverables: [{ path: "report.md", status: "missing" }] });
 assert.equal(missing.verification.status, "failed"); assert.equal(missing.compatibility.hubAcceptanceStatus, "deliverable_failed");
 const unchanged = runtime({ deliverables: [{ path: "report.md", status: "read", changed: false, retainedPath: "/e/report" }], checks: [{ producer: "runtime", taskId: "task-1", command: ["node", "--test"], exitCode: 0, inspectedRevision: "rev-after", evidenceRef: "/e/test", requirementIds: ["AF-MIN-CHANGE"] }] });
 assert.equal(unchanged.changes.status, "changed"); assert.equal(unchanged.verification.status, "failed"); assert.equal(unchanged.compatibility.hubAcceptanceStatus, "deliverable_failed"); assert.equal(unchanged.acceptance.accepted, false);
 assert.ok(unchanged.verification.evidenceRefs.includes("/e/report"));
});

test("UTC calendar-day requirement cannot be proven by semantic drift or a self-reported command", () => {
 const result = runtime({
  requirements: [{ id: "A1", tag: "test", text: "Compare by UTC calendar day", source: "PLAN.md:UTC", reference: "user requirement", criticalConditions: ["UTC calendar day, not current instant"], status: "proven", evidenceTaskId: "task-1", evidenceRevision: "rev-after", evidenceRefs: ["self:npm test"] }],
  checks: [{ producer: "specialist", command: ["npm", "test"], exitCode: 0, inspectedRevision: "rev-after", evidenceRef: "self:npm test", requirementIds: ["A1"] }],
 });
 assert.equal(result.verification.requirements[0].status, "unsupported"); assert.equal(result.verification.requirements[0].taskId, "task-1"); assert.equal(result.verification.requirements[0].revision, "rev-after"); assert.equal(result.acceptance.accepted, false);
 assert.match(result.verification.requirements[0].criticalConditions[0], /UTC calendar day/);
});

test("evidence from a prior task or revision is stale and cannot accept current changes", () => {
 for (const requirement of [
  { ...minimalChangeRequirement(), status: "proven", evidenceTaskId: "task-old", evidenceRevision: "rev-after" },
  { ...minimalChangeRequirement(), status: "proven", evidenceTaskId: "task-1", evidenceRevision: "rev-old" },
 ]) {
  const result = runtime({ requirements: [requirement] });
  assert.equal(result.verification.status, "stale"); assert.equal(result.acceptance.accepted, false);
 }
});

test("changed and verification_failed coexist with command, exit, revision, and evidence", () => {
 const result = runtime({ checks: [{ producer: "runtime", taskId: "task-1", command: ["node", "--test"], exitCode: 1, inspectedRevision: "rev-after", evidenceRef: "/e/check.json", requirementIds: ["AF-MIN-CHANGE"] }] });
 assert.equal(result.changes.status, "changed"); assert.equal(result.verification.status, "failed");
 assert.equal(result.verification.checks[0].exitCode, 1); assert.equal(result.verification.checks[0].inspectedRevision, "rev-after");
 assert.equal(result.acceptance.accepted, false);
});

test("a current runtime-owned passing check can accept the minimal changed-task contract", () => {
 const result = runtime({ checks: [{ producer: "runtime", taskId: "task-1", command: ["node", "node_modules/typescript/bin/tsc", "-p", "tsconfig.json", "--noEmit"], exitCode: 0, inspectedRevision: "rev-after", evidenceRef: "/e/compiler.json", requirementIds: ["AF-MIN-CHANGE"] }] });
 assert.equal(result.verification.status, "passed"); assert.equal(result.acceptance.accepted, true);
 assert.equal(result.compatibility.flowStatus, "accepted"); assert.deepEqual(result.verification.evidenceRefs, ["/e/compiler.json"]);
});

test("concurrent attribution uncertainty and execution failure fail closed", () => {
 const uncertain = runtime({ changes: { status: "changed", paths: ["src/a.ts"], attribution: "uncertain" }, checks: [{ producer: "runtime", taskId: "task-1", command: ["node", "--test"], exitCode: 0, inspectedRevision: "rev-after", evidenceRef: "/e/test", requirementIds: ["AF-MIN-CHANGE"] }] });
 assert.equal(uncertain.verification.status, "unsupported"); assert.equal(uncertain.acceptance.accepted, false);
 const failed = runtime({ execution: { status: "failed", exitCode: 1, dispatchId: "run-1" }, changes: { status: "unknown", paths: [], attribution: "not_observed" } });
 assert.equal(failed.execution.status, "failed"); assert.equal(failed.verification.status, "unsupported");
 assert.equal(failed.compatibility.hubAcceptanceStatus, "not_available");
});

test("legacy Hub and flow status mappings preserve meaning", () => {
 assert.deepEqual(mapCompatibilityStatus({ execution: "failed", verification: "unsupported", accepted: false, deliverableFailed: false }), { hubAcceptanceStatus: "not_available", flowStatus: "rejected" });
 assert.deepEqual(mapCompatibilityStatus({ execution: "completed", verification: "failed", accepted: false, deliverableFailed: true }), { hubAcceptanceStatus: "deliverable_failed", flowStatus: "rejected" });
 assert.deepEqual(mapCompatibilityStatus({ execution: "completed", verification: "missing", accepted: false, deliverableFailed: false }), { hubAcceptanceStatus: "needs_verification", flowStatus: "rejected" });
 assert.deepEqual(mapCompatibilityStatus({ execution: "completed", verification: "passed", accepted: true, deliverableFailed: false }), { hubAcceptanceStatus: "accepted", flowStatus: "accepted" });
});

test("untrusted ledger claims never become runtime evidence references", () => {
 const result = runtime({ requirements: [{ id: "A1", tag: "test", text: "semantic", source: "request", evidenceRefs: ["I ran tests, all green"], status: "proven" }] });
 assert.equal(result.verification.evidenceRefs.includes("I ran tests, all green"), false);
 assert.deepEqual(result.verification.requirements[0].claimedEvidenceRefs, ["I ran tests, all green"]);
});

test("explicit semantic test coverage accepts only the exact task, source, requirement and command", () => {
 const requirement = { id: "A1", tag: "test", text: "UTC calendar day", source: "request", criticalConditions: ["UTC, not local time"], testCommand: "node --test utc.test.js" };
 const check = { producer: "runtime", kind: "test", taskId: "task-1", command: [requirement.testCommand], exitCode: 0, inspectedRevision: "rev-after", evidenceRef: "/e/runtime-test", requirementIds: ["A1"], coverage: [{ id: requirement.id, source: requirement.source, text: requirement.text, criticalConditions: requirement.criticalConditions }] };
 const evaluate = (checks: any[]) => runtime({ requirements: [requirement], checks });
 assert.equal(evaluate([check]).acceptance.accepted, true);
 for (const changed of [{ taskId: "old-task" }, { kind: "compilation" }, { command: ["echo all green"] }, { producer: "specialist" }, { coverage: [{ ...check.coverage[0], source: "other" }] }, { inspectedRevision: "old" }, { exitCode: 1 }]) assert.equal(evaluate([{ ...check, ...changed }]).acceptance.accepted, false);
});

test("current bound runtime check supersedes old ledger stamps; code-grep is checkable, manual and UI remain unsupported", () => {
 for (const tag of ["test", "code-grep", "manual", "runtime-ui"]) {
  const requirement = { id: "A1", tag, text: "declared condition", source: "user", testCommand: "node check.js", status: "proven", evidenceTaskId: "old-task", evidenceRevision: "old-revision" };
  const check = { producer: "runtime", kind: tag, taskId: "task-1", command: [requirement.testCommand], exitCode: 0, inspectedRevision: "rev-after", evidenceRef: "/e/check", requirementIds: ["A1"], coverage: [{ id: "A1", text: requirement.text, source: requirement.source, criticalConditions: [] }] };
  const result = runtime({ requirements: [requirement], checks: [check] });
  assert.equal(result.verification.requirements[0].status, ["test", "code-grep"].includes(tag) ? "passed" : "unsupported");
  assert.equal(result.acceptance.accepted, ["test", "code-grep"].includes(tag));
 }
 for (const tag of ["manual", "runtime-ui", "code-grep"]) {
  const result = runtime({ requirements: [{ id: "A2", tag, text: "condition", source: "user" }] });
  assert.equal(result.verification.status, tag === "code-grep" ? "missing" : "unsupported");
  assert.equal(result.acceptance.accepted, false);
 }
});

test("T11 risk obligations are independent of budget tier and ratchet until a genuine new task", () => {
 let state = createProcessState();
 for (const mode of ["operator", "orchestrator"] as const) for (const tier of ["trivial", "small", "feature", "project"]) {
  const unknown = evaluateProcessObligations(state, { writable: true, budgetTier: tier, workMode: mode });
  assert.equal(unknown.accepted, false); assert.equal(unknown.obligations.risk.status, "open");
 }
 const high = applyProcessClassification(state, { risk: "high", scope: "small", reason: "touches authorization" });
 assert.equal(high.ok, true); state = high.state;
 for (const tier of ["trivial", "project"]) {
  const verdict = evaluateProcessObligations(state, { writable: true, budgetTier: tier, t2Accepted: true });
  assert.equal(verdict.accepted, false); assert.equal(verdict.obligations.review.status, "open");
 }
 const lowered = applyProcessClassification(state, { risk: "low", reason: "risk reassessed after containment" });
 assert.equal(lowered.ok, true); state = lowered.state;
 assert.equal(evaluateProcessObligations(state, { writable: true, budgetTier: "trivial", t2Accepted: true }).obligations.review.status, "open", "low does not erase an open high-risk review");
 state = noteProcessStage(state, "review", { evidenceRef: "review:run-1", revision: "rev-1" });
 assert.equal(evaluateProcessObligations(state, { writable: true, budgetTier: "trivial", t2Accepted: true }).accepted, true);
 const reset = applyProcessClassification(state, { newTask: true, risk: "low", scope: "small", reason: "genuine new task" });
 assert.equal(reset.ok, true); assert.equal(reset.state.review.required, false); assert.equal(reset.state.review.evidenceRef, null);
});

test("T11 scope expansion requires an explicit reason and risk reassessment; wide work keeps plan and review", () => {
 let state = applyProcessClassification(createProcessState(), { risk: "low", scope: "small", reason: "contained reversible change" }).state;
 const missing = applyProcessClassification(state, { scope: "wide", reason: "dependencies expanded" });
 assert.equal(missing.ok, false); assert.match(missing.message, /risk reassessment/i);
 const expanded = applyProcessClassification(state, { scope: "wide", risk: "high", reason: "new cross-package dependency" });
 assert.equal(expanded.ok, true); state = expanded.state;
 const verdict = evaluateProcessObligations(state, { writable: true, budgetTier: "small", t2Accepted: true });
 assert.equal(verdict.obligations.plan.status, "open"); assert.equal(verdict.obligations.review.status, "open");
 assert.match(verdict.explanation, /budget tier small/i); assert.match(verdict.explanation, /risk high/i);
 state = noteProcessStage(noteProcessStage(state, "plan", { evidenceRef: "plan:run-1", revision: "rev-1" }), "review", { evidenceRef: "review:run-2", revision: "rev-1" });
 assert.equal(evaluateProcessObligations(state, { writable: true, budgetTier: "small", t2Accepted: true }).accepted, true);
});

test("T11 process state round-trips through session entries for resume and compaction", () => {
 let state = applyProcessClassification(createProcessState(), { risk: "high", scope: "wide", reason: "cross-boundary change" }).state;
 state = noteProcessStage(state, "plan", { evidenceRef: "plan:1", revision: "rev-1" });
 const verdict = evaluateProcessObligations(state, { writable: true, budgetTier: "trivial", currentRevision: "rev-1" });
 const entry = { type: "custom", customType: "agent-hub-process-state", data: processAuditRecord(state, verdict) };
 assert.deepEqual(latestProcessState([{ type: "compaction", id: "snap-1" }, entry]), state);
 assert.deepEqual(latestProcessState([{ type: "compaction", id: "snap-2" }, entry]), state, "compaction identity does not reset same-task obligations");
});

test("T11 read-only work stays lightweight while unknown writable work cannot be accepted", () => {
 const state = createProcessState();
 const readOnly = evaluateProcessObligations(state, { writable: false, budgetTier: "small" });
 assert.equal(readOnly.accepted, false); assert.equal(readOnly.path, "read-only"); assert.equal(readOnly.obligations.acceptance.status, "unsupported");
 const writable = evaluateProcessObligations(state, { writable: true, budgetTier: "small", t2Accepted: true });
 assert.equal(writable.accepted, false); assert.equal(writable.obligations.risk.status, "open");
});

test("T11 open plan refuses operator writes and dependent children before effect", () => {
 const wide = applyProcessClassification(createProcessState(), { risk: "high", scope: "wide", reason: "cross-package change" }).state;
 assert.equal(processPreEffectGate(wide, "write")?.reason, "process_plan_open");
 assert.equal(processPreEffectGate(wide, "child", "builder")?.reason, "process_plan_open");
 assert.equal(processPreEffectGate(wide, "child", "planner"), null);
});

test("dispatcher prompt makes declared checks and unsupported requirement limits discoverable", async () => {
 const { verificationFragment } = await import("./prompts/fragments.ts");
 const prompt = verificationFragment(12);
 for (const phrase of ["test_command", "critical_conditions", "expected_result", "code-grep", "manual", "runtime-ui", "separate code review", "NOT semantic test adequacy"]) assert.ok(prompt.includes(phrase), phrase);
});
