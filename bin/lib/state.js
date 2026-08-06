// state.js — the workspace install state file.
//
// `.ai/agent-fleet-state.json` records what agent-fleet installed into a
// workspace: which items, which files, which method, and the content hash at
// install time. It is the machine contract that replaces parsing the prose
// install record — see plans/deterministic-installer-manifest-spec.md §3.
//
// Two things depend on it that prose cannot provide:
//   • ownership — an entry means "we installed this"; anything absent is never
//     removed or overwritten, so the removal-scope rule becomes a lookup;
//   • modification detection — the recorded hash is the middle term of the
//     three-way merge (base × ours × theirs) that upgrade performs.
//
// The human-readable `.ai/agent-fleet-setup.md` is rendered FROM this file and
// is never parsed back, so the two cannot disagree.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, lstatSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

export const STATE_SCHEMA_VERSION = 1;
export const STATE_REL_PATH = join(".ai", "agent-fleet-state.json");
export const LEGACY_RECORD_REL_PATH = join(".ai", "agent-fleet-setup.md");

// Never walked into: install artifacts, not agent-fleet content.
const SKIP_DIR_NAMES = new Set(["node_modules", ".git", "dist", "build"]);
const SKIP_FILE_NAMES = new Set([".DS_Store"]);

// ── read / write ────────────────────────────────────────────────────────────

/** @returns {object|null} parsed state, or null when the workspace has none. */
export function readState(workspace) {
  const path = join(workspace, STATE_REL_PATH);
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (err) { throw new Error(`${STATE_REL_PATH} is unreadable: ${err.message}`); }
}

export function writeState(workspace, state) {
  const path = join(workspace, STATE_REL_PATH);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(orderState(state), null, 2) + "\n", "utf8");
  return path;
}

export function emptyState({ agent, method, packageVersion, sourceRoot, profiles = [] }) {
  const now = new Date().toISOString();
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    agent,
    method,
    packageVersion,
    sourceRoot,
    profiles: [...profiles].sort(),
    installedAt: now,
    updatedAt: now,
    items: {},
    externalPackages: [],
    runtimeRepairs: [],
    events: [],
  };
}

// Fixed key order + capped event log keeps the file small and diffable.
const MAX_EVENTS = 20;

function orderState(state) {
  return {
    schemaVersion: state.schemaVersion ?? STATE_SCHEMA_VERSION,
    agent: state.agent,
    method: state.method,
    packageVersion: state.packageVersion,
    sourceRoot: state.sourceRoot,
    profiles: [...(state.profiles ?? [])].sort(),
    installedAt: state.installedAt,
    updatedAt: state.updatedAt,
    items: Object.fromEntries(
      Object.keys(state.items ?? {}).sort().map((k) => [k, state.items[k]]),
    ),
    externalPackages: state.externalPackages ?? [],
    runtimeRepairs: state.runtimeRepairs ?? [],
    events: (state.events ?? []).slice(-MAX_EVENTS),
  };
}

/**
 * Read the pre-engine markdown install record. Used only to report version
 * drift and the recorded agent for a workspace that predates the state file —
 * never to infer ownership (§3.1: reconstruction hashes disk content instead).
 *
 * @returns {{version: string|null, agent: string|null}|null}
 */
