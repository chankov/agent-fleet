// verify.js — read-only workspace inspection.
//
// Answers, without writing anything: what does this workspace have installed,
// how does it differ from the source, and what is broken? It is the shared
// computation behind `agent-fleet verify` and, from Phase 3 on, behind the
// planner — `plan()` is this pass plus a decision per item, and `apply()` is
// that plan executed. Keeping the state computation in one place is what stops
// setup and doctor from drifting apart.
//
// See plans/deterministic-installer-manifest-spec.md §4.1 for the state table.

import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import { itemsForAgent } from "./manifest.js";
import { extractRegion, leafPaths, getPath, canonicalJson } from "./merge-forms.js";
import { runDoctor } from "./doctor.js";
import {
  readState,
  readLegacyRecord,
  hashFile,
  hashText,
  walkTree,
  inspectPath,
  isInside,
  linkPointsInside,
  isVolatileSourceRoot,
  isAgentFleetCheckout,
  STATE_SCHEMA_VERSION,
  STATE_REL_PATH,
} from "./state.js";

export const VERIFY_SCHEMA_VERSION = 1;

// States that mean the workspace is broken, not merely behind. `outdated` and
// `modified` are reported but do not fail: an available upgrade and a
// deliberate local edit are both legitimate resting states.
export const BROKEN_STATES = new Set(["missing", "broken-link", "foreign-link", "conflict", "gone"]);

// Findings that describe a condition rather than a defect. They are printed,
// but they never fail the run — a workspace installed before `.versions/`
// retention, or one carrying a hand-edited overrides file, is not broken.
export const ADVISORY_FINDINGS = new Set([
  "base-snapshot-missing",
  "source-root-volatile",
  "symlink-retired",
  "retired-artifact",
  "legacy-target",
  "overrides",
  "yaml-shape",
  "pi-package-ownership",
]);

// Worst-wins ordering when a tree item's files disagree.
const SEVERITY = {
  "not-applicable": 0,
  "unchecked": 1,
  "absent": 2,
  "linked": 3,
  "up-to-date": 4,
  "outdated": 5,
  "modified": 6,
  "partial": 7,
  "gone": 8,
  "foreign-link": 9,
  "broken-link": 10,
  "missing": 11,
  "conflict": 12,
};

/**
 * Inspect a workspace against the manifest.
 *
 * @param {object} opts
 * @param {string}  opts.workspace       target workspace (absolute)
 * @param {string}  opts.sourceRoot      agent-fleet package root (absolute)
 * @param {string}  opts.packageVersion  the running package's version
 * @param {object}  opts.manifest        loaded install manifest
 * @param {string}  [opts.agent]         override the recorded/detected agent
 * @param {string}  [opts.platform]      process.platform, for platform-gated items
 * @param {boolean} [opts.includeDoctor] run the legacy doctor scan too (default true)
 * @returns {Promise<object>} report
 */
