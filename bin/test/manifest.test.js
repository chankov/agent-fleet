// Tests for the generated install manifest (Phase 1 of the deterministic installer).
//
// The manifest is generated from the tree, so these tests are the drift guard:
// a new skill/persona/command/extension/harness landing in the repo without a
// regenerated manifest must fail here, not silently vanish from the menu.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import {
  buildManifest,
  serializeManifest,
  validateManifest,
  loadManifest,
  loadSnapshotManifest,
  loadMeta,
  itemsForAgent,
  resolveSelection,
  MANIFEST_AGENTS,
  MANIFEST_FILE,
  MANIFEST_SCHEMA_VERSION,
} from "../lib/manifest.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const manifest = loadManifest(root);
const meta = loadMeta(root);
const ids = new Set(manifest.items.map((i) => i.id));

function dirsIn(rel) {
  const dir = join(root, rel);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() || e.isSymbolicLink())
    .map((e) => e.name);
}

function filesIn(rel) {
  const dir = join(root, rel);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);
}

// ── generation ──────────────────────────────────────────────────────────────

test("committed manifest matches a fresh regeneration", () => {
  const rebuilt = serializeManifest(
    buildManifest({ sourceRoot: root, packageVersion: pkg.version }),
  );
  assert.equal(
    readFileSync(join(root, MANIFEST_FILE), "utf8"),
    rebuilt,
    `${MANIFEST_FILE} is stale — run \`node bin/build-manifest.js\``,
  );
});

test("build is deterministic across repeated runs", () => {
  const a = serializeManifest(buildManifest({ sourceRoot: root, packageVersion: "9.9.9" }));
  const b = serializeManifest(buildManifest({ sourceRoot: root, packageVersion: "9.9.9" }));
  assert.equal(a, b);
});

test("manifest is stamped with the package version and schema version", () => {
  assert.equal(manifest.packageVersion, pkg.version);
  assert.equal(manifest.schemaVersion, MANIFEST_SCHEMA_VERSION);
});

// ── validation ──────────────────────────────────────────────────────────────

test("manifest validates against the source tree", () => {
  assert.deepEqual(validateManifest(manifest, { sourceRoot: root }), []);
});

test("schema-v1 snapshots normalize in memory while current manifests require v2", () => {
  for (const version of ["0.0.10", "0.0.11"]) {
    const snapshot = loadSnapshotManifest(join(root, ".versions", version));
    assert.equal(snapshot.schemaVersion, 2);
    assert.equal(typeof snapshot.presets, "object");
    assert.equal(typeof snapshot.features, "object");
    assert.ok(snapshot.items.every((item) => typeof item.stability === "string"));
  }
  assert.equal(loadSnapshotManifest(join(root, ".versions", "0.0.9")), null, "pre-manifest source snapshots remain usable bases");
});

test("v2 validation rejects invalid preset/feature references, cycles, and stability", () => {
  const broken = structuredClone(manifest);
  broken.presets.default.items.push("missing:item");
  broken.features.voice.requiresFeatures = ["missing-feature"];
  broken.features.hermes.requiresFeatures = ["telegram"];
  broken.items[0].stability = "unsafe";
  const problems = validateManifest(broken);
  assert.ok(problems.some((problem) => problem.includes("preset default: unknown item")));
  assert.ok(problems.some((problem) => problem.includes("unknown feature dependency")));
  assert.ok(problems.some((problem) => problem.includes("feature dependency cycle")));
  assert.ok(problems.some((problem) => problem.includes("invalid stability")));
});

test("validation catches a broken manifest", () => {
  const broken = structuredClone(manifest);
  broken.items[0].agents[Object.keys(broken.items[0].agents)[0]].source = ["does/not/exist"];
  broken.items[1].id = broken.items[0].id;
  const problems = validateManifest(broken, { sourceRoot: root });
  assert.ok(problems.some((p) => p.includes("does not exist")));
  assert.ok(problems.some((p) => p.includes("duplicate id")));
});

test("item ids are unique", () => {
  assert.equal(ids.size, manifest.items.length);
});

// ── coverage: nothing in the tree is silently missing ───────────────────────

test("every skill in either catalogue root has an item", () => {
  const excluded = new Set(meta.exclude.skills);
  const roots = ["skills", join("vendor", "agent-skills-upstream", "skills")];
  for (const skillRoot of roots) {
    for (const name of dirsIn(skillRoot)) {
      if (excluded.has(name)) continue;
      if (!existsSync(join(root, skillRoot, name, "SKILL.md"))) continue;
      assert.ok(ids.has(`skill:${name}`), `skill "${name}" (${skillRoot}) has no manifest item`);
    }
  }
});

test("every canonical persona has an item", () => {
  for (const file of filesIn("agents")) {
    if (!file.endsWith(".md")) continue;
    const name = file.slice(0, -3);
    assert.ok(ids.has(`persona:${name}`), `persona "${name}" has no manifest item`);
  }
});

