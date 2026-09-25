import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, openSync, renameSync, writeFileSync, closeSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { ExtensionAPI, TurnEndEvent } from "@mariozechner/pi-coding-agent";
import { isCaptureEnabled } from "./proactive-config.ts";
import { beginTurn, finishTurn } from "./proactive-snapshot.ts";
import type { ProactiveConfig, TaskContext, TurnSnapshot } from "./proactive-types.ts";
import { readProactiveInbox } from "./proactive-feedback.ts";

export const PROACTIVE_OBSERVER_ENV = "AGENT_HUB_PROACTIVE_OBSERVER";
/** Only authored specialist turns; no researcher, review helper, judge or System 1 recursion. */
export function isProactiveSpecialist(persona: string): boolean {
 return !!persona && !/(?:research|review|auditor|test-engineer|judge|system[-_]?1)/i.test(persona);
}
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
export interface ObserverAssignment {
 root: string;
 directory: string;
 session: string;
 owner: string;
 attempt: string;
 config: ProactiveConfig;
 context: TaskContext;
}
export interface ObserverManifest {
 producer: "agent-fleet.proactive-observer/v1";
 session: string; owner: string; attempt: string; turnIndex: number; turnId: string;
 status: "captured" | "incomplete" | "not_checked";
 reason?: "aborted" | "capture_timeout" | "capture_unavailable" | "missing_turn_start";
 snapshot?: { path: string; hash: string; snapshotId: string; bytes: number };
}
/** Parent assigns a private attempt directory; only basename refs are published. */
function publish(dir: string, name: string, data: string): void {
 mkdirSync(dir, { recursive: true, mode: 0o700 });
 const temp = join(dir, `.pending-${randomUUID()}`);
 const fd = openSync(temp, "wx", 0o600);
 try { writeFileSync(fd, data); } finally { closeSync(fd); }
 chmodSync(temp, 0o600);
 renameSync(temp, join(dir, name));
}
export function observerStatus(directory: string, manifestExists: boolean): "instrumented" | "not_instrumented" {
 return directory && manifestExists ? "instrumented" : "not_instrumented";
}
export function createProactiveObserver(pi: Pick<ExtensionAPI, "on">, assignment: ObserverAssignment): void {
 if (!isCaptureEnabled(assignment.config)) return;
 if (!assignment.session || !assignment.owner || !assignment.attempt || !assignment.directory || !resolve(assignment.directory).startsWith(resolve(assignment.root) + "/")) throw new Error("Invalid proactive observer assignment");
 // Serialize hooks: snapshot subprocesses finish before the next baseline is taken.
 let queue: Promise<void> = Promise.resolve();
 let active: { turnIndex: number; baseline: Awaited<ReturnType<typeof beginTurn>> } | undefined;
 const seen = new Set<number>();
 const identity = (i: number) => `${assignment.session}:${assignment.owner}:${assignment.attempt}:${i}`;
 const delivered = new Set<string>();
 if (assignment.config.mode === "advisory") pi.on("context", event => {
  const text = readProactiveInbox(assignment.root, join(assignment.session, "artifacts", "proactive-inbox"), assignment.owner, assignment.attempt, assignment.context, delivered);
  if (text) return { messages: [...event.messages, { role: "custom" as const, customType: "agent-fleet.proactive-advisory", content: text, display: false, timestamp: Date.now() }] };
 });
 const record = (i: number, status: ObserverManifest["status"], reason?: ObserverManifest["reason"], snapshot?: TurnSnapshot) => {
  const turnId = identity(i);
  const manifest: ObserverManifest = { producer: "agent-fleet.proactive-observer/v1", session: assignment.session, owner: assignment.owner, attempt: assignment.attempt, turnIndex: i, turnId, status, ...(reason ? { reason } : {}) };
  if (snapshot) {
   const path = `snapshot-${i}.json`, data = JSON.stringify(snapshot);
   publish(assignment.directory, path, data);
   manifest.snapshot = { path, hash: sha(data), snapshotId: snapshot.snapshotId, bytes: Buffer.byteLength(data) };
  }
  publish(assignment.directory, `turn-${i}.json`, JSON.stringify(manifest));
 };
 const enqueue = (fn: () => Promise<void>) => { queue = queue.then(fn, fn).catch(() => { /* an unavailable capture is recorded at its hook */ }); return queue; };
 pi.on("turn_start", event => enqueue(async () => {
  const i = event.turnIndex;
  if (!Number.isSafeInteger(i) || i < 0 || seen.has(i) || active?.turnIndex === i) return;
  if (active) { record(active.turnIndex, "incomplete", "aborted"); seen.add(active.turnIndex); }
  active = { turnIndex: i, baseline: null };
  try { active.baseline = await beginTurn({ root: assignment.root, config: assignment.config, turnId: identity(i), context: assignment.context }); }
  catch { /* finish records not_checked, never claims a snapshot */ }
 }));
 pi.on("turn_end", (event: TurnEndEvent) => enqueue(async () => {
  const i = event.turnIndex;
  if (!Number.isSafeInteger(i) || i < 0 || seen.has(i)) return;
  seen.add(i);
  const baseline = active?.turnIndex === i ? active.baseline : null;
  if (active?.turnIndex === i) active = undefined;
  if (!baseline) { record(i, "not_checked", "missing_turn_start"); return; }
  const aborted = event.message.role !== "assistant" || event.message.stopReason === "aborted" || event.message.stopReason === "error";
  const assistantText = event.message.role === "assistant" ? event.message.content.filter(c => c.type === "text").map(c => c.text).join("") : "";
  try {
   const snapshot = await finishTurn(baseline, { assistantText });
   if (!snapshot) { record(i, "not_checked", "capture_unavailable"); return; }
   const timeout = snapshot.gaps.includes("capture_timeout");
   record(i, timeout ? "not_checked" : aborted || snapshot.status !== "complete" ? "incomplete" : "captured", timeout ? "capture_timeout" : aborted ? "aborted" : undefined, snapshot);
  } catch (error) { record(i, "not_checked", (error as Error).message === "capture_timeout" ? "capture_timeout" : "capture_unavailable"); }
 }));
 pi.on("agent_end", () => enqueue(async () => {
  if (active && !seen.has(active.turnIndex)) { record(active.turnIndex, "incomplete", "aborted"); seen.add(active.turnIndex); active = undefined; }
 }));
}
/** Native extension reads only its parent-provided assignment. No provider, key or inference in child. */
export default function proactiveObserver(pi: ExtensionAPI): void {
 const raw = process.env[PROACTIVE_OBSERVER_ENV];
 if (!raw || Buffer.byteLength(raw) > 16_384) return;
 try {
  const assignment = JSON.parse(raw) as ObserverAssignment;
  if (!assignment || !isCaptureEnabled(assignment.config) || basename(assignment.directory) === "." || !assignment.context?.task) return;
  createProactiveObserver(pi, assignment);
 } catch { /* malformed assignment is not instrumentation */ }
}
