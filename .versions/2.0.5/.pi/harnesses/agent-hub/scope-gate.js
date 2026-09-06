import { execFileSync } from "node:child_process";

export function snapshotWorktree(cwd) {
	const status = gitStatus(cwd);
	if (status.skipped) return { skipped: true, reason: status.reason, paths: new Set() };
	return { skipped: false, paths: new Set(status.paths) };
}

export function diffAgainst(snapshot, cwd) {
	const current = snapshotWorktree(cwd);
	if (snapshot?.skipped || current.skipped) {
		return { skipped: true, reason: snapshot?.reason || current.reason || "scope gate skipped", paths: [] };
	}
	const before = snapshot?.paths instanceof Set ? snapshot.paths : new Set(snapshot?.paths || []);
	const paths = [...current.paths].filter((p) => !before.has(p)).sort();
	return { skipped: false, paths };
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
		const output = execFileSync("git", ["-C", cwd, "status", "--porcelain", "--untracked-files=all"], {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { skipped: false, paths: parsePorcelain(output) };
	} catch (err) {
		return { skipped: true, reason: err?.message || "not a git worktree" };
	}
}

function parsePorcelain(output) {
	const paths = [];
	for (const line of String(output || "").split(/\r?\n/)) {
		if (!line.trim()) continue;
		let file = line.slice(3).trim();
		const rename = file.match(/ -> (.+)$/);
		if (rename) file = rename[1];
		paths.push(normalizePath(unquotePorcelainPath(file)));
	}
	return uniqueSorted(paths.filter(Boolean));
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
				out += ".*";
				i++;
			} else {
				out += "[^/]*";
			}
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

function unquotePorcelainPath(value) {
	const trimmed = String(value || "").trim();
	if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
		try { return JSON.parse(trimmed); } catch { return trimmed.slice(1, -1); }
	}
	return trimmed;
}

function escapeRegExp(value) {
	return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}
