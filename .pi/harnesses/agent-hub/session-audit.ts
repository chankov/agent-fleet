import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { redactSecrets } from "../lib/fleet-transcript-store.ts";
import { RECOVERY_CATEGORIES, type RecoveryCategory } from "./recovery-contract.ts";

const RESULT_SCHEMA = "agent-fleet.runtime-result/v1";
const PROTOCOL_SCHEMA = "agent-fleet.tool-protocol-diagnostic/v1";
const AUDIT_STATUSES = new Set(["accepted", "not_accepted", "authorized", "authorized_once", "budget_authorized", "retry_authorized_once", "passed", "failed", "missing", "stale", "unsupported", "busy", "invalid_input", "resource_exhausted", "operator_cancelled", "verification_failed", "tool_protocol_error", "unknown_tool", "indeterminate", "completed_unverified", "unavailable"]);
type Availability = "available" | "unavailable";
type AuditKind = "refusal" | "verification" | "tool_protocol" | "budget_permission" | "retry_permission" | "human_intervention" | "process_obligation";

export interface SessionAuditEvent {
	kind: AuditKind;
	rootSessionId: string | null;
	childDispatchId: string | null;
	childSessionId: string | null;
	snapshotId: string | null;
	repeatCount: number;
	category?: RecoveryCategory;
	status: string;
	taskId?: string | null;
	requestId?: string | null;
	operation?: string | null;
	evidence: Availability;
	risk?: "unknown" | "low" | "high";
	scope?: "unknown" | "read-only" | "small" | "wide";
	budgetTier?: string | null;
	obligations?: Record<string, "satisfied" | "open" | "unsupported">;
	appliedRuleIds?: string[];
	currentStage?: string;
	admissibleNextAction?: string;
	auditScope?: string[];
	explanation?: string;
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

/** Build an allowlisted audit from runtime-owned records. Prompt, output, payload, paths and environment values are never copied. */
export function buildSessionAudit(input: { entries: readonly unknown[]; sessionDir: string }): SessionAuditSummary {
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

	for (const entry of input.entries) {
		const record = entryData(entry), snapshotId = record.type === "compaction" || record.type === "session_compact" ? record.id : null;
		if (snapshotId) { snapshots.add(snapshotId); continue; }
		if (record.type === "agent-hub-process-state") {
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
	}

	const deduped = new Map<string, SessionAuditEvent>();
	for (const event of rawEvents) {
		const key = JSON.stringify([event.kind, event.rootSessionId, event.childDispatchId, event.childSessionId, event.snapshotId, event.category ?? null, event.status, event.taskId ?? null, event.requestId ?? null, event.operation ?? null, event.risk ?? null, event.scope ?? null, event.budgetTier ?? null, event.obligations ?? null, event.appliedRuleIds ?? null, event.currentStage ?? null, event.admissibleNextAction ?? null, event.auditScope ?? null]);
		const prior = deduped.get(key);
		if (prior) prior.repeatCount++;
		else deduped.set(key, { ...event, repeatCount: 1 });
	}
	return {
		schema: "agent-fleet.session-audit/v1", readOnly: true,
		identity: { rootSessionId, children: [...children].map(([dispatchId, sessionId]) => ({ dispatchId, sessionId })), snapshots: [...snapshots].map(snapshotId => ({ snapshotId })) },
		events: [...deduped.values()], unavailable: [...unavailable].sort(),
	};
}

export function formatSessionAudit(summary: SessionAuditSummary): string { return JSON.stringify(summary, null, 2); }

export async function showSessionAudit(ctx: ExtensionContext, sessionDir: string): Promise<void> {
	ctx.ui.notify(formatSessionAudit(buildSessionAudit({ entries: ctx.sessionManager.getEntries(), sessionDir })), "info");
}
