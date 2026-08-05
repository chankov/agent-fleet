// plan.test.js — the planner's decision table and the upgrade merge.
//
// Two kinds of coverage here:
//
//   • synthetic fixtures — a tiny hand-built manifest and source tree, so each
//     row of spec §4.1/§4.2 can be provoked exactly. Driving these off the real
//     102-item manifest would make every assertion depend on the catalogue.
//   • golden plans — the real manifest, fresh workspace, one file per agent.
//     These fail when the recommended set changes, which is the point: a new
//     recommended artifact should be a reviewed diff, not a silent addition.
//     Regenerate deliberately with UPDATE_PLAN_GOLDEN=1.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { buildPlan, hasConflicts, isNoop } from "../lib/plan.js";
import { loadManifest } from "../lib/manifest.js";
import { writeState, emptyState, hashFile, walkTree } from "../lib/state.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GOLDEN_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

// ── synthetic world ─────────────────────────────────────────────────────────

const AGENT = "pi";
const BASE_VERSION = "1.0.0";
const CURRENT_VERSION = "1.1.0";

function tmp(label) {
  const dir = mkdtempSync(join(tmpdir(), `af-plan-${label}-`));
  return dir;
}

function write(root, rel, text) {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
  return path;
}

/**
 * A source package with two skills and one exec/external/operator item each.
 * `.versions/1.0.0/` holds the merge base; the live tree is 1.1.0.
 *
 * @param {object} [content] per-file overrides for the current source
 */
function makeSource({ alphaNow = "alpha v1\n", alphaBase = "alpha v1\n", betaNow = "beta v1\n" } = {}) {
  const root = tmp("src");
  write(root, "skills/alpha/SKILL.md", alphaNow);
  write(root, "skills/beta/SKILL.md", betaNow);
  write(root, `.versions/${BASE_VERSION}/skills/alpha/SKILL.md`, alphaBase);
  write(root, `.versions/${BASE_VERSION}/skills/beta/SKILL.md`, "beta v1\n");
  return root;
}

function makeManifest(extraItems = []) {
  const skill = (name) => ({
    id: `skill:${name}`,
    kind: "skill",
    group: "skills",
    subcategory: null,
    title: name,
    summary: "",
    recommended: name === "alpha",
    consent: "file",
    platform: "any",
    agents: {
      [AGENT]: {
        source: [`skills/${name}`],
        sourceMode: "first",
        target: `.pi/skills/${name}`,
        strategy: "copy-tree",
      },
    },
    companions: [],
    requires: [],
  });

  return {
    schemaVersion: 1,
    packageVersion: CURRENT_VERSION,
    groups: [{ id: "skills", title: "Skills", order: 1, agents: [AGENT] }],
    profiles: {
      recommended: { title: "recommended", rule: "recommended" },
      full: { title: "all", rule: "all" },
      both: { title: "both skills", items: ["skill:alpha", "skill:beta"] },
    },
    items: [skill("alpha"), skill("beta"), ...extraItems],
  };
}

/** Install `ids` into a workspace at BASE_VERSION, recording real hashes. */
function installFixture({ workspace, sourceRoot, manifest, ids, method = "copy", fromBase = true }) {
  const state = emptyState({
    agent: AGENT, method, packageVersion: BASE_VERSION, sourceRoot, profiles: [],
  });
  const treeRoot = fromBase ? join(sourceRoot, ".versions", BASE_VERSION) : sourceRoot;

  for (const id of ids) {
    const item = manifest.items.find((i) => i.id === id);
    const binding = item.agents[AGENT];
    const files = [];
    for (const rel of binding.source) {
      const from = join(treeRoot, rel);
      if (!existsSync(from)) continue;
      for (const inner of walkTree(from)) {
        const targetRel = `${binding.target}/${inner}`;
        write(workspace, targetRel, readFileSync(join(from, inner), "utf8"));
        files.push({ path: targetRel, mode: "copy", sha256: hashFile(join(workspace, targetRel)) });
      }
    }
    state.items[id] = {
      kind: item.kind, strategy: binding.strategy, method,
      version: BASE_VERSION, files,
    };
  }
  writeState(workspace, state);
  return state;
}

function plan(opts) {
  return buildPlan({
    packageVersion: CURRENT_VERSION,
    agent: AGENT,
    ...opts,
  });
}

