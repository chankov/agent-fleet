import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configuredConcurrency, configuredRetries, retriedPasses, runNodeTestWithRerun } from "./helpers/node-test-rerun.js";

test("retries default to one under CI, zero locally, and accept a bounded override", () => {
  assert.equal(configuredRetries({}), 0);
  assert.equal(configuredRetries({ CI: "true" }), 1);
  assert.equal(configuredRetries({ CI: "false" }), 0);
  assert.equal(configuredRetries({ CI: "true", AF_TEST_RETRIES: "0" }), 0);
  assert.equal(configuredRetries({ AF_TEST_RETRIES: "2" }), 2);
  assert.throws(() => configuredRetries({ AF_TEST_RETRIES: "9" }), /0-3/);
  assert.throws(() => configuredRetries({ AF_TEST_RETRIES: "x" }), /0-3/);
});

test("runner concurrency defaults to four, CI included, and accepts a bounded override", () => {
  assert.equal(configuredConcurrency({}), 4);
  assert.equal(configuredConcurrency({ CI: "true" }), 4);
  assert.equal(configuredConcurrency({ AF_TEST_CONCURRENCY: "" }), 4);
  assert.equal(configuredConcurrency({ AF_TEST_CONCURRENCY: "1" }), 1);
  assert.equal(configuredConcurrency({ AF_TEST_CONCURRENCY: "8" }), 8);
  for (const raw of ["0", "-1", "1.5", "x", "65"]) assert.throws(() => configuredConcurrency({ AF_TEST_CONCURRENCY: raw }), /1-64/);
});

test("only tests that passed after the first attempt are reported as retried", () => {
  assert.deepEqual(retriedPasses(undefined), []);
  assert.deepEqual(retriedPasses([{ "a.js:1:1": { name: "a", passed_on_attempt: 0 } }]), []);
  assert.deepEqual(retriedPasses([
    { "a.js:1:1": { name: "a", passed_on_attempt: 0 } },
    { "a.js:1:1": { name: "a", passed_on_attempt: 0 }, "a.js:2:1": { name: "b", passed_on_attempt: 1 } },
  ]), [{ location: "a.js:2:1", name: "b", attempt: 1 }]);
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "af-rerun-fixture-"));
  writeFileSync(join(dir, "flaky.test.mjs"), `import test from "node:test";import {existsSync,writeFileSync,appendFileSync} from "node:fs";
test("stable", () => { appendFileSync("stable-runs", "x"); });
test("flaky once", () => { if (!existsSync("seen")) { writeFileSync("seen", "1"); throw new Error("cold start"); } });
`);
  writeFileSync(join(dir, "broken.test.mjs"), `import test from "node:test";test("always fails", () => { throw new Error("regression"); });\n`);
  return dir;
}

const quiet = { GITHUB_ACTIONS: "", GITHUB_STEP_SUMMARY: "" };
const silent = { log() {}, warn() {} };

test("a test that fails once passes on the rerun without rerunning passed tests", { timeout: 60000 }, () => {
  const dir = fixture();
  try {
    const summary = join(dir, "summary.md");
    const lines = [];
    const log = { log: line => lines.push(line), warn: line => lines.push(line) };
    const result = runNodeTestWithRerun({ args: ["flaky.test.mjs"], cwd: dir, env: { ...process.env, ...quiet, GITHUB_ACTIONS: "true", GITHUB_STEP_SUMMARY: summary }, retries: 1, label: "fixture", stdio: "ignore", log });
    assert.equal(result.status, 0);
    assert.ok(lines.some(line => /^::warning title=Flaky test \(fixture\)::flaky once — flaky\.test\.mjs:3:1/.test(line)), lines.join("\n"));
    assert.equal(readFileSync(join(dir, "stable-runs"), "utf8"), "x", "passed tests are not executed again");
    assert.match(readFileSync(summary, "utf8"), /flaky once/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a real regression still fails after the rerun, and zero retries fails on the first attempt", { timeout: 60000 }, () => {
  const dir = fixture();
  try {
    assert.notEqual(runNodeTestWithRerun({ args: ["broken.test.mjs"], cwd: dir, env: { ...process.env, ...quiet }, retries: 1, label: "fixture", stdio: "ignore", log: silent }).status, 0);
    assert.notEqual(runNodeTestWithRerun({ args: ["flaky.test.mjs"], cwd: dir, env: { ...process.env, ...quiet }, retries: 0, label: "fixture", stdio: "ignore", log: silent }).status, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("release lanes run through the rerun helper", () => {
  for (const runner of ["./run-fast.js", "./helpers/run-portability.js"]) {
    const source = readFileSync(new URL(runner, import.meta.url), "utf8");
    assert.match(source, /runNodeTestWithRerun\(/, runner);
  }
});
