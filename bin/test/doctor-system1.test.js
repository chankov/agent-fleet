import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { runDoctor, scanSystem1Readiness } from "../lib/doctor.js";

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
    assert.equal(findings[0].envDeclared, declareEnv);
    assert.equal(findings[0].environmentPresent, readiness === "ready");
    assert.equal(findings[0].apiValidity, "unverified");
    assert.equal(JSON.stringify(findings).includes("present-only-in-env"), false);
    assert.equal(JSON.stringify(findings).includes("not-loaded"), false);
    if (readiness === "disabled") {
      assert.match(findings[0].issue, /other fields were not validated/);
    }
  }
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
