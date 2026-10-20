import { createHash, randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { EXECUTION_TRACE_CHANNEL, policyTraceReason, type TraceEnvelope, type TraceEnd, type TraceKind, type TraceSource, type TraceStart, type TraceStatus } from "../lib/execution-trace.ts";

export const EXECUTION_TRACE_ENTRY = "agent-hub-execution-trace";
// v2 journals one row per finished span (start time, end time and outcome together);
// only long-lived turn/child spans also journal their start, so a crash still shows
// what was in flight. v1 rows (separate start/end) from older sessions remain readable.
const SCHEMA = "agent-fleet.execution-trace/v2";
const LEGACY_SCHEMA = "agent-fleet.execution-trace/v1";
const JOURNALED_STARTS = new Set<TraceKind>(["turn", "child"]);
const MAX_ROWS = 5000;
const kinds = new Set<TraceKind>(["input", "turn", "model", "tool", "policy", "approval", "queue", "child"]);
const sources = new Set<TraceSource>(["runtime", "native", "process", "task-triage", "damage-control", "damage-guard", "access-escalation"]);
const statuses = new Set<TraceStatus>(["pending", "completed", "failed", "allowed", "denied", "blocked", "cancelled", "interrupted", "unavailable", "reused", "not_started", "busy"]);
const reasons = new Set(["zero_access", "read_only", "no_delete", "authority_changed", "human_denial", "policy_rule", "task_transition_pending", "process_state_corrupt", "risk_required", "action_confirmation_unsupported", "approval_queue"]);
const actors = new Set(["operator", "specialist", "builder", "planner", "plan-reviewer", "code-reviewer", "security-auditor", "test-engineer", "researcher", "deep-researcher", "architect", "documenter", "debugger"]);
const tools = new Set(["bash", "read", "write", "edit", "grep", "find", "ls", "filesystem", "ask_user", "dispatch_agent", "spawn_research", "set_task_tier", "set_assertions", "update_assertion", "get_assertions", "coms_send", "coms_get", "coms_await", "delegate"]);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const millis = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

export interface ExecutionTraceRow {
 schema: typeof SCHEMA | typeof LEGACY_SCHEMA; instanceId: string; sequence: number; atMs: number;
 /** Present on a v2 finished-span row; atMs is then the span's start. */
 endAtMs?: number;
 spanId: string; parentSpanId: string | null; ownerIdHash: string; taskIdHash: string; inputRevisionHash: string;
 kind: TraceKind; source: TraceSource; phase: "start" | "end" | "span"; status: TraceStatus;
 tool?: string; ruleId?: string; fingerprint?: string; childIdHash?: string; durationMs?: number;
 decision?: TraceEnd["decision"];
 reason?: string;
 actor: string; analysis?: TraceEnd["analysis"];
}
export interface ExecutionTraceSnapshot { rows: ExecutionTraceRow[]; persistenceFailures: number; droppedRows: number; open?: ExecutionTraceRow[]; }

export function createExecutionTrace(ports: { identity(): { taskId: string; inputRevision: string }; persist(row: ExecutionTraceRow): void; now?(): number }) {
 let instanceId = randomUUID(), sequence = 0, persistenceFailures = 0, droppedRows = 0;
 const active = new Map<string, { row: ExecutionTraceRow; finish: (end: TraceEnd) => void }>();
 const rows: ExecutionTraceRow[] = [];
 const now = ports.now ?? Date.now;
 const key = (kind: TraceKind, id: string, owner = "hub") => JSON.stringify([kind, owner, id]);
 const spanId = (kind: TraceKind, id: string, owner = "hub") => hash(JSON.stringify([instanceId, kind, owner, id]));
 const record = (row: ExecutionTraceRow) => {
  rows.push(row); if (rows.length > MAX_ROWS) { rows.shift(); droppedRows++; }
  try { ports.persist(row); } catch { persistenceFailures++; }
 };
 const start = (input: TraceStart, capturedIdentity?: ReturnType<typeof ports.identity>): ((end: TraceEnd) => void) => {
  if (!input || !kinds.has(input.kind) || typeof input.id !== "string" || !input.id || input.id.length > 512) return () => {};
  const binding = key(input.kind, input.id, input.owner), prior = active.get(binding);
  if (prior) return prior.finish;
  const identity = capturedIdentity ?? ports.identity(), epoch = instanceId;
  const parent=input.parentId?active.get(key(input.parentKind??"tool",input.parentId,input.owner))?.row:undefined;
  const child=input.owner?active.get(key("child",input.owner,input.owner))?.row:undefined;
  const row: ExecutionTraceRow = {
   schema: SCHEMA, instanceId, sequence: ++sequence, atMs: now(),
   spanId: spanId(input.kind, input.id, input.owner),
   parentSpanId: input.parentId ? spanId(input.parentKind ?? "tool", input.parentId, input.owner) : null,
   ownerIdHash: hash(input.owner ?? "hub"), taskIdHash: parent?.taskIdHash??child?.taskIdHash??hash(identity.taskId), inputRevisionHash: parent?.inputRevisionHash??child?.inputRevisionHash??hash(identity.inputRevision),
   actor: input.actor&&actors.has(input.actor)?input.actor:parent?.actor??child?.actor??(!input.owner||input.owner==="hub"?"operator":"specialist"),
   kind: input.kind, source: input.source && sources.has(input.source) ? input.source : "runtime", phase: "start", status: "pending",
   ...(input.tool ? { tool: tools.has(input.tool) ? input.tool : "other" } : {}),
   ...(input.rule ? { ruleId: hash(input.rule) } : {}), ...(input.fingerprint ? { fingerprint: hash(input.fingerprint) } : {}),
   ...(input.reason && reasons.has(input.reason) ? { reason: input.reason } : {}),
  };
  const finish = (end: TraceEnd) => {
   if (instanceId !== epoch || active.get(binding)?.row !== row || !end || !statuses.has(end.status)) return;
   active.delete(binding);
   record({ ...row, sequence: ++sequence, endAtMs: Math.max(row.atMs, now()), phase: "span", status: end.status,
    ...(millis(end.durationMs) ? { durationMs: end.durationMs } : {}), ...(end.childId ? { childIdHash: hash(end.childId) } : {}),
    ...(end.rule ? { ruleId: hash(end.rule) } : {}), ...(end.reason && reasons.has(end.reason) ? { reason: end.reason } : {}),
    ...(end.analysis && ["static_operands","conservative_text"].includes(end.analysis) ? {analysis:end.analysis} : {}),
    ...(end.decision && ["selected_first", "selected_second", "freeform", "multiple", "none"].includes(end.decision) ? { decision: end.decision } : {}) });
  };
  active.set(binding, { row, finish }); if (JOURNALED_STARTS.has(row.kind)) record(row); return finish;
 };
 const close = () => { for (const item of [...active.values()]) item.finish({ status: "interrupted" }); };
 return {
  start: (input:TraceStart) => start(input),
  endTool(id: string, end: TraceEnd, owner = "hub") { active.get(key("tool", id, owner))?.finish(end); },
  input(id: string) { start({ kind: "input", id })({ status: "completed" }); },
  close,
  reset() { close(); instanceId = randomUUID(); sequence = 0; rows.length = 0; persistenceFailures = 0; droppedRows = 0; },
  snapshot: (): ExecutionTraceSnapshot => ({ rows: [...rows], persistenceFailures, droppedRows, open: [...active.values()].map(item => item.row) }),
  forOwner(owner: string) {
   const epoch=instanceId,identity=ports.identity();
   return {
    start: (input:TraceStart) => instanceId===epoch ? start({...input,owner},identity) : (_end:TraceEnd)=>{},
    endTool: (id:string,end:TraceEnd) => { if(instanceId===epoch)active.get(key("tool",id,owner))?.finish(end); },
    close: () => { if(instanceId===epoch)for(const item of [...active.values()])if(item.row.ownerIdHash===hash(owner))item.finish({status:"interrupted"}); },
   };
  },
 };
}
export type ExecutionTrace = ReturnType<typeof createExecutionTrace>;

/** Native callbacks already transport tool metadata; no new child transport. */
export function createNativeExecutionTrace(trace:ExecutionTrace,owner:string,actor?:string) {
 const scope=trace.forOwner(owner),finish=scope.start({kind:"child",id:owner,actor});
 let closed=false;
 return {
  toolStart(tool:string,args:string,id?:string) { if(id&&!closed)scope.start({kind:"tool",id,parentId:owner,parentKind:"child",tool,source:"native",fingerprint:args}); },
  toolEnd(tool:string,id?:string,isError?:boolean,resultText?:string,durationMs?:number) {
   if(!id||closed)return;
   // An allowlisted marker explains refusal; it is never proof or permission.
   const blocked=isError&&durationMs===undefined&&/Damage-Control:/.test(resultText??"");
   if(blocked)scope.start({kind:"policy",id:`baseline:${id}`,parentId:id,source:"damage-control",tool,rule:(resultText??"").split("\n",1)[0],reason:policyTraceReason(resultText??"")})({status:"blocked"});
   scope.endTool(id,{status:blocked?"blocked":isError?"failed":"completed",durationMs});
  },
  finish(result:{exitCode:number;pending?:boolean}) { closed=true;finish({status:result.pending?"pending":result.exitCode===0?"completed":"failed"});scope.close(); },
 };
}

function normalizeRow(raw: unknown): ExecutionTraceRow | null {
 if (!raw || typeof raw !== "object") return null;
 const row = raw as ExecutionTraceRow;
 const phases = row.schema === SCHEMA ? ["start", "span"] : row.schema === LEGACY_SCHEMA ? ["start", "end"] : [];
 if (!/^[a-f0-9-]{36}$/.test(row.instanceId) || !Number.isSafeInteger(row.sequence) || row.sequence < 1 || !millis(row.atMs)
  || !digest(row.spanId) || row.parentSpanId !== null && !digest(row.parentSpanId) || ![row.ownerIdHash, row.taskIdHash, row.inputRevisionHash].every(digest)
  || !kinds.has(row.kind) || !sources.has(row.source) || !phases.includes(row.phase) || !statuses.has(row.status)
  || row.phase === "span" && !(millis(row.endAtMs) && row.endAtMs >= row.atMs)) return null;
 return { schema: row.schema, instanceId: row.instanceId, sequence: row.sequence, atMs: row.atMs, ...(row.phase === "span" ? { endAtMs: row.endAtMs } : {}), spanId: row.spanId, parentSpanId: row.parentSpanId,
  ownerIdHash: row.ownerIdHash, taskIdHash: row.taskIdHash, inputRevisionHash: row.inputRevisionHash, kind: row.kind, source: row.source, phase: row.phase, status: row.status,
  actor: actors.has(row.actor)?row.actor:"specialist",...(row.analysis&&["static_operands","conservative_text"].includes(row.analysis)?{analysis:row.analysis}:{}),
  ...(row.tool && (tools.has(row.tool) || row.tool === "other") ? { tool: row.tool } : {}),
  ...(digest(row.ruleId) ? { ruleId: row.ruleId } : {}), ...(digest(row.fingerprint) ? { fingerprint: row.fingerprint } : {}),
  ...(digest(row.childIdHash) ? { childIdHash: row.childIdHash } : {}), ...(millis(row.durationMs) ? { durationMs: row.durationMs } : {}),
  ...(row.decision && ["selected_first", "selected_second", "freeform", "multiple", "none"].includes(row.decision) ? { decision: row.decision } : {}),
  ...(row.reason && reasons.has(row.reason) ? { reason: row.reason } : {}),
 };
}
type Interval = [number, number];
function union(intervals: Interval[]): Interval[] {
 const merged: Interval[] = [];
 for (const [start, end] of intervals.sort((a, b) => a[0] - b[0])) {
  const last = merged.at(-1);
  if (last && start <= last[1]) last[1] = Math.max(last[1], end); else merged.push([start, end]);
 }
 return merged;
}
const length = (intervals: Interval[]) => union(intervals).reduce((sum, [a, b]) => sum + Math.max(0, b - a), 0);
const intersections = (left: Interval[], right: Interval[]) => left.flatMap(([a, b]) => right.map(([c, d]): Interval => [Math.max(a, c), Math.max(Math.max(a, c), Math.min(b, d))]));

export function projectExecutionTrace(entries: readonly unknown[], live?: ExecutionTraceSnapshot) {
 let invalidRecords = 0, duplicateRecords = 0, droppedRows = 0;
 const retained = new Map<string, ExecutionTraceRow>();
 for (const entry of entries) {
  const value = entry as { customType?: unknown; data?: unknown };
  if (value?.customType !== EXECUTION_TRACE_ENTRY) continue;
  const row = normalizeRow(value.data); if (!row) { invalidRecords++; continue; }
  const key = `${row.instanceId}:${row.sequence}`, previous = retained.get(key);
  if (previous) { duplicateRecords++; if (JSON.stringify(previous) !== JSON.stringify(row)) invalidRecords++; }
  else retained.set(key, row);
 }
 if (live?.persistenceFailures) for (const raw of live.rows) { const row = normalizeRow(raw); if (row) retained.set(`${row.instanceId}:${row.sequence}`, row); }
 // Unfinished spans are journaled only for turn/child; the live view still shows the rest.
 for (const raw of live?.open ?? []) { const row = normalizeRow(raw); if (row) retained.set(`${row.instanceId}:${row.sequence}`, row); }
 const all = [...retained.values()].sort((a, b) => a.atMs - b.atMs || a.sequence - b.sequence);
 if (all.length > MAX_ROWS) droppedRows += all.length - MAX_ROWS;
 const events = all.slice(-MAX_ROWS), grouped = new Map<string, { start?: ExecutionTraceRow; end?: ExecutionTraceRow }>();
 for (const row of events) {
  const item = grouped.get(row.spanId) ?? {};
  if (row.phase === "span") { item.start ??= row; item.end = { ...row, atMs: row.endAtMs! }; } else item[row.phase] = row;
  grouped.set(row.spanId, item);
 }
 const spans = [...grouped].map(([spanId, { start, end }]) => {
  const row = start ?? end!;
  return { spanId, instanceId: row.instanceId, parentSpanId: row.parentSpanId, ownerIdHash: row.ownerIdHash, taskIdHash: row.taskIdHash, inputRevisionHash: row.inputRevisionHash,
   kind: row.kind, source: row.source, actor:row.actor, tool: row.tool, ruleId: end?.ruleId ?? row.ruleId, reason: end?.reason ?? row.reason, analysis:end?.analysis, fingerprint: row.fingerprint, childIdHash: end?.childIdHash, decision: end?.decision,
   startedAt: start?.atMs ?? null, endedAt: end?.atMs ?? null, status: end?.status ?? "open", elapsedMs: start && end ? Math.max(0, end.atMs - start.atMs) : null,
   executionMs: end?.durationMs ?? null, humanWaitMs: 0, executionWithoutHumanMs: null as number | null, repeatOf: null as string | null,
   correlation: row.parentSpanId ? "direct" : null as string | null };
 });
 const byId = new Map(spans.map(s => [s.spanId, s]));
 for (const child of spans.filter(s => s.kind === "child" && !s.parentSpanId)) {
  const parents = spans.filter(s => s.kind === "tool" && s.instanceId === child.instanceId && s.childIdHash === child.ownerIdHash);
  if (parents.length === 1) { child.parentSpanId = parents[0].spanId; child.correlation = "runtime_child"; }
 }
 // The existing child broker has its own request id. Join only one exact input
 // observation from the same owner and time range; ambiguous calls stay unlinked.
 for(const policy of spans.filter(s=>s.kind==="policy"&&!s.parentSpanId&&s.fingerprint&&s.source==="damage-guard")){
  const candidates=spans.filter(s=>s.kind==="tool"&&s.instanceId===policy.instanceId&&s.ownerIdHash===policy.ownerIdHash&&s.tool===policy.tool&&s.fingerprint===policy.fingerprint
   &&s.startedAt!==null&&policy.startedAt!==null&&s.startedAt<=policy.startedAt&&(s.endedAt===null||policy.endedAt!==null&&s.endedAt>=policy.endedAt));
  if(candidates.length===1){policy.parentSpanId=candidates[0].spanId;policy.correlation="exact_input_unique";}
 }
 const below = (span: typeof spans[number], ancestor: typeof spans[number]) => {
  const seen = new Set<string>(); let parent = span.parentSpanId;
  while (parent && !seen.has(parent)) { if (parent === ancestor.spanId) return true; seen.add(parent); parent = byId.get(parent)?.parentSpanId ?? null; }
  return false;
 };
 const interval = (s: typeof spans[number]): Interval[] => s.startedAt === null || s.endedAt === null ? [] : [[s.startedAt, s.endedAt]];
 const waits = spans.filter(s => s.kind === "approval" && s.status !== "reused").flatMap(interval);
 const repeats = new Map<string, string>();
 for (const tool of spans.filter(s => s.kind === "tool")) {
  const ownWaits = spans.filter(s => s.kind === "approval" && s.status !== "reused" && below(s, tool)).flatMap(interval);
  tool.humanWaitMs = length(ownWaits);
  if (tool.executionMs !== null && tool.endedAt !== null) {
   const execution: Interval[] = [[Math.max(tool.startedAt ?? 0, tool.endedAt - tool.executionMs), tool.endedAt]];
   tool.executionWithoutHumanMs = Math.max(0, tool.executionMs - length(intersections(execution, ownWaits)));
  }
  if (tool.status === "failed" && tool.executionMs === null && spans.some(s => s.kind === "policy" && s.parentSpanId === tool.spanId && s.status === "blocked")) tool.status = "blocked";
  if (tool.fingerprint) { const key = JSON.stringify([tool.instanceId, tool.ownerIdHash, tool.taskIdHash, tool.inputRevisionHash, tool.tool, tool.fingerprint]); tool.repeatOf = repeats.get(key) ?? null; repeats.set(key, tool.spanId); }
 }
 const executions: Interval[] = spans.filter(s => s.kind === "tool" && s.executionMs !== null && s.endedAt !== null).map(s => [Math.max(s.startedAt ?? 0, s.endedAt! - s.executionMs!), s.endedAt!]);
 return { schema: SCHEMA, diagnosticOnly: true,
  coverage: { availability: live?.persistenceFailures ? "live_degraded" : events.length ? "recorded" : "not_recorded", persistenceFailures: live?.persistenceFailures ?? 0,
   invalidRecords, duplicateRecords, droppedRows, liveDroppedRows: live?.droppedRows ?? 0, openSpans: spans.filter(s => s.status === "open").length,
   incompleteSpans: spans.filter(s => s.startedAt === null || s.endedAt === null || ["interrupted","pending"].includes(s.status)).length,
   unlinkedSpans: spans.filter(s=>s.parentSpanId&&!byId.has(s.parentSpanId)||s.kind==="policy"&&s.source==="damage-guard"&&!s.parentSpanId).length },
  totals: { scope:"retained_trace_window", observedWallMs: events.length ? Math.max(0, Math.max(...events.map(row => row.endAtMs ?? row.atMs)) - events[0].atMs) : null,
   toolActivityMs: events.length?length(spans.filter(s => s.kind === "tool").flatMap(interval)):null, humanWaitMs: events.length?length(waits):null,
   queueWaitMs: events.length?length(spans.filter(s=>s.kind==="queue").flatMap(interval)):null, modelRoundMs: events.length?length(spans.filter(s=>s.kind==="model").flatMap(interval)):null,
   executionMs: events.length?length(executions):null, executionWithoutHumanMs: events.length?Math.max(0, length(executions) - length(intersections(executions, waits))):null,
   repeatedTools: spans.filter(s => s.repeatOf).length, blockedTools: spans.filter(s => s.kind === "tool" && s.status === "blocked").length },
  spans, events,
 };
}

export function registerExecutionTrace(pi: Pick<ExtensionAPI, "on" | "events">, trace: ExecutionTrace): void {
 const receive = (value: unknown) => {
  const envelope = value as TraceEnvelope;
  if (envelope?.start) envelope.finish = trace.start(envelope.start);
 };
 let unsubscribe: (() => void) | undefined = pi.events.on(EXECUTION_TRACE_CHANNEL, receive);
 pi.on("session_start", async () => { trace.reset(); unsubscribe ??= pi.events.on(EXECUTION_TRACE_CHANNEL, receive); });
 // before_switch is only a proposal: another extension may cancel it.
 pi.on("session_shutdown", async () => { trace.close(); unsubscribe?.(); unsubscribe = undefined; });
 let finishTurn: ((end: TraceEnd) => void) | undefined;
 let finishModel: ((end: TraceEnd) => void) | undefined;
 pi.on("agent_start", async () => { finishTurn = trace.start({ kind: "turn", id: randomUUID() }); });
 pi.on("agent_end", async () => { finishTurn?.({ status: "completed" }); trace.close(); });
 pi.on("turn_start",async()=>{finishModel=trace.start({kind:"model",id:randomUUID()});});
 pi.on("message_end",async event=>{if(event.message.role==="assistant")finishModel?.({status:event.message.stopReason==="error"?"failed":event.message.stopReason==="aborted"?"cancelled":"completed"});});
 pi.on("tool_execution_start", async event => {
  trace.start({ kind: "tool", id: event.toolCallId, tool: event.toolName, fingerprint: JSON.stringify(event.args ?? {}) });
 });
 pi.on("tool_execution_end", async event => {
  const details = event.result?.details as Record<string, unknown> | undefined;
  const status: TraceStatus = details?.status === "review_reused" ? "reused" : details?.status === "busy" ? "busy" : details?.started === false ? "not_started" : event.isError ? "failed" : "completed";
  trace.endTool(event.toolCallId, { status, durationMs: (event as typeof event & { durationMs?: number }).durationMs, childId: typeof details?.dispatchId === "string" ? details.dispatchId : undefined });
 });
}
