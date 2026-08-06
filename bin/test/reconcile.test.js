import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadManifest } from "../lib/manifest.js";
import { emptyState, writeState } from "../lib/state.js";
import { buildReconcilePlan } from "../lib/reconcile.js";
import { buildPlan } from "../lib/plan.js";

const root = process.cwd();
const manifest = loadManifest(root);
const workspace = () => mkdtempSync(join(tmpdir(), "af-reconcile-"));

function legacyWorkspace() {
  const dir = workspace();
  const state = emptyState({ agent: "pi", method: "copy", packageVersion: "0.0.10", sourceRoot: root });
  state.items["foreign:item"] = { kind: "unknown", files: [{ path: ".pi/extensions/custom/index.ts", sha256: "x" }] };
  writeState(dir, state);
  return dir;
}

test("first migration is dry-run previewable but mutation is strictly gated", () => {
  const dir = legacyWorkspace();
  assert.equal(buildReconcilePlan({ workspace: dir, sourceRoot: root, packageVersion: manifest.packageVersion, manifest, dryRun: true }).migrationBlocked, false);
  const blocked = buildReconcilePlan({ workspace: dir, sourceRoot: root, packageVersion: manifest.packageVersion, manifest });
  assert.equal(blocked.firstMigration, true);
  assert.equal(blocked.migrationBlocked, true);
  const allowed = buildReconcilePlan({ workspace: dir, sourceRoot: root, packageVersion: manifest.packageVersion, manifest, migrate: true, yes: true, preset: "default", features: "none" });
  assert.equal(allowed.migrationBlocked, false);
});

test("reconciliation lists only owned removals by exact path and never adopts foreign files", () => {
  const dir = workspace();
  mkdirSync(join(dir, ".ai"));
  writeFileSync(join(dir, ".ai", "agent-fleet.json"), JSON.stringify({ schemaVersion: 1, preset: "default", features: {} }));
  const state = emptyState({ agent: "pi", method: "copy", packageVersion: manifest.packageVersion, sourceRoot: root });
  state.items["retired:item"] = { kind: "unknown", files: [{ path: ".pi/extensions/retired/index.ts", sha256: "x" }] };
  writeState(dir, state);
  const plan = buildReconcilePlan({ workspace: dir, sourceRoot: root, packageVersion: manifest.packageVersion, manifest });
  const removal = plan.actions.find((action) => action.id === "retired:item");
  assert.deepEqual(removal.paths, [".pi/extensions/retired/index.ts"]);
  assert.equal(plan.actions.some((action) => action.target === ".pi/extensions/custom/index.ts"), false);
});

test("schema-v1 and pre-manifest source snapshots remain available three-way merge bases", () => {
  for (const version of ["0.0.10", "0.0.11"]) {
    const dir = workspace();
    mkdirSync(join(dir, ".ai"), { recursive: true });
    writeFileSync(join(dir, ".ai", "agent-fleet.json"), JSON.stringify({ schemaVersion: 1, preset: "default", features: {} }));
    writeState(dir, emptyState({ agent: "pi", method: "copy", packageVersion: version, sourceRoot: root }));
    const plan = buildPlan({
      workspace: dir, sourceRoot: root, packageVersion: manifest.packageVersion, manifest, verb: "upgrade", agent: "pi",
    });
    assert.equal(plan.baseAvailable, true, `schema-v1 snapshot ${version} must stay a merge base`);
    assert.equal(plan.snapshotMetadataError, null);
  }
  const pre = workspace();
  mkdirSync(join(pre, ".ai"), { recursive: true });
  writeFileSync(join(pre, ".ai", "agent-fleet.json"), JSON.stringify({ schemaVersion: 1, preset: "default", features: {} }));
  writeState(pre, emptyState({ agent: "pi", method: "copy", packageVersion: "0.0.9", sourceRoot: root }));
  const prePlan = buildPlan({
    workspace: pre, sourceRoot: root, packageVersion: manifest.packageVersion, manifest, verb: "upgrade", agent: "pi",
  });
  assert.equal(prePlan.baseAvailable, true, "pre-manifest .versions/0.0.9 remains a merge base");
  assert.equal(prePlan.snapshotMetadataError, null);
});
