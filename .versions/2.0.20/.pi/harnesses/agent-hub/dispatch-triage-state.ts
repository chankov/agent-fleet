import { containsCommunicationSecret } from "./system1-communication-store.ts";
import { createHash } from "node:crypto";
import { TRIAGE_VERSION, type TriageInput, type TriageConfig } from "./dispatch-triage-contract.ts";
const CONTROL_CHARACTERS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
function sanitizeTriageText(text: string): string {
 return text
  .replace(/file:\/\/\/[^\s"'`<>)]*/gi, "file://[PATH]")
  .replace(/(?<![A-Za-z0-9._-])\/(?!\/)[^\s"'`<>)]*/g, "[PATH]")
  .replace(/(?<![A-Za-z0-9._-])[A-Za-z]:\\[^\s"'`<>)]*/g, "[PATH]")
  .replace(CONTROL_CHARACTERS, "");
}
export function triageFingerprint(input: TriageInput): string { return createHash("sha256").update(JSON.stringify(input)).digest("hex"); }
export function buildTriageState(input: TriageInput, limits: Pick<TriageConfig,"maxStateBytes"|"maxTaskBytes"|"maxRoleBytes">) {
 const candidates = input.candidates.filter(c => !c.excluded).sort((a,b) => a.name.localeCompare(b.name));
 const bytes = (v: unknown) => Buffer.byteLength(typeof v === "string" ? v : JSON.stringify(v));
 if (!input.task.trim() || !input.complete) return { ok: false as const, reason: "insufficient_evidence" };
 if (candidates.some(c => !/^[a-z][a-z0-9_-]*$/i.test(c.name) || c.name.toLowerCase() === "none") || new Set(candidates.map(c => c.name.toLowerCase())).size !== candidates.length || candidates.length > 254) return { ok: false as const, reason: "invalid_candidates" };
 if (!candidates.length) return { ok: false as const, reason: "no_eligible_candidates" };
 const rawText = [input.task, ...input.scope, input.language, input.domain, input.constraints, ...candidates.flatMap(c => [c.name, c.description])];
 if (rawText.some(containsCommunicationSecret)) return { ok: false as const, reason: "sensitive_context_withheld" };
 const safeCandidates = candidates.map(c => ({ ...c, description: sanitizeTriageText(c.description) }));
 const state = {
  schema: TRIAGE_VERSION,
  task: sanitizeTriageText(input.task),
  scope: input.scope.map(sanitizeTriageText),
  language: sanitizeTriageText(input.language),
  domain: sanitizeTriageText(input.domain),
  constraints: sanitizeTriageText(input.constraints),
  candidates: safeCandidates.map(c => ({ name: c.name, description: c.description })),
 };
 if (bytes(state.task) > limits.maxTaskBytes || safeCandidates.some(c => bytes(c.description) > limits.maxRoleBytes) || bytes(state) > limits.maxStateBytes) return { ok: false as const, reason: "state_too_large" };
 return { ok: true as const, state, candidates: safeCandidates, fingerprint: triageFingerprint(input) };
}
