import assert from "node:assert/strict";
import test from "node:test";
import { proposeRoutingPolicy, rollbackRoutingPolicy, shadowCompare } from "./routing-proposal.ts";

test("a numeric rule stays a shadow proposal until maintainer approval", () => {
	const proposal = proposeRoutingPolicy({
		taskClass: "narrow-plan-driven",
		model: "openai/gpt-5.5",
		maxWallMs: 600,
		previousModel: "openai/gpt-5.4",
	});
	assert.equal(proposal.active, false);
	assert.equal(proposal.fallback, false);
	assert.equal(proposal.acceptanceWeakened, false);
	assert.equal(proposal.requiresApproval, true);
	assert.equal(proposal.shadowCompared, true);
});

test("shadow comparison refuses activation without same-class observations", () => {
	const proposal = proposeRoutingPolicy({ taskClass: "narrow-plan-driven", model: "openai/gpt-5.5", maxWallMs: 600, previousModel: "openai/gpt-5.4" });
	assert.equal(shadowCompare(proposal, []).activate, false);
	assert.match(shadowCompare(proposal, [{ taskClass: "other", toolTestMs: "unknown" }]).reason, /same task class/);
});

test("rollback restores the previous model and keeps evidence", () => {
	const proposal = proposeRoutingPolicy({
		taskClass: "narrow-plan-driven",
		model: "openai/gpt-5.5",
		maxWallMs: 600,
		previousModel: "openai/gpt-5.4",
		evidenceRef: "artifacts/evidence/routing.json",
	});
	const rolled = rollbackRoutingPolicy(proposal);
	assert.equal(rolled.model, "openai/gpt-5.4");
	assert.equal(rolled.active, false);
	assert.equal(rolled.evidenceRef, "artifacts/evidence/routing.json");
});
