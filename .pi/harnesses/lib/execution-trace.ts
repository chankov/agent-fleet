/** Metadata-only observations. These messages never carry permission or evidence authority. */
export const EXECUTION_TRACE_CHANNEL = "agent-fleet:execution-trace";
export const TRACE_OWNER_ENV = "AGENT_FLEET_TRACE_OWNER";
export type TraceKind = "input" | "turn" | "model" | "tool" | "policy" | "approval" | "queue" | "child";
export type TraceSource = "runtime" | "native" | "process" | "task-triage" | "damage-control" | "damage-guard" | "access-escalation";
export type TraceStatus = "pending" | "completed" | "failed" | "allowed" | "denied" | "blocked" | "cancelled" | "interrupted" | "unavailable" | "reused" | "not_started" | "busy";
export interface TraceStart {
 kind: TraceKind; id: string; owner?: string; parentId?: string; parentKind?: TraceKind;
 source?: TraceSource; tool?: string; rule?: string; reason?: string; fingerprint?: string; actor?: string;
}
export interface TraceEnd { status: TraceStatus; durationMs?: number; childId?: string; rule?: string; reason?: string; analysis?: "static_operands" | "conservative_text"; decision?: "selected_first" | "selected_second" | "freeform" | "multiple" | "none"; }
export interface TraceBus { emit(channel: string, value: unknown): void; }
export interface TraceEnvelope { start: TraceStart; end?: TraceEnd; token?: object; finish?: (end: TraceEnd) => void; }

/** The collector supplies a session-fenced completion callback synchronously. */
export function beginRuntimeTrace(bus: TraceBus | undefined, start: TraceStart): (end: TraceEnd) => void {
 const envelope: TraceEnvelope = { start };
 try { bus?.emit(EXECUTION_TRACE_CHANNEL, envelope); } catch { /* Diagnostic only. */ }
 return end => { try { envelope.finish?.(end); } catch { /* Diagnostic only. */ } };
}
export function emitRuntimeTrace(bus: TraceBus | undefined, signal: TraceStart & {status: TraceStatus}): void {
 beginRuntimeTrace(bus, signal)({ status: signal.status });
}

/** Record answer shape, never answer text or inferred permission semantics. */
export function traceAskResult(result: unknown, options: readonly unknown[]): TraceEnd {
 const value = result as { isError?: boolean; details?: { cancelled?: boolean; semanticApprovalReused?: boolean; response?: { kind?: string; selections?: unknown[] } } } | null;
 if (value?.isError) return { status: "failed" };
 if (value?.details?.cancelled) return { status: "cancelled", decision: "none" };
 const response = value?.details?.response;
 const selections = response?.selections ?? [];
 const label = (option: unknown) => typeof option === "string" ? option : (option as {title?:unknown})?.title;
 const index = selections.length === 1 ? options.findIndex(option => label(option) === selections[0]) : -1;
 return { status: value?.details?.semanticApprovalReused ? "reused" : "completed",
  decision: response?.kind === "freeform" ? "freeform" : selections.length > 1 ? "multiple" : index === 0 ? "selected_first" : index === 1 ? "selected_second" : "none" };
}

export function policyTraceReason(text:string):string {
 if(/zero.access|Glob matches|Find pattern matches/i.test(text))return 'zero_access';
 if(/read.only/i.test(text))return 'read_only';
 if(/delete\/move protected|no.delete/i.test(text))return 'no_delete';
 if(/authority changed|revoked/i.test(text))return 'authority_changed';
 if(/user denied|keep blocked/i.test(text))return 'human_denial';
 return 'policy_rule';
}
