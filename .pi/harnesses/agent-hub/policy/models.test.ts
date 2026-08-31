import assert from "node:assert/strict";
import test from "node:test";
import { createModelPolicy } from "./models.ts";

const defs = [
	{ name: "builder", model: "p/base", fallbackModel: "p/fallback", models: ["p/fast"], thinking: "high", subagents: { review: { model: "p/review" } } },
	{ name: "researcher", model: "p/research", kind: "research" },
];
function fixture() {
	let refreshes = 0;
	const policy = createModelPolicy({ getAllDefs: () => defs, getActiveDef: name => name === "builder" ? defs[0] : undefined, getResearchDefs: () => [defs[1]], refreshUi: () => { refreshes++; } });
	return { policy, refreshes: () => refreshes };
}

test("model policy preserves persona, thinking, sub-role, and late substitution precedence", () => {
	const { policy } = fixture();
	assert.deepEqual(policy.allowedModels(defs[0]), ["p/base", "p/fast"]);
	policy.setPersonaOverride("Builder", "p/fast");
	policy.setSubagentOverride("builder", "REVIEW", "p/fast");
	policy.setThinkingOverride("builder", "xhigh");
	assert.equal(policy.resolvedModel(defs[0]), "p/fast");
	assert.equal(policy.resolvedSubagentModel("Builder", "review", "p/review"), "p/fast");
	assert.equal(policy.resolvedThinking(defs[0]), "xhigh");
	assert.equal(policy.switchablePersonaDef("researcher"), defs[1]);
	assert.deepEqual(policy.allKnownModels(), ["p/base", "p/fallback", "p/fast", "p/review", "p/research"]);
});

test("session substitution validates source and target, applies to future resolutions, and resets", async () => {
	const { policy, refreshes } = fixture();
	const notices: string[] = [];
	const ui = { loadAvailable: async () => [{ spec: "p/new" }], notify: (message: string) => notices.push(message) };
	assert.equal(await policy.applySessionSubstitution("missing", "p/new", ui), false);
	assert.equal(await policy.applySessionSubstitution("p/base", "p/new", ui), true);
	assert.equal(policy.resolvedModel(defs[0]), "p/new");
	assert.equal(refreshes(), 1);
	assert.match(notices.at(-1) ?? "", /future agents spawned/);
	policy.reset();
	assert.equal(policy.resolvedModel(defs[0]), "p/base");
});
