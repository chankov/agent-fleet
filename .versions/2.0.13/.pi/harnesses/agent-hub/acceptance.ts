import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { resolveArtifactPath, artifactPreviewFromText } from "./artifacts.js";
import type { DispatchAgentParams } from "./tools/context.ts";

type Roots = { cwd: string; sessionDir: string };
export interface DeliverableContract {
 files: { input: string; path: string; before: string | null }[];
 scopeRoots: { scope: string; root: string; exists: boolean }[];
}
export interface DeliverableReadback {
 path: string; status: "read" | "missing" | "unreadable"; changed?: boolean;
 sha256?: string; bytes?: number; preview?: string; reason?: string; retainedPath?: string;
}
const within = (root: string, path: string) => { const rel = relative(root, path); return rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel); };
function checkedPath(path: string, roots: Roots): string {
 const allowed = [resolve(roots.cwd), resolve(roots.sessionDir)];
 if (!allowed.some(root => within(root, path))) throw new Error(`Path outside repository/session: ${path}`);
 let ancestor = path;
 while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
 const real = realpathSync(ancestor);
 if (!allowed.some(root => existsSync(root) && within(realpathSync(root), real))) throw new Error(`Symlink path outside repository/session: ${path}`);
 return path;
}
const digest = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const exactArtifactPath = (input: string, roots: Roots) => checkedPath(resolveArtifactPath(input, {
 repoDir: roots.cwd, sessionDir: roots.sessionDir, exists: () => true, // No guessing another artifact kind.
}).path, roots);

