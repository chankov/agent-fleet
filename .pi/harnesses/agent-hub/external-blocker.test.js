import test from "node:test";
import assert from "node:assert/strict";

import { checkExternalBlockerGate, confirmsExternalBlockerInChat, externalBlockedProtocol, extractExternalBlockers } from "./external-blocker.js";

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
	const gate = checkExternalBlockerGate(state);
	assert.ok(gate, "a repeated refusal is correct while the human is reachable");
	assert.match(gate.message, /Call `ask_user`.*Wait for the human's explicit answer/);
});

test("without ask_user repeated attempts wait for the addressed human chat reply", () => {
	const first = checkExternalBlockerGate({ blockers: [{ what: "x" }], acknowledged: false, askUserAvailable: false, refusedOnce: false });
	assert.ok(first);
	assert.match(first.message, /ask_user` is unavailable/);
	assert.match(first.message, /in chat and wait for the human's explicit answer/);
	assert.match(first.message, /this exact line/);
	const second = checkExternalBlockerGate({ blockers: [{ what: "x" }], acknowledged: false, askUserAvailable: false, refusedOnce: true });
	assert.ok(second);
});

test("the injected protocol tells specialists to stop rather than substitute", () => {
	const protocol = externalBlockedProtocol();
	assert.match(protocol, /EXTERNAL_BLOCKED: <what is missing/);
	assert.match(protocol, /do NOT build a substitute/);
	assert.match(protocol, /report what you DID\n {2}prove/);
});

test('internal registration failures do not latch unrelated delegation, including restored blockers',()=>{
 for(const what of ['damage_physical_registration_unavailable','damage_transport_unavailable','optional assessment transport or registration failed']){
  assert.deepEqual(extractExternalBlockers(`EXTERNAL_BLOCKED: ${what}`),[]);
  assert.equal(checkExternalBlockerGate({blockers:[{what}],acknowledged:false,askUserAvailable:true}),null);
 }
 assert.ok(checkExternalBlockerGate({blockers:[{what:'human denied secret access'}],acknowledged:false,askUserAvailable:true}));
 assert.ok(checkExternalBlockerGate({blockers:[{what:'damage_transport_unavailable'},{what:'missing production deployment credentials'}],askUserAvailable:true}));
});

test("only a human chat answer to the current blocker packet confirms resolution", () => {
	const marker = "[[external-blocker:current]]";
	for (const source of ["interactive", "rpc"]) {
		assert.equal(confirmsExternalBlockerInChat({ source, text: `Confirm ${marker}` }, marker), true);
		assert.equal(confirmsExternalBlockerInChat({ source, text: `Confirm ${marker}\r\nUse the staging endpoint.` }, marker), true);
		for (const text of ["continue", "please update me", "Confirm [[external-blocker:older]]\nstale", `Cancel ${marker}`, `Status update\nConfirm ${marker}`, `Confirm ${marker} perhaps`]) {
			assert.equal(confirmsExternalBlockerInChat({ source, text }, marker), false);
		}
	}
	assert.equal(confirmsExternalBlockerInChat({ source: "extension", text: `Confirm ${marker}` }, marker), false);
});