export async function runVerify({
  workspace,
  sourceRoot,
  packageVersion,
  manifest,
  agent = null,
  platform = process.platform,
  includeDoctor = true,
}) {
  const state = readState(workspace);
  const legacy = readLegacyRecord(workspace);
  const resolvedAgent = agent ?? state?.agent ?? legacy?.agent ?? null;
  const recordedVersion = state?.packageVersion ?? legacy?.version ?? null;
  const stateSource = state ? "state-file" : legacy ? "legacy-record" : "none";

  const findings = [];
  const baseRoot = resolveBaseRoot(sourceRoot, recordedVersion);
  const baseAvailable = Boolean(baseRoot);

  if (state && state.schemaVersion !== STATE_SCHEMA_VERSION) {
    findings.push({
      type: "state-schema",
      path: STATE_REL_PATH,
      issue: `state schemaVersion ${state.schemaVersion}, this build speaks ${STATE_SCHEMA_VERSION}`,
      fix: "upgrade agent-fleet, or re-run install to rewrite the state file",
    });
  }
  if (state?.sourceRoot && !existsSync(state.sourceRoot)) {
    findings.push({
      type: "source-root-missing",
      path: STATE_REL_PATH,
      issue: `recorded source root no longer exists — ${state.sourceRoot}`,
      fix: "re-run install from the current package to re-point the workspace",
    });
  }
  if (state?.method === "symlink" && !isAgentFleetCheckout(workspace)) {
    findings.push({
      type: "symlink-retired",
      path: STATE_REL_PATH,
      issue: "installed with symlinks, which are now supported only inside an agent-fleet checkout",
      fix: "run `agent-fleet install` or `upgrade` — linked items are re-materialised as copies",
    });
  } else if (state?.method === "symlink" && isVolatileSourceRoot(state.sourceRoot)) {
    findings.push({
      type: "source-root-volatile",
      path: STATE_REL_PATH,
      issue: "symlink install points into an npx cache — a cache clean breaks every link",
      fix: "re-install with --method copy, or from a stable clone / global install",
    });
  }
  if (recordedVersion && !baseAvailable) {
    findings.push({
      type: "base-snapshot-missing",
      path: `.versions/${recordedVersion}`,
      issue: "no snapshot for the recorded version — three-way merges degrade to two-way",
      fix: "informational; the installed copy is treated as canonical on upgrade",
    });
  }

  let items = [];
  if (!resolvedAgent) {
    findings.push({
      type: "agent-unknown",
      path: STATE_REL_PATH,
      issue: "no recorded or detected coding agent — cannot resolve install targets",
      fix: "re-run with --agent pi",
    });
  } else {
    items = evaluateWorkspace({
      workspace, sourceRoot, manifest, agent: resolvedAgent, platform, state, baseRoot,
    });
  }

  for (const entry of items) {
    for (const rel of entry.legacyTargets ?? []) {
      findings.push({
        type: "legacy-target",
        path: rel,
        issue: `${entry.id} used to install here; the runtime still loads it`,
        fix: `re-run install to retire it (kept if you edited it), or delete ${rel} by hand`,
      });
    }
    if (entry.owned && entry.retired) {
      findings.push({
        type: "retired-artifact",
        path: entry.target ?? entry.id,
        issue: `${entry.id} was retired upstream`,
        fix: "remove it with `agent-fleet uninstall`, or keep it deliberately",
      });
    }
  }

  if (includeDoctor) {
    findings.push(...(await runDoctor({ workspace, sourceRoot })));
  }
  for (const f of findings) f.severity = ADVISORY_FINDINGS.has(f.type) ? "advisory" : "problem";

  const byState = {};
  for (const entry of items) byState[entry.state] = (byState[entry.state] ?? 0) + 1;

  const broken = items.filter((i) => BROKEN_STATES.has(i.state));
  const upgradable = items.filter((i) => i.state === "outdated");

  return {
    schemaVersion: VERIFY_SCHEMA_VERSION,
    verb: "verify",
    workspace,
    sourceRoot,
    agent: resolvedAgent,
    packageVersion,
    recordedVersion,
    stateSource,
    baseAvailable,
    // The menu metadata travels with the report so a front-end needs exactly
    // one command to build a selection screen: groups give it the headings and
    // ordering, profiles the shortcuts, items the rows and their states.
    groups: (manifest.groups ?? []).filter((g) => !resolvedAgent || (g.agents ?? []).includes(resolvedAgent)),
    profiles: manifest.profiles ?? {},
    items,
    findings,
    summary: {
      total: items.length,
      installed: items.filter((i) => i.owned).length,
      present: items.filter(
        (i) => !["absent", "not-applicable", "unchecked"].includes(i.state),
      ).length,
      broken: broken.length,
      upgradable: upgradable.length,
      findings: findings.length,
      problems: findings.filter((f) => f.severity === "problem").length,
      advisories: findings.filter((f) => f.severity === "advisory").length,
      versionDrift: Boolean(recordedVersion && recordedVersion !== packageVersion),
      byState,
    },
  };
}

/** True when the report should exit non-zero (code 2). Advisories do not count. */
export function hasDrift(report) {
  return report.summary.problems > 0 || report.summary.broken > 0;
}

// ── per-item evaluation ─────────────────────────────────────────────────────

/**
 * The three-way merge base for a workspace: the snapshot of the source tree at
 * the version the workspace recorded. Null when there is no recorded version or
 * the snapshot is gone (pre-`.versions/` install, or past retention) — callers
 * degrade to a two-way comparison and say so.
 *
 * @returns {string|null} absolute path to `.versions/<recorded>`, or null
 */
