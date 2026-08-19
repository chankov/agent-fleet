import assert from "node:assert/strict";
import test from "node:test";

import {
	capabilityConfirmationContext,
	capabilityConfirmationPack,
	capabilityConfirmationQuestion,
	confirmationGate,
	confirmationOutcome,
	type CapabilityConfirmationState,
} from "./capability-confirmation.ts";

for (const pack of ["fleet", "peer", "workspace"] as const) {
	test(`provisional ${pack} refuses its first side effect, promotes once confirmed, and remains available`, () => {
		const state: CapabilityConfirmationState = {};
		const first = confirmationGate(state, pack, true);
		assert.equal(first.allowed, false);
		if (!first.allowed) {
			assert.equal(first.status, "ask");
			assert.match(first.message, /ask_user/);
		}
		state[pack] = "pending";
		const pending = confirmationGate(state, pack, true);
		assert.deepEqual(pending, {
			allowed: false,
			status: "pending",
			message: `provisional ${pack} capability awaits its single human confirmation; do not repeat the question or side effect.`,
		});
		state[pack] = "promoted";
		assert.deepEqual(confirmationGate(state, pack, true), { allowed: true });
	});

	test(`provisional ${pack} rejection and cancellation leave its side effect blocked`, () => {
		for (const result of [
			{ details: { response: { kind: "selection", selections: ["Reject"] }, cancelled: false } },
			{ details: { response: null, cancelled: true } },
		]) {
			assert.equal(confirmationOutcome(result), "declined");
			const state: CapabilityConfirmationState = { [pack]: "declined" };
			const refusal = confirmationGate(state, pack, true);
			assert.equal(refusal.allowed, false);
			if (!refusal.allowed) assert.equal(refusal.status, "declined");
		}
	});
}

test("confirmation marker is typed, compact, and never parses arbitrary answer prose", () => {
	const question = capabilityConfirmationQuestion("peer");
	assert.equal(capabilityConfirmationPack(question.context), "peer");
	assert.equal(capabilityConfirmationPack("please confirm fleet"), null);
	assert.deepEqual(question.options, ["Confirm", "Reject", "Cancel"]);
	assert.equal(confirmationOutcome({ details: { response: { text: "yes please" }, cancelled: false } }), null);
});
