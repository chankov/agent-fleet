import { spawnSync } from "node:child_process";
import type { Run } from "./run.ts";

export interface BaseRef { ref: string; diffBase: string; reason: string; scenario: "ahead" | "dirty" | "fallback" }
export interface ChangeSet { base: BaseRef; changedFiles: string[]; untrackedFiles: string[]; diff: string; hiddenLines: number }
export interface ChangesEnvelope {
	status: "success";
	summary: string;
	artifacts: string[];
	notes_for_next_agent: string;
	changed_files: string[];
	base: string;
	reason: string;
}
function git(cwd: string, args: string[]): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (result.status !== 0) throw new Error((result.stderr || result.stdout || `git ${args.join(" ")} failed`).trim());
	return result.stdout;
}
function lines(value: string): string[] { return value.split(/\r?\n/).map(line => line.trim()).filter(Boolean); }

export function resolveBase(ref: string, cwd = process.cwd()): BaseRef {
	git(cwd, ["rev-parse", "--verify", ref]);
	const ahead = Number(git(cwd, ["rev-list", "--count", `${ref}..HEAD`]).trim());
	if (ahead > 0) return { ref, diffBase: ref, reason: `HEAD is ahead of \`${ref}\``, scenario: "ahead" };
	const dirty = git(cwd, ["status", "--porcelain", "--untracked-files=all"]).trim().length > 0;
	if (dirty) return { ref, diffBase: "HEAD", reason: "diffing the uncommitted working tree", scenario: "dirty" };
	const fallback = git(cwd, ["rev-parse", "--verify", "HEAD~1"]).trim();
	return { ref, diffBase: fallback, reason: "clean tree — falling back to the last commit (HEAD~1)", scenario: "fallback" };
}

export function capture(run: Run, params: { ref?: string; cwd?: string; maxDiffLines?: number } = {}): ChangeSet {
	const cwd = params.cwd ?? run.trace.cwd;
	const base = resolveBase(params.ref ?? "main", cwd);
	const runtimePrefix = `.pi/flow-sessions/${run.trace.runId}/`;
	const tracked = lines(git(cwd, ["diff", "--name-only", base.diffBase, "--"])).filter(path => !path.startsWith(runtimePrefix));
	const untrackedFiles = lines(git(cwd, ["ls-files", "--others", "--exclude-standard"])).filter(path => !path.startsWith(runtimePrefix));
	const changedFiles = [...new Set([...tracked, ...untrackedFiles])].sort();
	let diff = git(cwd, ["diff", "--no-ext-diff", "--unified=3", base.diffBase, "--"]);
	if (untrackedFiles.length) diff += `${diff && !diff.endsWith("\n") ? "\n" : ""}Untracked files:\n${untrackedFiles.map(path => `?? ${path}`).join("\n")}\n`;
	const allLines = diff.split(/\r?\n/);
	if (allLines.at(-1) === "") allLines.pop();
	const max = params.maxDiffLines ?? 2000;
	const hiddenLines = Math.max(0, allLines.length - max);
	if (hiddenLines) diff = `${allLines.slice(0, max).join("\n")}\n... ${hiddenLines} diff lines hidden by maxDiffLines ...`;
	else diff = allLines.join("\n");
	run.trace.write("log", { phase: "changes", message: base.reason, base: base.diffBase, ref: base.ref, changedFiles, untrackedFiles, hiddenLines });
	return { base, changedFiles, untrackedFiles, diff, hiddenLines };
}

export function asEnvelope(changes: ChangeSet, notes = ""): ChangesEnvelope {
	return {
		status: "success",
		summary: `${changes.changedFiles.length} changed path(s) captured`,
		artifacts: [],
		notes_for_next_agent: [changes.diff, notes].filter(Boolean).join("\n\n"),
		changed_files: changes.changedFiles,
		base: changes.base.diffBase,
		reason: changes.base.reason,
	};
}