export function resolveBaseRoot(sourceRoot, recordedVersion) {
  if (!recordedVersion) return null;
  const path = join(sourceRoot, ".versions", recordedVersion);
  return existsSync(path) ? path : null;
}

/**
 * Evaluate every manifest item for one agent against the workspace. Shared by
 * `verify` (which reports the result) and `plan` (which decides on it), so the
 * two can never disagree about what state a file is in.
 *
 * Writes nothing.
 *
 * @param {object}  opts
 * @param {number}  [opts.fileLimit] per-item cap on the reported `files` array.
 *   `verify` caps it for display; the planner passes Infinity because it needs
 *   every conflicting path to write the `.new` files in Phase 4.
 * @returns {object[]} item evaluations, sorted by id
 */
export function evaluateWorkspace({
  workspace,
  sourceRoot,
  manifest,
  agent,
  platform = process.platform,
  state = null,
  baseRoot = null,
  fileLimit = 20,
}) {
  const items = [];
  for (const item of itemsForAgent(manifest, agent)) {
    if (item.platform !== "any" && item.platform !== platform) continue;
    items.push(evaluateItem({
      item,
      binding: item.binding,
      workspace,
      sourceRoot,
      baseRoot,
      recorded: state?.items?.[item.id] ?? null,
      fileLimit,
    }));
  }
  return items.sort((a, b) => (a.id < b.id ? -1 : 1));
}

function evaluateItem({ item, binding, workspace, sourceRoot, baseRoot, recorded, fileLimit = 20 }) {
  const base = {
    id: item.id,
    kind: item.kind,
    group: item.group,
    subcategory: item.subcategory ?? null,
    title: item.title,
    summary: item.summary ?? "",
    recommended: item.recommended,
    consent: item.consent,
    target: binding.target,
    owned: Boolean(recorded),
    // How this item was last installed. The planner compares it against the
    // requested method: content can be up to date while the *form* is wrong,
    // and a copy is not a symlink however identical the bytes are.
    recordedMethod: recorded?.method ?? null,
    retired: Boolean(item.retired),
    // The two consent classes the engine refuses to perform carry what the
    // human needs instead — the exact commands, or the package spec. Without
    // them a report of "operator step" is a dead end.
    ...(item.operatorSteps ? { operatorSteps: item.operatorSteps } : {}),
    ...(item.package?.spec ? { packageSpec: item.package.spec } : {}),
  };

  // Nothing on disk to compare: the engine never applies these itself.
  if (["exec", "operator", "external"].includes(binding.strategy)) {
    return { ...base, state: "not-applicable", detail: consentDetail(item) };
  }

  // Forms that share their file with the user: compare only our part of it.
  if (binding.strategy === "managed-region") {
    return { ...base, ...compareRegion({ binding, workspace, sourceRoot, baseRoot, recorded }) };
  }
  if (binding.strategy === "json-merge") {
    return { ...base, ...compareJsonKeys({ binding, workspace, sourceRoot, baseRoot, recorded }) };
  }

  const pairs = expandBinding(binding, sourceRoot);
  if (pairs.length === 0) {
    return { ...base, state: "gone", detail: "no source for this item in the current package" };
  }

  const recordedHashes = new Map((recorded?.files ?? []).map((f) => [f.path, f.sha256]));
  const agent = agentOf(item, binding);
  const results = [];
  const changed = [];

  for (const pair of pairs) {
    const targetAbs = join(workspace, pair.targetRel);
    const found = inspectPath(targetAbs);

    if (found.kind === "absent") {
      results.push({ state: "absent" });
      continue;
    }
    if (found.kind === "symlink") {
      if (found.dangling) {
        results.push({ state: "broken-link" });
        changed.push({ path: pair.targetRel, state: "broken-link", detail: "link target does not exist" });
        continue;
      }
      const recordedRoot = recorded?.sourceRoot ?? sourceRoot;
      if (linkPointsInside(sourceRoot, found.linkTarget) || linkPointsInside(recordedRoot, found.linkTarget)) {
        results.push({ state: "linked", linkTarget: found.linkTarget });
        continue;
      }
      results.push({ state: "foreign-link" });
      changed.push({
        path: pair.targetRel,
        state: "foreign-link",
        detail: `resolves outside the source root — ${found.linkTarget}`,
      });
      continue;
    }

    const files = pair.isDir
      ? walkTree(pair.sourceAbs).map((rel) => compareOne({
          rel: `${pair.targetRel}/${rel}`,
          ours: hashFile(join(targetAbs, rel)),
          theirs: hashFile(join(pair.sourceAbs, rel)),
          base: baseHashOf({ baseRoot, sourceRel: `${pair.sourceRel}/${rel}` }),
          recorded: recordedHashes.get(`${pair.targetRel}/${rel}`) ?? null,
        }))
      : [compareOne({
          rel: pair.targetRel,
          ours: hashFile(targetAbs),
          theirs: hashFile(pair.sourceAbs),
          base: baseHashOf({ baseRoot, sourceRel: pair.sourceRel }),
          recorded: recordedHashes.get(pair.targetRel) ?? null,
        })];

    results.push({ state: worstOf(files.map((f) => f.state)) ?? "up-to-date", fileCount: files.length });
    changed.push(...files.filter((f) => f.state !== "up-to-date"));
  }

  const absentPairs = results.filter((r) => r.state === "absent").length;
  let state;
  if (absentPairs === results.length) {
    state = recorded ? "missing" : "absent";
  } else {
    state = worstOf(results.filter((r) => r.state !== "absent").map((r) => r.state)) ?? "up-to-date";
    // Some pieces present, some not: broken if we installed it, merely
    // incomplete if we did not.
    if (absentPairs > 0) state = recorded ? "missing" : worstOf([state, "partial"]);
  }

  const out = {
    ...base,
    state,
    fileCount: results.reduce((n, r) => n + (r.fileCount ?? 0), 0),
    changedCount: changed.length,
  };
  // A path this item used to install to that is still occupied. The runtime
  // does not know it is stale — pi will keep offering `/spec` from a legacy
  // `.pi/prompts/spec.md` — so it is reported rather than merely cleaned up on
  // the next apply.
  const stale = (binding.legacyTargets ?? []).filter((rel) => existsSync(join(workspace, rel)));
  if (stale.length > 0) out.legacyTargets = stale;
  if (changed.length > 0) {
    out.files = Number.isFinite(fileLimit) ? changed.slice(0, fileLimit) : changed;
  }
  if (state === "linked") out.linkTarget = results.find((r) => r.linkTarget)?.linkTarget;
  if (!base.owned && state !== "absent") {
    out.detail = "present but not recorded — agent-fleet did not install it";
  }
  return out;
}

