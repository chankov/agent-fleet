import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PermissionBreach, changedPaths, enforce, matchesWriteGlob, permitted, snapshot } from "./permissions.ts";

function repo(): string {
	const cwd = mkdtempSync(join(tmpdir(), "flow-permissions-"));
	execFileSync("git", ["init", "-q", "-b", "main"], { cwd });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd }); execFileSync("git", ["config", "user.name", "Test"], { cwd });
	writeFileSync(join(cwd, "tracked.txt"), "clean\n"); writeFileSync(join(cwd, ".gitignore"), ".pi/flow-sessions/\n");
	execFileSync("git", ["add", "."], { cwd }); execFileSync("git", ["commit", "-qm", "initial"], { cwd }); return cwd;
}

test("custom write globs stop star at slash while double-star crosses directories", () => {
	assert.equal(matchesWriteGlob("adws/adw_one.py", "adws/adw_*.py"), true);
	assert.equal(matchesWriteGlob("adws/nested/adw_one.py", "adws/adw_*.py"), false);
	assert.equal(matchesWriteGlob("adws/nested/adw_one.py", "adws/**/*.py"), true);
	assert.equal(matchesWriteGlob("README.md", "**/*.md"), true);
});

test("unauthorized introduced files roll back while runtime is always writable", () => {
	const cwd = repo();
	try {
		const runtime = join(cwd, ".pi", "flow-sessions", "r1"); mkdirSync(runtime, { recursive: true });
		const before = snapshot(cwd); writeFileSync(join(cwd, "intruder.txt"), "bad"); writeFileSync(join(runtime, "report.md"), "ok"); const after = snapshot(cwd);
		assert.throws(() => enforce(before, after, { writes: [], alwaysWritable: [runtime] }), PermissionBreach);
		assert.equal(readFileSync(join(runtime, "report.md"), "utf8"), "ok");
		assert.equal(permitted(".pi/flow-sessions/r1/report.md", { writes: [], alwaysWritable: [runtime] }, cwd), true);
		assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" }).trim(), "");
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("appeared, disappeared, and same-size rewritten states are detected", () => {
	const cwd = repo();
	try {
		writeFileSync(join(cwd, "tracked.txt"), "dirty\n"); const before = snapshot(cwd);
		execFileSync("git", ["restore", "tracked.txt"], { cwd }); const clean = snapshot(cwd);
		assert.deepEqual(changedPaths(before, clean), ["tracked.txt"], "git checkout reversal is a change");
		assert.throws(() => enforce(before, clean, { writes: [] }), /restored pre-dirty state for: tracked.txt/);
		assert.equal(readFileSync(join(cwd, "tracked.txt"), "utf8"), "dirty\n");
		const rewrittenBefore = snapshot(cwd); writeFileSync(join(cwd, "tracked.txt"), "other\n"); const rewrittenAfter = snapshot(cwd);
		assert.deepEqual(changedPaths(rewrittenBefore, rewrittenAfter), ["tracked.txt"]);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("allowed paths survive and protected globs require explicit naming", () => {
	const cwd = repo();
	try {
		const before = snapshot(cwd); mkdirSync(join(cwd, "docs")); writeFileSync(join(cwd, "docs", "x.md"), "x"); const after = snapshot(cwd);
		assert.doesNotThrow(() => enforce(before, after, { writes: ["docs/"], protectedGlobs: ["scripts/**"] }));
		assert.equal(permitted("scripts/x.ts", { protectedGlobs: ["scripts/**"] }, cwd), false);
		assert.equal(permitted("scripts/x.ts", { writes: ["scripts/x.ts"], protectedGlobs: ["scripts/**"] }, cwd), true);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});
