import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";

export function snapshotWorktree(cwd) {
 const status = gitStatus(cwd);
 if (status.skipped) return { skipped: true, reason: status.reason, paths: new Set() };
 try {
  const fingerprints = new Map(status.paths.map(path => [path, fileFingerprint(cwd, path)]));
  let head = "";
  try { head = execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); } catch {}
  return { skipped: false, paths: new Set(status.paths), fingerprints, head };
 } catch (error) { return { skipped: true, reason: String(error), paths: new Set() }; }
}

function fileFingerprint(cwd, path) {
 try {
  const file = join(cwd, path), stat = lstatSync(file);
  if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error(`Cannot prove file-content delta for ${path}`);
  return createHash("sha256").update(String(stat.mode)).update("\0").update(stat.isSymbolicLink() ? readlinkSync(file) : readFileSync(file)).digest("hex");
 } catch (error) { if (error.code === "ENOENT") return "missing"; throw error; }
}

export function diffAgainst(snapshot, cwd) {
 const current = snapshotWorktree(cwd);
 if (snapshot?.skipped || current.skipped || snapshot?.head !== current.head) {
  return { skipped: true, reason: snapshot?.reason || current.reason || "HEAD changed during observation; content attribution is incomplete", paths: [] };
 }
 try {
  const paths = [...new Set([...snapshot.paths, ...current.paths])].filter(path => {
   const before = snapshot.fingerprints.get(path);
   return before === undefined || before !== (current.fingerprints.get(path) ?? fileFingerprint(cwd, path));
  }).sort();
  return { skipped: false, paths };
 } catch (error) { return { skipped: true, reason: String(error), paths: [] }; }
}

/** Runtime outputs are not input progress. Callers add explicitly supplied evidence separately. */
export function worktreeRevision(cwd, scopes = []) {
 const snapshot = snapshotWorktree(cwd);
 if (snapshot.skipped) return "unavailable";
 const entries = [...snapshot.fingerprints].filter(([path]) => !path.startsWith(".pi/agent-sessions/") && (!scopes.length || checkScope([path], scopes).inScope.length)).sort(([a], [b]) => a.localeCompare(b));
 return createHash("sha256").update(JSON.stringify([snapshot.head, entries])).digest("hex");
}

export function checkScope(changedPaths, scopeGlobs) {
	const scopes = (scopeGlobs || []).map(normalizePath).filter(Boolean);
	const inScope = [];
	const outOfScope = [];
	for (const rawPath of changedPaths || []) {
		const changed = normalizePath(rawPath);
		if (!changed) continue;
		if (scopes.some((scope) => matchesScope(changed, scope))) inScope.push(changed);
		else outOfScope.push(changed);
	}
	return { inScope: uniqueSorted(inScope), outOfScope: uniqueSorted(outOfScope) };
}

function gitStatus(cwd) {
	try {
		const output = execFileSync("git", ["-C", cwd, "status", "--porcelain", "-z", "--untracked-files=all"], {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { skipped: false, paths: parsePorcelain(output) };
	} catch (err) {
		return { skipped: true, reason: err?.message || "not a git worktree" };
	}
}

function parsePorcelain(output) {
 const entries = String(output || "").split("\0"), paths = [];
 for (let i = 0; i < entries.length; i++) {
  const entry = entries[i]; if (!entry) continue;
  paths.push(entry.slice(3));
  if (/[RC]/.test(entry.slice(0, 2)) && entries[i + 1]) paths.push(entries[++i]);
 }
 return uniqueSorted(paths);
}

function matchesScope(changedPath, scope) {
	if (hasGlob(scope)) return globToRegExp(scope).test(changedPath);
	const dir = scope.endsWith("/") ? scope.slice(0, -1) : scope;
	return changedPath === dir || changedPath.startsWith(`${dir}/`);
}

function hasGlob(scope) {
	return /[*?]/.test(scope);
}

function globToRegExp(glob) {
	let out = "^";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === "*") {
			if (glob[i + 1] === "*") {
				if (glob[i + 2] === "/") { out += "(?:.*/)?"; i += 2; }
				else { out += ".*"; i++; }
			} else {
				out += "[^/]*";
			}
		} else if (c === "?") {
			out += "[^/]";
		} else {
			out += escapeRegExp(c);
		}
	}
	out += "$";
	return new RegExp(out);
}

function normalizePath(value) {
	return String(value || "").trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+/g, "/");
}

function uniqueSorted(values) {
	return [...new Set(values)].sort();
}

function escapeRegExp(value) {
	return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}
