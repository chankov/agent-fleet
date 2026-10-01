import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTaskTriageConfig, loadTaskTriageConfig } from "./task-triage-config.ts";
import { TASK_TRIAGE_LIMITS, TASK_TRIAGE_MODEL, TASK_TRIAGE_PROVIDER, TASK_TRIAGE_POLICY_VERSION, TASK_TRIAGE_QUESTION_VERSION } from "./task-triage-contract.ts";
const config = { version: 1, mode: "experimental", remoteContextApproved: true, provider: TASK_TRIAGE_PROVIDER, model: TASK_TRIAGE_MODEL, policyVersion: TASK_TRIAGE_POLICY_VERSION, questionVersion: TASK_TRIAGE_QUESTION_VERSION, limits: TASK_TRIAGE_LIMITS };
test("explicit experimental consent and exact versioned limits, missing/off/invalid distinct", () => {
 assert.equal(parseTaskTriageConfig(config).status, "active"); assert.equal(parseTaskTriageConfig({ ...config, remoteContextApproved: false }).status, "off"); assert.equal(parseTaskTriageConfig({ ...config, mode: "off", remoteContextApproved: false }).status, "off");
 for (const x of [{ ...config, limits: { ...config.limits, timeoutMs: 2001 } }, { ...config, model: "other" }, { ...config, policyVersion: "other" }, { ...config, approved: true }, { ...config, mode: "shadow" }, { ...config, mode: "off" }]) assert.equal(parseTaskTriageConfig(x).status, "invalid");
 assert.equal(loadTaskTriageConfig("/nonexistent/task-triage-root").status, "missing");
});
test("installed feature deselection disables inference without erasing a human config", t => {
 const ws = mkdtempSync(join(tmpdir(), "triage-selection-")); t.after(() => rmSync(ws, { recursive: true, force: true }));
 mkdirSync(join(ws, ".ai"));
 const configPath = join(ws, ".ai/task-triage.json");
 const statePath = join(ws, ".ai/agent-fleet-state.json");
 const bytes = JSON.stringify(config) + "\n";
 writeFileSync(configPath, bytes);
 assert.equal(loadTaskTriageConfig(ws).status, "active", "legacy/manual config stays supported without installer state");
 writeFileSync(statePath, JSON.stringify({ schemaVersion: 2, taskTriageSelected: true }));
 assert.equal(loadTaskTriageConfig(ws).status, "active");
 writeFileSync(statePath, JSON.stringify({ schemaVersion: 2, taskTriageSelected: false }));
 assert.equal(loadTaskTriageConfig(ws).status, "off");
 assert.equal(readFileSync(configPath, "utf8"), bytes);
 writeFileSync(statePath, "{");
 assert.equal(loadTaskTriageConfig(ws).status, "invalid", "corrupt applied selection never grants inference");
});
