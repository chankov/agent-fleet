import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { redactSecrets } from "../lib/fleet-transcript-store.ts";
import { RECOVERY_CATEGORIES, type RecoveryCategory } from "./recovery-contract.ts";
import { readWatchdogEvents, buildProactiveReport, readProactiveReport, readTaskTriageReport, buildTaskTriageReport, type ProactiveReportInput } from "./system1-report.ts";
import { projectTaskTriage, type TaskTriageProjectionInput, type TaskTriageSessionView } from "../lib/fleet-read-model.ts";
import { projectWatchdogReadback, type TaskTriageActivity } from "./system1-activity.ts";
export type TaskTriageAuditInput = Omit<TaskTriageProjectionInput, "process"> & { activity?: ReturnType<TaskTriageActivity["live"]> };
import { createNoProgressGuard, projectRecoveryRows } from './no-progress.ts';
import { createHash } from "node:crypto";
import { taskTriageActionAuditRecord, type TaskTriageActionAuditRecord } from "./task-triage-authorization.ts";

const RESULT_SCHEMA = "agent-fleet.runtime-result/v1";
const PROTOCOL_SCHEMA = "agent-fleet.tool-protocol-diagnostic/v1";
const AUDIT_STATUSES = new Set(["accepted", "not_accepted", "authorized", "authorized_once", "budget_authorized", "retry_authorized_once", "passed", "failed", "missing", "stale", "unsupported", "busy", "invalid_input", "resource_exhausted", "operator_cancelled", "verification_failed", "tool_protocol_error", "unknown_tool", "indeterminate", "completed_unverified", "unavailable", "cleared", "open", "abandoned", "settled"]);
type Availability = "available" | "unavailable";
type AuditKind = "refusal" | "verification" | "tool_protocol" | "budget_permission" | "retry_permission" | "human_intervention" | "process_obligation" | "watchdog" | "recovery";

export interface SessionAuditEvent {
	kind: AuditKind;
	rootSessionId: string | null;
	childDispatchId: string | null;
	childSessionId: string | null;
	snapshotId: string | null;
	repeatCount: number;
	category?: RecoveryCategory;
    operationId?: string | null;
    attemptId?: string | null;
    technicalBlock?: 'open' | 'cleared';
    openRequirements?: string[];
	status: string;
	taskId?: string | null;
	requestId?: string | null;
	operation?: string | null;
	evidence: Availability;
	risk?: "unknown" | "low" | "high";
	scope?: "unknown" | "read-only" | "small" | "wide";
	budgetTier?: string | null;
	obligations?: Record<string, "satisfied" | "open" | "unsupported" | "waived">;
	processAdditions?: TaskTriageSessionView["process"]["additions"];
	appliedRuleIds?: string[];
	currentStage?: string;
	admissibleNextAction?: string;
	auditScope?: string[];
	explanation?: string;
	watchdog?: { evaluation: string; llm: string; llmStatus: string; providerStatus: string; reason: string; source: string; applied: string; outcome: string };
}

export interface SessionAuditSummary {
	schema: "agent-fleet.session-audit/v1";
	readOnly: true;
	identity: {
		rootSessionId: string | null;
		children: Array<{ dispatchId: string; sessionId: string | null }>;
		snapshots: Array<{ snapshotId: string }>;
	};
	events: SessionAuditEvent[];
	proactive: ReturnType<typeof buildProactiveReport> | ReturnType<typeof readProactiveReport>;
	taskTriage: TaskTriageSessionView & { metrics: ReturnType<typeof readTaskTriageReport>; actions: ReturnType<typeof projectTaskTriageActions> };
	unavailable: string[];
}

