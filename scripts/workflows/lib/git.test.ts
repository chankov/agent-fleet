import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { commitAll, createFlowBranch, flowBranchName, isClean, readFlowBranchMetadata, recordFlowResult, requireCleanTree } from "./git.ts";
import { snapshot } from "./permissions.ts";

function repo(): string {
	const cwd = mkdtempSync(join(tmpdir(), "flow-git-"));
	execFileSync("git", ["init", "-q", "-b", "main"], { cwd });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
	execFileSync("git", ["config", "user.name", "Test"], { cwd });
	writeFileSync(join(cwd, "README.md"), "ok\n");
	execFileSync("git", ["add", "README.md"], { cwd });
	execFileSync("git", ["commit", "-qm", "initial"], { cwd });
	return cwd;
}

test("clean guard and deterministic flow branch", () => {
	const cwd = repo();
	try {
		assert.equal(isClean(cwd), true);
		requireCleanTree(cwd);
		const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
		const branch = createFlowBranch("quality", "run-1", cwd);
		assert.equal(branch, flowBranchName("quality", "run-1"));
		assert.equal(execFileSync("git", ["branch", "--show-current"], { cwd, encoding: "utf8" }).trim(), branch);
		assert.deepEqual(readFlowBranchMetadata(branch, cwd), { branch, flowName: "quality", runId: "run-1", baseBranch: "main", baseCommit });
		recordFlowResult(branch, "accepted", cwd);
		assert.equal(readFlowBranchMetadata(branch, cwd).result, "accepted");
		recordFlowResult(branch, "rejected", cwd);
		assert.equal(readFlowBranchMetadata(branch, cwd).result, "rejected");
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("dirty guard refuses before branch or flow-session side effects", () => {
	const cwd = repo();
	try {
		writeFileSync(join(cwd, "dirty.txt"), "dirty\n");
		assert.equal(isClean(cwd), false);
		assert.throws(() => requireCleanTree(cwd), error => (error as any).exitCode === 3);
		assert.equal(execFileSync("git", ["branch", "--show-current"], { cwd, encoding: "utf8" }).trim(), "main");
		assert.equal(existsSync(join(cwd, ".pi", "flow-sessions")), false);
		assert.doesNotThrow(() => requireCleanTree(cwd, true));
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("commitAll preserves pre-dirty paths and commits only flow-introduced permitted paths", () => {
	const cwd = repo();
	try {
		writeFileSync(join(cwd, "README.md"), "operator staged\n");
		execFileSync("git", ["add", "README.md"], { cwd });
		writeFileSync(join(cwd, "operator.txt"), "operator untracked\n");
		const baseline = snapshot(cwd);
		writeFileSync(join(cwd, "README.md"), "flow tried to overwrite operator work\n");
		writeFileSync(join(cwd, "operator.txt"), "flow tried to overwrite untracked work\n");
		writeFileSync(join(cwd, "docs.md"), "flow docs\n");
		const hash = commitAll("docs: flow", cwd, baseline, { writes: ["*.md"] });
		assert.ok(hash);
		assert.equal(readFileSync(join(cwd, "README.md"), "utf8"), "operator staged\n");
		assert.equal(readFileSync(join(cwd, "operator.txt"), "utf8"), "operator untracked\n");
		assert.match(execFileSync("git", ["show", "--format=", "--name-only", "HEAD"], { cwd, encoding: "utf8" }), /^docs\.md\s*$/);
		assert.match(execFileSync("git", ["diff", "--cached", "--name-only"], { cwd, encoding: "utf8" }), /^README\.md\s*$/);
		assert.match(execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd, encoding: "utf8" }), /\?\? operator\.txt/);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("commitAll skips an accurate no-op and operational failures are not start refusals", () => {
	const cwd = repo();
	try {
		const baseline = snapshot(cwd);
		assert.equal(commitAll("docs: no-op", cwd, baseline), null);
		writeFileSync(join(cwd, "blocked.txt"), "not permitted\n");
		assert.throws(() => commitAll("docs: blocked", cwd, baseline, { writes: ["docs/"] }), error => {
			assert.equal((error as { exitCode?: number }).exitCode, undefined);
			return /outside the commit policy/.test((error as Error).message);
		});
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});
