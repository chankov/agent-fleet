// T9 — only admitted portable commands ship: required inputs,
// target/capability discovery, one done-when; no universal estimates,
// no SQL clearing, no provider procedures; exclusions documented.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const text = (rel) => readFileSync(join(root, rel), "utf8");
const commands = [
  "catalog/commands/assess-change-impact.md",
  "catalog/commands/audit-documentation.md",
];

test("shipped commands declare inputs, discovery, and one done-when", () => {
  for (const rel of commands) {
    assert.ok(existsSync(join(root, rel)), `${rel} exists`);
    const body = text(rel);
    assert.match(body, /^---\nfleet-template: [a-z-]+\nfleet-source-version: 1\n---\n/);
    assert.match(body, /Inputs:/, "required inputs declared");
    assert.match(body, /discover|trace inbound|establish .* from/i, "target/capability discovery");
    assert.match(body, /## Output and done when/i, "single done-when");
  }
});

test("no project/provider procedure ships in v1", () => {
  for (const rel of commands) {
    const body = text(rel);
    assert.doesNotMatch(body, /story points?/i, `${rel}: no universal estimates`);
    assert.doesNotMatch(body, /clearing|DACPAC|Worktrunk|Azure DevOps/i, `${rel}: no project operations`);
  }
});

test("command exclusions are documented in the index", () => {
  const index = text("catalog/commands/README.md");
  for (const excluded of ["translation entry creation", "story-point", "version bumping", "worktree", "database operations", "sprint procedures", "translation-update inventory"]) {
    assert.match(index, new RegExp(excluded), `exclusion documented: ${excluded}`);
  }
});

test("translation entry command is not shipped", () => {
  assert.equal(existsSync(join(root, "catalog/commands/add-translation.md")), false);
  assert.doesNotMatch(text("catalog/commands/README.md"), /\]\(add-translation\.md\)/);
});
