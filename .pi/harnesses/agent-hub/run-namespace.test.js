import test from "node:test";
import assert from "node:assert/strict";

import {
	DEFAULT_RUN_HISTORY_KEEP,
	appendRunIndex,
	buildRunMeta,
	isRunId,
	makeRunId,
	normalizeRunHistoryKeep,
	pruneRunDirs,
} from "./run-namespace.js";

test("makeRunId is sortable, UTC, and filesystem-safe", () => {
	const id = makeRunId(new Date("2026-08-03T09:10:42.123Z"), "a3f9");
	assert.equal(id, "2026-08-03T09-10-42-a3f9");
	assert.ok(!id.includes(":"));
	assert.ok(isRunId(id));
});

test("two runs in the same second still get distinct namespaces", () => {
	const at = new Date("2026-08-03T09:10:42.000Z");
	const ids = new Set(Array.from({ length: 50 }, () => makeRunId(at)));
	assert.ok(ids.size > 1, "the random suffix must actually vary");
	for (const id of ids) assert.ok(isRunId(id), id);
});

test("run ids sort chronologically as plain strings", () => {
	const early = makeRunId(new Date("2026-08-03T09:10:42Z"), "aaaa");
	const late = makeRunId(new Date("2026-08-03T11:00:00Z"), "0000");
	assert.ok(early < late);
});

test("isRunId rejects anything we did not mint", () => {
	for (const name of ["artifacts", "returns", "2026-08-03", "index.json", "", "../escape"]) {
		assert.equal(isRunId(name), false, name);
	}
});

test("pruneRunDirs keeps the newest N and returns the rest", () => {
	const names = ["2026-08-01T10-00-00-aaaa", "2026-08-02T10-00-00-bbbb", "2026-08-03T10-00-00-cccc"];
	assert.deepEqual(pruneRunDirs(names, 2), ["2026-08-01T10-00-00-aaaa"]);
	assert.deepEqual(pruneRunDirs(names, 3), []);
	assert.deepEqual(pruneRunDirs(names, 10), []);
});

test("pruneRunDirs never touches entries it did not mint", () => {
	const names = ["index.json", "README.md", "2026-08-01T10-00-00-aaaa", "2026-08-02T10-00-00-bbbb"];
	assert.deepEqual(pruneRunDirs(names, 1), ["2026-08-01T10-00-00-aaaa"]);
});

test("pruneRunDirs with keep off prunes nothing, with keep 0 prunes everything", () => {
	const names = ["2026-08-01T10-00-00-aaaa", "2026-08-02T10-00-00-bbbb"];
	assert.deepEqual(pruneRunDirs(names, null), []);
	assert.deepEqual(pruneRunDirs(names, 0), names);
	assert.deepEqual(pruneRunDirs([], DEFAULT_RUN_HISTORY_KEEP), []);
});

test("buildRunMeta records the identifiers a post-mortem could not recover", () => {
	const meta = buildRunMeta({
		runId: "2026-08-03T09-10-42-a3f9",
		startedAt: new Date("2026-08-02T15:22:23Z"),
		archivedAt: new Date("2026-08-03T09:10:42Z"),
		cwd: "/repos/ringithub",
		project: "ringithub-plan37-implementation",
		workspace: "w33",
		artifactCounts: { returns: 11, reviews: 2 },
	});
	assert.equal(meta.runId, "2026-08-03T09-10-42-a3f9");
	assert.equal(meta.workspace, "w33");
	assert.equal(meta.project, "ringithub-plan37-implementation");
	assert.equal(meta.startedAt, "2026-08-02T15:22:23.000Z");
	assert.deepEqual(meta.artifactCounts, { returns: 11, reviews: 2 });
});

test("buildRunMeta tolerates the unknowns", () => {
	const meta = buildRunMeta({ runId: "r" });
	assert.equal(meta.startedAt, null);
	assert.equal(meta.workspace, null);
	assert.ok(meta.archivedAt);
});

test("appendRunIndex keeps runs ordered, capped, and newest-last", () => {
	let index = { version: 1, runs: [] };
	for (const runId of ["2026-08-01T10-00-00-aaaa", "2026-08-02T10-00-00-bbbb", "2026-08-03T10-00-00-cccc"]) {
		index = appendRunIndex(index, { runId }, 2);
	}
	assert.deepEqual(index.runs.map((r) => r.runId), ["2026-08-02T10-00-00-bbbb", "2026-08-03T10-00-00-cccc"]);
	assert.equal(index.version, 1);
	assert.ok(index.updatedAt);
});

test("appendRunIndex replaces a re-indexed run instead of duplicating it", () => {
	const first = appendRunIndex(null, { runId: "r1", workspace: null });
	const second = appendRunIndex(first, { runId: "r1", workspace: "w33" });
	assert.equal(second.runs.length, 1);
	assert.equal(second.runs[0].workspace, "w33");
});

test("appendRunIndex survives a corrupt or absent index", () => {
	assert.equal(appendRunIndex(undefined, { runId: "r1" }).runs.length, 1);
	assert.equal(appendRunIndex({ runs: "not-an-array" }, { runId: "r1" }).runs.length, 1);
	assert.equal(appendRunIndex({ runs: [null, { runId: "r0" }] }, { runId: "r1" }).runs.length, 2);
});

test("normalizeRunHistoryKeep maps the overrides value", () => {
	assert.equal(normalizeRunHistoryKeep("20"), 20);
	assert.equal(normalizeRunHistoryKeep(" 5 "), 5);
	assert.equal(normalizeRunHistoryKeep("off"), null);
	assert.equal(normalizeRunHistoryKeep("0"), null);
	assert.equal(normalizeRunHistoryKeep(""), undefined);
	assert.equal(normalizeRunHistoryKeep("junk"), undefined);
	assert.equal(normalizeRunHistoryKeep("-3"), undefined);
});
