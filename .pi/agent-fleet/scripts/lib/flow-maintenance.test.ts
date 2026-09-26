import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFlowBranch, recordFlowResult } from "../workflows/lib/git.ts";
import { FlowMaintenanceError, listFlowBranches, renderFlowBranches, runFlowMaintenance, selectFlowBranch } from "./flow-maintenance.ts";

type Call = { command: string; args: string[]; cwd: string };
const fixtureRepos = new Set<string>();
function cleanupRepo(cwd: string): void {
	if (existsSync(join(cwd, ".git"))) {
		const worktrees = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd, encoding: "utf8" })
			.split(/\r?\n/).filter(line => line.startsWith("worktree ")).map(line => line.slice("worktree ".length));
		for (const path of worktrees.slice(1)) {
			if (existsSync(path)) execFileSync("git", ["worktree", "remove", "--force", path], { cwd, stdio: "ignore" });
		}
		execFileSync("git", ["worktree", "prune"], { cwd, stdio: "ignore" });
	}
	rmSync(cwd, { recursive: true, force: true });
	 assert.equal(existsSync(cwd), false, `temporary Git fixture was not removed: ${cwd}`);
	 fixtureRepos.delete(cwd);
}
test.after(() => { for (const cwd of [...fixtureRepos]) cleanupRepo(cwd); });
function repo(): string {
	const cwd = mkdtempSync(join(tmpdir(), "flow-maintenance-"));
	fixtureRepos.add(cwd);
	execFileSync("git", ["init", "-q", "-b", "main"], { cwd });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
	execFileSync("git", ["config", "user.name", "Test"], { cwd });
	writeFileSync(join(cwd, "README.md"), "base\n");
	execFileSync("git", ["add", "README.md"], { cwd });
	execFileSync("git", ["commit", "-qm", "base"], { cwd });
	return cwd;
}
function acceptedFlow(cwd: string, name = "scout", runId = "r1"): string {
	const branch = createFlowBranch(name, runId, cwd);
	recordFlowResult(branch, "accepted", cwd);
	return branch;
}
function fakeWorktrunk(calls: Call[], failure = false) {
	return (command: string, args: string[], cwd: string) => {
		calls.push({ command, args, cwd });
		return failure && args.includes("remove")
			? { status: 1, stdout: "", stderr: "not integrated" }
			: { status: 0, stdout: command === "wt" && args[0] === "--version" ? "wt test" : "{}", stderr: "" };
	};
}

test("flow branch selector reports persisted source, acceptance, relation, and stable names", () => {
	const cwd = repo();
	try {
		const branch = acceptedFlow(cwd);
		const branches = listFlowBranches(cwd);
		assert.equal(branches.length, 1);
		assert.deepEqual({ branch: branches[0].branch, result: branches[0].result, target: branches[0].target, dirty: branches[0].dirty, ahead: branches[0].ahead }, { branch, result: "accepted", target: "main", dirty: false, ahead: 0 });
		assert.match(renderFlowBranches(branches), /1\. flow\/scout-r1\s+accepted\s+clean\s+↑0 ↓0\s+target: main/);
		assert.equal(selectFlowBranch(branches, "1").branch, branch);
		assert.equal(selectFlowBranch(branches, branch).branch, branch);
		assert.throws(() => selectFlowBranch(branches, "2"), (error: unknown) => error instanceof FlowMaintenanceError && error.exitCode === 2);
	} finally { cleanupRepo(cwd); }
});

test("non-interactive maintenance without a selector only prints options", async () => {
	const cwd = repo();
	const calls: Call[] = [], output: string[] = [];
	try {
		acceptedFlow(cwd);
		assert.equal(await runFlowMaintenance({ action: "cleanup", discard: false, yes: false }, { cwd, interactive: false, taskRunner: fakeWorktrunk(calls), writeOut: text => output.push(text) }), 0);
		assert.match(output.join(""), /Flow branches:/);
		assert.equal(calls.length, 0);
	} finally { cleanupRepo(cwd); }
});

test("cleanup uses safe Worktrunk removal and discard adds branch force only", async () => {
	for (const discard of [false, true]) {
		const cwd = repo();
		const calls: Call[] = [];
		try {
			const branch = acceptedFlow(cwd);
			assert.equal(await runFlowMaintenance({ action: "cleanup", selector: "1", discard, yes: true }, { cwd, interactive: false, taskRunner: fakeWorktrunk(calls), writeOut() {}, writeError() {} }), 0);
			assert.deepEqual(calls[0], { command: "wt", args: ["--version"], cwd });
			const remove = calls[1];
			assert.equal(remove.command, "wt");
			assert.deepEqual(remove.args, ["-C", cwd, "-y", "remove", branch, "--foreground", "--format=json", ...(discard ? ["-D"] : [])]);
			assert.equal(remove.args.includes("--force"), false);
		} finally { cleanupRepo(cwd); }
	}
});

