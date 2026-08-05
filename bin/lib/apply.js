// apply.js — execute a plan.
//
// The only module in the installer that writes to a target workspace. Every
// verb reaches the filesystem through here, so the safety rules live in one
// place instead of being restated in prose per verb:
//
//   • nothing is written outside the workspace — asserted per path, not assumed;
//   • nothing is deleted that the state file does not record as ours, and
//     nothing the user has since edited is deleted at all;
//   • a conflict writes `<file>.new` beside the file and leaves the original
//     alone — the engine never picks a side;
//   • `exec` items run only when the plan admitted them (--allow-exec), and
//     `external` / `operator` items are never performed.
//
// The state file is written even when the pass fails partway: a workspace with
// files but no record of them is worse than one that admits what it has.
//
// See plans/deterministic-installer.md phase 4.

import {
  existsSync, mkdirSync, copyFileSync, writeFileSync, readFileSync,
  symlinkSync, rmSync, rmdirSync, lstatSync, unlinkSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";

import { itemsForAgent } from "./manifest.js";
import { expandBinding } from "./verify.js";
import { extractRegion, replaceRegion, stripRegion, leafPaths, setPath, canonicalJson } from "./merge-forms.js";
import {
  readState, writeState, emptyState, hashFile, hashText, walkTree,
  inspectPath, isInside, linkPointsInside, STATE_REL_PATH, LEGACY_RECORD_REL_PATH,
} from "./state.js";

export const APPLY_SCHEMA_VERSION = 1;

/**
 * Execute a plan against its workspace.
 *
 * @param {object}   opts
 * @param {object}   opts.plan       a plan from buildPlan()
 * @param {object}   opts.manifest   the manifest the plan was built from
 * @param {boolean}  [opts.allowExec]
 * @param {() => string} [opts.now]  injectable clock, for deterministic tests
 * @returns {object} result
 */
export function applyPlan({ plan, manifest, allowExec = false, now = () => new Date().toISOString() }) {
  const { workspace, sourceRoot, agent, method, packageVersion } = plan;
  const catalogue = new Map(itemsForAgent(manifest, agent).map((i) => [i.id, i]));
  const previous = readState(workspace);

  const state = previous ?? emptyState({
    agent, method, packageVersion, sourceRoot, profiles: plan.selection.profiles,
  });
  // The pass re-stamps identity: an install can change agent, method, or the
  // package doing the writing, and a stale header would misdirect every later
  // comparison.
  state.agent = agent;
  state.method = method;
  state.sourceRoot = sourceRoot;
  state.profiles = [...new Set([...(state.profiles ?? []), ...plan.selection.profiles])].sort();

  const results = [];
  const conflictFiles = [];
  let failed = null;

  for (const action of plan.actions) {
    if (failed) {
      results.push({ id: action.id, action: action.kind, status: "not-reached" });
      continue;
    }
    try {
      const outcome = perform({
        action, item: catalogue.get(action.id), state, workspace, sourceRoot,
        method, agent, allowExec, now,
      });
      results.push({ id: action.id, action: action.kind, ...outcome });
      if (outcome.conflicts) conflictFiles.push(...outcome.conflicts);
    } catch (err) {
      failed = { id: action.id, action: action.kind, status: "failed", detail: err.message };
      results.push(failed);
    }
  }

  // Record the pass even on failure — see the header note.
  state.packageVersion = failed ? (previous?.packageVersion ?? packageVersion) : packageVersion;
  state.updatedAt = now();
  state.installedAt ??= state.updatedAt;
  state.events = [...(state.events ?? []), {
    at: state.updatedAt,
    verb: plan.verb,
    packageVersion,
    actions: results.filter((r) => r.status === "applied").length,
    conflicts: conflictFiles.length,
    failed: failed ? 1 : 0,
  }];

  const statePath = writeState(workspace, state);
  const recordPath = writeLegacyRecord({ workspace, state, plan });

  const count = (status) => results.filter((r) => r.status === status).length;
  return {
    schemaVersion: APPLY_SCHEMA_VERSION,
    verb: plan.verb,
    workspace,
    agent,
    method,
    packageVersion,
    results,
    conflictFiles,
    statePath,
    recordPath,
    failure: failed,
    summary: {
      applied: count("applied"),
      adopted: count("adopted"),
      unchanged: count("unchanged"),
      removed: count("removed"),
      conflicts: conflictFiles.length,
      skipped: count("skipped"),
      failed: failed ? 1 : 0,
      notReached: count("not-reached"),
    },
  };
}

// ── one action ──────────────────────────────────────────────────────────────

function perform({ action, item, state, workspace, sourceRoot, method, agent, allowExec, now }) {
  switch (action.kind) {
    case "create":
    case "refresh":
    case "repair": {
      requireItem(item, action.id);
      const files = materialize({ item, workspace, sourceRoot, method, agent });
      const retired = retireLegacyTargets({ item, workspace, sourceRoot, agent });
      state.items[action.id] = {
        kind: item.kind,
        strategy: item.binding.strategy,
        method: methodFor(item, method),
        version: state.packageVersion,
        sourceRoot: item.binding.source?.[0] ?? null,
        ...files,
      };
      return {
        status: "applied",
        detail: describeFiles(files) + (retired.length ? `; retired ${retired.join(", ")}` : ""),
      };
    }

    case "keep": {
      // A selected item that already matches the source but is not recorded is
      // adopted: we were asked to install it, and it is byte-identical to what
      // we would have written. Anything else is left exactly as it is.
      if (item && !state.items[action.id] && ["up-to-date", "linked"].includes(action.state)) {
        state.items[action.id] = {
          kind: item.kind,
          strategy: item.binding.strategy,
          method: methodFor(item, method),
          version: state.packageVersion,
          sourceRoot: item.binding.source?.[0] ?? null,
          ...inventory({ item, workspace, sourceRoot }),
        };
        return { status: "adopted", detail: "already matched the source; now recorded" };
      }
      return { status: "unchanged" };
    }

    case "conflict": {
      requireItem(item, action.id);
      const written = writeConflictCopies({ item, action, workspace, sourceRoot, agent });
      return {
        status: "skipped",
        detail: `left untouched; ${written.length} .new file(s) written for review`,
        conflicts: written,
      };
    }

    case "remove":
      return removeItem({ id: action.id, state, workspace, sourceRoot });

    case "exec": {
      if (!allowExec) return { status: "skipped", detail: "exec not permitted" };
      const spec = item?.exec;
      if (!spec) return { status: "skipped", detail: "no exec specification" };
      const cwd = insideWorkspace(workspace, spec.cwd ?? ".");
      const run = spawnSync(spec.command, spec.args ?? [], { cwd, stdio: "pipe", encoding: "utf8" });
      if (run.status !== 0) {
        throw new Error(
          `${spec.command} ${(spec.args ?? []).join(" ")} exited ${run.status ?? "on signal"}: ` +
          `${(run.stderr ?? "").trim().split("\n").slice(-3).join(" ") || "no output"}`,
        );
      }
      state.items[action.id] = {
        kind: item.kind, strategy: "exec", method: "exec",
        version: state.packageVersion, files: [],
        lastRun: { at: now(), command: `${spec.command} ${(spec.args ?? []).join(" ")}`.trim() },
      };
      return { status: "applied", detail: "command ran" };
    }

    case "external": {
      const spec = item?.package;
      recordExternal(state, spec, now);
      return { status: "skipped", detail: `install it yourself: ${spec?.spec ?? "unknown package"}` };
    }

    case "operator":
      return { status: "skipped", detail: "operator step — printed, never performed" };

    case "skip":
      return { status: "skipped", detail: action.reason };

    default:
      return { status: "skipped", detail: `unhandled action: ${action.kind}` };
  }
}

// ── materialisation ─────────────────────────────────────────────────────────

/**
 * Write an item's files and return the state records for them. Dispatches on
 * strategy; `method: "symlink"` turns the two copy strategies into links, but
 * never the generated or merged ones — a persona is transform output and a
 * managed region shares its file with the user, so neither can be a link into
 * the source.
 */
function materialize({ item, workspace, sourceRoot, method, agent }) {
  const binding = item.binding;

  if (binding.strategy === "managed-region") return writeManagedRegion({ binding, workspace, sourceRoot });
  if (binding.strategy === "json-merge")     return mergeJson({ binding, workspace, sourceRoot });

  const pairs = expandBinding(binding, sourceRoot);
  if (pairs.length === 0) throw new Error(`no source available for ${item.id}`);

  const link = method === "symlink";
  const files = [];

  for (const pair of pairs) {
    const targetAbs = insideWorkspace(workspace, pair.targetRel);
    clearTarget(targetAbs);

    if (link) {
      mkdirSync(dirname(targetAbs), { recursive: true });
      symlinkSync(pair.sourceAbs, targetAbs);
      files.push({ path: pair.targetRel, mode: "symlink", linkTarget: pair.sourceAbs });
      continue;
    }

    if (pair.isDir) {
      for (const rel of walkTree(pair.sourceAbs)) {
        const dest = insideWorkspace(workspace, `${pair.targetRel}/${rel}`);
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(join(pair.sourceAbs, rel), dest);
        files.push({ path: `${pair.targetRel}/${rel}`, mode: "copy", sha256: hashFile(dest) });
      }
      continue;
    }

    mkdirSync(dirname(targetAbs), { recursive: true });
    copyFileSync(pair.sourceAbs, targetAbs);
    files.push({ path: pair.targetRel, mode: "copy", sha256: hashFile(targetAbs) });
  }

  return { files };
}

/**
 * Retire a path this item used to install to.
 *
 * The only case today is the `af-` namespace: a workspace set up before it has
 * `.pi/prompts/spec.md` alongside the new `af-spec.md`, and pi keeps offering
 * the stale `/spec` from it. Deleting it is subject to the same ownership rule
 * as everything else — it goes only when it is a link into the source, or its
 * bytes still match what we would have written. A same-named prompt the user
 * wrote themselves stays, and is reported.
 */
function retireLegacyTargets({ item, workspace, sourceRoot, agent }) {
  const legacy = item.binding.legacyTargets ?? [];
  if (legacy.length === 0) return [];

  const sourceRel = (item.binding.source ?? [])[0];
  const sourceAbs = sourceRel ? join(sourceRoot, sourceRel) : null;
  const ours = sourceAbs && existsSync(sourceAbs) ? hashFile(sourceAbs) : null;

  const retired = [];
  for (const rel of legacy) {
    const abs = insideWorkspace(workspace, rel);
    const found = inspectPath(abs);
    if (found.kind === "absent") continue;
    if (found.kind === "symlink") {
      if (!found.dangling && !linkPointsInside(sourceRoot, found.linkTarget)) continue;
      unlinkSync(abs);
      retired.push(rel);
      continue;
    }
    if (!ours || hashFile(abs) !== ours) continue; // user-authored or edited — keep
    rmSync(abs, { force: true });
    retired.push(rel);
  }
  return retired;
}

/** The same record, computed without writing — used when adopting a match. */
function inventory({ item, workspace, sourceRoot }) {
  const binding = item.binding;

  // Shared-file forms record our part, not the whole file. Hashing the file
  // here would record the user's lines as ours and report drift the moment
  // they edit them.
  if (binding.strategy === "managed-region") {
    const region = extractRegion(readFileSync(join(sourceRoot, binding.source[0]), "utf8"));
    return {
      files: [{
        path: binding.target, mode: "managed-region",
        region: region?.name ?? null, sha256: region ? hashText(region.block) : null,
      }],
    };
  }
  if (binding.strategy === "json-merge") {
    const fragment = JSON.parse(readFileSync(join(sourceRoot, binding.source[0]), "utf8"));
    return {
      files: [],
      jsonKeys: leafPaths(fragment).map(([path, value]) => ({
        path: binding.target, keyPath: path.join("."), sha256: hashText(canonicalJson(value)),
      })),
    };
  }

  const files = [];
  for (const pair of expandBinding(item.binding, sourceRoot)) {
    const targetAbs = join(workspace, pair.targetRel);
    const found = inspectPath(targetAbs);
    if (found.kind === "symlink") {
      files.push({ path: pair.targetRel, mode: "symlink", linkTarget: found.linkTarget });
      continue;
    }
    if (pair.isDir) {
      for (const rel of walkTree(pair.sourceAbs)) {
        const p = `${pair.targetRel}/${rel}`;
        files.push({ path: p, mode: "copy", sha256: hashFile(join(workspace, p)) });
      }
      continue;
    }
    files.push({ path: pair.targetRel, mode: "copy", sha256: hashFile(targetAbs) });
  }
  return { files };
}

/**
 * Replace the agent-fleet region of a shared file, preserving everything
 * outside the sentinels. This is what lets a workspace keep its own justfile
 * recipes across an upgrade that prunes retired harness recipes.
 */
function writeManagedRegion({ binding, workspace, sourceRoot }) {
  const sourceAbs = join(sourceRoot, binding.source[0]);
  if (!existsSync(sourceAbs)) throw new Error(`managed-region source missing: ${binding.source[0]}`);

  const region = extractRegion(readFileSync(sourceAbs, "utf8"));
  if (!region) throw new Error(`no complete agent-fleet region in ${binding.source[0]}`);

  const targetAbs = insideWorkspace(workspace, binding.target);
  const existing = existsSync(targetAbs) ? readFileSync(targetAbs, "utf8") : "";
  writeFileSyncDeep(targetAbs, replaceRegion(existing, region.block));

  return {
    files: [{
      path: binding.target, mode: "managed-region",
      region: region.name, sha256: hashText(region.block),
    }],
  };
}

/**
 * Set only the leaf paths the source declares, leaving every other key in the
 * target file alone — user permissions, env vars, third-party MCP servers and
 * custom hooks all survive.
 */
function mergeJson({ binding, workspace, sourceRoot }) {
  const sourceAbs = join(sourceRoot, binding.source[0]);
  if (!existsSync(sourceAbs)) throw new Error(`json-merge source missing: ${binding.source[0]}`);

  const fragment = JSON.parse(readFileSync(sourceAbs, "utf8"));
  const targetAbs = insideWorkspace(workspace, binding.target);
  let target = {};
  if (existsSync(targetAbs)) {
    try { target = JSON.parse(readFileSync(targetAbs, "utf8")); }
    catch (err) { throw new Error(`${binding.target} is not valid JSON: ${err.message}`); }
  }

  const jsonKeys = [];
  for (const [keyPath, value] of leafPaths(fragment)) {
    setPath(target, keyPath, value);
    jsonKeys.push({
      path: binding.target,
      keyPath: keyPath.join("."),
      sha256: hashText(canonicalJson(value)),
    });
  }
  writeFileSyncDeep(targetAbs, JSON.stringify(target, null, 2) + "\n");

  return { files: [], jsonKeys };
}

/**
 * A conflicting file gets its incoming version written beside it as `.new`.
 * The original is untouched; resolution is the human's, and `--accept-theirs`
 * / `--accept-ours` exist for when it is not worth their time.
 */
function writeConflictCopies({ item, action, workspace, sourceRoot, agent }) {
  const written = [];
  const conflicted = new Set((action.files ?? []).filter((f) => f.state === "conflict").map((f) => f.path));

  for (const pair of expandBinding(item.binding, sourceRoot)) {
    const emit = (targetRel, contents) => {
      if (!conflicted.has(targetRel)) return;
      const dest = insideWorkspace(workspace, `${targetRel}.new`);
      writeFileSyncDeep(dest, contents);
      written.push(`${targetRel}.new`);
    };

    if (pair.isDir) {
      for (const rel of walkTree(pair.sourceAbs)) {
        emit(`${pair.targetRel}/${rel}`, readFileSync(join(pair.sourceAbs, rel)));
      }
      continue;
    }
    emit(pair.targetRel, readFileSync(pair.sourceAbs));
  }
  return written;
}

// ── removal ─────────────────────────────────────────────────────────────────

/**
 * Delete only what the state file records, and only where the workspace copy
 * is still what we wrote. A path the user has since edited is kept and
 * reported — an upgrade that silently eats an edited file is the failure mode
 * this whole design exists to prevent.
 */
function removeItem({ id, state, workspace, sourceRoot }) {
  const recorded = state.items[id];
  if (!recorded) return { status: "skipped", detail: "not recorded as ours — nothing removed" };

  const kept = [];
  let removed = 0;

  for (const file of recorded.files ?? []) {
    const abs = insideWorkspace(workspace, file.path);
    const found = inspectPath(abs);
    if (found.kind === "absent") continue;

    if (found.kind === "symlink") {
      if (!linkPointsInside(sourceRoot, found.linkTarget) && !found.dangling) { kept.push(file.path); continue; }
      unlinkSync(abs); // not rmSync — see clearTarget() on dangling links
      removed++;
      continue;
    }
    // A managed region shares its file with the user: take our block out and
    // leave their lines, rather than deleting a file that is half theirs. If
    // the block was edited, it is theirs now — keep the whole thing.
    if (file.mode === "managed-region") {
      const text = readFileSync(abs, "utf8");
      const region = extractRegion(text);
      if (!region || (file.sha256 && hashText(region.block) !== file.sha256)) {
        kept.push(file.path);
        continue;
      }
      const rest = stripRegion(text);
      if (rest === null) rmSync(abs, { force: true });
      else writeFileSync(abs, rest);
      removed++;
      continue;
    }
    if (!file.sha256) { kept.push(file.path); continue; }
    if (hashFile(abs) !== file.sha256) { kept.push(file.path); continue; }
    rmSync(abs, { recursive: true, force: true });
    removed++;
  }

  pruneEmptyDirs(workspace, (recorded.files ?? []).map((f) => f.path));
  delete state.items[id];

  return {
    status: "removed",
    detail: kept.length > 0
      ? `${removed} removed; kept ${kept.length} user-modified path(s): ${kept.slice(0, 3).join(", ")}`
      : `${removed} path(s) removed`,
  };
}

// ── the human-readable record ───────────────────────────────────────────────

/**
 * `.ai/agent-fleet-setup.md` is rendered from the state file and never parsed
 * back, so the two cannot disagree. It keeps the pre-engine section names so
 * an older reader still finds `version:` and `agent:`.
 */
function writeLegacyRecord({ workspace, state, plan }) {
  const byKind = {};
  for (const [id, entry] of Object.entries(state.items)) {
    (byKind[entry.kind] ??= []).push(id.split(":").slice(1).join(":"));
  }
  const line = (label, kind) =>
    `${(label + ":").padEnd(12)}[${(byKind[kind] ?? []).sort().join(", ")}]`;

  const text = `# Agent Fleet — Workspace Setup
#
# Generated from ${STATE_REL_PATH} by \`agent-fleet ${plan.verb}\`.
# Edit the workspace, not this file: it is rewritten on every apply.

## workspace-summary
agent:   ${state.agent}
method:  ${state.method}
version: ${state.packageVersion}
source:  ${state.sourceRoot}

## install-status
${line("skills", "skill")}
${line("commands", "command")}
${line("personas", "persona")}
${line("references", "reference")}
${line("hooks", "hook")}
${line("extensions", "pi-extension")}
${line("harnesses", "pi-harness")}
${line("runtime-skills", "pi-runtime-skill")}
${line("companions", "companion")}
external:   [${(state.externalPackages ?? []).map((p) => p.spec).sort().join(", ")}]
updated:    ${state.updatedAt.slice(0, 10)}

## verification
- ${Object.keys(state.items).length} item(s) recorded; run \`agent-fleet verify\` to check them against disk.
- No secrets are stored in this file or in ${STATE_REL_PATH}.
`;
  const path = join(workspace, LEGACY_RECORD_REL_PATH);
  writeFileSyncDeep(path, text);
  return path;
}

// ── helpers ─────────────────────────────────────────────────────────────────

/**
 * Resolve a workspace-relative path and refuse anything that escapes. A
 * manifest is data; a `../` in a target must not be able to write outside the
 * directory the user named.
 */
function insideWorkspace(workspace, rel) {
  const abs = resolve(workspace, rel);
  if (!isInside(workspace, abs)) {
    throw new Error(`refusing to write outside the workspace: ${rel}`);
  }
  return abs;
}

function writeFileSyncDeep(abs, contents) {
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, contents);
}