export function readLegacyRecord(workspace) {
  const path = join(workspace, LEGACY_RECORD_REL_PATH);
  if (!existsSync(path)) return null;
  let text;
  try { text = readFileSync(path, "utf8"); } catch { return null; }
  const version = text.match(/^version:\s*([^\s#]+)/m)?.[1]?.trim() ?? null;
  const agent = text.match(/^(?:coding-)?agent:\s*([^\s#]+)/m)?.[1]?.trim() ?? null;
  return { version, agent };
}

// ── hashing ─────────────────────────────────────────────────────────────────

export function hashText(text) {
  return createHash("sha256").update(text).digest("hex");
}

/** sha256 of a file's raw bytes; null when it does not exist or is unreadable. */
export function hashFile(path) {
  try { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
  catch { return null; }
}

/**
 * Sorted relative file list of a directory tree. Symlinked entries are
 * reported as files so a linked artifact is never walked into.
 *
 * @returns {string[]} POSIX-style relative paths
 */
export function walkTree(rootDir) {
  const out = [];
  if (!existsSync(rootDir)) return out;

  const visit = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) { out.push(toPosix(relative(rootDir, full))); continue; }
      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES.has(entry.name)) continue;
        visit(full);
        continue;
      }
      if (SKIP_FILE_NAMES.has(entry.name)) continue;
      out.push(toPosix(relative(rootDir, full)));
    }
  };
  visit(rootDir);
  return out.sort();
}

/** `[{ path, sha256 }]` for every file under a tree, relative to it. */
export function hashTree(rootDir) {
  return walkTree(rootDir).map((rel) => ({
    path: rel,
    sha256: hashFile(join(rootDir, rel)),
  }));
}

// ── symlink helpers ─────────────────────────────────────────────────────────

/**
 * Classify a workspace path.
 *
 * @returns {{kind: "absent"|"file"|"dir"|"symlink", linkTarget?: string, dangling?: boolean}}
 */
export function inspectPath(path) {
  let st;
  try { st = lstatSync(path); } catch { return { kind: "absent" }; }
  if (st.isSymbolicLink()) {
    let linkTarget = null;
    let dangling = true;
    try { linkTarget = realpathSync(path); dangling = false; } catch { /* dangling */ }
    return { kind: "symlink", linkTarget, dangling };
  }
  return { kind: st.isDirectory() ? "dir" : "file" };
}

/** True when `child` is inside `parent` (or equal), comparing normalized paths.
 *
 *  Both arguments must already be resolved the same way. Callers holding a
 *  realpath — anything from `inspectPath().linkTarget` — want
 *  `linkPointsInside` instead. */
export function isInside(parent, child) {
  if (!parent || !child) return false;
  const p = resolve(parent);
  const c = resolve(child);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/**
 * True when a symlink's resolved target points into `root`.
 *
 * `inspectPath` reports `linkTarget` through realpathSync, so the root it is
 * measured against has to be resolved the same way. Comparing a realpath
 * against a raw path disagrees the moment any component of the root is itself a
 * symlink, and the answer is silently wrong rather than an error: the planner
 * decides a perfectly good link points outside the source tree and schedules a
 * repair. On macOS both /tmp and /var are symlinks, which is where this
 * surfaced.
 */
export function linkPointsInside(root, linkTarget) {
  if (!root || !linkTarget) return false;
  let resolvedRoot = root;
  try { resolvedRoot = realpathSync(root); } catch { /* unresolvable: compare as given */ }
  return isInside(resolvedRoot, linkTarget);
}

/**
 * npx caches are wiped without warning, which breaks every symlink pointing
 * into them. A recorded source root inside one is flagged so `verify` can warn
 * rather than wait for the links to dangle.
 */
export function isVolatileSourceRoot(sourceRoot) {
  if (!sourceRoot) return false;
  const p = toPosix(sourceRoot);
  return p.includes("/_npx/") || p.includes("/.npm/_cacache/");
}

export const PACKAGE_NAME = "@chankov/agent-fleet";

/**
 * Is this workspace an agent-fleet checkout?
 *
 * Symlink installs are supported only here. Everywhere else they are a trap:
 * the link target has to stay put forever, an npx cache clean breaks every one
 * of them at once, a `git pull` in the source silently rewrites artifacts the
 * workspace never asked to change, and Windows needs Developer Mode. A copy has
 * none of those failure modes, and `upgrade` already refreshes it deterministically.
 *
 * Inside agent-fleet itself the trade is different — the whole point of that
 * workspace is that editing an artifact edits the source — so the mode survives
 * for exactly that case.
 */
export function isAgentFleetCheckout(workspace) {
  if (!workspace) return false;
  try {
    const pkg = JSON.parse(readFileSync(join(workspace, "package.json"), "utf8"));
    return pkg?.name === PACKAGE_NAME;
  } catch { return false; }
}

function toPosix(p) {
  return p.split(sep).join("/");
}