/**
 * Turn a binding into concrete (source → target) pairs.
 *
 * `sourceMode: "first"` treats `source` as an ordered candidate list and picks
 * the first that exists (native skills shadowing the vendored copy).
 * `sourceMode: "all"` installs every source, either under `target` by basename
 * or — with `preserveLayout` — at its own repo-relative path.
 */
export function expandBinding(binding, sourceRoot) {
  const out = [];
  const push = (sourceRel, targetRel) => {
    const sourceAbs = join(sourceRoot, sourceRel);
    if (!existsSync(sourceAbs)) return;
    out.push({ sourceRel, sourceAbs, targetRel, isDir: statSync(sourceAbs).isDirectory() });
  };

  if (binding.sourceMode === "all") {
    for (const rel of binding.source ?? []) {
      push(rel, binding.preserveLayout ? rel : `${binding.target}/${basename(rel)}`);
    }
    return out;
  }

  const first = (binding.source ?? []).find((rel) => existsSync(join(sourceRoot, rel)));
  if (first && binding.target) push(first, binding.target);
  return out;
}

/**
 * A managed region is compared as its sentinel-bounded block, never as the
 * whole file — the user's other recipes are not drift.
 */
function compareRegion({ binding, workspace, sourceRoot, baseRoot, recorded }) {
  const blockOf = (path) => {
    const found = extractRegion(readTextOrNull(path));
    return found ? hashText(found.block) : null;
  };
  const theirs = blockOf(join(sourceRoot, binding.source?.[0] ?? ""));
  if (theirs === null) return { state: "gone", detail: "no managed region in the current source" };

  const targetAbs = join(workspace, binding.target);
  if (!existsSync(targetAbs)) return { state: recorded ? "missing" : "absent" };

  const ours = blockOf(targetAbs);
  if (ours === null) {
    return recorded
      ? { state: "missing", detail: "the managed region is gone from the file" }
      : { state: "absent", detail: "file exists but carries no agent-fleet region" };
  }

  const result = compareOne({
    rel: binding.target,
    ours,
    theirs,
    base: baseRoot ? blockOf(join(baseRoot, binding.source[0])) : null,
    recorded: recorded?.files?.find((f) => f.path === binding.target)?.sha256 ?? null,
  });
  return result.state === "up-to-date"
    ? { state: "up-to-date", fileCount: 1 }
    : { state: result.state, fileCount: 1, changedCount: 1, files: [{ ...result, detail: "managed region" }] };
}