test("every command source file has an item", () => {
  const excluded = new Set(meta.exclude.commands);
  const sources = [
    [".pi/prompts", "af-"],
  ];
  for (const [dir, prefix] of sources) {
    for (const file of filesIn(dir)) {
      if (!file.endsWith(".md")) continue;
      const base = file.slice(0, -3);
      if (prefix && !base.startsWith(prefix)) continue;
      const name = prefix ? base.slice(prefix.length) : base;
      if (excluded.has(name)) continue;
      assert.ok(ids.has(`command:${name}`), `command "${name}" (${dir}) has no manifest item`);
    }
  }
});

test("every reference, hook, pi tree, and hermes artifact has an item", () => {
  for (const file of filesIn("references")) {
    if (file.endsWith(".md")) assert.ok(ids.has(`reference:${file.slice(0, -3)}`), file);
  }
  const excludedHooks = new Set(meta.exclude.hooks);
  for (const file of filesIn("hooks")) {
    if (!/\.(sh|mjs)$/.test(file) || excludedHooks.has(file)) continue;
    assert.ok(ids.has(`hook:${file.replace(/\.(sh|mjs)$/, "")}`), file);
  }
  for (const name of dirsIn(".pi/extensions")) {
    if (name === "node_modules") continue;
    assert.ok(ids.has(`pi-extension:${name}`), name);
  }
  for (const name of dirsIn(".pi/harnesses")) {
    if (name === "node_modules" || meta.exclude.piHarnesses.includes(name)) continue;
    assert.ok(ids.has(`pi-harness:${name}`), name);
  }
  for (const name of dirsIn(".pi/skills")) {
    assert.ok(ids.has(`pi-runtime-skill:${name}`), name);
  }
  for (const name of [...dirsIn("hermes/plugins"), ...dirsIn("hermes/desktop-plugins")]) {
    assert.ok(ids.has(`hermes-plugin:${name}`), name);
  }
  for (const name of dirsIn("hermes/skills")) {
    assert.ok(ids.has(`hermes-skill:${name}`), name);
  }
});

test("installer-only artifacts are never offered", () => {
  for (const name of ["_internal"]) {
    assert.ok(!ids.has(`skill:${name}`), `${name} must stay installer-only`);
  }
  for (const name of ["setup-agent-fleet", "doctor-agent-fleet"]) {
    assert.ok(!ids.has(`command:${name}`), `${name} must stay installer-only`);
  }
});

// ── per-agent rules ─────────────────────────────────────────────────────────

test("command sources never cross agents", () => {
  const dirFor = { "pi": ".pi/prompts/af-" };
  for (const item of manifest.items.filter((i) => i.kind === "command")) {
    for (const [agent, binding] of Object.entries(item.agents)) {
      assert.ok(
        binding.source[0].startsWith(dirFor[agent]),
        `${item.id} (${agent}) sources from ${binding.source[0]}`,
      );
      assert.equal(binding.source[0], binding.target);
    }
  }
});

test("every persona is offered, including the ones coupled to the pi runtime", () => {
  for (const name of ["bowser", "web-debugger", "orchestrator", "code-reviewer"]) {
    const item = manifest.items.find((i) => i.id === `persona:${name}`);
    assert.deepEqual(Object.keys(item.agents), [...MANIFEST_AGENTS], name);
  }
});

test("personas are copied verbatim — agents/*.md is already pi's own dialect", () => {
  const item = manifest.items.find((i) => i.id === "persona:builder");
  assert.deepEqual(Object.keys(item.agents), ["pi"]);
  assert.equal(item.agents["pi"].strategy, "copy-file");
  assert.equal(item.agents["pi"].target, "agents/builder.md");
});

test("native skills shadow the vendored upstream copy", () => {
  const item = manifest.items.find((i) => i.id === "skill:code-review-and-quality");
  assert.equal(item.agents.pi.source[0], "skills/code-review-and-quality");
  assert.ok(item.agents.pi.source[1].startsWith("vendor/"));

  const vendorOnly = manifest.items.find((i) => i.id === "skill:test-driven-development");
  assert.ok(vendorOnly.agents.pi.source[0].startsWith("vendor/"));
  assert.equal(vendorOnly.agents.pi.source.length, 1);
});

test("pi extensions, harnesses, and runtime skills are pi-only", () => {
  for (const item of manifest.items) {
    if (!item.kind.startsWith("pi-")) continue;
    assert.deepEqual(Object.keys(item.agents), ["pi"], item.id);
  }
});

test("every item binds to pi and nothing else", () => {
  for (const item of manifest.items) {
    assert.deepEqual(Object.keys(item.agents), ["pi"], item.id);
  }
});

