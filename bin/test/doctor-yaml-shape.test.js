// Tests for the doctor's dispatch-policy route scan. Routes are keyed by
// runtime role (PLAN-11-01, D11); the Hub ignores any other key with a
// warning, so the doctor reports such keys as advisory "yaml-shape" findings,
// with the role-and-practice mapping for a retired persona name. The old
// peers.yaml/teams.yaml scans went with those files (D7/D8/D16).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { runDoctor } from "../lib/doctor.js";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const POLICY_REL = ".pi/agents/dispatch-policy.yaml";

function workspaceWith(files) {
  const ws = mkdtempSync(join(tmpdir(), "agent-fleet-routes-"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(ws, rel)), { recursive: true });
    writeFileSync(join(ws, rel), text);
  }
  return ws;
}

async function shapeFindingsFor(files) {
  const ws = workspaceWith(files);
  try {
    const findings = await runDoctor({ workspace: ws, sourceRoot });
    return findings.filter((f) => f.type === "yaml-shape");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
}

test("role-keyed routes and an absent policy yield no findings", async () => {
  assert.deepEqual(await shapeFindingsFor({}), []);
  assert.deepEqual(await shapeFindingsFor({
    [POLICY_REL]: "default: native\nroutes:\n  reviewer:\n    peer: claude-reviewer\n    prefer: coms\n  researcher:\n    fallback: none\n",
  }), []);
  // The shipped policy is role-keyed.
  assert.deepEqual(await shapeFindingsFor({ [POLICY_REL]: readFileSync(join(sourceRoot, POLICY_REL), "utf8") }), []);
});

test("a retired persona route key is reported with its role-and-practice mapping", async () => {
  const findings = await shapeFindingsFor({
    [POLICY_REL]: "routes:\n  code-reviewer:\n    prefer: coms\n  planner:\n    prefer: coms\n",
  });
  assert.equal(findings.length, 2);
  const [codeReviewer, planner] = findings;
  assert.equal(codeReviewer.path, POLICY_REL);
  assert.match(codeReviewer.issue, /route "code-reviewer" is not a role, so the Hub ignores it/);
  assert.match(codeReviewer.issue, /"code-reviewer" is a retired persona.*agent "reviewer" with practices \["independent-review"\]/);
  assert.match(codeReviewer.fix, /key the route by "reviewer:" and keep the peer address as "peer: code-reviewer"/);
  // A persona that maps to two roles names both, and the fix leaves the choice to the human.
  assert.match(planner.issue, /agent "editor" with practices \["planning"\].*agent "researcher" with practices \["planning"\]/);
  assert.match(planner.fix, /key the route by its role \(researcher, reviewer, editor\) and name the peer with "peer: planner"/);
});

test("a peer-name route key that is not a persona still gets the role hint, and the legacy substitutions spelling is scanned", async () => {
  const [finding] = await shapeFindingsFor({ [POLICY_REL]: "substitutions:\n  claude-main:\n    prefer: coms\n" });
  assert.match(finding.issue, /route "claude-main" is not a role, so the Hub ignores it; routes are keyed by researcher, reviewer, editor/);
});

test("the advisory scan never edits the policy, and peers.yaml/teams.yaml are no longer read", async () => {
  const text = "routes:\n  code-reviewer:\n    prefer: coms\n";
  const ws = workspaceWith({
    [POLICY_REL]: text,
    ".pi/agents/peers.yaml": "full:\n    persona: web-debugger\n",
    ".pi/agents/teams.yaml": "default:\n  - code-reviewer\n",
  });
  try {
    const result = await runDoctor({ workspace: ws, sourceRoot, apply: false });
    assert.equal(result.filter((f) => f.path === ".pi/agents/peers.yaml" || f.path === ".pi/agents/teams.yaml").length, 0);
    assert.equal(readFileSync(join(ws, POLICY_REL), "utf8"), text);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
