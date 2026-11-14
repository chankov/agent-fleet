// Pure root selection shared by the launcher and Hub. This is routing, not consent.
import { createHash } from "node:crypto";
import { AsyncLocalStorage } from 'node:async_hooks';
const contextKey=Symbol.for('agent-fleet.session-root-context.v1');
const contexts=globalThis[contextKey]??(globalThis[contextKey]=new AsyncLocalStorage());
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

function directory(path) {
 const canonical = realpathSync(path);
 const stat = statSync(canonical, { bigint: true });
 if (!stat.isDirectory()) throw new Error(`Not a directory: ${path}`);
 return { path: canonical, device: String(stat.dev), inode: String(stat.ino), birthtime:String(stat.birthtimeNs) };
}
export function sessionGitEnv(env = process.env) {
 const clean = { ...env };
 for (const key of Object.keys(clean)) if (key.startsWith("GIT_")) delete clean[key];
 return { ...clean, GIT_OPTIONAL_LOCKS: "0" };
}
function git(cwd, args) {
 return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...sessionGitEnv(), GIT_TERMINAL_PROMPT: "0" }, timeout: 10_000, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}
// Remove only Git's record terminator, not whitespace that belongs to a path.
function gitPath(cwd, option) {
 return git(cwd, ["rev-parse", option]).replace(/\n$/, "");
}
function gitDirectory(cwd, name) {
 return realpathSync(resolve(cwd, gitPath(cwd, name)));
}
function identity(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function worktrees(repository) {
 const fields = git(repository, ["worktree", "list", "--porcelain", "-z"]).split("\0");
 return fields.filter(field => field.startsWith("worktree ")).map(field => field.slice(9));
}
/** Relative selection is always relative to workspace, never the caller/checkout. */
export function resolveSessionRoots(workspace, selection, execution = workspace) {
 const workspaceIdentity = directory(workspace);
 // Managed installation symlinks do not relocate human configuration.
 let resourceIdentity=workspaceIdentity;
 for(const entry of ['.pi/agent-fleet/scripts/fleet.ts','.pi/harnesses/damage-control-continue/index.ts']){
  const file=resolve(workspaceIdentity.path,entry);if(!existsSync(file))continue;
  resourceIdentity=directory(resolve(realpathSync(file),'../../../..'));break;
 }
 if (selection === undefined) {
  const root = directory(execution);
  if(root.path!==workspaceIdentity.path)throw new Error('Legacy roots cannot select another execution directory; use an explicit worktree selection');
  return Object.freeze({ version: 1, mode: "legacy", workspaceRoot: workspaceIdentity.path, resourceRoot: resourceIdentity.path, resourceIdentity:Object.freeze(resourceIdentity), executionRoot: root.path,
   workspaceIdentity: Object.freeze(workspaceIdentity), executionIdentity: Object.freeze(root), targetId: identity([workspaceIdentity, resourceIdentity, root]), configBase: workspaceIdentity.path });
 }
 if (!selection || !selection.worktree) throw new Error("Target requires a worktree");
 const target = directory(resolve(workspaceIdentity.path, selection.worktree));
 // Git's registry identifies the owning main checkout; no basename heuristic or search.
 if (selection.repository !== undefined && !selection.repository) throw new Error("Repository path must not be empty");
 const owner = selection.repository ? resolve(workspaceIdentity.path, selection.repository) : worktrees(target.path)[0];
 if (!owner) throw new Error("Cannot identify worktree repository");
 const repository = directory(owner);
 if (realpathSync(gitPath(repository.path, "--show-toplevel")) !== repository.path) throw new Error("Repository must be a checkout root");
 if (realpathSync(gitPath(target.path, "--show-toplevel")) !== target.path) throw new Error("Worktree must be a checkout root");
 if (realpathSync(worktrees(repository.path)[0]) !== repository.path) throw new Error("Repository must identify the registered main checkout");
 if (git(target.path, ["rev-parse", "--is-bare-repository"]).trim() !== "false") throw new Error("Bare target is unsupported");
 const repositoryCommonDir = gitDirectory(repository.path, "--git-common-dir");
 const commonDir = gitDirectory(target.path, "--git-common-dir");
 const gitDir = gitDirectory(target.path, "--git-dir");
 const commonDirectoryIdentity = Object.freeze(directory(commonDir));
 const gitDirectoryIdentity = Object.freeze(directory(gitDir));
 if (commonDir !== repositoryCommonDir) throw new Error("Worktree belongs to a different repository");
 if (!worktrees(repository.path).some(path => { try { return realpathSync(path) === target.path; } catch { return false; } })) throw new Error("Target is not a registered worktree");
 const binding = { version: 1, mode: "targeted", workspaceRoot: workspaceIdentity.path, resourceRoot: resourceIdentity.path, resourceIdentity:Object.freeze(resourceIdentity), executionRoot: target.path,
  repositoryRoot: repository.path, worktreeRoot: target.path, commonDir, gitDir, commonDirectoryIdentity, gitDirectoryIdentity,
  workspaceIdentity: Object.freeze(workspaceIdentity), executionIdentity: Object.freeze(target), repositoryIdentity: Object.freeze(repository), configBase: workspaceIdentity.path };
 return Object.freeze({ ...binding, targetId: identity([workspaceIdentity, resourceIdentity, target, repository, commonDirectoryIdentity, gitDirectoryIdentity]) });
}
/** Re-resolve instead of trusting serialized environment/session metadata. */
export function validateSessionRoots(binding) {
 if (!binding || binding.version !== 1) throw new Error("Invalid session root binding");
 const current = resolveSessionRoots(binding.workspaceRoot, binding.mode === "targeted" ? { repository: binding.repositoryRoot, worktree: binding.executionRoot } : undefined, binding.executionRoot);
 if (current.targetId !== binding.targetId) throw new Error("Session root identity changed; start a new session explicitly");
 // Reject misleading serialized fields instead of silently repairing a corrupt transport.
 if (!isDeepStrictEqual(current, binding)) throw new Error("Invalid session root binding fields");
 return current;
}
export function parseWorktreeSelection(args) {
 const rest = []; let worktree; let repository;
 for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--") { rest.push(...args.slice(i)); break; }
  if (arg === "--worktree" || arg === "--repository") {
   const value = args[++i];
   if (!value || value.startsWith("--")) throw new Error(`${arg} requires a path`);
   if (arg === "--worktree") { if (worktree !== undefined) throw new Error("Duplicate --worktree"); worktree = value; }
   else { if (repository !== undefined) throw new Error("Duplicate --repository"); repository = value; }
  } else if (arg.startsWith("--worktree=") || arg.startsWith("--repository=")) throw new Error("Use --worktree <path> and --repository <path>");
  else rest.push(arg);
 }
 if (repository !== undefined && worktree === undefined) throw new Error("--repository requires --worktree");
 return { rest, ...(worktree !== undefined ? { selection: { worktree, repository } } : {}) };
}
export function withSessionRoots(binding,body){return contexts.run(validateSessionRoots(binding),body);}
export function sessionRootsFromEnv(env = process.env) {
 const scoped=env===process.env?contexts.getStore():undefined;
 if(scoped)return validateSessionRoots(scoped);
 if (!env.AF_SESSION_ROOTS) return undefined;
 let binding; try { binding = JSON.parse(env.AF_SESSION_ROOTS); } catch { throw new Error("Invalid AF_SESSION_ROOTS"); }
 return validateSessionRoots(binding);
}
export function targetProject(base,roots) { return roots.mode==='targeted'?`${base}-wt-${roots.targetId.slice(0,32)}`:base; }
export function projectForSession(base,roots,env=process.env) {
 if(env.AF_TARGET_BASE_PROJECT&&env.AF_TARGET_EFFECTIVE_PROJECT===targetProject(env.AF_TARGET_BASE_PROJECT,roots)&&base===env.AF_TARGET_EFFECTIVE_PROJECT)return {baseProject:env.AF_TARGET_BASE_PROJECT,project:base};
 return {baseProject:base,project:targetProject(base,roots)};
}
export function targetEnvironment(roots,env=process.env) { return {...(roots.mode==='targeted'?sessionGitEnv(env):env),AF_SESSION_ROOTS:JSON.stringify(validateSessionRoots(roots))}; }
export function workspaceRoot(cwd, env = process.env) { return sessionRootsFromEnv(env)?.workspaceRoot ?? cwd; }
export function executionRoot(cwd, env = process.env) { return sessionRootsFromEnv(env)?.executionRoot ?? cwd; }