test("references install under .pi/, and each one is pulled in by a citing skill", () => {
  const refs = manifest.items.filter((i) => i.kind === "reference");
  assert.ok(refs.length > 0, "no reference items in the manifest");
  for (const item of refs) {
    assert.ok(
      item.agents.pi.target.startsWith(".pi/references/"),
      `${item.id} installs outside .pi/references/`,
    );
    // A reference nobody cites is dead weight — the parent back-refs are what
    // make it travel with its skill instead of being a standalone menu row.
    assert.ok((item.parents ?? []).length > 0, `${item.id} has no citing parent`);
  }
});

test("the coms bridge hook installs where Claude Code reads it", () => {
  // Claude Code is a coms peer, never an install target — but the pane running
  // it is a Claude Code process, so its Stop hook has to land in .claude/.
  const hook = manifest.items.find((i) => i.id === "hook:coms-stop-hook");
  assert.equal(hook.group, "coms-bridge");
  assert.deepEqual(Object.keys(hook.agents), ["pi"]);
  assert.equal(hook.agents.pi.target, ".claude/hooks/coms-stop-hook.mjs");
});

// ── consent boundary ────────────────────────────────────────────────────────

test("operator-consent items declare no workspace target", () => {
  for (const item of manifest.items.filter((i) => i.consent === "operator")) {
    for (const binding of Object.values(item.agents)) {
      assert.equal(binding.target, null, `${item.id} declares a workspace target`);
    }
  }
});

test("exec items declare their command and nothing else runs commands", () => {
  for (const item of manifest.items) {
    if (item.exec) {
      assert.equal(item.consent, "exec", item.id);
      assert.ok(item.exec.command && Array.isArray(item.exec.args), item.id);
    }
    if (item.consent === "exec") assert.ok(item.exec, `${item.id} has no exec block`);
  }
});

test("hermes and codex artifacts stay operator-gated", () => {
  for (const item of manifest.items) {
    if (["hermes-plugin", "hermes-skill", "codex"].includes(item.kind)) {
      assert.equal(item.consent, "operator", item.id);
    }
  }
});

// ── selection ───────────────────────────────────────────────────────────────

test("visible presets have deterministic valid roots", () => {
  assert.deepEqual(Object.keys(manifest.presets), ["default", "full", "minimal"]);
  for (const preset of Object.values(manifest.presets)) {
    for (const id of preset.items ?? []) assert.ok(ids.has(id), id);
  }
  assert.equal(manifest.features.browser.items.includes("pi-skill:bowser"), false);
  assert.ok(manifest.features.browser.items.includes("pi-runtime-skill:bowser"));
});

test("every profile resolves without unknown ids for every agent", () => {
  for (const agent of MANIFEST_AGENTS) {
    for (const name of Object.keys(manifest.profiles)) {
      const { unknown } = resolveSelection(manifest, agent, { profiles: [name] });
      // Profile items bound to another agent are legitimately unavailable —
      // only a truly unknown id (typo, retired artifact) is a failure.
      for (const id of unknown) {
        assert.ok(ids.has(id), `profile "${name}" (${agent}) references unknown id ${id}`);
      }
    }
  }
});

test("selection pulls in requires and companions", () => {
  const { selected } = resolveSelection(manifest, "pi", { items: ["skill:spec-driven-development"] });
  assert.ok(selected.includes("companion:skills-internal-grilling"));

  const hub = resolveSelection(manifest, "pi", { items: ["pi-harness:agent-hub"] });
  assert.ok(hub.selected.includes("pi-harness:damage-control-continue"), "agent-hub must pull its safety child");
  assert.ok(hub.selected.includes("companion:justfile-region"));
});

test("the recommended profile is non-empty for every agent", () => {
  for (const agent of MANIFEST_AGENTS) {
    const { selected } = resolveSelection(manifest, agent, { profiles: ["recommended"] });
    assert.ok(selected.length >= 10, `${agent} recommended set is suspiciously small (${selected.length})`);
  }
});

test("itemsForAgent only returns items bound to that agent", () => {
  for (const agent of MANIFEST_AGENTS) {
    for (const item of itemsForAgent(manifest, agent)) {
      assert.ok(item.binding, `${item.id} has no resolved binding`);
      assert.equal(item.binding, item.agents[agent]);
    }
  }
});

// ── packaging ───────────────────────────────────────────────────────────────

test("the manifest and its meta ship in the package and the version snapshot", () => {
  assert.ok(pkg.files.includes(MANIFEST_FILE), `package.json files must include ${MANIFEST_FILE}`);
  const snapshot = readFileSync(join(root, "bin", "snapshot-version.js"), "utf8");
  assert.ok(
    snapshot.includes(`"${MANIFEST_FILE}"`),
    "snapshot-version.js must snapshot the manifest — upgrade needs a per-version base catalogue",
  );
});
