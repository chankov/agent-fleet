import assert from "node:assert/strict";
import test from "node:test";
import { chooseReviewerRerun } from "./rerun-policy.ts";

test("a narrow adapter fix gets an independent focused rerun", () => {
	const decision = chooseReviewerRerun({
		impact: "narrow",
		sharedCode: false,
		selector: "adapter",
		flaky: false,
		policyMandate: false,
		builderPassed: true,
	});
	assert.equal(decision.mode, "focused");
	assert.equal(decision.selector, "adapter");
	assert.equal(decision.independent, true);
	assert.match(decision.reason, /independent focused rerun/);
});

test("shared transport or error handling requires the full regression suite", () => {
	const decision = chooseReviewerRerun({
		impact: "wide",
		sharedCode: true,
		selector: "transport",
		flaky: false,
		policyMandate: false,
		builderPassed: true,
		area: "shared transport/error handling",
	});
	assert.equal(decision.mode, "full");
	assert.match(decision.reason, /shared/);
});

test("unclear selector, flaky signal, or policy mandate also require the full suite", () => {
	for (const extra of [{ selector: "" }, { flaky: true }, { policyMandate: true }]) {
		assert.equal(chooseReviewerRerun({
			impact: "narrow",
			sharedCode: false,
			selector: "adapter",
			flaky: false,
			policyMandate: false,
			builderPassed: true,
			...extra,
		}).mode, "full");
	}
});

test("time saved is not a reason to lower the suite, and builder PASS is not enough", () => {
	const saved = chooseReviewerRerun({
		impact: "wide",
		sharedCode: true,
		selector: "transport",
		flaky: false,
		policyMandate: false,
		builderPassed: true,
		timeSavedMs: 900,
	});
	assert.equal(saved.mode, "full");
	assert.doesNotMatch(saved.reason, /time saved/i);
	const trusted = chooseReviewerRerun({
		impact: "narrow",
		sharedCode: false,
		selector: "adapter",
		flaky: false,
		policyMandate: false,
		builderPassed: true,
		reviewerRan: false,
	});
	assert.equal(trusted.accepted, false);
});
