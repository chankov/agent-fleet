// T10 — repository-ai-setup skill and /af-setup-rules prompt contract.
//
// The skill is prose plus references: it must route every deterministic effect
// (catalogue resolution, settings writes, provenance) to its owning mechanism
// and must never grow its own overrides merge algorithm.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const skillDir = join(root, "skills/repository-ai-setup");
const read = (path) => readFileSync(path, "utf8");
const skill = read(join(skillDir, "SKILL.md"));
const flow = read(join(skillDir, "references/setup-flow.md"));
const prompt = read(join(root, ".pi/prompts/af-setup-rules.md"));

test("skill, prompt, and helper references exist; catalogue is never duplicated", () => {
  assert.ok(existsSync(join(skillDir, "SKILL.md")), "SKILL.md exists");
  assert.ok(
    existsSync(join(skillDir, "references/setup-flow.md")),
    "setup-flow.md exists",
  );
  assert.ok(
    existsSync(join(skillDir, "references/provenance-template.md")),
    "provenance-template.md exists",
  );
  assert.ok(
    existsSync(join(root, ".pi/prompts/af-setup-rules.md")),
    "af-setup-rules.md exists",
  );
  assert.match(skill, /name:\s*repository-ai-setup/, "skill frontmatter names the skill");
  // npm-only catalogue: no second copy under .pi/ or inside the skill.
  assert.ok(!existsSync(join(root, ".pi/catalog")), "no catalogue copy under .pi/");
  assert.ok(
    !existsSync(join(skillDir, "references/catalog")),
    "no catalogue copy inside the skill",
  );
});

test("skill resolves the catalogue from the installed npm package payload", () => {
  assert.match(skill, /requirePackageCatalogue/, "uses the package catalogue resolver");
  assert.match(
    skill,
    /installed Fleet npm package/,
    "catalogue source is the installed package",
  );
  assert.match(skill, /never download/i, "forbids silent downloads");
});

test("skill has no overrides merge algorithm; settings go through the CLI", () => {
  assert.match(skill, /agent-fleet configure/, "hands settings to the CLI");
  assert.match(skill, /--dry-run/, "previews before applying");
  assert.match(skill, /--expect-hash/, "applies against the reviewed preview");
  assert.match(
    skill,
    /no overrides merge algorithm|never edits overrides/i,
    "disclaims its own merge path",
  );
  // Structural proof: the skill ships prose and data only — no executable
  // implementation that could hide a second merge writer.
  const shipped = readdirSync(skillDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
  assert.ok(
    shipped.every((name) => /\.(md|json)$/.test(name)),
    `skill ships prose/data only, found: ${shipped.join(", ")}`,
  );
  assert.match(flow, /no overrides merge algorithm/, "reference repeats the ban");
});

test("missing rules/docs paths warn and continue without failing setup", () => {
  assert.match(skill, /warn and continue/i, "warn-and-continue contract");
  assert.match(flow, /warn and continue/, "reference repeats warn-and-continue");
});

test("grilling is one question at a time with a recommendation", () => {
  for (const [name, text] of [["SKILL.md", skill], ["setup-flow.md", flow]]) {
    assert.match(text, /one question at a time/i, `${name}: single-question discipline`);
    assert.match(text, /recommendation/i, `${name}: orchestrator recommendation`);
  }
  assert.match(skill, /accepted \/ rejected \/ deferred/, "decisions are recorded");
  assert.match(skill, /zero-open/, "zero-open case is reported, not padded");
  assert.match(
    skill,
    /headless/i,
    "headless runs are limited to analysis/proposal",
  );
  assert.match(
    skill,
    /never simulate|no fake interview/i,
    "no simulated interview or auto-acceptance",
  );
});

test("change requests scope repeated runs without duplicate applies", () => {
  assert.match(skill, /change request/i, "optional change request");
  assert.match(prompt, /\$ARGUMENTS|change request/i, "prompt forwards the request");
  assert.match(skill, /no-op|no duplicates/i, "fulfilled repeats stay clean");
  assert.match(
    skill,
    /Existing explicit policy is preserved|preserved without redundant confirmation/i,
    "existing policy is reused, not re-asked",
  );
  assert.match(
    skill,
    /never normative|until the user explicitly accepts/i,
    "code-only patterns stay proposals until accepted",
  );
});

test("provenance goes through the sidecar and its owning library", () => {
  assert.match(skill, /\.ai\/agent-fleet-ai-state\.json/, "single sidecar");
  assert.match(skill, /bin\/lib\/project-provenance\.js/, "owning library");
  assert.match(skill, /appliedHash/, "hash classification, not file content");
  assert.match(
    skill,
    /preserved on uninstall|remains on uninstall/i,
    "sidecar survives uninstall",
  );
});

test("prompt is a thin adapter over the skill with a CLI handoff", () => {
  assert.match(
    prompt,
    /repository-ai-setup/,
    "prompt loads the repository-ai-setup skill",
  );
  assert.match(prompt, /live user|headless/i, "prompt states the live-user boundary");
  assert.match(
    prompt,
    /agent-fleet configure/,
    "prompt hands settings to the CLI, never edits overrides directly",
  );
  assert.match(prompt, /never edit/i, "prompt forbids direct overrides edits");
});

test("packaging delivers the skill and its command", () => {
  const manifest = JSON.parse(readFileSync(join(root, "install-manifest.json"), "utf8"));
  const ids = new Set(manifest.items.map((item) => item.id));
  assert.ok(ids.has("skill:repository-ai-setup"), "manifest installs the skill");
  assert.ok(ids.has("command:setup-rules"), "manifest installs /af-setup-rules");
});
