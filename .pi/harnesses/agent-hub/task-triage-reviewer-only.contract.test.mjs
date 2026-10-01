// Offline contract only; NEVER import/execute the user-run live entry point.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reviewFixture, independentReviewUnmet, reviewGateSource } from "./task-triage-reviewer-only-contract.mjs";
import { reviewReturnTemplate } from "./task-triage-review-contract.mjs";
import { BENIGN_UI_METHODS, createReviewDiagnostics } from "./task-triage-reviewer-only-diagnostics.mjs";
import { parseStructuredReturn } from "./return-contract.js";
const sha = text => createHash("sha256").update(text).digest("hex");
const source = readFileSync(new URL("./task-triage-reviewer-only.user-run.mjs", import.meta.url), "utf8");
function fixture() {
  const from = mkdtempSync(join(tmpdir(), "t4-live-stage-closure-test-"));
  const put = (path, text) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, typeof text === "string" ? text : JSON.stringify(text)); return path; };
  const at = path => join(from, path);
  const base = at("worktree/.pi/agent-sessions/sessions/session-1"), readme = at("worktree/README-SYNTH.md");
  const before = "# Synthetic Widget\nThe wdiget renders a greeting.\n", after = before.replace("wdiget renders", "widget renders");
  const keys = ["README-SYNTH.md", "probe-hooks.ts", "stage-boundary.mjs", "skills/orchestration-verification/SKILL.md", ".pi/agents/teams.yaml", ".pi/agents/personas/planner.md", ".pi/agents/personas/builder.md", ".pi/agents/personas/code-reviewer.md"];
  const originals = Object.fromEntries(keys.map(key => [key, key === "README-SYNTH.md" ? before : `synthetic ${key}\n`]));
  for (const key of keys) put(at(`worktree/${key}`), key === "README-SYNTH.md" ? after : originals[key]);
  const baseline = { manifest: put(at("evidence/baseline-fixture-sha256.json"), Object.fromEntries(keys.map(key => [key, sha(originals[key])]))),
    filesPath: put(at("evidence/baseline-fixture-bytes.json"), originals), bytes: put(at("evidence/README-before.md"), before),
    diff: put(at("evidence/README-before.git-diff.patch"), "baseline"), statusPath: put(at("evidence/baseline-git-status.txt"), "") };
  const afterPath = put(at("evidence/README-after.md"), after);
  const diff = put(at("evidence/README-before-after.git-diff.patch"), "-The wdiget renders a greeting.\n+The widget renders a greeting.\n");
  const status = " M README-SYNTH.md";
  const afterStatus = put(at("evidence/after-git-status.txt"), status);
  const reviewStatus = put(at("evidence/after-review-git-status.txt"), status);
  const stage = (role, name, id) => {
    const resultPath = join(base, "dispatches", id, "result.json");
    const acceptancePath = join(base, "artifacts/evidence", `${role}-acceptance-${id}.md`);
    const returnPath = join(base, "artifacts/returns", `${role}-${id}.md`);
    put(returnPath, `${role} return`);
    put(acceptancePath, role === "builder" ? "{}" : "{}");
    put(resultPath, { evidencePath: resultPath, exitCode: 0 });
    return { stage: name, role, id, resultPath, acceptancePath, returnPath,
      modelEvidence: { fallback: null, status: "observed", identities: [{ provider: "openai-codex", model: "gpt-6-luna" }] } };
  };
  const plan = stage("planner", "plan", "11111111-1111-1111-1111-111111111111");
  const build = stage("builder", "build", "22222222-2222-2222-2222-222222222222");
  const review = stage("code-reviewer", "review", "33333333-3333-3333-3333-333333333333");
  review.process = { accepted: true, currentStage: "complete", obligations: { review: { status: "satisfied" } } };
  put(review.resultPath, { output: "VERDICT: APPROVE\nassertions_proven: [A1 — evidence: abbreviated]", exitCode: 0 });
  put(join(base, "artifacts/plans/synthetic-readme-fix.md"), "plan");
  const retainedPath = put(join(base, "dispatches", build.id, "deliverables/0"), after);
  const taskId = "task-1", revision = "rev-1", command = "node -e 'declared check only'";
  const checkPath = put(join(base, "artifacts/evidence/builder-test-check-44444444-4444-4444-4444-444444444444.md"), {
    declaration: { taskId, dispatchId: build.id }, observation: { command, exitCode: 0, afterRevision: revision } });
  put(review.acceptancePath, { task: { id: taskId, revision: { after: revision } }, process: { accepted: true },
    structuredReturn: { assertions_proven: [{ id: "A1", evidence: "abbreviated" }] } });
  put(build.acceptancePath, { task: { id: taskId, revision: { after: revision } }, execution: { dispatchId: build.id },
    readback: [{ path: readme, status: "read", changed: true, sha256: sha(after), bytes: Buffer.byteLength(after), retainedPath }],
    scopeRoots: [{ scope: "README-SYNTH.md", exists: true }],
    process: { obligations: { acceptance: { status: "satisfied" } } }, verification: {
      requirements: ["A1", "AF-MIN-CHANGE"].map(id => ({ id, status: "passed", taskId, revision })),
      checks: [{ taskId, inspectedRevision: revision, exitCode: 0, command: [command], evidenceRef: checkPath }] } });
  const resultPath = at("result.json");
  const result = { fixture: from, worktree: at("worktree"), model: "openai-codex/gpt-6-luna", declaredCheck: command,
    error: "review closure unmet: parsed A1 evidence missing references: fixture; parsed A1 evidence missing exact declared command; parsed A1 evidence missing exit code; parsed A1 evidence missing inspected revision",
    stages: [plan, build, review], baseline, after: { path: afterPath, diffPath: diff, statusPath: afterStatus, gitStatus: status,
      exactExpectedBytes: true, unchangedFixture: true, nonRuntimeStatus: status }, afterReview: { statusPath: reviewStatus, gitStatus: status,
      nonRuntimeStatus: status, unchangedFixture: true } };
  put(resultPath, result);
  return { from, at, put, result, plan, build, review, checkPath, cleanup: () => rmSync(from, { recursive: true, force: true }) };
}

