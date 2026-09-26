// T12 — native registration and package delivery.
//
// The setup capability is delivered without interview and without a second
// catalogue: the npm payload carries catalog/ + skill + prompt, the install
// manifest delivers the skill/command to workspaces, and no installer-owned
// item ever targets human-owned .ai/ content, sidecars, or adapters.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { requirePackageCatalogue } from "../lib/project-provenance.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(root, "install-manifest.json"), "utf8"));

test("npm payload carries the catalogue, the skill, and the prompt", () => {
  for (const dir of ["catalog/", "skills/", ".pi/prompts/"]) {
    assert.ok(pkg.files.includes(dir), `package files ship ${dir}`);
  }
  for (const entry of [
    "catalog/rules/architecture/repository-boundaries.md",
    "catalog/commands/assess-change-impact.md",
    "catalog/agent-prompts/requirements-author.md",
    "skills/repository-ai-setup/SKILL.md",
    "skills/repository-ai-setup/references/setup-flow.md",
    "skills/repository-ai-setup/references/apply-contract.md",
    ".pi/prompts/af-setup-rules.md",
  ]) {
    assert.ok(
      readFileSync(join(root, entry), "utf8").length > 0,
      `shipped surface exists: ${entry}`,
    );
  }
});

test("installed package resolves the catalogue with no source checkout", () => {
  // The installed Fleet npm package IS a directory carrying catalog/; the
  // resolver touches only that subtree, never sibling checkout paths.
  assert.equal(requirePackageCatalogue(root), join(root, "catalog"));
  const bare = mkdtempSync(join(tmpdir(), "af-bare-package-"));
  assert.throws(
    () => requirePackageCatalogue(bare),
    /missing catalog/,
    "setup is blocked without the packaged catalogue, never inferred",
  );
});

test("install manifest delivers the capability and owns no human content", () => {
  const ids = new Set(manifest.items.map((item) => item.id));
  assert.ok(ids.has("skill:repository-ai-setup"), "skill installs to workspaces");
  assert.ok(ids.has("command:setup-rules"), "slash command installs to workspaces");
  for (const item of manifest.items) {
    for (const agent of Object.values(item.agents ?? {})) {
      for (const target of [agent.target, ...(agent.legacyTargets ?? [])]) {
        assert.equal(
          typeof target === "string" && target.startsWith(".ai/"),
          false,
          `${item.id} must not own human content: ${target}`,
        );
      }
    }
  }
});

test("setup capability documents its own delivery dependencies", () => {
  const skill = readFileSync(join(root, "skills/repository-ai-setup/SKILL.md"), "utf8");
  assert.match(skill, /requirePackageCatalogue/, "skill resolves the packaged catalogue");
  assert.match(
    skill,
    /installed Fleet npm package/,
    "skill names the installed package as its catalogue source",
  );
});
