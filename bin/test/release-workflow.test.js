import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import YAML from "yaml";

const workflow = YAML.parse(readFileSync(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8"));
const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));

test("PRs and releases share Linux/macOS validation without PR publishing authority", () => {
  assert.deepEqual(workflow.on.pull_request.branches, ["main"]);
  assert.equal(workflow.on.pull_request_target, undefined);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  const checks = workflow.jobs["installer-matrix"];
  assert.deepEqual(checks.strategy.matrix.os, ["ubuntu-latest", "macos-latest"]);
  assert.equal(checks.permissions, undefined);
  assert.equal(checks.secrets, undefined);
  const commands = checks.steps.map(step => step.run).filter(Boolean);
  for (const command of ["npm run test:fast", "npm run test:portability", "npm run check:manifest", "npm run pack:dry"]) assert.ok(commands.includes(command), command);
  assert.equal(commands.includes("npm run test:full"), false, "release CI must not run the full suite");
  const checkout = checks.steps.find(step => step.uses?.startsWith("actions/checkout@"));
  assert.equal(checkout.with["persist-credentials"], false);
  assert.ok(!checks.steps.some(step => step.uses?.startsWith("changesets/action@")));
  const release = workflow.jobs.release;
  assert.equal(release.needs, "installer-matrix");
  assert.equal(release.if, "github.event_name != 'pull_request' && github.ref == 'refs/heads/main'");
  assert.deepEqual(release.permissions, { contents: "write", "pull-requests": "write", "id-token": "write" });
});

test("the release PR is opened with a GitHub App token, falling back to GITHUB_TOKEN until configured", () => {
  const steps = workflow.jobs.release.steps;
  const mint = steps.findIndex(step => step.id === "app-token");
  const checkout = steps.findIndex(step => step.uses?.startsWith("actions/checkout@"));
  const changesets = steps.find(step => step.uses?.startsWith("changesets/action@"));
  assert.ok(mint >= 0 && mint < checkout, "the App token is minted before checkout");
  assert.match(steps[mint].uses, /^actions\/create-github-app-token@/);
  assert.equal(steps[mint].if, "${{ vars.RELEASE_APP_ID != '' }}");
  assert.equal(steps[mint].with["app-id"], "${{ vars.RELEASE_APP_ID }}");
  assert.equal(steps[mint].with["private-key"], "${{ secrets.RELEASE_APP_PRIVATE_KEY }}");
  assert.equal(steps[checkout].with.token, "${{ steps.app-token.outputs.token || github.token }}");
  assert.equal(changesets.env.GITHUB_TOKEN, "${{ steps.app-token.outputs.token || secrets.GITHUB_TOKEN }}");
  assert.equal(workflow.jobs["installer-matrix"].steps.some(step => step.id === "app-token"), false, "PR checks never mint the App token");
});

test("npm test defaults to a fast local lane while the full suite remains available", () => {
  assert.equal(packageJson.scripts.test, "npm run test:fast");
  assert.equal(packageJson.scripts["test:fast"], "node bin/test/run-fast.js");
  const fullScript = packageJson.scripts["test:full"];
  assert.match(fullScript, /npm run typecheck:workflows/);
  assert.ok(fullScript.includes("bin/test/*.test.js"));
  assert.match(fullScript, /npm run test:watchdog-py/);
  const fastRunner = readFileSync(new URL("./run-fast.js", import.meta.url), "utf8");
  assert.ok(fastRunner.includes('"bin/test/features.test.js"'));
  assert.ok(fastRunner.includes('".pi/harnesses/agent-hub/proactive-config.test.ts"'));
  assert.doesNotMatch(fastRunner, /proactive-installed|package-hermes-watchdog/);
});
