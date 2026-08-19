// Static wiring contracts for the large Hub entrypoint. Live posture behavior is
// exercised through a real offline Pi RPC process in extension-loader.test.ts.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const indexSource = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const personaSource = readFileSync(new URL("../../../agents/orchestrator.md", import.meta.url), "utf8");

test("wiring contract: Hub registers posture controls without conditional commands", () => {
	assert.match(indexSource, /registerFlag\("posture"/);
	assert.match(indexSource, /registerCommand\("af-posture"/);
	assert.match(indexSource, /registerCommand\("af-handoff"/);
	assert.doesNotMatch(indexSource, /if \(posture === [^)]+\)\s*\{\s*pi\.registerCommand/);
});

test("wiring contract: Hub persists and restores posture entries", () => {
	assert.match(indexSource, /appendEntry\("agent-hub-posture"/);
	assert.match(indexSource, /resolveSessionPosture\(\{/);
	assert.match(indexSource, /entries: _ctx\.sessionManager\.getEntries\(\)/);
});

test("wiring contract: Hub applies posture tools at startup and live switches", () => {
	const applications = indexSource.match(/applyPostureTools\(\)/g) ?? [];
	assert.ok(applications.length >= 3, `expected definition plus startup and command applications, got ${applications.length}`);
	assert.match(indexSource, /resolvePostureTools\(/);
});

test("wiring contract: orchestrator persona defers authority to active posture", () => {
	assert.match(personaSource, /active Hub posture/i);
	assert.match(personaSource, /operator posture/i);
	assert.match(personaSource, /orchestrator posture/i);
});

test("same-turn lifecycle has one pre-model surface assembly point for normal and resumed remote turns", () => {
	const inputHook = indexSource.match(/pi\.on\("input", async \(_event, ctx\) => \{[\s\S]*?\n\t\}\);/);
	const beforeHook = indexSource.match(/pi\.on\("before_agent_start", async \(_event, _ctx\) => buildHubSystemPrompt\(true\)\);/);
	assert.ok(inputHook, "incoming normal and remote messages share Pi's input hook");
	assert.ok(beforeHook, "all model turns share the before_agent_start hook");
	// Registration order is intentionally irrelevant: Pi invokes input before model startup.
	assert.match(indexSource, /function buildHubSystemPrompt\(forTurn: boolean\)[\s\S]*?if \(forTurn\) \{[\s\S]*?applyPostureTools\(\)/);
	assert.doesNotMatch(indexSource, /classification model|classify.*model request|sendMessage\([\s\S]{0,100}classif/i);
});
