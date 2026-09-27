import { redactCommunication } from "./system1-communication-store.ts";
import { createHash } from "node:crypto";
import { TRIAGE_VERSION, type TriageInput, type TriageConfig } from "./dispatch-triage-contract.ts";
export function triageFingerprint(input: TriageInput): string { return createHash("sha256").update(JSON.stringify(input)).digest("hex"); }
export function buildTriageState(input: TriageInput, limits: Pick<TriageConfig,"maxStateBytes"|"maxTaskBytes"|"maxRoleBytes">) {
 const candidates = input.candidates.filter(c => !c.excluded).sort((a,b) => a.name.localeCompare(b.name));
 const bytes = (v: unknown) => Buffer.byteLength(typeof v === "string" ? v : JSON.stringify(v));
 if (!input.task.trim() || !input.complete) return { ok: false as const, reason: "insufficient_evidence" };
 if (candidates.some(c => !/^[a-z][a-z0-9_-]*$/i.test(c.name) || c.name.toLowerCase() === "none") || new Set(candidates.map(c => c.name.toLowerCase())).size !== candidates.length || candidates.length > 254) return { ok: false as const, reason: "invalid_candidates" };
 if (!candidates.length) return { ok: false as const, reason: "no_eligible_candidates" };
 if ([input.task, ...input.scope, ...candidates.map(c => c.description)].some(text => redactCommunication(text) !== text)) return { ok: false as const, reason: "sensitive_context_withheld" };
 const state = { schema: TRIAGE_VERSION, task: input.task, scope: input.scope, language: input.language, domain: input.domain, constraints: input.constraints, candidates: candidates.map(c => ({ name: c.name, description: c.description })) };
 if (bytes(input.task) > limits.maxTaskBytes || candidates.some(c => bytes(c.description) > limits.maxRoleBytes) || bytes(state) > limits.maxStateBytes) return { ok: false as const, reason: "state_too_large" };
 return { ok: true as const, state, candidates, fingerprint: triageFingerprint(input) };
}