const text = (value: unknown, max = 256): string | null => typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
const runtimeId = (value: unknown): string | null => { const normalized = text(value); return normalized && redactSecrets(normalized) === normalized && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(normalized) ? normalized : null; };
const status = (value: unknown): string => { const normalized = text(value, 64); return normalized && AUDIT_STATUSES.has(normalized) ? normalized : "unavailable"; };
const operation = (value: unknown): string | null => { const normalized = text(value, 16); return normalized && ["dispatch", "research", "retry"].includes(normalized) ? normalized : null; };
const object = (value: unknown): Record<string, any> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : null;
function readJson(path: string): Record<string, any> | null { try { return object(JSON.parse(readFileSync(path, "utf8"))); } catch { return null; } }
function recovery(value: unknown): RecoveryCategory | undefined { return RECOVERY_CATEGORIES.includes(value as RecoveryCategory) ? value as RecoveryCategory : undefined; }
function entryData(entry: unknown): { type: string | null; id: string | null; data: Record<string, any> | null; details: Record<string, any> | null } {
	const row = object(entry), message = object(row?.message);
	return {
		type: text(row?.customType) ?? text(row?.type),
		id: runtimeId(row?.id) ?? runtimeId(message?.id) ?? runtimeId(message?.toolCallId),
		data: object(row?.data),
		details: object(message?.details) ?? object(row?.details),
	};
}
function runtimeResult(details: Record<string, any> | null): Record<string, any> | null {
	const value = object(details?.runtimeResult) ?? (details?.schema === RESULT_SCHEMA ? details : null);
	return value?.schema === RESULT_SCHEMA ? value : null;
}

/** Diagnostic joins only: durable consumption is not proof of execution or semantic acceptance. */
export function projectTaskTriageActions(entries: readonly unknown[], binding?: Pick<TaskTriageProjectionInput, "taskId" | "inputRevision">) {
 type ActionRow = { metadata: TaskTriageActionAuditRecord; requested: boolean; denied: boolean; grant: boolean; consumed: boolean;
  consumptionFailed: boolean; execution: "not_recorded" | "tool_result_ok" | "tool_result_error"; ambiguous: boolean; seen: Set<string> };
 const rows = new Map<string, ActionRow>();
 let invalidRecords = 0, overflow = false;
 const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
 const uuid = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
 for (const entry of entries) {
  const record = entryData(entry);
  const observation = record.type === "agent-hub-task-triage-action-observation";
  const grant = record.type === "agent-hub-task-triage-action-grant", consumed = record.type === "agent-hub-task-triage-action-consumed";
  if (observation || grant || consumed) {
   const data = record.data;
   let metadata: TaskTriageActionAuditRecord | null = null;
   if (observation && data?.schema === "task-triage-action-audit/v1" && uuid(data.taskId) && hash(data.inputRevision)
    && hash(data.actionFingerprint) && hash(data.callFingerprint) && ["bash", "edit", "write"].includes(data.operation)
    && ["requested", "not_granted", "consumption_failed"].includes(data.status)
    && Object.keys(data).length === 7) metadata = { schema: data.schema, taskId: data.taskId, inputRevision: data.inputRevision,
     actionFingerprint: data.actionFingerprint, callFingerprint: data.callFingerprint, operation: data.operation, status: data.status };
   else if (!observation && data) metadata = taskTriageActionAuditRecord(data as any, "requested");
   if (!metadata) { invalidRecords++; continue; }
   const key = JSON.stringify([metadata.taskId, metadata.inputRevision, metadata.callFingerprint]);
   let row = rows.get(key);
   if (!row) {
    if (rows.size >= 300) { overflow = true; continue; }
    row = { metadata, requested: false, denied: false, grant: false, consumed: false, consumptionFailed: false, execution: "not_recorded", ambiguous: false, seen: new Set() };
    rows.set(key, row);
   }
   const type = grant ? "grant" : consumed ? "consumed" : metadata.status;
   if (row.seen.has(type) || row.metadata.actionFingerprint !== metadata.actionFingerprint || row.metadata.operation !== metadata.operation) row.ambiguous = true;
   row.seen.add(type);
   if (grant) { if (row.denied || row.consumed) row.ambiguous = true; row.grant = true; }
   else if (consumed) { if (!row.grant || row.denied || row.consumptionFailed) row.ambiguous = true; row.consumed = true; }
   else if (metadata.status === "requested") row.requested = true;
   else if (metadata.status === "not_granted") { if (row.grant || row.consumed) row.ambiguous = true; row.denied = true; }
   else { if (row.consumed || !row.grant) row.ambiguous = true; row.consumptionFailed = true; }
   continue;
  }
  const message = object(object(entry)?.message);
  if (message?.role !== "toolResult" || typeof message.toolCallId !== "string" || !message.toolCallId || message.toolCallId.length > 512) continue;
  const call = createHash("sha256").update(message.toolCallId).digest("hex");
  const matching = [...rows.values()].filter(row => row.metadata.callFingerprint === call && row.metadata.operation === message.toolName && row.consumed);
  if (matching.length > 1) { matching.forEach(row => { row.ambiguous = true; }); continue; }
  const row = matching[0]; if (!row) continue;
  if (row.execution !== "not_recorded") row.ambiguous = true;
  if (typeof message.isError === "boolean") row.execution = message.isError ? "tool_result_error" : "tool_result_ok";
 }
 const records = [...rows.values()].map(row => ({ taskId: row.metadata.taskId, inputRevision: row.metadata.inputRevision,
  actionFingerprint: row.metadata.actionFingerprint, operation: row.metadata.operation,
  binding: !binding?.taskId || !binding?.inputRevision ? "unbound" : row.metadata.taskId === binding.taskId && row.metadata.inputRevision === binding.inputRevision ? "current" : "stale",
  authorization: row.ambiguous ? "ambiguous" : row.grant ? "recorded_grant" : row.denied ? "not_granted" : "not_recorded",
  consumption: row.ambiguous ? "ambiguous" : row.consumptionFailed ? "persistence_failed" : row.consumed ? "recorded_once" : "not_recorded",
  execution: row.ambiguous ? "not_recorded" : row.denied || row.consumptionFailed ? "blocked" : row.execution }));
 return { availability: records.length ? "recorded" : "unavailable", records, invalidRecords, overflow,
  ambiguous: records.filter(row => row.authorization === "ambiguous").length, completeness: "retained session entries only; no replay authority" };
}

