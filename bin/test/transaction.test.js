import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runTransaction, JOURNAL_REL_PATH } from "../lib/transaction.js";
import { buildPlan } from "../lib/plan.js";
import { applyPlan } from "../lib/apply.js";
import { loadManifest } from "../lib/manifest.js";
import { emptyState, writeState, readState } from "../lib/state.js";
import { buildReconcilePlan } from "../lib/reconcile.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifest = loadManifest(repoRoot);

function write(root, rel, text) {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

test("transaction interruption restores the exact pre-commit tree", () => {
  const workspace = mkdtempSync(join(tmpdir(), "af-tx-"));
  writeFileSync(join(workspace, "before.txt"), "before");
  assert.throws(() => runTransaction({ workspace, plan: { workspace, actions: [{ files: [{ path: "before.txt" }] }] }, failAt: "after-commit", commit: () => writeFileSync(join(workspace, "before.txt"), "after") }), /injected/);
  assert.equal(readFileSync(join(workspace, "before.txt"), "utf8"), "before");
  assert.equal(existsSync(join(workspace, JOURNAL_REL_PATH)), false);
});

test("transaction backup and rollback never touch foreign, .git, or concurrent paths", () => {
  const workspace = mkdtempSync(join(tmpdir(), "af-tx-owned-"));
  write(workspace, ".pi/skills/owned/SKILL.md", "before");
  write(workspace, ".git/config", "foreign git");
  write(workspace, "foreign.txt", "foreign");
  assert.throws(() => runTransaction({
    workspace, plan: { workspace, actions: [{ files: [{ path: ".pi/skills/owned/SKILL.md" }] }] },
    failAt: "after-commit",
    commit: () => {
      write(workspace, ".pi/skills/owned/SKILL.md", "after");
      write(workspace, "concurrent.txt", "created while committing");
    },
  }), /injected/);
  assert.equal(readFileSync(join(workspace, ".pi/skills/owned/SKILL.md"), "utf8"), "before");
  assert.equal(readFileSync(join(workspace, ".git/config"), "utf8"), "foreign git");
  assert.equal(readFileSync(join(workspace, "foreign.txt"), "utf8"), "foreign");
  assert.equal(readFileSync(join(workspace, "concurrent.txt"), "utf8"), "created while committing");
});

test("recovery journal is written with fsync before commit", () => {
  const workspace = mkdtempSync(join(tmpdir(), "af-tx-fsync-"));
  write(workspace, "owned.txt", "before");
  let sawJournalBeforeCommit = false;
  runTransaction({
    workspace,
    plan: { workspace, actions: [{ files: [{ path: "owned.txt" }] }] },
    commit: () => {
      assert.ok(existsSync(join(workspace, JOURNAL_REL_PATH)), "journal must exist before commit mutates");
      const body = JSON.parse(readFileSync(join(workspace, JOURNAL_REL_PATH), "utf8"));
      assert.equal(body.schemaVersion, 2);
      assert.ok(Array.isArray(body.paths));
      assert.ok(body.paths.includes("owned.txt"));
      sawJournalBeforeCommit = true;
      writeFileSync(join(workspace, "owned.txt"), "after");
    },
  });
  assert.equal(sawJournalBeforeCommit, true);
  assert.equal(existsSync(join(workspace, JOURNAL_REL_PATH)), false);
  assert.equal(readFileSync(join(workspace, "owned.txt"), "utf8"), "after");
});

test("validation failure creates no journal", () => {
  const workspace = mkdtempSync(join(tmpdir(), "af-tx-"));
  assert.throws(() => runTransaction({ workspace, validate: () => { throw new Error("bad snapshot"); }, commit: () => {} }), /bad snapshot/);
  assert.equal(existsSync(join(workspace, JOURNAL_REL_PATH)), false);
});

test("rejected migration fails before journaling with no workspace write", () => {
  const workspace = mkdtempSync(join(tmpdir(), "af-tx-mig-"));
  const state = emptyState({
    agent: "pi", method: "copy", packageVersion: "0.0.10", sourceRoot: repoRoot,
  });
  writeState(workspace, state);
  const marker = join(workspace, "untouched.txt");
  writeFileSync(marker, "keep");
  const plan = buildReconcilePlan({
    workspace, sourceRoot: repoRoot, packageVersion: manifest.packageVersion, manifest,
  });
  assert.equal(plan.migrationBlocked, true);
  const applied = applyPlan({ plan, manifest });
  assert.equal(applied.exitCode, 1);
  assert.match(applied.failure.detail, /first migration requires/);
  assert.equal(existsSync(join(workspace, JOURNAL_REL_PATH)), false);
  assert.equal(readFileSync(marker, "utf8"), "keep");
  assert.equal(existsSync(join(workspace, ".ai", "agent-fleet.json")), false);
});

test("unsupported snapshot metadata fails before journaling with no workspace write", () => {
  const sourceRoot = mkdtempSync(join(tmpdir(), "af-tx-snap-"));
  const workspace = mkdtempSync(join(tmpdir(), "af-tx-ws-"));
  write(sourceRoot, "skills/alpha/SKILL.md", "alpha v2\n");
  write(sourceRoot, ".versions/1.0.0/skills/alpha/SKILL.md", "alpha v1\n");
  write(sourceRoot, ".versions/1.0.0/install-manifest.json", JSON.stringify({
    schemaVersion: 99, packageVersion: "1.0.0", groups: [], items: [],
  }));
  const mini = {
    schemaVersion: 2,
    packageVersion: "1.1.0",
    groups: [{ id: "skills", title: "Skills", order: 1, agents: ["pi"] }],
    presets: { default: { title: "Default", items: ["skill:alpha"] } },
    features: {},
    profiles: { all: { title: "all", rule: "all" } },
    items: [{
      id: "skill:alpha", kind: "skill", group: "skills", title: "alpha",
      summary: "", recommended: true, consent: "file", platform: "any",
      stability: "stable", companions: [], requires: [],
      agents: { pi: { source: ["skills/alpha"], sourceMode: "first", target: ".pi/skills/alpha", strategy: "copy-tree" } },
    }],
  };
  const state = emptyState({ agent: "pi", method: "copy", packageVersion: "1.0.0", sourceRoot });
  state.items["skill:alpha"] = {
    kind: "skill", files: [{ path: ".pi/skills/alpha/SKILL.md", sha256: "0".repeat(64) }],
  };
  writeState(workspace, state);
  write(workspace, ".pi/skills/alpha/SKILL.md", "alpha v1\n");
  const before = readFileSync(join(workspace, ".pi/skills/alpha/SKILL.md"), "utf8");
  const plan = buildPlan({
    workspace, sourceRoot, packageVersion: "1.1.0", manifest: mini, verb: "upgrade", agent: "pi",
  });
  assert.match(plan.snapshotMetadataError ?? "", /unsupported snapshot manifest schemaVersion/);
  assert.equal(plan.baseAvailable, false);
  const applied = applyPlan({ plan, manifest: mini });
  assert.equal(applied.exitCode, 1);
  assert.match(applied.failure.detail, /unsupported snapshot manifest schemaVersion/);
  assert.equal(existsSync(join(workspace, JOURNAL_REL_PATH)), false);
  assert.equal(readFileSync(join(workspace, ".pi/skills/alpha/SKILL.md"), "utf8"), before);
});

test("desired and applied state commit in the same transaction", () => {
  const sourceRoot = mkdtempSync(join(tmpdir(), "af-tx-des-src-"));
  const workspace = mkdtempSync(join(tmpdir(), "af-tx-des-ws-"));
  write(sourceRoot, "skills/alpha/SKILL.md", "alpha\n");
  const mini = {
    schemaVersion: 2,
    packageVersion: "1.1.0",
    groups: [{ id: "skills", title: "Skills", order: 1, agents: ["pi"] }],
    presets: { default: { title: "Default", items: ["skill:alpha"] } },
    features: {},
    profiles: { all: { title: "all", rule: "all" } },
    items: [{
      id: "skill:alpha", kind: "skill", group: "skills", title: "alpha",
      summary: "", recommended: true, consent: "file", platform: "any",
      stability: "stable", companions: [], requires: [],
      agents: { pi: { source: ["skills/alpha"], sourceMode: "first", target: ".pi/skills/alpha", strategy: "copy-tree" } },
    }],
  };
  write(workspace, ".ai/agent-fleet.json", JSON.stringify({
    schemaVersion: 1, preset: "default", features: {},
  }));
  const plan = buildReconcilePlan({
    workspace, sourceRoot, packageVersion: "1.1.0", manifest: mini,
    preset: "default", features: "none", yes: true,
  });
  plan.writeDesired = true;

  // Injected post-commit failure rolls back desired rewrite and applied state together.
  const failed = applyPlan({ plan, manifest: mini, failAt: "after-commit" });
  assert.equal(failed.exitCode, 1);
  assert.equal(existsSync(join(workspace, JOURNAL_REL_PATH)), false);
  assert.equal(readState(workspace), null, "rolled back: no applied state without successful commit");
  assert.equal(existsSync(join(workspace, ".pi/skills/alpha/SKILL.md")), false);
  assert.equal(
    JSON.parse(readFileSync(join(workspace, ".ai/agent-fleet.json"), "utf8")).preset,
    "default",
  );

  const ok = applyPlan({ plan, manifest: mini });
  assert.equal(ok.exitCode, 0);
  assert.ok(readState(workspace)?.items?.["skill:alpha"]);
  assert.ok(existsSync(join(workspace, ".ai/agent-fleet.json")));
  assert.ok(existsSync(join(workspace, ".pi/skills/alpha/SKILL.md")));
});
