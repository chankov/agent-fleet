import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

import { checkScope, diffAgainst, reviewableChangedPaths, snapshotRevision, snapshotWorktree, worktreeRevision } from "./scope-gate.js";

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

function repo(t, dir = temporaryDirectory(t, "scope-gate-")) {
	mkdirSync(dir, { recursive: true });
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

test("review accounting excludes only unrequested outputs from the owning runtime session", t => {
 const cwd = "/tmp/review-repo", sessionDir = join(cwd, ".pi/agent-sessions/sessions/current");
 const own = ".pi/agent-sessions/sessions/current/artifacts/returns/run.md";
 const paths = [own, ".pi/agent-sessions/sessions/other/artifacts/returns/user.md", ".pi/agent-sessions/sessions/current/user-task.txt", "src/user.ts", "README.md"];
 assert.deepEqual(reviewableChangedPaths(paths, cwd, sessionDir, ["README.md"]), paths.slice(1));
 assert.deepEqual(reviewableChangedPaths([own], cwd, sessionDir, [own]), [own], "explicit task scope is protected");
 assert.deepEqual(reviewableChangedPaths([own], cwd, sessionDir, ["**/*.md", ".pi/**"]), [], "generic broad globs do not select runtime output as a task edit");
 assert.deepEqual(reviewableChangedPaths([own], cwd, sessionDir, ["README.md"], [join(cwd, own)]), [own], "declared deliverable is protected");
 assert.deepEqual(reviewableChangedPaths([own], cwd, "/tmp/other-session", ["README.md"]), [own], "no global hidden-path rule");
 assert.deepEqual(reviewableChangedPaths([own], cwd, sessionDir, ["README.md"]), [], "runtime outputs alone are not reviewed task changes");
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

test("nested Git observes only declared scopes and retains separate repository HEADs", t => {
 const parent = temporaryDirectory(t, "nested-scope-");
 const app = repo(t, join(parent, "ringithub")), docs = repo(t, join(parent, "rin-docs"));
 const scopes = ["ringithub/src", "rin-docs/src/tracked.ts"];
 const before = snapshotWorktree(parent, scopes), revision = worktreeRevision(parent, scopes);
 assert.equal(before.skipped, false);
 assert.deepEqual(before.repositories.map(r => r.prefix), ["rin-docs", "ringithub"]);
 for (const r of before.repositories) assert.equal(r.head, git(["rev-parse", "HEAD"], join(parent, r.prefix)).trim());
 writeFileSync(join(app, "src/tracked.ts"), "changed\n");
 writeFileSync(join(app, "outside.ts"), "outside declared scope\n");
 writeFileSync(join(docs, "src/not-declared.ts"), "outside declared file\n");
 mkdirSync(join(parent, ".pi/agent-sessions/sessions/current"), { recursive: true });
 writeFileSync(join(parent, ".pi/agent-sessions/sessions/current/session.json"), "{}");
 const diff = diffAgainst(before, parent);
 assert.equal(diff.skipped, false);
 assert.deepEqual(diff.paths, ["ringithub/src/tracked.ts"]);
 assert.deepEqual(diff.gaps, []);
 assert.notEqual(worktreeRevision(parent, scopes), revision);
 assert.equal(snapshotWorktree(parent).skipped, true, "no scope never scans nested checkouts");
 assert.equal(worktreeRevision(parent), "unavailable");
});

test("nested Git reports per-scope gaps while retaining observed changes from other roots", t => {
 const parent = temporaryDirectory(t, "nested-gaps-");
 const app = repo(t, join(parent, "ringithub"));
 mkdirSync(join(parent, "loose"));
 const scopes = ["ringithub/src", "loose/missing.txt"];
 const before = snapshotWorktree(parent, scopes);
 assert.equal(before.skipped, false);
 assert.deepEqual(before.gaps.map(g => g.scope), ["loose/missing.txt"]);
 writeFileSync(join(app, "src/tracked.ts"), "changed\n");
 const diff = diffAgainst(before, parent);
 assert.equal(diff.skipped, false);
 assert.deepEqual(diff.paths, ["ringithub/src/tracked.ts"]);
 assert.deepEqual(diff.gaps.map(g => g.scope), ["loose/missing.txt"]);
 assert.equal(worktreeRevision(parent, scopes), "unavailable", "partial coverage is never a complete revision");
});

test("nested Git scopes cannot discover outside repositories or unanchored siblings", t => {
 const parent = temporaryDirectory(t, "nested-boundary-"), outside = repo(t);
 repo(t, join(parent, "unselected"));
 symlinkSync(outside, join(parent, "external"), "dir");
 const scopes = [outside, "../escape", "external/src", "**/*.ts"];
 const snapshot = snapshotWorktree(parent, scopes);
 assert.equal(snapshot.skipped, true);
 assert.deepEqual(snapshot.repositories, []);
 assert.deepEqual(snapshot.gaps.map(g => g.scope), scopes);
 assert.equal(snapshotWorktree(join(outside, "src"), ["tracked.ts"]).nested, undefined, "existing single-repo behavior stays intact");
});

test("nested Git glob scopes detect repeated dirty changes and missing files", t => {
 const parent = temporaryDirectory(t, "nested-dirty-"), app = repo(t, join(parent, "app"));
 const scopes = ["app/src/**/*.ts"];
 writeFileSync(join(app, "src/tracked.ts"), "before\n");
 writeFileSync(join(app, "src/ignore.txt"), "before\n");
 const before = snapshotWorktree(parent, scopes);
 assert.equal(before.skipped, false);
 writeFileSync(join(app, "src/tracked.ts"), "after!\n");
 writeFileSync(join(app, "src/ignore.txt"), "after!\n");
 assert.deepEqual(diffAgainst(before, parent).paths, ["app/src/tracked.ts"]);
 const dirty = snapshotWorktree(parent, scopes);
 writeFileSync(join(app, "src/tracked.ts"), "initial\n");
 assert.deepEqual(diffAgainst(dirty, parent).paths, ["app/src/tracked.ts"]);
 const clean = snapshotWorktree(parent, scopes);
 rmSync(join(app, "src/tracked.ts"));
 assert.deepEqual(diffAgainst(clean, parent).paths, ["app/src/tracked.ts"]);
});

test("nested Git HEAD changes invalidate only their repository observation", t => {
 const parent = temporaryDirectory(t, "nested-head-"), app = repo(t, join(parent, "app")), docs = repo(t, join(parent, "docs"));
 const before = snapshotWorktree(parent, ["app/src", "docs/src"]);
 git(["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "new head"], app);
 writeFileSync(join(docs, "src/tracked.ts"), "changed\n");
 const diff = diffAgainst(before, parent);
 assert.equal(diff.skipped, false);
 assert.deepEqual(diff.paths, ["docs/src/tracked.ts"]);
 assert.deepEqual(diff.gaps.map(g => g.scope), ["app/src"]);
});

test("nested Git root scopes exclude session outputs and do not scan sibling repositories", t => {
 const parent = temporaryDirectory(t, "nested-root-"), app = repo(t, join(parent, "app"));
 const sibling = repo(t, join(parent, "unselected"));
 const before = snapshotWorktree(parent, ["app"]), revision = worktreeRevision(parent, ["app"]);
 assert.equal(before.skipped, false);
 mkdirSync(join(app, ".pi/agent-sessions/current"), { recursive: true });
 writeFileSync(join(app, ".pi/agent-sessions/current/report.md"), "runtime output\n");
 writeFileSync(join(sibling, "src/tracked.ts"), "unselected edit\n");
 assert.equal(worktreeRevision(parent, ["app"]), revision);
 writeFileSync(join(app, "src/new.ts"), "declared repository edit\n");
 assert.deepEqual(diffAgainst(before, parent).paths, ["app/src/new.ts"]);
});

test("nested Git observes metadata without reading file contents, including literal workspace brackets", t => {
 const parent = temporaryDirectory(t, "nested-[workspace]-"), app = repo(t, join(parent, "app"));
 writeFileSync(join(app, "src/tracked.ts"), "dirty before\n");
 const originalRead = fs.readFileSync;
 fs.readFileSync = () => { throw new Error("Nested observation must not read file contents"); };
 syncBuiltinESMExports();
 try {
  const before = snapshotWorktree(parent, ["app\\src\\**\\*.ts"]);
  assert.equal(before.skipped, false);
  writeFileSync(join(app, "src/tracked.ts"), "dirty after\n");
  assert.deepEqual(diffAgainst(before, parent).paths, ["app/src/tracked.ts"]);
 } finally { fs.readFileSync = originalRead; syncBuiltinESMExports(); }
});

test("one observation yields the same revision as a fresh worktree revision", (t) => {
	const dir = temporaryDirectory(t, "fleet-snapshot-revision-");
	git(["init", "-q"], dir); writeFileSync(join(dir, "a.txt"), "a\n"); git(["add", "a.txt"], dir);
	git(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "base"], dir);
	const before = snapshotWorktree(dir, ["a.txt"]);
	assert.equal(snapshotRevision(before), worktreeRevision(dir, [], ["a.txt"]));
	writeFileSync(join(dir, "a.txt"), "changed\n"); writeFileSync(join(dir, "notes.txt"), "local");
	const diff = diffAgainst(before, dir);
	assert.deepEqual(diff.paths, ["a.txt", "notes.txt"]);
	assert.equal(snapshotRevision(diff.snapshot), worktreeRevision(dir, [], ["a.txt"]), "the post-run delta snapshot is the after revision");
	assert.notEqual(snapshotRevision(diff.snapshot), snapshotRevision(before));
});
