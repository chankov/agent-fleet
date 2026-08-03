// symlink-retirement.test.js — symlink installs are checkout-only now.
//
// A symlink install only works where the source is meant to be edited in place.
// Anywhere else the link target has to stay put forever: an npx cache clean
// breaks every link at once, and a `git pull` in the source silently rewrites
// artifacts the workspace never agreed to change. So `--method symlink` is
// refused outside an agent-fleet checkout, and a workspace that recorded it
// before the restriction is migrated to copies rather than left half-supported.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, lstatSync, existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildPlan } from "../lib/plan.js";
import { applyPlan } from "../lib/apply.js";
import { readState, isAgentFleetCheckout } from "../lib/state.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = join(repoRoot, "bin", "cli.js");
const AGENT = "pi";
const VERSION = "1.0.0";

const tmp = (label) => mkdtempSync(join(tmpdir(), `af-symlink-${label}-`));

function write(root, rel, text) {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
  return path;
}

function makeSource() {
  const root = tmp("src");
  write(root, "skills/alpha/SKILL.md", "alpha v1\n");
  return root;
}

function makeManifest() {
  return {
    schemaVersion: 1,
    packageVersion: VERSION,
    groups: [{ id: "skills", title: "Skills", order: 1, agents: [AGENT] }],
    profiles: { full: { title: "all", rule: "all" } },
    items: [{
      id: "skill:alpha", kind: "skill", group: "skills", subcategory: null,
      title: "alpha", summary: "", recommended: false, consent: "file",
      platform: "any", companions: [], requires: [],
      agents: {
        [AGENT]: {
          source: ["skills/alpha"], sourceMode: "first",
          target: ".pi/skills/alpha", strategy: "copy-tree",
        },
      },
    }],
  };
}

/** A workspace that is an agent-fleet checkout — the one place symlinks live. */
function checkout() {
  const root = tmp("ws");
  write(root, "package.json", JSON.stringify({ name: "@chankov/agent-fleet" }));
  return root;
}

function plan(workspace, sourceRoot, manifest, opts = {}) {
  return buildPlan({
    workspace, sourceRoot, packageVersion: VERSION, manifest,
    verb: "install", agent: AGENT, profiles: ["full"], ...opts,
  });
}

// ── the gate ────────────────────────────────────────────────────────────────

test("isAgentFleetCheckout keys off the package name, not the path", () => {
  const plain = tmp("plain");
  assert.equal(isAgentFleetCheckout(plain), false, "an empty directory is not a checkout");

  write(plain, "package.json", JSON.stringify({ name: "someone-elses-project" }));
  assert.equal(isAgentFleetCheckout(plain), false);

  write(plain, "package.json", JSON.stringify({ name: "@chankov/agent-fleet" }));
  assert.equal(isAgentFleetCheckout(plain), true);

  write(plain, "package.json", "{ not json");
  assert.equal(isAgentFleetCheckout(plain), false, "unreadable must not read as a checkout");

  assert.equal(isAgentFleetCheckout(repoRoot), true, "this repo is the case the mode exists for");
});

test("the planner downgrades a symlink request outside a checkout", () => {
  const sourceRoot = makeSource();
  const workspace = tmp("ws");

  const result = plan(workspace, sourceRoot, makeManifest(), { method: "symlink" });
  assert.equal(result.method, "copy");
  assert.ok(result.notes.some((n) => n.type === "symlink-retired"));
});

test("the planner honours symlink inside a checkout", () => {
  const sourceRoot = makeSource();
  const workspace = checkout();

  const result = plan(workspace, sourceRoot, makeManifest(), { method: "symlink" });
  assert.equal(result.method, "symlink");
  assert.equal(result.notes.some((n) => n.type === "symlink-retired"), false);

  applyPlan({ plan: result, manifest: makeManifest() });
  assert.ok(lstatSync(join(workspace, ".pi/skills/alpha")).isSymbolicLink());
});

// ── migration ───────────────────────────────────────────────────────────────

