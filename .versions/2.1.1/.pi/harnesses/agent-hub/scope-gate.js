import {sessionRootsFromEnv,sessionGitEnv,validateSessionRoots} from "../lib/workspace-context.js";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export function snapshotWorktree(cwd, scopes = []) {
 let binding;try{binding=sessionRootsFromEnv();if(binding?.mode==="targeted"&&realpathSync(cwd)!==binding.executionRoot)return {skipped:true,reason:"target_mismatch",paths:new Set(),head:undefined,fingerprints:new Map()};}catch{return {skipped:true,reason:"target_unavailable",paths:new Set(),head:undefined,fingerprints:new Map()};}
 const status = gitStatus(cwd);
 if (status.skipped&&binding?.mode==='targeted')return {skipped:true,reason:status.reason,paths:new Set(),head:undefined,fingerprints:new Map()};
 if (status.skipped) return scopes.length ? snapshotNestedWorktrees(cwd, scopes) : { skipped: true, reason: status.reason, paths: new Set() };
 try {
  const fingerprints = new Map(status.paths.map(path => [path, fileFingerprint(cwd, path)]));
  let head = "";
  try { head = execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], { env:sessionRootsFromEnv()?.mode==="targeted"?sessionGitEnv():process.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); } catch {}
  if(binding)validateSessionRoots(binding);
  return { skipped: false, paths: new Set(status.paths), fingerprints, head,...(binding?.mode==="targeted"?{targetId:binding.targetId}:{}) };
 } catch (error) { return { skipped: true, reason: String(error), paths: new Set() }; }
}

function within(root, path) {
 const rel = relative(root, path);
 return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}

