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
  assert.deepEqual(release.permissions, { contents: "write", "id-token": "write" });
});

test("only a pending changeset cuts a release: CI versions on main with [skip ci], no release PR", () => {
  const steps = workflow.jobs.release.steps;
  assert.equal(steps.some(step => step.uses?.startsWith("changesets/action@")), false, "no bot release PR");
  const index = name => steps.findIndex(step => step.name === name);
  const version = steps[index("Version pending changesets")];
  const publish = steps[index("Publish to npm, tag and create GitHub Release")];
  assert.ok(version && publish, "version and publish steps exist");
  assert.ok(index("Version pending changesets") < index("Verify package contents"), "pack:dry checks the versioned tree");
  assert.ok(index("Verify package contents") < index("Publish to npm, tag and create GitHub Release"));
  assert.match(version.run, /find \.changeset .*! -name README\.md/);
  assert.match(version.run, /if \[ "\$pending" -eq 0 \]; then[\s\S]*?exit 0/, "no changesets means no new version");
  assert.match(version.run, /npm run version:changeset/);
  assert.match(version.run, /git commit -m "chore: release v\$\{version\} \[skip ci\]"/, "the version commit starts no extra run");
  assert.match(version.run, /git push origin HEAD:main/);
  assert.ok(version.run.indexOf("git push origin HEAD:main") > version.run.indexOf("git commit"));
  assert.match(publish.run, /^npx changeset publish$/m);
  assert.match(publish.run, /gh release create "\$tag"/);
  assert.equal(publish.env.GH_TOKEN, "${{ github.token }}");
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
