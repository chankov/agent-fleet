// T8 — reusable task prompts under the admission gate: bounded scope, rules
// references, output/done-when; no persona router, no fixed timeout
// confirmation, no model default; provenance frontmatter valid.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const text = (rel) => readFileSync(join(root, rel), "utf8");
const prompts = [
  "catalog/agent-prompts/requirements-author.md",
  "catalog/agent-prompts/architecture-decision-author.md",
];

test("shipped prompts carry valid provenance and reuse skills by reference", () => {
  for (const rel of prompts) {
    assert.ok(existsSync(join(root, rel)), `${rel} exists`);
    const body = text(rel);
    assert.match(body, /^---\nfleet-template: [a-z-]+\nfleet-source-version: 1\n---\n/);
    assert.match(body, /## (Context|Workflow)/, "bounded task structure");
    assert.match(body, /## (Boundaries|Output and done when)/i, "boundaries and done-when");
    assert.match(body, /existing \w+ skill/i, "reuses a Fleet skill instead of copying its workflow");
    assert.match(body, /by reference/i, "used by reference, not registered");
  }
  assert.match(
    text("catalog/agent-prompts/architecture-decision-author.md"),
    /Disposition: include/,
    "adaptation disposition retained",
  );
});

test("prompts route no personas, fix no timeouts, set no model defaults", () => {
  for (const rel of prompts) {
    const body = text(rel);
    assert.doesNotMatch(body, /you are a router|route (this|the|work) to|invoke the \w+ persona|delegate to (another|an? \w+ )?persona|spawn a \w+ agent to/i, `${rel}: no router`);
    assert.doesNotMatch(body, /five-minute|5-minute|five minute/i, `${rel}: no fixed confirmation`);
    assert.doesNotMatch(body, /default.*[Cc]laude|Claude.*default/i, `${rel}: no model default`);
    assert.doesNotMatch(body, /reveal .{0,30}reasoning|show .{0,20}chain-of-thought/i, `${rel}: no reasoning disclosure`);
  }
  const adr = text("catalog/agent-prompts/architecture-decision-author.md");
  assert.match(adr, /actual diff/i, "binds the real change, not a fixed branch/date");
  assert.doesNotMatch(adr, /master|2025-08/, "no fixed branch or date from the source");
});

test("admission exclusions are documented, not silently dropped", () => {
  const index = text("catalog/agent-prompts/README.md");
  for (const excluded of ["requirements-author", "meta-agent", "orchestrator", "operations"]) {
    assert.match(index, new RegExp(excluded), `exclusion rationale names: ${excluded}`);
  }
});