test("recorded baseline and first-time snapshot detect changed or missing evidence", () => {
  const f = fixture();
  try {
    const valid = reviewFixture(f.from);
    assert.equal(valid.recordedBaseline["README-SYNTH.md"], sha("# Synthetic Widget\nThe wdiget renders a greeting.\n"));
    assert.ok(valid.snapshot[f.plan.returnPath]);
    valid.verify();
    f.put(f.plan.returnPath, "mutated plan");
    assert.throws(() => valid.verify(), /changed since first-time snapshot/);
    assert.throws(() => reviewFixture(f.from.replace("t4-live-stage-closure", "not-a-fixture")), /fixture|ENOENT/);
    rmSync(f.checkPath);
    assert.throws(() => reviewFixture(f.from), /ENOENT|missing/);
  } finally { f.cleanup(); }
});

test("wrong task/revision, wrong README, or missing original process refuses pre-spend", () => {
  for (const mutate of [
    f => { const a = JSON.parse(readFileSync(f.build.acceptancePath)); a.verification.checks[0].inspectedRevision = "wrong"; f.put(f.build.acceptancePath, a); },
    f => f.put(f.at("worktree/README-SYNTH.md"), "wrong README"),
    f => { f.result.stages[2].process.accepted = false; f.put(f.at("result.json"), f.result); },
  ]) {
    const f = fixture();
    try { mutate(f); assert.throws(() => reviewFixture(f.from)); } finally { f.cleanup(); }
  }
});

test("recorded status permits only the exact owning session's artifacts, not foreign paths", () => {
  const f = fixture();
  try {
    const owned = `?? .pi/agent-sessions/sessions/session-1/artifacts/evidence/record.md`;
    const after = `${" M README-SYNTH.md"}\n${owned}`;
    f.result.after.gitStatus = after;
    f.result.afterReview.gitStatus = after;
    f.put(f.result.after.statusPath, after);
    f.put(f.result.afterReview.statusPath, after);
    f.put(f.at("result.json"), f.result);
    reviewFixture(f.from);
    for (const alien of ["?? unrelated.txt", "?? .pi/agent-sessions/sessions/foreign/artifacts/record.md"]) {
      const bad = `${after}\n${alien}`;
      f.result.after.gitStatus = bad;
      f.put(f.result.after.statusPath, bad);
      f.put(f.at("result.json"), f.result);
      assert.throws(() => reviewFixture(f.from), /unrelated source or session changes/);
    }
  } finally { f.cleanup(); }
});

