// Fleet Core closure and the retired hard-stop harness.
//
// These rules used to be prose in guided-workspace-setup/SKILL.md, asserted here
// as regexes over that file. Phase 7 of plans/deterministic-installer.md moved
// them into data and code — `requires`/`pinnedBy` in the manifest, and the
// ownership check in apply.js — so the assertions moved with them. A regex over
// prose could only prove the sentence still existed; these prove the behaviour.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadManifest, resolveSelection } from "../lib/manifest.js";
import { buildPlan } from "../lib/plan.js";
import { applyPlan } from "../lib/apply.js";
import { writeState, emptyState, hashFile } from "../lib/state.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (path) => readFileSync(join(root, path), "utf8");

// The launcher is the authority: whatever `fleet_core_extensions` loads is what
// a workspace must have installed for `just fleet` to start at all.
const CORE_HARNESSES = ["pi-harness:damage-control-continue", "pi-harness:ask-user-remote"];
const CORE_EXTENSIONS = [
  "pi-extension:pi-voice-stt",
  "pi-extension:compact-and-continue",
  "pi-extension:btw",
  "pi-extension:agent-fleet-update-check",
];

test("only damage-control-continue remains in the active harness inventory", () => {
  assert.equal(existsSync(join(root, ".pi/harnesses/damage-control")), false);
  const manifest = loadManifest(root);
  assert.equal(manifest.items.some((i) => i.id === "pi-harness:damage-control"), false);
  assert.ok(manifest.items.some((i) => i.id === "pi-harness:damage-control-continue"));
});

test("the manifest's Fleet Core closure matches what the justfile loads", () => {
  // Parse the launcher, so a harness added to `fleet_core_extensions` without a
  // matching manifest edge fails here rather than at someone's session start.
  const line = read("justfile").match(/^fleet_core_extensions := "(.+)"$/m)?.[1];
  assert.ok(line, "justfile no longer declares fleet_core_extensions");

  const loaded = [...line.matchAll(/-e \.pi\/(harnesses|extensions)\/([\w-]+)\/index\.ts/g)]
    .map(([, kind, name]) => `pi-${kind === "harnesses" ? "harness" : "extension"}:${name}`);
  assert.deepEqual([...loaded].sort(), [...CORE_HARNESSES, ...CORE_EXTENSIONS].sort());

  // Installing any one harness must pull the whole set — that is the closure
  // the skill used to state in prose as the "mandatory Fleet Core" rule.
  const manifest = loadManifest(root);
  for (const harness of manifest.items.filter((i) => i.kind === "pi-harness")) {
    const { selected } = resolveSelection(manifest, "pi", { items: [harness.id] });
    for (const member of [...CORE_HARNESSES, ...CORE_EXTENSIONS]) {
      if (member === harness.id) continue;
      assert.ok(
        selected.includes(member),
        `selecting ${harness.id} did not pull Fleet Core member ${member}`,
      );
    }
  }
});

test("uninstall refuses to take a Fleet Core member out from under a harness", () => {
  const manifest = loadManifest(root);
  const workspace = mkdtempSync(join(tmpdir(), "af-core-"));

  // A workspace with agent-hub and the whole Core recorded as installed.
  const { selected } = resolveSelection(manifest, "pi", { items: ["pi-harness:agent-hub"] });
  const state = emptyState({
    agent: "pi", method: "copy", packageVersion: manifest.packageVersion,
    sourceRoot: root, profiles: [],
  });
  for (const id of selected) state.items[id] = { kind: "unknown", files: [] };
  writeState(workspace, state);

  for (const member of [...CORE_HARNESSES, ...CORE_EXTENSIONS]) {
    const plan = buildPlan({
      workspace, sourceRoot: root, packageVersion: manifest.packageVersion, manifest,
      verb: "uninstall", agent: "pi", items: [member], platform: "linux",
    });
    assert.deepEqual(
      plan.actions.map((a) => a.id), [],
      `${member} was planned for removal while agent-hub is installed`,
    );
    assert.ok(
      plan.notes.some((n) => n.type === "pinned" && n.detail.includes(member)),
      `${member} was dropped without saying which harness pins it`,
    );
  }
});

test("a retired harness is removed only when recorded and unmodified", () => {
  const manifest = loadManifest(root);
  const retired = "pi-harness:damage-control";
  const target = ".pi/harnesses/damage-control/index.ts";

  const setup = (contents, { record = true } = {}) => {
    const workspace = mkdtempSync(join(tmpdir(), "af-retired-"));
    mkdirSync(join(workspace, dirname(target)), { recursive: true });
    writeFileSync(join(workspace, target), contents, "utf8");
    const state = emptyState({
      agent: "pi", method: "copy", packageVersion: manifest.packageVersion,
      sourceRoot: root, profiles: [],
    });
    if (record) {
      state.items[retired] = {
        kind: "pi-harness", strategy: "copy-tree", method: "copy",
        files: [{ path: target, mode: "copy", sha256: hashFile(join(workspace, "shipped-copy")) }],
      };
      // Record the hash of what we "shipped", which only matches the unmodified case.
      state.items[retired].files[0].sha256 = hashFile(join(workspace, target));
    }
    writeState(workspace, state);
    return workspace;
  };

  const removalPlan = (workspace) => buildPlan({
    workspace, sourceRoot: root, packageVersion: manifest.packageVersion, manifest,
    verb: "uninstall", agent: "pi", items: [retired], platform: "linux",
  });

  // Recorded and untouched → removed.
  const clean = setup("export const retired = true;\n");
  const cleanPlan = removalPlan(clean);
  assert.deepEqual(cleanPlan.actions.map((a) => `${a.kind}:${a.id}`), [`remove:${retired}`]);
  applyPlan({ plan: cleanPlan, manifest });
  assert.equal(existsSync(join(clean, target)), false);

  // Recorded but edited by the user → preserved, and said so.
  const edited = setup("export const retired = true;\n");
  writeFileSync(join(edited, target), "my own version\n", "utf8");
  const editedApplied = applyPlan({ plan: removalPlan(edited), manifest });
  assert.equal(existsSync(join(edited, target)), true);
  assert.match(
    editedApplied.results.find((r) => r.id === retired).detail,
    /kept 1 user-modified path/,
  );

  // Not recorded at all → not ours, never proposed.
  const foreign = setup("someone else's harness\n", { record: false });
  assert.deepEqual(removalPlan(foreign).actions, []);
  assert.equal(existsSync(join(foreign, target)), true);
});
