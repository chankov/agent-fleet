import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import { readFlowBranchMetadata, type FlowBranchMetadata } from "../workflows/lib/git.ts";
import type { FlowMaintenanceCommand } from "./flow-command.ts";

export interface FlowBranchInfo {
	branch: string;
	head: string;
	timestamp: number;
	metadata: FlowBranchMetadata;
	runId?: string;
	result: "accepted" | "rejected" | "unknown";
	target?: string;
	worktreePath?: string;
	dirty: boolean;
	ahead?: number;
	behind?: number;
	diffSummary?: string;
}

interface CommandResult { status: number | null; stdout: string; stderr: string; error?: Error; streamed?: boolean }
type CommandRunner = (command: string, args: string[], cwd: string) => CommandResult | Promise<CommandResult>;
export interface FlowMaintenanceOptions {
	cwd?: string;
	interactive?: boolean;
	taskRunner?: CommandRunner;
	taskPrompt?: (question: string) => Promise<string>;
	writeOut?: (text: string) => void;
	writeError?: (text: string) => void;
}

export class FlowMaintenanceError extends Error {
	readonly exitCode: number;
	constructor(message: string, exitCode = 3) { super(message); this.exitCode = exitCode; }
}

function run(command: string, args: string[], cwd: string): CommandResult {
	const result = spawnSync(command, args, { cwd, encoding: "utf8" });
	return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", ...(result.error ? { error: result.error } : {}) };
}

function runTask(command: string, args: string[], cwd: string): Promise<CommandResult> {
	return new Promise(resolveTask => {
		const visible = !(command === "wt" && args[0] === "--version");
		let stdout = "", stderr = "", spawnError: Error | undefined;
		const child = spawn(command, args, { cwd, stdio: ["inherit", "pipe", "pipe"] });
		child.stdout.on("data", chunk => { const text = chunk.toString(); stdout += text; if (visible) process.stdout.write(text); });
		child.stderr.on("data", chunk => { const text = chunk.toString(); stderr += text; if (visible) process.stderr.write(text); });
		child.on("error", error => { spawnError = error; });
		child.on("close", status => resolveTask({ status, stdout, stderr, ...(spawnError ? { error: spawnError } : {}), streamed: visible }));
	});
}

function git(cwd: string, args: string[]): string {
	const result = run("git", args, cwd);
	if (result.status !== 0) throw new FlowMaintenanceError((result.stderr || result.stdout || `git ${args.join(" ")} failed`).trim(), 1);
	return result.stdout.trim();
}

