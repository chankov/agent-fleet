import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import YAML from "yaml";

const workflow = YAML.parse(readFileSync(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8"));

test("PRs and releases share Linux/macOS validation without PR publishing authority", () => {
  assert.deepEqual(workflow.on.pull_request.branches, ["main"]);
  assert.equal(workflow.on.pull_request_target, undefined);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  const checks = workflow.jobs["installer-matrix"];
  assert.deepEqual(checks.strategy.matrix.os, ["ubuntu-latest", "macos-latest"]);
  assert.equal(checks.permissions, undefined);
  assert.equal(checks.secrets, undefined);
  const commands = checks.steps.map(step => step.run).filter(Boolean);
  for (const command of ["npm test", "npm run test:portability", "npm run check:manifest", "npm run pack:dry"]) assert.ok(commands.includes(command), command);
  const checkout = checks.steps.find(step => step.uses?.startsWith("actions/checkout@"));
  assert.equal(checkout.with["persist-credentials"], false);
  assert.ok(!checks.steps.some(step => step.uses?.startsWith("changesets/action@")));
  const release = workflow.jobs.release;
  assert.equal(release.needs, "installer-matrix");
  assert.equal(release.if, "github.event_name != 'pull_request' && github.ref == 'refs/heads/main'");
  assert.deepEqual(release.permissions, { contents: "write", "pull-requests": "write", "id-token": "write" });
});
