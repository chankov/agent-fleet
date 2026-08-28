// Static wiring contracts for index.ts. Executable routing semantics live in
// backend-policy.test.js; model-backed dispatch remains a runtime smoke concern.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const dispatchAgentToolSource = readFileSync(new URL("./tools/dispatch-agent.ts", import.meta.url), "utf8");

test("wiring contract: dispatch_agent exposes the explicit backend enum", () => {
	assert.match(dispatchAgentToolSource, /backend: Type\.Optional\(Type\.Union\(\[/);
	for (const backend of ["auto", "native", "coms"]) {
		assert.match(dispatchAgentToolSource, new RegExp(`Type\\.Literal\\("${backend}"\\)`));
	}
});

test("wiring contract: requested backend reaches initial and resumed dispatches", () => {
	assert.match(source, /const \{ task, artifacts, scope, watchdog, review_reason, backend = "auto" \}/);
	assert.match(source, /dispatchAgent\(agent, dispatchedTask, ctx, inputArtifacts, scopeGlobs, watchdog, backend\)/);
	assert.match(source, /dispatchAgent\(agent, resumePrompt, ctx, inputArtifacts, scopeGlobs, watchdog, backend, true\)/);
});

test("wiring contract: explicit coms refusal precedes native spawn", () => {
	assert.match(source, /route\.backend === "coms-unavailable"/);
	assert.match(source, /explicitComsRefusal\(displayName\(state\.def\.name\)\)/);
	assert.match(source, /const allowNativeFallback = !route\.explicit/);
});
