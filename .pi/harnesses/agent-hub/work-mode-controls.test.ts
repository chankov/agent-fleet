import assert from "node:assert/strict";
import test from "node:test";

import {
	compactWorkMode,
	workModeChangeBlockedByRoster,
	parseWorkModeArgs,
	workModePickerOptions,
	selectedPickerValue,
} from "./work-mode-controls.ts";

test("work-mode arguments accept only operator or orchestrator", () => {
	assert.deepEqual(parseWorkModeArgs(""), { ok: true, action: "picker" });
	assert.deepEqual(parseWorkModeArgs("  "), { ok: true, action: "picker" });
	assert.deepEqual(parseWorkModeArgs("operator"), { ok: true, action: "apply", workMode: "operator" });
	assert.deepEqual(parseWorkModeArgs(" Orchestrator "), { ok: true, action: "apply", workMode: "orchestrator" });
	for (const value of ["fast", "standard", "strict", "turbo", "operator orchestrator"]) {
		const invalid = parseWorkModeArgs(value);
		assert.equal(invalid.ok, false);
		if (!invalid.ok) assert.match(invalid.error, /operator or orchestrator/);
	}
});

test("work-mode picker marks the current choice", () => {
	const workModes = workModePickerOptions("operator");
	assert.match(workModes.title, /Alt\+M/);
	assert.match(workModes.options[0], /^✓ operator/);
	assert.match(workModes.options[1], /requires a native roster/);
	assert.equal(selectedPickerValue(workModes.options, workModes.options[1], workModes.workModes), "orchestrator");
	assert.equal(selectedPickerValue(workModes.options, undefined, workModes.workModes), undefined);
	assert.equal(compactWorkMode("orchestrator"), "Orchestrator");
});

test("roster validation blocks only a work-mode change onto orchestrator", () => {
	assert.equal(workModeChangeBlockedByRoster("operator", "orchestrator", 0), true);
	assert.equal(workModeChangeBlockedByRoster("operator", "orchestrator", 1), false);
	assert.equal(workModeChangeBlockedByRoster("orchestrator", "orchestrator", 0), false);
	assert.equal(workModeChangeBlockedByRoster("orchestrator", "operator", 0), false);
	assert.equal(workModeChangeBlockedByRoster("operator", "operator", 0), false);
});