function actionFor(result, id) {
  return result.actions.find((a) => a.id === id);
}

// ── Phase 3: the planner ────────────────────────────────────────────────────

test("plan is deterministic and writes nothing", () => {
  const sourceRoot = makeSource();
  const workspace = tmp("ws");
  const manifest = makeManifest();

  const before = snapshot(workspace);
  const first = plan({ workspace, sourceRoot, manifest, profiles: ["full"] });
  const second = plan({ workspace, sourceRoot, manifest, profiles: ["full"] });

  assert.deepEqual(first, second, "two plans over an unchanged workspace must be identical");
  assert.deepEqual(snapshot(workspace), before, "planning must not touch the workspace");
});

test("fresh workspace: every selected item is a create", () => {
  const sourceRoot = makeSource();
  const workspace = tmp("ws");
  const result = plan({ workspace, sourceRoot, manifest: makeManifest(), profiles: ["both"] });

  assert.equal(result.summary.create, 2);
  assert.equal(result.summary.changes, 2);
  assert.equal(result.conflicts.length, 0);
  assert.equal(hasConflicts(result), false);
});

test("selection never removes: a narrower profile keeps what is installed", () => {
  const sourceRoot = makeSource();
  const workspace = tmp("ws");
  const manifest = makeManifest();
  installFixture({ workspace, sourceRoot, manifest, ids: ["skill:alpha", "skill:beta"], fromBase: false });

  const result = plan({ workspace, sourceRoot, manifest, items: ["skill:alpha"] });

  assert.equal(actionFor(result, "skill:beta").kind, "keep");
  assert.match(actionFor(result, "skill:beta").reason, /selection never removes/);
  assert.equal(result.summary.remove, 0);
});

test("installing an unchanged workspace is a no-op", () => {
  const sourceRoot = makeSource();
  const workspace = tmp("ws");
  const manifest = makeManifest();
  installFixture({ workspace, sourceRoot, manifest, ids: ["skill:alpha", "skill:beta"], fromBase: false });

  const result = plan({ workspace, sourceRoot, manifest, profiles: ["both"] });

  assert.equal(result.summary.changes, 0);
  assert.ok(isNoop(result));
});

test("install overwrites a locally modified item, and says so", () => {
  const sourceRoot = makeSource();
  const workspace = tmp("ws");
  const manifest = makeManifest();
  installFixture({ workspace, sourceRoot, manifest, ids: ["skill:alpha"], fromBase: false });
  write(workspace, ".pi/skills/alpha/SKILL.md", "my local edit\n");

  const result = plan({ workspace, sourceRoot, manifest, items: ["skill:alpha"] });
  const action = actionFor(result, "skill:alpha");

  assert.equal(action.kind, "refresh");
  assert.equal(action.overwrites, true, "the caller must be able to warn about this");
  assert.equal(result.summary.overwrites, 1);
});

test("a recorded item missing from disk is repaired even when not selected", () => {
  const sourceRoot = makeSource();
  const workspace = tmp("ws");
  const manifest = makeManifest();
  installFixture({ workspace, sourceRoot, manifest, ids: ["skill:alpha", "skill:beta"], fromBase: false });
  rmSync(join(workspace, ".pi/skills/beta"), { recursive: true });

  const result = plan({ workspace, sourceRoot, manifest, items: ["skill:alpha"] });

  assert.equal(actionFor(result, "skill:beta").kind, "repair");
});

test("a dangling symlink is repaired", () => {
  const sourceRoot = makeSource();
  const workspace = tmp("ws");
  const manifest = makeManifest();
  mkdirSync(join(workspace, ".pi/skills"), { recursive: true });
  symlinkSync(join(sourceRoot, "skills/gone"), join(workspace, ".pi/skills/alpha"));

  const state = emptyState({ agent: AGENT, method: "symlink", packageVersion: BASE_VERSION, sourceRoot });
  state.items["skill:alpha"] = { kind: "skill", strategy: "copy-tree", method: "symlink", files: [] };
  writeState(workspace, state);

  const result = plan({ workspace, sourceRoot, manifest, items: ["skill:alpha"] });
  assert.equal(actionFor(result, "skill:alpha").kind, "repair");
  assert.match(actionFor(result, "skill:alpha").reason, /symlink target/);
});

