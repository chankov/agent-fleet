import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const { HARNESS_VERSION_MANIFESTS, syncHarnessVersions } = await import("../sync-harness-versions.js");

function fixture({ version = "1.2.3", rootName = "@chankov/agent-fleet" } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "harness-version-sync-"));
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: rootName, version, private: true }, null, 2));
	for (const path of HARNESS_VERSION_MANIFESTS) {
		const full = join(dir, path);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, JSON.stringify({ name: `fixture-${path}`, private: true, custom: { preserved: true } }, null, 2));
	}
	return dir;
}

function manifest(dir, relativePath) {
	return JSON.parse(readFileSync(join(dir, relativePath), "utf8"));
}

test("stamps exactly the three UI-owning harness manifests and preserves unrelated fields", () => {
	assert.deepEqual(HARNESS_VERSION_MANIFESTS, [
		".pi/harnesses/agent-hub/package.json",
		".pi/harnesses/coms/package.json",
		".pi/harnesses/damage-control-continue/package.json",
	]);
	const dir = fixture({ version: "1.2.3-beta.4+build.5" });
	try {
		const result = syncHarnessVersions(dir);
		assert.equal(result.version, "1.2.3-beta.4+build.5");
		assert.deepEqual(result.results.map(({ path }) => path), HARNESS_VERSION_MANIFESTS);
		for (const path of HARNESS_VERSION_MANIFESTS) {
			assert.equal(manifest(dir, path).version, result.version, path);
			assert.deepEqual(manifest(dir, path).custom, { preserved: true }, path);
		}
		assert.doesNotThrow(() => syncHarnessVersions(dir, { check: true }));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("check is read-only and reports derived-version drift", () => {
	const dir = fixture();
	try {
		syncHarnessVersions(dir);
		const drifted = HARNESS_VERSION_MANIFESTS[0];
		const current = manifest(dir, drifted);
		current.version = "9.9.9";
		writeFileSync(join(dir, drifted), JSON.stringify(current, null, 2));
		assert.throws(() => syncHarnessVersions(dir, { check: true }), /does not match root version/);
		assert.equal(manifest(dir, drifted).version, "9.9.9");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("release flow synchronizes harness stamps after the root bump and before lockfile and snapshot finalization", () => {
	const { scripts } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	const flow = scripts["version:changeset"];
	const bump = flow.indexOf("changeset version");
	const sync = flow.indexOf("node bin/sync-harness-versions.js");
	const lockfile = flow.indexOf("npm install --package-lock-only");
	const snapshot = flow.indexOf("node bin/snapshot-version.js");

	assert.ok(bump >= 0, "release flow bumps the root version");
	assert.ok(sync > bump, "release flow stamps harness manifests after the root version bump");
	assert.ok(lockfile > sync, "release flow finalizes the lockfile after stamping manifests");
	assert.ok(snapshot > lockfile, "release flow snapshots only after lockfile finalization");
	assert.doesNotThrow(() => syncHarnessVersions(root, { check: true }), "committed harness stamps do not drift from the root version");
});

test("rejects missing or malformed root and target manifests", () => {
	const cases = [
		{ mutate: (dir) => rmSync(join(dir, "package.json")), expected: /missing or unreadable/ },
		{ mutate: (dir) => writeFileSync(join(dir, "package.json"), "{"), expected: /malformed JSON/ },
		{ mutate: (dir) => writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "wrong", version: "1.2.3" })), expected: /name must be/ },
		{ mutate: (dir) => writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@chankov/agent-fleet", version: "not-a-version" })), expected: /valid semantic version/ },
		{ mutate: (dir) => rmSync(join(dir, HARNESS_VERSION_MANIFESTS[0])), expected: /missing or unreadable/ },
		{ mutate: (dir) => writeFileSync(join(dir, HARNESS_VERSION_MANIFESTS[0]), "{"), expected: /malformed JSON/ },
	];
	for (const { mutate, expected } of cases) {
		const dir = fixture();
		try {
			mutate(dir);
			assert.throws(() => syncHarnessVersions(dir), expected);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}
});
