import { randomUUID } from "node:crypto";
import type { EvaluateRequest, System1Result, System1Service } from "../lib/system1/contracts.ts";

export const COMMUNICATION_LIMITS = Object.freeze({ pairs: 200, bytes: 4 * 1024 * 1024, payloadBytes: 32 * 1024 });
export interface CommunicationPair {
 id: string; consumer: string; owner: string; provider: string; model: string;
 started: number; ended?: number; request: string | null; response: string | null;
 status: string; requestOmitted?: string; responseOmitted?: string;
}
const secretKey = /authorization|api.?key|password|passwd|secret|credential|cookie|access.?token|refresh.?token|private.?key/i;
/** Conservative diagnostic copy, never an HTTP capture. Unknown consumer schemas are withheld. */
export function redactCommunication(value: unknown): unknown {
 const seen = new WeakSet<object>();
 const walk = (v: unknown, depth: number): unknown => {
  if (depth > 30) return "[withheld: depth]";
  if (typeof v === "string") return v
   .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, "[REDACTED]")
   .replace(/\b(?:Bearer|Basic)\s+\S+/gi, "[REDACTED]")
   .replace(/\b(?:sk-|gh[pousr]_|github_pat_|AKIA)[A-Za-z0-9_\-]+/g, "[REDACTED]")
   .replace(/((?:api[_ -]?key|password|passwd|secret|token|credential)\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]")
   .replace(/(?:\/[A-Za-z0-9._-]+){2,}|[A-Za-z]:\\[^\s]+/g, "[PATH]")
   .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
  if (v === null || typeof v === "boolean" || typeof v === "number") return v;
  if (!v || typeof v !== "object" || seen.has(v)) return "[withheld]";
  seen.add(v);
  if (Array.isArray(v)) return v.map(x => walk(x, depth + 1));
  return Object.fromEntries(Object.entries(v).map(([k,x]) => [String(walk(k, depth + 1)), secretKey.test(k) ? "[REDACTED]" : walk(x, depth + 1)]));
 };
 return walk(value, 0);
}
function consumerFor(request: EvaluateRequest): string {
 const version = request.questionSetVersion;
 if (version === "dispatch-triage/v1") return "dispatch-triage";
 if (version === "watchdog-questions/v1") return "watchdog";
 if (["proactive-assessment/v1", "proactive-selection/v1"].includes(version)) return "proactive";
 return "not instrumented";
}
export function createCommunicationStore(limits = COMMUNICATION_LIMITS, now = Date.now) {
 let enabled = false, generation = 0, sessionEpoch = 0, evicted = 0;
 const pairs = new Map<string, CommunicationPair>();
 const listeners = new Set<() => void>();
 const emit = () => { for (const listener of listeners) { try { listener(); } catch { /* observer cannot affect inference */ } } };
 const bytes = () => Buffer.byteLength(JSON.stringify([...pairs.values()]));
 const trim = () => { while (pairs.size > limits.pairs || (pairs.size && bytes() > limits.bytes)) { pairs.delete(pairs.keys().next().value!); evicted++; } };
 const payload = (value: unknown): string | null => {
  const raw = JSON.stringify(value);
  if (Buffer.byteLength(raw) > limits.payloadBytes) return null;
  const text = JSON.stringify(redactCommunication(value), null, 2);
  return Buffer.byteLength(text) <= limits.payloadBytes ? text : null;
 };
 return {
  get enabled() { return enabled; }, get evicted() { return evicted; },
  snapshot(): CommunicationPair[] { return [...pairs.values()].map(p => ({ ...p })); },
  subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
  setEnabled(value: boolean) { generation++; enabled = value; pairs.clear(); evicted = 0; emit(); },
  dispose() { sessionEpoch++; generation++; enabled = false; pairs.clear(); evicted = 0; emit(); listeners.clear(); },
  wrap(service: System1Service, identity: { provider: string; model: string }): System1Service {
   const ownerEpoch = sessionEpoch;
   return { async evaluate(request) {
    const epoch = generation; let id: string | undefined;
    try {
     if (enabled && ownerEpoch === sessionEpoch) {
      id = randomUUID(); const consumer = consumerFor(request);
      const state = request.state as Record<string, unknown>;
      const owner = typeof state?.owner === "string" ? String(redactCommunication(state.owner)) : consumer === "dispatch-triage" ? "hub" : "owner unavailable";
      const keys = consumer === "watchdog" ? ["schema","task","scope","hub_owned_paths","tool_events","signal","counters","coverage"] : consumer === "proactive" ? ["schema","candidates","task","paths","plan","planStatus","snapshotId","status","gaps","units","pairs"] : ["schema","task","scope","language","domain","constraints","candidates"];
      const projected = state && typeof state === "object" && !Array.isArray(state) ? Object.fromEntries(keys.filter(k => Object.hasOwn(state,k)).map(k => [k,state[k]])) : null;
      const questions = request.questions.map(q => ({ id:q.id,type:q.type,instructions:q.instructions,...(q.type === "choice" ? {options:q.options} : q.type === "ordinal" ? {levels:q.levels} : {criteria:q.criteria}) }));
      const text = consumer === "not instrumented" || projected === null ? null : payload({ state: projected, questions, questionSetVersion: request.questionSetVersion, timeoutMs: request.timeoutMs, requiredCapabilities: request.requiredCapabilities });
      pairs.set(id, { id, consumer, owner, provider: String(redactCommunication(identity.provider)), model: String(redactCommunication(identity.model)), started: now(), status: "pending", request: text, response: null, ...(text === null ? { requestOmitted: "payload withheld or too large" } : {}) }); trim(); emit();
     }
    } catch { id = undefined; }
    let result: System1Result;
    try { result = await service.evaluate(request); }
    catch (error) {
     if (id && epoch === generation && pairs.has(id)) { Object.assign(pairs.get(id)!, { status: "observer: evaluation threw", ended: now(), responseOmitted: "payload withheld" }); emit(); }
     throw error;
    }
    try {
     if (id && enabled && epoch === generation && pairs.has(id)) {
      const pair = pairs.get(id)!;
      // Reconstruct the result allowlist; never preserve unvalidated provider extras.
      const safe = result.status === "ok" ? { status: result.status, evaluation: { answers: result.evaluation.answers.map(a => ({ questionId: a.questionId, type: a.type, ...(a.type === "predicate" ? { probabilityTrue: a.probabilityTrue } : { value: a.value, ...(a.type === "ordinal" ? { levels: a.levels } : {}) }), uncertainty: { provenance: a.uncertainty.provenance, confidence: a.uncertainty.confidence, distribution: a.uncertainty.distribution } })), metadata: { provider: result.evaluation.metadata.provider, requestedModel: result.evaluation.metadata.requestedModel, returnedModel: result.evaluation.metadata.returnedModel, questionSetVersion: result.evaluation.metadata.questionSetVersion, latencyMs: result.evaluation.metadata.latencyMs, attempts: result.evaluation.metadata.attempts, usage: result.evaluation.metadata.usage } } } : { status: result.status, reason: "reason" in result ? result.reason : undefined, missingCapabilities: "missingCapabilities" in result ? result.missingCapabilities : undefined };
      pair.response = pair.consumer === "not instrumented" ? null : payload(safe);
      pair.status = result.status; pair.ended = now();
      if (pair.response === null) pair.responseOmitted = "payload withheld or too large";
      trim(); emit();
     }
    } catch { /* observational only */ }
    return result;
   } };
  },
 };
}
export type CommunicationStore = ReturnType<typeof createCommunicationStore>;
