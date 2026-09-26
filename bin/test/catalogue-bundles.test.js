// T7 — bundles, docs policy, verification templates: routing + link integrity.
//
// Every catalogue file is reachable from its kind index, every relative link
// resolves, template ids are unique (no duplicated policy), and routing rows
// keep docs-only work free of implementation bundles.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, dirname, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const catalog = join(root, "catalog");
const text = (rel) => readFileSync(join(root, rel), "utf8");

function mdFiles(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) return mdFiles(abs, base);
    if (entry.name.endsWith(".md") && abs !== join(base, "README.md")) return [abs];
    return [];
  });
}

test("every catalogue entry is indexed and every index link resolves", () => {
  for (const kind of ["rules", "commands", "agent-prompts"]) {
    const kindDir = join(catalog, kind);
    const index = text(`catalog/${kind}/README.md`);
    for (const file of mdFiles(kindDir)) {
      const rel = file.slice(kindDir.length + 1).replace(/\\/g, "/");
      const esc = (s) => s.replace(/[./]/g, (c) => `\\${c}`);
      // A bundle sub-index is referenced by its directory, not its filename.
      const pattern = rel.endsWith("/README.md")
        ? esc(rel.slice(0, -"/README.md".length) + "/")
        : esc(rel);
      assert.match(index, new RegExp(pattern), `${kind} index lists ${rel}`);
    }
  }
  const linkRe = /\[([^\]]*)\]\(([^)#]+)(#[^)]*)?\)/g;
  for (const kind of ["rules", "commands", "agent-prompts"]) {
    const kindDir = join(catalog, kind);
    const check = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const abs = join(dir, entry.name);
        if (entry.isDirectory()) { check(abs); continue; }
        if (!entry.name.endsWith(".md")) continue;
        const body = readFileSync(abs, "utf8");
        for (const [, , target] of body.matchAll(linkRe)) {
          if (/^(https?:|mailto:)/.test(target)) continue;
          const resolved = normalize(join(dir, target));
          assert.ok(existsSync(resolved), `${abs}: link resolves: ${target}`);
        }
      }
    };
    check(kindDir);
  }
});

test("template ids are unique: no duplicated policy under two names", () => {
  const ids = new Map();
  const check = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) { check(abs); continue; }
      if (!entry.name.endsWith(".md") || entry.name === "README.md") continue;
      const match = readFileSync(abs, "utf8").match(/^---\nfleet-template: (\S+)\nfleet-source-version: (\S+)\n---\n/);
      assert.ok(match, `${abs} carries template frontmatter`);
      assert.ok(!ids.has(match[1]), `duplicate fleet-template: ${match[1]} in ${abs} and ${ids.get(match[1])}`);
      ids.set(match[1], abs);
    }
  };
  check(catalog);
});

test("routing keeps docs-only work free of implementation bundles", () => {
  const bundles = text("catalog/rules/bundles/README.md");
  assert.match(bundles, /Docs-only task/i);
  const docsRow = bundles.split("\n").find((line) => /docs-maintenance/i.test(line) && line.startsWith("|"));
  assert.ok(docsRow, "docs row exists");
  assert.doesNotMatch(docsRow, /csharp|javascript|sql|vue|boundaries/i, "docs-only row loads no implementation rules");
  assert.match(bundles, /before any diff/i, "planning without a diff is explicit");
  assert.match(bundles, /Monorepo/i, "monorepo routing is explicit");
  assert.match(text("catalog/rules/docs/docs-maintenance.md"), /explicit target decision|explicit local decision/i, "allowed types are decided, not prescribed");
  assert.match(text("catalog/rules/testing/verification-conventions.md"), /no second quality subsystem/i, "no duplicate quality ownership");
});