test("a recorded symlink install is re-materialised as copies on the next run", () => {
  const sourceRoot = makeSource();
  const manifest = makeManifest();

  // Install the way an older version would have: as a checkout, with symlinks.
  const workspace = checkout();
  applyPlan({ plan: plan(workspace, sourceRoot, manifest, { method: "symlink" }), manifest });
  assert.ok(lstatSync(join(workspace, ".pi/skills/alpha")).isSymbolicLink());
  assert.equal(readState(workspace).method, "symlink");

  // Now it is an ordinary project — the checkout marker is gone.
  write(workspace, "package.json", JSON.stringify({ name: "someone-elses-project" }));

  // No --method flag at all: the recorded `symlink` must not be honoured.
  const migration = plan(workspace, sourceRoot, manifest);
  assert.equal(migration.method, "copy");
  assert.equal(migration.actions.find((a) => a.id === "skill:alpha").kind, "refresh");

  applyPlan({ plan: migration, manifest });
  const target = join(workspace, ".pi/skills/alpha");
  assert.equal(lstatSync(target).isSymbolicLink(), false, "still a link after migration");
  assert.equal(readFileSync(join(target, "SKILL.md"), "utf8"), "alpha v1\n");
  assert.equal(readState(workspace).method, "copy");
  assert.equal(readState(workspace).items["skill:alpha"].files[0].mode, "copy");
});

test("upgrade migrates too — it is the verb most people will hit", () => {
  const sourceRoot = makeSource();
  const manifest = makeManifest();
  const workspace = checkout();

  applyPlan({ plan: plan(workspace, sourceRoot, manifest, { method: "symlink" }), manifest });
  write(workspace, "package.json", JSON.stringify({ name: "someone-elses-project" }));

  const upgrade = buildPlan({
    workspace, sourceRoot, packageVersion: VERSION, manifest, verb: "upgrade", agent: AGENT,
  });
  assert.equal(upgrade.method, "copy");
  applyPlan({ plan: upgrade, manifest });
  assert.equal(lstatSync(join(workspace, ".pi/skills/alpha")).isSymbolicLink(), false);
});

// ── the CLI surface ─────────────────────────────────────────────────────────

const cli = (args, cwd = repoRoot) =>
  spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });

test("the CLI refuses an explicit --method symlink outside a checkout", () => {
  const workspace = tmp("cli");
  mkdirSync(join(workspace, ".pi"), { recursive: true });
  // `update` refuses a workspace with no install record before it ever looks at
  // --method, so give it one — the point here is the method check, not that.
  write(workspace, ".ai/agent-fleet-setup.md", "## workspace-summary\nagent: pi\nversion: 0.0.1\n");

  for (const verb of ["install", "init", "update"]) {
    const args = verb === "install"
      ? ["install", "--workspace", workspace, "--agent", AGENT, "--profile", "minimal", "--method", "symlink", "--dry-run"]
      : [verb, "--workspace", workspace, "--agent", AGENT, "--method", "symlink", "--dry-run"];
    const run = cli(args);
    assert.equal(run.status, 1, `${verb} should have refused: ${run.stdout}`);
    assert.match(run.stderr, /only inside an agent-fleet checkout/, verb);
  }
});

test("--method is gone from the help text of every verb that used to offer it", () => {
  for (const verb of ["init", "install", "upgrade", "update"]) {
    const help = cli([verb, "--help"]).stdout;
    assert.doesNotMatch(
      help, /^\s+--method </m,
      `${verb} --help still advertises --method as an option`,
    );
  }
});

test("a plain install with no flags produces copies, not links", () => {
  const workspace = tmp("cli-copy");
  const run = cli(["install", "--workspace", workspace, "--agent", AGENT, "--profile", "minimal", "--yes"]);
  assert.equal(run.status, 0, run.stderr);

  const state = readState(workspace);
  assert.equal(state.method, "copy");
  for (const entry of Object.values(state.items)) {
    for (const file of entry.files ?? []) {
      assert.notEqual(file.mode, "symlink", `${file.path} was linked`);
      assert.ok(existsSync(join(workspace, file.path)));
    }
  }
});
