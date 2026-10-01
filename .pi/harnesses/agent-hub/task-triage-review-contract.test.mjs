// Offline only: exercise the production structured-return parser against the live harness contract.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { reviewGateSource } from "./task-triage-reviewer-only-contract.mjs";
import { parseStructuredReturn } from "./return-contract.js";
import { reviewClosureUnmet, reviewReturnTemplate } from "./task-triage-review-contract.mjs";

const input = {
  planReturnPath: "/tmp/fixture/artifacts/returns/planner.md",
  before: "/tmp/fixture/evidence/BEFORE, original.md",
  after: "/tmp/fixture/evidence/AFTER.md",
  afterDiff: "/tmp/fixture/evidence/diff.patch",
  acceptancePath: "/tmp/fixture/artifacts/evidence/builder-acceptance.md",
  checkPath: "/tmp/fixture/artifacts/evidence/builder-test-check.md",
  check: 'node -e \'const text="widget";\nif (!text) process.exit(1)\'',
  exitCode: 0,
  inspectedRevision: "inspected-revision-abc123",
};
const requiredPaths = [input.planReturnPath, input.before, input.after, input.afterDiff, input.acceptancePath, input.checkPath];
const process = { accepted: true, obligations: { review: { status: "satisfied" } } };
const verdict = "VERDICT: APPROVE";
const gaps = (text, overrides = {}) => reviewClosureUnmet({ process, verdict, parsed: parseStructuredReturn(text),
  requiredPaths, check: input.check, exitCode: input.exitCode, inspectedRevision: input.inspectedRevision, ...overrides });

test("generated reviewer gate admits tier preparation without abort, but only one exact review dispatch", () => {
  const sandbox = { registerGate: null };
  runInNewContext(reviewGateSource.replace("export default function", "globalThis.registerGate = function"), sandbox);
  let hook;
  sandbox.registerGate({ on: (name, handler) => { assert.equal(name, "tool_call"); hook = handler; } });
  const call = (toolName, input) => {
    let aborts = 0;
    const result = hook({ toolName, input }, { abort: () => { aborts++; } });
    return { aborts, blocked: result?.block === true };
  };
  assert.deepEqual(call("set_task_tier", { tier: "small", risk: "low", scope: "read-only", reason: "independent review" }), { aborts: 0, blocked: false });
  assert.deepEqual(call("set_task_tier", { tier: "small", risk: "low", scope: "small", reason: "existing README review" }), { aborts: 0, blocked: false });
  for (const input of [
    { tier: "small", scope: "read-only", new_task: true, reason: "reset" },
    { tier: "project", scope: "read-only" },
    { tier: "small", scope: "wide" },
  ]) assert.deepEqual(call("set_task_tier", input), { aborts: 1, blocked: true });
  assert.deepEqual(call("set_assertions", { assertions: [{ id: "A1", tag: "manual", text: "review", source: "fixture" }] }), { aborts: 0, blocked: false });
  for (const tool of ["spawn_research", "ask_user", "write", "bash"])
    assert.deepEqual(call(tool, {}), { aborts: 1, blocked: true });
  const reviewer = { agent: "code-reviewer", backend: "native", scope: ["README-SYNTH.md"] };
  for (const input of [{ ...reviewer, backend: "coms" }, { ...reviewer, agent: "builder" }, { ...reviewer, scope: ["other.md"] },
    { ...reviewer, artifacts: ["/tmp/synthetic-review-note.md"] }])
    assert.deepEqual(call("dispatch_agent", input), { aborts: 1, blocked: true });
  assert.deepEqual(call("dispatch_agent", { ...reviewer, artifacts: [] }), { aborts: 0, blocked: false });
  assert.deepEqual(call("dispatch_agent", reviewer), { aborts: 1, blocked: true });
  assert.deepEqual(call("set_task_tier", { tier: "small", scope: "read-only" }), { aborts: 1, blocked: true });
  assert.deepEqual(call("set_assertions", { assertions: [] }), { aborts: 1, blocked: true });
});

test("review template is one-line A1 evidence parseable by production parser with exact serialized command and six paths", () => {
  const text = reviewReturnTemplate(input).replace("VERDICT: APPROVE | VERDICT: REJECT (choose exactly one, as the first standalone line)", verdict)
    .replace("<reviewer's own observation>", "observed exact one-token change and adequate plan");
  const parsed = parseStructuredReturn(text);
  assert.equal(parsed.assertions_proven.length, 1);
  assert.equal(parsed.assertions_proven[0].id, "A1");
  assert.ok(parsed.assertions_proven[0].evidence);
  assert.deepEqual(gaps(text), []);
  assert.deepEqual(gaps(text.replace("exit code 0", "exit status 0")), ["parsed A1 evidence missing exit code"]);
  assert.equal(text.split("\n").filter(line => line.startsWith("- A1:")).length, 1);
});

test("source-only note and tests_run cannot stand in for parsed A1 evidence", () => {
  const text = `${verdict}\nassertions_proven: [A1 — exact SHA-256 f81b90f3, matching expected bytes; source: after README and builder runtime evidence]\nassertions_unproven: []\nassertions_failed: []\ntests_run: [${input.check} → exit 0; inspected revision ${input.inspectedRevision}; evidence: builder check]`;
  assert.equal(parseStructuredReturn(text).assertions_proven[0].evidence, null);
  assert.deepEqual(gaps(text), [
    "parsed A1 assertions_proven evidence field missing",
    `parsed A1 evidence missing references: ${requiredPaths.join(", ")}`,
    "parsed A1 evidence missing exact declared command",
    "parsed A1 evidence missing exit code",
    "parsed A1 evidence missing inspected revision",
  ]);
});

test("missing references and runtime fields remain unmet even when verdict and process are accepted", () => {
  const text = `${verdict}\nassertions_proven:\n- A1: checked — evidence: plan return ${JSON.stringify(input.planReturnPath)}; BEFORE bytes ${JSON.stringify(input.before)}; exit code 0\nassertions_unproven: []\nassertions_failed: []`;
  assert.deepEqual(gaps(text), [
    `parsed A1 evidence missing references: ${requiredPaths.slice(2).join(", ")}`,
    "parsed A1 evidence missing exact declared command",
    "parsed A1 evidence missing inspected revision",
  ]);
  assert.deepEqual(gaps(text, { verdict: "VERDICT: REJECT", process: { accepted: false, obligations: { review: { status: "open" } } } }).slice(0, 3), [
    "review obligation not satisfied", "process closure not accepted", "canonical first-line verdict is not APPROVE",
  ]);
});
