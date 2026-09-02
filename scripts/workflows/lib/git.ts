import { spawnSync } from "node:child_process";
import { changedPaths, permitted, rollBack, snapshot, type PermissionPolicy, type PermissionSnapshot } from "./permissions.ts";

export class StartRefusedError extends Error {
	readonly exitCode = 3;
}
export class GitOperationError extends Error {}

function git(cwd: string, args: string[]): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (result.status !== 0) throw new GitOperationError((result.stderr || result.stdout || `git ${args.join(" ")} failed`).trim());
	return result.stdout.trim();
}
function asStartRefusal(action: () => string): string {
	try { return action(); }
	catch (error) { throw new StartRefusedError(error instanceof Error ? error.message : String(error)); }
}

export function isClean(cwd = process.cwd()): boolean {
	return asStartRefusal(() => git(cwd, ["status", "--porcelain", "--untracked-files=all"])) === "";
}

export function requireCleanTree(cwd = process.cwd(), allowDirty = false): void {
	if (!allowDirty && !isClean(cwd)) throw new StartRefusedError("Flow start refused: working tree is dirty; commit/stash it or pass --allow-dirty.");
}

export function flowBranchName(name: string, runId: string): string {
	return `flow/${name}-${runId}`;
}

export function createFlowBranch(name: string, runId: string, cwd = process.cwd()): string {
	const branch = flowBranchName(name, runId);
	asStartRefusal(() => git(cwd, ["switch", "-c", branch]));
	return branch;
}

export function commitAll(message: string, cwd: string, baseline: PermissionSnapshot, policy: PermissionPolicy = {}): string | null {
	let after = snapshot(cwd);
	const changed = changedPaths(baseline, after);
	const preDirtyChanged = changed.filter(path => baseline.paths.has(path));
	if (preDirtyChanged.length) {
		rollBack(baseline, preDirtyChanged);
		after = snapshot(cwd);
	}
	const introduced = changedPaths(baseline, after).filter(path => !baseline.paths.has(path));
	const violations = introduced.filter(path => !permitted(path, policy, cwd));
	if (violations.length) {
		rollBack(baseline, violations);
		throw new GitOperationError(`Flow introduced paths outside the commit policy: ${violations.join(", ")}`);
	}
	if (!introduced.length) return null;
	git(cwd, ["add", "--", ...introduced]);
	git(cwd, ["commit", "--only", "-m", message, "--", ...introduced]);
	return git(cwd, ["rev-parse", "HEAD"]);
}