export function preflightDeliverables(params: Pick<DispatchAgentParams, "scope" | "scope_mode" | "deliverables">, roots: Roots): DeliverableContract {
 const files = (params.deliverables ?? []).map(input => {
  const path = exactArtifactPath(input, roots);
  let before: string | null = null;
  try { if (statSync(path).isFile()) before = digest(readFileSync(path)); } catch {}
  return { input, path, before };
 });
 const scopeRoots = (params.scope ?? []).map(scope => {
  const normalized = scope.replace(/\\/g, "/").replace(/^\.\//, "");
  const wildcard = normalized.search(/[*?]/);
  const prefix = wildcard < 0 ? normalized.replace(/\/+$/, "") : normalized.slice(0, wildcard);
  const base = wildcard < 0 ? prefix : prefix.slice(0, prefix.lastIndexOf("/") + 1);
  const root = checkedPath(resolve(roots.cwd, base || "."), roots), exists = existsSync(root);
  const declaredNewFile = wildcard < 0 && !normalized.endsWith("/") && files.some(file => file.path === root) && existsSync(dirname(root)) && statSync(dirname(root)).isDirectory();
  if (!exists && params.scope_mode !== "create" && !declaredNewFile) throw new Error(`Missing scope root: ${scope} (resolved to ${root}). Correct the path or explicitly declare scope_mode: create for new work. This is not a zero-match result.`);
  if (exists && wildcard >= 0 && !statSync(root).isDirectory()) throw new Error(`Scope root is not a directory: ${root}`);
  return { scope, root, exists };
 });
 return { files, scopeRoots };
}

export function readBackDeliverables(contract: DeliverableContract, roots: Roots, retain?: (index: number, bytes: Buffer) => string): DeliverableReadback[] {
 return contract.files.map((file, index) => {
  try {
   checkedPath(file.path, roots);
   if (!existsSync(file.path)) return { path: file.path, status: "missing" };
   if (!statSync(file.path).isFile()) return { path: file.path, status: "unreadable", reason: "not a regular file" };
   const bytes = readFileSync(file.path), sha256 = digest(bytes);
   return { path: file.path, status: "read", sha256, bytes: bytes.length, changed: file.before !== sha256, preview: artifactPreviewFromText(bytes.toString("utf8")), ...(retain ? { retainedPath: retain(index, bytes) } : {}) };
  } catch (error) { return { path: file.path, status: "unreadable", reason: String(error) }; }
 });
}

export type ExecutionStatus = "completed" | "failed" | "pending";
export type ChangeStatus = "changed" | "unchanged" | "unknown";
export type VerificationStatus = "passed" | "failed" | "missing" | "stale" | "unsupported";
export type RequirementStatus = VerificationStatus;

export interface AcceptanceRequirement {
 id: string;
 tag: string;
 text: string;
 source: string;
 reference?: string;
 criticalConditions?: string[];
 testCommand?: string;
 status?: "open" | "proven" | "unproven" | "failed";
 evidenceTaskId?: string;
 evidenceRevision?: string;
 evidenceRefs?: string[];
}

export interface VerificationCheckInput {
 kind?: "test" | "code-grep" | "compilation";
 taskId?: string;
 coverage?: Array<{ id: string; source: string; text: string; reference?: string; criticalConditions: string[] }>;
 producer: "runtime" | "specialist";
 command: string[];
 exitCode: number | null;
 inspectedRevision: string;
 evidenceRef: string;
 requirementIds?: string[];
}

export interface RuntimeResultInput {
 task: { id: string; current: boolean; beforeRevision: string; afterRevision: string };
 execution: { status: ExecutionStatus; exitCode: number | null; dispatchId: string | null };
 changes: { status: ChangeStatus; paths: string[]; attribution: "certain" | "uncertain" | "not_observed" };
 requirements: AcceptanceRequirement[];
 deliverables: DeliverableReadback[];
 checks: VerificationCheckInput[];
 evidenceRefs?: string[];
}

export function minimalChangeRequirement(): AcceptanceRequirement {
 return {
  id: "AF-MIN-CHANGE",
  tag: "test",
  text: "Inspect the actual changed state and run an applicable verification command against it.",
  source: "runtime:minimal-change-contract",
  reference: "T2a",
  criticalConditions: ["command, exit code, inspected revision, and evidence reference are runtime-recorded"],
  status: "open",
 };
}

export function mapCompatibilityStatus(input: {
 execution: ExecutionStatus;
 verification: VerificationStatus;
 accepted: boolean;
 deliverableFailed: boolean;
}): { hubAcceptanceStatus: "not_available" | "deliverable_failed" | "needs_verification" | "accepted"; flowStatus: "accepted" | "rejected" } {
 if (input.execution !== "completed") return { hubAcceptanceStatus: "not_available", flowStatus: "rejected" };
 if (input.deliverableFailed) return { hubAcceptanceStatus: "deliverable_failed", flowStatus: "rejected" };
 if (input.accepted && input.verification === "passed") return { hubAcceptanceStatus: "accepted", flowStatus: "accepted" };
 return { hubAcceptanceStatus: "needs_verification", flowStatus: "rejected" };
}

const unique = (values: Array<string | undefined>) => [...new Set(values.map(value => String(value || "").trim()).filter(Boolean))];

export function buildRuntimeResult(input: RuntimeResultInput) {
 const checks = input.checks.map(check => {
  let status: VerificationStatus = "unsupported";
  if (check.producer === "runtime" && !!check.taskId && check.command.length > 0 && Number.isInteger(check.exitCode) && check.evidenceRef) {
   status = check.taskId === input.task.id && check.inspectedRevision === input.task.afterRevision ? (check.exitCode === 0 ? "passed" : "failed") : "stale";
  }
  return { ...check, command: [...check.command], requirementIds: [...(check.requirementIds ?? [])], status };
 });
 const requirements = input.requirements.map(requirement => {
  const matching = checks.filter(check => check.requirementIds.includes(requirement.id) && (requirement.id === "AF-MIN-CHANGE" || (["test", "code-grep"].includes(requirement.tag) && check.kind === requirement.tag && check.taskId === input.task.id && check.command.length === 1 && check.command[0] === requirement.testCommand && check.coverage?.some(binding => binding.id === requirement.id && binding.source === requirement.source && binding.text === requirement.text && binding.reference === requirement.reference && JSON.stringify(binding.criticalConditions) === JSON.stringify(requirement.criticalConditions ?? [])))));
  let status: RequirementStatus;
  if (requirement.id !== "AF-MIN-CHANGE" && !["test", "code-grep"].includes(requirement.tag)) status = "unsupported";
  else if (matching.some(check => check.status === "failed")) status = "failed";
  else if (matching.some(check => check.status === "stale")) status = "stale";
  else if (matching.some(check => check.status === "passed")) status = "passed";
  else if (requirement.evidenceTaskId && requirement.evidenceTaskId !== input.task.id) status = "stale";
  else if (requirement.evidenceRevision && requirement.evidenceRevision !== input.task.afterRevision) status = "stale";
  else if (requirement.status === "failed") status = "failed";
  else if (requirement.status === "proven") status = "unsupported";
  else status = "missing";
  return {
   id: requirement.id,
   tag: requirement.tag,
   text: requirement.text,
   source: requirement.source,
   ...(requirement.reference ? { reference: requirement.reference } : {}),
   criticalConditions: [...(requirement.criticalConditions ?? [])],
   ...(requirement.testCommand ? { testCommand: requirement.testCommand } : {}),
   taskId: input.task.id,
   revision: input.task.afterRevision,
   status,
   claimedEvidenceRefs: unique(requirement.evidenceRefs ?? []),
   evidenceRefs: unique(matching.filter(check => check.producer === "runtime").map(check => check.evidenceRef)),
  };
 });
 const deliverableFailed = input.deliverables.some(deliverable => deliverable.status !== "read" || deliverable.changed !== true);
 let verification: VerificationStatus;
 if (input.execution.status !== "completed") verification = "unsupported";
 else if (!input.task.current || requirements.some(requirement => requirement.status === "stale") || checks.some(check => check.status === "stale")) verification = "stale";
 else if (deliverableFailed) verification = "failed";
 else if (input.changes.attribution === "uncertain" || input.changes.status === "unknown") verification = "unsupported";
 else if (requirements.some(requirement => requirement.status === "failed") || checks.some(check => check.status === "failed")) verification = "failed";
 else if (requirements.some(requirement => requirement.status === "unsupported") || checks.some(check => check.status === "unsupported")) verification = "unsupported";
 else if (input.changes.status !== "changed" || requirements.length === 0 || requirements.some(requirement => requirement.status === "missing") || checks.length === 0) verification = "missing";
 else verification = "passed";
 const accepted = input.execution.status === "completed" && input.task.current && input.changes.status === "changed" && input.changes.attribution === "certain" && verification === "passed" && requirements.every(requirement => requirement.status === "passed");
 const compatibility = mapCompatibilityStatus({ execution: input.execution.status, verification, accepted, deliverableFailed });
 const evidenceRefs = unique([
  ...(input.evidenceRefs ?? []),
  ...input.deliverables.map(deliverable => deliverable.retainedPath),
  ...checks.filter(check => check.producer === "runtime").map(check => check.evidenceRef),
  ...requirements.flatMap(requirement => requirement.evidenceRefs),
 ]);
 const reasons: string[] = [];
 if (input.execution.status !== "completed") reasons.push(`execution_${input.execution.status}`);
 if (!input.task.current) reasons.push("stale_task");
 if (input.changes.status !== "changed") reasons.push(`changes_${input.changes.status}`);
 if (input.changes.attribution !== "certain") reasons.push("change_attribution_uncertain");
 if (verification !== "passed") reasons.push(`verification_${verification}`);
 return {
  schema: "agent-fleet.runtime-result/v1" as const,
  task: { id: input.task.id, current: input.task.current, revision: { before: input.task.beforeRevision, after: input.task.afterRevision } },
  execution: { ...input.execution },
  changes: { ...input.changes, paths: [...input.changes.paths] },
  verification: { status: verification, requirements, checks, evidenceRefs, claimedEvidenceRefs: unique(requirements.flatMap(requirement => requirement.claimedEvidenceRefs)) },
  acceptance: { status: accepted ? "accepted" as const : "not_accepted" as const, accepted, reasons },
  compatibility,
 };
}