test("a symlink into the source root is kept, not refreshed", () => {
  const sourceRoot = makeSource();
  const workspace = tmp("ws");
  const manifest = makeManifest();
  // Symlink mode is supported only inside an agent-fleet checkout; elsewhere the
  // planner migrates linked items to copies (see the symlink-retirement tests).
  write(workspace, "package.json", JSON.stringify({ name: "@chankov/agent-fleet" }));
  mkdirSync(join(workspace, ".pi/skills"), { recursive: true });
  symlinkSync(join(sourceRoot, "skills/alpha"), join(workspace, ".pi/skills/alpha"));

  const state = emptyState({ agent: AGENT, method: "symlink", packageVersion: BASE_VERSION, sourceRoot });
  state.items["skill:alpha"] = { kind: "skill", strategy: "copy-tree", method: "symlink", files: [] };
  writeState(workspace, state);

  const result = plan({ workspace, sourceRoot, manifest, items: ["skill:alpha"] });
  assert.equal(actionFor(result, "skill:alpha").kind, "keep");
  assert.equal(result.summary.changes, 0);
});

test("exec items are skipped without --allow-exec and planned with it", () => {
  const sourceRoot = makeSource();
  const workspace = tmp("ws");
  const manifest = makeManifest([{
    id: "companion:deps", kind: "companion", group: "skills", subcategory: null,
    title: "deps", summary: "", recommended: false, consent: "exec", platform: "any",
    agents: { [AGENT]: { source: [], sourceMode: "first", target: null, strategy: "exec" } },
    companions: [], requires: [],
    exec: { command: "npm", args: ["ci"], cwd: "." },
  }]);

  const gated = plan({ workspace, sourceRoot, manifest, items: ["companion:deps"] });
  assert.equal(actionFor(gated, "companion:deps").kind, "skip");
  assert.match(actionFor(gated, "companion:deps").reason, /--allow-exec/);

  const allowed = plan({ workspace, sourceRoot, manifest, items: ["companion:deps"], allowExec: true });
  assert.equal(actionFor(allowed, "companion:deps").kind, "exec");
  assert.equal(allowed.summary.changes, 0, "an exec is not a file change");
});

test("external and operator items never become file changes", () => {
  const sourceRoot = makeSource();
  const workspace = tmp("ws");
  const mk = (id, consent) => ({
    id, kind: "external-package", group: "skills", subcategory: null,
    title: id, summary: "", recommended: false, consent, platform: "any",
    agents: { [AGENT]: { source: [], sourceMode: "first", target: null, strategy: consent === "external" ? "external" : "operator" } },
    companions: [], requires: [],
  });
  const manifest = makeManifest([mk("external-package:x", "external"), mk("codex:y", "operator")]);

  const result = plan({
    workspace, sourceRoot, manifest,
    items: ["external-package:x", "codex:y"], allowExec: true,
  });

  assert.equal(actionFor(result, "external-package:x").kind, "external");
  assert.equal(actionFor(result, "codex:y").kind, "operator");
  assert.equal(result.summary.changes, 0);
});

test("requirements are ordered before the items that need them", () => {
  const sourceRoot = makeSource();
  const workspace = tmp("ws");
  const manifest = makeManifest();
  manifest.items.find((i) => i.id === "skill:alpha").requires = ["skill:beta"];

  const result = plan({ workspace, sourceRoot, manifest, items: ["skill:alpha"] });
  const ids = result.actions.map((a) => a.id);

  assert.ok(ids.includes("skill:beta"), "requires closure must pull beta in");
  assert.ok(ids.indexOf("skill:beta") < ids.indexOf("skill:alpha"));
});

test("unknown profiles and item ids are reported, not fatal", () => {
  const sourceRoot = makeSource();
  const workspace = tmp("ws");
  const result = plan({
    workspace, sourceRoot, manifest: makeManifest(),
    profiles: ["nope"], items: ["skill:alpha", "skill:missing"],
  });

  assert.deepEqual(result.selection.unknown, ["profile:nope", "skill:missing"]);
  assert.equal(result.summary.create, 1);
});

test("planning without a resolvable agent fails loudly", () => {
  const sourceRoot = makeSource();
  const workspace = tmp("ws");
  assert.throws(
    () => buildPlan({
      workspace, sourceRoot, packageVersion: CURRENT_VERSION,
      manifest: makeManifest(), agent: null, profiles: ["full"],
    }),
    /--agent/,
  );
});

// ── Phase 5: upgrade and the three-way merge ────────────────────────────────

