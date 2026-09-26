import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requirePackageCatalogue } from "../lib/project-provenance.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const catalog = requirePackageCatalogue(root);
const text = (path) => readFileSync(join(catalog, path), "utf8");
const fixture = JSON.parse(readFileSync(join(root, "bin/test/fixtures/minimal-catalogue-adaptation.json"), "utf8"));

// The fixture is intentionally not a path substitution: document policy, entry points,
// consumers and proposed code-only policy all differ from the source examples.
test("minimal catalogue is indexed and requires semantic adaptation", () => {
  const entries = [
    ["rules", "architecture/repository-boundaries.md"],
    ["commands", "assess-change-impact.md"],
    ["agent-prompts", "requirements-author.md"],
  ];
  for (const [kind, name] of entries) {
    assert.match(text(`${kind}/README.md`), new RegExp(name.replace(".", "\\.")));
    const body = text(`${kind}/${name}`);
    assert.match(body, /^---\nfleet-template: [a-z-]+\nfleet-source-version: 1\n---\n/);
    assert.doesNotMatch(body, /RIN\.|Presentation\/|META_PRD\.md|router\.js|\.get\(/);
  }
  assert.match(text("commands/assess-change-impact.md"), /agent-prompts/);
  assert.match(text("agent-prompts/requirements-author.md"), /existing specification skill/);
  assert.match(text("rules/architecture/repository-boundaries.md"), /observed code as evidence/);
  assert.match(fixture.adaptationRequired.command, /queue publish to worker\/retry/);
  assert.match(fixture.adaptationRequired.prompt, /ask before creating a new PRD type/);
  assert.match(fixture.repoDerivedCandidate.beforeAcceptance, /proposal only; no normative/);
  assert.match(fixture.repoDerivedCandidate.afterAcceptance, /origin repo-derived with no invented templateId/);
  assert.ok(!existsSync(join(root, "skills/repository-ai-setup/references/catalog")));
});
