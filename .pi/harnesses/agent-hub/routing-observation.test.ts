import assert from "node:assert/strict";
import test from "node:test";
import { recordRoutingObservation } from "./routing-observation.ts";

test("observation keeps task class, model, and outcome without inventing a split", () => {
	const record = recordRoutingObservation({
		taskClass: "narrow-plan-driven",
		model: "openai/gpt-5.5",
		wallMs: 1200,
		retries: 0,
		refusals: 0,
		contractCompliant: true,
		accepted: true,
	});
	assert.equal(record.taskClass, "narrow-plan-driven");
	assert.equal(record.model, "openai/gpt-5.5");
	assert.equal(record.wallMs, 1200);
	assert.equal(record.toolTestMs, "unknown");
	assert.equal(record.missingDimensions.includes("toolTestMs"), true);
	assert.equal(record.routingChanged, false);
});

test("private payloads and secrets are dropped", () => {
	const record = recordRoutingObservation({
		taskClass: "narrow-plan-driven",
		model: "openai/gpt-5.5",
		wallMs: 10,
		retries: 1,
		refusals: 0,
		contractCompliant: false,
		accepted: false,
		payload: "token sk-live-secret file body",
	});
	assert.equal("payload" in record, false);
	assert.equal(JSON.stringify(record).includes("sk-live"), false);
});
