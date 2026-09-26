// T14 — contrasting repositories and the Rankedin adoption case.
//
// Minimal repo, multi-area repo, and Rankedin-like overrides (docs without
// rules:) run through the real scanner/validator contracts: no foreign stack
// defaults, local content preserved, full catalogue resolved from the package.
// Actual Rankedin apply stays a separate authorized target operation — this
// file proves the detection, never performs that apply.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { scanProject } from "../lib/scan.js";
import { validateOverrides, OVERRIDES_REL_PATH } from "../lib/validate-overrides.js";
import { requirePackageCatalogue } from "../lib/project-provenance.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
function workspace(files = {}) {
  const ws = mkdtempSync(join(tmpdir(), "af-contrast-"));
  for (const [rel, content] of Object.entries(files)) {
    const path = join(ws, rel);
    if (content === true) mkdirSync(path, { recursive: true });
    else {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    }
  }
  return ws;
}

test("minimal repo: empty discovery, silent validator, no normative output", () => {
  const ws = workspace({ "package.json": "{}\n", "README.md": "# minimal\n" });
  try {
    const scan = scanProject(ws);
    assert.deepEqual(scan.rules, [], "no rule candidates invented");
    assert.deepEqual(validateOverrides({ workspace: ws, env: {} }), [], "nothing configured, nothing flagged");
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("multi-root repo: every candidate surfaces, selection stays per area", () => {
  const ws = workspace({
    ".ai/rules/README.md": "# ai index\n",
    "rules/README.md": "# legacy index\n",
    "docs/README.md": "# docs\n",
  });
  try {
    const scan = scanProject(ws);
    assert.ok(scan.rules.includes(".ai/rules"), "primary root discovered");
    assert.ok(scan.rules.includes("rules"), "second root discovered, none imposed");
    const bundles = readFileSyncSafe("catalog/rules/bundles/README.md");
    assert.match(bundles, /Monorepo/i, "monorepo routing stays explicit");
    assert.match(bundles, /affected area only/i, "one stack is never imposed on all packages");
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

function readFileSyncSafe(rel) {
  return readFileSync(join(root, rel), "utf8");
}

test("Rankedin-like overrides: missing rules root is a proposal, not an error", () => {
  const ws = workspace({
    [OVERRIDES_REL_PATH]: "## agent-hub\ndocs: README.md\n",
    "README.md": "# guide\n",
    ".ai/rules/shared/repo-boundaries.md": "# local rule\n",
  });
  try {
    // Absent key falls back to default: the validator flags nothing…
    assert.deepEqual(validateOverrides({ workspace: ws, env: {} }), []);
    // …while the scanner surfaces the on-disk candidate for a proposal.
    const scan = scanProject(ws);
    assert.ok(scan.rules.includes(".ai/rules"), "unconfigured .ai/rules is discovered as a candidate");
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("full catalogue resolves from the package with no new install surface", () => {
  const catalog = requirePackageCatalogue(root);
  const entries = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.name.endsWith(".md") && entry.name !== "README.md") entries.push(abs);
    }
  };
  walk(catalog);
  assert.ok(entries.length >= 10, `expanded catalogue ships, found ${entries.length} entries`);
  const manifest = JSON.parse(readFileSyncSafe("install-manifest.json"));
  const owned = manifest.items.flatMap((item) =>
    Object.values(item.agents ?? {}).flatMap((agent) => [agent.target, ...(agent.legacyTargets ?? [])]),
  );
  assert.equal(owned.some((target) => typeof target === "string" && target.startsWith(".ai/")), false);
});
