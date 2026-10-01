import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { runDoctor, scanSystem1Readiness, scanTaskTriageReadiness } from "../lib/doctor.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cli = join(root, "bin", "cli.js");
const validConfig = {
  version: 1,
  mode: "auto",
  provider: "typesafe",
  model: "jev-1.13.0",
  apiKeyEnv: "TYPESAFE_API_KEY",
};

function workspace(t) {
  const ws = mkdtempSync(join(tmpdir(), "af-doctor-system1-"));
  t.after(() => rmSync(ws, { recursive: true, force: true }));
  return ws;
}

function selectSystem1(ws) {
  mkdirSync(join(ws, ".ai"), { recursive: true });
  writeFileSync(join(ws, ".ai", "agent-fleet.json"), JSON.stringify({
    schemaVersion: 1,
    preset: "default",
    features: { system1: true },
  }));
}

function writeConfig(ws, value = validConfig) {
  mkdirSync(join(ws, ".ai"), { recursive: true });
  writeFileSync(join(ws, ".ai", "system1.json"), JSON.stringify(value, null, 2) + "\n");
}

test("System 1 doctor readiness distinguishes absent, off, invalid, missing-key, and ready", (t) => {
  const absent = workspace(t);
  assert.deepEqual(scanSystem1Readiness({ workspace: absent, env: {} }), []);

  const cases = [
    ["missing_config", undefined, {}, false],
    ["disabled", { ...validConfig, mode: "off" }, {}, false],
    ["disabled", { mode: "off", nonsense: true }, {}, false],
    ["invalid_config", { ...validConfig, version: 2 }, {}, false],
    ["invalid_config", { ...validConfig, model: "wrong" }, {}, false],
    ["missing_key", validConfig, {}, true],
    ["ready", validConfig, { TYPESAFE_API_KEY: "present-only-in-env" }, false],
  ];
  for (const [readiness, config, env, declareEnv] of cases) {
    const ws = workspace(t);
    selectSystem1(ws);
    if (config !== undefined) writeConfig(ws, config);
    if (declareEnv) writeFileSync(join(ws, ".env"), "TYPESAFE_API_KEY=not-loaded\n");
    const findings = scanSystem1Readiness({ workspace: ws, env });
    assert.equal(findings.length, 1, readiness);
    assert.equal(findings[0].type, "system1");
    assert.equal(findings[0].readiness, readiness);
    assert.equal(findings[0].envDeclared, null, "doctor does not inspect .env, so declaration status is unknown");
    assert.doesNotMatch(findings[0].issue, /declared in \.env/);
    assert.equal(findings[0].environmentPresent, readiness === "ready");
    assert.equal(findings[0].apiValidity, "unverified");
    assert.equal(JSON.stringify(findings).includes("present-only-in-env"), false);
    assert.equal(JSON.stringify(findings).includes("not-loaded"), false);
    if (readiness === "disabled") {
      assert.match(findings[0].issue, /other fields were not validated/);
    }
  }
});

test("System 1 doctor recognizes selection through the experimental task-triage feature dependency", t => {
  const ws = workspace(t);
  mkdirSync(join(ws, ".ai"));
  writeFileSync(join(ws, ".ai/agent-fleet.json"), JSON.stringify({ schemaVersion: 1, preset: "default",
    features: { system1: false, "system1-task-triage": true } }));
  writeConfig(ws);
  const findings = scanSystem1Readiness({ workspace: ws, env: { TYPESAFE_API_KEY: "fixture-only" } });
  assert.equal(findings.find(f => f.type === "system1")?.readiness, "ready");
  assert.equal(JSON.stringify(findings).includes("fixture-only"), false);
});

