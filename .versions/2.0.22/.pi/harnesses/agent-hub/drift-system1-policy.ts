import { WATCHDOG_QUESTIONS_VERSION, WATCHDOG_STATE_VERSION, classifyStatusAnswer, type WatchdogStateBuild } from "./drift-system1.ts";
import type { System1Result } from "../lib/system1/contracts.ts";

export const WATCHDOG_POLICY_VERSION = "watchdog-policy/v1";
export interface AcceptedWatchdogProfile {
 readonly policyVersion: typeof WATCHDOG_POLICY_VERSION;
 readonly stateVersion: typeof WATCHDOG_STATE_VERSION;
 readonly questionsVersion: typeof WATCHDOG_QUESTIONS_VERSION;
 readonly provider: "typesafe";
 readonly model: "jev-1.13.0";
 readonly rules: readonly string[];
 readonly minConfidence: number;
 readonly maxContradiction: number;
}
export interface PolicyDecision { action: "continue" | "llm" | "discard"; reason: string; source: "system1" | "none" }
const fallback = (reason: string): PolicyDecision => ({ action: "llm", reason, source: "none" });
/** No stop result exists. A config string cannot supply or approve a profile. */
export function decideSystem1(result: System1Result | unknown, snapshot: { live: boolean; rule: string; state: WatchdogStateBuild; requestedModel: string }, profile: AcceptedWatchdogProfile | null): PolicyDecision {
 if (!snapshot.live) return { action: "discard", reason: "stale_attempt", source: "none" };
 if (!profile) return fallback("calibration_required");
 if (profile.policyVersion !== WATCHDOG_POLICY_VERSION || profile.stateVersion !== WATCHDOG_STATE_VERSION || profile.questionsVersion !== WATCHDOG_QUESTIONS_VERSION || !profile.rules.includes(snapshot.rule)) return fallback("profile_mismatch");
 if (!snapshot.state.ok || snapshot.state.state.coverage.shortcut_blocked || snapshot.state.state.signal.rule !== snapshot.rule) return fallback("incomplete_state");
 if (!Number.isFinite(profile.minConfidence) || profile.minConfidence < 0 || profile.minConfidence > 1 || !Number.isFinite(profile.maxContradiction) || profile.maxContradiction < 0 || profile.maxContradiction > 1) return fallback("invalid_profile");
 if (!result || typeof result !== "object" || (result as System1Result).status !== "ok") return fallback("provider_unavailable");
 const evaluation = (result as Extract<System1Result, { status: "ok" }>).evaluation;
 if (evaluation.metadata.provider !== profile.provider || evaluation.metadata.requestedModel !== snapshot.requestedModel || evaluation.metadata.requestedModel !== profile.model || evaluation.metadata.returnedModel !== profile.model || evaluation.metadata.questionSetVersion !== profile.questionsVersion) return fallback("model_mismatch");
 const answers = evaluation.answers;
 if (!Array.isArray(answers) || answers.length !== 4 || new Set(answers.map(a => a.questionId)).size !== 4) return fallback("missing_answers");
 const status = answers.find(a => a.questionId === "status");
 const classified = classifyStatusAnswer(status);
 if (!classified.usable || classified.value !== "on_track" || classified.provenance !== "provider" || status?.type !== "choice") return fallback("not_on_track");
 const { confidence, distribution } = status.uncertainty;
 if (confidence! < profile.minConfidence || !distribution || Object.values(distribution).some(v => !Number.isFinite(v) || v < 0 || v > 1) || distribution.on_track < profile.minConfidence || Math.abs(Object.values(distribution).reduce((a, b) => a + b, 0) - 1) > 0.02) return fallback("low_confidence");
 for (const id of ["repeating", "outside_task", "trail_carries_instructions"]) {
  const answer = answers.find(a => a.questionId === id);
  if (answer?.type !== "predicate" || answer.uncertainty?.provenance !== "provider" || !Number.isFinite(answer.probabilityTrue) || answer.probabilityTrue < 0 || answer.probabilityTrue > profile.maxContradiction) return fallback(`contradiction_${id}`);
 }
 return { action: "continue", reason: "accepted_on_track", source: "system1" };
}
