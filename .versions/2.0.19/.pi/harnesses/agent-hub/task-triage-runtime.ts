import { createHash, randomUUID } from "node:crypto";
import type { System1Result, System1Service } from "../lib/system1/contracts.ts";
import type { TaskTriageActivity } from "./system1-activity.ts";
import { TASK_TRIAGE_LIMITS, TASK_TRIAGE_QUESTIONS, TASK_TRIAGE_QUESTION_VERSION, type TaskTriageAssessment } from "./task-triage-contract.ts";
import { buildTaskTriageState } from "./task-triage-state.ts";
import { assessTaskTriage } from "./task-triage-policy.ts";

export const TASK_TRIAGE_RUNTIME_ENTRY = "agent-hub-task-triage-runtime/v1";

/** An unavailable or invalid assessment is not an evaluation that can fence baseline work. */
export function evaluatedTaskTriageInputChanged(current: { revision: string; assessment: TaskTriageAssessment } | null, text: string): boolean {
 return !!current && (current.assessment.status === "applied" || current.assessment.status === "no_additions")
  && current.revision !== createHash("sha256").update(text).digest("hex");
}
interface Snapshot { schema: typeof TASK_TRIAGE_RUNTIME_ENTRY; calls: number; fingerprints: string[]; assessments?: Record<string, TaskTriageAssessment>; }
type TaskTriageCurrent = { fingerprint: string; taskId: string; assessment: TaskTriageAssessment; evaluationId: string; revision: string };
export function restoreTaskTriageCounter(entries: readonly unknown[]): Snapshot | null {
 for (let i = entries.length - 1; i >= 0; i--) {
  const row = entries[i] as any;
  if ((row?.customType ?? row?.type) !== TASK_TRIAGE_RUNTIME_ENTRY) continue;
  const s = row.data as Snapshot;
  return s?.schema === TASK_TRIAGE_RUNTIME_ENTRY && Number.isSafeInteger(s.calls) && s.calls >= 0 && s.calls <= TASK_TRIAGE_LIMITS.maxCallsPerSession && Array.isArray(s.fingerprints) && s.fingerprints.length <= TASK_TRIAGE_LIMITS.maxCallsPerSession && s.fingerprints.every(x => typeof x === "string" && /^[a-f0-9]{64}$/.test(x)) && (!s.assessments || (typeof s.assessments === "object" && !Array.isArray(s.assessments) && Object.entries(s.assessments).every(([key, value]) => s.fingerprints.includes(key) && value && ["applied", "no_additions", "unavailable", "skipped", "stale"].includes((value as TaskTriageAssessment).status) && Array.isArray((value as TaskTriageAssessment).reasons)) && Buffer.byteLength(JSON.stringify(s.assessments)) <= 64 * 1024)) ? s : null;
 }
 return entries.some((row: any) => row?.type === "message" && row?.message?.role === "user") ? null : { schema: TASK_TRIAGE_RUNTIME_ENTRY, calls: 0, fingerprints: [] };
}
export function createTaskTriageRuntime(options: { service?: System1Service; serviceUnavailableReason?: string; root: string; persist(snapshot: Snapshot): void; restored?: Snapshot | null; observer?: Pick<TaskTriageActivity, "evaluationStarted" | "evaluationFinished"> }) {
 let snapshot: Snapshot | null = options.restored === undefined ? restoreTaskTriageCounter([]) : options.restored;
 let pending: { text: string; revision: string } | null = null;
 let scope: string | null = null;
 let current: TaskTriageCurrent | null = null;
 let controller: AbortController | null = null;
 let flight: { fingerprint: string; taskId: string; generation: number; promise: Promise<TaskTriageCurrent | null> } | null = null;
 let epoch = 0;
 let cancelObservation: (() => void) | null = null;
 const stop = () => { epoch++; controller?.abort(); controller = null; flight = null; cancelObservation?.(); cancelObservation = null; };
 return {
  get status() { return current?.assessment ?? { status: !snapshot || !options.service ? "unavailable" : "skipped", reasons: [], detail: !snapshot ? "counter_restore_ambiguous" : !options.service ? `shared_service_${options.serviceUnavailableReason ?? "unavailable"}` : "no_user_input" } as TaskTriageAssessment; },
  get current() { return current; },
  get inputRevision() { return pending?.revision; },
  get calls() { return snapshot?.calls ?? null; },
  input(text: string, source: string) {
   if (source === "extension" || !text.trim()) return;
   const revision = createHash("sha256").update(text).digest("hex");
   if (pending?.revision === revision) return;
   stop(); pending = { text, revision }; current = null;
  },
  restore(entries: readonly unknown[]) { stop(); pending = null; current = null; scope = null; snapshot = restoreTaskTriageCounter(entries); },
  dispose: stop,
  adopt(taskId: string) { if (current) current = { ...current, taskId }; return current; },
  /** Reuse the already evaluated input; otherwise wait for the newest pending revision. */
  async bindInput(taskId: string) { return current ?? await this.evaluate(taskId); },
  scope(value: string) { if (scope === value) return false; scope = value; stop(); current = null; return true; },
  invalidate() { stop(); current = null; },
  async evaluate(taskId: string): Promise<TaskTriageCurrent | null> {
   if (!pending || !taskId) return current;
   const input = pending, generation = epoch;
   const built = buildTaskTriageState({ task: input.text, constraints: scope ? [`Declared process scope: ${scope}`] : [] }, options.root);
   const fingerprint = built.ok ? built.fingerprint : input.revision + (scope ?? "");
   if (current?.fingerprint === fingerprint && current.taskId === taskId) return current;
   if (flight?.fingerprint === fingerprint && flight.taskId === taskId && flight.generation === generation) return flight.promise;
   const evaluationId = randomUUID(), identity = { taskId, evaluationId, inputRevision: input.revision };
   let observed = false, observationClosed = false, providerResult: System1Result | undefined;
   const beginObservation = (logicalCall: boolean) => {
    if (observed) return;
    observed = true;
    try { options.observer?.evaluationStarted({ ...identity }, logicalCall); } catch { /* optional observer never owns policy */ }
   };
   const finishObservation = (assessment: TaskTriageAssessment) => {
    if (observationClosed) return;
    observationClosed = true;
    // Only validated metadata, not task/state, raw bodies or mutable policy objects.
    const result: System1Result | undefined = providerResult?.status === "ok"
     ? { status: "ok", evaluation: { answers: [], metadata: { provider: providerResult.evaluation.metadata.provider,
       requestedModel: providerResult.evaluation.metadata.requestedModel, returnedModel: providerResult.evaluation.metadata.returnedModel,
       questionSetVersion: providerResult.evaluation.metadata.questionSetVersion, latencyMs: providerResult.evaluation.metadata.latencyMs,
       attempts: providerResult.evaluation.metadata.attempts, usage: providerResult.evaluation.metadata.usage ? { inputTokens: providerResult.evaluation.metadata.usage.inputTokens, outputTokens: providerResult.evaluation.metadata.usage.outputTokens } : undefined } } }
     : providerResult ? { status: providerResult.status,
       ...("reason" in providerResult ? { reason: providerResult.reason } : {}),
       ...("missingCapabilities" in providerResult ? { missingCapabilities: [...providerResult.missingCapabilities] } : {}) } as System1Result : undefined;
    try { options.observer?.evaluationFinished({ ...identity }, structuredClone({ assessment, result })); } catch { /* observational only */ }
   };
   const record = (assessment: TaskTriageAssessment) => {
    beginObservation(false); finishObservation(assessment);
    if (epoch !== generation || pending?.revision !== input.revision) return null;
    current = { fingerprint, taskId, assessment, evaluationId, revision: input.revision };
    return current;
   };
   if (!built.ok) return record({ status: built.reason, reasons: [] });
   const service = options.service;
   if (!service) return record({ status: "unavailable", reasons: [], detail: `shared_service_${options.serviceUnavailableReason ?? "unavailable"}` });
   if (!snapshot) return record({ status: "unavailable", reasons: [], detail: "counter_restore_ambiguous" });
   if (snapshot.fingerprints.includes(fingerprint)) return record(snapshot.assessments?.[fingerprint] ?? { status: "stale", reasons: [], detail: "reserved_result_unavailable" });
   if (snapshot.calls >= TASK_TRIAGE_LIMITS.maxCallsPerSession) return record({ status: "skipped", reasons: [], detail: "session_call_cap" });
   // Reserve durably before the physical request; a failed write never permits inference.
   const next: Snapshot = { schema: TASK_TRIAGE_RUNTIME_ENTRY, calls: snapshot.calls + 1, fingerprints: [...snapshot.fingerprints, fingerprint], assessments: snapshot.assessments };
   try { options.persist(next); snapshot = next; } catch { return record({ status: "unavailable", reasons: [], detail: "counter_persistence_failed" }); }
   beginObservation(true);
   const cancel = () => finishObservation({ status: "cancelled", reasons: [], detail: "cancelled" });
   cancelObservation = cancel;
   controller = new AbortController();
   const call = controller;
   const timeout = setTimeout(() => call.abort(), TASK_TRIAGE_LIMITS.timeoutMs);
   const work: Promise<TaskTriageCurrent | null> = (async () => {
   try {
    const result = await Promise.race([
     service.evaluate({ state: built.state, questions: TASK_TRIAGE_QUESTIONS, questionSetVersion: TASK_TRIAGE_QUESTION_VERSION, timeoutMs: TASK_TRIAGE_LIMITS.timeoutMs, signal: call.signal }),
     new Promise<never>((_, reject) => call.signal.addEventListener("abort", () => reject(new Error("deadline")), { once: true })),
    ]);
    providerResult = result;
    const assessment = assessTaskTriage(result);
    if (epoch !== generation || pending?.revision !== input.revision) return null;
    // A result is reusable only after its bounded projection is durably appended.
    const cached: Snapshot = { ...snapshot!, assessments: { ...snapshot!.assessments, [fingerprint]: assessment } };
    try { options.persist(cached); snapshot = cached; }
    catch { return record({ status: "unavailable", reasons: [], detail: "result_persistence_failed" }); }
    return record(assessment);
   } catch { return record({ status: call.signal.aborted ? "unavailable" : "unavailable", reasons: [], detail: call.signal.aborted ? "deadline_or_cancelled" : "provider_failure" }); }
   finally { clearTimeout(timeout); if (controller === call) controller = null; if (cancelObservation === cancel) cancelObservation = null; }
   })();
   flight = { fingerprint, taskId, generation, promise: work };
   try { return await work; }
   finally { if (flight?.promise === work) flight = null; }
  },
 };
}