test("a Worktrunk cleanup failure keeps the branch and exits as an operation failure", async () => {
	const cwd = repo();
	const calls: Call[] = [];
	try {
		const branch = acceptedFlow(cwd);
		await assert.rejects(runFlowMaintenance({ action: "cleanup", selector: "1", discard: false, yes: true }, {
			cwd, interactive: false, taskRunner: fakeWorktrunk(calls, true), writeOut() {}, writeError() {},
		}), (error: unknown) => error instanceof FlowMaintenanceError && error.exitCode === 1);
		assert.match(execFileSync("git", ["branch", "--list", branch], { cwd, encoding: "utf8" }), /flow\/scout-r1/);
	} finally { cleanupRepo(cwd); }
});

test("interactive selector and confirmation can choose cleanup by number", async () => {
	const cwd = repo();
	const calls: Call[] = [], answers = ["1", "yes"];
	try {
		acceptedFlow(cwd);
		assert.equal(await runFlowMaintenance({ action: "cleanup", discard: false, yes: false }, {
			cwd, interactive: true, taskRunner: fakeWorktrunk(calls), taskPrompt: async () => answers.shift() ?? "", writeOut() {}, writeError() {},
		}), 0);
		assert.ok(calls.some(call => call.args.includes("remove")));
	} finally { cleanupRepo(cwd); }
});

test("merge requires accepted clean work and invokes Worktrunk default squash pipeline against the recorded target", async () => {
	const cwd = repo();
	const calls: Call[] = [];
	try {
		const branch = acceptedFlow(cwd, "build-test", "api-1");
		writeFileSync(join(cwd, "feature.txt"), "done\n");
		execFileSync("git", ["add", "feature.txt"], { cwd });
		execFileSync("git", ["commit", "-qm", "flow result"], { cwd });
		assert.equal(await runFlowMaintenance({ action: "merge", selector: branch, discard: false, yes: true }, { cwd, interactive: false, taskRunner: fakeWorktrunk(calls), writeOut() {}, writeError() {} }), 0);
		const merge = calls.find(call => call.args.includes("merge"));
		assert.ok(merge);
		assert.deepEqual(merge.args, ["-C", merge.cwd, "-y", "merge", "main", "--format=json"]);
		assert.equal(merge.args.includes("--no-squash"), false);
	} finally { cleanupRepo(cwd); }
});

test("merge materializes a Worktrunk worktree when the selected branch is not checked out", async () => {
	const cwd = repo();
	const calls: Call[] = [];
	try {
		const branch = acceptedFlow(cwd, "build-test", "detached-1");
		execFileSync("git", ["switch", "main"], { cwd, stdio: "ignore" });
		const runner = (command: string, args: string[], callCwd: string) => {
			calls.push({ command, args, cwd: callCwd });
			if (args.includes("switch")) execFileSync("git", ["worktree", "add", "-q", join(cwd, "flow-wt"), branch], { cwd });
			return { status: 0, stdout: "{}", stderr: "" };
		};
		assert.equal(await runFlowMaintenance({ action: "merge", selector: branch, discard: false, yes: true }, { cwd, interactive: false, taskRunner: runner, writeOut() {}, writeError() {} }), 0);
		assert.ok(calls.some(call => call.args.includes("switch")));
		const merge = calls.find(call => call.args.includes("merge"));
		assert.equal(merge?.cwd.endsWith("/flow-wt"), true);
	} finally { cleanupRepo(cwd); }
});

test("merge and cleanup refusals preserve rejected or dirty work", async () => {
	const cwd = repo();
	const calls: Call[] = [];
	try {
		const branch = createFlowBranch("build-test", "red-1", cwd);
		recordFlowResult(branch, "rejected", cwd);
		await assert.rejects(runFlowMaintenance({ action: "merge", selector: "1", discard: false, yes: true }, { cwd, interactive: false, taskRunner: fakeWorktrunk(calls), writeOut() {}, writeError() {} }), /only accepted runs/);
		writeFileSync(join(cwd, "dirty.txt"), "keep\n");
		await assert.rejects(runFlowMaintenance({ action: "cleanup", selector: "1", discard: true, yes: true }, { cwd, interactive: false, taskRunner: fakeWorktrunk(calls), writeOut() {}, writeError() {} }), /uncommitted changes/);
		assert.equal(calls.filter(call => call.args.includes("merge") || call.args.includes("remove")).length, 0);
	} finally { cleanupRepo(cwd); }
});

test("old branches require an explicit target and missing Worktrunk is a startup refusal", async () => {
	const cwd = repo();
	try {
		execFileSync("git", ["switch", "-qc", "flow/legacy"], { cwd });
		recordFlowResult("flow/legacy", "accepted", cwd);
		const calls: Call[] = [];
		await assert.rejects(runFlowMaintenance({ action: "merge", selector: "1", discard: false, yes: true }, {
			cwd, interactive: false, taskRunner: fakeWorktrunk(calls), writeOut() {}, writeError() {},
		}), /no recorded source branch/);
		assert.equal(calls.length, 0);
		await assert.rejects(runFlowMaintenance({ action: "merge", selector: "1", discard: false, yes: true, target: "main" }, {
			cwd, interactive: false, taskRunner: () => ({ status: 127, stdout: "", stderr: "wt missing" }), writeOut() {}, writeError() {},
		}), (error: unknown) => error instanceof FlowMaintenanceError && error.exitCode === 3 && /Worktrunk is required/.test(error.message));
	} finally { cleanupRepo(cwd); }
});
