import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { component, estimateTokens, planeOccupancy, reconcilePlane, safeSchemaChars } from "./context-budget.ts";

const visible = (id: string, chars: number) => component({ id, plane: "hub", category: "system", label: id, persistence: "fixed", visibility: "model-visible", confidence: "heuristic", chars });

test("reconciliation preserves estimates below a provider total and exposes a residual", () => {
	const result = reconcilePlane([visible("a", 40), visible("b", 20)], "hub", 20, 100);
	assert.equal(result.summary.attributedTokens, 15);
	assert.equal(result.summary.residualTokens, 5);
	assert.equal(result.residual?.adjustedTokens, 5);
	assert.equal(result.summary.attributedTokens + (result.summary.residualTokens ?? 0), 20);
	assert.equal(result.summary.occupancyPercent, 20);
});

test("reconciliation scales down without negative components and reconciles rounding", () => {
	const result = reconcilePlane([visible("a", 40), visible("b", 40), visible("c", 40)], "hub", 2);
	assert.deepEqual(result.components.map((entry) => entry.adjustedTokens), [0, 0, 0]);
	assert.equal(result.summary.residualTokens, 2);
	assert.equal(result.summary.attributedTokens + (result.summary.residualTokens ?? 0), 2);
	assert.ok(result.components.every((entry) => (entry.adjustedTokens ?? -1) >= 0));
});

test("loaded-excluded input costs zero in the final prompt", () => {
	const excluded = component({ id: "project/agents", plane: "hub", category: "project", label: "AGENTS.md", persistence: "fixed", visibility: "loaded-excluded", confidence: "exact-chars", chars: 999 });
	const result = reconcilePlane([excluded], "hub", 3);
	assert.equal(result.components[0].adjustedTokens, 0);
	assert.equal(result.summary.attributedTokens, 0);
	assert.equal(result.summary.residualTokens, 3);
});

test("unknown and zero measurements do not fabricate capacity", () => {
	assert.equal(reconcilePlane([visible("a", 4)], "hub").summary.residualTokens, undefined);
	assert.equal(reconcilePlane([visible("a", 4)], "hub", 0, 0).summary.occupancyPercent, undefined);
	assert.equal(planeOccupancy(10, undefined), undefined);
	assert.equal(planeOccupancy(10, 0), undefined);
});

test("unicode character estimates and unsupported schemas are safe", () => {
	assert.equal(estimateTokens("😀😀".length), 1);
	const circular: { self?: unknown; data?: bigint } = { data: 1n };
	circular.self = circular;
	assert.doesNotThrow(() => safeSchemaChars(circular));
	assert.ok(safeSchemaChars(circular) > 0);
});

test("each plane uses its own denominator", () => {
	assert.equal(planeOccupancy(100, 1000), 10);
	assert.equal(planeOccupancy(100, 200), 50);
});

test("missing usage fields do not invent cache or residual", () => {
	const result = reconcilePlane([visible("a", 8)], "hub");
	assert.equal(result.summary.measuredTokens, undefined);
	assert.equal(result.residual, undefined);
});

test("deterministic profile fixtures attribute exact prompt, tool, and plane characters", () => {
	const profiles = JSON.parse(readFileSync(new URL("./fixtures/context-budget-profiles.json", import.meta.url), "utf8")) as Array<{ name: string; plane: "hub" | "research" | "specialist"; prompt: string; tools: string[] }>;
	assert.deepEqual(profiles.map(profile => profile.name), ["greeting", "direct-coding", "fleet", "verification", "peer", "workspace", "compaction-full-fleet", "research-helper", "specialist"]);
	for (const profile of profiles) {
		const policy = component({ id: `${profile.name}/policy`, plane: profile.plane, category: "system", label: "policy", persistence: "fixed", visibility: "model-visible", confidence: "exact-chars", chars: profile.prompt.length });
		const tools = profile.tools.map(name => component({ id: `${profile.name}/tool/${name}`, plane: profile.plane, category: "tool", label: name, persistence: "fixed", visibility: "model-visible", confidence: "exact-chars", chars: safeSchemaChars({ name, description: `${name} tool` }) }));
		assert.equal(policy.chars, profile.prompt.length, `${profile.name} policy attribution`);
		assert.equal(tools.reduce((total, tool) => total + tool.chars, 0), profile.tools.reduce((total, name) => total + safeSchemaChars({ name, description: `${name} tool` }), 0), `${profile.name} tool attribution`);
		assert.ok([policy, ...tools].every(entry => entry.plane === profile.plane && entry.confidence === "exact-chars"), `${profile.name} plane attribution`);
	}
});
