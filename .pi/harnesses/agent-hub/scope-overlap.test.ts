import assert from "node:assert/strict";
import test from "node:test";
import { entriesOverlap, findScopeOverlap, normalizeScopeEntry, scopeAnchor } from "./scope-overlap.ts";

test("anchors stop at the first glob segment and normalise separators", () => {
	assert.deepEqual(scopeAnchor("src/a/**"), ["src", "a"]);
	assert.deepEqual(scopeAnchor("./src//b/"), ["src", "b"]);
	assert.deepEqual(scopeAnchor("src/*.ts"), ["src"]);
	assert.deepEqual(scopeAnchor("**"), []);
	assert.deepEqual(scopeAnchor("../outside"), [], "escaping paths are treated as the whole repository");
	assert.equal(normalizeScopeEntry("src\\a\\b.ts"), "src/a/b.ts");
});

test("equal, nested and glob-covered entries overlap; siblings and name prefixes do not", () => {
	assert.equal(entriesOverlap("src/a.ts", "src/a.ts"), true);
	assert.equal(entriesOverlap("src/a", "src/a/b.ts"), true);
	assert.equal(entriesOverlap("src/a/b.ts", "src/a"), true);
	assert.equal(entriesOverlap("src/*.ts", "src/b/x.ts"), true, "conservative: unprovable disjointness is overlap");
	assert.equal(entriesOverlap("src/a", "src/b"), false);
	assert.equal(entriesOverlap("src/a", "src/ab.ts"), false, "segment comparison, not string prefix");
	assert.equal(entriesOverlap("docs/x.md", "src/x.md"), false);
});

test("findScopeOverlap names the first overlapping pair and treats an empty scope as everything", () => {
	assert.equal(findScopeOverlap(["src/a"], ["src/b", "docs"]), null);
	assert.deepEqual(findScopeOverlap(["src/a", "docs/x.md"], ["src/b", "docs"]), { left: "docs/x.md", right: "docs" });
	assert.ok(findScopeOverlap([], ["src/b"]));
	assert.ok(findScopeOverlap(["src/b"], []));
});