test("task-triage doctor distinguishes applied selection, consent, provider and local-only readiness", t => {
  const ws = workspace(t);
  const statePath = join(ws, ".ai/agent-fleet-state.json");
  const triagePath = join(ws, ".ai/task-triage.json");
  const providerPath = join(ws, ".ai/system1.json");
  const active = { version: 1, mode: "experimental", remoteContextApproved: true, provider: "typesafe", model: "jev-1.13.0",
    questionVersion: "task-triage/questions/v1", policyVersion: "task-triage/policy/v1",
    limits: { maxTaskBytes: 40960, maxStateBytes: 65536, maxCallsPerSession: 100, timeoutMs: 2000 } };
  const scan = (env = {}) => scanTaskTriageReadiness({ workspace: ws, env });
  assert.deepEqual(scan(), [], "unselected new workspace has no triage advisory");
  mkdirSync(join(ws, ".ai"));
  writeFileSync(statePath, JSON.stringify({ schemaVersion: 2, taskTriageSelected: false }));
  assert.deepEqual(scan(), [], "default setup does not create a triage advisory");
  writeFileSync(statePath, JSON.stringify({ schemaVersion: 2, taskTriageSelected: true }));
  assert.equal(scan()[0].readiness, "missing_config");
  writeFileSync(triagePath, JSON.stringify({ ...active, policyVersion: "unknown" }));
  assert.equal(scan()[0].readiness, "policy_mismatch");
  writeFileSync(triagePath, JSON.stringify({ ...active, remoteContextApproved: false }));
  assert.equal(scan()[0].readiness, "unapproved");
  writeFileSync(triagePath, JSON.stringify({ ...active, mode: "off", remoteContextApproved: false }));
  assert.equal(scan()[0].readiness, "disabled");
  writeFileSync(triagePath, JSON.stringify(active));
  assert.equal(scan()[0].readiness, "missing_provider");
  writeConfig(ws, { ...validConfig, mode: "off" });
  assert.equal(scan()[0].readiness, "provider_off");
  writeConfig(ws, { ...validConfig, model: "wrong" });
  assert.equal(scan()[0].readiness, "invalid_provider");
  writeConfig(ws);
  assert.equal(scan()[0].readiness, "missing_key");
  const blocked = scan({ TYPESAFE_API_KEY: "private-test-value" })[0];
  assert.equal(blocked.readiness, "missing_local_producer");
  assert.deepEqual(blocked.missingLocalProducers, ["planner", "code-reviewer"]);
  assert.match(blocked.fix, /\/af-agents-add planner/);
  const personaDir = join(ws, ".pi/agents/personas");
  mkdirSync(personaDir, { recursive: true });
  for (const role of ["planner", "code-reviewer"]) writeFileSync(join(personaDir, `${role}.md`), `---\nname: ${role}\nmodel: synthetic/offline\n---\n`);
  const ready = scan({ TYPESAFE_API_KEY: "private-test-value" })[0];
  assert.equal(ready.readiness, "locally_ready");
  assert.equal(ready.stageProducerStatus, "local_files_present_roster_unverified");
  assert.equal(ready.selected, true);
  assert.equal(ready.configured, true);
  assert.equal(ready.remoteApproved, true);
  assert.equal(ready.apiValidity, "unverified");
  assert.equal(JSON.stringify(ready).includes("private-test-value"), false);
  writeFileSync(statePath, JSON.stringify({ schemaVersion: 2, taskTriageSelected: false }));
  assert.equal(scan({ TYPESAFE_API_KEY: "private-test-value" })[0].readiness, "disabled_by_setup");
  rmSync(statePath);
  const foreign = workspace(t);
  const foreignState = join(foreign, "outside-state.json");
  writeFileSync(foreignState, JSON.stringify({ schemaVersion: 2, taskTriageSelected: true, secret: "private-outside-value" }));
  symlinkSync(foreignState, statePath);
  const linked = scan({ TYPESAFE_API_KEY: "private-test-value" })[0];
  assert.equal(linked.readiness, "invalid_selection", "doctor must not trust a linked external state");
  assert.equal(JSON.stringify(linked).includes("private-outside-value"), false);
});

