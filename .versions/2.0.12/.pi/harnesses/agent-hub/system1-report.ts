import { join } from "node:path";
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
