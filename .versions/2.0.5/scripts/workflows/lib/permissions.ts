import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";

interface PathState {
	path: string;
	numstat: string;
	index?: { mode: string; object: string; stage: string };
	worktree?: { kind: "file" | "symlink"; data: string; hash: string };
	headTracked: boolean;
}
export interface PermissionSnapshot { cwd: string; paths: Map<string, PathState> }
export interface PermissionPolicy { writes?: string[]; protectedGlobs?: string[]; alwaysWritable?: string[] }
export interface PermissionEnforcement { changed: string[]; violations: string[]; preDirtyPreserved: string[] }

export class PermissionBreach extends Error {
	readonly paths: string[];
	readonly exitCode = 1;
	readonly terminal = true;
	constructor(paths: string[], preserved: string[] = []) {
		super(`PermissionBreach: unauthorized repository changes: ${paths.join(", ")}${preserved.length ? `; restored pre-dirty state for: ${preserved.join(", ")}` : ""}`);
		this.name = "PermissionBreach";
		this.paths = paths;
	}
}

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" });
}
function zlist(value: string): string[] { return value.split("\0").filter(Boolean); }
function worktreeState(cwd: string, path: string): PathState["worktree"] {
	const full = resolve(cwd, path);
	if (!existsSync(full)) return undefined;
	const stat = lstatSync(full);
	if (stat.isDirectory()) return undefined;
	const kind = stat.isSymbolicLink() ? "symlink" : "file";
	const data = kind === "symlink" ? Buffer.from(readlinkSync(full)).toString("base64") : readFileSync(full).toString("base64");
	return { kind, data, hash: createHash("sha256").update(data).digest("hex") };
}
function indexState(cwd: string, path: string): PathState["index"] {
	const raw = git(cwd, ["ls-files", "-s", "-z", "--", path]);
	const match = raw.match(/^(\d+) ([0-9a-f]+) (\d+)\t/);
	return match ? { mode: match[1], object: match[2], stage: match[3] } : undefined;
}
function headTracked(cwd: string, path: string): boolean {
	try { execFileSync("git", ["cat-file", "-e", `HEAD:${path}`], { cwd, stdio: "ignore" }); return true; } catch { return false; }
}

export function snapshot(cwd = process.cwd()): PermissionSnapshot {
	const numstat = git(cwd, ["diff", "HEAD", "--no-renames", "--numstat", "-z"]);
	const rows = zlist(numstat);
	const stats = new Map<string, string>();
	for (const row of rows) {
		const match = row.match(/^([^\t]+)\t([^\t]+)\t([\s\S]+)$/);
		if (match) stats.set(match[3], `${match[1]}\t${match[2]}`);
	}
	const trackedChanges = zlist(git(cwd, ["diff", "HEAD", "--no-renames", "--name-only", "-z"]));
	const untracked = zlist(git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]));
	const paths = new Map<string, PathState>();
	for (const path of new Set([...trackedChanges, ...untracked])) {
		paths.set(path, { path, numstat: stats.get(path) ?? "untracked", index: indexState(cwd, path), worktree: worktreeState(cwd, path), headTracked: headTracked(cwd, path) });
	}
	return { cwd: resolve(cwd), paths };
}
function signature(state?: PathState): string { return state ? JSON.stringify(state) : "clean"; }
export function changedPaths(before: PermissionSnapshot, after: PermissionSnapshot): string[] {
	const paths = new Set([...before.paths.keys(), ...after.paths.keys()]);
	return [...paths].filter(path => signature(before.paths.get(path)) !== signature(after.paths.get(path))).sort();
}

function globRegex(pattern: string): RegExp {
	let input = pattern.replaceAll("\\", "/").replace(/^\.\//, "");
	if (input.endsWith("/")) input += "**";
	let source = "^";
	for (let i = 0; i < input.length; i++) {
		const char = input[i];
		if (char === "*" && input[i + 1] === "*") {
			i++;
			if (input[i + 1] === "/") { i++; source += "(?:.*/)?"; } else source += ".*";
		} else if (char === "*") source += "[^/]*";
		else if (char === "?") source += "[^/]";
		else source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`${source}$`);
}
export function matchesWriteGlob(path: string, pattern: string): boolean { return globRegex(pattern).test(path.replaceAll("\\", "/")); }
export function permitted(path: string, policy: PermissionPolicy, cwd = process.cwd()): boolean {
	const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
	for (const always of policy.alwaysWritable ?? []) {
		const rel = relative(resolve(cwd), resolve(always)).split(sep).join("/");
		if (normalized === rel || normalized.startsWith(`${rel}/`)) return true;
	}
	const explicitlyAllowed = policy.writes?.some(glob => matchesWriteGlob(normalized, glob)) ?? false;
	if ((policy.protectedGlobs ?? []).some(glob => matchesWriteGlob(normalized, glob)) && !explicitlyAllowed) return false;
	return policy.writes === undefined || explicitlyAllowed;
}

function restoreState(cwd: string, path: string, state?: PathState): void {
	const full = resolve(cwd, path);
	if (!state) {
		if (headTracked(cwd, path)) execFileSync("git", ["restore", "--source=HEAD", "--staged", "--worktree", "--", path], { cwd });
		else { rmSync(full, { recursive: true, force: true }); try { execFileSync("git", ["update-index", "--force-remove", "--", path], { cwd, stdio: "ignore" }); } catch {} }
		return;
	}
	if (state.index) execFileSync("git", ["update-index", "--add", "--cacheinfo", `${state.index.mode},${state.index.object},${path}`], { cwd });
	else { try { execFileSync("git", ["update-index", "--force-remove", "--", path], { cwd, stdio: "ignore" }); } catch {} }
	rmSync(full, { recursive: true, force: true });
	if (state.worktree) {
		mkdirSync(dirname(full), { recursive: true });
		const data = Buffer.from(state.worktree.data, "base64");
		if (state.worktree.kind === "symlink") symlinkSync(data.toString(), full);
		else writeFileSync(full, data);
	}
}
export function rollBack(before: PermissionSnapshot, paths: string[]): string[] {
	const preserved: string[] = [];
	for (const path of paths) {
		if (before.paths.has(path)) preserved.push(path);
		restoreState(before.cwd, path, before.paths.get(path));
	}
	return preserved;
}
export function enforce(before: PermissionSnapshot, after: PermissionSnapshot, policy: PermissionPolicy): PermissionEnforcement {
	const changed = changedPaths(before, after);
	const violations = changed.filter(path => !permitted(path, policy, before.cwd));
	const preDirtyPreserved = violations.length ? rollBack(before, violations) : [];
	if (violations.length) throw new PermissionBreach(violations, preDirtyPreserved);
	return { changed, violations, preDirtyPreserved };
}
