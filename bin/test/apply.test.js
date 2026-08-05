// apply.test.js — the only module that writes to a workspace.
//
// The assertions that matter here are the negative ones: what apply() must NOT
// do. Writing files correctly is easy to eyeball; deleting the wrong thing,
// clobbering a user's settings key, or escaping the workspace is not, and each
// has a test below.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync,
  lstatSync, realpathSync, rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { buildPlan } from "../lib/plan.js";
import { applyPlan } from "../lib/apply.js";
import { runVerify, hasDrift } from "../lib/verify.js";
import { loadManifest } from "../lib/manifest.js";
import { readState, walkTree } from "../lib/state.js";
import { extractRegion } from "../lib/merge-forms.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const AGENT = "pi";
const VERSION = "1.1.0";

// ── synthetic world ─────────────────────────────────────────────────────────

const tmp = (label) => mkdtempSync(join(tmpdir(), `af-apply-${label}-`));

// Symlink mode exists only inside an agent-fleet checkout, so a test of symlink
// mode has to be one. The marker is the package name, same as in production.
function checkout(label) {
  const root = tmp(label);
  write(root, "package.json", JSON.stringify({ name: "@chankov/agent-fleet" }));
  return root;
}

function write(root, rel, text) {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
  return path;
}

function makeSource() {
  const root = tmp("src");
  write(root, "skills/alpha/SKILL.md", "alpha v2\n");
  write(root, "skills/alpha/notes.md", "notes\n");
  write(root, "skills/beta/SKILL.md", "beta v1\n");
  write(root, ".versions/1.0.0/skills/alpha/SKILL.md", "alpha v1\n");
  write(root, ".versions/1.0.0/skills/alpha/notes.md", "notes\n");
  write(root, ".versions/1.0.0/skills/beta/SKILL.md", "beta v1\n");
  write(
    root,
    "justfile",
    "# >>> agent-fleet:harnesses — managed >>>\nfleet:\n\techo fleet\n# <<< agent-fleet:harnesses <<<\n",
  );
  write(root, "hooks/hooks.json", JSON.stringify({ hooks: { SessionStart: [{ cmd: "ours" }] } }, null, 2));
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

function makeManifest(extra = []) {
  const skill = (name) => item(`skill:${name}`, {
    agents: {
      [AGENT]: {
        source: [`skills/${name}`], sourceMode: "first",
        target: `.pi/skills/${name}`, strategy: "copy-tree",
      },
    },
  });
  return {
    schemaVersion: 1,
    packageVersion: VERSION,
    groups: [{ id: "skills", title: "Skills", order: 1, agents: [AGENT] }],
    profiles: { all: { title: "all", rule: "all" } },
    items: [skill("alpha"), skill("beta"), ...extra],
  };
}

/** plan + apply in one step, the way the CLI does it. */
function run(opts) {
  const { manifest, allowExec = false, ...planOpts } = opts;
  const plan = buildPlan({ packageVersion: VERSION, agent: AGENT, manifest, allowExec, ...planOpts });
  const applied = applyPlan({ plan, manifest, allowExec, now: () => "2026-01-01T00:00:00.000Z" });
  return { plan, applied };
}

function read(root, rel) {
  return readFileSync(join(root, rel), "utf8");
}

// ── install ─────────────────────────────────────────────────────────────────

test("install writes the files, the state, and the human record", () => {
  const sourceRoot = makeSource();
  const workspace = tmp("ws");
  const { applied } = run({ workspace, sourceRoot, manifest: makeManifest(), profiles: ["all"] });

  assert.equal(read(workspace, ".pi/skills/alpha/SKILL.md"), "alpha v2\n");
  assert.equal(read(workspace, ".pi/skills/alpha/notes.md"), "notes\n");
  assert.equal(applied.summary.failed, 0);

  const state = readState(workspace);
  assert.equal(state.agent, AGENT);
  assert.equal(state.packageVersion, VERSION);
  assert.equal(state.items["skill:alpha"].files.length, 2);
  assert.ok(state.items["skill:alpha"].files.every((f) => f.sha256));

  const record = read(workspace, ".ai/agent-fleet-setup.md");
  assert.match(record, /^version: 1\.1\.0$/m, "the record must carry the version an older reader looks for");
  assert.match(record, /^agent:\s+pi$/m);
  assert.match(record, /skills:\s+\[alpha, beta\]/);
});

test("install twice changes nothing the second time", () => {
  const sourceRoot = makeSource();
  const workspace = tmp("ws");
  const manifest = makeManifest();

  run({ workspace, sourceRoot, manifest, profiles: ["all"] });
  const second = buildPlan({
    workspace, sourceRoot, packageVersion: VERSION, manifest, agent: AGENT, profiles: ["all"],
  });

  assert.equal(second.summary.changes, 0);
  assert.equal(second.summary.keep, 2);
});

test("install then verify reports a clean workspace", async () => {
  const sourceRoot = makeSource();
  const workspace = tmp("ws");
  const manifest = makeManifest();
  run({ workspace, sourceRoot, manifest, profiles: ["all"] });

  const report = await runVerify({
    workspace, sourceRoot, packageVersion: VERSION, manifest, agent: AGENT, includeDoctor: false,
  });

  assert.equal(hasDrift(report), false);
  assert.equal(report.summary.broken, 0);
  assert.equal(report.summary.installed, 2);
});

test("symlink method links to source and records the target", () => {
  const sourceRoot = makeSource();
  const workspace = checkout("ws");
  run({ workspace, sourceRoot, manifest: makeManifest(), profiles: ["all"], method: "symlink" });

  const link = join(workspace, ".pi/skills/alpha");
  assert.ok(lstatSync(link).isSymbolicLink());
  assert.equal(realpathSync(link), realpathSync(join(sourceRoot, "skills/alpha")));

  const recorded = readState(workspace).items["skill:alpha"].files[0];
  assert.equal(recorded.mode, "symlink");
  assert.ok(!recorded.sha256, "a link has no content of its own to hash");
});

test("switching copy → symlink replaces the directory cleanly", () => {
  const sourceRoot = makeSource();
  const workspace = checkout("ws");
  const manifest = makeManifest();

  run({ workspace, sourceRoot, manifest, profiles: ["all"] });
  assert.ok(!lstatSync(join(workspace, ".pi/skills/alpha")).isSymbolicLink());

  run({ workspace, sourceRoot, manifest, items: ["skill:alpha"], method: "symlink" });
  assert.ok(lstatSync(join(workspace, ".pi/skills/alpha")).isSymbolicLink());
});

test("a pre-existing identical copy is adopted, not rewritten", () => {
  const sourceRoot = makeSource();
  const workspace = tmp("ws");
  write(workspace, ".pi/skills/alpha/SKILL.md", "alpha v2\n");
  write(workspace, ".pi/skills/alpha/notes.md", "notes\n");

  const { applied } = run({ workspace, sourceRoot, manifest: makeManifest(), items: ["skill:alpha"] });
  const result = applied.results.find((r) => r.id === "skill:alpha");

  assert.equal(result.status, "adopted");
  assert.ok(readState(workspace).items["skill:alpha"], "adoption must record ownership");
});

// ── the two shared-file forms ───────────────────────────────────────────────

test("a managed region leaves the user's own lines alone", () => {
  const sourceRoot = makeSource();
  const workspace = tmp("ws");
  write(workspace, "justfile", "my-recipe:\n\techo mine\n");
  const manifest = makeManifest([item("companion:justfile-region", {
    kind: "companion",
    agents: { [AGENT]: { source: ["justfile"], sourceMode: "first", target: "justfile", strategy: "managed-region" } },
  })]);

  run({ workspace, sourceRoot, manifest, items: ["companion:justfile-region"] });
  const after = read(workspace, "justfile");

  assert.match(after, /my-recipe:/, "user recipes must survive");
  assert.match(after, /echo fleet/, "the managed region must be present");
  assert.equal(
    extractRegion(after).block,
    extractRegion(read(sourceRoot, "justfile")).block,
    "the installed region must be byte-identical to the source region",
  );
});

test("a managed region is stable across re-application", () => {
  const sourceRoot = makeSource();
  const workspace = tmp("ws");
  write(workspace, "justfile", "my-recipe:\n\techo mine\n");
  const manifest = makeManifest([item("companion:justfile-region", {
    kind: "companion",
    agents: { [AGENT]: { source: ["justfile"], sourceMode: "first", target: "justfile", strategy: "managed-region" } },
  })]);

  run({ workspace, sourceRoot, manifest, items: ["companion:justfile-region"] });
  const once = read(workspace, "justfile");
  const second = buildPlan({
    workspace, sourceRoot, packageVersion: VERSION, manifest, agent: AGENT,
    items: ["companion:justfile-region"],
  });

  assert.equal(second.summary.changes, 0, "a region at EOF must not read as drift on re-run");
  run({ workspace, sourceRoot, manifest, items: ["companion:justfile-region"] });
  assert.equal(read(workspace, "justfile"), once, "re-applying must not grow the file");
});

test("json-merge sets only its own keys", () => {
  const sourceRoot = makeSource();
  const workspace = tmp("ws");
  write(workspace, "settings.json", JSON.stringify({
    permissions: { allow: ["Bash(ls:*)"] },
    hooks: { Stop: [{ cmd: "theirs" }] },
  }, null, 2));
  const manifest = makeManifest([item("companion:settings", {
    kind: "companion",
    agents: { [AGENT]: { source: ["hooks/hooks.json"], sourceMode: "first", target: "settings.json", strategy: "json-merge" } },
  })]);

  run({ workspace, sourceRoot, manifest, items: ["companion:settings"] });
  const after = JSON.parse(read(workspace, "settings.json"));

  assert.deepEqual(after.permissions, { allow: ["Bash(ls:*)"] }, "unrelated keys are untouched");
  assert.deepEqual(after.hooks.Stop, [{ cmd: "theirs" }], "sibling hooks are untouched");
  assert.deepEqual(after.hooks.SessionStart, [{ cmd: "ours" }]);

  const recorded = readState(workspace).items["companion:settings"].jsonKeys;
  assert.deepEqual(recorded.map((k) => k.keyPath), ["hooks.SessionStart"]);
});

test("json-merge refuses to overwrite a file it cannot parse", () => {
  const sourceRoot = makeSource();
  const workspace = tmp("ws");
  write(workspace, "settings.json", "{ not json");
  const manifest = makeManifest([item("companion:settings", {
    kind: "companion",
    agents: { [AGENT]: { source: ["hooks/hooks.json"], sourceMode: "first", target: "settings.json", strategy: "json-merge" } },
  })]);

  const { applied } = run({ workspace, sourceRoot, manifest, items: ["companion:settings"] });

  assert.equal(applied.summary.failed, 1);
  assert.match(applied.failure.detail, /not valid JSON/);
  assert.equal(read(workspace, "settings.json"), "{ not json", "the unparseable file is left as it was");
});

// ── conflicts ───────────────────────────────────────────────────────────────

test("a conflict writes .new and leaves the original untouched", () => {
  const sourceRoot = makeSource();
  const workspace = tmp("ws");
  const manifest = makeManifest();

  // installed at 1.0.0, source moved to v2, and the user edited it
  run({ workspace, sourceRoot, manifest, items: ["skill:alpha"] });
  const state = readState(workspace);
  state.packageVersion = "1.0.0";
  state.items["skill:alpha"].files = state.items["skill:alpha"].files.map((f) =>
    f.path.endsWith("SKILL.md")
      ? { ...f, sha256: "0".repeat(64) }   // pretend it was installed at v1
      : f);
  writeFileSync(join(workspace, ".ai/agent-fleet-state.json"), JSON.stringify(state, null, 2));
  write(workspace, ".pi/skills/alpha/SKILL.md", "my own text\n");

  const { plan, applied } = run({ workspace, sourceRoot, manifest, verb: "upgrade" });

  assert.equal(plan.conflicts.length, 1);
  assert.equal(read(workspace, ".pi/skills/alpha/SKILL.md"), "my own text\n", "the original must survive");
  assert.equal(read(workspace, ".pi/skills/alpha/SKILL.md.new"), "alpha v2\n", "the incoming version lands beside it");
  assert.deepEqual(applied.conflictFiles, [".pi/skills/alpha/SKILL.md.new"]);
});

// ── removal ─────────────────────────────────────────────────────────────────

test("removal deletes only what is recorded and unmodified", () => {
  const sourceRoot = makeSource();
  const workspace = tmp("ws");
  const manifest = makeManifest();
  run({ workspace, sourceRoot, manifest, profiles: ["all"] });

  // the user edits one of beta's files, then beta leaves the catalogue
  write(workspace, ".pi/skills/beta/SKILL.md", "I changed this\n");
  const shrunk = { ...manifest, items: manifest.items.filter((i) => i.id !== "skill:beta") };
  const { applied } = run({ workspace, sourceRoot, manifest: shrunk, verb: "upgrade" });

  assert.equal(read(workspace, ".pi/skills/beta/SKILL.md"), "I changed this\n", "a user-edited file is never deleted");
  const result = applied.results.find((r) => r.id === "skill:beta");
  assert.equal(result.status, "removed");
  assert.match(result.detail, /kept 1 user-modified/);
  assert.equal(readState(workspace).items["skill:beta"], undefined, "ownership is dropped either way");
});

test("removal never touches a path the state does not record", () => {
  const sourceRoot = makeSource();
  const workspace = tmp("ws");
  const manifest = makeManifest();
  run({ workspace, sourceRoot, manifest, items: ["skill:alpha"] });

  write(workspace, ".pi/skills/beta/SKILL.md", "not ours\n");
  const shrunk = { ...manifest, items: manifest.items.filter((i) => i.id !== "skill:beta") };
  run({ workspace, sourceRoot, manifest: shrunk, verb: "upgrade" });

  assert.ok(existsSync(join(workspace, ".pi/skills/beta/SKILL.md")), "an unrecorded path is not ours to delete");
});

// ── safety ──────────────────────────────────────────────────────────────────

test("a target escaping the workspace is refused", () => {
  const sourceRoot = makeSource();
  const workspace = tmp("ws");
  const manifest = makeManifest([item("skill:evil", {
    agents: { [AGENT]: { source: ["skills/beta"], sourceMode: "first", target: "../escaped", strategy: "copy-tree" } },
  })]);

  const { applied } = run({ workspace, sourceRoot, manifest, items: ["skill:evil"] });

  assert.equal(applied.summary.failed, 1);
  assert.match(applied.failure.detail, /outside the workspace/);
  assert.ok(!existsSync(join(workspace, "..", "escaped")));
});

test("exec runs only when permitted, and a failure stops the pass", () => {
  const sourceRoot = makeSource();
  const execItem = (args) => item("companion:cmd", {
    kind: "companion", consent: "exec",
    agents: { [AGENT]: { source: [], sourceMode: "first", target: null, strategy: "exec" } },
    exec: { command: process.execPath, args, cwd: "." },
  });

  const gated = run({
    workspace: tmp("ws"), sourceRoot,
    manifest: makeManifest([execItem(["-e", "process.exit(0)"])]),
    items: ["companion:cmd"],
  });
  assert.equal(gated.applied.results.find((r) => r.id === "companion:cmd").status, "skipped");

  const ok = run({
    workspace: tmp("ws"), sourceRoot,
    manifest: makeManifest([execItem(["-e", "process.exit(0)"])]),
    items: ["companion:cmd"], allowExec: true,
  });
  assert.equal(ok.applied.results.find((r) => r.id === "companion:cmd").status, "applied");

  const workspace = tmp("ws");
  const bad = run({
    workspace, sourceRoot,
    manifest: makeManifest([execItem(["-e", "process.exit(2)"])]),
    profiles: ["all"], items: ["companion:cmd"], allowExec: true,
  });
  assert.equal(bad.applied.summary.failed, 1);
  assert.ok(readState(workspace), "the state file is written even when the pass fails");
  assert.ok(
    readState(workspace).items["skill:alpha"],
    "work completed before the failure stays recorded",
  );
});

test("exec sorts after every file action", () => {
  const sourceRoot = makeSource();
  const manifest = makeManifest([item("companion:cmd", {
    kind: "companion", consent: "exec", parents: ["skill:alpha"],
    agents: { [AGENT]: { source: [], sourceMode: "first", target: null, strategy: "exec" } },
    exec: { command: process.execPath, args: ["-e", ""], cwd: "." },
  })]);

  const plan = buildPlan({
    workspace: tmp("ws"), sourceRoot, packageVersion: VERSION, manifest,
    agent: AGENT, profiles: ["all"], items: ["companion:cmd"], allowExec: true,
  });
  const kinds = plan.actions.map((a) => a.kind);

  assert.equal(kinds[kinds.length - 1], "exec", "a command must see the finished tree");
});

test("the state file stores no secret-shaped values", () => {
  const sourceRoot = makeSource();
  const workspace = tmp("ws");
  run({ workspace, sourceRoot, manifest: makeManifest(), profiles: ["all"] });

  const raw = read(workspace, ".ai/agent-fleet-state.json");
  // sha256 digests are legitimately 64-hex; anything else long and opaque is not.
  for (const candidate of raw.match(/"[A-Za-z0-9+/_-]{40,}"/g) ?? []) {
    const value = candidate.slice(1, -1);
    assert.ok(
      /^[0-9a-f]{64}$/.test(value) || value.includes("/"),
      `unexpected opaque value in the state file: ${value.slice(0, 24)}…`,
    );
  }
  assert.doesNotMatch(raw, /sk-[A-Za-z0-9]/);
});

// ── against the real package ────────────────────────────────────────────────

test("real manifest: install pi/recommended, verify clean, re-plan empty", async () => {
  const workspace = tmp("real-pi");
  const manifest = loadManifest(repoRoot);
  const common = {
    workspace, sourceRoot: repoRoot, packageVersion: manifest.packageVersion,
    manifest, agent: "pi", platform: "linux",
  };

  const plan = buildPlan({ ...common, profiles: ["recommended"] });
  const applied = applyPlan({ plan, manifest });

  assert.equal(applied.summary.failed, 0, applied.failure?.detail ?? "");
  assert.ok(applied.summary.applied > 15, "the recommended profile is not empty");
  assert.ok(existsSync(join(workspace, ".pi/skills/test-driven-development/SKILL.md")));
  assert.ok(existsSync(join(workspace, ".pi/prompts/af-build.md")));
  assert.ok(existsSync(join(workspace, "agents/builder.md")));

  const report = await runVerify({ ...common, includeDoctor: false });
  assert.equal(hasDrift(report), false, "a fresh install must verify clean");

  const again = buildPlan({ ...common, profiles: ["recommended"] });
  assert.equal(again.summary.changes, 0, "installing twice must be a no-op");
});

test("real manifest: a persona installs as a verbatim copy of the canonical file", () => {
  const workspace = tmp("real-persona");
  const manifest = loadManifest(repoRoot);
  const plan = buildPlan({
    workspace, sourceRoot: repoRoot, packageVersion: manifest.packageVersion,
    manifest, agent: "pi", items: ["persona:code-reviewer"], platform: "linux",
  });
  applyPlan({ plan, manifest });

  const installed = read(workspace, "agents/code-reviewer.md");
  const canonical = readFileSync(join(repoRoot, "agents/code-reviewer.md"), "utf8");

  // agents/*.md is written in pi's own dialect, so there is nothing to
  // translate — install is a copy, and the state records it as one.
  assert.equal(installed, canonical);
  assert.equal(readState(workspace).items["persona:code-reviewer"].files[0].mode, "copy");
});

test("real manifest: a fresh install leaves no stray files behind", () => {
  const workspace = tmp("real-clean");
  const manifest = loadManifest(repoRoot);
  const plan = buildPlan({
    workspace, sourceRoot: repoRoot, packageVersion: manifest.packageVersion,
    manifest, agent: "pi", profiles: ["minimal"], platform: "linux",
  });
  applyPlan({ plan, manifest });

  const recorded = new Set(
    Object.values(readState(workspace).items).flatMap((e) => (e.files ?? []).map((f) => f.path)),
  );
  const onDisk = walkTree(workspace).filter((p) => !p.startsWith(".ai/"));

  assert.deepEqual(
    onDisk.filter((p) => !recorded.has(p)),
    [],
    "every file written must be recorded, or removal can never reclaim it",
  );
  rmSync(workspace, { recursive: true, force: true });
});
