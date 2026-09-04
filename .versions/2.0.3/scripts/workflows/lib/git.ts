import { spawnSync } from "node:child_process";
import { changedPaths, permitted, rollBack, snapshot, type PermissionPolicy, type PermissionSnapshot } from "./permissions.ts";

export class StartRefusedError extends Error {
	readonly exitCode = 3;
}
export class GitOperationError extends Error {}

export interface FlowBranchMetadata {
	branch: string;
	flowName?: string;
	runId?: string;
	baseBranch?: string;
	baseCommit?: string;
	result?: "accepted" | "rejected";
}

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

function configKey(branch: string, name: string): string { return `branch.${branch}.agentFleet${name}`; }
function optionalGit(cwd: string, args: string[]): string | undefined {
	try { return git(cwd, args); } catch { return undefined; }
}
function writeBranchConfig(cwd: string, branch: string, name: string, value: string): void {
	git(cwd, ["config", "--local", "--replace-all", configKey(branch, name), value]);
}

export function readFlowBranchMetadata(branch: string, cwd = process.cwd()): FlowBranchMetadata {
	const value = (name: string) => optionalGit(cwd, ["config", "--local", "--get", configKey(branch, name)]);
	const flowName = value("FlowName"), runId = value("RunId"), baseBranch = value("BaseBranch"), baseCommit = value("BaseCommit"), result = value("Result");
	return {
		branch,
		...(flowName ? { flowName } : {}), ...(runId ? { runId } : {}), ...(baseBranch ? { baseBranch } : {}), ...(baseCommit ? { baseCommit } : {}),
		...(result === "accepted" || result === "rejected" ? { result } : {}),
	};
}

export function recordFlowResult(branch: string, result: "accepted" | "rejected", cwd = process.cwd()): void {
	writeBranchConfig(cwd, branch, "Result", result);
}

export function createFlowBranch(name: string, runId: string, cwd = process.cwd()): string {
	const branch = flowBranchName(name, runId);
	const baseBranch = optionalGit(cwd, ["branch", "--show-current"]);
	const baseCommit = asStartRefusal(() => git(cwd, ["rev-parse", "HEAD"]));
	asStartRefusal(() => git(cwd, ["switch", "-c", branch]));
	try {
		writeBranchConfig(cwd, branch, "FlowName", name);
		writeBranchConfig(cwd, branch, "RunId", runId);
		writeBranchConfig(cwd, branch, "BaseCommit", baseCommit);
		if (baseBranch) writeBranchConfig(cwd, branch, "BaseBranch", baseBranch);
	} catch (error) {
		throw new GitOperationError(`Flow branch was created but its metadata could not be recorded: ${error instanceof Error ? error.message : String(error)}`);
	}
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
