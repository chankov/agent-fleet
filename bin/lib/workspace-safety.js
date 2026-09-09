// Shared workspace path and single-writer safety.
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const LOCK_REL_PATH = ".ai/agent-fleet.lock";

export function ownedRelativePath(workspace, value, label = "path") {
  if (typeof value !== "string" || !value) throw new Error(`${label} must be a non-empty workspace path`);
  const rel = relative(resolve(workspace), isAbsolute(value) ? resolve(value) : resolve(workspace, value));
  if (rel === "") return ".";
  if (rel === ".." || rel.startsWith(`..${sep}`) || rel.split(sep).includes("..")) throw new Error(`${label} is outside the workspace: ${value}`);
  return rel;
}

/** Refuse writes through any existing parent symlink. Leaf symlinks remain valid managed targets. */
export function assertSafeWorkspaceTarget(workspace, value, { allowLeafSymlink = true } = {}) {
  const rel = ownedRelativePath(workspace, value, "target path");
  let cursor = resolve(workspace);
  for (const [index, part] of rel.split(sep).entries()) {
    cursor = join(cursor, part);
    if (!existsSync(cursor)) continue;
    const leaf = index === rel.split(sep).length - 1;
    if (lstatSync(cursor).isSymbolicLink() && !(leaf && allowLeafSymlink)) {
      throw new Error(`refusing target through symlink: ${rel}`);
    }
  }
  return join(resolve(workspace), rel);
}

export function lockPath(workspace) { return join(workspace, LOCK_REL_PATH); }
export function breakWorkspaceLock(workspace) {
  const path = assertSafeWorkspaceTarget(workspace, LOCK_REL_PATH, { allowLeafSymlink: false });
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}

/** No stale-lock stealing: recovery is an explicit operator decision. */
export function acquireWorkspaceLock(workspace, operation) {
  const path = lockPath(workspace);
  assertSafeWorkspaceTarget(workspace, LOCK_REL_PATH, { allowLeafSymlink: false });
  const parentExisted = existsSync(dirname(path));
  mkdirSync(dirname(path), { recursive: true });
  let fd;
  try { fd = openSync(path, "wx", 0o600); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    let owner = "unknown owner";
    try { owner = readFileSync(path, "utf8").trim() || owner; } catch {}
    throw Object.assign(new Error(`workspace is locked (${owner}); locks are never stolen automatically`), { exitCode: 4 });
  }
  const body = JSON.stringify({ schemaVersion: 1, pid: process.pid, operation, createdAt: new Date().toISOString() }) + "\n";
  writeFileSync(fd, body); closeSync(fd);
  let released = false;
  return {
    path,
    release() {
      if (released) return;
      released = true;
      try {
        const current = JSON.parse(readFileSync(path, "utf8"));
        if (current.pid === process.pid) rmSync(path, { force: true });
        if (!parentExisted) try { rmdirSync(dirname(path)); } catch {}
      } catch {}
    },
  };
}

export function assertWorkspaceRootSafe(workspace) {
  const root = realpathSync(workspace);
  if (root !== resolve(workspace)) throw new Error("workspace root must not be a symlink");
}
