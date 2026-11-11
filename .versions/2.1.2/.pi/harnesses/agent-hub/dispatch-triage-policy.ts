import type { System1Result } from "../lib/system1/contracts.ts";
import { TRIAGE_LEVELS, TRIAGE_VERSION, validProfile, type TriageInput, type TriageProfile } from "./dispatch-triage-contract.ts";
export interface TriageAdvice { status: string; persona?: string; warnings: string[]; reason: string; uncertainty?: { distribution: Readonly<Record<string,number>>; confidence: number; margin: number }; risks?: { touches_security: number; is_destructive: number }; complexity?: number }
const probability = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
/** Pure additive advice. No execution, no process/budget/permission writes. */
export function triageAdvice(result: System1Result, input: TriageInput, profile?: TriageProfile): TriageAdvice {
 const fail = (status: string, reason = status): TriageAdvice => ({ status, reason, warnings: [] });
 if (result.status !== "ok") return fail(result.status, "reason" in result ? result.reason : result.status);
 if (!input.complete) return fail("insufficient_evidence");
 const { answers, metadata } = result.evaluation;
 if (metadata.questionSetVersion !== TRIAGE_VERSION || answers.length !== 4 || new Set(answers.map(a => a.questionId)).size !== 4) return fail("insufficient_evidence", "invalid_answers");
 const persona = answers.find(a => a.questionId === "persona"), complexity = answers.find(a => a.questionId === "complexity"), security = answers.find(a => a.questionId === "touches_security"), destructive = answers.find(a => a.questionId === "is_destructive");
 if (persona?.type !== "choice" || complexity?.type !== "ordinal" || security?.type !== "predicate" || destructive?.type !== "predicate") return fail("insufficient_evidence", "invalid_types");
 const keys = [...input.candidates.filter(c => !c.excluded).map(c => c.name), "none"];
 if (keys.length < 2 || keys.slice(0,-1).some(k => !/^[a-z][a-z0-9_-]*$/i.test(k) || k.toLowerCase() === "none") || new Set(keys.map(k=>k.toLowerCase())).size !== keys.length) return fail("insufficient_evidence", "invalid_candidates");
 const distribution = persona.uncertainty.distribution, confidence = persona.uncertainty.confidence;
 if (!distribution || !probability(confidence) || Object.keys(distribution).length !== keys.length || !keys.every(k => Object.hasOwn(distribution,k) && probability(distribution[k])) || Math.abs(Object.values(distribution).reduce((a,b) => a+b,0)-1) > 1e-6 || !keys.includes(persona.value) || !probability(security.probabilityTrue) || !probability(destructive.probabilityTrue) || !Number.isFinite(complexity.value) || complexity.value < 0 || complexity.value > 2 || JSON.stringify(complexity.levels) !== JSON.stringify(TRIAGE_LEVELS)) return fail("insufficient_evidence", "invalid_uncertainty");
 const ranked = Object.entries(distribution).sort((a,b) => b[1]-a[1]);
 if (distribution[persona.value] !== ranked[0][1]) return fail("insufficient_evidence", "inconsistent_choice");
 const margin = ranked[0][1]-ranked[1][1];
 const observed = { uncertainty: { distribution, confidence, margin }, risks: { touches_security: security.probabilityTrue, is_destructive: destructive.probabilityTrue }, complexity: complexity.value };
 if (!validProfile(profile) || profile.provider !== metadata.provider || profile.model !== metadata.requestedModel || profile.model !== metadata.returnedModel || !profile.languages.includes(input.language) || !profile.domains.includes(input.domain)) return { ...fail("uncalibrated"), ...observed };
 const warnings: string[] = [];
 if (security.probabilityTrue >= profile.securityThreshold) warnings.push("consider_security_review");
 if (destructive.probabilityTrue >= profile.destructiveThreshold) warnings.push("consider_human_confirmation");
 if (complexity.value === 2) warnings.push("consider_decomposition");
 const status = persona.value === "none" ? "abstain" : confidence < profile.minConfidence || margin < profile.minMargin ? "needs_judgment" : "suggest_persona";
 return { status, reason: status, ...(status === "suggest_persona" ? { persona: persona.value } : {}), warnings, ...observed };
}
