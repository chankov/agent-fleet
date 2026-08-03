import test from "node:test";
import assert from "node:assert/strict";

import { checkExternalBlockerGate, externalBlockedProtocol, extractExternalBlockers } from "./external-blocker.js";

test("extractExternalBlockers pulls markers out of a specialist return", () => {
	const output = [
		"Implemented the provider change.",
		"EXTERNAL_BLOCKED: Application Insights has no correlation destination for per-key reads; owned by the Azure subscription admin",
		"Tests: 126 passed.",
	].join("\n");
	assert.deepEqual(extractExternalBlockers(output), [
		"Application Insights has no correlation destination for per-key reads; owned by the Azure subscription admin",
	]);
});

test("extractExternalBlockers is case-insensitive, trims, and de-duplicates", () => {
	const output = "external_blocked:  missing deploy credential \nEXTERNAL_BLOCKED: missing deploy credential";
	assert.deepEqual(extractExternalBlockers(output), ["missing deploy credential"]);
});

test("extractExternalBlockers ignores prose that merely mentions the marker", () => {
	assert.deepEqual(extractExternalBlockers("the agent may emit EXTERNAL_BLOCKED: when stuck (see docs)"), []);
	assert.deepEqual(extractExternalBlockers(""), []);
	assert.deepEqual(extractExternalBlockers(undefined), []);
});

test("no blockers means no gate", () => {
	assert.equal(checkExternalBlockerGate({ blockers: [], acknowledged: false, askUserAvailable: true }), null);
	assert.equal(checkExternalBlockerGate(undefined), null);
});

test("an unacknowledged blocker refuses the next dispatch with an owner packet", () => {
	const gate = checkExternalBlockerGate({
		blockers: [{ agent: "builder", what: "no telemetry destination" }],
		acknowledged: false,
		askUserAvailable: true,
	});
	assert.equal(gate.reason, "external_blocked");
	assert.match(gate.message, /no telemetry destination/);
	assert.match(gate.message, /builder/);
	assert.match(gate.message, /NOT counted against any budget/);
	assert.match(gate.message, /Owner escalation packet/);
	assert.match(gate.message, /waive the assertion as UNPROVEN/);
});

test("the gate names the specific anti-pattern it exists to stop", () => {
	const gate = checkExternalBlockerGate({ blockers: [{ what: "x" }], acknowledged: false, askUserAvailable: true });
	assert.match(gate.message, /Do NOT route around this/);
	assert.match(gate.message, /manifests, fixtures/);
});

test("acknowledging the blocker opens the gate", () => {
	const state = { blockers: [{ what: "x" }], acknowledged: true, askUserAvailable: true };
	assert.equal(checkExternalBlockerGate(state), null);
});

test("with ask_user available the gate keeps firing until the human is addressed", () => {
	const state = { blockers: [{ what: "x" }], acknowledged: false, askUserAvailable: true, refusedOnce: true };
	assert.ok(checkExternalBlockerGate(state), "a repeated refusal is correct while the human is reachable");
	assert.match(checkExternalBlockerGate(state).message, /The gate opens as soon as you do/);
});

test("without ask_user the gate fires exactly once so the session cannot deadlock", () => {
	const first = checkExternalBlockerGate({ blockers: [{ what: "x" }], acknowledged: false, askUserAvailable: false, refusedOnce: false });
	assert.ok(first);
	assert.match(first.message, /ask_user` is unavailable/);
	assert.match(first.message, /fires once/);
	const second = checkExternalBlockerGate({ blockers: [{ what: "x" }], acknowledged: false, askUserAvailable: false, refusedOnce: true });
	assert.equal(second, null);
});

test("the injected protocol tells specialists to stop rather than substitute", () => {
	const protocol = externalBlockedProtocol();
	assert.match(protocol, /EXTERNAL_BLOCKED: <what is missing/);
	assert.match(protocol, /do NOT build a substitute/);
	assert.match(protocol, /report what you DID\n {2}prove/);
});
