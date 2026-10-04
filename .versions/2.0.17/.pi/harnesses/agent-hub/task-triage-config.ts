import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadSystem1Snapshot } from "../lib/system1/config-loader.js";
import { TASK_TRIAGE_LIMITS, TASK_TRIAGE_MODEL, TASK_TRIAGE_POLICY_VERSION, TASK_TRIAGE_PROVIDER, TASK_TRIAGE_QUESTION_VERSION } from "./task-triage-contract.ts";

export interface TaskTriageConfig { version: 1; mode: "off" | "experimental"; remoteContextApproved: boolean; provider: typeof TASK_TRIAGE_PROVIDER; model: typeof TASK_TRIAGE_MODEL; questionVersion: typeof TASK_TRIAGE_QUESTION_VERSION; policyVersion: typeof TASK_TRIAGE_POLICY_VERSION; limits: typeof TASK_TRIAGE_LIMITS; }
export type TaskTriageConfigStatus = { status: "active" | "off" | "missing" | "invalid"; config?: TaskTriageConfig };
import { parseTaskTriageConfig as parseShared } from "../lib/system1/config-triage.js";
export function parseTaskTriageConfig(value: unknown): TaskTriageConfigStatus { return parseShared(value) as TaskTriageConfigStatus; }
/** Config parsing and loading are offline; no provider is constructed. */
export function loadTaskTriageConfig(root: string, snapshot = loadSystem1Snapshot(root)): TaskTriageConfigStatus {
 const section = snapshot.consumers.taskTriage;
 if (snapshot.status === "invalid" || snapshot.status === "migration_required" || section.status === "invalid") return { status: "invalid" };
 if (snapshot.status === "missing" || !snapshot.document?.consumers.taskTriage) return { status: "missing" };
 const config: TaskTriageConfigStatus = section.status === "ready" ? { status: "active", config: section.config as TaskTriageConfig } : { status: "off" };
 if (config.status !== "active") return config;
 const statePath = join(root, ".ai/agent-fleet-state.json");
 try {
  // No installer state preserves existing manual configurations. A present but
  // corrupt/linked state cannot authorize remote context. Setup writes an
  // effective selection even when --features was an ephemeral CLI override.
  if (!lstatSync(statePath).isFile()) return { status: "invalid" };
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  if (!state || typeof state !== "object" || ![1, 2].includes(state.schemaVersion)) return { status: "invalid" };
  if (state.taskTriageSelected === false) return { status: "off" };
  if (state.taskTriageSelected === true || state.taskTriageSelected === undefined) return config;
  return { status: "invalid" };
 } catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? config : { status: "invalid" }; }
}
