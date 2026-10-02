import assert from "node:assert/strict";
import test from "node:test";
import { buildEvidenceManifest, rawReadsRequired } from "./evidence-manifest.ts";

const full = {
	revision: "abc123",
	scope: ["src/adapter.ts"],
	changes: ["src/adapter.ts"],
	commands: [{ command: "npm test adapter", exitCode: 0 }],
	tests: { executed: 69, passed: 69, failed: 0, testIds: ["delete-404"] },
	evidenceRefs: ["artifacts/evidence/adapter.json"],
	openAssertions: [],
	observedRevision: "abc123",
};

test("a full manifest carries the handoff fields", () => {
	const manifest = buildEvidenceManifest(full);
	assert.equal(manifest.revision, "abc123");
	assert.deepEqual(manifest.scope, ["src/adapter.ts"]);
	assert.deepEqual(manifest.changes, ["src/adapter.ts"]);
	assert.equal(manifest.commands[0].exitCode, 0);
	assert.equal(manifest.tests.executed, 69);
	assert.deepEqual(manifest.evidenceRefs, ["artifacts/evidence/adapter.json"]);
	assert.deepEqual(manifest.openAssertions, []);
	assert.equal(manifest.truncated, false);
});

test("truncation names the preserved artifact", () => {
	const manifest = buildEvidenceManifest({ ...full, changes: ["a.ts", "b.ts", "c.ts"], maxChanges: 1, fullArtifact: "artifacts/evidence/full.json" });
	assert.equal(manifest.truncated, true);
	assert.deepEqual(manifest.changes, ["a.ts"]);
	assert.equal(manifest.fullArtifact, "artifacts/evidence/full.json");
});

test("stale and mismatched manifests are not a sufficient handoff", () => {
	assert.equal(buildEvidenceManifest({ ...full, observedRevision: "def456" }).stale, true);
	assert.equal(buildEvidenceManifest({ ...full, changes: ["other.ts"] }).mismatch, true);
});

test("the next specialist rereads only missing or conflicting facts", () => {
	const manifest = buildEvidenceManifest(full);
	const reads = rawReadsRequired(manifest, ["src/adapter.ts", "docs/unrelated.md", "artifacts/evidence/adapter.json"]);
	assert.deepEqual(reads, ["docs/unrelated.md"]);
	assert.equal(reads.length, 1);
});
