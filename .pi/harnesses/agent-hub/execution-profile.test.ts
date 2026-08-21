import assert from "node:assert/strict";
import test from "node:test";

import {
	ALL_EXECUTION_PAIRS,
	advancedProfileOptions,
	classifyExecutionProfile,
	compactExecutionPair,
	executionPairBlockedByRoster,
	executionProfileLabel,
	hubModePickerOptions,
	parseWorkModeArgs,
	posturePickerOptions,
	RECOMMENDED_PROFILES,
	recommendedProfileById,
	recommendedProfileOptions,
	selectedPickerValue,
	type ExecutionPair,
} from "./execution-profile.ts";

test("recommended profiles map fast/standard/strict onto the agreed pairs", () => {
	assert.deepEqual(
		RECOMMENDED_PROFILES.map(profile => ({ id: profile.id, mode: profile.mode, posture: profile.posture })),
		[
			{ id: "fast", mode: "fast", posture: "operator" },
			{ id: "standard", mode: "standard", posture: "orchestrator" },
			{ id: "strict", mode: "strict", posture: "orchestrator" },
		],
	);
	assert.equal(recommendedProfileById("fast")?.label, "Fast Operator");
	assert.equal(recommendedProfileById("standard")?.label, "Standard Orchestrator");
	assert.equal(recommendedProfileById("strict")?.label, "Strict Orchestrator");
	assert.equal(recommendedProfileById("turbo"), null);
});

test("advanced enumeration covers all six mode/posture pairs without rewriting custom ones", () => {
	assert.equal(ALL_EXECUTION_PAIRS.length, 6);
	assert.deepEqual(
		ALL_EXECUTION_PAIRS.map(pair => `${pair.mode}/${pair.posture}`),
		["fast/operator", "fast/orchestrator", "standard/operator", "standard/orchestrator", "strict/operator", "strict/orchestrator"],
	);
	assert.equal(classifyExecutionProfile({ mode: "fast", posture: "operator" }).kind, "recommended");
	assert.deepEqual(classifyExecutionProfile({ mode: "fast", posture: "orchestrator" }), {
		kind: "custom",
		label: "Fast Orchestrator",
		pair: { mode: "fast", posture: "orchestrator" },
	});
	assert.equal(classifyExecutionProfile({ mode: "standard", posture: "operator" }).kind, "custom");
	assert.equal(classifyExecutionProfile({ mode: "strict", posture: "operator" }).kind, "custom");
	assert.equal(executionProfileLabel({ mode: "strict", posture: "orchestrator" }), "Strict Orchestrator");
});

test("work-mode arguments select recommended profiles, advanced, or an explicit pair", () => {
	assert.deepEqual(parseWorkModeArgs(""), { ok: true, action: "picker" });
	assert.deepEqual(parseWorkModeArgs("  "), { ok: true, action: "picker" });
	assert.deepEqual(parseWorkModeArgs("fast"), { ok: true, action: "apply", pair: { mode: "fast", posture: "operator" } });
	assert.deepEqual(parseWorkModeArgs(" Standard "), { ok: true, action: "apply", pair: { mode: "standard", posture: "orchestrator" } });
	assert.deepEqual(parseWorkModeArgs("strict"), { ok: true, action: "apply", pair: { mode: "strict", posture: "orchestrator" } });
	assert.deepEqual(parseWorkModeArgs("advanced"), { ok: true, action: "advanced" });
	assert.deepEqual(parseWorkModeArgs("fast orchestrator"), { ok: true, action: "apply", pair: { mode: "fast", posture: "orchestrator" } });
	assert.deepEqual(parseWorkModeArgs("strict operator"), { ok: true, action: "apply", pair: { mode: "strict", posture: "operator" } });
	const invalid = parseWorkModeArgs("turbo");
	assert.equal(invalid.ok, false);
	if (!invalid.ok) assert.match(invalid.error, /fast, standard, strict, advanced/);
	const invalidPair = parseWorkModeArgs("fast builder");
	assert.equal(invalidPair.ok, false);
	const extra = parseWorkModeArgs("fast operator now");
	assert.equal(extra.ok, false);
});

test("picker options mark the current recommended or custom pair without normalizing it", () => {
	const recommended = recommendedProfileOptions({ mode: "fast", posture: "operator" });
	assert.equal(recommended.title, "Execution profile — Alt+M");
	assert.equal(recommended.options.length, 4);
	assert.match(recommended.options[0], /^✓ Fast Operator/);
	assert.match(recommended.options[1], /^ {2}Standard Orchestrator/);
	assert.match(recommended.options[3], /^ {2}Advanced… — Choose any mode\/posture combination/);
	assert.deepEqual(recommended.keys, ["fast", "standard", "strict", "advanced"]);

	const custom: ExecutionPair = { mode: "fast", posture: "orchestrator" };
	const customOptions = recommendedProfileOptions(custom);
	assert.match(customOptions.options[0], /^ {2}Fast Operator/);
	assert.match(customOptions.options[3], /Advanced… \(Fast·Orchestrator\)/);
	assert.equal(classifyExecutionProfile(custom).kind, "custom");

	const advanced = advancedProfileOptions(custom);
	assert.equal(advanced.pairs.length, 6);
	assert.match(advanced.options[1], /^✓ Fast Orchestrator/);
	assert.equal(selectedPickerValue(advanced.options, advanced.options[1], advanced.pairs)?.posture, "orchestrator");
	assert.equal(selectedPickerValue(advanced.options, undefined, advanced.pairs), undefined);
});

test("axis pickers and compact labels keep mode and posture independent", () => {
	const modes = hubModePickerOptions("standard");
	assert.match(modes.options[1], /^✓ standard/);
	assert.deepEqual(modes.modes, ["fast", "standard", "strict"]);
	const postures = posturePickerOptions("operator");
	assert.match(postures.options[0], /^✓ operator/);
	assert.match(postures.options[1], /requires a native roster/);
	assert.equal(compactExecutionPair("fast", "operator"), "Fast·Operator");
	assert.equal(compactExecutionPair("strict", "orchestrator"), "Strict·Orchestrator");
});

test("roster validation blocks only a posture change onto orchestrator", () => {
	const operatorFast: ExecutionPair = { mode: "fast", posture: "operator" };
	const standardOrch: ExecutionPair = { mode: "standard", posture: "orchestrator" };
	const fastOrch: ExecutionPair = { mode: "fast", posture: "orchestrator" };
	assert.equal(executionPairBlockedByRoster(operatorFast, standardOrch, 0), true);
	assert.equal(executionPairBlockedByRoster(operatorFast, standardOrch, 1), false);
	assert.equal(executionPairBlockedByRoster(fastOrch, standardOrch, 0), false);
	assert.equal(executionPairBlockedByRoster(standardOrch, operatorFast, 0), false);
	assert.equal(executionPairBlockedByRoster(operatorFast, operatorFast, 0), false);
});
