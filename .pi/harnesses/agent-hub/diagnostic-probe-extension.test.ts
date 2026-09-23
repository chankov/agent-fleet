import assert from "node:assert/strict";
import test from "node:test";
import { applyProviderOutputTokenCap } from "./diagnostic-probe-extension.ts";

const OMLX_MODEL = { provider: "omlx", api: "openai-completions", compat: { maxTokensField: "max_completion_tokens" } } as const;
const XAI_MODEL = { provider: "xai", api: "openai-responses" } as const;

test("provider/API-specific output caps match installed xAI Responses and OMLX completions semantics", () => {
	const responses = applyProviderOutputTokenCap({ model: "grok-4.7", input: [{ role: "user", content: "small" }], stream: true, store: false }, XAI_MODEL, 2048);
	assert.equal(responses.field, "max_output_tokens"); assert.equal(responses.payload.max_output_tokens, 2048); assert.ok(!("max_completion_tokens" in responses.payload));
	const completions = applyProviderOutputTokenCap({ model: "Nex-N2.5-mini-MLX-4bit", messages: [{ role: "user", content: "small" }], stream: true }, OMLX_MODEL, 2048);
	assert.equal(completions.field, "max_completion_tokens"); assert.equal(completions.payload.max_completion_tokens, 2048);
	const defaulted = applyProviderOutputTokenCap({ model: "Nex-N2.5-mini-MLX-4bit", messages: [{ role: "user", content: "small" }], stream: true }, { provider: "omlx", api: "openai-completions" }, 2048);
	assert.equal(defaulted.field, "max_completion_tokens"); assert.equal(defaulted.payload.max_completion_tokens, 2048); assert.ok(!("max_tokens" in defaulted.payload));
	const legacy = applyProviderOutputTokenCap({ model: "Nex-N2.5-mini-MLX-4bit", messages: [{ role: "user", content: "small" }], stream: true }, { provider: "omlx", api: "openai-completions", compat: { maxTokensField: "max_tokens" } }, 2048);
	assert.equal(legacy.field, "max_tokens"); assert.equal(legacy.payload.max_tokens, 2048); assert.ok(!("max_completion_tokens" in legacy.payload));
});

test("missing or oversized configured limits and semantic body mismatches fail closed", () => {
	const responses = { model: "grok-4.7", input: [{ role: "user", content: "small" }], stream: true };
	for (const limit of [undefined, null, 0, 2049]) assert.throws(() => applyProviderOutputTokenCap(responses, XAI_MODEL, limit), /exactly 2048/);
	assert.throws(() => applyProviderOutputTokenCap({ model: "grok-4.7", messages: [{ role: "user", content: "small" }], stream: true, max_output_tokens: 1 }, XAI_MODEL, 2048), /payload shape/);
	assert.throws(() => applyProviderOutputTokenCap({ ...responses, max_tokens: 99 }, XAI_MODEL, 2048), /incompatible/);
	assert.throws(() => applyProviderOutputTokenCap({ model: "Nex", messages: [{ role: "user", content: "small" }], stream: true, max_tokens: 99 }, { provider: "omlx", api: "openai-completions" }, 2048), /incompatible/);
	assert.throws(() => applyProviderOutputTokenCap({ model: "Nex", messages: [{ role: "user", content: "small" }], stream: true }, { provider: "omlx", api: "openai-completions", compat: { maxTokensField: "max_output_tokens" } }, 2048), /unsupported OMLX compat/);
	assert.throws(() => applyProviderOutputTokenCap({ ...responses, arbitrary_numeric_limit: 2048 }, { provider: "other", api: "openai-responses" }, 2048), /unsupported provider/);
});

test("compatibility library exposes no executable extension", async () => {
 const library = await import("./diagnostic-probe-extension.ts");
 assert.deepEqual(Object.keys(library).sort(), ["DIAGNOSTIC_TRANSPORT_REFUSAL_EXIT", "applyProviderOutputTokenCap"]);
});