function localBranchExists(cwd: string, branch: string): boolean {
	return run("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], cwd).status === 0;
}

function worktrees(cwd: string): Map<string, string> {
	const output = git(cwd, ["worktree", "list", "--porcelain"]);
	const result = new Map<string, string>();
	let path: string | undefined;
	for (const line of output.split("\n")) {
		if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
		else if (line.startsWith("branch refs/heads/") && path) result.set(line.slice("branch refs/heads/".length), path);
		else if (!line) path = undefined;
	}
	return result;
}

function inferRunId(branch: string, cwd: string): string | undefined {
	const sessions = resolve(cwd, ".pi", "flow-sessions");
	if (!existsSync(sessions)) return undefined;
	return readdirSync(sessions, { withFileTypes: true })
		.filter(entry => entry.isDirectory() && branch.endsWith(`-${entry.name}`))
		.map(entry => entry.name)
		.sort((a, b) => b.length - a.length || a.localeCompare(b))[0];
}

function traceResult(cwd: string, runId?: string): "accepted" | "rejected" | undefined {
	if (!runId) return undefined;
	try {
		const lines = readFileSync(resolve(cwd, ".pi", "flow-sessions", runId, "trace.jsonl"), "utf8").trim().split("\n").filter(Boolean);
		for (let index = lines.length - 1; index >= 0; index--) {
			const event = JSON.parse(lines[index]) as { type?: string; status?: string };
			if (event.type === "run_end" && (event.status === "accepted" || event.status === "rejected")) return event.status;
		}
	} catch {}
	return undefined;
}

function dirtyWorktree(path: string | undefined): boolean {
	if (!path) return false;
	const result = run("git", ["status", "--porcelain", "--untracked-files=all"], path);
	if (result.status !== 0) throw new FlowMaintenanceError(`Could not inspect flow worktree ${path}: ${(result.stderr || result.error?.message || "git status failed").trim()}`);
	return result.stdout.trim() !== "";
}

export function listFlowBranches(cwd = process.cwd()): FlowBranchInfo[] {
	const refs = git(cwd, ["for-each-ref", "--format=%(refname:short)%09%(objectname:short)%09%(committerdate:unix)", "refs/heads/flow/"]);
	if (!refs) return [];
	const paths = worktrees(cwd);
	return refs.split("\n").filter(Boolean).map(line => {
		const [branch, head, rawTimestamp] = line.split("\t");
		const metadata = readFlowBranchMetadata(branch, cwd);
		const runId = metadata.runId ?? inferRunId(branch, cwd);
		const result = metadata.result ?? traceResult(cwd, runId) ?? "unknown";
		const target = metadata.baseBranch;
		const worktreePath = paths.get(branch);
		let ahead: number | undefined, behind: number | undefined, diffSummary: string | undefined;
		if (target && localBranchExists(cwd, target)) {
			const counts = git(cwd, ["rev-list", "--left-right", "--count", `${target}...${branch}`]).split(/\s+/).map(Number);
			behind = counts[0]; ahead = counts[1];
			diffSummary = git(cwd, ["diff", "--shortstat", `${target}...${branch}`]) || "no file changes";
		}
		return {
			branch, head, timestamp: Number(rawTimestamp) || 0, metadata,
			...(runId ? { runId } : {}), result, ...(target ? { target } : {}), ...(worktreePath ? { worktreePath } : {}),
			dirty: dirtyWorktree(worktreePath), ...(ahead === undefined ? {} : { ahead }), ...(behind === undefined ? {} : { behind }), ...(diffSummary ? { diffSummary } : {}),
		};
	}).sort((a, b) => b.timestamp - a.timestamp || a.branch.localeCompare(b.branch));
}

export function renderFlowBranches(branches: FlowBranchInfo[]): string {
	if (!branches.length) return "No local flow/* branches found.\n";
	const rows = branches.map((info, index) => {
		const relation = info.ahead === undefined ? "relation unknown" : `↑${info.ahead} ↓${info.behind ?? 0}`;
		return `  ${index + 1}. ${info.branch}  ${info.result}  ${info.dirty ? "dirty" : "clean"}  ${relation}  target: ${info.target ?? "unknown"}`;
	});
	return `Flow branches:\n${rows.join("\n")}\n\nSelect with a number or full branch name.\n`;
}

export function selectFlowBranch(branches: FlowBranchInfo[], selector: string): FlowBranchInfo {
	if (/^\d+$/.test(selector)) {
		const index = Number(selector) - 1;
		if (!Number.isSafeInteger(index) || index < 0 || index >= branches.length) throw new FlowMaintenanceError(`Flow branch number is out of range: ${selector}`, 2);
		return branches[index];
	}
	const match = branches.find(info => info.branch === selector);
	if (!match) throw new FlowMaintenanceError(`Flow branch was not found: ${selector}`, 2);
	return match;
}

async function defaultPrompt(question: string): Promise<string> {
	const prompt = createInterface({ input: process.stdin, output: process.stdout });
	try { return (await prompt.question(question)).trim(); }
	finally { prompt.close(); }
}

async function requireWorktrunk(cwd: string, taskRunner: CommandRunner): Promise<void> {
	const result = await taskRunner("wt", ["--version"], cwd);
	if (result.status !== 0) throw new FlowMaintenanceError(`Worktrunk is required for flow maintenance: ${(result.error?.message || result.stderr || "wt was not found").trim()}`);
}

function printTaskResult(result: CommandResult, out: (text: string) => void, error: (text: string) => void): void {
	if (result.streamed) return;
	if (result.stdout.trim()) out(`${result.stdout.trim()}\n`);
	if (result.stderr.trim()) error(`${result.stderr.trim()}\n`);
}

function requireClean(info: FlowBranchInfo): void {
	if (info.dirty) throw new FlowMaintenanceError(`Flow branch ${info.branch} has uncommitted changes; commit or stash them before maintenance.`);
}

async function selectedWorktree(info: FlowBranchInfo, cwd: string, taskRunner: CommandRunner): Promise<string> {
	if (info.worktreePath) return info.worktreePath;
	const switched = await taskRunner("wt", ["-C", cwd, "-y", "switch", info.branch, "--no-cd", "--format=json"], cwd);
	if (switched.status !== 0) throw new FlowMaintenanceError((switched.stderr || switched.stdout || `Worktrunk could not create a worktree for ${info.branch}`).trim(), 1);
	const path = worktrees(cwd).get(info.branch);
	if (!path) throw new FlowMaintenanceError(`Worktrunk did not expose a worktree for ${info.branch}.`, 1);
	return path;
}

export async function runFlowMaintenance(command: FlowMaintenanceCommand, options: FlowMaintenanceOptions = {}): Promise<number> {
	const cwd = resolve(options.cwd ?? process.cwd());
	const interactive = options.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
	const taskRunner = options.taskRunner ?? runTask;
	const ask = options.taskPrompt ?? defaultPrompt;
	const out = options.writeOut ?? (text => process.stdout.write(text));
	const error = options.writeError ?? (text => process.stderr.write(text));
	const branches = listFlowBranches(cwd);
	out(renderFlowBranches(branches));
	if (!branches.length) return 0;

	let selector = command.selector;
	if (!selector) {
		if (!interactive) return 0;
		selector = await ask(`${command.action === "cleanup" ? "Clean up" : "Merge"} which flow branch? `);
		if (!selector) return 0;
	}
	let info = selectFlowBranch(branches, selector);
	if (!command.yes) {
		if (!interactive) throw new FlowMaintenanceError("Confirmation requires an interactive terminal; rerun with --yes.");
		const answer = (await ask(`${command.action === "cleanup" ? command.discard ? "Discard" : "Clean up" : "Squash-merge"} ${info.branch}? [y/N] `)).toLowerCase();
		if (answer !== "y" && answer !== "yes") { out("Cancelled.\n"); return 0; }
	}

	const refreshed = listFlowBranches(cwd).find(candidate => candidate.branch === info.branch);
	if (!refreshed) throw new FlowMaintenanceError(`Flow branch disappeared before ${command.action}: ${info.branch}`, 1);
	info = refreshed;
	requireClean(info);
	if (command.action === "cleanup") {
		await requireWorktrunk(cwd, taskRunner);
		const args = ["-C", cwd, "-y", "remove", info.branch, "--foreground", "--format=json", ...(command.discard ? ["-D"] : [])];
		const result = await taskRunner("wt", args, cwd);
		printTaskResult(result, out, error);
		if (result.status !== 0) throw new FlowMaintenanceError(`Worktrunk did not remove ${info.branch}. Use flow merge, or review before --discard.`, 1);
		return 0;
	}

	if (info.result !== "accepted") throw new FlowMaintenanceError(`Flow branch ${info.branch} is ${info.result}; only accepted runs may be merged.`);
	const target = command.target ?? info.target;
	if (!target) throw new FlowMaintenanceError(`Flow branch ${info.branch} has no recorded source branch; rerun with --target <branch>.`);
	if (target === info.branch) throw new FlowMaintenanceError("A flow branch cannot be merged into itself.", 2);
	if (!localBranchExists(cwd, target)) throw new FlowMaintenanceError(`Merge target is not a local branch: ${target}`);
	await requireWorktrunk(cwd, taskRunner);
	const path = await selectedWorktree(info, cwd, taskRunner);
	if (dirtyWorktree(path)) throw new FlowMaintenanceError(`Flow worktree ${path} became dirty before merge; merge was refused.`);
	const result = await taskRunner("wt", ["-C", path, "-y", "merge", target, "--format=json"], path);
	printTaskResult(result, out, error);
	if (result.status !== 0) throw new FlowMaintenanceError(`Worktrunk could not merge ${info.branch} into ${target}.`, 1);
	return 0;
}
