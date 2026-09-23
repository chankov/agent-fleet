import assert from "node:assert/strict";
import test from "node:test";
import { RECOVERY_CATEGORIES, recoveryCategoryFromDetails, recoveryDecision } from "./recovery-contract.ts";

test("shared recovery contract covers every T1 category without retry, waiting, or a new budget", () => {
	assert.deepEqual(RECOVERY_CATEGORIES, ["busy", "invalid_input", "resource_exhausted", "operator_cancelled", "verification_failed", "tool_protocol_error", "unknown_tool", "indeterminate"]);
	for (const category of RECOVERY_CATEGORIES) {
		const decision = recoveryDecision(category);
		assert.equal(decision.automaticRetry, false);
		assert.equal(decision.waitOrQueue, false);
		assert.equal(decision.budget, "existing_budgets");
		assert.equal(decision.allowed, false);
	}
});

test("recovery permits only explicit evidenced conditions and keeps special safeguards", () => {
	assert.equal(recoveryDecision("busy", { explicitInvocation: true, relevantConditionsChanged: true, executorIdle: true }).allowed, true);
	for (const category of ["invalid_input", "resource_exhausted", "verification_failed"] as const) {
		assert.equal(recoveryDecision(category, { explicitInvocation: true, relevantConditionsChanged: true }).allowed, true);
	}
	assert.equal(recoveryDecision("operator_cancelled", { explicitInvocation: true, relevantConditionsChanged: true }).allowed, false);
	assert.equal(recoveryDecision("operator_cancelled", { explicitInvocation: true, freshOneUseAuthorization: true }).allowed, true);
	assert.equal(recoveryDecision("tool_protocol_error", { explicitInvocation: true, relevantConditionsChanged: true }).allowed, false);
	assert.equal(recoveryDecision("tool_protocol_error", { explicitInvocation: true, relevantConditionsChanged: true, effectsEstablished: true }).allowed, true);
	assert.equal(recoveryDecision("unknown_tool", { explicitInvocation: true, relevantConditionsChanged: true }).allowed, false);
	assert.equal(recoveryDecision("unknown_tool", { explicitInvocation: true, relevantConditionsChanged: true, toolStateChanged: true }).allowed, true);
	assert.equal(recoveryDecision("indeterminate", { explicitInvocation: true, relevantConditionsChanged: true, freshOneUseAuthorization: true }).allowed, false);
	assert.equal(recoveryDecision("indeterminate", { explicitInvocation: true, executorIdle: true, processSettled: true, freshOneUseAuthorization: true, indeterminateGrantUsed: true }).allowed, true);
});

test("execution details classify parent cancellation separately from child and verification failures", () => {
	assert.equal(recoveryCategoryFromDetails({ status: "cancelled", exitCode: 1 }), "operator_cancelled");
	assert.equal(recoveryCategoryFromDetails({ status: "error", diagnostics: { reason: "assistant_error" }, exitCode: 1 }), "indeterminate");
	assert.equal(recoveryCategoryFromDetails({ status: "verification_failed", exitCode: 1 }), "verification_failed");
	assert.equal(recoveryCategoryFromDetails({ status: "completed_unverified", acceptanceStatus: "deliverable_failed", exitCode: 0 }), "verification_failed");
	assert.equal(recoveryCategoryFromDetails({ status: "unknown_tool", exitCode: 1 }), "unknown_tool");
	assert.equal(recoveryCategoryFromDetails({ status: "done", exitCode: 0 }), null);
});
