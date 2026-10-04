import test, { after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync, lstatSync, readlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runTransaction, capturePlanFingerprints, JOURNAL_REL_PATH } from "../lib/transaction.js";
import { buildPlan } from "../lib/plan.js";
import { applyPlan } from "../lib/apply.js";
import { loadManifest } from "../lib/manifest.js";
import { emptyState, writeState, readState } from "../lib/state.js";
import { buildReconcilePlan } from "../lib/reconcile.js";
import { assertSafeWorkspaceTarget } from '../lib/workspace-safety.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifest = loadManifest(repoRoot);

const allocatedDirectories = [];
function temporaryDirectory(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  // Cleanup is registered before file writes, setup or assertions can fail.
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  allocatedDirectories.push(dir);
  return dir;
}
after(() => {
  for (const dir of allocatedDirectories) assert.equal(existsSync(dir), false, `Leaked test directory: ${dir}`);
});

function write(root, rel, text) {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

test("transaction interruption restores the exact pre-commit tree", t => {
  const workspace = temporaryDirectory(t, "af-tx-");
  writeFileSync(join(workspace, "before.txt"), "before");
  assert.throws(() => runTransaction({ workspace, plan: { workspace, actions: [{ files: [{ path: "before.txt" }] }] }, failAt: "after-commit", commit: () => writeFileSync(join(workspace, "before.txt"), "after") }), /injected/);
  assert.equal(readFileSync(join(workspace, "before.txt"), "utf8"), "before");
  assert.equal(existsSync(join(workspace, JOURNAL_REL_PATH)), false);
});

test("transaction backup and rollback never touch foreign, .git, or concurrent paths", t => {
  const workspace = temporaryDirectory(t, "af-tx-owned-");
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

test("recovery journal is written with fsync before commit", t => {
  const workspace = temporaryDirectory(t, "af-tx-fsync-");
  write(workspace, "owned.txt", "before");
  let sawJournalBeforeCommit = false;
  runTransaction({
    workspace,
    plan: { workspace, actions: [{ files: [{ path: "owned.txt" }] }] },
    commit: () => {
      assert.ok(existsSync(join(workspace, JOURNAL_REL_PATH)), "journal must exist before commit mutates");
      const body = JSON.parse(readFileSync(join(workspace, JOURNAL_REL_PATH), "utf8"));
      assert.equal(body.schemaVersion, 3);
      assert.equal(body.phase, "applying");
      assert.match(body.backup, /^\.ai\/\.agent-fleet-recovery\//);
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

test("validation failure creates no journal", t => {
  const workspace = temporaryDirectory(t, "af-tx-");
  assert.throws(() => runTransaction({ workspace, validate: () => { throw new Error("bad snapshot"); }, commit: () => {} }), /bad snapshot/);
  assert.equal(existsSync(join(workspace, JOURNAL_REL_PATH)), false);
});

test("rejected migration fails before journaling with no workspace write", t => {
  const workspace = temporaryDirectory(t, "af-tx-mig-");
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

test("unsupported snapshot metadata fails before journaling with no workspace write", t => {
  const sourceRoot = temporaryDirectory(t, "af-tx-snap-");
  const workspace = temporaryDirectory(t, "af-tx-ws-");
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

test("task-triage config and desired selection roll back together on interrupted setup", t => {
  const workspace = temporaryDirectory(t, "af-tx-triage-");
  const plan = buildReconcilePlan({
    workspace, sourceRoot: repoRoot, packageVersion: manifest.packageVersion, manifest,
    preset: "default", features: "system1-task-triage", taskTriageConsent: true, yes: true,
  });
  assert.equal(plan.taskTriage?.write, true);
  assert.equal(plan.taskTriageProvider?.write, false);
  const failed = applyPlan({ plan, manifest, failAt: "after-commit" });
  assert.equal(failed.exitCode, 1);
  assert.equal(existsSync(join(workspace, ".ai/task-triage.json")), false);
  assert.equal(existsSync(join(workspace, ".ai/system1.json")), false);
  assert.equal(existsSync(join(workspace, ".ai/agent-fleet.json")), false);
  assert.equal(readState(workspace), null);
  assert.equal(existsSync(join(workspace, JOURNAL_REL_PATH)), false);
  const applied = applyPlan({ plan, manifest });
  assert.equal(applied.exitCode, 0, applied.failure?.detail);
  assert.equal(JSON.parse(readFileSync(join(workspace, ".ai/system1.json"), "utf8")).consumers.taskTriage.mode, "experimental");
  assert.equal(JSON.parse(readFileSync(join(workspace, ".ai/system1.json"), "utf8")).apiKeyEnv, "TYPESAFE_API_KEY");
});

test("task-triage planning refuses a linked config or linked .ai parent before reading outside the workspace", t => {
  const workspace = temporaryDirectory(t, "af-tx-triage-links-");
  const foreign = temporaryDirectory(t, "af-tx-triage-foreign-");
  const sentinel = write(foreign, "secret.json", '{"remoteContextApproved":true}\n');
  mkdirSync(join(workspace, ".ai"));
  symlinkSync(sentinel, join(workspace, ".ai/system1.json"));
  const plan = () => buildReconcilePlan({ workspace, sourceRoot: repoRoot, packageVersion: manifest.packageVersion, manifest,
    preset: "default", features: "system1-task-triage", taskTriageConsent: true, yes: true });
  assert.throws(plan, /symlink|regular file/);
  rmSync(join(workspace, ".ai/system1.json"));
  rmSync(join(workspace, ".ai"), { recursive: true });
  symlinkSync(foreign, join(workspace, ".ai"));
  assert.throws(plan, /symlink/);
  assert.equal(readFileSync(sentinel, "utf8"), '{"remoteContextApproved":true}\n');
});

test('dangling symlinks are neither safe write targets nor absent fingerprints', t => {
  const workspace = temporaryDirectory(t, 'af-tx-dangling-');
  const outside = temporaryDirectory(t, 'af-tx-dangling-outside-');
  mkdirSync(join(workspace, '.ai'));
  const plan = { workspace, verb: 'configure', actions: [{ files: [{ path: '.ai/system1.json' }] }] };
  plan.fingerprints = capturePlanFingerprints(plan, { items: [] });
  symlinkSync(join(outside, 'not-present'), join(workspace, '.ai/system1.json'));
  assert.throws(() => assertSafeWorkspaceTarget(workspace, '.ai/system1.json', { allowLeafSymlink: false }), /symlink/);
  assert.throws(() => runTransaction({ workspace, plan, manifest: { items: [] }, commit: () => { throw Error('must not run'); } }), error => error.exitCode === 3 && /changed since preview/.test(error.message));
  assert.equal(existsSync(join(outside, 'not-present')), false);
  assert.equal(lstatSync(join(workspace, '.ai/system1.json')).isSymbolicLink(), true);
});
test('rollback retains a legitimate managed dangling leaf link', t => {
  const workspace = temporaryDirectory(t, 'af-tx-dangling-rollback-');
  mkdirSync(join(workspace, '.ai'));
  const path = join(workspace, '.ai/managed-link');
  symlinkSync(join(workspace, 'not-present'), path);
  const target = readlinkSync(path);
  const plan = { workspace, verb: 'configure', actions: [{ files: [{ path: '.ai/managed-link' }] }] };
  plan.fingerprints = capturePlanFingerprints(plan, { items: [] });
  assert.throws(() => runTransaction({ workspace, plan, manifest: { items: [] }, commit: () => { unlinkSync(path); writeFileSync(path, 'new'); throw Error('injected'); } }), /injected/);
  assert.equal(lstatSync(path).isSymbolicLink(), true);
  assert.equal(readlinkSync(path), target);
});

test("desired and applied state commit in the same transaction", t => {
  const sourceRoot = temporaryDirectory(t, "af-tx-des-src-");
  const workspace = temporaryDirectory(t, "af-tx-des-ws-");
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