/**
 * A JSON merge is compared key path by key path, so unrelated settings — user
 * permissions, other hooks, third-party MCP servers — are never drift.
 */
function compareJsonKeys({ binding, workspace, sourceRoot, baseRoot, recorded }) {
  const fragment = readJsonOrNull(join(sourceRoot, binding.source?.[0] ?? ""));
  if (!fragment) return { state: "gone", detail: "no merge fragment in the current source" };

  const targetAbs = join(workspace, binding.target);
  if (!existsSync(targetAbs)) return { state: recorded ? "missing" : "absent" };

  const target = readJsonOrNull(targetAbs);
  if (!target) return { state: "modified", detail: `${binding.target} is not valid JSON` };

  const baseDoc = baseRoot ? readJsonOrNull(join(baseRoot, binding.source[0])) : null;
  const recordedKeys = new Map((recorded?.jsonKeys ?? []).map((k) => [k.keyPath, k.sha256]));
  const files = [];

  for (const [path, value] of leafPaths(fragment)) {
    const keyPath = path.join(".");
    const present = getPath(target, path);
    if (present === undefined) { files.push({ path: keyPath, state: "missing" }); continue; }
    files.push(compareOne({
      rel: keyPath,
      ours: hashText(canonicalJson(present)),
      theirs: hashText(canonicalJson(value)),
      base: baseDoc ? hashText(canonicalJson(getPath(baseDoc, path))) : null,
      recorded: recordedKeys.get(keyPath) ?? null,
    }));
  }

  const changed = files.filter((f) => f.state !== "up-to-date");
  const state = changed.length === 0
    ? "up-to-date"
    : (recorded ? worstOf(changed.map((f) => f.state)) : "absent");
  return changed.length === 0
    ? { state, fileCount: files.length }
    : { state, fileCount: files.length, changedCount: changed.length, files: changed };
}

function readTextOrNull(path) {
  try { return readFileSync(path, "utf8"); } catch { return null; }
}

function readJsonOrNull(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

function compareOne({ rel, ours, theirs, base, recorded }) {
  if (ours === null) return { path: rel, state: "missing" };
  if (theirs === null) return { path: rel, state: "gone" };
  if (ours === theirs) return { path: rel, state: "up-to-date" };

  // Untracked file: we can say it differs from the source, nothing more.
  if (!recorded) return { path: rel, state: "modified" };

  if (ours === recorded) return { path: rel, state: "outdated" };
  if (base === null) return { path: rel, state: "modified", detail: "no merge base" };
  if (base === theirs) return { path: rel, state: "modified" };
  return { path: rel, state: "conflict" };
}

function baseHashOf({ baseRoot, sourceRel }) {
  if (!baseRoot) return null;
  const path = join(baseRoot, sourceRel);
  if (!existsSync(path)) return null;
  return hashFile(path);
}

function agentOf(item, binding) {
  return Object.keys(item.agents ?? {}).find((a) => item.agents[a] === binding) ?? null;
}

function worstOf(states) {
  let worst = null;
  for (const s of states) {
    if (worst === null || (SEVERITY[s] ?? 0) > (SEVERITY[worst] ?? 0)) worst = s;
  }
  return worst;
}

function consentDetail(item) {
  switch (item.consent) {
    case "operator": return "operator-applied — the engine reports steps, never performs them";
    case "exec":     return "runs a command; requires --allow-exec";
    case "external":  return `external package: ${item.package?.spec ?? "unknown"}`;
    default:          return "no workspace target";
  }
}
