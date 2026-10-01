// Setup-only, non-secret task-triage configuration. Never replace a human file.
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SYSTEM1_CONFIG_VERSION, SYSTEM1_PROVIDER, SYSTEM1_MODEL, SYSTEM1_API_KEY_ENV,
} from "../../.pi/harnesses/lib/system1/config.js";

// Keep these values aligned with the runtime's versioned task-triage contract.
const CONFIG = Object.freeze({
  version: 1, mode: "experimental", remoteContextApproved: true,
  provider: "typesafe", model: "jev-1.13.0",
  questionVersion: "task-triage/questions/v1", policyVersion: "task-triage/policy/v1",
  limits: { maxTaskBytes: 40 * 1024, maxStateBytes: 64 * 1024, maxCallsPerSession: 100, timeoutMs: 2000 },
});

function approved(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (Object.keys(value).length !== Object.keys(CONFIG).length) return false;
  return Object.entries(CONFIG).every(([key, expected]) => {
    if (key !== "limits") return value[key] === expected;
    const limits = value.limits;
    return limits && typeof limits === "object" && !Array.isArray(limits)
      && Object.keys(limits).length === Object.keys(expected).length
      && Object.entries(expected).every(([name, max]) => limits[name] === max);
  });
}

function safeAiDirectory(workspace) {
  const parent = join(workspace, ".ai");
  let parentStat;
  try { parentStat = lstatSync(parent); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (parentStat?.isSymbolicLink()) throw new Error("linked .ai directory is not safe to inspect");
  if (parentStat && !parentStat.isDirectory()) throw new Error(".ai must be a directory");
  return parent;
}

/** Build a read-only plan; a valid existing grant is the only reusable consent. */
export function planTaskTriageConfig(workspace) {
  const path = join(safeAiDirectory(workspace), "task-triage.json");
  let stat;
  try { stat = lstatSync(path); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { path, write: true, text: JSON.stringify(CONFIG, null, 2) + "\n", alreadyApproved: false, status: "missing" };
  }
  if (!stat.isFile()) throw new Error(".ai/task-triage.json must be a regular file; existing link or directory is not safe to inspect");
  let status = "invalid";
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (approved(value)) status = "active";
    else if (value && typeof value === "object" && value.policyVersion !== CONFIG.policyVersion
      && approved({ ...value, policyVersion: CONFIG.policyVersion })) status = "policy_mismatch";
    else if (value && typeof value === "object" && (value.mode === "off" || value.mode === "experimental")
      && value.remoteContextApproved === false
      && approved({ ...value, mode: "experimental", remoteContextApproved: true })) {
      status = value.mode === "off" ? "off" : "unapproved";
    }
  } catch { /* Invalid or unreadable human config stays untouched and cannot authorize. */ }
  return { path, write: false, preserved: true, alreadyApproved: status === "active", status };
}

/** Propose a non-secret provider template only when selecting task triage. */
export function planTaskTriageProviderConfig(workspace) {
  const path = join(safeAiDirectory(workspace), "system1.json");
  let stat;
  try { stat = lstatSync(path); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    const template = { version: SYSTEM1_CONFIG_VERSION, mode: "auto", provider: SYSTEM1_PROVIDER,
      model: SYSTEM1_MODEL, apiKeyEnv: SYSTEM1_API_KEY_ENV };
    return { path, write: true, text: JSON.stringify(template, null, 2) + "\n", status: "missing" };
  }
  if (!stat.isFile()) throw new Error(".ai/system1.json must be a regular file; existing link or directory is not safe to inspect");
  return { path, write: false, preserved: true, status: "human-owned" };
}
