import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./grid.ts", import.meta.url), "utf8");

test("main dispatcher grid never registers research cards; running strip sits below the editor", () => {
	assert.doesNotMatch(source, /agent-research/);
	assert.doesNotMatch(source, /updateResearchWidget/);
	assert.doesNotMatch(source, /renderResearchCard/);
	assert.doesNotMatch(source, /getResearchStates/);
	assert.doesNotMatch(source, /GridResearchState/);
	assert.doesNotMatch(source, /switchableAgents/);
	assert.match(source, /setWidget\("agent-running"/);
	assert.match(source, /placement: "belowEditor"/);
});