test("canonical verdict and parsed A1 evidence reject omissions, accept independent valid report", () => {
  const f = fixture();
  try {
    const input = reviewFixture(f.from);
    const template = reviewReturnTemplate({ planReturnPath: input.plan.returnPath, before: input.before, after: input.after,
      afterDiff: input.afterDiff, acceptancePath: input.acceptancePath, checkPath: input.checkPath,
      check: input.check, exitCode: input.exitCode, inspectedRevision: input.inspectedRevision });
    const good = template.replace("VERDICT: APPROVE | VERDICT: REJECT (choose exactly one, as the first standalone line)", "VERDICT: APPROVE")
      .replace("<reviewer's own observation>", "observed the exact one-token change and adequate plan");
    assert.deepEqual(independentReviewUnmet(input, good, parseStructuredReturn(good)), []);
    assert.match(independentReviewUnmet(input, good.replace("exit code 0", "exit unknown"), parseStructuredReturn(good.replace("exit code 0", "exit unknown"))).join(";"), /missing exit code/);
    assert.match(independentReviewUnmet(input, good.replace(JSON.stringify(input.before), '"omitted"'), parseStructuredReturn(good.replace(JSON.stringify(input.before), '"omitted"'))).join(";"), /missing references/);
    assert.match(independentReviewUnmet(input, good.replace("VERDICT: APPROVE", "VERDICT: REJECT"), parseStructuredReturn(good)).join(";"), /canonical first-line/);
  } finally { f.cleanup(); }
});

test("abbreviated APPROVE with evidence outside the parsed A1 field remains unaccepted", () => {
  const f = fixture();
  try {
    const input = reviewFixture(f.from);
    const quoted = input.requiredPaths.map(JSON.stringify).join("; ");
    const actualShape = `VERDICT: APPROVE\nassertions_proven: [A1 — exact typo and recorded check passed]\nassertions_unproven: []\nassertions_failed: []\n\n- A1 — evidence: ${quoted}; declared command ${JSON.stringify(input.check)}; exit code 0; inspected revision ${JSON.stringify(input.inspectedRevision)}`;
    const parsed = parseStructuredReturn(actualShape);
    assert.equal(parsed.assertions_proven[0].evidence, null);
    assert.match(independentReviewUnmet(input, actualShape, parsed).join("; "), /parsed A1 assertions_proven evidence field missing/);
  } finally { f.cleanup(); }
});

test("RPC UI schema distinguishes fire-and-forget notifications from human decisions", () => {
  for (const method of ["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"])
    assert.equal(BENIGN_UI_METHODS.has(method), true);
  for (const method of ["select", "confirm", "input", "editor", "unknown"])
    assert.equal(BENIGN_UI_METHODS.has(method), false);
  assert.match(source, /!BENIGN_UI_METHODS\.has\(ev\.method\)/);
  assert.doesNotMatch(source, /extension_ui_response|confirmed: true/);
});

test("diagnostics retain first failure over close/error and record kills before signalling", () => {
  const output = {}, snapshots = [];
  const d = createReviewDiagnostics(output, () => snapshots.push(JSON.parse(JSON.stringify(output))));
  d.rpc({ type: "extension_ui_request", method: "confirm", title: "Approve?", message: "private value" });
  d.kill("unexpected human decision", "SIGTERM", () => {
    assert.equal(snapshots.at(-1).diagnostics.firstFailure.reason, "unexpected human decision");
    assert.equal(snapshots.at(-1).diagnostics.kills[0].signal, "SIGTERM");
  });
  d.spawnError(Object.assign(new Error("second failure"), { code: "EPIPE" }));
  d.exit(143, null);
  assert.equal(output.diagnostics.firstFailure.reason, "unexpected human decision");
  assert.deepEqual(output.diagnostics.exit.code, 143);
  assert.equal(output.diagnostics.spawnError.code, "EPIPE");
  assert.equal(output.diagnostics.rpc[0].title, undefined);
  assert.doesNotMatch(JSON.stringify(output), /Approve\?|private value/);
  assert.match(source, /firstFailure\?\.reason \?\? "Pi exited before agent_end"/);
});

