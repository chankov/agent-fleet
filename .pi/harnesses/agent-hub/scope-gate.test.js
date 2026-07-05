import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { checkScope, diffAgainst, snapshotWorktree } from "./scope-gate.js";

function git(args, cwd) {
	return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
}

function repo() {
	const dir = mkdtempSync(join(tmpdir(), "scope-gate-"));
	git(["init"], dir);
	git(["config", "user.email", "scope@example.test"], dir);
	git(["config", "user.name", "Scope Gate"], dir);
	mkdirSync(join(dir, "src", "deep"), { recursive: true });
	writeFileSync(join(dir, "src", "tracked.ts"), "initial\n", "utf-8");
	git(["add", "."], dir);
	git(["commit", "-m", "initial"], dir);
	return dir;
}

test("checkScope supports exact file, exact directory prefix, *, and **", () => {
	const changed = [
		"src/tracked.ts",
		"src/deep/nested.ts",
		"test/foo.test.js",
		"README.md",
		"docs/guide/intro.md",
	];

	assert.deepEqual(checkScope(changed, ["src/tracked.ts", "test/*.test.js", "docs/**"]), {
		inScope: ["docs/guide/intro.md", "src/tracked.ts", "test/foo.test.js"],
		outOfScope: ["README.md", "src/deep/nested.ts"],
	});
	assert.deepEqual(checkScope(["src/deep/nested.ts", "srcfile.ts"], ["src"]), {
		inScope: ["src/deep/nested.ts"],
		outOfScope: ["srcfile.ts"],
	});
});

test("snapshotWorktree and diffAgainst include untracked files", () => {
	const dir = repo();
	const snapshot = snapshotWorktree(dir);
	assert.equal(snapshot.skipped, false);

	writeFileSync(join(dir, "src", "new-file.ts"), "new\n", "utf-8");
	const diff = diffAgainst(snapshot, dir);

	assert.equal(diff.skipped, false);
	assert.deepEqual(diff.paths, ["src/new-file.ts"]);
});

test("diffAgainst does not attribute pre-existing dirty files", () => {
	const dir = repo();
	writeFileSync(join(dir, "src", "tracked.ts"), "dirty before\n", "utf-8");
	const snapshot = snapshotWorktree(dir);
	assert.ok(snapshot.paths.has("src/tracked.ts"));

	writeFileSync(join(dir, "README.md"), "new after\n", "utf-8");
	const diff = diffAgainst(snapshot, dir);

	assert.deepEqual(diff.paths, ["README.md"]);
});

test("non-git worktrees skip without throwing", () => {
	const dir = mkdtempSync(join(tmpdir(), "scope-gate-nongit-"));
	const snapshot = snapshotWorktree(dir);
	const diff = diffAgainst(snapshot, dir);

	assert.equal(snapshot.skipped, true);
	assert.equal(diff.skipped, true);
	assert.deepEqual(diff.paths, []);
});
