import { execFileSync, fork } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isCaptureEnabled, PROACTIVE_LIMITS } from "./proactive-config.ts";
import { checkScope } from "./scope-gate.js";
import type { ProactiveConfig, SourceExcerpt, TaskContext, TurnSnapshot, TurnUnit } from "./proactive-types.ts";

const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const forbidden = /^(?:\.env(?:\..*)?|\.git|\.pi|\.ssh|\.aws|\.npmrc|\.netrc|node_modules|vendor|dist|build|coverage|\.next|\.cache|artifacts|sessions?|transcripts?|credentials?(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|ed25519)|.*\.(?:pem|key|p12|pfx|sqlite|db|lock))$/i;
function allowed(root: string, path: string): string {
 if (!path || isAbsolute(path) || path.includes("\\") || path.includes("\0") || path.split("/").some(s => !s || s === "." || s === ".." || forbidden.test(s))) throw new Error("forbidden_path");
 const rootReal = realpathSync(root), full = resolve(root, path);
 const rel = relative(rootReal, full);
 if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("escape");
 let cursor = rootReal;
 for (const part of path.split("/")) {
  cursor = join(cursor, part);
  try { if (lstatSync(cursor).isSymbolicLink()) throw new Error("symlink"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") break; throw e; }
 }
 return full;
}
function remaining(start: number, now: () => number): number {
 const ms = PROACTIVE_LIMITS.captureMs - (now() - start);
 if (ms <= 0) throw new Error("capture_timeout");
 return Math.min(300, Math.max(1, Math.floor(ms)));
}
function git(root: string, args: string[], start: number, now: () => number, maxBuffer = 1024 * 1024): Buffer {
 remaining(start, now);
 // The enclosing process-group deadline owns cancellation; this is only a backup.
 const bytes = execFileSync("git", ["-C", root, ...args], { timeout: PROACTIVE_LIMITS.captureMs + 200, maxBuffer, stdio: ["ignore", "pipe", "pipe"] });
 remaining(start, now);
 return bytes;
}
function status(root: string, start: number, now: () => number): Set<string> {
 const rows = git(root, ["status", "--porcelain", "-z", "--untracked-files=all"], start, now).toString("utf8").split("\0");
 const paths = new Set<string>();
 for (let i = 0; i < rows.length; i++) {
  const row = rows[i]; if (!row) continue;
  paths.add(row.slice(3));
  if (/[RC]/.test(row.slice(0, 2)) && rows[i + 1]) paths.add(rows[++i]);
 }
 return paths;
}
function read(root: string, path: string, start: number, now: () => number, afterFirstRead?: () => void): Buffer | null {
 remaining(start, now);
 const full = allowed(root, path);
 let fd: number;
 try { fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW); }
 catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
 try {
  const before = fstatSync(fd);
  if (!before.isFile() || before.size > PROACTIVE_LIMITS.maxFileBytes) throw new Error("oversized_or_nonfile");
  const bytes = Buffer.alloc(before.size);
  let offset = 0;
  while (offset < bytes.length) { remaining(start, now); const n = readSync(fd, bytes, offset, bytes.length - offset, offset); if (!n) throw new Error("unstable_snapshot"); offset += n; }
  afterFirstRead?.();
  const confirm = Buffer.alloc(before.size);
  let checked = 0;
  while (checked < confirm.length) { remaining(start, now); const n = readSync(fd, confirm, checked, confirm.length - checked, checked); if (!n) throw new Error("unstable_snapshot"); checked += n; }
  const after = fstatSync(fd);
  if (!bytes.equals(confirm)) throw new Error("unstable_snapshot");
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.ino !== after.ino || !after.isFile()) throw new Error("unstable_snapshot");
  const final = lstatSync(full);
  if (final.isSymbolicLink() || final.ino !== after.ino) throw new Error("unstable_snapshot");
  if (bytes.includes(0) || !new TextDecoder("utf-8", { fatal: true }).decode(bytes)) { if (bytes.length) throw new Error("binary_or_invalid_utf8"); }
  remaining(start, now);
  return bytes;
 } finally { closeSync(fd); }
}
function excerpt(bytes: Buffer, secrets: readonly string[]): SourceExcerpt {
 let text = bytes.toString("utf8");
 for (const secret of secrets) if (secret) text = text.replaceAll(secret, "[REDACTED]");
 const source = bytes.toString("utf8");
 return Object.freeze({ hash: hash(text), offset: 0, endOffset: bytes.length, startLine: 1, endLine: Math.max(1, source.split("\n").length - (source.endsWith("\n") ? 1 : 0)), text, truncated: false });
}
export interface TurnBaseline {
 readonly root: string;
 readonly head: string;
 readonly dirty: ReadonlyMap<string, Buffer | null>;
 readonly initialPaths: ReadonlySet<string>;
 readonly config: ProactiveConfig;
 readonly turnId: string;
 readonly context: TaskContext;
 readonly gaps: readonly string[];
 readonly startedAt: number;
}
const code = (e: unknown): string => {
 const message = (e as Error)?.message;
 return typeof message === "string" && ["capture_timeout", "forbidden_path", "escape", "symlink", "oversized_or_nonfile", "unstable_snapshot", "binary_or_invalid_utf8", "missing_baseline", "oversized_baseline"].includes(message) ? message : "read_unavailable";
};
/** Worker-only synchronous core. Never call on the agent's event loop. */
export function beginTurnCore(input: { root: string; config: ProactiveConfig; turnId: string; context: TaskContext; knownTargets?: readonly string[]; now?: () => number }): TurnBaseline | null {
 if (!isCaptureEnabled(input.config)) return null;
 const now = input.now ?? Date.now, startedAt = now();
 let head = "";
 let initialPaths = new Set<string>();
 const dirty = new Map<string, Buffer | null>(), gaps: string[] = [];
 try {
  head = git(input.root, ["rev-parse", "HEAD"], startedAt, now).toString("utf8").trim();
  initialPaths = status(input.root, startedAt, now);
 } catch (e) { head = ""; gaps.push((e as Error).message === "capture_timeout" ? "capture_timeout" : "git_unavailable"); }
 let retained = 0, count = 0;
 for (const path of [...new Set([...initialPaths, ...(input.knownTargets ?? [])])].sort()) {
  if (now() - startedAt >= PROACTIVE_LIMITS.captureMs) { gaps.push("capture_timeout"); break; }
  if (!checkScope([path], input.config.include).inScope.length) continue;
  if (!head) break;
  if (count >= PROACTIVE_LIMITS.maxUnits || retained >= PROACTIVE_LIMITS.maxRetainedBytes) { gaps.push("baseline_limit"); break; }
  try {
   const bytes = read(input.root, path, startedAt, now);
   if (retained + (bytes?.length ?? 0) > PROACTIVE_LIMITS.maxRetainedBytes) { gaps.push("baseline_limit"); break; }
   dirty.set(path, bytes); retained += bytes?.length ?? 0; count++;
  } catch (e) { gaps.push(code(e)); }
 }
 return { root: input.root, head, dirty, initialPaths, config: input.config, turnId: input.turnId, context: structuredClone(input.context), gaps, startedAt };
}
export function finishTurnCore(baseline: TurnBaseline | null, input: { assistantText?: string; knownTargets?: readonly string[]; secrets?: readonly string[]; overlap?: boolean; now?: () => number; afterFirstRead?: () => void } = {}): TurnSnapshot | null {
 if (!baseline) return null;
 const now = input.now ?? Date.now, started = now();
 const gaps = [...baseline.gaps];
 let current: Set<string>;
 try {
  current = status(baseline.root, started, now);
  if (git(baseline.root, ["rev-parse", "HEAD"], started, now).toString("utf8").trim() !== baseline.head) gaps.push("head_changed");
 } catch (e) { current = new Set(); gaps.push((e as Error).message === "capture_timeout" ? "capture_timeout" : "git_unavailable"); }
 if (input.overlap) gaps.push("concurrent_writer_attribution_uncertain");
 const paths = [...new Set([...baseline.initialPaths, ...current, ...baseline.dirty.keys(), ...(input.knownTargets ?? [])])].sort();
 const units: TurnUnit[] = [];
 let retained = 0, omitted = 0;
 const secrets = input.secrets ?? [];
 for (const path of paths) {
  if (!checkScope([path], baseline.config.include).inScope.length) continue;
  if (now() - started >= PROACTIVE_LIMITS.captureMs) { gaps.push("capture_timeout"); omitted++; continue; }
  if (units.length >= PROACTIVE_LIMITS.maxUnits) { omitted++; continue; }
  try {
   // Deny both lexical and symlink/realpath escapes before path-specific Git reads.
   allowed(baseline.root, path);
   let before = baseline.dirty.get(path);
   if (!baseline.dirty.has(path)) {
    if (!baseline.head || baseline.initialPaths.has(path) || (input.knownTargets ?? []).includes(path)) throw new Error("missing_baseline");
    // A clean tracked path can use HEAD; only a path absent from HEAD is a genuine addition.
    const tracked = git(baseline.root, ["ls-tree", "-z", "--name-only", baseline.head, "--", path], started, now).length > 0;
    before = tracked ? git(baseline.root, ["show", `${baseline.head}:${path}`], started, now, PROACTIVE_LIMITS.maxFileBytes + 1) : null;
    if (before && before.length > PROACTIVE_LIMITS.maxFileBytes) throw new Error("oversized_baseline");
   }
   const after = read(baseline.root, path, started, now, input.afterFirstRead);
   remaining(started, now);
   if (before && (before.includes(0) || !new TextDecoder("utf-8", { fatal: true }).decode(before))) { if (before.length) throw new Error("binary_or_invalid_utf8"); }
   if (before !== null && after !== null && before?.equals(after)) continue;
   if (before == null && after == null) continue;
   const prior = before == null ? undefined : excerpt(before, secrets);
   const next = after == null ? undefined : excerpt(after, secrets);
   const size = Buffer.byteLength(prior?.text ?? "") + Buffer.byteLength(next?.text ?? "");
   remaining(started, now);
   if (retained + size > PROACTIVE_LIMITS.maxRetainedBytes) { omitted++; continue; }
   const unit: TurnUnit = Object.freeze({ id: hash(`${baseline.turnId}:${path}`), path, kind: before == null ? "added" : after == null ? "deleted" : "modified", before: prior, after: next, attribution: "uncertain" });
   units.push(unit); retained += size;
  } catch (e) { gaps.push(code(e)); omitted++; }
 }
 if (omitted) gaps.push(`omitted_paths:${omitted}`);
 if (baseline.config.remoteContext === "selected-excerpts" && input.assistantText) {
  const text = Buffer.from(input.assistantText);
  const redacted = text.length <= PROACTIVE_LIMITS.maxFileBytes ? excerpt(text, secrets) : null;
  const size = Buffer.byteLength(redacted?.text ?? "");
  if (units.length >= PROACTIVE_LIMITS.maxUnits || !redacted || retained + size > PROACTIVE_LIMITS.maxRetainedBytes) gaps.push("assistant_text_omitted");
  else { units.push(Object.freeze({ id: hash(`${baseline.turnId}:assistant`), path: "assistant", kind: "text", after: redacted, attribution: "observed_only" })); retained += size; }
 }
 const statusValue = gaps.some(g => g.includes("unstable_snapshot")) ? "unstable_snapshot" : gaps.length ? "partial" : "complete";
 const snapshotId = hash(JSON.stringify([baseline.turnId, baseline.head, baseline.context, units.map(u => [u.id, u.before?.hash, u.after?.hash]), gaps]));
 const context = structuredClone(baseline.context);
 Object.freeze(context.task);
 if (context.plan) Object.freeze(context.plan);
 for (const rule of context.rules) Object.freeze(rule);
 Object.freeze(context.rules); Object.freeze(context.exceptions); Object.freeze(context);
 return Object.freeze({ snapshotId, turnId: baseline.turnId, head: baseline.head, context, planStatus: baseline.context.plan ? "bound" : "task_only", status: statusValue, gaps: Object.freeze(gaps), units: Object.freeze(units), observedPaths: paths.length, coverage: Object.freeze({ retainedUnits: units.length, omittedPaths: omitted, retainedBytes: retained }) });
}
/** Immutable in-memory readback: never opens the source path. */
export function readSnapshotUnit(snapshot: TurnSnapshot, snapshotId: string, unitId: string, contentHash: string): string | null {
 if (snapshot.snapshotId !== snapshotId) return null;
 const unit = snapshot.units.find(u => u.id === unitId);
 const excerpt = [unit?.before, unit?.after].find(e => e?.hash === contentHash);
 return excerpt?.text ?? null;
}

