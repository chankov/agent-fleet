import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./grid.ts", import.meta.url), "utf8");

test("main dispatcher grid never registers research cards or compact research rows", () => {
	assert.doesNotMatch(source, /agent-research/);
	assert.doesNotMatch(source, /updateResearchWidget/);
	assert.doesNotMatch(source, /renderResearchCard/);
	assert.doesNotMatch(source, /getResearchStates/);
	assert.doesNotMatch(source, /GridResearchState/);
	assert.match(source, /function switchableAgents[\s\S]*getAgentStates\(\)\.values\(\)/);
	assert.doesNotMatch(source, /function switchableAgents[\s\S]*getResearchStates/);
	assert.match(source, /setWidget\("agent-running"/);
	assert.match(source, /Research helpers appear only in the Fleet Dashboard/);
});
