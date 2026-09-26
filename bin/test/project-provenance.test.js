import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hashText } from "../lib/state.js";
import { AI_STATE_REL_PATH, readProjectProvenance, classifyProjectFile, applyAcceptedProjectFiles, templateSource, requirePackageCatalogue } from "../lib/project-provenance.js";
import { recoverTransaction } from "../lib/transaction.js";

const roots = ["rules", "commands", "agent-prompts"];
function fixture(fn) {
  const workspace = mkdtempSync(join(tmpdir(), "af-provenance-"));
  try { return fn(workspace); } finally { rmSync(workspace, { recursive: true, force: true }); }
}
const template = templateSource("shared/evidence", "v1", "template body");
function accepted(workspace, root = "rules", source = template) {
  const path = `.ai/${root}/evidence.md`;
  const change = { path, source, evidence: ["README.md"], acceptedDecision: "accepted policy", accepted: true, adopt: true, content: "---\nfleet-template: shared/evidence\nfleet-source-version: v1\n---\nLocal adapted body\n" };
  if (source.origin === "repo-derived") change.content = "Local evidence-backed body\n";
  applyAcceptedProjectFiles({ workspace, changes: [change] });
  return change;
}

test("classification table across all three catalogues and both origins", () => {
  for (const root of roots) for (const origin of [template, { origin: "repo-derived" }]) {
    fixture((workspace) => {
      const change = accepted(workspace, root, origin);
      const classify = (overrides = {}) => classifyProjectFile({ workspace, ...change, ...overrides });
      const cases = [
        ["unchanged", {}, null],
        ["source-update", { source: origin.origin === "template" ? templateSource("shared/evidence", "v2", "new source") : origin, inputs: { newEvidence: true } }, null],
        ["local-edit", {}, "local modification"],
        ["conflict", { acceptedDecision: "updated policy" }, "local modification"],
      ];
      for (const [expected, args, edited] of cases) {
        writeFileSync(join(workspace, change.path), edited ?? change.content);
        assert.equal(classify(args).status, expected, `${root} ${origin.origin} ${expected}`);
      }
      assert.equal(classify({ source: origin, acceptedDecision: "accepted policy", snapshotAvailable: false }).snapshotAvailable, false);
      rmSync(join(workspace, change.path));
      assert.equal(classify().status, "deleted");
      assert.throws(() => applyAcceptedProjectFiles({ workspace, changes: [{ ...change, adopt: false }] }), /adoption or reconciliation/);
    });
  }
});

test("missing, corrupt, unrecorded and unknown template cannot silently overwrite", () => fixture((workspace) => {
  const path = ".ai/rules/evidence.md";
  assert.deepEqual(classifyProjectFile({ workspace, path, source: template }).status, "unknown");
  mkdirSync(join(workspace, ".ai/rules"), { recursive: true }); writeFileSync(join(workspace, path), "human-owned");
  assert.throws(() => applyAcceptedProjectFiles({ workspace, changes: [{ path, source: template, evidence: [], acceptedDecision: "yes", accepted: true, content: "replacement" }] }), /adoption or reconciliation/);
  const change = accepted(workspace);
  assert.equal(classifyProjectFile({ workspace, ...change, knownTemplate: false }).reason, "unknown-template");
  writeFileSync(join(workspace, AI_STATE_REL_PATH), "{broken");
  assert.equal(readProjectProvenance(workspace).status, "corrupt");
  assert.throws(() => applyAcceptedProjectFiles({ workspace, changes: [change] }), /corrupt/);
}));

test("unchanged rerun leaves bytes and sidecar untouched without generator", () => fixture((workspace) => {
  const change = accepted(workspace);
  const sidecar = readFileSync(join(workspace, AI_STATE_REL_PATH));
  const target = readFileSync(join(workspace, change.path));
  const result = applyAcceptedProjectFiles({ workspace, changes: [{ ...change, content: undefined, adopt: false }], generateContent: () => { throw new Error("generator invoked"); } });
  assert.equal(result.changed, false);
  assert.deepEqual(readFileSync(join(workspace, AI_STATE_REL_PATH)), sidecar);
  assert.deepEqual(readFileSync(join(workspace, change.path)), target);
  assert.equal(readProjectProvenance(workspace).state.entries[change.path].appliedHash, hashText(target));
}));

test("transaction rolls project files and sidecar back on failure and interruption", () => fixture((workspace) => {
  const first = accepted(workspace);
  const original = readFileSync(join(workspace, first.path));
  const sidecar = readFileSync(join(workspace, AI_STATE_REL_PATH));
  const second = { ...first, acceptedDecision: "new accepted choice", content: "new content", adopt: false };
  const extra = { ...first, path: ".ai/commands/new.md", content: "new command" };
  assert.throws(() => applyAcceptedProjectFiles({ workspace, changes: [second, extra], failAt: "after-commit" }), /injected/);
  assert.deepEqual(readFileSync(join(workspace, first.path)), original);
  assert.deepEqual(readFileSync(join(workspace, AI_STATE_REL_PATH)), sidecar);
  assert.equal(existsSync(join(workspace, extra.path)), false);
  assert.throws(() => applyAcceptedProjectFiles({ workspace, changes: [second], failAt: "after-journal" }), /injected/);
  assert.deepEqual(readFileSync(join(workspace, AI_STATE_REL_PATH)), sidecar);
  assert.equal(recoverTransaction(workspace), false);
}));

test("package catalogue is required at package root, without fallback to .pi", () => fixture((workspace) => {
  mkdirSync(join(workspace, ".pi/catalog/rules"), { recursive: true });
  assert.throws(() => requirePackageCatalogue(workspace), /missing catalog\/rules/);
  for (const root of roots) mkdirSync(join(workspace, "catalog", root), { recursive: true });
  assert.equal(requirePackageCatalogue(workspace), join(workspace, "catalog"));
}));

test("provenance is independent of install state and retained on uninstall", () => fixture((workspace) => {
  accepted(workspace);
  const before = readFileSync(join(workspace, AI_STATE_REL_PATH));
  // Installer cleanup removes only its own state and managed items, not project files or AI sidecar.
  assert.equal(existsSync(join(workspace, ".ai/agent-fleet-state.json")), false);
  assert.deepEqual(readFileSync(join(workspace, AI_STATE_REL_PATH)), before);
}));