test("upgrade refreshes an untouched item whose source moved on", () => {
  const sourceRoot = makeSource({ alphaNow: "alpha v2\n" });
  const workspace = tmp("ws");
  const manifest = makeManifest();
  installFixture({ workspace, sourceRoot, manifest, ids: ["skill:alpha"] });

  const result = plan({ workspace, sourceRoot, manifest, verb: "upgrade" });
  const action = actionFor(result, "skill:alpha");

  assert.equal(action.kind, "refresh");
  assert.equal(action.state, "outdated");
  assert.equal(result.summary.changes, 1);
});

test("upgrade preserves a local edit when upstream did not move", () => {
  const sourceRoot = makeSource();              // alpha unchanged between base and now
  const workspace = tmp("ws");
  const manifest = makeManifest();
  installFixture({ workspace, sourceRoot, manifest, ids: ["skill:alpha"] });
  write(workspace, ".pi/skills/alpha/SKILL.md", "my local edit\n");

  const result = plan({ workspace, sourceRoot, manifest, verb: "upgrade" });
  const action = actionFor(result, "skill:alpha");

  assert.equal(action.kind, "keep");
  assert.equal(action.preserved, true);
  assert.equal(result.summary.changes, 0, "an upgrade must not eat a local edit");
});

test("upgrade flags a both-changed file as a conflict and never picks a side", () => {
  // base = v1, theirs = v2, ours = a third thing → spec §4.2 row 5.
  const sourceRoot = makeSource({ alphaNow: "alpha v2\n" });
  const workspace = tmp("ws");
  const manifest = makeManifest();
  installFixture({ workspace, sourceRoot, manifest, ids: ["skill:alpha"] });
  write(workspace, ".pi/skills/alpha/SKILL.md", "my local edit\n");

  const result = plan({ workspace, sourceRoot, manifest, verb: "upgrade" });
  const action = actionFor(result, "skill:alpha");

  assert.equal(action.kind, "conflict");
  assert.ok(hasConflicts(result), "a conflict must surface for the exit-3 contract");
  assert.deepEqual(action.files, [{ path: ".pi/skills/alpha/SKILL.md", state: "conflict" }]);
  assert.equal(result.summary.changes, 0, "a conflict is not applied");
});

test("--accept-theirs and --accept-ours resolve conflicts non-interactively", () => {
  const build = (accept) => {
    const sourceRoot = makeSource({ alphaNow: "alpha v2\n" });
    const workspace = tmp("ws");
    const manifest = makeManifest();
    installFixture({ workspace, sourceRoot, manifest, ids: ["skill:alpha"] });
    write(workspace, ".pi/skills/alpha/SKILL.md", "my local edit\n");
    return plan({ workspace, sourceRoot, manifest, verb: "upgrade", accept });
  };

  const theirs = build("theirs");
  assert.equal(actionFor(theirs, "skill:alpha").kind, "refresh");
  assert.equal(actionFor(theirs, "skill:alpha").overwrites, true);
  assert.equal(hasConflicts(theirs), false);

  const ours = build("ours");
  assert.equal(actionFor(ours, "skill:alpha").kind, "keep");
  assert.equal(actionFor(ours, "skill:alpha").preserved, true);
  assert.equal(hasConflicts(ours), false);
});

test("upgrade without a merge base degrades to two-way and says so", () => {
  const sourceRoot = makeSource({ alphaNow: "alpha v2\n" });
  const workspace = tmp("ws");
  const manifest = makeManifest();
  installFixture({ workspace, sourceRoot, manifest, ids: ["skill:alpha"] });
  write(workspace, ".pi/skills/alpha/SKILL.md", "my local edit\n");
  rmSync(join(sourceRoot, ".versions", BASE_VERSION), { recursive: true });

  const result = plan({ workspace, sourceRoot, manifest, verb: "upgrade" });

  assert.equal(result.baseAvailable, false);
  assert.ok(result.notes.some((n) => n.type === "base-snapshot-missing"));
  assert.equal(actionFor(result, "skill:alpha").kind, "keep", "no base ⇒ preserve, never clobber");
});

