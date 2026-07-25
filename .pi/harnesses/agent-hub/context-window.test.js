import test from "node:test";
import assert from "node:assert/strict";

import {
	PRESPAWN_HEADROOM,
	contextPct,
	estimatePromptTokens,
	overWindowDiagnostic,
	resolveContextWindow,
	shouldRecycleBeforeSpawn,
	splitModelSpec,
} from "./context-window.js";

const registry = {
	"custom/Qwen3.6-35B-A3B-4bit": { contextWindow: 49152 },
	"openai-codex/gpt-5.6-luna": { contextWindow: 400_000 },
	"openrouter/google/gemini-3-flash-preview": { contextWindow: 1_000_000 },
};
const lookup = (provider, modelId) => registry[`${provider}/${modelId}`];

test("splitModelSpec keeps everything after the first slash as the model id", () => {
	assert.deepEqual(splitModelSpec("custom/Qwen3.6-35B-A3B-4bit"), { provider: "custom", modelId: "Qwen3.6-35B-A3B-4bit" });
	assert.deepEqual(splitModelSpec("openrouter/google/gemini-3-flash-preview"), {
		provider: "openrouter",
		modelId: "google/gemini-3-flash-preview",
	});
	// Nothing to look up without a provider segment.
	assert.deepEqual(splitModelSpec("bare-model"), { provider: "", modelId: "bare-model" });
	assert.deepEqual(splitModelSpec("trailing/"), { provider: "", modelId: "trailing/" });
	assert.deepEqual(splitModelSpec(""), { provider: "", modelId: "" });
	assert.deepEqual(splitModelSpec(undefined), { provider: "", modelId: "" });
});

test("the registry is the source, and the source is reported", () => {
	const small = resolveContextWindow("custom/Qwen3.6-35B-A3B-4bit", { lookup, fallbackWindow: 400_000 });
	assert.equal(small.window, 49152);
	assert.match(small.source, /model registry/);
	assert.match(small.source, /custom\/Qwen3\.6-35B-A3B-4bit/);

	// Multi-segment ids resolve too — this is the shape the default model uses.
	assert.equal(resolveContextWindow("openrouter/google/gemini-3-flash-preview", { lookup }).window, 1_000_000);
});

test("an unknown model falls back to the dispatcher window and says so", () => {
	const r = resolveContextWindow("custom/not-registered", { lookup, fallbackWindow: 400_000 });
	assert.equal(r.window, 400_000);
	// The fallback is exactly the bug being fixed, so it must never read as authoritative.
	assert.match(r.source, /dispatcher's own model/);
	assert.match(r.source, /not custom\/not-registered's window/);
});

test("no registry hit and no fallback resolves to unknown, not to a guess", () => {
	assert.deepEqual(resolveContextWindow("custom/x", { lookup: () => undefined }), { window: 0, source: "unknown" });
	assert.deepEqual(resolveContextWindow("custom/x", { lookup, fallbackWindow: 0 }), { window: 0, source: "unknown" });
	// A registry that throws must not take the hub down with it.
	const throwing = resolveContextWindow("custom/x", { lookup: () => { throw new Error("registry offline"); }, fallbackWindow: 100 });
	assert.equal(throwing.window, 100);
});

test("contextPct counts cache reads and writes, and is 0 without a window", () => {
	assert.equal(contextPct({ input: 1000, cacheRead: 2000, cacheWrite: 1000 }, 40_000), 10);
	assert.equal(contextPct({ input: 100 }, 0), 0);
	assert.equal(contextPct({ input: 100 }, undefined), 0);
	assert.equal(contextPct({}, 1000), 0);
	// Over-window readings are reported as-is; clamping would hide the defect.
	assert.equal(contextPct({ input: 3000 }, 1000), 300);
});

test("estimatePromptTokens is a coarse chars/4 estimate", () => {
	assert.equal(estimatePromptTokens("abcd"), 1);
	assert.equal(estimatePromptTokens("a".repeat(4001)), 1001);
	assert.equal(estimatePromptTokens(""), 0);
	assert.equal(estimatePromptTokens(undefined), 0);
});

test("the pre-spawn guard fires only when a resumed session would overflow", () => {
	const window = 50_000;
	// Fits with headroom to spare.
	assert.equal(shouldRecycleBeforeSpawn({ priorTokens: 10_000, promptTokens: 1_000, window }), null);
	// A fresh session has nothing to recycle, however big the prompt.
	assert.equal(shouldRecycleBeforeSpawn({ priorTokens: 0, promptTokens: 90_000, window }), null);
	// Unknown window → no opinion.
	assert.equal(shouldRecycleBeforeSpawn({ priorTokens: 40_000, promptTokens: 40_000, window: 0 }), null);

	const hit = shouldRecycleBeforeSpawn({ priorTokens: 44_000, promptTokens: 2_000, window });
	assert.ok(hit);
	assert.equal(hit.projected, 46_000);
	assert.match(hit.message, /46k tokens/);
	assert.match(hit.message, /50k window/);
	// Exactly at the headroom boundary counts as overflow.
	assert.ok(shouldRecycleBeforeSpawn({ priorTokens: window * PRESPAWN_HEADROOM, promptTokens: 0, window }));
});

test("the over-window diagnostic names the window and its source", () => {
	const msg = overWindowDiagnostic({
		agent: "Planner",
		model: "custom/Qwen3.6-35B-A3B-4bit",
		pct: 315,
		window: 49152,
		source: "pi model registry (custom/Qwen3.6-35B-A3B-4bit)",
	});
	assert.match(msg, /Planner/);
	assert.match(msg, /315%/);
	assert.match(msg, /49k tokens/);
	assert.match(msg, /model registry/);
	assert.match(msg, /wrong for this provider or the run genuinely exceeded it/);
});
