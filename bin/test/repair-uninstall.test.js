// repair-uninstall.test.js — Phase 6: the two narrowing verbs.
//
// `repair` and `uninstall` are the same plan() → apply() core as install and
// upgrade, restricted to a subset of action kinds. That is the whole point: a
// doctor that repaired through its own code path would drift from setup, which
// is the failure this plan exists to remove. So the assertions here are mostly
// about what these verbs REFUSE to do — refresh content that is merely behind,
// delete a file we do not own, delete a file the user has edited, or orphan
// something another installed item still needs.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync,
  symlinkSync, unlinkSync, rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { buildPlan } from "../lib/plan.js";
import { applyPlan } from "../lib/apply.js";
import { loadManifest, validateManifest, itemsForAgent } from "../lib/manifest.js";
import { readState, writeState, emptyState, hashFile, walkTree } from "../lib/state.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const AGENT = "pi";
const VERSION = "1.0.0";

// ── synthetic world ─────────────────────────────────────────────────────────

const tmp = (label) => mkdtempSync(join(tmpdir(), `af-ru-${label}-`));

function write(root, rel, text) {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
  return path;
}

function makeSource() {
  const root = tmp("src");
  write(root, "skills/alpha/SKILL.md", "alpha v1\n");
  write(root, "skills/beta/SKILL.md", "beta v1\n");
  write(root, "shared/config.yaml", "shared\n");
  return root;
}

function item(id, over = {}) {
  return {
    id, kind: "skill", group: "skills", subcategory: null, title: id,
    summary: "", recommended: false, consent: "file", platform: "any",
    companions: [], requires: [],
    ...over,
  };
}

/**
 * alpha and beta both carry the same shared companion, so removing one of them
 * must not take the file the other still runs from.
 */
function makeManifest() {
  const skill = (name, over = {}) => item(`skill:${name}`, {
    agents: {
      [AGENT]: {
        source: [`skills/${name}`], sourceMode: "first",
        target: `.pi/skills/${name}`, strategy: "copy-tree",
      },
    },
    companions: ["companion:shared"],
    ...over,
  });

  return {
    schemaVersion: 1,
    packageVersion: VERSION,
    groups: [{ id: "skills", title: "Skills", order: 1, agents: [AGENT] }],
    profiles: { full: { title: "all", rule: "all" } },
    items: [
      skill("alpha"),
      skill("beta", { pinnedBy: ["skill:alpha"] }),
      item("companion:shared", {
        kind: "companion",
        group: "skills",
        parents: ["skill:alpha", "skill:beta"],
        companions: [],
        agents: {
          [AGENT]: {
            source: ["shared/config.yaml"], sourceMode: "first",
            target: ".pi/shared.yaml", strategy: "copy-file",
          },
        },
      }),
    ],
  };
}

/** A real install, so the state file records real hashes. */
function install(workspace, sourceRoot, manifest, { method = "copy" } = {}) {
  const plan = buildPlan({
    workspace, sourceRoot, packageVersion: VERSION, manifest,
    verb: "install", agent: AGENT, method, profiles: ["full"],
  });
  applyPlan({ plan, manifest });
  return readState(workspace);
}

function plan(workspace, sourceRoot, manifest, opts) {
  return buildPlan({
    workspace, sourceRoot, packageVersion: VERSION, manifest, agent: AGENT, ...opts,
  });
}

const kinds = (result) => result.actions.map((a) => `${a.kind}:${a.id}`).sort();

// ── repair ──────────────────────────────────────────────────────────────────

test("repair on a healthy workspace plans nothing", () => {
  const sourceRoot = makeSource();
  const workspace = tmp("ws");
  const manifest = makeManifest();
  install(workspace, sourceRoot, manifest);

  const result = plan(workspace, sourceRoot, manifest, { verb: "repair" });
  assert.deepEqual(result.actions, []);
  assert.equal(result.summary.changes, 0);
});

test("repair fixes breakage and refuses to touch content that is merely stale or edited", () => {
  const sourceRoot = makeSource();
  const workspace = tmp("ws");
  const manifest = makeManifest();
  install(workspace, sourceRoot, manifest);

  // beta is deleted — breakage. alpha is edited by the user, and the source has
  // moved on underneath it. Only beta is repairable; the other two are an
  // upgrade's business, not a doctor's.
  rmSync(join(workspace, ".pi/skills/beta"), { recursive: true });
  write(workspace, ".pi/skills/alpha/SKILL.md", "my own alpha\n");
  write(sourceRoot, "shared/config.yaml", "shared v2\n");

  const result = plan(workspace, sourceRoot, manifest, { verb: "repair" });
  assert.deepEqual(kinds(result), ["repair:skill:beta"]);

  applyPlan({ plan: result, manifest });
  assert.equal(readFileSync(join(workspace, ".pi/skills/beta/SKILL.md"), "utf8"), "beta v1\n");
  assert.equal(
    readFileSync(join(workspace, ".pi/skills/alpha/SKILL.md"), "utf8"),
    "my own alpha\n",
    "a repair must never overwrite a local edit",
  );
  assert.equal(readFileSync(join(workspace, ".pi/shared.yaml"), "utf8"), "shared\n");
});