test("upgrade proposes removal of an artifact retired upstream", () => {
  const sourceRoot = makeSource();
  const workspace = tmp("ws");
  const manifest = makeManifest();
  installFixture({ workspace, sourceRoot, manifest, ids: ["skill:alpha", "skill:beta"], fromBase: false });

  // beta leaves the catalogue entirely, the way a retired harness does.
  const shrunk = { ...manifest, items: manifest.items.filter((i) => i.id !== "skill:beta") };

  const result = plan({ workspace, sourceRoot, manifest: shrunk, verb: "upgrade" });
  const action = actionFor(result, "skill:beta");

  assert.equal(action.kind, "remove");
  assert.equal(action.owned, true);
  assert.match(action.reason, /retired upstream/);
});

test("upgrade never widens the install", () => {
  const sourceRoot = makeSource();
  const workspace = tmp("ws");
  const manifest = makeManifest();
  installFixture({ workspace, sourceRoot, manifest, ids: ["skill:alpha"], fromBase: false });

  const result = plan({ workspace, sourceRoot, manifest, verb: "upgrade" });

  assert.equal(actionFor(result, "skill:beta"), undefined, "an uninstalled item is not an action");
  assert.equal(result.summary.newAvailable, 1, "but it is reported as available");
});

test("upgrade on a workspace with no install record refuses", () => {
  const sourceRoot = makeSource();
  const workspace = tmp("ws");
  assert.throws(
    () => plan({ workspace, sourceRoot, manifest: makeManifest(), verb: "upgrade" }),
    /nothing to upgrade/,
  );
});

test("upgrade of a pre-engine workspace warns before it acts", () => {
  const sourceRoot = makeSource();
  const workspace = tmp("ws");
  write(workspace, ".ai/agent-fleet-setup.md", `## workspace-summary\n\nversion: ${BASE_VERSION}\nagent: ${AGENT}\n`);

  const result = plan({ workspace, sourceRoot, manifest: makeManifest(), verb: "upgrade" });

  assert.equal(result.stateSource, "legacy-record");
  assert.ok(result.notes.some((n) => n.type === "pre-engine-workspace"));
  assert.equal(result.summary.changes, 0, "no ownership record ⇒ nothing is owned ⇒ nothing to do");
});

test("upgrade at the same version still reports content drift", () => {
  const sourceRoot = makeSource({ alphaNow: "alpha v2\n" });
  const workspace = tmp("ws");
  const manifest = makeManifest();
  const state = installFixture({ workspace, sourceRoot, manifest, ids: ["skill:alpha"] });
  state.packageVersion = CURRENT_VERSION;
  writeState(workspace, state);
  // The snapshot the state now points at does not exist; drift is still visible.
  const result = plan({ workspace, sourceRoot, manifest, verb: "upgrade" });

  assert.ok(result.notes.some((n) => n.type === "no-version-delta"));
  assert.equal(actionFor(result, "skill:alpha").kind, "refresh");
});

// ── golden plans against the real manifest ──────────────────────────────────

for (const agent of ["pi", "claude-code"]) {
  test(`golden: fresh ${agent} workspace, --profile recommended`, () => {
    const workspace = tmp(`golden-${agent}`);
    const result = buildPlan({
      workspace,
      sourceRoot: repoRoot,
      packageVersion: loadManifest(repoRoot).packageVersion,
      manifest: loadManifest(repoRoot),
      agent,
      profiles: ["recommended"],
      platform: "linux",
    });

    const rendered = result.actions.map((a) => `${a.kind}\t${a.id}`).join("\n") + "\n";
    const goldenPath = join(GOLDEN_DIR, `plan-${agent}-recommended.txt`);

    if (process.env.UPDATE_PLAN_GOLDEN === "1") {
      mkdirSync(GOLDEN_DIR, { recursive: true });
      writeFileSync(goldenPath, rendered, "utf8");
    }

    assert.ok(
      existsSync(goldenPath),
      `missing golden ${goldenPath} — regenerate with UPDATE_PLAN_GOLDEN=1`,
    );
    assert.equal(
      rendered,
      readFileSync(goldenPath, "utf8"),
      "plan changed for a fresh workspace — review the diff, then UPDATE_PLAN_GOLDEN=1",
    );
    assert.equal(result.conflicts.length, 0, "a fresh workspace cannot conflict");
  });
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** Path → mtime+size, for asserting a directory was not touched. */
function snapshot(root) {
  return walkTree(root).map((rel) => {
    const st = statSync(join(root, rel));
    return `${rel}:${st.size}:${st.mtimeMs}`;
  });
}