/** Build an allowlisted audit from runtime-owned records. Prompt, output, payload, paths and environment values are never copied. */
export function buildSessionAudit(input: { entries: readonly unknown[]; sessionDir: string; proactive?: ProactiveReportInput; taskTriage?: TaskTriageAuditInput }): SessionAuditSummary {
	const unavailable = new Set<string>(), meta = readJson(join(input.sessionDir, "session.json"));
	const rootSessionId = runtimeId(meta?.sessionId) ?? runtimeId(basename(input.sessionDir));
	if (!meta) unavailable.add("root_session_metadata");
	const children = new Map<string, string | null>(), snapshots = new Set<string>();
	const rawEvents: Omit<SessionAuditEvent, "repeatCount">[] = [];
	const add = (event: Omit<SessionAuditEvent, "repeatCount">) => rawEvents.push(event);
	const dispatchRoot = join(input.sessionDir, "dispatches");
	if (existsSync(dispatchRoot)) {
		for (const dispatchPathId of readdirSync(dispatchRoot).sort()) {
			const dispatchId = runtimeId(dispatchPathId);
			if (!dispatchId) { unavailable.add("child_identity"); continue; }
			const result = readJson(join(dispatchRoot, dispatchPathId, "result.json"));
			if (!result) { unavailable.add(`child_result:${dispatchId}`); children.set(dispatchId, null); continue; }
			const childSessionId = text(result.sessionPath) ? runtimeId(basename(String(result.sessionPath)).replace(/\.jsonl?$/i, "")) : null;
			children.set(dispatchId, childSessionId);
			const category = recovery(result.recoveryCategory);
			if (category) add({ kind: "refusal", rootSessionId, childDispatchId: dispatchId, childSessionId, snapshotId: null, category, status: status(result.status), evidence: "available" });
			if (object(result.protocolDiagnostic)?.schema === PROTOCOL_SCHEMA) add({ kind: "tool_protocol", rootSessionId, childDispatchId: dispatchId, childSessionId, snapshotId: null, category: "tool_protocol_error", status: "tool_protocol_error", evidence: "available" });
		}
	} else unavailable.add("child_execution_records");

    // Compaction snapshots contain prior append-only rows; project once from the last snapshot.
    let projected: any[] = [];
    try {
        // The audit must not infer an empty or clean history from an invalid checkpoint.
        createNoProgressGuard().restore(input.entries);
        projected = projectRecoveryRows(input.entries);
    } catch {
        unavailable.add('recovery_history_integrity');
    }
    const attemptDispatch = new Map<string, string>();
    const recoveryDispatch = new Map<string, { operationId: string; attemptId: string }>();
    const attemptCategory = new Map<string, RecoveryCategory>();
    const attemptRequirements = new Map<string, string[]>();
    for (const row of projected) {
        const event = object(row?.event), type = text(event?.type), opId = runtimeId(event?.operationId), attemptId = runtimeId(event?.attemptId);
        if (row?.kind === 'guard' && type === 'evidence') {
            const evidence = object(event?.evidence), id = runtimeId(evidence?.dispatchId);
            if (id && Array.isArray(evidence?.openRequirements)) attemptRequirements.set(id, evidence.openRequirements.map(runtimeId).filter((x: string | null): x is string => !!x).slice(0, 64));
        }
        if (row?.kind !== 'ledger' || !opId || !attemptId) continue;
        const dispatchId = type === 'start' || type === 'dispatch' ? runtimeId(event?.dispatchId) : attemptDispatch.get(attemptId) ?? null;
        if (dispatchId) { attemptDispatch.set(attemptId, dispatchId); recoveryDispatch.set(dispatchId, { operationId: opId, attemptId }); }
        if (type === 'failure') { const category = recovery(event?.category); if (category) attemptCategory.set(attemptId, category); }
        if (!['start','failure','settled','grant','technical','abandon','complete'].includes(type ?? '')) continue;
        const category = attemptCategory.get(attemptId), technicalBlock = type === 'technical' && ['open','cleared'].includes(event?.status) ? event?.status as 'open' | 'cleared' : undefined;
        add({ kind: 'recovery', rootSessionId, childDispatchId: dispatchId, childSessionId: dispatchId ? children.get(dispatchId) ?? null : null, snapshotId: null,
            taskId: runtimeId(event?.taskId), operationId: opId, attemptId, category,
            status: type === 'technical' ? technicalBlock ?? 'unavailable' : type === 'grant' ? 'authorized_once' : type === 'abandon' ? 'abandoned' : type === 'settled' ? 'settled' : type === 'failure' ? 'failed' : 'open',
            technicalBlock, openRequirements: type === 'technical' && dispatchId ? attemptRequirements.get(dispatchId) ?? [] : undefined,
            evidence: type === 'technical' || type === 'settled' ? 'available' : 'available',
            explanation: type === 'grant' ? 'Human-authorized one-use indeterminate retry; partial side effects and duplicate effects were warned; no automatic execution.' : type === 'technical' ? 'Technical assessment only; failed execution and parent acceptance remain independent.' : undefined });
    }
	let latestProcess: unknown;
	for (const entry of input.entries) {
		const record = entryData(entry), snapshotId = record.type === "compaction" || record.type === "session_compact" ? record.id : null;
		if (snapshotId) { snapshots.add(snapshotId); continue; }
		if (record.type === "agent-hub-process-state") {
			latestProcess = record.data;
			if (record.data && Object.hasOwn(record.data, "additions")) {
				const projected = projectTaskTriage({ ...input.taskTriage, process: record.data }).process;
				add({ kind: "process_obligation", rootSessionId, childDispatchId: null, childSessionId: null, snapshotId: null,
					status: projected.completion === "process_complete" ? "accepted" : "not_accepted",
					risk: projected.declaration.risk as SessionAuditEvent["risk"], scope: projected.declaration.scope as SessionAuditEvent["scope"],
					budgetTier: projected.declaration.budgetTier, obligations: projected.obligations ?? undefined, processAdditions: projected.additions,
					currentStage: projected.currentStage, evidence: projected.availability === "available" ? "available" : "unavailable",
					explanation: "Process status only; waivers remain waived and per-effect confirmation is independent of task acceptance." });
				continue;
			}
			const data = record.data, risk = ["unknown", "low", "high"].includes(data?.risk) ? data!.risk as "unknown" | "low" | "high" : "unknown";
			const budgetTier = ["trivial", "small", "feature", "project"].includes(data?.budgetTier) ? data!.budgetTier : null;
			const scope = ["unknown", "read-only", "small", "wide"].includes(data?.scope) ? data!.scope : "unknown";
			const appliedRuleIds = Array.isArray(data?.appliedRuleIds) ? data.appliedRuleIds.filter((v: unknown) => typeof v === "string").slice(0, 8) : [];
			const currentStage = text(data?.currentStage, 64) ?? "unavailable", admissibleNextAction = text(data?.admissibleNextAction, 160) ?? "unavailable";
			const auditScope = Array.isArray(data?.auditScope) ? data.auditScope.filter((v: unknown) => typeof v === "string").slice(0, 64) : [];
			const raw = object(data?.obligations), obligations: Record<string, "satisfied" | "open" | "unsupported"> = {};
			for (const name of ["risk", "acceptance", "review", "plan"]) {
				const item = object(raw?.[name]), value = item?.status;
				obligations[name] = ["satisfied", "open", "unsupported"].includes(value) ? value : "unsupported";
			}
			add({ kind: "process_obligation", rootSessionId, childDispatchId: null, childSessionId: null, snapshotId: null,
				status: Object.values(obligations).some(value => value !== "satisfied") ? "not_accepted" : "accepted", risk, scope, budgetTier,
				obligations, appliedRuleIds, currentStage, admissibleNextAction, auditScope, explanation: `Risk ${risk}; scope ${scope}; budget tier ${budgetTier ?? "unavailable"} limits spend only. Open obligations: ${Object.entries(obligations).filter(([, value]) => value !== "satisfied").map(([name]) => name).join(", ") || "none"}.`, evidence: "available" });
			continue;
		}
		if (record.type === "agent-hub-budget-continuation") {
			const correlation = object(record.data?.correlation), evidence = correlation ? "available" as const : "unavailable" as const;
			const base = { rootSessionId, childDispatchId: null, childSessionId: null, snapshotId: null, taskId: runtimeId(correlation?.task_id), requestId: runtimeId(correlation?.request_id), operation: operation(correlation?.operation), evidence };
			add({ ...base, kind: "budget_permission", status: "authorized" });
			add({ ...base, kind: "human_intervention", status: "budget_authorized" });
			continue;
		}
		if (record.type === "agent-hub-retry-authorized") {
			const correlation = object(record.data?.correlation), dispatchId = runtimeId(record.data?.dispatchId), evidence = correlation ? "available" as const : "unavailable" as const;
			const base = { rootSessionId, childDispatchId: dispatchId, childSessionId: dispatchId ? children.get(dispatchId) ?? null : null, snapshotId: null, taskId: runtimeId(correlation?.taskId), requestId: runtimeId(correlation?.requestId), operation: operation(correlation?.operation), evidence };
			add({ ...base, kind: "retry_permission", status: "authorized_once" });
			add({ ...base, kind: "human_intervention", status: "retry_authorized_once" });
			continue;
		}
		const details = record.details, result = runtimeResult(details);
		if (!result) {
			const category = recovery(details?.recoveryCategory);
			if (category) {
				const dispatchId = runtimeId(details?.dispatchId) ?? runtimeId(details?.previousDispatchId);
				add({ kind: category === "tool_protocol_error" ? "tool_protocol" : "refusal", rootSessionId, childDispatchId: dispatchId, childSessionId: dispatchId ? children.get(dispatchId) ?? null : null, snapshotId: null, category, status: status(details?.status ?? category), evidence: "available" });
			}
			continue;
		}
		const execution = object(result.execution), verification = object(result.verification), acceptance = object(result.acceptance), task = object(result.task);
		const dispatchId = runtimeId(execution?.dispatchId), childSessionId = dispatchId ? children.get(dispatchId) ?? null : null;
		if (verification?.status !== "passed") add({ kind: "verification", rootSessionId, childDispatchId: dispatchId, childSessionId, snapshotId: null, status: status(verification?.status), taskId: runtimeId(task?.id), evidence: verification?.status ? "available" : "unavailable" });
		const category = recovery(details?.recoveryCategory);
		if (category) add({ kind: category === "tool_protocol_error" ? "tool_protocol" : "refusal", rootSessionId, childDispatchId: dispatchId, childSessionId, snapshotId: null, category, status: status(details?.status ?? acceptance?.status), taskId: runtimeId(task?.id), evidence: "available" });
        const linked = dispatchId ? recoveryDispatch.get(dispatchId) : undefined;
        if (linked && acceptance?.status === 'accepted' && result.execution?.status === 'completed' && verification?.status === 'passed')
            add({ kind:'recovery', rootSessionId, childDispatchId:dispatchId, childSessionId, snapshotId:null, taskId:runtimeId(task?.id), operationId:linked.operationId, attemptId:linked.attemptId, status:'accepted', evidence:'available' });
	}

	// Trace-only, read-only projection: unknown/interrupted is not guessed into a verdict.
	const watchdogTrace = readWatchdogEvents(input.sessionDir);
	if (watchdogTrace.integrity.partialTail || watchdogTrace.integrity.invalidRecords || watchdogTrace.integrity.readError) unavailable.add("watchdog_trace_integrity");
	for (const check of projectWatchdogReadback(watchdogTrace.events)) {
		const dispatchId = runtimeId(check.dispatchId), attemptId = runtimeId(check.attemptId), checkId = runtimeId(check.checkId);
		if (!dispatchId || !attemptId || !checkId) continue;
		const allowed = new Set(["continue", "advisory", "drift_stop", "judge_unavailable", "discard"]);
		add({ kind: "watchdog", rootSessionId, childDispatchId: dispatchId, childSessionId: children.get(dispatchId) ?? null,
			snapshotId: runtimeId(check.snapshotId), requestId: checkId, taskId: attemptId,
			status: allowed.has(check.outcome) ? check.outcome : check.evaluation === "interrupted" || check.llm === "interrupted" ? "indeterminate" : "unavailable",
			watchdog: {
				evaluation: ["finished", "interrupted", "unknown"].includes(check.evaluation) ? check.evaluation : "unknown",
				llm: ["finished", "interrupted", "none"].includes(check.llm) ? check.llm : "unknown",
				llmStatus: ["verdict", "unavailable", "cancelled"].includes(check.llmStatus ?? "") ? check.llmStatus! : "unknown",
				providerStatus: ["ok", "skipped", "unavailable", "unsupported", "cancelled"].includes(check.status) ? check.status : "unknown",
				reason: ["timeout", "network", "auth", "rate_limit", "overloaded", "invalid_config", "invalid_request", "missing_key", "consumer_off", "state_too_large", "disposed", "interrupted", "unknown"].includes(check.reason) ? check.reason : "unknown",
				source: ["llm", "none", "system1"].includes(check.source) ? check.source : "unknown",
				applied: check.applied === "yes" || check.applied === "no" ? check.applied : "unknown",
				outcome: allowed.has(check.outcome) ? check.outcome : "unknown",
			},
			evidence: check.evaluation === "interrupted" || check.llm === "interrupted" ? "unavailable" : "available" });
	}
	const diskMetrics = readTaskTriageReport(input.sessionDir);
	// Disk includes prior session instances. Use bounded live fallback only if this
	// observer lost writes; report the source rather than duplicating its events.
	const liveActivity = input.taskTriage?.activity;
	const metrics = liveActivity?.degraded ? { ...buildTaskTriageReport(liveActivity.events, liveActivity, diskMetrics.observability),
		availability: "session-memory", scope: "bounded-live-observer; durable trace degraded" } : diskMetrics;
	const taskTriage = { ...projectTaskTriage({ ...input.taskTriage, process: latestProcess }), metrics, actions: projectTaskTriageActions(input.entries, input.taskTriage) };
	if (taskTriage.actions.invalidRecords || taskTriage.actions.ambiguous || taskTriage.actions.overflow) unavailable.add("task_triage_action_integrity");
	if (latestProcess !== undefined && taskTriage.process.availability === "unavailable") unavailable.add("task_triage_process_integrity");
	if (taskTriage.metrics.observability.degraded) unavailable.add("task_triage_trace_integrity");
	const deduped = new Map<string, SessionAuditEvent>();
	for (const event of rawEvents) {
		const key = JSON.stringify([event.kind, event.rootSessionId, event.childDispatchId, event.childSessionId, event.snapshotId, event.category ?? null, event.status, event.taskId ?? null, event.requestId ?? null, event.operation ?? null, event.risk ?? null, event.scope ?? null, event.budgetTier ?? null, event.obligations ?? null, event.processAdditions ?? null, event.appliedRuleIds ?? null, event.currentStage ?? null, event.admissibleNextAction ?? null, event.auditScope ?? null, event.watchdog ?? null, event.operationId ?? null, event.attemptId ?? null, event.technicalBlock ?? null, event.openRequirements ?? null]);
		const prior = deduped.get(key);
		if (prior) prior.repeatCount++;
		else deduped.set(key, { ...event, repeatCount: 1 });
	}
	return {
		schema: "agent-fleet.session-audit/v1", readOnly: true,
		identity: { rootSessionId, children: [...children].map(([dispatchId, sessionId]) => ({ dispatchId, sessionId })), snapshots: [...snapshots].map(snapshotId => ({ snapshotId })) },
		events: [...deduped.values()], proactive: input.proactive ? buildProactiveReport(input.proactive) : readProactiveReport(input.sessionDir), taskTriage, unavailable: [...unavailable].sort(),
	};
}

export function formatSessionAudit(summary: SessionAuditSummary): string { return JSON.stringify(summary, null, 2); }

export async function showSessionAudit(ctx: ExtensionContext, sessionDir: string, proactive?: ProactiveReportInput, taskTriage?: TaskTriageAuditInput): Promise<void> {
	ctx.ui.notify(formatSessionAudit(buildSessionAudit({ entries: ctx.sessionManager.getEntries(), sessionDir, proactive, taskTriage })), "info");
}
