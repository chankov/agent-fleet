import assert from "node:assert/strict";
import test from "node:test";
import {
	checkChildVisibility, checkRegistryAuth, parseListModelsOutput, resetModelVisibilityCache,
} from "./model-visibility.ts";

test("parseListModelsOutput skips the header and builds provider/id names", () => {
	const output = [
		"provider         model           context  max-out  thinking  images",
		"openai-codex     gpt-5.6-sol     200K     16K      yes       no",
		"xai              grok-4.6        256K     16K      yes       no",
		"",
	].join("\n");
	assert.deepEqual(parseListModelsOutput(output), ["openai-codex/gpt-5.6-sol", "xai/grok-4.6"]);
});

test("child-visible failures name that exact check", () => {
	resetModelVisibilityCache();
	const report = checkChildVisibility(["openai-codex/gpt-5.6-sol", "missing/model"], () => ({
		models: ["openai-codex/gpt-5.6-sol"],
	}));
	assert.equal(report.diagnostic, undefined);
	assert.deepEqual(report.models[0], { model: "openai-codex/gpt-5.6-sol", ok: true, failed: [], reasons: [] });
	assert.equal(report.models[1].ok, false);
	assert.deepEqual(report.models[1].failed, ["child-visible"]);
	assert.match(report.models[1].reasons[0], /child-visible check failed/);
	assert.doesNotMatch(report.models[1].reasons.join(" "), /\bauth\b|registered/);
});

test("listing is invoked at most once per process", () => {
	resetModelVisibilityCache();
	let calls = 0;
	const list = () => { calls++; return { models: ["p/a"] }; };
	assert.equal(checkChildVisibility(["p/a"], list).models[0].ok, true);
	assert.equal(checkChildVisibility(["p/b"], list).models[0].ok, false);
	assert.equal(calls, 1);
});

test("a listing invocation failure is a diagnostic, not a claim that every model failed child-visible", () => {
	resetModelVisibilityCache();
	const report = checkChildVisibility(["p/a", "p/b"], () => ({ diagnostic: "pi --no-extensions --list-models failed: not found" }));
	assert.match(report.diagnostic ?? "", /pi --no-extensions --list-models failed/);
	assert.equal(report.models.length, 2);
	for (const model of report.models) {
		assert.equal(model.ok, false);
		assert.deepEqual(model.failed, []);
		assert.match(model.reasons[0], /not performed/);
		assert.doesNotMatch(model.reasons.join(" "), /all models are invalid/);
	}
});

test("registry auth names the exact failed check and is not claimed without a registry", () => {
	const models = ["p/known", "p/noauth", "p/missing"];
	const checks = checkRegistryAuth(models, {
		isRegistered: model => model !== "p/missing",
		hasAuth: model => model === "p/known",
	});
	assert.deepEqual(checks[0], { model: "p/known", ok: true, failed: [], reasons: [] });
	assert.deepEqual(checks[1].failed, ["auth"]);
	assert.match(checks[1].reasons[0], /auth check failed/);
	assert.deepEqual(checks[2].failed, ["registered"]);
	assert.match(checks[2].reasons[0], /registered check failed/);
	resetModelVisibilityCache();
	const child = checkChildVisibility(["p/known"], () => ({ models: ["p/known"] }));
	assert.equal(child.models[0].ok, true);
	assert.equal("auth" in child.models[0], false);
	assert.doesNotMatch(JSON.stringify(child), /"auth"|registered/);
});
