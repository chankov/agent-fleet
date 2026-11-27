// Retiring the 13 shipped personas for the three runtime roles (PLAN-11-01,
// Phase 3): what setup, doctor and uninstall do to a workspace a previous
// version installed, and the doctor's advisory scans for leftovers (D1, D2,
// D7, D22). The persona → role + practices mapping is read from the Hub's own
// table (roles.ts); nothing here or in bin/lib restates it.
//
// The historical record is the unaltered 2.0.5 installer output in
// fixtures/agent-fleet-2.0.5 — it records persona:builder, persona:code-reviewer
// and persona:test-engineer. It ships metadata only, so each test writes the
// recorded persona files itself and re-hashes the record to match, which is
// exactly what an unedited installed copy looks like.

import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runDoctor } from "../lib/doctor.js";
import { OVERRIDES_REL_PATH } from "../lib/validate-overrides.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cli = join(root, "bin", "cli.js");
const FIXTURE = join(root, "bin", "test", "fixtures", "agent-fleet-2.0.5", ".ai");
const RETIRED_RECORDED = ["builder", "code-reviewer", "test-engineer"];
const ROLES = ["editor", "researcher", "reviewer"];
const OVERRIDES = "# Team overrides\n\n## agent-hub\nlanguage: English\nmodel.builder: x/y\nthinking.planner: high\n";

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const run = (args) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
const visible = (models) => ({ models: models.map((model) => ({ model, ok: true, failed: [], reasons: [] })) });
const noDependencyFindings = () => ({ status: 0, stdout: "{}" });

function write(ws, rel, text) {
  mkdirSync(dirname(join(ws, rel)), { recursive: true });
  writeFileSync(join(ws, rel), text);
}

/**
 * A workspace a previous version set up with the default preset. `layout`
 * picks where it put the personas: `agents/` (2.0.5, as the fixture records)
 * or `.pi/agents/personas/` (2.0.14 and later). builder.md carries a local
 * edit; my-own.md is a definition the installer never recorded.
 */
function historicalWorkspace(layout) {
  const ws = mkdtempSync(join(tmpdir(), `af-retired-${layout}-`));
  cpSync(FIXTURE, join(ws, ".ai"), { recursive: true });
  const statePath = join(ws, ".ai", "agent-fleet-state.json");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(state.packageVersion, "2.0.5", "the fixture is the published 2.0.5 record");
  for (const name of RETIRED_RECORDED) {
    const rel = layout === "agents" ? `agents/${name}.md` : `.pi/agents/personas/${name}.md`;
    const shipped = `---\nname: ${name}\ndescription: shipped ${name}\nmodel: x/y\n---\nShipped ${name}.\n`;
    write(ws, rel, name === "builder" ? `${shipped}\nMy local edit.\n` : shipped);
    state.items[`persona:${name}`].files = [{ path: rel, mode: "copy", sha256: sha256(shipped) }];
  }
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  write(ws, ".pi/agents/personas/my-own.md", "---\nname: my-own\ndescription: mine\n---\nMine.\n");
  write(ws, OVERRIDES_REL_PATH, OVERRIDES);
  return ws;
}

