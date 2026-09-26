import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";

import { checkScope, diffAgainst, snapshotWorktree } from "./scope-gate.js";

function git(args, cwd) {
	return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
}

const allocatedDirectories = [];
function temporaryDirectory(t, prefix) {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	// Register before setup can throw; clean only this test's owned directory.
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	allocatedDirectories.push(dir);
	return dir;
}
after(() => {
	for (const dir of allocatedDirectories) assert.equal(existsSync(dir), false, `Leaked test directory: ${dir}`);
});

function repo(t) {
	const dir = temporaryDirectory(t, "scope-gate-");
	git(["init"], dir);
	git(["config", "user.email", "scope@example.test"], dir);
	git(["config", "user.name", "Scope Gate"], dir);
	mkdirSync(join(dir, "src", "deep"), { recursive: true });
	writeFileSync(join(dir, "src", "tracked.ts"), "initial\n", "utf-8");
	git(["add", "."], dir);
	git(["commit", "-m", "initial"], dir);
	return dir;
}

test("checkScope supports exact file, exact directory prefix, *, and **", t => {
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

test("snapshotWorktree and diffAgainst include untracked files", t => {
	const dir = repo(t);
	const snapshot = snapshotWorktree(dir);
	assert.equal(snapshot.skipped, false);

	writeFileSync(join(dir, "src", "new-file.ts"), "new\n", "utf-8");
	const diff = diffAgainst(snapshot, dir);

	assert.equal(diff.skipped, false);
	assert.deepEqual(diff.paths, ["src/new-file.ts"]);
});

test("diffAgainst does not attribute pre-existing dirty files", t => {
	const dir = repo(t);
	writeFileSync(join(dir, "src", "tracked.ts"), "dirty before\n", "utf-8");
	const snapshot = snapshotWorktree(dir);
	assert.ok(snapshot.paths.has("src/tracked.ts"));

	writeFileSync(join(dir, "README.md"), "new after\n", "utf-8");
	const diff = diffAgainst(snapshot, dir);

	assert.deepEqual(diff.paths, ["README.md"]);
});

test("non-git worktrees skip without throwing", t => {
	const dir = temporaryDirectory(t, "scope-gate-nongit-");
	const previous = process.env.GIT_CEILING_DIRECTORIES;
	// Stop Git walking from a repo-local TMPDIR into this worktree. Ceiling is the fixture only.
	process.env.GIT_CEILING_DIRECTORIES = previous ? `${dir}${delimiter}${previous}` : dir;
	try {
		const snapshot = snapshotWorktree(dir);
		const diff = diffAgainst(snapshot, dir);

		assert.equal(snapshot.skipped, true);
		assert.equal(diff.skipped, true);
		assert.deepEqual(diff.paths, []);
	} finally {
		if (previous === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
		else process.env.GIT_CEILING_DIRECTORIES = previous;
	}
});

test("glob **/ matches zero or multiple directory levels", t => {
 assert.deepEqual(checkScope(["RIN.DataCore/BaseRINCoreData.cs", "RIN.DataCore/deep/Base.cs"], ["RIN.DataCore/**/*.cs"]).outOfScope, []);
 assert.deepEqual(checkScope(["root.cs", "a/b/child.cs"], ["**/*.cs"]).outOfScope, []);
 assert.deepEqual(checkScope(["src/a.ts", "src/ab.ts"], ["src/?.ts"]).inScope, ["src/a.ts"]);
});

test("content changes in already staged, unstaged and untracked files are detected without touching index", t => {
 const dir = repo(t);
 writeFileSync(join(dir, "src/tracked.ts"), "staged\n"); git(["add", "src/tracked.ts"], dir);
 writeFileSync(join(dir, "src/tracked.ts"), "unstaged before\n");
 writeFileSync(join(dir, "untracked file.ts"), "before\n");
 const indexBefore = git(["diff", "--cached", "--binary"], dir);
 const snapshot = snapshotWorktree(dir);
 writeFileSync(join(dir, "src/tracked.ts"), "unstaged after\n");
 writeFileSync(join(dir, "untracked file.ts"), "after\n");
 assert.deepEqual(diffAgainst(snapshot, dir).paths, ["src/tracked.ts", "untracked file.ts"]);
 assert.equal(git(["diff", "--cached", "--binary"], dir), indexBefore);
});

test("dirty-to-clean restoration and filenames containing newlines are reported", t => {
 const dir = repo(t);
 writeFileSync(join(dir, "src/tracked.ts"), "dirty\n");
 writeFileSync(join(dir, "new\nfile.ts"), "before\n");
 const snapshot = snapshotWorktree(dir);
 writeFileSync(join(dir, "src/tracked.ts"), "initial\n");
 writeFileSync(join(dir, "new\nfile.ts"), "after\n");
 assert.deepEqual(diffAgainst(snapshot, dir).paths, ["new\nfile.ts", "src/tracked.ts"]);
});
