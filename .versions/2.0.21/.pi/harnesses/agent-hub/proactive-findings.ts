import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProactiveAssessment } from "./proactive-evaluate.ts";
import type { LocalFinding } from "./proactive-local.ts";
import type { ReviewFinding, TurnSnapshot } from "./proactive-types.ts";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const LIMIT = 100;
export type FindingState = "current" | "stale" | "resolved";
export interface FindingEntry {
 readonly id: string; readonly source: "deterministic" | "system1";
 readonly claim: "violation" | "suspicion"; readonly state: FindingState;
 readonly owner: string; readonly attempt: string; readonly ruleId: string; readonly ruleHash: string; readonly subject: string;
 readonly snapshotHandle: string; readonly snapshotHash: string; readonly snapshotId: string;
 readonly unitId: string; readonly excerptHash: string; readonly occurrences: number;
 readonly capturedRange?: { readonly side: "before" | "after"; readonly offset: number; readonly endOffset: number; readonly startLine: number; readonly endLine: number };
 readonly violationLine?: number;
}
export interface FindingCoverage { readonly status: string; readonly gaps: readonly string[]; readonly checked: readonly string[] }
export interface FindingReview { readonly owner: string; readonly attempt: string; readonly turnId: string; readonly status: string; readonly planStatus: "bound" | "task_only"; readonly drift?: { readonly task: string; readonly plan: string }; readonly coverage: FindingCoverage; readonly findings: readonly FindingEntry[] }
interface Stored { entry: FindingEntry; key: string }
/** Private session-scoped evidence, not an activity record. Disk readback never opens a source file. */
export function createProactiveFindings(options: { directory?: string } = {}) {
 const snapshots = new Map<string, { bytes: Buffer; digest: string }>();
 const current = new Map<string, Stored>();
 const history: FindingReview[] = [];
 const identity = randomUUID();
 const snapshotFile = (handle: string) => options.directory && /^[a-f0-9]{64}$/.test(handle) ? join(options.directory, `${handle}.json`) : null;
 const retain = (snapshot: TurnSnapshot) => {
  const bytes = Buffer.from(JSON.stringify(snapshot));
  const digest = hash(bytes), handle = hash(`${identity}:${snapshot.turnId}:${digest}`);
  if (!snapshots.has(handle)) {
   snapshots.set(handle, { bytes, digest });
   if (options.directory) {
    try { mkdirSync(options.directory, { recursive: true, mode: 0o700 }); writeFileSync(snapshotFile(handle)!, bytes, { flag: "wx", mode: 0o600 }); }
    catch { snapshots.delete(handle); return null; }
   }
  }
  return { handle, digest };
 };
 const readback = (handle: string, digest: string, snapshotId: string, unitId: string, excerptHash: string): string | null => {
  if (!/^[a-f0-9]{64}$/.test(handle) || !/^[a-f0-9]{64}$/.test(digest)) return null;
  try {
   const file = snapshotFile(handle);
   const bytes = file ? readFileSync(file) : snapshots.get(handle)?.bytes;
   if (!bytes || hash(bytes) !== digest) return null;
   const snapshot = JSON.parse(bytes.toString("utf8")) as TurnSnapshot;
   if (snapshot.snapshotId !== snapshotId || !Array.isArray(snapshot.units)) return null;
   const unit = snapshot.units.find(u => u.id === unitId);
   const excerpt = [unit?.after, unit?.before].find(e => e?.hash === excerptHash);
   return excerpt && hash(excerpt.text) === excerptHash ? excerpt.text : null;
  } catch { return null; }
 };
 const observe = (owner: string, attempt: string, snapshot: TurnSnapshot, status: string, assessment?: ProactiveAssessment, checkedLocal: readonly { ruleId: string; subject: string }[] = []): FindingReview => {
  const evidence = retain(snapshot);
  const gaps = [...snapshot.gaps, ...(assessment?.gaps ?? []), ...(!evidence ? ["evidence_unavailable"] : [])].slice(0, 32).map(() => "coverage_gap");
  const checked: string[] = [];
  const fullyChecked = !!evidence && status === "reviewed" && snapshot.status === "complete" && gaps.length === 0 && assessment?.status === "reviewed";
  if (fullyChecked) for (const rule of assessment.rules) if (rule.verdict === "no_observed_violation" || rule.verdict === "not_applicable") checked.push(`${rule.ruleId}:${rule.unitId}`);
  const found = new Set<string>();
  for (const finding of assessment?.findings ?? []) {
   if (!evidence || finding.snapshotId !== snapshot.snapshotId || !["deterministic", "system1"].includes(finding.source)) continue;
   const unit = snapshot.units.find(u => u.id === finding.unitId);
   const local = finding as LocalFinding;
   const side = unit?.after ? "after" : "before";
   const excerpt = unit?.after ?? unit?.before;
   if (!unit || !excerpt || hash(excerpt.text) !== excerpt.hash || (finding.source === "deterministic" && (!local.locator || local.locator.path !== unit.path || local.locator.excerptHash !== excerpt.hash))) continue;
   const subject = unit.path;
   const ruleId = finding.reference;
   const ruleHash = finding.source === "deterministic" ? local.ruleHash : hash(JSON.stringify(snapshot.context.rules.map(r => [r.path, r.hash]).sort()));
   if (!/^[a-f0-9]{64}$/.test(ruleHash)) continue;
   // The normalized offending line is stable when unrelated lines move. Structural placement uses path.
   const line = local.locator?.line;
   const normalized = finding.source === "deterministic" && line !== undefined ? excerpt.text.split("\n")[line - 1]?.trim().replace(/\s+/g, " ") : finding.source === "deterministic" ? subject : excerpt.text.replace(/\s+/g, " ").trim();
   if (!normalized) continue;
   const key = hash(JSON.stringify([owner, attempt, finding.source, ruleId, ruleHash, subject, local.category ?? "", normalized]));
   found.add(key);
   const prior = current.get(key)?.entry;
   const { offset, endOffset, startLine, endLine } = excerpt;
   const validRange = [offset, endOffset, startLine, endLine].every(Number.isSafeInteger) && offset >= 0 && endOffset >= offset && startLine >= 1 && endLine >= startLine;
   const capturedRange = validRange ? Object.freeze({ side, offset, endOffset, startLine, endLine }) : undefined;
   // Local locators index the retained text; redaction can change its relation to source lines.
   const violationLine = capturedRange && finding.source === "deterministic" && local.category === "relative-markdown-links" &&
    Number.isSafeInteger(line) && line! >= 1 && line! <= excerpt.text.split("\n").length &&
    !excerpt.text.includes("[REDACTED]") && Buffer.byteLength(excerpt.text) === endOffset - offset &&
    startLine + line! - 1 <= endLine ? startLine + line! - 1 : undefined;
   const entry: FindingEntry = Object.freeze({ id: key, source: finding.source, claim: finding.source === "deterministic" ? "violation" : "suspicion", state: "current", owner, attempt, ruleId, ruleHash, subject, snapshotHandle: evidence.handle, snapshotHash: evidence.digest, snapshotId: snapshot.snapshotId, unitId: unit.id, excerptHash: excerpt.hash, occurrences: (prior?.occurrences ?? 0) + 1, ...(capturedRange ? { capturedRange } : {}), ...(violationLine !== undefined ? { violationLine } : {}) });
   current.set(key, { key, entry });
  }
  // Resolution requires an explicit successful same-rule/subject recheck, never an omission.
  for (const [key, stored] of current) {
   if (!evidence) break; // Failed private retention cannot justify changing prior findings.
   const prior = stored.entry;
   if (prior.owner !== owner || prior.attempt !== attempt || found.has(key) || prior.state === "resolved") continue;
   const subjectPresent = snapshot.units.some(u => u.path === prior.subject);
   const semanticChecked = fullyChecked && prior.source === "system1" && prior.ruleHash === hash(JSON.stringify(snapshot.context.rules.map(r => [r.path, r.hash]).sort())) && assessment!.rules.some(r => r.ruleId === prior.ruleId && snapshot.units.some(u => u.id === r.unitId && u.path === prior.subject && (r.verdict === "no_observed_violation" || r.verdict === "not_applicable")));
   const deterministicChecked = snapshot.status === "complete" && gaps.length === 0 && status === "reviewed" && subjectPresent && checkedLocal.some(c => c.ruleId === prior.ruleId && c.subject === prior.subject && snapshot.context.rules.some(r => r.hash === prior.ruleHash));
   const state = semanticChecked || deterministicChecked ? "resolved" : "stale";
   current.set(key, { key, entry: Object.freeze({ ...prior, state }) });
  }
  const review: FindingReview = Object.freeze({ owner, attempt, turnId: snapshot.turnId, status, planStatus: snapshot.planStatus, ...(assessment?.drift ? { drift: Object.freeze({ task: assessment.drift.task, plan: assessment.drift.plan }) } : {}), coverage: Object.freeze({ status: fullyChecked ? "checked" : "partial", gaps: Object.freeze(gaps), checked: Object.freeze(checked) }), findings: Object.freeze([...current.values()].map(v => v.entry).filter(v => v.owner === owner && v.attempt === attempt).slice(-LIMIT)) });
  history.push(review); if (history.length > LIMIT) history.shift();
  while (current.size > LIMIT) current.delete(current.keys().next().value!);
  // Retain at most LIMIT private snapshots, even when local-only jobs exceed semantic budget.
  if (snapshots.size > LIMIT) {
   const oldest = snapshots.keys().next().value!;
   snapshots.delete(oldest);
   const file = snapshotFile(oldest);
   if (file) try { unlinkSync(file); } catch { /* readback reports unavailable */ }
  }
  return review;
 };
 return { observe, readback, get history() { return history.slice(); }, get current() { return [...current.values()].map(v => v.entry).slice(-LIMIT); }, dispose() { snapshots.clear(); current.clear(); history.length = 0; } };
}
