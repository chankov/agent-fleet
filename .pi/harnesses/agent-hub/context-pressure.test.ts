import assert from "node:assert/strict";
import test from "node:test";

import {
	AUTO_COMPACT_PERCENT,
	CONTEXT_WARNING_PERCENT,
	compactionShortOfTargetAfterRecovery,
	contextPressureDiagnostic,
	pressureCapabilityState,
	createContextPressureState,
	shouldExposeCompaction,
	transitionContextPressure,
	type ContextPressureState,
} from "./context-pressure.ts";

function usage(percent: number | null, tokens: number | null = percent == null ? null : percent * 1_000) {
	return { type: "usage" as const, usage: { tokens, contextWindow: 100_000, percent } };
}

function sample(state: ContextPressureState, percent: number | null, tokens?: number | null) {
	return transitionContextPressure(state, usage(percent, tokens ?? (percent == null ? null : percent * 1_000)));
}

test("pressure diagnostics expose thresholds and metadata-only recovery outcome", () => {
	let decision = sample(createContextPressureState(), 91, 91_000);
	decision = transitionContextPressure(decision.state, { type: "compaction-succeeded" });
	assert.deepEqual(contextPressureDiagnostic(decision.state), {
		phase: "recovered",
		pressure: "imminent",
		episode: 1,
		tokens: 91_000,
		contextWindow: 100_000,
		percent: 91,
		warningPercent: CONTEXT_WARNING_PERCENT,
		automaticPercent: AUTO_COMPACT_PERCENT,
		lastRecoveryOutcome: "succeeded",
	});
	decision = transitionContextPressure(decision.state, { type: "compaction-failed", error: "credential-shaped secret must stay internal" });
	const failed = contextPressureDiagnostic(decision.state);
	assert.equal(failed.phase, "failed");
	assert.equal(failed.lastRecoveryOutcome, "failed");
	assert.doesNotMatch(JSON.stringify(failed), /credential-shaped|secret/);
});

test("context pressure boundaries expose recovery at 60% and request one compaction at 70%", () => {
	let state = createContextPressureState();

	let decision = sample(state, CONTEXT_WARNING_PERCENT - 0.01);
	assert.equal(decision.state.phase, "normal");
	assert.equal(decision.action, "none");
	assert.equal(shouldExposeCompaction(decision.state), false);

	decision = sample(decision.state, CONTEXT_WARNING_PERCENT);
	assert.equal(decision.state.phase, "warning");
	assert.equal(decision.action, "expose-compaction");
	assert.equal(shouldExposeCompaction(decision.state), true);

	decision = sample(decision.state, AUTO_COMPACT_PERCENT - 0.01);
	assert.equal(decision.state.phase, "warning");
	assert.equal(decision.action, "none");

	decision = sample(decision.state, AUTO_COMPACT_PERCENT);
	assert.equal(decision.state.phase, "compacting");
	assert.equal(decision.action, "compact-now");
	assert.equal(decision.state.episode, 1);

	decision = sample(decision.state, 105);
	assert.equal(decision.state.phase, "compacting");
	assert.equal(decision.action, "none");
});

test("unknown usage is observable and does not block ordinary work", () => {
	const decision = transitionContextPressure(createContextPressureState(), {
		type: "usage",
		usage: { tokens: null, contextWindow: null, percent: null },
	});
	assert.equal(decision.state.pressure, "unknown");
	assert.equal(decision.state.phase, "normal");
	assert.equal(decision.reason, "usage-unknown");
	assert.equal(decision.action, "none");
});

test("token and window measurements derive pressure when a provider omits percent", () => {
	const decision = transitionContextPressure(createContextPressureState(), {
		type: "usage",
		usage: { tokens: 65_000, contextWindow: 100_000, percent: null },
	});
	assert.equal(decision.state.usage.percent, 65);
	assert.equal(decision.state.pressure, "approaching");
	assert.equal(decision.action, "expose-compaction");
});

test("automatic compaction is single-flight and rearms only after recovery is measured below warning", () => {
	let decision = sample(createContextPressureState(), 91);
	assert.equal(decision.action, "compact-now");
	assert.equal(decision.state.episode, 1);

	for (const percent of [92, 99, 110]) {
		decision = sample(decision.state, percent);
		assert.equal(decision.action, "none");
		assert.equal(decision.state.phase, "compacting");
		assert.equal(decision.state.episode, 1);
	}

	decision = transitionContextPressure(decision.state, { type: "compaction-succeeded" });
	assert.equal(decision.state.phase, "recovered");
	assert.equal(shouldExposeCompaction(decision.state), true, "recovery stays visible until post-compact usage is observed");

	decision = sample(decision.state, 91);
	assert.equal(decision.state.phase, "recovered");
	assert.equal(decision.action, "none", "high post-compact usage cannot start a retry loop");

	decision = sample(decision.state, 20);
	assert.equal(decision.state.phase, "normal");
	assert.equal(shouldExposeCompaction(decision.state), false);

	decision = sample(decision.state, 95);
	assert.equal(decision.action, "compact-now");
	assert.equal(decision.state.episode, 2);
});