test("bounded stderr and RPC diagnostics redact secrets, persist no UI values", () => {
  const output = {}, snapshots = [];
  const d = createReviewDiagnostics(output, () => snapshots.push(JSON.stringify(output)));
  d.stderr("token=secret123 Bearer privateValue https://user:pass@example.test/secret\n".repeat(300));
  d.flushStderr();
  d.rpc({ type: "response", command: "prompt", success: false, error: "api_key=privateValue AWS_SECRET_ACCESS_KEY='synthetic private phrase'" });
  d.rpc({ type: "extension_ui_request", method: "notify", message: "privateValue", title: "privateValue" });
  assert.equal(output.diagnostics.stderrTruncated, true);
  assert.ok(output.diagnostics.stderr.length <= 8192);
  assert.doesNotMatch(snapshots.join("\n"), /secret123|privateValue|user:pass|synthetic private phrase/);
  assert.equal(output.diagnostics.rpc.at(-1).title, undefined);
  assert.equal(output.diagnostics.rpc.at(-1).method, "notify");
  for (let n = 0; n < 100; n++) d.rpc({ type: "agent_start" });
  assert.equal(output.diagnostics.rpc.length, 80);
});

test("offline tool refusal and parent identity survive zero-dispatch failure without secrets or args", () => {
  const output = {}, snapshots = [];
  const d = createReviewDiagnostics(output, () => snapshots.push(JSON.stringify(output)));
  d.rpc({ type: "message_end", message: { role: "assistant", provider: "openai-codex", model: "gpt-6-luna",
    content: [{ type: "text", text: "PRIVATE_ASSISTANT_TEXT" }] } });
  d.rpc({ type: "tool_execution_start", toolCallId: "call-1", toolName: "dispatch_agent",
    args: { api_key: "PRIVATE_ARG" } });
  d.rpc({ type: "message_end", message: { role: "toolResult", toolCallId: "call-1", toolName: "dispatch_agent",
    isError: true, status: "refused", content: [{ type: "text", text: "Reviewer dispatch denied: token=PRIVATE_RESULT Bearer PRIVATE_BEARER" }] } });
  d.failure("only one reviewer may start; observed 0 dispatches");
  const records = output.diagnostics.rpc;
  assert.deepEqual([records[0].provider, records[0].model], ["openai-codex", "gpt-6-luna"]);
  assert.equal(records[1].toolName, "dispatch_agent");
  assert.equal(records[2].toolCallId, "call-1");
  assert.equal(records[2].isError, true);
  assert.equal(records[2].status, "refused");
  assert.match(records[2].reason, /Reviewer dispatch denied: \[redacted-secret\]/);
  assert.ok(records[2].reason.length <= 240);
  assert.match(snapshots.at(-1), /observed 0 dispatches/);
  assert.doesNotMatch(snapshots.join("\n"), /PRIVATE_ASSISTANT_TEXT|PRIVATE_ARG|PRIVATE_RESULT|PRIVATE_BEARER/);
  assert.match(source, /"tool_execution_start", "tool_execution_end"/);
});

test("stderr redacts underscore-joined keys and split chunks before bounded retention", () => {
  const output = {}, snapshots = [];
  const d = createReviewDiagnostics(output, () => snapshots.push(JSON.stringify(output)));
  const longSecret = "SYNTHETIC_PRIVATE_VALUE_FOR_BOUNDARY";
  // Benign punctuation breaks up the filler so the long-value redactor does not shrink it.
  d.stderr("x.".repeat(4095) + `\nMY_API_KEY=${longSecret}\n`);
  d.stderr("github_access_to");
  d.stderr("ken=SYNTHETIC_CHUNK_VALUE\nAWS_SECRET_ACCESS_");
  d.stderr("KEY=SYNTHETIC_KEY_VALUE\nplain diagnostic\n");
  d.flushStderr();
  assert.equal(output.diagnostics.stderrTruncated, true);
  assert.match(output.diagnostics.stderr, /plain diagnostic/);
  assert.doesNotMatch(snapshots.join("\n"), /SYNTHETIC_PRIVATE_VALUE_FOR_BOUNDARY|SYNTHETIC_CHUNK_VALUE|SYNTHETIC_KEY_VALUE/);
  assert.ok(Buffer.byteLength(output.diagnostics.stderr) <= 8192);
});

