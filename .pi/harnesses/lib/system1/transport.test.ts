// PLAN-11-01 tasks 14–15 (D32): every System 1 caller keeps Fleet's direct TypeSafe adapter. The
// decision is code-owned, made before any request, and no System 1 path calls Pi's native classifier.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { JEV_ENDPOINT, JEV_MODEL, type JevHttpRequest } from "./jev.ts";
import { createSystem1Runtime } from "./service.ts";
import { NATIVE_CLASSIFIER_GAPS, selectSystem1Transport, SYSTEM1_TRANSPORTS, system1TransportSummary } from "./transport.js";

const here = dirname(fileURLToPath(import.meta.url));
const config = { version: 2, consumers: {}, mode: "auto", provider: "typesafe", model: JEV_MODEL, apiKeyEnv: "TYPESAFE_API_KEY" } as const;
const request = { state: { message: "Synthetic input only" }, questionSetVersion: "fixture-v1", questions: [{ id: "clear", type: "predicate" as const, instructions: "Is it clear?", criteria: { true: "Clear", false: "Unclear" } }] };
const okBody = JSON.stringify({ model: JEV_MODEL, answers: { clear: { type: "noul", noul: 0.75 } }, usage: { input_tokens: 3, output_tokens: 1 } });

test("every caller uses the direct adapter, with a recorded reason; unknown callers too", () => {
	assert.ok(SYSTEM1_TRANSPORTS.length >= 5);
	for (const entry of SYSTEM1_TRANSPORTS) {
		assert.equal(entry.transport, "direct", entry.caller);
		assert.ok(entry.reason.length > 10, entry.caller);
		assert.deepEqual(selectSystem1Transport(entry.caller), { transport: "direct", reason: entry.reason });
	}
	assert.equal(selectSystem1Transport("someone-new").transport, "direct");
	assert.match(system1TransportSummary(), /^transport: direct \(Fleet's TypeSafe adapter\); Pi's native classifier is not used because Pi's catalog has no classifier typesafe\/jev-1\.13\.0/);
	assert.ok(NATIVE_CLASSIFIER_GAPS.some(gap => /returned/.test(gap)) && NATIVE_CLASSIFIER_GAPS.some(gap => /ordinal/.test(gap)));
});

test("the sole authorized request goes to the pinned TypeSafe endpoint once; off and missing-key paths send nothing", async () => {
	const sent: JevHttpRequest[] = [];
	const transport = async (http: JevHttpRequest) => { sent.push(http); return { status: 200, headers: {}, body: okBody }; };
	const runtime = createSystem1Runtime({ selected: true, config, env: { TYPESAFE_API_KEY: "synthetic-transport-key" }, transport, caller: "hub" });
	const result = await runtime.service.evaluate(request);
	assert.equal(result.status, "ok");
	assert.equal(sent.length, 1, "one submission, one transport");
	assert.equal(sent[0].url, JEV_ENDPOINT);
	const body = JSON.parse(sent[0].body.toString("utf8"));
	assert.equal(body.model, JEV_MODEL, "the exact configured pin, not an alias");
	assert.deepEqual(Object.keys(body).sort(), ["model", "questions", "state"], "only the authorized payload");
	if (result.status === "ok") assert.equal(result.evaluation.metadata.returnedModel, JEV_MODEL);

	for (const [label, options] of [
		["root mode off", { selected: true, config: { ...config, mode: "off" }, env: { TYPESAFE_API_KEY: "k" } }],
		["feature not selected", { selected: false, config, env: { TYPESAFE_API_KEY: "k" } }],
		["missing key", { selected: true, config, env: {} }],
	] as const) {
		const before = sent.length;
		const off = createSystem1Runtime({ ...options, transport });
		assert.notEqual((await off.service.evaluate(request)).status, "ok", label);
		assert.equal(sent.length, before, `${label}: zero provider calls`);
	}
});

test("no System 1 path calls Pi's native classifier", () => {
	const sources = [
		"service.ts", "jev.ts", "worktree-service.ts", "transport.js",
		"../../agent-hub/system1-runtime.ts", "../../agent-hub/agentic-runtime.ts", "../../agent-hub/agentic-hub.ts",
	].map(path => [path, readFileSync(join(here, path), "utf8")] as const);
	for (const [path, source] of sources) {
		assert.doesNotMatch(source.replace(/^\s*\/\/.*$/gm, ""), /modelRegistry|\.classify\(/, path);
	}
});