test("a compacted baseline above warning re-arms after one band of growth, never after a failure", () => {
	let decision = sample(createContextPressureState(), 72);
	assert.equal(decision.action, "compact-now");
	decision = transitionContextPressure(decision.state, { type: "compaction-succeeded" });
	decision = sample(decision.state, 64);
	assert.equal(decision.state.compactedTokens, 64_000, "the first measurement after compaction is the baseline");
	decision = sample(decision.state, 73);
	assert.equal(decision.action, "none", "less than one band of new history stays single-flight");
	decision = sample(decision.state, 74);
	assert.equal(decision.action, "compact-now", "a small window is not left waiting for usage below warning");

	decision = transitionContextPressure(decision.state, { type: "compaction-failed", error: "offline" });
	decision = sample(decision.state, 95);
	assert.equal(decision.action, "none", "a failed recovery never re-arms by growth");
});

test("a tool result not yet sent is never part of the post-compaction baseline", () => {
	let decision = transitionContextPressure(sample(createContextPressureState(), 72).state, { type: "compaction-succeeded" });
	decision = transitionContextPressure(decision.state, { type: "usage", usage: { tokens: 75_000, contextWindow: 100_000, percent: 75 }, measuredTokens: 64_000 });
	assert.equal(decision.state.compactedTokens, 64_000);
});

test("only a compacted baseline between target and ceiling is short of target", () => {
	const recovered = transitionContextPressure(sample(createContextPressureState(), 72).state, { type: "compaction-succeeded" }).state;
	for (const [percent, expected] of [[69, false], [70, true], [79.9, true], [80, false], [95, false]] as const) {
		assert.equal(compactionShortOfTargetAfterRecovery(sample(recovered, percent).state), expected, `${percent}%`);
	}
	assert.equal(compactionShortOfTargetAfterRecovery(sample(createContextPressureState(), 75).state), false, "no compaction ran");
});

test("compaction failure remains actionable without retrying until pressure clears", () => {
	let decision = sample(createContextPressureState(), 93);
	decision = transitionContextPressure(decision.state, { type: "compaction-failed", error: "offline" });
	assert.equal(decision.state.phase, "failed");
	assert.equal(decision.state.lastError, "offline");
	assert.equal(shouldExposeCompaction(decision.state), true);

	decision = sample(decision.state, 94);
	assert.equal(decision.state.phase, "failed");
	assert.equal(decision.action, "none");

	decision = sample(decision.state, 10);
	assert.equal(decision.state.phase, "normal");
	assert.equal(decision.state.lastError, null);
});

test("the historical same-turn growth pattern requests recovery before an over-window provider call", () => {
	const contextWindow = 272_000;
	const progression = [
		{ checkpoint: "turn_end", tokens: 215_000 },
		{ checkpoint: "turn_end", tokens: 221_000 },
		{ checkpoint: "turn_end", tokens: 246_000 },
		{ checkpoint: "turn_end", tokens: 263_094 },
		{ checkpoint: "terminal_tool_result", tokens: 284_983 },
	] as const;

	let state = createContextPressureState();
	const actions: string[] = [];
	for (const point of progression) {
		const decision = transitionContextPressure(state, {
			type: "usage",
			usage: { tokens: point.tokens, contextWindow, percent: point.tokens / contextWindow * 100 },
		});
		state = decision.state;
		if (decision.action !== "none") actions.push(`${point.checkpoint}:${decision.action}`);
	}

	assert.deepEqual(actions, [
		"turn_end:compact-now",
	]);
	assert.equal(state.episode, 1);
	assert.equal(state.phase, "compacting");
});

test("approved automatic policy starts at 70%, never below 50%, and exposes a ceiling of 80%", () => {
 assert.equal(AUTO_COMPACT_PERCENT,70);
 assert.equal(CONTEXT_WARNING_PERCENT,60);
 for(const percent of [0,49,49.99,50,59]) assert.equal(sample(createContextPressureState(),percent).action,"none");
 assert.equal(sample(createContextPressureState(),70).action,"compact-now");
 assert.equal(sample(createContextPressureState(),80).action,"compact-now");
});

test("live usage between warning and target exposes compaction before the pressure state catches up", () => {
	const fresh = createContextPressureState();
	assert.equal(pressureCapabilityState(fresh, CONTEXT_WARNING_PERCENT - 0.01), "normal");
	assert.equal(pressureCapabilityState(fresh, CONTEXT_WARNING_PERCENT), "approaching-compaction");
	assert.equal(pressureCapabilityState(fresh, AUTO_COMPACT_PERCENT), "imminent-compaction");
	assert.equal(pressureCapabilityState(sample(fresh, 65).state, null), "approaching-compaction");
	assert.equal(pressureCapabilityState(sample(fresh, 75).state, null), "imminent-compaction");
});
