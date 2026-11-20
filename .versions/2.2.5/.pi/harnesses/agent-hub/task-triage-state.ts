import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { redactCommunication } from "./system1-communication-store.ts";
import { TASK_TRIAGE_LIMITS, TASK_TRIAGE_STATE_VERSION } from "./task-triage-contract.ts";

export interface TaskTriageInput { task: string; clarifications?: readonly string[]; paths?: readonly string[]; constraints?: readonly string[]; metadataComplete?: boolean; }
const sensitive = (s: string) => redactCommunication(s) !== s || /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(s) || /\b(?:password|credential|secret|api[_ -]?key|token)\s*[:=]/i.test(s);
const denied = (s: string) => s.split("/").some(p => [".git", ".pi", "node_modules", ".env", "vendor", "dist", "build"].includes(p) || /^\.env\./.test(p));
/** Bounded, metadata-only local capture. Paths are caller-selected, never discovered by tree walk. */
export function buildTaskTriageState(input: TaskTriageInput, root: string, allowPath?: (relativePath: string) => boolean) {
 if (!input || !input.task?.trim() || input.metadataComplete === false || !Array.isArray(input.clarifications ?? []) || !Array.isArray(input.paths ?? []) || !Array.isArray(input.constraints ?? [])) return { ok: false as const, reason: "incomplete_input" as const };
 const clarifications = input.clarifications ?? [], paths = input.paths ?? [], constraints = input.constraints ?? [];
 if (paths.length > 32 || constraints.length > 16 || clarifications.length > 32 || [...clarifications, ...paths, ...constraints].some(s => typeof s !== "string")) return { ok: false as const, reason: "incomplete_input" as const };
 const textBytes = Buffer.byteLength(input.task) + clarifications.reduce((sum, s) => sum + Buffer.byteLength(s), 0);
 if (textBytes > TASK_TRIAGE_LIMITS.maxTaskBytes) return { ok: false as const, reason: "oversized_input" as const };
 if ([input.task, ...clarifications, ...paths, ...constraints].some(sensitive)) return { ok: false as const, reason: "sensitive_input" as const };
 const base = realpathSync(root);
 const metadata: { path: string; kind: "file" | "directory" | "missing" }[] = [];
 for (const name of paths) {
  if (!name || isAbsolute(name) || name.includes("\\") || name.includes("\0") || denied(name) || name.split("/").some(p => !p || p === "." || p === "..") || !allowPath || !allowPath(name)) return { ok: false as const, reason: "sensitive_input" as const };
  const full = resolve(base, name);
  const rel = relative(base, full);
  if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) return { ok: false as const, reason: "sensitive_input" as const };
  let kind: "file" | "directory" | "missing" = "missing";
  try {
   const stat = lstatSync(full);
   if (stat.isSymbolicLink()) return { ok: false as const, reason: "sensitive_input" as const };
   const resolved = realpathSync(full);
   const target = relative(base, resolved);
   if (target === ".." || target.startsWith(`..${sep}`) || isAbsolute(target)) return { ok: false as const, reason: "sensitive_input" as const };
   kind = stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "missing";
  } catch (e) {
   if ((e as NodeJS.ErrnoException).code !== "ENOENT") return { ok: false as const, reason: "incomplete_input" as const };
   // A missing leaf beneath an escaping symlink must not be called safe metadata.
   for (let parent = resolve(full, ".."); parent !== base; parent = resolve(parent, "..")) {
    try { const real = realpathSync(parent); const inside = relative(base, real); if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return { ok: false as const, reason: "sensitive_input" as const }; }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") return { ok: false as const, reason: "incomplete_input" as const }; }
   }
  }
  metadata.push({ path: name, kind });
 }
 const state = { schema: TASK_TRIAGE_STATE_VERSION, task: input.task, clarifications: [...clarifications], paths: metadata, constraints: [...constraints], gaps: metadata.filter(x => x.kind === "missing").map(x => x.path) };
 if (Buffer.byteLength(JSON.stringify(state)) > TASK_TRIAGE_LIMITS.maxStateBytes) return { ok: false as const, reason: "oversized_input" as const };
 return { ok: true as const, state, fingerprint: createHash("sha256").update(JSON.stringify(state)).digest("hex") };
}
