import assert from "node:assert/strict";
import test from "node:test";

import {
	compactPosture,
	executionPairBlockedByRoster,
	parseWorkModeArgs,
	posturePickerOptions,
	selectedPickerValue,
} from "./execution-profile.ts";

test("work-mode arguments select posture, with deprecated fast/standard/strict aliases", () => {
	assert.deepEqual(parseWorkModeArgs(""), { ok: true, action: "picker" });
	assert.deepEqual(parseWorkModeArgs("  "), { ok: true, action: "picker" });
	assert.deepEqual(parseWorkModeArgs("operator"), { ok: true, action: "apply", posture: "operator" });
	assert.deepEqual(parseWorkModeArgs(" Orchestrator "), { ok: true, action: "apply", posture: "orchestrator" });
	assert.deepEqual(parseWorkModeArgs("fast"), { ok: true, action: "apply", posture: "operator", deprecatedFrom: "fast" });
	assert.deepEqual(parseWorkModeArgs("standard"), { ok: true, action: "apply", posture: "orchestrator", deprecatedFrom: "standard" });
	assert.deepEqual(parseWorkModeArgs("strict"), { ok: true, action: "apply", posture: "orchestrator", deprecatedFrom: "strict" });
	const invalid = parseWorkModeArgs("turbo");
	assert.equal(invalid.ok, false);
	if (!invalid.ok) assert.match(invalid.error, /operator or orchestrator/);
	assert.equal(parseWorkModeArgs("fast orchestrator").ok, false);
	assert.equal(parseWorkModeArgs("advanced").ok, false);
});

test("posture picker marks the current choice", () => {
	const postures = posturePickerOptions("operator");
	assert.match(postures.title, /Alt\+M/);
	assert.match(postures.options[0], /^✓ operator/);
	assert.match(postures.options[1], /requires a native roster/);
	assert.equal(selectedPickerValue(postures.options, postures.options[1], postures.postures), "orchestrator");
	assert.equal(selectedPickerValue(postures.options, undefined, postures.postures), undefined);
	assert.equal(compactPosture("orchestrator"), "Orchestrator");
});

test("roster validation blocks only a posture change onto orchestrator", () => {
	assert.equal(executionPairBlockedByRoster("operator", "orchestrator", 0), true);
	assert.equal(executionPairBlockedByRoster("operator", "orchestrator", 1), false);
	assert.equal(executionPairBlockedByRoster("orchestrator", "orchestrator", 0), false);
	assert.equal(executionPairBlockedByRoster("orchestrator", "operator", 0), false);
	assert.equal(executionPairBlockedByRoster("operator", "operator", 0), false);
});
