import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { System1Service } from "../lib/system1/contracts.ts";
import { createProactiveEvaluator } from "./proactive-evaluate.ts";
import { discoverRules } from "./proactive-rules.ts";
import { selectRules } from "./proactive-selection.ts";
import type { BoundReference } from "./proactive-types.ts";
import { PROACTIVE_LIMITS } from "./proactive-config.ts";
import type { ObserverAssignment, ObserverManifest } from "./proactive-observer.ts";
import type { ProactiveConfig, TaskContext, TurnSnapshot } from "./proactive-types.ts";
import { isCaptureEnabled, type LocalProactiveConfig } from "./proactive-config.ts";
import { assessLocal } from "./proactive-local.ts";
import type { CatalogSection } from "./proactive-rules.ts";
import type { ProactiveAssessment } from "./proactive-evaluate.ts";
import { beginTurn, finishTurn, type TurnBaseline } from "./proactive-snapshot.ts";
import { createProactiveFindings } from "./proactive-findings.ts";
import { createProactiveFeedback } from "./proactive-feedback.ts";
import { createProactiveActivity } from "./system1-activity.ts";

export type ReviewClosure = "reviewed" | "not_checked" | "superseded" | "queue_timeout" | "backlog_full" | "session_budget" | "cancelled" | "unavailable" | "no_new_evidence" | "not_instrumented";
export interface ReviewRecord { readonly owner: string; readonly attempt: string; readonly turnId: string; readonly snapshotId?: string; readonly status: ReviewClosure; readonly paths: readonly string[]; readonly uncheckedPaths: readonly string[]; readonly assessment?: import("./proactive-evaluate.ts").ProactiveAssessment }
export interface ReviewJob { readonly owner: string; readonly attempt: string; readonly snapshot: TurnSnapshot; readonly uncheckedPaths: readonly string[]; readonly signal: AbortSignal; readonly claimEvaluation?: () => boolean }
export interface ReviewRuntimeOptions {
 config: LocalProactiveConfig;
 localSections?: readonly CatalogSection[];
 evaluate?: ((job: ReviewJob) => Promise<void | import("./proactive-evaluate.ts").ProactiveAssessment>) & { readonly budgeted?: true }; // P6 accounts actual calls; legacy callbacks count one job.
 onRecord?: (record: ReviewRecord) => void;
 onChange?: () => void;
 findingsDirectory?: string; // parent-owned private session directory, never child supplied
 activityDirectory?: string;
 feedback?: ReturnType<typeof createProactiveFeedback>;
 now?: () => number;
 setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
 clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}
