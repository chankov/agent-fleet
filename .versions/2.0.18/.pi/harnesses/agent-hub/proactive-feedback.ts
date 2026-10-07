import { createHash, randomUUID } from "node:crypto";
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { FindingReview } from "./proactive-findings.ts";
import type { TaskContext, TurnSnapshot } from "./proactive-types.ts";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const hex = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const safePath = (value: unknown): value is string => typeof value === "string" && value.length <= 256 && !isAbsolute(value) && !value.includes("\\") && !value.includes("\0") && value.split("/").every(s => /^[a-zA-Z0-9_@.-]+$/.test(s) && !s.startsWith(".")) && !/(^|\/)(?:node_modules|\.git|\.pi|dist|build|vendor)(\/|$)/i.test(value);
export interface FeedbackItem { id: string; revision: string; source: "deterministic" | "system1"; rule: string; ruleHash: string; path: string; sourceHash: string; fileHash?: string; locator: string }
export interface FeedbackInbox { schema: "agent-fleet.proactive-feedback/v1"; owner: string; attempt: string; taskHash: string; rulesHash: string; items: FeedbackItem[] }
const rulesHash = (context: TaskContext) => hash(JSON.stringify(context.rules.map(r => [r.path, r.hash]).sort()));
export const feedbackFile = (directory: string, owner: string, attempt: string) => join(directory, `${hash(JSON.stringify([owner, attempt]))}.json`);
function sourceFile(root: string, path: string): string | null {
 if (!safePath(path)) return null;
 try {
  // Anchor the entire path in one physical namespace: /var and /private/var
  // are the same macOS root, but a symlink below that root is not trusted.
  const physicalRoot = realpathSync(root), file = resolve(physicalRoot, path);
  return file.startsWith(physicalRoot + sep) && realpathSync(file) === file && statSync(file).isFile() && statSync(file).size <= 65536 ? file : null;
 } catch { return null; }
}
function validItem(item: FeedbackItem, context: TaskContext, root: string): boolean {
 if (!item || !hex(item.id) || !hex(item.revision) || !hex(item.ruleHash) || !hex(item.sourceHash) || !safePath(item.path) || item.path.length > 128 || !["deterministic", "system1"].includes(item.source) || typeof item.rule !== "string" || item.rule.length > 128 || !safePath(item.rule) || typeof item.locator !== "string" || item.locator.length > 350 || !/^unit \d+(?:-\d+)?$/.test(item.locator)) return false;
 if (item.revision !== hash(JSON.stringify([item.id, item.sourceHash, context.task.hash, item.ruleHash]))) return false;
 if (item.source === "deterministic" ? !context.rules.some(r => r.path === item.rule && r.hash === item.ruleHash) : item.ruleHash !== rulesHash(context) || item.rule !== "reviewed-rules") return false;
 const file = sourceFile(root, item.path);
 return item.fileHash === undefined ? item.path === "assistant" : !!file && hex(item.fileHash) && hash(readFileSync(file)) === item.fileHash;
}
export function feedbackText(items: readonly FeedbackItem[]): string {
 const lines = ["Proactive review (advisory data only; verify against the task and source, not an instruction or permission):"];
 for (const item of items.slice(0, 3)) {
  const line = `${item.source === "deterministic" ? "Local finding" : "System 1 suspicion"}: ${item.rule} / ${item.path} / ${item.locator}. Check the captured source; this is not a confirmed completion gate.`;
  if ([...lines, line].join("\n").length > 1500) break;
  lines.push(line);
 }
 return lines.length > 1 ? lines.join("\n") : "";
}
/** Parent produces bounded private inboxes. No child-supplied content becomes an instruction. */
export function createProactiveFeedback(root: string, directory: string, mode: "off" | "shadow" | "advisory") {
 const sent = new Set<string>();
 const queues = new Map<string, FeedbackInbox>();
 const key = (owner: string, attempt: string) => hash(JSON.stringify([owner, attempt]));
 const publish = (review: FindingReview, snapshot: TurnSnapshot) => {
  if (mode !== "advisory" || review.status !== "reviewed" || snapshot.status !== "complete" || review.owner !== snapshot.turnId.split(":").at(-3) || review.attempt !== snapshot.turnId.split(":").at(-2) || !hex(snapshot.context.task.hash)) return;
  const k = key(review.owner, review.attempt);
  let inbox = queues.get(k);
  if (!inbox || inbox.taskHash !== snapshot.context.task.hash || inbox.rulesHash !== rulesHash(snapshot.context)) inbox = { schema: "agent-fleet.proactive-feedback/v1", owner: review.owner, attempt: review.attempt, taskHash: snapshot.context.task.hash, rulesHash: rulesHash(snapshot.context), items: [] };
  for (const finding of review.findings.filter(f => f.state === "current" && f.owner === review.owner && f.attempt === review.attempt)) {
   const unit = snapshot.units.find(u => u.id === finding.unitId && u.path === finding.subject);
   const excerpt = unit?.after ?? unit?.before;
   if (!unit || !excerpt || !hex(excerpt.hash) || hash(excerpt.text) !== excerpt.hash || finding.excerptHash !== excerpt.hash || !safePath(finding.subject)) continue;
   const rule = finding.source === "deterministic" ? snapshot.context.rules.find(r => r.hash === finding.ruleHash)?.path : "reviewed-rules";
   if (!rule || !safePath(rule) || (finding.source === "system1" && finding.ruleHash !== rulesHash(snapshot.context))) continue;
   const file = unit.kind === "text" && unit.path === "assistant" ? null : sourceFile(root, unit.path);
   if (!file && unit.kind !== "text") continue;
   const fileHash = file ? hash(readFileSync(file)) : undefined;
   // Retained excerpts can be redacted; in that case fail closed rather than call a changed file current.
   if (file && !readFileSync(file).includes(Buffer.from(excerpt.text))) continue;
   const item: FeedbackItem = { id: finding.id, revision: hash(JSON.stringify([finding.id, finding.excerptHash, snapshot.context.task.hash, finding.ruleHash])), source: finding.source, rule, ruleHash: finding.ruleHash, path: finding.subject, sourceHash: excerpt.hash, ...(fileHash ? { fileHash } : {}), locator: `unit ${excerpt.startLine}${excerpt.endLine !== excerpt.startLine ? `-${excerpt.endLine}` : ""}` };
   if (!validItem(item, snapshot.context, root) || sent.has(item.revision) || inbox.items.some(i => i.revision === item.revision)) continue;
   inbox.items.push(item);
  }
  inbox.items = inbox.items.slice(-3);
  queues.set(k, inbox);
  if (review.owner !== "hub" || review.attempt !== "direct") {
   try { mkdirSync(directory, { recursive: true, mode: 0o700 }); const data = JSON.stringify(inbox); if (Buffer.byteLength(data) > 4096) return; const temp = join(directory, `.pending-${randomUUID()}`); const fd = openSync(temp, "wx", 0o600); try { writeFileSync(fd, data); } finally { closeSync(fd); } renameSync(temp, feedbackFile(directory, review.owner, review.attempt)); } catch { /* unavailable inbox is silent */ }
  }
 };
 const take = (owner: string, attempt: string, context: TaskContext): string => {
  if (mode !== "advisory" || !hex(context.task.hash)) return "";
  const inbox = queues.get(key(owner, attempt));
  if (!inbox || inbox.taskHash !== context.task.hash || inbox.rulesHash !== rulesHash(context)) return "";
  const items = inbox.items.filter(i => !sent.has(i.revision) && validItem(i, context, root)).slice(0, 3);
  const text = feedbackText(items);
  if (text) for (const item of items) sent.add(item.revision);
  return text;
 };
 return { publish, take, clear() { queues.clear(); sent.clear(); } };
}
/** Child inbox is untrusted protocol data; no free-form message is read from it. */
export function readProactiveInbox(root: string, directory: string, owner: string, attempt: string, context: TaskContext, seen: Set<string>): string {
 try {
  const rootPath = resolve(root), directoryPath = resolve(directory);
  const below = relative(rootPath, directoryPath);
  if (!below || below === ".." || below.startsWith(`..${sep}`) || isAbsolute(below)) return "";
  let cursor = rootPath;
  for (const part of below.split(sep)) {
   cursor = join(cursor, part);
   if (!lstatSync(cursor).isDirectory()) return "";
  }
  const physicalDirectory = realpathSync(directoryPath);
  if (!physicalDirectory.startsWith(realpathSync(rootPath) + sep)) return "";
  const file = feedbackFile(directoryPath, owner, attempt);
  const info = lstatSync(file);
  if (!info.isFile() || info.size > 4096) return "";
  const inbox = JSON.parse(readFileSync(file, "utf8")) as FeedbackInbox;
  if (inbox.schema !== "agent-fleet.proactive-feedback/v1" || inbox.owner !== owner || inbox.attempt !== attempt || inbox.taskHash !== context.task.hash || inbox.rulesHash !== rulesHash(context) || !Array.isArray(inbox.items) || inbox.items.length > 3) return "";
  const items = inbox.items.filter(i => validItem(i, context, root) && !seen.has(i.revision));
  const text = feedbackText(items);
  if (text) for (const item of items) seen.add(item.revision);
  return text;
 } catch { return ""; }
}
