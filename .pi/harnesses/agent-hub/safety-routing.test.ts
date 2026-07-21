import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { requireSafetyHarness, resolveSafetyHarness } from "./safety-routing.ts";

function fixtureWithHarness() {
	const cwd = mkdtempSync(join(tmpdir(), "agent-hub-safety-"));
	const continuePath = join(cwd, ".pi", "harnesses", "damage-control-continue", "index.ts");
	mkdirSync(join(continuePath, ".."), { recursive: true });
	writeFileSync(continuePath, "export default () => {};");
	return { cwd, continuePath };
}

test("resolveSafetyHarness prefers the launched continue extension", () => {
	const { cwd, continuePath } = fixtureWithHarness();
	const launched = join(cwd, "installed", "damage-control-continue", "index.ts");
	mkdirSync(join(launched, ".."), { recursive: true });
	writeFileSync(launched, "export default () => {};");
	assert.equal(resolveSafetyHarness(cwd, ["pi", "-e", launched]), launched);
	assert.notEqual(launched, continuePath);
});

test("resolveSafetyHarness uses the repo-local continue harness", () => {
	const { cwd, continuePath } = fixtureWithHarness();
	assert.equal(resolveSafetyHarness(cwd, ["pi"]), continuePath);
});

test("resolveSafetyHarness never falls back to the retired hard-stop harness", () => {
	const cwd = mkdtempSync(join(tmpdir(), "agent-hub-safety-"));
	const hardStop = join(cwd, ".pi", "harnesses", "damage-control", "index.ts");
	mkdirSync(join(hardStop, ".."), { recursive: true });
	writeFileSync(hardStop, "export default () => {};");
	assert.equal(resolveSafetyHarness(cwd, ["pi", "-e", hardStop]), null);
});

test("requireSafetyHarness fails closed with an actionable refusal", () => {
	assert.deepEqual(requireSafetyHarness(null), {
		ok: false,
		error: "damage-control-continue harness not found — guarded child dispatch refused",
	});
	assert.deepEqual(requireSafetyHarness("/repo/damage-control-continue/index.ts"), {
		ok: true,
		extensions: ["/repo/damage-control-continue/index.ts"],
	});
});
