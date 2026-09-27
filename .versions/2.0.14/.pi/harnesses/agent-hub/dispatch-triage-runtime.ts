import { randomUUID } from "node:crypto";
import type { System1Service } from "../lib/system1/contracts.ts";
import { TRIAGE_VERSION, triageQuestions, type TriageInput, type TriageConfig } from "./dispatch-triage-contract.ts";
import { buildTriageState, triageFingerprint } from "./dispatch-triage-state.ts";
import { triageAdvice } from "./dispatch-triage-policy.ts";
export interface TriageTrace { id: string; taskId: string; fingerprint: string; event: string; status?: string; persona?: string; reason?: string; uncertainty?: unknown; risks?: unknown; policyVersion?: string; metadata?: unknown }
export function createTriageRuntime(deps: { config: TriageConfig | null; service?: System1Service; current(input: TriageInput): TriageInput; trace?(event: TriageTrace): void }) {
 const evaluations = new Map<string, { input: TriageInput; fingerprint: string }>();
 let calls = 0, disposed = false; const abort = new AbortController();
 const trace = (event: TriageTrace) => { try { deps.trace?.(event); } catch { /* no change to provider semantics */ } };
 return {
  get calls() { return calls; },
  get orchestratorBeforeDispatch() { return !disposed && deps.config?.mode === "advisory" && deps.config.remoteContextApproved && deps.config.orchestratorBeforeDispatch === true && !!deps.service && calls < deps.config.maxCalls; },
  dispose() { disposed = true; abort.abort(); evaluations.clear(); },
  disposition(id: string, persona: string, reason: string) {
   const e = evaluations.get(id);
   if (disposed || !e || triageFingerprint(deps.current(e.input)) !== e.fingerprint) return false;
   trace({ id, taskId: e.input.taskId, fingerprint: e.fingerprint, event: "triage_disposition", persona, reason });
   return true;
  },
  submitted(id: string, persona: string, status: string) {
   const e = evaluations.get(id); if (!e || disposed) return;
   trace({ id, taskId: e.input.taskId, fingerprint: e.fingerprint, event: "dispatch_observed", persona, status });
  },
  async evaluate(input: TriageInput, signal?: AbortSignal) {
   const config = deps.config;
   const skipped = (reason: string) => ({ status: "skipped", reason });
   if (disposed) return skipped("disposed");
   if (!config || config.mode === "off") return skipped("consumer_off");
   if (!config.remoteContextApproved) return skipped("remote_context_not_approved");
   if (!deps.service) return skipped("service_unavailable");
   if (signal?.aborted) return { status: "cancelled" };
   const built = buildTriageState(input, config); if (!built.ok) return skipped(built.reason);
   if (calls >= config.maxCalls) return skipped("session_call_budget");
   const id = randomUUID(), base = { id, taskId: input.taskId, fingerprint: built.fingerprint };
   const call = new AbortController(), cancel = () => call.abort();
   signal?.addEventListener("abort",cancel,{once:true}); abort.signal.addEventListener("abort",cancel,{once:true});
   evaluations.set(id, { input: structuredClone(input), fingerprint: built.fingerprint });
   calls++; trace({ ...base, event: "triage_requested" });
   try {
    const result = await deps.service.evaluate({ state: built.state, questions: triageQuestions(built.candidates), questionSetVersion: TRIAGE_VERSION, requiredCapabilities: ["distribution","probability_true"], signal: call.signal });
    trace({ ...base, event: "triage_completed", status: result.status, metadata: result.status === "ok" ? result.evaluation.metadata : undefined });
    if (disposed || call.signal.aborted) return { id, status: "cancelled" };
    if (triageFingerprint(deps.current(input)) !== built.fingerprint) return { id, status: "stale" };
    const advice = triageAdvice(result,input,config.profile);
    trace({ ...base, event: "triage_advice", status: advice.status, persona: advice.persona, reason: advice.reason, uncertainty: advice.uncertainty, risks: advice.risks, policyVersion: TRIAGE_VERSION });
    if (config.mode === "shadow") return { id, status: "shadow_recorded", reason: "Advice withheld until an independent decision" };
    return { id, ...advice, policyVersion: TRIAGE_VERSION, note: "Advisory only. Existing dispatch, permission, risk, budget and acceptance gates still apply. Low risk probabilities never mean safe." };
   } catch { trace({ ...base, event: "triage_completed", status: "unavailable" }); return { id, status: "unavailable", reason: "evaluation_failed" }; }
   finally { signal?.removeEventListener("abort",cancel); abort.signal.removeEventListener("abort",cancel); }
  },
 };
}