test("repair ignores breakage the state file does not own", () => {
  const sourceRoot = makeSource();
  const workspace = tmp("ws");
  const manifest = makeManifest();

  // Nothing installed, but the paths exist as broken links — the legacy doctor
  // scan's territory, because the manifest cannot tell whose they are.
  mkdirSync(join(workspace, ".pi/skills"), { recursive: true });
  symlinkSync(join(sourceRoot, "skills/gone"), join(workspace, ".pi/skills/alpha"));
  writeState(workspace, emptyState({
    agent: AGENT, method: "copy", packageVersion: VERSION, sourceRoot, profiles: [],
  }));

  const result = plan(workspace, sourceRoot, manifest, { verb: "repair" });
  assert.deepEqual(result.actions, []);
});

test("repair rebuilds a dangling symlink rather than failing on it", () => {
  // Regression: rmSync(path, { force: true }) stats *through* a symlink, so a
  // dangling one looked already-gone and survived, and the replacing
  // symlinkSync then failed EEXIST. Repair is the case that hits this.
  const sourceRoot = makeSource();
  const workspace = tmp("ws");
  const manifest = makeManifest();
  // Symlink mode is only available inside an agent-fleet checkout.
  write(workspace, "package.json", JSON.stringify({ name: "@chankov/agent-fleet" }));
  install(workspace, sourceRoot, manifest, { method: "symlink" });

  const link = join(workspace, ".pi/skills/alpha");
  unlinkSync(link);
  symlinkSync(join(sourceRoot, "skills/vanished"), link);

  const result = plan(workspace, sourceRoot, manifest, { verb: "repair" });
  assert.deepEqual(kinds(result), ["repair:skill:alpha"]);

  const applied = applyPlan({ plan: result, manifest });
  assert.equal(applied.summary.failed, 0, JSON.stringify(applied.failure));
  assert.equal(readFileSync(join(workspace, ".pi/skills/alpha/SKILL.md"), "utf8"), "alpha v1\n");
});

test("repair on a workspace with no install record is an error, not a guess", () => {
  const sourceRoot = makeSource();
  const workspace = tmp("ws");
  assert.throws(
    () => plan(workspace, sourceRoot, makeManifest(), { verb: "repair" }),
    /no agent-fleet install record/,
  );
});

// ── uninstall ───────────────────────────────────────────────────────────────

test("uninstall removes only what it was asked for", () => {
  const sourceRoot = makeSource();
  const workspace = tmp("ws");
  const manifest = makeManifest();
  install(workspace, sourceRoot, manifest);

  const result = plan(workspace, sourceRoot, manifest, {
    verb: "uninstall", items: ["skill:alpha"],
  });
  assert.deepEqual(kinds(result), ["remove:skill:alpha"]);

  applyPlan({ plan: result, manifest });
  assert.equal(existsSync(join(workspace, ".pi/skills/alpha")), false);
  assert.equal(existsSync(join(workspace, ".pi/skills/beta/SKILL.md")), true);
  assert.equal(
    existsSync(join(workspace, ".pi/shared.yaml")),
    true,
    "a companion beta still needs must survive alpha's removal",
  );
  assert.equal(readState(workspace).items["skill:alpha"], undefined);
  assert.ok(readState(workspace).items["companion:shared"]);
});

test("uninstall --all takes the shared companion once nobody needs it", () => {
  const sourceRoot = makeSource();
  const workspace = tmp("ws");
  const manifest = makeManifest();
  install(workspace, sourceRoot, manifest);

  const result = plan(workspace, sourceRoot, manifest, { verb: "uninstall", all: true });
  assert.deepEqual(
    kinds(result),
    ["remove:companion:shared", "remove:skill:alpha", "remove:skill:beta"],
  );

  applyPlan({ plan: result, manifest });
  assert.equal(existsSync(join(workspace, ".pi/shared.yaml")), false);
  assert.deepEqual(readState(workspace).items, {});
});

test("uninstall refuses an item another installed item pins", () => {
  const sourceRoot = makeSource();
  const workspace = tmp("ws");
  const manifest = makeManifest();
  install(workspace, sourceRoot, manifest);

  const result = plan(workspace, sourceRoot, manifest, {
    verb: "uninstall", items: ["skill:beta"],
  });
  assert.deepEqual(result.actions, []);
  assert.equal(result.notes.find((n) => n.type === "pinned")?.detail.includes("skill:alpha"), true);
  assert.equal(existsSync(join(workspace, ".pi/skills/beta/SKILL.md")), true);
});

