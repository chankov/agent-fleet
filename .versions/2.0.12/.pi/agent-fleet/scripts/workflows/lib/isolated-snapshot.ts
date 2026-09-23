import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { constants } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const ISOLATED_SNAPSHOT_SCHEMA = "agent-fleet.flow-snapshot/v1" as const;
export interface SnapshotEntry { path: string; sha256: string | null; size: number; mode: number; state: "file" | "deleted" }
export interface IsolatedSnapshotManifest {
	schema: typeof ISOLATED_SNAPSHOT_SCHEMA; sourceRoot: string; sourceRevision: string; sourceStateHash: string;
	createdAt: string; entries: SnapshotEntry[]; excluded: string[]; workspace: string;
}

function git(cwd: string, args: string[]): string { return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }); }
function safeRelative(path: string): string {
	const value = path.replaceAll("\\", "/").replace(/^\.\//, "");
	if (!value || isAbsolute(value) || value.split("/").includes("..") || value.includes("\0")) throw new Error(`Unsafe snapshot path: ${JSON.stringify(path)}`);
	return value;
}
function sensitive(path: string): boolean {
	const parts = path.toLowerCase().split("/"); const base = parts.at(-1) ?? "";
	return parts.includes("agent-sessions") || parts.includes("flow-sessions") || /^\.env(?:\.|$)/.test(base) || /^(?:auth|credentials?|secrets?)\.json$/.test(base);
}
function assertInside(root: string, path: string, label: string): void {
	const fromRoot = relative(root, path);
	if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) throw new Error(`${label} escapes owned root`);
}
function pathExists(path: string): boolean { try { lstatSync(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } }
function assertPlainParents(root: string, relativePath: string): void {
	let current = root;
	for (const part of relativePath.split("/").slice(0, -1)) {
		current = join(current, part);
		assertInside(root, current, `Snapshot path ${relativePath}`);
		if (pathExists(current) && lstatSync(current).isSymbolicLink()) throw new Error(`Snapshot path traverses symlink: ${relativePath}`);
	}
}
function stableBytes(root: string, path: string): { data: Buffer; mode: number } {
	const full = resolve(root, path);
	assertInside(root, full, `Snapshot source ${path}`);
	assertPlainParents(root, path);
	let fd: number | undefined;
	try {
		fd = openSync(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		const before = fstatSync(fd);
		if (!before.isFile()) throw new Error(`Snapshot source must be a plain file: ${path}`);
		const data = readFileSync(fd);
		const after = fstatSync(fd);
		if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error(`Snapshot source changed while read: ${path}`);
		return { data, mode: before.mode & 0o777 };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new Error(`Snapshot source must be a plain file: ${path}`);
		throw error;
	} finally { if (fd !== undefined) closeSync(fd); }
}
function inspect(root: string, path: string): SnapshotEntry {
	const full = resolve(root, path);
	assertInside(root, full, `Snapshot source ${path}`);
	assertPlainParents(root, path);
	if (!pathExists(full)) return { path, sha256: null, size: 0, mode: 0, state: "deleted" };
	const { data, mode } = stableBytes(root, path);
	return { path, sha256: createHash("sha256").update(data).digest("hex"), size: data.length, mode, state: "file" };
}
function stateHash(entries: SnapshotEntry[]): string { return createHash("sha256").update(JSON.stringify(entries)).digest("hex"); }
function listedPaths(root: string): { included: string[]; excluded: string[] } {
	const raw = git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
	const all = raw.split("\0").filter(Boolean).map(safeRelative).sort();
	return { included: all.filter(path => !sensitive(path)), excluded: all.filter(sensitive) };
}
function removeOwnedLeaf(root: string, path: string): void {
	const destination = resolve(root, path);
	assertInside(root, destination, `Snapshot destination ${path}`);
	assertPlainParents(root, path);
	if (!pathExists(destination)) return;
	const value = lstatSync(destination);
	if (value.isDirectory() && !value.isSymbolicLink()) throw new Error(`Snapshot destination unexpectedly became a directory: ${path}`);
	unlinkSync(destination); // unlink the leaf itself; never recurse through or follow its target
}
function prepareOwnedParents(root: string, path: string): void {
	assertPlainParents(root, path);
	mkdirSync(dirname(resolve(root, path)), { recursive: true, mode: 0o700 });
	assertPlainParents(root, path);
}
function writeOwnedFile(root: string, entry: SnapshotEntry, data: Buffer): void {
	const destination = resolve(root, entry.path);
	assertInside(root, destination, `Snapshot destination ${entry.path}`);
	prepareOwnedParents(root, entry.path);
	removeOwnedLeaf(root, entry.path);
	assertPlainParents(root, entry.path);
	let fd: number | undefined;
	try {
		fd = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), entry.mode);
		writeSync(fd, data);
	} finally { if (fd !== undefined) closeSync(fd); }
	chmodSync(destination, entry.mode);
}

/** Create a detached local clone plus a stable overlay of the current working tree. Never mutates sourceRoot. */
export function createIsolatedWorkingTreeSnapshot(sourceRoot: string, workspace: string, manifestPath: string): IsolatedSnapshotManifest {
	const root = resolve(sourceRoot), target = resolve(workspace);
	if (target === root || !relative(root, target).startsWith("..")) throw new Error("Snapshot destination must be outside the source tree");
	if (pathExists(target)) throw new Error("Snapshot destination must be newly owned and absent");
	const sourceRevision = git(root, ["rev-parse", "HEAD"]).trim();
	const { included, excluded } = listedPaths(root);
	const first = included.map(path => inspect(root, path));
	mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
	execFileSync("git", ["clone", "--quiet", "--no-hardlinks", "--no-checkout", root, target]);
	execFileSync("git", ["checkout", "--quiet", "--detach", sourceRevision], { cwd: target });
	for (const path of excluded) removeOwnedLeaf(target, path);
	for (const entry of first) {
		if (entry.state === "deleted") removeOwnedLeaf(target, entry.path);
		else {
			const { data } = stableBytes(root, entry.path);
			const currentHash = createHash("sha256").update(data).digest("hex");
			if (currentHash !== entry.sha256 || data.length !== entry.size) throw new Error(`Snapshot source changed before copy: ${entry.path}`);
			writeOwnedFile(target, entry, data);
			const copied = inspect(target, entry.path);
			if (copied.sha256 !== entry.sha256 || copied.size !== entry.size) throw new Error(`Snapshot copy did not match stable source: ${entry.path}`);
		}
	}
	const second = included.map(path => inspect(root, path));
	if (stateHash(first) !== stateHash(second)) { rmSync(target, { recursive: true, force: true }); throw new Error("Source working tree changed while isolated snapshot was created"); }
	const manifest: IsolatedSnapshotManifest = { schema: ISOLATED_SNAPSHOT_SCHEMA, sourceRoot: root, sourceRevision, sourceStateHash: stateHash(second), createdAt: new Date().toISOString(), entries: second, excluded, workspace: target };
	mkdirSync(dirname(manifestPath), { recursive: true, mode: 0o700 }); writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o400 });
	return manifest;
}
