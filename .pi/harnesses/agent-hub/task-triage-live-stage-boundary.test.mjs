// Offline only: never import or execute the user-run live harness.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createStageBoundary, STAGE_ASSIGNMENT } from "./task-triage-live-stage-boundary.mjs";

const source = readFileSync(new URL("./task-triage-live-stage-closure.user-run.mjs", import.meta.url), "utf8");
function fixture() {
  let stage = "plan", aborts = 0;
  const attempts = [];
  const planPath = "/fixture/.pi/agent-sessions/sessions/one/artifacts/plans/synthetic-readme-fix.md";
  const gate = createStageBoundary({ stage: () => stage, planDeliverable: () => planPath, record: entry => attempts.push(entry) });
  // `who` is a stage name ("plan" | "build" | "review") for that stage's exact role
  // assignment, or a raw { agent, practices } input.
  const input = who => typeof who === "string" ? { agent: STAGE_ASSIGNMENT[who].agent, practices: [...STAGE_ASSIGNMENT[who].practices] } : who;
  const call = (who, id, deliverables = [planPath]) => gate({ toolName: "dispatch_agent", toolCallId: id, input: { ...input(who), deliverables } }, { abort() { aborts++; } });
  return { call, attempts, planPath, set: value => { stage = value; }, aborts: () => aborts };
}

test("actual tool_call stage map permits exactly one child per stage and denies stale/wrong roles", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(STAGE_ASSIGNMENT)), {
    plan: { agent: "editor", practices: ["planning"] },
    build: { agent: "editor", practices: ["implementation"] },
    review: { agent: "reviewer", practices: ["independent-review"] },
  });
  const f = fixture();
  assert.equal(f.call("review", "early")?.block, true);
  assert.equal(f.call("plan", "plan"), undefined);
  f.set("build");
  assert.equal(f.call("plan", "stale")?.block, true);
  assert.equal(f.call("build", "build"), undefined);
  assert.equal(f.call("review", "premature")?.block, true);
  assert.equal(f.call("build", "duplicate")?.block, true);
  assert.ok(f.aborts() >= 1);
  f.set("review");
  assert.equal(f.call("review", "review"), undefined);
  assert.equal(f.call("review", "extra")?.block, true);
  assert.deepEqual(f.attempts.filter(a => a.decision === "allowed").map(a => [a.stage, a.role, a.practices, a.toolCallId]),
    [["plan", "editor", ["planning"], "plan"], ["build", "editor", ["implementation"], "build"], ["review", "reviewer", ["independent-review"], "review"]]);
});

test("a stage admits only its exact practices; retired persona names and missing practices are denied", () => {
  for (const [stage, input] of [
    ["plan", { agent: "planner", practices: ["planning"] }],
    ["plan", { agent: "editor" }],
    ["plan", { agent: "editor", practices: ["implementation"] }],
    ["plan", { agent: "editor", practices: ["planning", "implementation"] }],
    ["build", { agent: "builder", practices: ["implementation"] }],
    ["build", { agent: "editor", practices: ["planning"] }],
    ["review", { agent: "code-reviewer", practices: ["independent-review"] }],
    ["review", { agent: "reviewer", practices: [] }],
  ]) {
    let current = "plan";
    const attempts = [];
    const planPath = "/fixture/plan.md";
    const gate = createStageBoundary({ stage: () => current, planDeliverable: () => planPath, record: entry => attempts.push(entry) });
    const dispatch = (value, id) => gate({ toolName: "dispatch_agent", toolCallId: id, input: { ...value, deliverables: [planPath] } }, { abort() {} });
    // Walk the harness to the stage under test with the exact assignments.
    for (const step of ["plan", "build", "review"]) {
      if (step === stage) break;
      current = step;
      assert.equal(dispatch({ agent: STAGE_ASSIGNMENT[step].agent, practices: [...STAGE_ASSIGNMENT[step].practices] }, `ok-${step}`), undefined);
    }
    current = stage;
    const refused = dispatch(input, "wrong");
    assert.equal(refused?.block, true, `${stage}: ${JSON.stringify(input)}`);
    assert.match(refused.reason, new RegExp(`expected ${STAGE_ASSIGNMENT[stage].agent} with practices`));
    assert.equal(attempts.at(-1).decision, "denied");
  }
});

