export const RECOVERY_CATEGORIES = [
	"busy",
	"invalid_input",
	"resource_exhausted",
	"operator_cancelled",
	"verification_failed",
	"tool_protocol_error",
	"unknown_tool",
	"indeterminate",
] as const;

export type RecoveryCategory = (typeof RECOVERY_CATEGORIES)[number];
export type RecoveryNextStep = "refuse" | "correct_and_reinvoke" | "reinvoke_after_change" | "authorize_once_and_reinvoke";

export interface RecoveryConditions {
	explicitInvocation?: boolean;
	relevantConditionsChanged?: boolean;
	executorIdle?: boolean;
	freshOneUseAuthorization?: boolean;
	toolStateChanged?: boolean;
	effectsEstablished?: boolean;
	processSettled?: boolean;
	indeterminateGrantUsed?: boolean;
}

export interface RecoveryDecision {
	category: RecoveryCategory;
	allowed: boolean;
	nextStep: RecoveryNextStep;
	budget: "existing_budgets";
	automaticRetry: false;
	waitOrQueue: false;
	reason: string;
}

/**
 * One fail-closed recovery policy shared by no-progress and later protocol slices.
 * It deliberately owns no counters: every allowed invocation still passes through
 * the Hub's existing turn/task budgets.
 */
export function recoveryDecision(category: RecoveryCategory, conditions: RecoveryConditions = {}): RecoveryDecision {
	const base = { category, budget: "existing_budgets" as const, automaticRetry: false as const, waitOrQueue: false as const };
	const explicit = conditions.explicitInvocation === true;
	const changed = conditions.relevantConditionsChanged === true;
	switch (category) {
		case "busy":
			return { ...base, allowed: explicit && changed && conditions.executorIdle === true, nextStep: "reinvoke_after_change", reason: "executor must be observed idle before an explicit re-invocation" };
		case "invalid_input":
			return { ...base, allowed: explicit && changed, nextStep: "correct_and_reinvoke", reason: "validated inputs must be materially corrected" };
		case "resource_exhausted":
			return { ...base, allowed: explicit && changed, nextStep: "reinvoke_after_change", reason: "resource conditions must be evidenced as changed; no fallback is authorized" };
		case "operator_cancelled":
			return { ...base, allowed: explicit && conditions.freshOneUseAuthorization === true, nextStep: "authorize_once_and_reinvoke", reason: "operator cancellation requires fresh one-use authorization for this agent" };
		case "verification_failed":
			return { ...base, allowed: explicit && changed, nextStep: "correct_and_reinvoke", reason: "the checked state or evidence must have changed" };
		case "tool_protocol_error":
			return { ...base, allowed: explicit && changed && conditions.effectsEstablished === true, nextStep: "correct_and_reinvoke", reason: "requires the T3 trusted event/readback effects artifact plus corrected conditions; /af-retry cannot authorize this failure and already-observed effects must not be replayed blindly" };
		case "unknown_tool":
			return { ...base, allowed: explicit && changed && conditions.toolStateChanged === true, nextStep: "correct_and_reinvoke", reason: "the effective tool catalog must have trusted runtime change evidence; /af-retry and prose cannot authorize this failure" };
		case "indeterminate":
			return { ...base, allowed: explicit && conditions.executorIdle === true && conditions.processSettled === true && conditions.freshOneUseAuthorization === true && conditions.indeterminateGrantUsed === true, nextStep: "authorize_once_and_reinvoke", reason: "one human-authorized retry only after the old process is settled and the executor idle; partial side effects may exist and retry may duplicate them" };
	}
}

export function recoveryCategoryFromDetails(details: any): RecoveryCategory | null {
	if (!details || typeof details !== "object") return null;
	if (RECOVERY_CATEGORIES.includes(details.recoveryCategory as RecoveryCategory)) return details.recoveryCategory as RecoveryCategory;
	const values = [details.status, details.acceptanceStatus, details.reason, details.diagnostics?.reason, details.termination?.reason]
		.filter((value): value is string => typeof value === "string")
		.map(value => value.toLowerCase());
	if (values.some(value => value === "busy")) return "busy";
	if (values.some(value => value.includes("operator_cancel") || value === "cancelled" || value === "canceled")) return "operator_cancelled";
	if (values.some(value => value.includes("invalid_input") || value.includes("validation"))) return "invalid_input";
	if (values.some(value => value.includes("resource_exhausted") || value.includes("out_of_memory") || value === "oom")) return "resource_exhausted";
	if (values.some(value => value.includes("verification_failed") || value.includes("deliverable_failed"))) return "verification_failed";
	if (values.some(value => value.includes("tool_protocol_error"))) return "tool_protocol_error";
	if (values.some(value => value.includes("unknown_tool"))) return "unknown_tool";
	const failed = typeof details.exitCode === "number" && details.exitCode !== 0;
	return failed ? "indeterminate" : null;
}