test("runDoctor keeps task-triage advisory read-only and never prints credential values", async t => {
  const ws = workspace(t);
  mkdirSync(join(ws, ".ai"));
  writeFileSync(join(ws, ".ai/agent-fleet-state.json"), JSON.stringify({ schemaVersion: 2, taskTriageSelected: true, items: {} }));
  const triagePath = join(ws, ".ai/task-triage.json");
  writeFileSync(triagePath, JSON.stringify({ version: 1, mode: "experimental", remoteContextApproved: true,
    provider: "typesafe", model: "jev-1.13.0", questionVersion: "task-triage/questions/v1", policyVersion: "task-triage/policy/v1",
    limits: { maxTaskBytes: 40960, maxStateBytes: 65536, maxCallsPerSession: 100, timeoutMs: 2000 } }));
  writeConfig(ws);
  const personaDir = join(ws, ".pi/agents/personas");
  mkdirSync(personaDir, { recursive: true });
  for (const role of ["planner", "code-reviewer"]) writeFileSync(join(personaDir, `${role}.md`), `---\nname: ${role}\nmodel: synthetic/offline\n---\n`);
  const before = [triagePath, join(ws, ".ai/system1.json")].map(p => readFileSync(p, "utf8"));
  const env = { TYPESAFE_API_KEY: "private-test-value" };
  const findings = await runDoctor({ workspace: ws, sourceRoot: root, env, checkVisibility: () => ({ status: 0, stdout: "" }), checkDependencies: () => ({ status: 0, stdout: "" }) });
  assert.equal(findings.find(f => f.type === "task-triage")?.readiness, "locally_ready");
  const applied = await runDoctor({ workspace: ws, sourceRoot: root, env, apply: true, checkVisibility: () => ({ status: 0, stdout: "" }), checkDependencies: () => ({ status: 0, stdout: "" }) });
  assert.equal(applied.findings.find(f => f.type === "task-triage")?.readiness, "locally_ready");
  assert.equal(JSON.stringify(applied).includes(env.TYPESAFE_API_KEY), false);
  const childEnv = { ...process.env, ...env, PI_OFFLINE: "1" };
  for (const args of [["--json"], []]) {
    const result = spawnSync(process.execPath, [cli, "doctor", "--workspace", ws, ...args], { encoding: "utf8", env: childEnv });
    assert.ok(result.status === 0 || result.status === 2, result.stderr);
    assert.equal((result.stdout + result.stderr).includes(env.TYPESAFE_API_KEY), false);
    if (args.length) assert.equal(JSON.parse(result.stdout).findings.find(f => f.type === "task-triage")?.readiness, "locally_ready");
    else assert.match(result.stdout, /Task triage: locally_ready/);
  }
  assert.deepEqual([triagePath, join(ws, ".ai/system1.json")].map(p => readFileSync(p, "utf8")), before);
});

test("runDoctor keeps System 1 advisory and read-only even when apply is requested", async (t) => {
  const ws = workspace(t);
  selectSystem1(ws);
  writeConfig(ws);
  writeFileSync(join(ws, ".env"), "TYPESAFE_API_KEY=private-file-value\n");
  const before = new Map([
    ["desired", readFileSync(join(ws, ".ai", "agent-fleet.json"), "utf8")],
    ["config", readFileSync(join(ws, ".ai", "system1.json"), "utf8")],
    ["env", readFileSync(join(ws, ".env"), "utf8")],
  ]);

  const findings = await runDoctor({ workspace: ws, sourceRoot: root, env: {}, checkVisibility: () => ({ status: 0, stdout: "" }), checkDependencies: () => ({ status: 0, stdout: "" }) });
  assert.equal(findings.filter((finding) => finding.type === "system1").length, 1);
  const applied = await runDoctor({ workspace: ws, sourceRoot: root, env: {}, apply: true, checkVisibility: () => ({ status: 0, stdout: "" }), checkDependencies: () => ({ status: 0, stdout: "" }) });
  assert.equal(applied.findings.filter((finding) => finding.type === "system1").length, 1);
  assert.equal(readFileSync(join(ws, ".ai", "agent-fleet.json"), "utf8"), before.get("desired"));
  assert.equal(readFileSync(join(ws, ".ai", "system1.json"), "utf8"), before.get("config"));
  assert.equal(readFileSync(join(ws, ".env"), "utf8"), before.get("env"));
});

test("CLI JSON/text and --fix keep System 1 advisory with zero outstanding work", (t) => {
  const ws = workspace(t);
  selectSystem1(ws);
  writeConfig(ws);
  const env = { ...process.env };
  delete env.TYPESAFE_API_KEY;
  const before = readFileSync(join(ws, ".ai", "system1.json"), "utf8");

  let result = spawnSync(process.execPath, [cli, "doctor", "--workspace", ws, "--json"], { encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr);
  let report = JSON.parse(result.stdout);
  assert.equal(report.summary.outstanding, 0);
  assert.equal(report.summary.advisories, 1);
  assert.equal(report.findings.find((finding) => finding.type === "system1").readiness, "missing_key");

  result = spawnSync(process.execPath, [cli, "doctor", "--workspace", ws], { encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /System 1/i);
  assert.match(result.stdout, /API validity is unverified/i);

  result = spawnSync(process.execPath, [cli, "doctor", "--workspace", ws, "--fix", "--json"], { encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr);
  report = JSON.parse(result.stdout);
  assert.equal(report.summary.outstanding, 0);
  assert.equal(readFileSync(join(ws, ".ai", "system1.json"), "utf8"), before);
  assert.equal(existsSync(join(ws, ".env")), false, "doctor never creates or loads .env");
});
