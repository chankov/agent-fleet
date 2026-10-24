import {canonicalMkdtempSync as mkdtempSync} from '../../../bin/test/helpers/test-temp.js';
import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import {cpSync, mkdirSync, renameSync, rmSync, symlinkSync} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { resolveSessionRoots, validateSessionRoots, parseWorktreeSelection, sessionRootsFromEnv, sessionGitEnv } from "./workspace-context.ts";

const root = mkdtempSync(join(tmpdir(), "fleet-roots-"));
const workspace = join(root, "af"), repository = join(root, "repo"), target = join(root, "repo.worktree");
mkdirSync(workspace);
mkdirSync(repository);
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], {
 env: { ...sessionGitEnv(), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, "no-config") }, stdio: "pipe",
});
git(repository, "init");
git(repository, "-c", "user.email=test@example.test", "-c", "user.name=Fixture", "commit", "--allow-empty", "-m", "initial");
git(repository, "worktree", "add", "-b", "fixture", target);
after(() => rmSync(root, { recursive: true, force: true }));

describe("immutable session root resolution", () => {
 test("legacy has no checkout requirement", () => {
  const roots = resolveSessionRoots(workspace);
  assert.equal(roots.mode, "legacy");
  assert.equal(roots.executionRoot, workspace);
  assert.equal(roots.repositoryRoot, undefined);
  assert.throws(()=>resolveSessionRoots(workspace,undefined,repository),/Legacy roots/);
 });
 test("sibling checkout needs no Fleet copy", () => {
  const roots = resolveSessionRoots(workspace, { worktree: "../repo.worktree" });
  assert.equal(roots.workspaceRoot, workspace);
  assert.equal(roots.resourceRoot, workspace);
  assert.equal(roots.configBase, workspace);
  assert.equal(roots.executionRoot, target);
  assert.equal(roots.worktreeRoot, target);
  assert.equal(roots.repositoryRoot, repository);
  assert.equal(Object.isFrozen(roots), true);
  assert.equal(Object.isFrozen(roots.executionIdentity), true);
  assert.equal(Object.isFrozen(roots.gitDirectoryIdentity), true);
  assert.deepEqual(validateSessionRoots(roots), roots);
  assert.deepEqual(sessionRootsFromEnv({ AF_SESSION_ROOTS: JSON.stringify(roots) }), roots);
 });
 test("main checkout is an explicit valid target", () => {
  const roots = resolveSessionRoots(workspace, { worktree: "../repo", repository: "../repo" });
  assert.equal(roots.executionRoot, repository);
  assert.equal(roots.repositoryRoot, repository);
 });
 test("canonical symlink and detached worktree", () => {
  const link = join(root, "link");
  symlinkSync(target, link);
  const before = resolveSessionRoots(workspace, { worktree: target });
  git(target, "checkout", "--detach");
  const after = resolveSessionRoots(workspace, { worktree: link });
  assert.equal(after.executionRoot, target);
  assert.equal(after.targetId, before.targetId);
 });
 test("normal commits do not change the session target identity", () => {
  const before = resolveSessionRoots(workspace, { worktree: target });
  git(target, "-c", "user.email=test@example.test", "-c", "user.name=Fixture", "commit", "--allow-empty", "-m", "second");
  assert.equal(validateSessionRoots(before).targetId, before.targetId);
 });
 test("non-root, missing, unrelated and bare targets refuse", () => {
  const child = join(target, "child"); mkdirSync(child);
  assert.throws(() => resolveSessionRoots(workspace, { worktree: child }));
  assert.throws(() => resolveSessionRoots(workspace, { worktree: "missing" }));
  const other = join(root, "other"); mkdirSync(other); git(other, "init");
  assert.throws(() => resolveSessionRoots(workspace, { worktree: target, repository: other }));
  const bare = join(root, "bare"); git(repository, "clone", "--bare", repository, bare);
  assert.throws(() => resolveSessionRoots(workspace, { worktree: bare }));
  assert.throws(() => resolveSessionRoots(workspace, { worktree: target, repository: "" }));
  assert.throws(() => resolveSessionRoots(workspace, { worktree: target, repository: target }));
 });
 test("replacement identity refuses rather than falling back", () => {
  const disposable = join(root, "disposable"); git(repository, "worktree", "add", "--detach", disposable);
  const roots = resolveSessionRoots(workspace, { worktree: disposable });
  renameSync(disposable, disposable + ".old"); mkdirSync(disposable);
  assert.throws(() => validateSessionRoots(roots));
 });
 test("deleted and Git-moved worktrees invalidate the old binding", () => {
  const path = join(root, "moving"); git(repository, "worktree", "add", "--detach", path);
  const roots = resolveSessionRoots(workspace, { worktree: path });
  git(repository, "worktree", "move", path, path + ".moved");
  assert.throws(() => validateSessionRoots(roots));
  const moved = resolveSessionRoots(workspace, { worktree: path + ".moved" });
  assert.notEqual(moved.targetId, roots.targetId);
  git(repository, "worktree", "remove", path + ".moved");
  assert.throws(() => validateSessionRoots(moved));
 });
 test("Git administrative-directory replacement invalidates the binding", () => {
  const path = join(root, "admin-replacement"); git(repository, "worktree", "add", "--detach", path);
  const roots = resolveSessionRoots(workspace, { worktree: path });
  renameSync(roots.gitDir!, roots.gitDir! + ".old");
  cpSync(roots.gitDir! + ".old", roots.gitDir!, { recursive: true });
  assert.throws(() => validateSessionRoots(roots));
 });
 test("registry parsing preserves spaces and newlines in external paths", () => {
  const path = join(root, "external worktree\nwith trailing whitespace \n");
  git(repository, "worktree", "add", "--detach", path);
  assert.equal(resolveSessionRoots(workspace, { worktree: path, repository }).executionRoot, path);
 });
 test("independent worktrees share neither operational identity nor execution root", () => {
  const first = resolveSessionRoots(workspace, { worktree: repository });
  const second = resolveSessionRoots(workspace, { worktree: target });
  assert.notEqual(first.targetId, second.targetId);
  assert.equal(first.commonDir, second.commonDir);
  assert.notEqual(first.executionRoot, second.executionRoot);
 });
 test("parser strips only launch options before --", () => {
  assert.deepEqual(parseWorktreeSelection(["--worktree", "../repo.worktree", "--agents", "dev"]), {
   rest: ["--agents", "dev"], selection: { worktree: "../repo.worktree", repository: undefined },
  });
  assert.deepEqual(parseWorktreeSelection(["--", "--worktree", "prompt"]), { rest: ["--", "--worktree", "prompt"] });
  for (const args of [["--worktree"], ["--worktree", "a", "--worktree", "b"], ["--repository", "a"], ["--worktree="], ["--worktree", ""], ["--repository", "a", "--repository", "b"]]) {
   assert.throws(() => parseWorktreeSelection(args));
  }
 });
 test("untrusted transport is never accepted without filesystem validation", () => {
  assert.throws(() => sessionRootsFromEnv({ AF_SESSION_ROOTS: "{}" }));
  assert.throws(() => sessionRootsFromEnv({ AF_SESSION_ROOTS: "not json" }));
  const roots = resolveSessionRoots(workspace, { worktree: target });
  for (const change of [{ targetId: "forged" }, { resourceRoot: "/wrong" }, { configBase: "/wrong" }, { worktreeRoot: repository }]) {
   assert.throws(() => sessionRootsFromEnv({ AF_SESSION_ROOTS: JSON.stringify({ ...roots, ...change }) }));
  }
  assert.throws(() => sessionRootsFromEnv({ AF_SESSION_ROOTS: JSON.stringify({ ...roots, unexpected: true }) }));
  assert.deepEqual(validateSessionRoots(JSON.parse(JSON.stringify(roots))), roots);
  assert.equal(sessionRootsFromEnv({}), undefined);
 });
 test("Git environment cannot redirect validation", () => {
  assert.deepEqual(sessionGitEnv({ GIT_DIR: "/wrong", GIT_WORK_TREE: "/wrong", GIT_CONFIG_COUNT: "1", PATH: "/bin" }), {
   PATH: "/bin", GIT_OPTIONAL_LOCKS: "0",
  });
 });
});