// Resolve only the literal anchor of a declared scope. Never enumerate children
// to find repositories, and never accept Git's discovery above the workspace.
function scopeRepository(cwd, scope) {
 const workspace = realpathSync(cwd), absolute = resolve(workspace, normalizePath(scope));
 if (!within(workspace, absolute)) throw new Error("Scope is outside the workspace");
 const declared = relative(workspace, absolute), wildcard = declared.search(/[*?]/);
 let anchor = wildcard < 0 ? absolute : resolve(workspace, dirname(declared.slice(0, wildcard) + "anchor"));
 while (within(workspace, anchor)) {
  try {
   const stat = lstatSync(anchor);
   if (stat.isDirectory() || stat.isSymbolicLink()) break;
  } catch (error) { if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error; }
  if (anchor === workspace) break;
  anchor = dirname(anchor);
 }
 const physical = realpathSync(anchor);
 if (!within(workspace, physical)) throw new Error("Scope anchor is outside the workspace");
 const root = realpathSync(execFileSync("git", ["-C", physical, "rev-parse", "--show-toplevel"], { env:sessionRootsFromEnv()?.mode==="targeted"?sessionGitEnv():process.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim());
 if (root === workspace || !within(workspace, root) || !within(root, absolute)) throw new Error("No declared repository inside the workspace");
 return { root, prefix: relative(workspace, root).replace(/\\/g, "/"), localScope: relative(root, absolute).replace(/\\/g, "/") || "." };
}

// Nested observation records metadata only, without capturing file contents.
// ctime also detects same-size writes or a dirty file restored to clean status.
function metadataFingerprint(cwd, path) {
 try {
  const stat = lstatSync(join(cwd, path), { bigint: true });
  return [stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs, stat.ino].join(":");
 } catch (error) { if (error.code === "ENOENT") return "missing"; throw error; }
}

function snapshotNestedWorktrees(cwd, scopes) {
 const groups = new Map(), gaps = [], repositories = [];
 for (const scope of scopes) {
  try {
   const found = scopeRepository(cwd, scope);
   if (!groups.has(found.root)) groups.set(found.root, { ...found, scopes: [], localScopes: [] });
   groups.get(found.root).scopes.push(scope);
   groups.get(found.root).localScopes.push(found.localScope);
  } catch (error) { gaps.push({ scope, reason: String(error) }); }
 }
 for (const group of [...groups.values()].sort((a, b) => a.prefix.localeCompare(b.prefix))) {
  try {
   const status = gitStatus(group.root, group.localScopes);
   if (status.skipped) throw new Error(status.reason);
   const head = execFileSync("git", ["-C", group.root, "rev-parse", "HEAD"], { env:sessionRootsFromEnv()?.mode==="targeted"?sessionGitEnv():process.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
   const paths = status.paths.filter(path => !isSessionOutput(path) && group.localScopes.some(scope => scope === "." || matchesScope(path, scope)));
   repositories.push({ ...group, head, paths: new Set(paths), fingerprints: new Map(paths.map(path => [path, metadataFingerprint(group.root, path)])) });
  } catch (error) { for (const scope of group.scopes) gaps.push({ scope, reason: String(error) }); }
 }
 const fingerprints = new Map(repositories.flatMap(repo => [...repo.fingerprints].map(([path, value]) => [`${repo.prefix}/${path}`, value])));
 return { nested: true, scopes: [...scopes], repositories, gaps, skipped: repositories.length === 0,
  reason: gaps.length ? "Declared scopes have incomplete Git observation" : undefined,
  paths: new Set(fingerprints.keys()), fingerprints, head: JSON.stringify(repositories.map(repo => [repo.prefix, repo.head])) };
}

function fileFingerprint(cwd, path) {
 try {
  const file = join(cwd, path), stat = lstatSync(file);
  if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error(`Cannot prove file-content delta for ${path}`);
  return createHash("sha256").update(String(stat.mode)).update("\0").update(stat.isSymbolicLink() ? readlinkSync(file) : readFileSync(file)).digest("hex");
 } catch (error) { if (error.code === "ENOENT") return "missing"; throw error; }
}

export function diffAgainst(snapshot, cwd) {
 if (snapshot?.nested) {
  const current = snapshotNestedWorktrees(cwd, snapshot.scopes), gaps = [...current.gaps], paths = [];
  for (const repo of snapshot.repositories) {
   const after = current.repositories.find(r => r.root === repo.root);
   if (!after || repo.head !== after.head) {
    for (const scope of repo.scopes) if (!gaps.some(g => g.scope === scope)) gaps.push({ scope, reason: "Repository disappeared or HEAD changed during observation" });
    continue;
   }
   try { paths.push(...changedPaths(repo, after, path => metadataFingerprint(repo.root, path)).map(path => `${repo.prefix}/${path}`)); }
   catch (error) { for (const scope of repo.scopes) gaps.push({ scope, reason: String(error) }); }
  }
  for (const repo of current.repositories) if (!snapshot.repositories.some(r => r.root === repo.root)) {
   for (const scope of repo.scopes) gaps.push({ scope, reason: "Repository was not observed before execution" });
  }
  return { skipped: snapshot.skipped || current.skipped, reason: gaps.length ? "Declared scopes have incomplete Git observation" : undefined, paths: uniqueSorted(paths), gaps, repositories: current.repositories.map(({ root, prefix, head, scopes }) => ({ root, prefix, head, scopes })), snapshot: current };
 }
 const current = snapshotWorktree(cwd);
 if (snapshot?.skipped || current.skipped || snapshot?.head !== current.head) {
  return { skipped: true, reason: snapshot?.reason || current.reason || "HEAD changed during observation; content attribution is incomplete", paths: [] };
 }
 try {
  const paths = changedPaths(snapshot, current, path => fileFingerprint(cwd, path));
  return { skipped: false, paths, snapshot: current };
 } catch (error) { return { skipped: true, reason: String(error), paths: [] }; }
}

function changedPaths(before, after, fingerprint) {
 return [...new Set([...before.paths, ...after.paths])].filter(path => before.fingerprints.get(path) === undefined || before.fingerprints.get(path) !== (after.fingerprints.get(path) ?? fingerprint(path))).sort();
}

const isSessionOutput = path => path.startsWith(".pi/agent-sessions/");

/** Review task edits, not outputs created inside this run's own session directory.
 * A declared scope/deliverable under that directory is still a task edit to review.
 * Other sessions' files and all non-session paths remain reviewable.
 */
export function reviewableChangedPaths(paths, cwd, sessionDir, scopes = [], deliverables = []) {
 const sessionPath = relative(resolve(cwd), resolve(sessionDir)).replace(/\\/g, "/");
 const ownedSession = /^\.pi\/agent-sessions\/sessions\/[^/]+$/.test(sessionPath) && !isAbsolute(sessionPath);
 // A generic glob (for example **/*.md) does not explicitly select runtime evidence.
 const explicitSessionScopes = scopes.filter(scope => {
  const normalized = normalizePath(scope);
  return normalized === sessionPath || normalized.startsWith(`${sessionPath}/`);
 });
 return paths.filter(path => {
  const output = path.startsWith(`${sessionPath}/`) ? path.slice(sessionPath.length + 1) : "";
  if (!ownedSession || !/^(?:artifacts|dispatches|transcripts|findings|delegations)\/|^(?:session|assertions)\.json$/.test(output)) return true;
  return checkScope([path], explicitSessionScopes).inScope.length > 0 || deliverables.some(file => relative(resolve(cwd), resolve(file)) === path);
 });
}

/** Runtime outputs are not input progress. Callers add explicitly supplied evidence separately. */
export function worktreeRevision(cwd, scopes = [], declaredScopes = scopes) {
 return snapshotRevision(snapshotWorktree(cwd, declaredScopes), scopes);
}

/** The revision of an existing snapshot: equal to worktreeRevision taken at that moment,
 * so one observation can serve several consumers without another git status and rehash. */
export function snapshotRevision(snapshot, scopes = []) {
 if (snapshot.skipped || snapshot.gaps?.length) return "unavailable";
 const entries = [...snapshot.fingerprints].filter(([path]) => !isSessionOutput(path) && (snapshot.nested || !scopes.length || checkScope([path], scopes).inScope.length)).sort(([a], [b]) => a.localeCompare(b));
 return createHash("sha256").update(JSON.stringify([...(snapshot.targetId?[snapshot.targetId]:[]),snapshot.head, entries])).digest("hex");
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

function gitStatus(cwd, scopes = []) {
	try {
		const pathspecs = scopes.map(scope => scope === "." ? ":(top,glob)**" : `:(top,${hasGlob(scope) ? "glob" : "literal"})${scope}`);
		const output = execFileSync("git", ["-C", cwd, "status", "--porcelain", "-z", "--untracked-files=all", ...(pathspecs.length ? ["--", ...pathspecs] : [])], {
			env:sessionRootsFromEnv()?.mode==="targeted"?sessionGitEnv():process.env,
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
