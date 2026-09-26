import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildWatchdogReport, readWatchdogEvents, type WatchdogTraceIntegrity } from "./system1-report.ts";
import type { WatchdogTraceRecord } from "./system1-activity.ts";
import { WATCHDOG_POLICY_VERSION, type AcceptedWatchdogProfile } from "./drift-system1-policy.ts";

export interface HumanWatchdogLabel {
 sessionId: string; dispatchId: string; attemptId: string; checkId: string; snapshotId: string; llmAttemptId: string;
 partition: "tuning" | "held_out";
 label: "on_track" | "drifting" | "stuck" | "unknown";
 /** Human adjudication at this signal, not dispatch success or LLM agreement. */
 humanConfirmed: true;
}
const checkId = (x: HumanWatchdogLabel | WatchdogTraceRecord) => [x.sessionId, x.dispatchId, x.attemptId, x.checkId, x.snapshotId].join("\u0000");
const id = (x: HumanWatchdogLabel | WatchdogTraceRecord) => `${checkId(x)}\u0000${x.llmAttemptId ?? ""}`;
/** Offline, read-only. A prospective candidate needs explicit profile and replayable safe metadata.
 * No profile is shipped. This report neither approves nor activates a profile. */
export function evaluateWatchdog(events: readonly WatchdogTraceRecord[], labels: readonly HumanWatchdogLabel[], profile: AcceptedWatchdogProfile | null = null, integrity?: WatchdogTraceIntegrity) {
 const report = buildWatchdogReport(events, null, integrity);
 const sessionPartitions = new Map<string, Set<string>>();
 for (const label of labels) {
  const partitions = sessionPartitions.get(label.sessionId) ?? new Set<string>(); partitions.add(label.partition); sessionPartitions.set(label.sessionId, partitions);
 }
 const leakage = [...sessionPartitions].filter(([, partitions]) => partitions.size > 1).map(([sessionId]) => sessionId);
 const potential = events.filter(e => e.schema === "watchdog-trace/v1" && e.type === "evaluation_finished" && e.status === "ok" && e.statusChoice === "on_track" && e.unused !== true);
 const labeledIds = new Set(labels.filter(l => l.humanConfirmed === true && ["held_out", "tuning"].includes(l.partition)).map(id));
 const unlabeledCandidates = new Set(potential.map(id).filter(key => !labeledIds.has(key))).size;
 const duplicateLabels = [...labels.reduce((counts, label) => counts.set(id(label), (counts.get(id(label)) ?? 0) + 1), new Map<string, number>())]
  .filter(([, count]) => count > 1).map(([key]) => key);
 const duplicateTrace = [...events.filter(e => e.schema === "watchdog-trace/v1" && ["evaluation_started", "evaluation_finished", "llm_started", "llm_finished", "decision"].includes(e.type))
  .reduce((counts, e) => { const key = `${e.type}\u0000${id(e)}`; counts.set(key, (counts.get(key) ?? 0) + 1); return counts; }, new Map<string, number>())]
  .filter(([, count]) => count > 1).map(([key]) => key);
 // Runtime retries open a new snapshot. Two LLM IDs on the same snapshot are
 // ambiguous evidence even if a human label names one of them.
 const llmIdsByCheck = new Map<string, Set<string>>();
 for (const event of events.filter(e => e.schema === "watchdog-trace/v1" && ["evaluation_started", "evaluation_finished", "llm_started", "llm_finished"].includes(e.type))) {
  const key = checkId(event);
  const attempts = llmIdsByCheck.get(key) ?? new Set<string>();
  attempts.add(event.llmAttemptId ?? ""); llmIdsByCheck.set(key, attempts);
 }
 const ambiguousLlmChecks = [...llmIdsByCheck.values()].filter(attempts => attempts.size !== 1 || attempts.has("")).length;
 const eligible = (e: WatchdogTraceRecord) => !!profile && profile.policyVersion === WATCHDOG_POLICY_VERSION
  && e.stateVersion === profile.stateVersion // stateVersion is recorded on the start event, see starts below
  && e.questionsVersion === profile.questionsVersion && e.stateComplete === true && e.predicatesProvider === true
  && e.provider === profile.provider && e.statusProvenance === "provider"
  && e.requestedModel === profile.model && e.returnedModel === profile.model && !!e.rule && profile.rules.includes(e.rule)
  && Number.isFinite(profile.minConfidence) && profile.minConfidence >= 0 && profile.minConfidence <= 1
  && Number.isFinite(profile.maxContradiction) && profile.maxContradiction >= 0 && profile.maxContradiction <= 1
  && typeof e.numerical?.status_confidence === "number" && e.numerical.status_confidence >= profile.minConfidence
  && typeof e.numerical.status_on_track === "number" && e.numerical.status_on_track >= profile.minConfidence
  && ["status_drifting", "status_stuck", "status_insufficient_evidence", "repeating", "outside_task", "trail_carries_instructions"].every(k => typeof e.numerical?.[k] === "number" && e.numerical[k] >= 0 && e.numerical[k] <= 1)
  && ["repeating", "outside_task", "trail_carries_instructions"].every(k => e.numerical![k] <= profile.maxContradiction)
  && Math.abs(["status_on_track", "status_drifting", "status_stuck", "status_insufficient_evidence"].reduce((sum, k) => sum + e.numerical![k], 0) - 1) <= 0.02;
 const starts = new Map(events.filter(e => e.schema === "watchdog-trace/v1" && e.type === "evaluation_started").map(e => [id(e), e]));
 const evaluations = new Map(potential.filter(e => eligible({ ...e, stateVersion: starts.get(id(e))?.stateVersion, questionsVersion: starts.get(id(e))?.questionsVersion, rule: starts.get(id(e))?.rule })).map(e => [id(e), e]));
 const decisions = new Map(events.filter(e => e.schema === "watchdog-trace/v1" && e.type === "decision").map(e => [id(e), e]));
 // A retry must not pair to a different snapshot or an orphan LLM finish.
 const llmStarts = new Map(events.filter(e => e.schema === "watchdog-trace/v1" && e.type === "llm_started" && !!e.llmAttemptId).map(e => [id(e), e]));
 const pairs = new Set(events.filter(e => e.schema === "watchdog-trace/v1" && e.type === "llm_finished" && e.status === "verdict" && !!e.llmAttemptId
  && (llmStarts.get(id(e))?.sequence ?? Infinity) < e.sequence).map(id));
 const seen = new Set<string>(), byRule: Record<string, { candidates: number; missed: number }> = {};
 const failedSessions = new Set<string>(), successfulSessions = new Set<string>(), incompleteSessions = new Set<string>();
 let unknown = 0, heldOutCandidates = 0, tuningCandidates = 0, matchedPairs = 0, unpaired = 0;
 for (const label of labels) {
  const key = id(label);
  if (seen.has(key) || label.humanConfirmed !== true || !["held_out", "tuning"].includes(label.partition)) continue;
  seen.add(key);
  const evaluation = evaluations.get(key), decision = decisions.get(key);
  if (!evaluation) continue;
  if (pairs.has(key)) matchedPairs++; else unpaired++;
  if (label.partition === "tuning") { tuningCandidates++; continue; }
  heldOutCandidates++;
  if (label.label === "unknown" || leakage.includes(label.sessionId)) { unknown++; incompleteSessions.add(label.sessionId); continue; }
  const actualRule = starts.get(key)?.rule;
  const rule = typeof actualRule === "string" && /^(loop|scope|failures|toolcap)$/.test(actualRule) ? actualRule : "unknown";
  const counts = byRule[rule] ?? { candidates: 0, missed: 0 }; byRule[rule] = counts;
  counts.candidates++;
  // Candidate is the prospective shortcut, even when shadow LLM disagrees; LLM is not ground truth.
  if (label.label === "drifting" || label.label === "stuck") { counts.missed++; failedSessions.add(label.sessionId); }
  else successfulSessions.add(label.sessionId);
  // Actual avoidance is counted in the trace report, never inferred from a label.
  void decision;
 }
 const sessions = new Set([...successfulSessions].filter(s => !incompleteSessions.has(s) && !leakage.includes(s)).concat([...failedSessions]));
 const n = sessions.size, failures = failedSessions.size;
 const checksByRule: Record<string, number> = {};
 for (const event of starts.values()) {
  const rule = typeof event.rule === "string" && /^(loop|scope|failures|toolcap)$/.test(event.rule) ? event.rule : "unknown";
  checksByRule[rule] = (checksByRule[rule] ?? 0) + 1;
 }
 return {
  schema: "watchdog-evaluation/v1" as const, readOnly: true as const,
  eligibility: !profile || report.observability.degraded || leakage.length || unknown || unlabeledCandidates || duplicateLabels.length || duplicateTrace.length || ambiguousLlmChecks || unpaired || !heldOutCandidates || !n || failures ? "not_enough_evidence" as const : "candidate_for_maintainer_review" as const,
  activation: "closed_requires_G2" as const,
  potentialOnTrack: potential.length, heldOutCandidates, tuningCandidates, unknownLabels: unknown, unlabeledCandidates, duplicateLabels: duplicateLabels.length, duplicateTrace: duplicateTrace.length, ambiguousLlmChecks, leakageSessions: leakage,
  matchedPairs, unpaired, perRule: byRule, checksByRule,
  sessionFailure: { sessions: n, failed: failures, upper95: n ? failures === 0 ? 1 - Math.pow(0.05, 1 / n) : null : null, unit: "independent_session" as const },
  diagnostics: report,
 };
}
export function readHumanWatchdogLabels(sessionDir: string): HumanWatchdogLabel[] {
 try {
  const text = readFileSync(join(sessionDir, "artifacts", "watchdog", "labels.jsonl"), "utf8");
  return text.split("\n").flatMap(line => { try { const value = JSON.parse(line); return value?.humanConfirmed === true && ["tuning", "held_out"].includes(value.partition) && ["on_track", "drifting", "stuck", "unknown"].includes(value.label) && ["sessionId", "dispatchId", "attemptId", "checkId", "snapshotId", "llmAttemptId"].every(k => typeof value[k] === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value[k])) ? [value as HumanWatchdogLabel] : []; } catch { return []; } });
 } catch { return []; }
}
export function evaluateWatchdogSession(sessionDir: string, profile: AcceptedWatchdogProfile | null = null) {
 const trace = readWatchdogEvents(sessionDir);
 return evaluateWatchdog(trace.events, readHumanWatchdogLabels(sessionDir), profile, trace.integrity);
}