test("invalid transitions and unreadable authorization fail closed before any child starts", () => {
  const f = fixture();
  f.set("review");
  assert.equal(f.call("review", "skip")?.block, true);
  f.set("plan");
  assert.equal(f.call("plan", "ok"), undefined);
  f.set("review");
  assert.equal(f.call("review", "skip-build")?.block, true);
  assert.equal(f.attempts.filter(a => a.decision === "allowed").length, 1);
  const missing = createStageBoundary({ stage: () => { throw Error("missing"); }, planDeliverable: () => "/fixture/plan.md", record() {} });
  assert.equal(missing({ toolName: "dispatch_agent", input: { agent: "editor", practices: ["planning"] }, toolCallId: "x" }, { abort() {} })?.block, true);
});

test("plan dispatch refuses absent, wrong, relative and surplus deliverables before child launch", () => {
  for (const deliverables of [undefined, [], ["/fixture/other.md"], ["artifacts/plans/synthetic-readme-fix.md"],
    ["/fixture/.pi/agent-sessions/sessions/one/artifacts/plans/synthetic-readme-fix.md", "/fixture/other.md"]]) {
    const f = fixture();
    // Pass a malformed raw input rather than the helper's default deliverables.
    const gate = createStageBoundary({ stage: () => "plan", planDeliverable: () => f.planPath, record: entry => f.attempts.push(entry) });
    assert.equal(gate({ toolName: "dispatch_agent", toolCallId: "bad", input: { agent: "editor", practices: ["planning"], deliverables } }, { abort() {} })?.block, true);
    assert.equal(f.attempts.at(-1).decision, "denied");
  }
  const f = fixture();
  assert.equal(f.call("plan", "valid", [f.planPath]), undefined);
  assert.equal(f.attempts.at(-1).decision, "allowed");
  const absentAuthorization = createStageBoundary({ stage: () => "plan", planDeliverable: () => { throw Error("missing"); }, record() {} });
  assert.equal(absentAuthorization({ toolName: "dispatch_agent", toolCallId: "x", input: { agent: "editor", practices: ["planning"], deliverables: [f.planPath] } }, { abort() {} })?.block, true);
});

test("fixture hook loads the real gate; only harness advances stage after evidence gates", () => {
  assert.match(source, /cpSync\(join\(root, "\.pi\/harnesses\/agent-hub\/task-triage-live-stage-boundary\.mjs"\), join\(worktree, "stage-boundary\.mjs"\)\)/);
  assert.match(source, /import \{ createStageBoundary \} from "\.\/stage-boundary\.mjs"/);
  assert.match(source, /pi\.on\("tool_call", \(event: any, ctx: any\) => gate\(event, ctx\)\)/);
  assert.match(source, /T4_LIVE_STAGE: stagePath, T4_LIVE_PLAN: planPath, T4_LIVE_DISPATCHES: dispatchLog/);
  assert.match(source, /renameSync\(next, stagePath\)/);
  assert.ok(source.indexOf('throw new Error("planning editor changed README') > 0);
  assert.ok(source.indexOf('throw new Error("planning editor changed README') < source.indexOf('authorize("build")'));
  assert.ok(source.indexOf('throw new Error("implementation editor runtime acceptance/check/revision/readback incomplete') > 0);
  assert.ok(source.indexOf('throw new Error("implementation editor runtime acceptance/check/revision/readback incomplete') < source.indexOf('authorize("review")'));
  assert.ok(source.indexOf('const reviewInputs = [') < source.indexOf('authorize("review")'));
  assert.match(source, /dispatches\.length !== outcome\.stages\.length \+ 1/);
  assert.match(source, /const observed = dispatches\.map\(id =>/);
});
