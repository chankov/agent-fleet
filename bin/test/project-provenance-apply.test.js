// T11 — generate and update target files using recorded provenance.
//
// Behavioral contract over the existing deterministic machinery
// (bin/lib/project-provenance.js + transaction.js, merge-forms.js regions):
// prompted add/change preserves unrelated content, conflicts reconcile
// explicitly, repeats add no duplicates, stale previews and interruptions
// stay visible. No new transaction subsystem, no settings merge here.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  AI_STATE_REL_PATH,
  classifyProjectFile,
  applyAcceptedProjectFiles,
  templateSource,
} from "../lib/project-provenance.js";
import { extractRegion, replaceRegion } from "../lib/merge-forms.js";

function fixture(fn) {
  const workspace = mkdtempSync(join(tmpdir(), "af-apply-"));
  try { return fn(workspace); } finally { rmSync(workspace, { recursive: true, force: true }); }
}
const template = (version = "v1", body = "template body") =>
  templateSource("shared/evidence", version, body);
const RULE = ".ai/rules/evidence.md";
const CMD = ".ai/commands/assess.md";
const ruleContent = (extra = "") =>
  `---\nfleet-template: shared/evidence\nfleet-source-version: v1\n---\nAdapted rule body\n${extra}`;
const sidecar = (workspace) =>
  JSON.parse(readFileSync(join(workspace, AI_STATE_REL_PATH), "utf8")).entries;

test("prompted add and change preserve unrelated files and record only applied files", () =>
  fixture((workspace) => {
    const unrelated = ".ai/rules/untouched.md";
    mkdirSync(join(workspace, ".ai/rules"), { recursive: true });
    writeFileSync(join(workspace, unrelated), "human-owned\n");
    const before = readFileSync(join(workspace, unrelated), "utf8");
    const first = applyAcceptedProjectFiles({
      workspace,
      changes: [{
        path: RULE, source: template(), evidence: ["README.md"],
        acceptedDecision: "adopt evidence rule", accepted: true, adopt: true,
        content: ruleContent(),
      }],
    });
    assert.equal(first.changed, true);
    const second = applyAcceptedProjectFiles({
      workspace,
      changes: [{
        path: CMD, source: { origin: "repo-derived" }, evidence: ["src/queue.js"],
        acceptedDecision: "accept queue-derived command", accepted: true, adopt: true,
        content: "Queue publish command\n",
      }],
    });
    assert.equal(second.changed, true);
    assert.equal(readFileSync(join(workspace, unrelated), "utf8"), before);
    assert.deepEqual(Object.keys(sidecar(workspace)).sort(), [CMD, RULE]);
  }));

test("conflict reconciles explicitly and keeps accepted local lines", () =>
  fixture((workspace) => {
    applyAcceptedProjectFiles({
      workspace,
      changes: [{
        path: RULE, source: template(), evidence: ["README.md"],
        acceptedDecision: "adopt evidence rule", accepted: true, adopt: true,
        content: ruleContent(),
      }],
    });
    writeFileSync(join(workspace, RULE), ruleContent("Local exception: legacy dir\n"));
    const change = {
      path: RULE, source: template("v2", "new source"),
      evidence: ["README.md"], acceptedDecision: "take v2, keep local exception",
      accepted: true, content: ruleContent("Local exception: legacy dir\nAdapted v2 addition\n"),
    };
    assert.equal(classifyProjectFile({ workspace, ...change }).status, "conflict");
    assert.throws(
      () => applyAcceptedProjectFiles({ workspace, changes: [change] }),
      /adoption or reconciliation/,
      "unreconciled conflict never overwrites",
    );
    applyAcceptedProjectFiles({ workspace, changes: [{ ...change, reconciled: true }] });
    const body = readFileSync(join(workspace, RULE), "utf8");
    assert.match(body, /Local exception: legacy dir/, "local lines survive");
    assert.match(body, /Adapted v2 addition/, "accepted update lands");
    const entry = sidecar(workspace)[RULE];
    assert.equal(entry.sourceVersion, "v2");
    assert.equal(
      classifyProjectFile({ workspace, ...change, reconciled: true }).status,
      "unchanged",
    );
  }));

