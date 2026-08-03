import test from "node:test";
import assert from "node:assert/strict";

import { DOCS_BLOCKED_PERSONAS, checkDocsLane, docsLaneNotice, isDocsGlob, isDocsOnlyScope } from "./docs-lane.js";

test("isDocsGlob accepts documentation extensions wherever they sit", () => {
	for (const glob of ["**/*.md", "CHANGELOG.md", "notes.txt", "RIN.Live/**/*.md", "a/b/c/*.mdx", "spec.rst", "guide.adoc"]) {
		assert.equal(isDocsGlob(glob), true, glob);
	}
});

test("isDocsGlob accepts a documentation directory subtree whatever the tail is", () => {
	for (const glob of ["Docs/**", "docs/plans/PLAN37.md", "artifacts/evidence/*.png", ".changeset/**", "adr/0001-*.md"]) {
		assert.equal(isDocsGlob(glob), true, glob);
	}
});

test("isDocsGlob rejects code and anything unbounded", () => {
	for (const glob of ["**", "*", "src/**", "RIN.Live/**", "**/*.cs", "bin/lib/*.js", "**/*", "package.json"]) {
		assert.equal(isDocsGlob(glob), false, glob);
	}
});

test("isDocsGlob handles brace alternation by requiring every alternative to be docs", () => {
	assert.equal(isDocsGlob("**/*.{md,mdx}"), true);
	assert.equal(isDocsGlob("**/*.{md,ts}"), false);
	assert.equal(isDocsGlob("**/*.{}"), false);
});

test("isDocsGlob accepts bare documentation basenames but not wildcarded ones", () => {
	assert.equal(isDocsGlob("README"), true);
	assert.equal(isDocsGlob("LICENSE"), true);
	assert.equal(isDocsGlob("REA*"), false);
	assert.equal(isDocsGlob("Makefile"), false);
});

test("isDocsGlob normalizes leading ./ and backslashes", () => {
	assert.equal(isDocsGlob("./Docs/**"), true);
	assert.equal(isDocsGlob("Docs\\plans\\PLAN37.md"), true);
	assert.equal(isDocsGlob(""), false);
	assert.equal(isDocsGlob(undefined), false);
});

test("isDocsOnlyScope requires EVERY glob to be documentation", () => {
	assert.equal(isDocsOnlyScope(["Docs/**", "**/*.md"]), true);
	assert.equal(isDocsOnlyScope(["Docs/**", "RIN.Live/Startup.cs"]), false);
});

test("an undeclared scope is never the lighter lane", () => {
	assert.equal(isDocsOnlyScope([]), false);
	assert.equal(isDocsOnlyScope(undefined), false);
	assert.equal(isDocsOnlyScope(["  "]), false);
});

test("checkDocsLane refuses every review persona on a docs-only scope", () => {
	for (const persona of DOCS_BLOCKED_PERSONAS) {
		const gate = checkDocsLane(persona, ["Docs/**"]);
		assert.ok(gate, persona);
		assert.equal(gate.reason, "docs_only_lane");
		assert.match(gate.message, /NOT counted/);
	}
});

test("checkDocsLane lets the writer personas through", () => {
	for (const persona of ["builder", "documenter", "researcher"]) {
		assert.equal(checkDocsLane(persona, ["Docs/**"]), null);
	}
});

test("checkDocsLane does not fire when the scope also covers code", () => {
	assert.equal(checkDocsLane("code-reviewer", ["Docs/**", "RIN.Live/Startup.cs"]), null);
	assert.equal(checkDocsLane("code-reviewer", []), null, "an unknown scope keeps the normal gate");
});

test("an explicit review_reason always opens the gate", () => {
	assert.equal(checkDocsLane("code-reviewer", ["Docs/**"], "the doc publishes a connection string"), null);
	assert.ok(checkDocsLane("code-reviewer", ["Docs/**"], "   "), "whitespace is not a reason");
});

test("the docs-lane refusal names both escape hatches", () => {
	const gate = checkDocsLane("code-reviewer", ["Docs/**"]);
	assert.match(gate.message, /review_reason/);
	assert.match(gate.message, /also touches code/);
});

test("docsLaneNotice tells the dispatcher not to open a review gate", () => {
	const notice = docsLaneNotice("documenter", ["Docs/**"]);
	assert.match(notice, /Docs lane/);
	assert.match(notice, /do not dispatch a reviewer/i);
	assert.equal(docsLaneNotice("documenter", ["src/**"]), null);
	assert.equal(docsLaneNotice("code-reviewer", ["Docs/**"]), null, "reviewers are refused, not notified");
});