test("stderr truncation never exposes the surviving suffix of a severed credential", () => {
  const output = {}, snapshots = [];
  const d = createReviewDiagnostics(output, () => snapshots.push(JSON.stringify(output)));
  const secret = "SYNTHETIC_BOUNDARY_SECRET_VALUE";
  d.stderr(`api_key=${secret}\n` + "y".repeat(8170) + "\n");
  d.flushStderr();
  // A raw last-8192 slice starts inside the credential value, after its key.
  assert.match(output.diagnostics.stderr, /\[redacted-secret\]/);
  assert.doesNotMatch(snapshots.join("\n"), /SYNTHETIC_BOUNDARY_SECRET_VALUE|OUNDARY_SECRET_VALUE/);
  assert.ok(Buffer.byteLength(output.diagnostics.stderr) <= 8192);
});

test("stderr omits oversized and unterminated lines instead of exposing partial secrets", () => {
  const output = {};
  const d = createReviewDiagnostics(output, () => {});
  d.stderr("api_key=" + "SYNTHETIC_OVERSIZED_SECRET".repeat(400));
  d.stderr("\npublic complete line\ncredential=SYNTHETIC_INCOMPLETE_SECRET");
  d.flushStderr();
  assert.equal(output.diagnostics.stderrTruncated, true);
  assert.equal(output.diagnostics.stderr, "public complete line\n");
  assert.doesNotMatch(JSON.stringify(output), /SYNTHETIC_OVERSIZED_SECRET|SYNTHETIC_INCOMPLETE_SECRET/);
});

test("original process completeness is sourced from validated original process record", () => {
  const f = fixture();
  try {
    const input = reviewFixture(f.from);
    assert.equal(input.review.process.currentStage, "complete");
    assert.match(source, /originalProcessComplete: fixture\.review\.process\.accepted === true/);
    assert.doesNotMatch(source, /originalProcessComplete: true/);
    f.result.stages[2].process.obligations.review.status = "open";
    f.put(f.at("result.json"), f.result);
    assert.throws(() => reviewFixture(f.from), /original process/);
  } finally { f.cleanup(); }
});

test("user-run entry is isolated reviewer-only, no npm integration or verification requests", () => {
  assert.match(source, /process\.argv\[2\] !== "--live" \|\| process\.argv\[3\] !== "--from"/);
  assert.match(source, /fixture\.verify\(\);\n    child = spawn/);
  assert.match(source, /writeFileSync\(join\(workspace, "review-gate\.ts"\), reviewGateSource\)/);
  assert.match(reviewGateSource, /input\?\.agent === "code-reviewer" && input\?\.backend === "native"/);
  assert.match(reviewGateSource, /JSON\.stringify\(input\?\.scope\) === '\["README-SYNTH\.md"\]'/);
  assert.match(reviewGateSource, /if \(allowed\) \{ used = true; return; \}/);
  assert.match(reviewGateSource, /input\.artifacts\.length === 0/);
  assert.match(source, /artifacts \[\] \(EMPTY: the cited files are read-only paths in the task/);
  assert.match(source, /tools: read,grep,find,ls/);
  assert.match(source, /models\.some\(m => `\$\{m\.provider\}\/\$\{m\.model\}` !== "openai-codex\/gpt-6-luna"\)/);
  assert.doesNotMatch(source, /m\.output > 0/);
  assert.match(source, /Do NOT execute or propose repeating the verification command/);
  assert.match(source, /DIRECTLY UNDER assertions_proven:/);
  assert.match(source, /Do not put A1 in bracket shorthand/);
  assert.match(source, /c2-reviewer-hash-adjudication\.md/);
  assert.match(source, /as a contested finding, not proof: independently read/);
  assert.match(source, /Do not reuse either prior verdict as authority/);
  assert.doesNotMatch(source, /spawn\("(npm|git|bash)"/);
});