/**
 * Remove whatever occupies a target so the new form lands cleanly.
 *
 * A symlink is unlinked, never rmSync'd: `rmSync(path, { force: true })` stats
 * through the link, sees ENOENT for a *dangling* one, and returns as if the
 * path were already gone — leaving the broken link in place for the next
 * symlinkSync to fail on with EEXIST. Repairing a broken link is exactly the
 * case that hits this.
 */
function clearTarget(abs) {
  let st;
  try { st = lstatSync(abs); } catch { return; }
  if (st.isSymbolicLink()) { unlinkSync(abs); return; }
  rmSync(abs, { recursive: true, force: true });
}

/**
 * Drop directories emptied by a removal, never one that still holds anything.
 *
 * `rmdirSync` and not `rmSync`: the non-recursive rmSync throws EISDIR on any
 * directory at all, so the whole walk used to abort on its first step and leave
 * empty skill directories behind. rmdirSync is the call that means "remove this
 * only if it is empty", which is exactly the rule wanted here — ENOTEMPTY stops
 * the walk and the user's files stay.
 */
function pruneEmptyDirs(workspace, relPaths) {
  const dirs = [...new Set(relPaths.map((p) => dirname(p)))].sort((a, b) => b.length - a.length);
  for (const rel of dirs) {
    let dir = resolve(workspace, rel);
    while (isInside(workspace, dir) && dir !== resolve(workspace)) {
      try { rmdirSync(dir); } catch { break; }
      dir = dirname(dir);
    }
  }
}

function methodFor(item, method) {
  const strategy = item.binding.strategy;
  if (strategy === "managed-region" || strategy === "json-merge") return strategy;
  return method;
}

function recordExternal(state, spec, now) {
  if (!spec?.spec) return;
  state.externalPackages ??= [];
  if (state.externalPackages.some((p) => p.spec === spec.spec)) return;
  state.externalPackages.push({ spec: spec.spec, scope: spec.scope ?? "project", recordedAt: now() });
}

function describeFiles({ files = [], jsonKeys = [] }) {
  const parts = [];
  if (files.length) parts.push(`${files.length} file(s)`);
  if (jsonKeys.length) parts.push(`${jsonKeys.length} json key(s)`);
  return parts.join(", ") || "nothing to write";
}

function requireItem(item, id) {
  if (!item) throw new Error(`${id} is not in the catalogue for this agent`);
}
