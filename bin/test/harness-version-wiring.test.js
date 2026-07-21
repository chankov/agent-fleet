import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const targets = ["agent-hub", "coms", "damage-control", "damage-control-continue"];

test("all four target entrypoints import and register their local version module at session start", () => {
	for (const name of targets) {
		const source = readFileSync(join(root, ".pi", "harnesses", name, "index.ts"), "utf8");
		assert.match(source, /from "\.\/version\.ts"/, name);
		assert.match(source, /pi\.on\("session_start", async \([^)]*\) => \{\s*registerVersionStatus\(/, name);
	}
});

test("agent-hub custom footer renders the local version before model and team", () => {
	const source = readFileSync(join(root, ".pi", "harnesses", "agent-hub", "index.ts"), "utf8");
	assert.match(source, /renderHubFooterLeft\(theme, HARNESS_VERSION, model, think, activeTeamName\)/);
});

test("version registration from stacked owners deduplicates on one common key", async () => {
	const statuses = new Map();
	for (const name of targets) {
		const module = await import(`${new URL(`../../.pi/harnesses/${name}/version.ts`, import.meta.url).href}?wiring=${name}`);
		module.registerVersionStatus({ ui: { setStatus: (key, text) => statuses.set(key, text) } });
	}
	assert.equal(statuses.size, 1);
	assert.equal(statuses.get("00-agent-fleet-version"), `v${JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version}`);
});
