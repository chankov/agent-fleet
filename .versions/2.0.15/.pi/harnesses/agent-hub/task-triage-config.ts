import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TASK_TRIAGE_LIMITS, TASK_TRIAGE_MODEL, TASK_TRIAGE_POLICY_VERSION, TASK_TRIAGE_PROVIDER, TASK_TRIAGE_QUESTION_VERSION } from "./task-triage-contract.ts";

export interface TaskTriageConfig { version: 1; mode: "off" | "experimental"; remoteContextApproved: boolean; provider: typeof TASK_TRIAGE_PROVIDER; model: typeof TASK_TRIAGE_MODEL; questionVersion: typeof TASK_TRIAGE_QUESTION_VERSION; policyVersion: typeof TASK_TRIAGE_POLICY_VERSION; limits: typeof TASK_TRIAGE_LIMITS; }
export type TaskTriageConfigStatus = { status: "active" | "off" | "missing" | "invalid"; config?: TaskTriageConfig };
const keys = ["version", "mode", "remoteContextApproved", "provider", "model", "questionVersion", "policyVersion", "limits"];
export function parseTaskTriageConfig(value: unknown): TaskTriageConfigStatus {
 if (!value || typeof value !== "object" || Array.isArray(value)) return { status: "invalid" };
 const x = value as Record<string, unknown>;
 if (Object.keys(x).some(k => !keys.includes(k)) || x.version !== 1 || (x.mode !== "off" && x.mode !== "experimental") || typeof x.remoteContextApproved !== "boolean" || x.provider !== TASK_TRIAGE_PROVIDER || x.model !== TASK_TRIAGE_MODEL || x.questionVersion !== TASK_TRIAGE_QUESTION_VERSION || x.policyVersion !== TASK_TRIAGE_POLICY_VERSION || !x.limits || typeof x.limits !== "object" || Array.isArray(x.limits)) return { status: "invalid" };
 const limits = x.limits as Record<string, unknown>;
 if (Object.keys(limits).length !== Object.keys(TASK_TRIAGE_LIMITS).length || Object.entries(TASK_TRIAGE_LIMITS).some(([k, v]) => limits[k] !== v)) return { status: "invalid" };
 if (x.mode === "off") return x.remoteContextApproved ? { status: "invalid" } : { status: "off" };
 return x.remoteContextApproved ? { status: "active", config: x as unknown as TaskTriageConfig } : { status: "off" };
}
/** Config parsing and loading are offline; no provider is constructed. */
export function loadTaskTriageConfig(root: string): TaskTriageConfigStatus {
 let raw: string;
 try { raw = readFileSync(join(root, ".ai/task-triage.json"), "utf8"); }
 catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? { status: "missing" } : { status: "invalid" }; }
 let config: TaskTriageConfigStatus;
 try { config = parseTaskTriageConfig(JSON.parse(raw)); } catch { return { status: "invalid" }; }
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
