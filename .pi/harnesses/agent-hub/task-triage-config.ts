import { readInstallationState } from "../lib/installation-owner.js";
import { loadSystem1Snapshot } from "../lib/system1/config-loader.js";
import { TASK_TRIAGE_LIMITS, TASK_TRIAGE_MODEL, TASK_TRIAGE_POLICY_VERSION, TASK_TRIAGE_PROVIDER, TASK_TRIAGE_QUESTION_VERSION } from "./task-triage-contract.ts";

export interface TaskTriageConfig { version: 1; mode: "off" | "experimental"; remoteContextApproved: boolean; provider: typeof TASK_TRIAGE_PROVIDER; model: typeof TASK_TRIAGE_MODEL; questionVersion: typeof TASK_TRIAGE_QUESTION_VERSION; policyVersion: typeof TASK_TRIAGE_POLICY_VERSION; limits: typeof TASK_TRIAGE_LIMITS; }
export type TaskTriageConfigStatus = { status: "active" | "off" | "missing" | "invalid"; config?: TaskTriageConfig };
import { parseTaskTriageConfig as parseShared } from "../lib/system1/config-triage.js";
export function parseTaskTriageConfig(value: unknown): TaskTriageConfigStatus { return parseShared(value) as TaskTriageConfigStatus; }
/** Config parsing and loading are offline; no provider is constructed. */
export function loadTaskTriageConfig(root: string, snapshot = loadSystem1Snapshot(root)): TaskTriageConfigStatus {
 const installation = readInstallationState(root);
 if (installation.status === 'invalid' || (installation.explicitOwner && installation.status === 'missing')) return { status: 'invalid' };
 const section = snapshot.consumers.taskTriage;
 if (snapshot.status === "invalid" || snapshot.status === "migration_required" || section.status === "invalid") return { status: "invalid" };
 if (snapshot.status === "missing" || !snapshot.document?.consumers.taskTriage) return { status: "missing" };
 const config: TaskTriageConfigStatus = section.status === "ready" ? { status: "active", config: section.config as TaskTriageConfig } : { status: "off" };
 if (config.status !== "active") return config;
 // Owner selection is a veto, never a replacement for workspace consent.
 return installation.state?.taskTriageSelected === false ? { status: 'off' } : config;
}
