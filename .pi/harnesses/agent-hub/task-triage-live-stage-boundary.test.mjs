// Offline only: never import or execute the user-run live harness.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createStageBoundary, STAGE_ROLE } from "./task-triage-live-stage-boundary.mjs";

const source = readFileSync(new URL("./task-triage-live-stage-closure.user-run.mjs", import.meta.url), "utf8");
function fixture() {
  let stage = "plan", aborts = 0;
  const attempts = [];
  const planPath = "/fixture/.pi/agent-sessions/sessions/one/artifacts/plans/synthetic-readme-fix.md";
  const gate = createStageBoundary({ stage: () => stage, planDeliverable: () => planPath, record: entry => attempts.push(entry) });
  const call = (agent, id, deliverables = [planPath]) => gate({ toolName: "dispatch_agent", toolCallId: id, input: { agent, deliverables } }, { abort() { aborts++; } });
  return { call, attempts, planPath, set: value => { stage = value; }, aborts: () => aborts };
}

test("actual tool_call stage map permits exactly one child per stage and denies stale/wrong roles", () => {
  assert.deepEqual(STAGE_ROLE, { plan: "planner", build: "builder", review: "code-reviewer" });
  const f = fixture();
  assert.equal(f.call("code-reviewer", "early")?.block, true);
  assert.equal(f.call("planner", "plan"), undefined);
  f.set("build");
  assert.equal(f.call("planner", "stale")?.block, true);
  assert.equal(f.call("builder", "build"), undefined);
  assert.equal(f.call("code-reviewer", "premature")?.block, true);
  assert.equal(f.call("builder", "duplicate")?.block, true);
  assert.ok(f.aborts() >= 1);
  f.set("review");
  assert.equal(f.call("code-reviewer", "review"), undefined);
  assert.equal(f.call("code-reviewer", "extra")?.block, true);
  assert.deepEqual(f.attempts.filter(a => a.decision === "allowed").map(a => [a.stage, a.role, a.toolCallId]),
    [["plan", "planner", "plan"], ["build", "builder", "build"], ["review", "code-reviewer", "review"]]);
});

test("invalid transitions and unreadable authorization fail closed before any child starts", () => {
  const f = fixture();
  f.set("review");
  assert.equal(f.call("code-reviewer", "skip")?.block, true);
  f.set("plan");
  assert.equal(f.call("planner", "ok"), undefined);
  f.set("review");
  assert.equal(f.call("code-reviewer", "skip-build")?.block, true);
  assert.equal(f.attempts.filter(a => a.decision === "allowed").length, 1);
  const missing = createStageBoundary({ stage: () => { throw Error("missing"); }, planDeliverable: () => "/fixture/plan.md", record() {} });
  assert.equal(missing({ toolName: "dispatch_agent", input: { agent: "planner" }, toolCallId: "x" }, { abort() {} })?.block, true);
});

test("plan dispatch refuses absent, wrong, relative and surplus deliverables before child launch", () => {
  for (const deliverables of [undefined, [], ["/fixture/other.md"], ["artifacts/plans/synthetic-readme-fix.md"],
    ["/fixture/.pi/agent-sessions/sessions/one/artifacts/plans/synthetic-readme-fix.md", "/fixture/other.md"]]) {
    const f = fixture();
    // Pass a malformed raw input rather than the helper's default deliverables.
    const gate = createStageBoundary({ stage: () => "plan", planDeliverable: () => f.planPath, record: entry => f.attempts.push(entry) });
    assert.equal(gate({ toolName: "dispatch_agent", toolCallId: "bad", input: { agent: "planner", deliverables } }, { abort() {} })?.block, true);
    assert.equal(f.attempts.at(-1).decision, "denied");
  }
  const f = fixture();
  assert.equal(f.call("planner", "valid", [f.planPath]), undefined);
  assert.equal(f.attempts.at(-1).decision, "allowed");
  const absentAuthorization = createStageBoundary({ stage: () => "plan", planDeliverable: () => { throw Error("missing"); }, record() {} });
  assert.equal(absentAuthorization({ toolName: "dispatch_agent", toolCallId: "x", input: { agent: "planner", deliverables: [f.planPath] } }, { abort() {} })?.block, true);
});

test("fixture hook loads the real gate; only harness advances stage after evidence gates", () => {
  assert.match(source, /cpSync\(join\(root, "\.pi\/harnesses\/agent-hub\/task-triage-live-stage-boundary\.mjs"\), join\(worktree, "stage-boundary\.mjs"\)\)/);
  assert.match(source, /import \{ createStageBoundary \} from "\.\/stage-boundary\.mjs"/);
  assert.match(source, /pi\.on\("tool_call", \(event: any, ctx: any\) => gate\(event, ctx\)\)/);
  assert.match(source, /T4_LIVE_STAGE: stagePath, T4_LIVE_PLAN: planPath, T4_LIVE_DISPATCHES: dispatchLog/);
  assert.match(source, /renameSync\(next, stagePath\)/);
  assert.ok(source.indexOf('throw new Error("planner changed README') < source.indexOf('authorize("build")'));
  assert.ok(source.indexOf('throw new Error("builder runtime acceptance/check/revision/readback incomplete') < source.indexOf('authorize("review")'));
  assert.ok(source.indexOf('const reviewInputs = [') < source.indexOf('authorize("review")'));
  assert.match(source, /dispatches\.length !== outcome\.stages\.length \+ 1/);
  assert.match(source, /const observed = dispatches\.map\(id =>/);
});