for (const layout of ["agents", "personas"]) {
  const dir = layout === "agents" ? "agents" : ".pi/agents/personas";

  test(`setup on a 2.0.5 record (${dir}/) retires unedited persona copies, keeps the edited and foreign ones, installs the roles`, async (t) => {
    const ws = historicalWorkspace(layout);
    t.after(() => rmSync(ws, { recursive: true, force: true }));

    // The 2.0.5 desired file still names the retired codex-remote feature, so a
    // preview stops at the separate config repair; the approved run does both.
    const preview = JSON.parse(run(["setup", "--workspace", ws, "--dry-run", "--json"]).stdout);
    assert.equal(preview.stage, "config-repair-preview");

    const result = run(["setup", "--workspace", ws, "--repair-config", "--yes", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const applied = JSON.parse(result.stdout);
    const byId = Object.fromEntries(applied.results.map((entry) => [entry.id, entry]));
    for (const role of ROLES) assert.equal(byId[`persona:${role}`]?.status, "applied", role);
    for (const name of RETIRED_RECORDED) assert.equal(byId[`persona:${name}`]?.status, "removed", name);
    assert.match(byId["persona:builder"].detail, new RegExp(`kept 1 user-modified path\\(s\\): ${dir.replace(/[./]/g, "\\$&")}/builder\\.md`));

    assert.equal(existsSync(join(ws, dir, "code-reviewer.md")), false, "an unedited installed copy is retired");
    assert.equal(existsSync(join(ws, dir, "test-engineer.md")), false, "an unedited installed copy is retired");
    assert.match(readFileSync(join(ws, dir, "builder.md"), "utf8"), /My local edit\./, "an edited copy is kept");
    assert.ok(existsSync(join(ws, ".pi/agents/personas/my-own.md")), "an unrecorded definition is never touched");
    for (const role of ROLES) {
      assert.equal(readFileSync(join(ws, `.pi/agents/personas/${role}.md`), "utf8"), readFileSync(join(root, "agents", `${role}.md`), "utf8"), role);
    }
    const state = JSON.parse(readFileSync(join(ws, ".ai", "agent-fleet-state.json"), "utf8"));
    assert.deepEqual(Object.keys(state.items).filter((id) => id.startsWith("persona:")).sort(), ROLES.map((role) => `persona:${role}`));
    assert.equal(readFileSync(join(ws, OVERRIDES_REL_PATH), "utf8"), OVERRIDES, "setup never touches the overrides (D22)");

    // Doctor reports what setup left for the human, and changes none of it.
    const findings = await runDoctor({ workspace: ws, sourceRoot: root, checkVisibility: visible, checkDependencies: noDependencyFindings });
    const leftover = findings.filter((f) => f.type === "retired-persona");
    assert.deepEqual(leftover.map((f) => f.path), [`${dir}/builder.md`]);
    assert.match(leftover[0].issue, /"builder" is a retired persona.*agent "editor" with practices \["implementation"\]/);
    assert.match(leftover[0].fix, /delete it by hand; doctor never deletes it/, "no longer recorded: the edited copy is the user's");
    const keys = findings.filter((f) => f.type === "overrides");
    assert.deepEqual(keys.map((f) => [f.path, f.replacement ?? null]), [
      [`${OVERRIDES_REL_PATH}:5`, "model.editor.implementation"],
      [`${OVERRIDES_REL_PATH}:6`, null],
    ]);
    assert.match(keys[1].fix, /editor with practices \[planning\] for a saved plan; or researcher with practices \[planning\] for advice/);
    assert.ok(existsSync(join(ws, dir, "builder.md")));
    assert.equal(readFileSync(join(ws, OVERRIDES_REL_PATH), "utf8"), OVERRIDES);

    // A second setup has nothing left to migrate.
    const again = JSON.parse(run(["setup", "--workspace", ws, "--dry-run", "--json"]).stdout);
    assert.equal(again.actions.some((action) => /^persona:/.test(action.id) && action.kind !== "keep"), false, JSON.stringify(again.actions.filter((action) => /^persona:/.test(action.id))));
  });
}

test("uninstall refuses a role the Hub still needs, and --all leaves the user's definitions", (t) => {
  const ws = historicalWorkspace("personas");
  t.after(() => rmSync(ws, { recursive: true, force: true }));
  assert.equal(run(["setup", "--workspace", ws, "--repair-config", "--yes", "--json"]).status, 0);

  const single = run(["uninstall", "--workspace", ws, "--items", "persona:editor", "--dry-run", "--json"]);
  assert.equal(single.status, 0, single.stderr);
  const plan = JSON.parse(single.stdout).plan ?? JSON.parse(single.stdout);
  assert.ok(plan.notes.some((note) => note.type === "pinned" && /persona:editor is kept — still required by pi-harness:agent-hub/.test(note.detail)), JSON.stringify(plan.notes));
  assert.equal(plan.actions.some((action) => action.kind === "remove"), false);

  const all = run(["uninstall", "--workspace", ws, "--all", "--yes", "--json"]);
  assert.equal(all.status, 0, all.stderr);
  for (const role of ROLES) assert.equal(existsSync(join(ws, `.pi/agents/personas/${role}.md`)), false, role);
  assert.ok(existsSync(join(ws, ".pi/agents/personas/builder.md")), "the kept edited copy is not ours to remove");
  assert.ok(existsSync(join(ws, ".pi/agents/personas/my-own.md")));
  assert.equal(readFileSync(join(ws, OVERRIDES_REL_PATH), "utf8"), OVERRIDES);
});

test("a clean setup installs the debate skill the Hub requires, and uninstall keeps it while the Hub stays (D28)", (t) => {
  const ws = mkdtempSync(join(tmpdir(), "af-debate-skill-"));
  t.after(() => rmSync(ws, { recursive: true, force: true }));
  const setup = run(["setup", "--workspace", ws, "--yes", "--json"]);
  assert.equal(setup.status, 0, setup.stderr);
  const byId = Object.fromEntries(JSON.parse(setup.stdout).results.map((entry) => [entry.id, entry]));
  assert.equal(byId["pi-harness:agent-hub"]?.status, "applied");
  assert.equal(byId["skill:debate"]?.status, "applied");
  assert.equal(readFileSync(join(ws, ".pi/skills/debate/SKILL.md"), "utf8"), readFileSync(join(root, "skills/debate/SKILL.md"), "utf8"));

  const single = run(["uninstall", "--workspace", ws, "--items", "skill:debate", "--dry-run", "--json"]);
  assert.equal(single.status, 0, single.stderr);
  const plan = JSON.parse(single.stdout).plan ?? JSON.parse(single.stdout);
  assert.ok(plan.notes.some((note) => note.type === "pinned" && /skill:debate is kept — still required by pi-harness:agent-hub/.test(note.detail)), JSON.stringify(plan.notes));
  assert.equal(plan.actions.some((action) => action.kind === "remove"), false);
  assert.ok(existsSync(join(ws, ".pi/skills/debate/SKILL.md")));
});

// ── doctor scans ─────────────────────────────────────────────────────────────

function workspaceWith(files) {
  const ws = mkdtempSync(join(tmpdir(), "af-retired-scan-"));
  for (const [rel, text] of Object.entries(files)) write(ws, rel, text);
  return ws;
}

const definition = (name) => `---\nname: ${name}\ndescription: d\nmodel: x/y\n---\nBody.\n`;

test("doctor reports a retired persona definition in every agent directory, by the name the Hub reads", async (t) => {
  const ws = workspaceWith({
    "agents/builder.md": definition("builder"),
    ".claude/agents/planner.md": definition("planner"),
    ".pi/agents/personas/code-reviewer.md": definition("code-reviewer"),
    ".pi/agents/bowser.md": definition("bowser"),
    // The frontmatter name decides, as it does for the Hub.
    "agents/old-docs.md": definition("documenter"),
    "agents/test-engineer.md": definition("editor"),
    // Roles and user-owned names are not leftovers.
    "agents/editor.md": definition("editor"),
    ".pi/agents/personas/my-own.md": definition("my-own"),
    ".ai/agent-fleet-state.json": JSON.stringify({
      schemaVersion: 2,
      items: { "persona:code-reviewer": { kind: "persona", files: [{ path: ".pi/agents/personas/code-reviewer.md", mode: "copy", sha256: sha256(definition("code-reviewer")) }] } },
    }),
  });
  t.after(() => rmSync(ws, { recursive: true, force: true }));
  // A dangling link is the broken-symlink scan's, not a second finding here.
  symlinkSync(join(ws, "missing", "web-debugger.md"), join(ws, "agents", "web-debugger.md"));

  const findings = await runDoctor({ workspace: ws, sourceRoot: root, checkVisibility: visible, checkDependencies: noDependencyFindings });
  const retired = findings.filter((f) => f.type === "retired-persona");
  assert.deepEqual(retired.map((f) => [f.path, f.persona]).sort(), [
    [".claude/agents/planner.md", "planner"],
    [".pi/agents/bowser.md", "bowser"],
    [".pi/agents/personas/code-reviewer.md", "code-reviewer"],
    ["agents/builder.md", "builder"],
    ["agents/old-docs.md", "documenter"],
  ]);
  for (const f of retired) {
    assert.equal(f.classification, "advisory");
    assert.match(f.issue, /is a retired persona and is no longer dispatched\. Dispatch a role with practices instead: .*The Hub ignores this definition file\./);
  }
  const byPath = Object.fromEntries(retired.map((f) => [f.path, f]));
  assert.match(byPath[".claude/agents/planner.md"].issue, /agent "editor" with practices \["planning"\] for a saved plan; or agent "researcher" with practices \["planning"\] for advice/);
  assert.match(byPath[".pi/agents/personas/code-reviewer.md"].fix, /^run agent-fleet setup to retire it/, "a recorded copy is the installer's to retire");
  assert.match(byPath["agents/builder.md"].fix, /agents\/researcher\.md, agents\/reviewer\.md, agents\/editor\.md\), then delete it by hand; doctor never deletes it/);
  assert.ok(findings.some((f) => f.type === "broken-symlink" && f.path === "agents/web-debugger.md"));

  const applied = await runDoctor({ workspace: ws, sourceRoot: root, apply: true, checkVisibility: visible, checkDependencies: noDependencyFindings });
  assert.equal(applied.skipped, 0);
  for (const rel of ["agents/builder.md", ".claude/agents/planner.md", ".pi/agents/personas/code-reviewer.md", ".pi/agents/bowser.md", "agents/old-docs.md"]) {
    assert.ok(existsSync(join(ws, rel)), `doctor --fix never deletes ${rel}`);
  }
});

test("doctor reports model-profiles.yaml keys that name a retired persona, with the line and the mapping", async (t) => {
  const profiles = [
    "mix:",
    "  builder: p/a",
    "  code-reviewer.security: p/b",
    "  planner: p/c",
    "  editor.planning: p/d",
    "full:",
    "  version: 2",
    "  defaults: { model: p/a }",
    "  agents:",
    "    deep-researcher: p/a",
    "    reviewer: p/a",
    "  subagents:",
    "    builder:",
    "      recon: p/a",
    "    test-engineer:",
    "      verifier: p/a",
    "",
  ].join("\n");
  const ws = workspaceWith({ ".pi/agents/model-profiles.yaml": profiles });
  t.after(() => rmSync(ws, { recursive: true, force: true }));
  const findings = (await runDoctor({ workspace: ws, sourceRoot: root, checkVisibility: visible, checkDependencies: noDependencyFindings }))
    .filter((f) => f.type === "yaml-shape");
  assert.deepEqual(findings.map((f) => [f.path, f.issue.replace(/ names the retired.*/, "")]), [
    [".pi/agents/model-profiles.yaml:2", 'profile "mix" key "builder"'],
    [".pi/agents/model-profiles.yaml:3", 'profile "mix" key "code-reviewer.security"'],
    [".pi/agents/model-profiles.yaml:4", 'profile "mix" key "planner"'],
    [".pi/agents/model-profiles.yaml:10", 'profile "full" agents: key "deep-researcher"'],
    [".pi/agents/model-profiles.yaml:13", 'profile "full" subagents: key "builder"'],
    [".pi/agents/model-profiles.yaml:15", 'profile "full" subagents: key "test-engineer"'],
  ]);
  const fixes = findings.map((f) => f.fix);
  assert.match(fixes[0], /^rename the key to "editor\.implementation" \(editor with practices \[implementation\]/);
  assert.match(fixes[1], /^rename the key to "reviewer\.security"/);
  assert.match(fixes[2], /pick the one you meant and rename by hand to <role>\.<practice>: editor with practices \[planning\] for a saved plan; or researcher/);
  assert.match(fixes[3], /^rename the key to "researcher\.research"/);
  assert.match(fixes[4], /^rename the key to "editor"/);
  assert.match(fixes[5], /rename by hand to <role>: editor with practices \[testing\] for test changes; or reviewer/);
  assert.equal(readFileSync(join(ws, ".pi/agents/model-profiles.yaml"), "utf8"), profiles);
});

test("the shipped model profiles name no retired persona", async (t) => {
  const ws = workspaceWith({ ".pi/agents/model-profiles.yaml": readFileSync(join(root, ".pi/agents/model-profiles.yaml"), "utf8") });
  t.after(() => rmSync(ws, { recursive: true, force: true }));
  const findings = await runDoctor({ workspace: ws, sourceRoot: root, checkVisibility: visible, checkDependencies: noDependencyFindings });
  assert.deepEqual(findings.filter((f) => f.type === "yaml-shape" || f.type === "retired-persona"), []);
});