const MAX_PENDING = 8, MAX_WAIT_MS = 5000, MAX_CARRY = 20;
const sha = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const hex = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function paths(snapshot: TurnSnapshot): string[] { return [...new Set(snapshot.units.filter(u => u.kind !== "text").map(u => u.path))].slice(0, MAX_CARRY); }
interface Entry { owner: string; attempt: string; snapshot: TurnSnapshot; queued: number; controller: AbortController; carry: string[]; jobId: string; evaluationIds: string[]; closed: boolean }
export function createProactiveRuntime(options: ReviewRuntimeOptions) {
 const now = options.now ?? Date.now;
 const setTimer = options.setTimer ?? setTimeout;
 const clearTimer = options.clearTimer ?? clearTimeout;
 const enabled = options.config.mode !== "off";
 const pending: Entry[] = [];
 const lastIndex = new Map<string, number>();
 const carry = new Map<string, string[]>();
 const records: ReviewRecord[] = [];
 const findings = createProactiveFindings({ directory: options.findingsDirectory });
 const activity = createProactiveActivity({ directory: options.activityDirectory, now });
 let active: Entry | undefined;
 let timer: ReturnType<typeof setTimeout> | undefined;
 let used = 0, stopped = false;
 const ownerKey = (owner: string, attempt: string) => `${owner}\0${attempt}`;
 const remember = (entry: Entry, extra: string[]) => {
  const key = ownerKey(entry.owner, entry.attempt);
  carry.set(key, [...new Set([...(carry.get(key) ?? []), ...extra])].slice(0, MAX_CARRY));
 };
 const close = (entry: Entry, status: ReviewClosure, assessment?: import("./proactive-evaluate.ts").ProactiveAssessment) => {
  if (entry.closed) return;
  entry.closed = true;
  entry.evaluationIds.forEach(id => activity.evaluationFinished(entry.jobId, id, status === "reviewed" ? "ok" : status));
  activity.jobFinished(entry.jobId, status);
  if (assessment) {
   const checkedLocal = status === "reviewed" && entry.snapshot.status === "complete" && !assessment.gaps.length
    ? findings.current.filter(f => f.source === "deterministic" && f.owner === entry.owner && f.attempt === entry.attempt).flatMap(f => {
      const binding = options.config.localBindings?.find(b => b.rule.hash === f.ruleHash && options.localSections?.some(s => s.id === f.ruleId && s.source.hash === b.rule.hash && s.source.path === b.rule.path));
      const unit = entry.snapshot.units.find(u => u.path === f.subject && u.after && !u.after.truncated && sha(Buffer.from(u.after.text)) === u.after.hash);
      const matches = (patterns: readonly string[]) => patterns.some(p => p === f.subject || (p.endsWith("/**") && f.subject.startsWith(p.slice(0, -2))));
      return binding && unit && binding.applicability.kinds.includes(unit.kind as "added" | "modified") && (matches(binding.applicability.paths) || (binding.applicability.basename && f.subject.split("/").at(-1) === binding.applicability.basename && binding.applicability.paths.includes(binding.applicability.basename))) && !matches(binding.exceptions.paths) && (!binding.exceptions.legacy || unit.kind === "added") && entry.snapshot.context.rules.some(r => r.path === binding.rule.path && r.hash === binding.rule.hash) ? [{ ruleId: f.ruleId, subject: f.subject }] : [];
     }) : [];
   const review = findings.observe(entry.owner, entry.attempt, entry.snapshot, status, assessment, checkedLocal);
   options.feedback?.publish(review, entry.snapshot);
  }
  if (status !== "reviewed" && status !== "no_new_evidence") remember(entry, [...paths(entry.snapshot), ...entry.carry]);
  const record: ReviewRecord = { owner: entry.owner, attempt: entry.attempt, turnId: entry.snapshot.turnId, snapshotId: entry.snapshot.snapshotId, status, paths: paths(entry.snapshot), uncheckedPaths: [...(carry.get(ownerKey(entry.owner, entry.attempt)) ?? [])], ...(assessment ? { assessment } : {}) };
  records.push(record); options.onRecord?.(record); options.onChange?.();
 };
 const arm = () => {
  if (timer) { clearTimer(timer); timer = undefined; }
  if (!pending.length || stopped) return;
  timer = setTimer(() => { timer = undefined; drain(); }, Math.max(0, pending[0].queued + MAX_WAIT_MS - now()));
 };
 const drain = () => {
  if (stopped) return;
  while (pending.length && now() - pending[0].queued >= MAX_WAIT_MS) close(pending.shift()!, "queue_timeout");
  if (!active && pending.length) {
   const entry = pending.shift()!;
   active = entry;
   const local = options.config.localBindings?.length ? assessLocal(entry.snapshot, options.localSections ?? [], options.config.localBindings, options.config.include) : undefined;
   const localAssessment = (): ProactiveAssessment | undefined => local ? { status: "not_checked", drift: { task: "not_checked", plan: "not_checked" }, rules: [], findings: local.findings, gaps: local.gaps, evaluations: [] } : undefined;
   if (used >= options.config.maxEvaluationsPerSession && !local) { close(entry, "session_budget"); active = undefined; drain(); return; }
   const key = ownerKey(entry.owner, entry.attempt);
   const uncheckedPaths = [...new Set([...(carry.get(key) ?? []), ...entry.carry])].slice(0, MAX_CARRY);
   // No evaluator is installed before P6. Do not spend budget or fabricate semantic coverage.
   if (!options.evaluate || used >= options.config.maxEvaluationsPerSession) { close(entry, "not_checked", localAssessment()); active = undefined; drain(); return; }
   if (!options.evaluate.budgeted) {
    used++; // Existing P5 callbacks represent a single evaluation.
    const id = sha(Buffer.from(`${entry.jobId}:evaluation:1`));
    entry.evaluationIds.push(id); activity.evaluationStarted(entry.jobId, id);
   }
   let calls = 0;
   const claimEvaluation = () => {
    if (entry.controller.signal.aborted || calls >= PROACTIVE_LIMITS.maxCallsPerTurn || used >= options.config.maxEvaluationsPerSession) return false;
    calls++; used++;
    const id = sha(Buffer.from(`${entry.jobId}:evaluation:${calls}`));
    entry.evaluationIds.push(id); activity.evaluationStarted(entry.jobId, id);
    return true;
   };
   const deadline = setTimer(() => { if (active === entry) { active = undefined; entry.controller.abort(); close(entry, "unavailable", localAssessment()); drain(); } }, 2000);
   void Promise.resolve().then(() => options.evaluate!({ owner: entry.owner, attempt: entry.attempt, snapshot: entry.snapshot, uncheckedPaths, signal: entry.controller.signal, claimEvaluation }))
    .then(assessment => { if (active === entry && !entry.controller.signal.aborted) { const result = assessment && local ? { ...assessment, findings: [...local.findings, ...assessment.findings], gaps: [...local.gaps, ...assessment.gaps], status: local.gaps.length || assessment.gaps.length ? "not_checked" as const : assessment.status } : assessment ?? localAssessment(); if (result && (result.status !== "reviewed" || result.gaps.length || entry.snapshot.status !== "complete" || local?.gaps.length)) close(entry, "not_checked", result); else { carry.delete(key); close(entry, "reviewed", result); } } }, () => { if (active === entry && !entry.controller.signal.aborted) close(entry, "unavailable", localAssessment()); })
    .finally(() => { clearTimer(deadline); if (active === entry) { active = undefined; drain(); } });
  }
  arm();
 };
 const submit = (owner: string, attempt: string, snapshot: TurnSnapshot, turnIndex: number) => {
  if (!enabled || stopped) return false;
  if (!owner || !attempt || !Number.isSafeInteger(turnIndex) || turnIndex < 0 || !snapshot.turnId.endsWith(`:${owner}:${attempt}:${turnIndex}`)) return false;
  const key = ownerKey(owner, attempt);
  const prior = lastIndex.get(key);
  if (prior !== undefined && turnIndex <= prior) return false;
  lastIndex.set(key, turnIndex);
  const entry: Entry = { owner, attempt, snapshot, queued: now(), controller: new AbortController(), carry: [], jobId: sha(Buffer.from(JSON.stringify([owner, attempt, snapshot.turnId, snapshot.snapshotId]))), evaluationIds: [], closed: false };
  activity.jobStarted(entry.jobId); options.onChange?.();
  if (snapshot.units.length === 0) { close(entry, "no_new_evidence"); return true; }
  if (used >= options.config.maxEvaluationsPerSession && options.evaluate?.budgeted !== true && !options.config.localBindings?.length) { close(entry, "session_budget"); return true; }
  const existing = pending.findIndex(p => p.owner === owner);
  if (existing >= 0) { const replaced = pending.splice(existing, 1)[0]; close(replaced, "superseded"); }
  if (pending.length >= MAX_PENDING) { close(entry, "backlog_full"); return true; }
  pending.push(entry);
  drain();
  return true;
 };
 const recordGap = (owner: string, attempt: string, turnId: string, status: "not_checked" | "not_instrumented") => {
  if (!enabled || stopped || !owner || !attempt || !turnId) return false;
  const record: ReviewRecord = { owner, attempt, turnId, status, paths: [], uncheckedPaths: [...(carry.get(ownerKey(owner, attempt)) ?? [])] };
  records.push(record); options.onRecord?.(record); options.onChange?.();
  return true;
 };
 const abort = (owner?: string, attempt?: string) => {
  for (let i = pending.length - 1; i >= 0; i--) if ((!owner || pending[i].owner === owner) && (!attempt || pending[i].attempt === attempt)) close(pending.splice(i, 1)[0], "cancelled");
  if (active && (!owner || active.owner === owner) && (!attempt || active.attempt === attempt)) { const entry = active; active = undefined; entry.controller.abort(); close(entry, "cancelled"); }
  if (!owner) { stopped = true; options.feedback?.clear(); }
  drain();
 };
 return { submit, abort, recordGap, records, findings, activity, feedback: options.feedback, get pendingCount() { return pending.length; }, get activeCount() { return active ? 1 : 0; }, get used() { return used; } };
}
/** Hub hook ports share the same generation fence as session reset and evidence-dir binding. */
export function createHubCapture(options: {
 root: () => string; task: () => string | undefined; plan?: () => string | undefined;
 begin?: typeof beginTurn; finish?: typeof finishTurn;
}) {
 let generation = 0, session = "", config: ProactiveConfig | null = null;
 let runtime: ReturnType<typeof createProactiveRuntime> | null = null;
 let baseline: { index: number; value: TurnBaseline | null } | undefined;
 let capture: Promise<void> = Promise.resolve();
 let rules: readonly BoundReference[] = [];
 const bound = new Map<string, { task: string; plan?: string }>();
 const native = new Map<string, { owner: string; task: string; context: TaskContext }>();
 const seen = new Set<number>();
 const start = (index: number) => {
  if (!runtime || !config || !session || !isCaptureEnabled(config) || seen.has(index)) return;
  const current = generation, identity = session, settings = config;
  capture = capture.then(async () => {
   if (current !== generation || identity !== session || !runtime) return;
   const task = options.task(), plan = options.plan?.();
   if (!task?.trim()) { baseline = { index, value: null }; return; }
   const digest = (text: string) => createHash("sha256").update(text).digest("hex");
   const turnId = `${identity}:hub:direct:${index}`;
   bound.set(turnId, { task, ...(plan ? { plan } : {}) });
   if (bound.size > 32) bound.delete(bound.keys().next().value!);
   let value: TurnBaseline | null = null;
   try { value = await (options.begin ?? beginTurn)({ root: options.root(), config: settings, turnId, context: { task: { path: "hub-task", revision: digest(task), hash: digest(task) }, ...(plan ? { plan: { path: "hub-plan", revision: digest(plan), hash: digest(plan) } } : {}), rules, exceptions: [] } }); }
   catch { /* recorded by end */ }
   if (current === generation && identity === session) baseline = { index, value };
  }).catch(() => { if (current === generation && identity === session && runtime) {
   baseline = { index, value: null }; const turnId = `${identity}:hub:direct:${index}`; bound.delete(turnId);
   if (!runtime.records.some(r => r.turnId === turnId)) try { runtime.recordGap("hub", "direct", turnId, "not_checked"); } catch { /* callback failure must not poison capture */ }
  } });
  // Pi awaits turn_start handlers: tools must not race the bounded baseline capture.
  return capture;
 };
 const end = (index: number, text: string) => {
  if (!runtime || !config || !session || !isCaptureEnabled(config) || seen.has(index)) return;
  seen.add(index);
  const current = generation, identity = session;
  capture = capture.then(async () => {
   if (current !== generation || identity !== session || !runtime) return;
   const value = baseline?.index === index ? baseline.value : null;
   baseline = undefined;
   const turnId = `${identity}:hub:direct:${index}`;
   if (!value) { bound.delete(turnId); if (!runtime.records.some(r => r.turnId === turnId)) runtime.recordGap("hub", "direct", turnId, "not_checked"); return; }
   let snapshot: TurnSnapshot | null = null;
   try { snapshot = await (options.finish ?? finishTurn)(value, { assistantText: text }); }
   catch { /* unavailable capture */ }
   if (current !== generation || identity !== session || !runtime) return;
   if (snapshot) runtime.submit("hub", "direct", snapshot, index);
   else { bound.delete(turnId); runtime.recordGap("hub", "direct", turnId, "not_checked"); }
  }).catch(() => {
   if (current !== generation || identity !== session || !runtime) return;
   const turnId = `${identity}:hub:direct:${index}`;
   bound.delete(turnId);
   if (!runtime.records.some(r => r.turnId === turnId)) {
    try { runtime.recordGap("hub", "direct", turnId, "not_checked"); } catch { /* callback failed; the chain must remain usable */ }
   }
  });
 };
 return {
  start, end,
  reset() { generation++; runtime?.abort(); runtime = null; config = null; session = ""; baseline = undefined; rules = []; bound.clear(); native.clear(); seen.clear(); },
  initialize(next: ProactiveConfig, nextRuntime: ReturnType<typeof createProactiveRuntime>, refs: readonly BoundReference[] = []) { config = next; runtime = nextRuntime; rules = [...refs]; },
  /** Parent dispatch bytes only; the child receives hashes/refs, never these bytes. */
  nativeContext(identity: string, owner: string, attempt: string, task: string): TaskContext | undefined {
   if (!runtime || !config || !isCaptureEnabled(config) || identity !== session || !owner || !attempt || !task.trim()) return undefined;
   const prefix = `${identity}:${owner}:${attempt}:`;
   const hash = createHash("sha256").update(task).digest("hex");
   const context: TaskContext = { task: { path: "dispatch", revision: hash, hash }, rules: rules.map(ref => ({ ...ref })), exceptions: [] };
   for (const [key, value] of native) if (value.owner === owner) native.delete(key); // replacement attempt fence
   native.set(prefix, { owner, task, context });
   if (native.size > 32) native.delete(native.keys().next().value!);
   return context;
  },
  contentFor(turnId: string) {
   const hub = bound.get(turnId);
   if (hub) return hub;
   const separator = turnId.lastIndexOf(":");
   const index = turnId.slice(separator + 1);
   if (!/^(0|[1-9]\d*)$/.test(index) || !Number.isSafeInteger(Number(index))) return undefined;
   const entry = native.get(turnId.slice(0, separator + 1));
   return entry ? { task: entry.task } : undefined;
  },
  bindSession(next: string) { session = next; },
  hubContext(): TaskContext | undefined {
   const task = options.task(), plan = options.plan?.();
   if (!task?.trim()) return undefined;
   const digest = (text: string) => createHash("sha256").update(text).digest("hex");
   return { task: { path: "hub-task", revision: digest(task), hash: digest(task) }, ...(plan ? { plan: { path: "hub-plan", revision: digest(plan), hash: digest(plan) } } : {}), rules, exceptions: [] };
  },
  get capture() { return capture; },
 };
}
/** Compose from the already-selected session service and approved roots; no config or provider activation. */
export function composeHubProactive(input: {
 config: LocalProactiveConfig; root: string; sessionDir: string; rulesRoots: readonly string[];
 service?: System1Service; capture: ReturnType<typeof createHubCapture>; onChange?: () => void;
}) {
 const catalog = input.rulesRoots.length ? discoverRules(input.root, input.rulesRoots) : null;
 const sections = catalog?.sections ?? [];
 const refs = catalog?.files ?? [];
 // Selection stays local and is keyed to the captured task revision and authored paths.
 const selectionFor = (job: ReviewJob) => catalog ? selectRules({ catalog, config: input.config,
  taskRevision: job.snapshot.context.task.revision, changedPaths: job.snapshot.units.map(u => u.path), contentHints: [] }) : null;
 const directory = join(input.sessionDir, "artifacts");
 // Directory belongs to the parent session; findings/activity use restrictive files underneath.
 mkdirSync(directory, { recursive: true, mode: 0o700 });
 const evaluate = input.config.remoteContext === "selected-excerpts" && input.service ? Object.assign(async (job: ReviewJob) => {
  const content = input.capture.contentFor(job.snapshot.turnId);
  const selection = selectionFor(job);
  const selected = selection ? await selection : { selected: [], coverage: [], gaps: ["unconfigured_rules"], status: "partial" as const, cacheKey: "" };
  return createProactiveEvaluator({ config: input.config, service: input.service!, selection: selected,
   taskText: content?.task, planText: content?.plan, catalogSections: sections })(job);
 }, { budgeted: true as const }) : undefined;
 const feedback = createProactiveFeedback(input.root, join(directory, "proactive-inbox"), input.config.mode);
 const runtime = createProactiveRuntime({ config: input.config, localSections: sections, evaluate, feedback,
  findingsDirectory: join(directory, "proactive-findings"), activityDirectory: join(directory, "proactive-activity"), onChange: input.onChange });
 input.capture.initialize(input.config, runtime, refs);
 input.capture.bindSession(input.sessionDir);
 return runtime;
}
/** Parent-owned directory only. This validates correlation and bytes, not hostile-child attestation. */
export function ingestObserverManifests(assignment: ObserverAssignment, submit: (owner: string, attempt: string, snapshot: TurnSnapshot, index: number) => boolean): number {
 if (assignment.config.mode === "off") return 0;
 const root = resolve(assignment.root), dir = resolve(assignment.directory);
 // Compare paths within one namespace. macOS /var is an alias for /private/var;
 // realpath(dir) !== dir does not mean the attempt itself is a symlink.
 try {
  const below = relative(root, dir);
  if (!below || below === ".." || below.startsWith(`..${sep}`) || isAbsolute(below)) return 0;
  let cursor = root;
  for (const part of below.split(sep)) {
   cursor = join(cursor, part);
   if (!lstatSync(cursor).isDirectory()) return 0;
  }
  if (!realpathSync(dir).startsWith(realpathSync(root) + sep)) return 0;
 } catch { return 0; }
 let accepted = 0;
 let names: string[];
 try { names = readdirSync(dir).filter(name => /^turn-(0|[1-9]\d*)\.json$/.test(name)).slice(0, 256); } catch { return 0; }
 for (const name of names) {
  try {
   const index = Number(name.slice(5, -5));
   if (!Number.isSafeInteger(index)) continue;
   const file = join(dir, name);
   const manifestInfo = lstatSync(file);
   if (!manifestInfo.isFile() || manifestInfo.size > 2048) continue;
   const manifest = JSON.parse(readFileSync(file, "utf8")) as ObserverManifest;
   if (manifest.producer !== "agent-fleet.proactive-observer/v1" || manifest.session !== assignment.session || manifest.owner !== assignment.owner || manifest.attempt !== assignment.attempt || manifest.turnIndex !== index || manifest.turnId !== `${assignment.session}:${assignment.owner}:${assignment.attempt}:${index}` || !["captured", "incomplete", "not_checked"].includes(manifest.status)) continue;
   const ref = manifest.snapshot;
   if (!ref || ref.path !== `snapshot-${index}.json` || basename(ref.path) !== ref.path || !hex(ref.hash) || !hex(ref.snapshotId) || !Number.isSafeInteger(ref.bytes) || ref.bytes < 1 || ref.bytes > PROACTIVE_LIMITS.maxRetainedBytes + 65536) continue;
   const source = join(dir, ref.path);
   const sourceInfo = lstatSync(source);
   if (!sourceInfo.isFile() || sourceInfo.size !== ref.bytes) continue;
   const data = readFileSync(source);
   if (sha(data) !== ref.hash) continue;
   const snapshot = JSON.parse(data.toString("utf8")) as TurnSnapshot;
   if (snapshot.turnId !== manifest.turnId || snapshot.snapshotId !== ref.snapshotId || !hex(snapshot.snapshotId) || !Array.isArray(snapshot.units) || snapshot.units.length > PROACTIVE_LIMITS.maxUnits || !snapshot.coverage || snapshot.coverage.retainedBytes > PROACTIVE_LIMITS.maxRetainedBytes) continue;
   // Child-owned snapshot cannot revise parent task, plan, or the catalog snapshot.
   if (JSON.stringify(snapshot.context) !== JSON.stringify(assignment.context) || snapshot.planStatus !== (assignment.context.plan ? "bound" : "task_only")) continue;
   if (submit(assignment.owner, assignment.attempt, snapshot, index)) accepted++;
  } catch { /* malformed or changing child data is unavailable, not evidence */ }
 }
 return accepted;
}
