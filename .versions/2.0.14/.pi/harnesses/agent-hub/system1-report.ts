import { isAbsolute, join, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { PROACTIVE_LIMITS } from "./proactive-config.ts";
import { validProactiveLabelKey } from "../lib/fleet-read-model.ts";
import type { ReviewRecord } from "./proactive-runtime.ts";
import type { FindingEntry, FindingReview } from "./proactive-findings.ts";
import { readProactiveTrace, type ProactiveTraceRecord } from "./system1-activity.ts";
import { projectWatchdogReadback, readWatchdogTrace, type WatchdogActivity, type WatchdogTraceRecord } from "./system1-activity.ts";
import type { WatchdogSystem1Session } from "./system1-runtime.ts";

export interface WatchdogTraceIntegrity { invalidRecords: number; partialTail: boolean; readError: boolean }
/** Read the trace, not the provider or worker accounting. Corruption remains visible as metadata. */
export function readWatchdogEvents(sessionDir: string): { events: WatchdogTraceRecord[]; integrity: WatchdogTraceIntegrity } {
	const path = join(sessionDir, "artifacts", "watchdog", "events.jsonl");
	const events: WatchdogTraceRecord[] = [];
	const integrity: WatchdogTraceIntegrity = { invalidRecords: 0, partialTail: false, readError: false };
	let offset = 0;
	for (;;) {
		const page = readWatchdogTrace(path, { after: offset, limit: 100 });
		events.push(...page.events);
		integrity.invalidRecords += page.invalidRecords;
		integrity.partialTail ||= page.partialTail;
		integrity.readError ||= page.readError;
		if (page.nextOffset === offset) break;
		offset = page.nextOffset;
	}
	return { events, integrity };
}
export function watchdogEvents(sessionDir: string): WatchdogTraceRecord[] { return readWatchdogEvents(sessionDir).events; }

const ids = (e: WatchdogTraceRecord) => [e.sessionId, e.dispatchId, e.attemptId, e.checkId, e.snapshotId].join("\u0000");
const span = (e: WatchdogTraceRecord) => `${ids(e)}\u0000${e.llmAttemptId ?? "unknown"}`;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const countBy = (values: readonly string[]) => values.reduce<Record<string, number>>((counts, value) => {
	counts[value] = (counts[value] ?? 0) + 1;
	return counts;
}, {});

export function buildWatchdogReport(events: readonly WatchdogTraceRecord[], live?: ReturnType<WatchdogActivity["live"]> | null, integrity?: WatchdogTraceIntegrity) {
	const valid = events.filter(e => e.schema === "watchdog-trace/v1" && e.consumer === "watchdog"
		&& [e.sessionId, e.dispatchId, e.attemptId, e.checkId, e.snapshotId].every(v => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(v)));
	// A duplicate lifecycle event makes the trace ambiguous. Never hide it behind Map's
	// last-write-wins projection when deciding whether pilot evidence is trustworthy.
	const seenEvents = new Set<string>();
	let duplicateEvents = 0;
	for (const event of valid) {
		const key = `${event.type}\u0000${event.type.startsWith("llm_") ? span(event) : ids(event)}`;
		if (seenEvents.has(key)) duplicateEvents++;
		else seenEvents.add(key);
	}
	const starts = new Set(valid.filter(e => e.type === "evaluation_started").map(ids));
	const finishes = new Map(valid.filter(e => e.type === "evaluation_finished").map(e => [ids(e), e]));
	const llmStarts = new Set(valid.filter(e => e.type === "llm_started").map(span));
	const llmFinishes = new Map(valid.filter(e => e.type === "llm_finished").map(e => [span(e), e]));
	const decisions = new Map(valid.filter(e => e.type === "decision").map(e => [ids(e), e]));
	const checks = new Set([...starts, ...llmStarts].map(s => s.split("\u0000").slice(0, 5).join("\u0000")));
	const latencies = [...finishes.values()].map(e => e.elapsedMs).filter(finite).sort((a, b) => a - b);
	const percentile = (p: number) => latencies.length ? latencies[Math.ceil(p * latencies.length) - 1] : null;
	const usage = [...finishes.values()].map(e => e.usage).filter((u): u is { inputTokens: number; outputTokens: number } => !!u && finite(u.inputTokens) && finite(u.outputTokens));
	const outcome = (value: unknown): string => ["continue", "advisory", "drift_stop", "judge_unavailable", "discard"].includes(String(value)) ? String(value) : "unknown";
	const status = (value: unknown): string => ["ok", "skipped", "unavailable", "unsupported", "cancelled"].includes(String(value)) ? String(value) : "unknown";
	const projection = projectWatchdogReadback(valid);
	return {
		schema: "watchdog-report/v1" as const,
		readOnly: true as const,
		checks: checks.size,
		evaluations: { started: starts.size, finished: finishes.size, incomplete: [...starts].filter(k => !finishes.has(k)).length, byStatus: countBy([...finishes.values()].map(e => status(e.status))) },
		llm: { started: llmStarts.size, finished: llmFinishes.size, incomplete: [...llmStarts].filter(k => !llmFinishes.has(k)).length,
			parallel: [...llmStarts].filter(k => starts.has(k.split("\u0000").slice(0, 5).join("\u0000"))).length,
			fallback: [...llmStarts].filter(k => !starts.has(k.split("\u0000").slice(0, 5).join("\u0000"))).length },
		avoidedLlmChecks: [...decisions.entries()].filter(([k, e]) => e.source === "system1" && outcome(e.outcome) === "continue" && ![...llmStarts].some(l => l.startsWith(`${k}\u0000`))).length,
		decisions: countBy([...decisions.values()].map(e => `${e.source === "llm" || e.source === "system1" ? e.source : "none"}:${outcome(e.outcome)}:${e.applied === "yes" || e.applied === "no" ? e.applied : "unknown"}`)),
		latencyMs: { p50: percentile(0.5), p95: percentile(0.95), known: latencies.length },
		usage: { known: usage.length, unknown: finishes.size - usage.length, inputTokens: usage.reduce((n, u) => n + u.inputTokens, 0), outputTokens: usage.reduce((n, u) => n + u.outputTokens, 0) },
		observability: { degraded: (live?.degraded ?? false) || duplicateEvents > 0 || (integrity?.invalidRecords ?? 0) > 0 || (integrity?.partialTail ?? false) || (integrity?.readError ?? false) || valid.length !== events.length,
			duplicateEvents, invalidRecords: (integrity?.invalidRecords ?? 0) + events.length - valid.length, partialTail: integrity?.partialTail ?? false, readError: integrity?.readError ?? false,
			active: live?.active.length ?? 0, incompleteChecks: projection.filter(c => c.evaluation === "interrupted" || c.llm === "interrupted").length },
	};
}

export function formatWatchdogStatus(session: WatchdogSystem1Session | null, activity: WatchdogActivity | null) {
	const live = activity?.live();
	const latest = live?.completed.at(-1);
	return [
		`System 1 · watchdog · configured ${session?.configuredMode ?? "off"} · effective ${session?.effectiveMode ?? "off"}`,
		`Readiness: ${session?.readiness.status ?? "unavailable"}${session?.readiness.status === "ready" ? " (API access not verified)" : ""} · armed ${session?.hubArmed === true ? "yes" : "no"}`,
		`Active: ${session?.blockLabel ?? "not enabled"} · checks ${live?.active.length ?? 0} · trace ${live?.degraded ? "degraded" : "available"}`,
		`Last: ${latest ? `${latest.checkId} · ${latest.status} · ${latest.reason} · LLM ${latest.llm} · ${latest.outcome}` : "unknown"}`,
	].join("\n");
}

/** Explicit human labels for a reviewed, revision-bound candidate set. No label is inferred. */
export interface ProactiveHumanLabel {
 snapshotId: string; ruleId: string; ruleHash: string; subject: string;
 expected: "violation" | "clean" | "unknown";
}
/** Explicit local JSON file only. Caller supplies a path inside a session artifact directory.
 * Invalid files fail closed; no auto-discovery and no file contents in errors/reports. */
export function loadProactiveLabels(sessionDir: string, file: string): readonly ProactiveHumanLabel[] {
 if (!isAbsolute(file)) throw new Error("Unavailable labels file");
 const root = resolve(sessionDir, "artifacts"), target = resolve(file);
 try {
  if (!target.startsWith(root + sep) || !target.endsWith(".json") || target.slice(root.length+1).split(sep).some(s => /^(?:\.|\.env|credentials?|secrets?|private)/i.test(s))) throw new Error();
  const rootInfo = lstatSync(root), targetRelative = target.slice(root.length + 1).split(sep);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error();
  let cursor = root;
  for (const part of targetRelative) {
   cursor = join(cursor, part);
   if (lstatSync(cursor).isSymbolicLink()) throw new Error();
  }
  const canonicalRoot = realpathSync(root), canonicalTarget = realpathSync(target);
  if (!canonicalTarget.startsWith(canonicalRoot + sep) || !lstatSync(target).isFile() || lstatSync(target).size > PROACTIVE_LIMITS.maxFileBytes) throw new Error();
 } catch { throw new Error("Unavailable labels file"); }
 let parsed: unknown;
 try { parsed = JSON.parse(readFileSync(target, "utf8")); } catch { throw new Error("Invalid labels file"); }
 if (!Array.isArray(parsed) || parsed.length > PROACTIVE_LIMITS.maxQuestions * PROACTIVE_LIMITS.maxUnits || parsed.some(label => !validLabel(label))) throw new Error("Invalid labels file");
 return parsed;
}
const hashId = (v: unknown) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const validLabel = (v: unknown): v is ProactiveHumanLabel => !!v && typeof v === "object" && !Array.isArray(v) &&
 Object.keys(v).sort().join(",") === "expected,ruleHash,ruleId,snapshotId,subject" &&
 validProactiveLabelKey(v) &&
 ["violation","clean","unknown"].includes((v as ProactiveHumanLabel).expected);
/** Command-only opt-in: bad syntax or unreadable/unmatched files never become measured zeroes. */
export function commandProactiveLabels(sessionDir: string, args: string): readonly ProactiveHumanLabel[] | undefined {
 const value = /^--labels[ \t]+(.+)$/.exec(args.trim())?.[1];
 if (!value || !isAbsolute(value)) return undefined;
 try { return loadProactiveLabels(sessionDir, value); } catch { return undefined; }
}
export interface ProactiveReportInput {
 records: readonly ReviewRecord[];
 history: readonly FindingReview[];
 current: readonly FindingEntry[];
 activity: readonly ProactiveTraceRecord[];
 labels?: readonly ProactiveHumanLabel[];
 /** Only parent-observed deliveries; child inbox publication is not a delivery receipt. */
 feedback?: { hubDelivered: number; nativeDelivered: number | null };
}
export function compareProactiveLabels(labels?: readonly ProactiveHumanLabel[], records: readonly ReviewRecord[] = [], history: readonly FindingReview[] = []) {
 if (!labels) return { availability:"unavailable" as const, labelled:null, truePositives:null, falseAlarms:null, misses:null, trueNegatives:null, unchecked:null, unknown:null, invalid:null, conflicts:null, precision:null, recall:null };
 const seen = new Map<string,ProactiveHumanLabel>(); const rejected = new Set<string>(); let truePositives = 0, falseAlarms = 0, misses = 0, trueNegatives = 0, unchecked = 0, unknown = 0, invalid = 0, conflicts = 0;
 const reviews = new Map(history.map(h => [h.turnId,h]));
 for (const label of labels) {
  if (!validLabel(label)) { invalid++; continue; }
  const key = JSON.stringify([label.snapshotId,label.ruleId,label.ruleHash,label.subject]);
  const prior=seen.get(key);
  if (prior) { if (prior.expected !== label.expected) { conflicts++; rejected.add(key); } else invalid++; continue; } seen.set(key,label);
 }
 for (const [key,label] of seen) {
  if (rejected.has(key)) continue;
  if (label.expected === "unknown") { unknown++; continue; }
  const matching = records.filter(r => r.snapshotId === label.snapshotId);
  const observed = matching.some(r => reviews.get(r.turnId)?.findings.some(f => f.state === "current" && f.snapshotId === label.snapshotId && f.ruleId === label.ruleId && f.ruleHash === label.ruleHash && f.subject === label.subject)) ? "finding" :
   matching.some(r => r.status === "reviewed" && r.assessment?.status === "reviewed" && !r.assessment.gaps.length && r.assessment.checkedUnits?.some(u => u.ruleId === label.ruleId && u.ruleHash === label.ruleHash && u.subject === label.subject && (u.verdict === "no_observed_violation" || u.verdict === "not_applicable"))) ? "clear" : "unchecked";
  if (observed === "unchecked") { unchecked++; continue; }
  if (label.expected === "violation") { if (observed === "finding") truePositives++; else misses++; }
  else if (observed === "finding") falseAlarms++; else trueNegatives++;
 }
 return { availability:"available" as const, source:"explicit-human-labels" as const, labelled:seen.size-rejected.size, truePositives,falseAlarms,misses,trueNegatives,unchecked,unknown,invalid,conflicts,
  precision:truePositives+falseAlarms ? truePositives/(truePositives+falseAlarms) : null,
  recall:truePositives+misses ? truePositives/(truePositives+misses) : null };
}
/** Metadata-only projection: never returns supplied task/rule/source/provider text. */
export function buildProactiveReport(input?: ProactiveReportInput) {
 const records = new Map<string, ReviewRecord>(); let duplicates = 0;
 for (const row of input?.records ?? []) { if (records.has(row.turnId)) { duplicates++; continue; } records.set(row.turnId, row); }
 const history = new Map((input?.history ?? []).map(row => [row.turnId, row]));
 const starts = new Map<string, number>(), ends = new Map<string, number>(), evalStarts = new Set<string>(), evalEnds = new Set<string>(), events = new Set<string>();
 for (const e of input?.activity ?? []) {
  if (e.schema !== "proactive-review-trace/v1" || e.consumer !== "proactive-review" || !/^[a-f0-9]{64}$/.test(e.jobId) || !finite(e.at)) continue;
  const key = JSON.stringify([e.sessionId,e.jobId,e.type,e.evaluationId]);
  if (events.has(key)) { duplicates++; continue; } events.add(key);
  const job = `${e.sessionId}:${e.jobId}`;
  if (e.type === "job_started") starts.set(job,e.at);
  if (e.type === "job_finished") ends.set(job,e.at);
  if (e.evaluationId && e.type === "evaluation_started") evalStarts.add(`${job}:${e.evaluationId}`);
  if (e.evaluationId && e.type === "evaluation_finished") evalEnds.add(`${job}:${e.evaluationId}`);
 }
 const rows = [...records.values()];
 const statuses = new Set(["reviewed","not_checked","superseded","queue_timeout","backlog_full","session_budget","cancelled","unavailable","no_new_evidence","not_instrumented"]);
 const turns = rows.filter(r => r.status !== "not_instrumented");
 const attempts = rows.filter(r => r.status === "not_instrumented").length;
 const reviewed = turns.filter(r => r.status === "reviewed" && r.assessment?.status === "reviewed" && !r.assessment.gaps.length && history.get(r.turnId)?.coverage.status !== "partial").length;
 const partial = turns.filter(r => r.status === "not_checked" || (r.status === "reviewed" && history.get(r.turnId)?.coverage.status === "partial")).length;
 const coverageUnknown = turns.filter(r => r.status === "reviewed" && !((r.assessment?.status === "reviewed" && !r.assessment.gaps.length && history.get(r.turnId)?.coverage.status !== "partial") || history.get(r.turnId)?.coverage.status === "partial")).length;
 const inventoryEligible = turns.filter(r => r.status !== "no_new_evidence");
 const turnsWithoutRuleInventory = inventoryEligible.filter(r => !Array.isArray(r.assessment?.ruleCoverage)).length;
 const active = [...starts.keys()].filter(k => !ends.has(k)).length;
 const latencies = [...ends].flatMap(([id,end]) => { const start=starts.get(id); return start !== undefined && end >= start ? [end-start] : []; }).sort((a,b)=>a-b);
 const percentile=(p:number)=>latencies.length ? latencies[Math.ceil(latencies.length*p)-1] : null;
 const evaluations = rows.flatMap(r => r.assessment?.evaluations ?? []);
 const usage = evaluations.flatMap(e => e.status === "ok" && e.metadata?.usage && finite(e.metadata.usage.inputTokens) && finite(e.metadata.usage.outputTokens) ? [e.metadata.usage] : []);
 const modelLatencies = evaluations.flatMap(e => e.status === "ok" && finite(e.metadata?.latencyMs) ? [e.metadata!.latencyMs] : []).sort((a,b)=>a-b);
 const findings = new Map((input?.current ?? []).map(f => [f.id,f]));
 const gapCount = rows.reduce((n,r)=>n+Math.max(r.assessment?.gaps.length ?? 0, history.get(r.turnId)?.coverage.gaps.length ?? 0),0);
 const uncovered = new Map<string,{ruleId:string;ruleHash:string;status:"not_selected"|"uncertain"|"insufficient";reason:string;count:number}>();
 for (const row of rows) for (const item of row.assessment?.ruleCoverage ?? []) {
  if (!hashId(item.ruleHash) || typeof item.ruleId !== "string" || !["not_selected","uncertain","insufficient"].includes(item.status) || !["budget","provisional_not_applicable","selection","assessment_incomplete","insufficient_evidence","rule_conflict"].includes(item.reason)) continue;
  const key=JSON.stringify([item.ruleId,item.ruleHash,item.status,item.reason]);const prior=uncovered.get(key);
  uncovered.set(key,{ruleId:createHash("sha256").update(item.ruleId).digest("hex"),ruleHash:item.ruleHash,status:item.status,reason:item.reason,count:(prior?.count??0)+1});
 }
 return { schema:"proactive-review-report/v1" as const, consumer:"proactive-review" as const, readOnly:true as const,
  availability: input ? "session-memory" : "unavailable", scope:"retained-session-evidence", completeness:"bounded-history; missing data is not checked",
  turns:{observed:turns.length+active,eligible:turns.filter(r=>r.status!=="no_new_evidence").length+active,reviewed,partial,coverageUnknown:coverageUnknown+active,skipped:turns.filter(r=>r.status!=="reviewed"&&r.status!=="not_checked").length,active,byStatus:countBy(turns.map(r=>statuses.has(r.status)?r.status:"unavailable"))},
  attempts:{notInstrumented:attempts},
  coverage:{gapCount,uncoveredRulesKnown:inventoryEligible.length>0 && turnsWithoutRuleInventory===0 && active===0,turnsWithoutRuleInventory:turnsWithoutRuleInventory+active,unboundInventory:rows.reduce((n,r)=>n+(r.assessment?.gaps.filter(g=>g==="unbound_rule_inventory"||g==="unbound_rules").length??0),0),uncoveredRules:[...uncovered.values()]},
  evaluations:{started:evalStarts.size,finished:evalEnds.size,metadataKnown:evaluations.filter(e=>e.status==="ok"&&e.metadata).length},
  findings:{deterministic:[...findings.values()].filter(f=>f.source==="deterministic").length,system1Suspicions:[...findings.values()].filter(f=>f.source==="system1").length,stale:[...findings.values()].filter(f=>f.state==="stale").length,resolved:[...findings.values()].filter(f=>f.state==="resolved").length,notValidatedBugs:true},
  feedback:{hubDelivered:input?.feedback&&finite(input.feedback.hubDelivered)?input.feedback.hubDelivered:null,nativeDelivered:input?.feedback&&finite(input.feedback.nativeDelivered)?input.feedback.nativeDelivered:null},
  latencyMs:{p50:percentile(.5),p95:percentile(.95),known:latencies.length,modelP50:modelLatencies.length?modelLatencies[Math.ceil(modelLatencies.length*.5)-1]:null,modelP95:modelLatencies.length?modelLatencies[Math.ceil(modelLatencies.length*.95)-1]:null},
  usage:{known:usage.length,unknown:Math.max(evalStarts.size,evaluations.length)-usage.length,inputTokens:usage.reduce((n,u)=>n+u.inputTokens,0),outputTokens:usage.reduce((n,u)=>n+u.outputTokens,0)},
  labels:compareProactiveLabels(input?.labels,rows,input?.history),observability:{duplicateEvents:duplicates,incompleteJobs:active} };
}
/** Disk fallback exposes only trace metrics: missing retained review data stays unavailable. */
export function readProactiveReport(sessionDir:string) {
 const events:ProactiveTraceRecord[]=[]; let offset=0,invalidRecords=0,partialTail=false,readError=false;
 for(let pageCount=0;pageCount<1000;pageCount++) {
  const page=readProactiveTrace(join(sessionDir,"artifacts","proactive-activity","proactive-events.jsonl"),{after:offset,limit:100});
  events.push(...page.events); invalidRecords+=page.invalidRecords;partialTail ||=page.partialTail;readError ||=page.readError;
  if(page.nextOffset===offset)break;offset=page.nextOffset;
 }
 const report=buildProactiveReport({records:[],history:[],current:[],activity:events});
 return {...report,availability:readError?"unavailable":"trace-only",turns:{...report.turns,observed:null,eligible:null,reviewed:null,partial:null,coverageUnknown:null,skipped:null},observability:{...report.observability,invalidRecords,partialTail,readError}};
}