test("uninstall keeps a file the user edited and says so", () => {
  const sourceRoot = makeSource();
  const workspace = tmp("ws");
  const manifest = makeManifest();
  install(workspace, sourceRoot, manifest);
  write(workspace, ".pi/skills/alpha/SKILL.md", "mine now\n");

  const result = plan(workspace, sourceRoot, manifest, {
    verb: "uninstall", items: ["skill:alpha"],
  });
  const applied = applyPlan({ plan: result, manifest });

  assert.equal(readFileSync(join(workspace, ".pi/skills/alpha/SKILL.md"), "utf8"), "mine now\n");
  const record = applied.results.find((r) => r.id === "skill:alpha");
  assert.match(record.detail, /kept 1 user-modified path/);
});

test("uninstall never deletes a path the state file does not record", () => {
  const sourceRoot = makeSource();
  const workspace = tmp("ws");
  const manifest = makeManifest();
  install(workspace, sourceRoot, manifest);

  // A file at a manifest target that we did not write: same path, different
  // provenance. Dropping it from state is enough to make it untouchable.
  const state = readState(workspace);
  delete state.items["skill:beta"];
  writeState(workspace, state);

  const result = plan(workspace, sourceRoot, manifest, {
    verb: "uninstall", items: ["skill:beta"],
  });
  assert.deepEqual(result.selection.unknown, ["skill:beta"]);
  assert.deepEqual(result.actions, []);
  assert.equal(existsSync(join(workspace, ".pi/skills/beta/SKILL.md")), true);
});

test("uninstall reaches a recorded item the catalogue no longer lists", () => {
  const sourceRoot = makeSource();
  const workspace = tmp("ws");
  const manifest = makeManifest();
  install(workspace, sourceRoot, manifest);

  // Retire beta upstream: gone from the manifest, still on disk and recorded.
  const trimmed = { ...manifest, items: manifest.items.filter((i) => i.id !== "skill:beta") };
  const result = plan(workspace, sourceRoot, trimmed, {
    verb: "uninstall", items: ["skill:beta"],
  });
  assert.deepEqual(kinds(result), ["remove:skill:beta"]);

  applyPlan({ plan: result, manifest: trimmed });
  assert.equal(existsSync(join(workspace, ".pi/skills/beta")), false);
});

// ── operator items: the real manifest ───────────────────────────────────────

test("every operator-consent item declares the steps a human must run", () => {
  const manifest = loadManifest(repoRoot);
  const operator = manifest.items.filter((i) => i.consent === "operator");

  assert.ok(operator.length > 0, "the catalogue should still have operator items");
  for (const item of operator) {
    assert.ok(
      (item.operatorSteps ?? []).length > 0,
      `${item.id} is operator-applied but declares no steps — an unactionable row`,
    );
    for (const step of item.operatorSteps) {
      assert.equal(typeof step, "string");
      assert.ok(step.trim().length > 0, `${item.id} has an empty step`);
    }
  }
});

test("validateManifest rejects an operator item with no steps", () => {
  const manifest = loadManifest(repoRoot);
  const broken = {
    ...manifest,
    items: manifest.items.map((i) =>
      i.consent === "operator" ? { ...i, operatorSteps: [] } : i,
    ),
  };
  const problems = validateManifest(broken);
  assert.ok(problems.some((p) => /without operatorSteps/.test(p)));
});

test("the Hermes and Codex profiles plan as operator steps and write nothing", () => {
  const manifest = loadManifest(repoRoot);
  const workspace = tmp("ws");

  for (const profile of ["hermes-plugins", "codex-bridge"]) {
    const result = buildPlan({
      workspace,
      sourceRoot: repoRoot,
      packageVersion: manifest.packageVersion,
      manifest,
      verb: "install",
      agent: AGENT,
      profiles: [profile],
      platform: "linux",
    });

    assert.ok(result.actions.length > 0, `${profile} resolved to nothing`);
    for (const action of result.actions) {
      assert.equal(action.kind, "operator", `${profile}: ${action.id} is ${action.kind}`);
      assert.ok(action.operatorSteps?.length, `${profile}: ${action.id} carries no steps`);
    }
    assert.equal(result.summary.changes, 0, `${profile} must plan zero workspace changes`);
  }

  assert.equal(
    existsSync(join(workspace, ".ai")), false,
    "planning an operator profile must not create anything",
  );
});

test("no operator item declares a workspace target", () => {
  // The engine's central invariant is that it writes only inside the workspace.
  // Hermes profiles and user systemd units live outside it, which is precisely
  // why they are operator-applied — so they must never acquire a target that
  // would tempt a future strategy to write one.
  const manifest = loadManifest(repoRoot);
  for (const item of itemsForAgent(manifest, AGENT)) {
    if (item.consent !== "operator") continue;
    assert.equal(item.binding.target, null, `${item.id} declares a workspace target`);
    assert.equal(item.binding.strategy, "operator", `${item.id} is not an operator strategy`);
  }
});