/** Each phase runs in a disposable process group. The parent fences IPC after deadline
 * and kills the entire group (including any Git descendants) before settling. */
function capture<T>(phase: "begin" | "finish", payload: unknown): Promise<T> {
 return new Promise((resolve, reject) => {
  const child = fork(fileURLToPath(new URL("./proactive-snapshot-worker.mjs", import.meta.url)), [], {
   detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "advanced", execArgv: [],
  });
  let settled = false;
  const killGroup = () => {
   if (child.pid) {
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* exited */ }
    try { child.kill("SIGKILL"); } catch { /* exited */ }
   }
  };
  const settle = (error?: Error, result?: T) => {
   if (settled) return;
   settled = true;
   clearTimeout(timer);
   killGroup();
   if (error) reject(error); else resolve(result as T);
  };
  const timer = setTimeout(() => settle(new Error("capture_timeout")), PROACTIVE_LIMITS.captureMs);
  child.on("message", (message: { ok?: boolean; result?: T; code?: string }) => {
   if (!message?.ok) settle(new Error(message?.code === "capture_timeout" ? "capture_timeout" : "capture_unavailable"));
   else settle(undefined, message.result);
  });
  child.on("error", () => settle(new Error("capture_unavailable")));
  // Let a queued IPC result win if the process exits immediately after sending.
  child.on("exit", () => setImmediate(() => settle(new Error("capture_unavailable"))));
  child.send({ phase, payload }, error => { if (error) settle(new Error("capture_unavailable")); });
 });
}
export function beginTurn(input: Parameters<typeof beginTurnCore>[0]): Promise<TurnBaseline | null> {
 if (!isCaptureEnabled(input.config)) return Promise.resolve(null);
 const { now: _now, ...payload } = input;
 return capture<TurnBaseline | null>("begin", payload).then(baseline => {
  if (baseline) {
   Object.freeze(baseline.context.task); if (baseline.context.plan) Object.freeze(baseline.context.plan);
   for (const rule of baseline.context.rules) Object.freeze(rule);
   Object.freeze(baseline.context.rules); Object.freeze(baseline.context.exceptions); Object.freeze(baseline.context);
  }
  return baseline;
 });
}
export function finishTurn(baseline: TurnBaseline | null, input: Parameters<typeof finishTurnCore>[1] = {}): Promise<TurnSnapshot | null> {
 if (!baseline) return Promise.resolve(null);
 const { now: _now, afterFirstRead: _hook, assistantText, ...options } = input;
 return capture<TurnSnapshot>("finish", { baseline, input: baseline.config.remoteContext === "selected-excerpts" ? { ...options, assistantText } : options }).then(snapshot => {
  // IPC cloning loses Object.freeze; reapply it before exposing private evidence.
  for (const unit of snapshot.units) { if (unit.before) Object.freeze(unit.before); if (unit.after) Object.freeze(unit.after); Object.freeze(unit); }
  Object.freeze(snapshot.units); Object.freeze(snapshot.gaps); Object.freeze(snapshot.coverage);
  Object.freeze(snapshot.context.task); if (snapshot.context.plan) Object.freeze(snapshot.context.plan);
  for (const rule of snapshot.context.rules) Object.freeze(rule);
  Object.freeze(snapshot.context.rules); Object.freeze(snapshot.context.exceptions); Object.freeze(snapshot.context);
  return Object.freeze(snapshot);
 });
}