test("stale preview is visible: concurrent edit between diff and apply fails loudly", () =>
  fixture((workspace) => {
    applyAcceptedProjectFiles({
      workspace,
      changes: [{
        path: RULE, source: template(), evidence: ["README.md"],
        acceptedDecision: "adopt evidence rule", accepted: true, adopt: true,
        content: ruleContent(),
      }],
    });
    // Preview computed against clean bytes…
    const previewed = { path: RULE, source: template("v2", "new source"), evidence: ["README.md"], acceptedDecision: "take v2" };
    assert.equal(classifyProjectFile({ workspace, ...previewed }).status, "source-update");
    // …then the repo moves before apply.
    writeFileSync(join(workspace, RULE), ruleContent("concurrent local edit\n"));
    assert.throws(
      () => applyAcceptedProjectFiles({ workspace, changes: [{ ...previewed, accepted: true, content: ruleContent("v2\n") }] }),
      /adoption or reconciliation/,
      "stale source-update is reclassified as conflict, not applied blindly",
    );
  }));

test("repeating a fulfilled request adds no duplicates and regenerates nothing", () =>
  fixture((workspace) => {
    const change = {
      path: RULE, source: template(), evidence: ["README.md"],
      acceptedDecision: "adopt evidence rule", accepted: true, adopt: true,
      content: ruleContent(),
    };
    applyAcceptedProjectFiles({ workspace, changes: [change] });
    const filesBefore = readdirSync(join(workspace, ".ai/rules")).sort();
    const entriesBefore = Object.keys(sidecar(workspace)).length;
    let generated = 0;
    const repeat = applyAcceptedProjectFiles({
      workspace,
      changes: [{ ...change }],
      generateContent: () => { generated += 1; return "regenerated"; },
    });
    assert.equal(repeat.changed, false);
    assert.equal(generated, 0, "no-op never invokes the content generator");
    assert.deepEqual(readdirSync(join(workspace, ".ai/rules")).sort(), filesBefore);
    assert.equal(Object.keys(sidecar(workspace)).length, entriesBefore);
  }));

test("interrupted multi-file apply rolls content and sidecar back together", () =>
  fixture((workspace) => {
    assert.throws(
      () => applyAcceptedProjectFiles({
        workspace,
        changes: [
          {
            path: RULE, source: template(), evidence: ["README.md"],
            acceptedDecision: "adopt evidence rule", accepted: true, adopt: true,
            content: ruleContent(),
          },
          {
            path: CMD, source: { origin: "repo-derived" }, evidence: ["x"],
            acceptedDecision: "broken change", accepted: true, adopt: true,
            content: "second file\n",
          },
        ],
        failAt: "after-commit",
      }),
      /injected/,
    );
    assert.equal(existsSync(join(workspace, RULE)), false, "partial content rolled back");
    assert.equal(
      existsSync(join(workspace, AI_STATE_REL_PATH)), false,
      "sidecar rolled back with content, no success recorded",
    );
  }));

test("pointer edits stay region-scoped and preserve surrounding content", () => {
  const block = "# >>> agent-fleet:rules >>>\n- `.ai/rules` index\n# <<< agent-fleet:rules <<<";
  const region = extractRegion(block);
  assert.ok(region, "region extracts with a name");
  const existing = "# Project\n\nHuman intro stays.\n\n# >>> agent-fleet:rules >>>\n- old pointer\n# <<< agent-fleet:rules <<<\n\nHuman outro stays.\n";
  const updated = replaceRegion(existing, region.block);
  assert.match(updated, /Human intro stays\./, "content before the region survives");
  assert.match(updated, /Human outro stays\./, "content after the region survives");
  assert.match(updated, /`\.ai\/rules` index/, "managed region is replaced");
  assert.doesNotMatch(updated, /old pointer/, "stale region content is gone");
});
