// The .pi/agent-fleet relocation, end to end against the real manifest.
//
// The plan for this move deliberately shipped no migration script: changing
// where an item installs changes its binding, and apply() already retires
// recorded files that leave a binding. These tests are the proof of that claim
// — that the cleanup happens, that it stops at files the operator touched, and
// that a *narrowed* run still reports what it did not clean up.

import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadManifest } from "../lib/manifest.js";
import { buildPlan } from "../lib/plan.js";
import { applyPlan } from "../lib/apply.js";
import { runVerify } from "../lib/verify.js";
import { readState, writeState, hashFile, STATE_SCHEMA_VERSION } from "../lib/state.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifest = loadManifest(repoRoot);

function workspace(label) {
  const dir = mkdtempSync(join(tmpdir(), `af-relocate-${label}-`));
  test.after?.(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const common = (ws) => ({
  workspace: ws, sourceRoot: repoRoot, packageVersion: manifest.packageVersion,
  manifest, agent: "pi", platform: "linux",
});

/**
 * Install for real, then rewrite the state so it looks like a pre-relocation
 * workspace: every recorded path moved back to where 2.0.x put it, with the
 * file copied there and the new one removed. Using the real bytes keeps the
 * hashes honest, which is the whole ownership rule.
 */
function pretendPreRelocation(ws, moves) {
  const state = readState(ws);
  state.schemaVersion = 1;
  for (const [id, rewrite] of Object.entries(moves)) {
    const recorded = state.items[id];
    assert.ok(recorded, `${id} was not installed`);
    recorded.files = recorded.files.map((file) => {
      const old = rewrite(file.path);
      if (old === file.path) return file;
      const from = join(ws, file.path);
      const to = join(ws, old);
      writeFileSyncDeep(to, readFileSync(from));
      rmSync(from, { force: true });
      return { ...file, path: old, sha256: hashFile(to) };
    });
  }
  writeState(ws, state);
  return state;
}

function writeFileSyncDeep(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

test("a full setup retires the pre-2.1 tree and keeps what the operator edited", async () => {
  const ws = workspace("full");
  const plan = buildPlan({ ...common(ws), profiles: ["recommended"] });
  assert.equal(applyPlan({ plan, manifest }).summary.failed, 0);

  pretendPreRelocation(ws, {
    "persona:builder": (p) => p.replace(".pi/agents/personas/", "agents/"),
    "persona:code-reviewer": (p) => p.replace(".pi/agents/personas/", "agents/"),
  });
  // One of the two is edited: it is the operator's now and must survive.
  appendFileSync(join(ws, "agents/builder.md"), "\n# local edit\n");

  const before = await runVerify({ ...common(ws), includeDoctor: false });
  const relocation = before.findings.find((f) => f.type === "relocated-artifacts");
  assert.ok(relocation, "verify must summarise the relocation in one finding");
  assert.match(relocation.issue, /2 item\(s\) moved/);
  assert.match(relocation.issue, /1 kept \(locally modified\)/);
  assert.ok(before.findings.some((f) => f.type === "state-schema"),
    "schemaVersion 1 marks a workspace that has not been reconciled yet");

  const second = buildPlan({ ...common(ws), profiles: ["recommended"] });
  assert.equal(applyPlan({ plan: second, manifest }).summary.failed, 0);

  assert.equal(existsSync(join(ws, "agents/code-reviewer.md")), false, "an untouched old copy is retired");
  assert.ok(existsSync(join(ws, "agents/builder.md")), "an edited old copy is kept");
  assert.ok(existsSync(join(ws, ".pi/agents/personas/code-reviewer.md")));
  assert.equal(readState(ws).schemaVersion, STATE_SCHEMA_VERSION, "the pass re-stamps the schema version");

  const after = await runVerify({ ...common(ws), includeDoctor: false });
  assert.equal(after.findings.some((f) => f.type === "relocated-artifacts"), false, "nothing left to relocate");
  assert.ok(
    after.findings.some((f) => f.type === "legacy-target" && f.path === "agents/builder.md"),
    "the surviving copy is reported — scanAgentDirs reads agents/ first and would shadow the installed persona",
  );
});

test("a narrowed install reconciles the moved items it did not select", async () => {
  // Risk 3 of the plan was that `install --items X` leaves every *other*
  // recorded item sitting on its pre-2.1 paths. It does not: buildPlan walks
  // the recorded state as well as the selection, and an item whose files no
  // longer match its binding comes back as a `repair` action even when the
  // operator asked for something else. The selection widens what is installed,
  // never what is reconciled.
  const ws = workspace("narrow");
  const plan = buildPlan({ ...common(ws), profiles: ["recommended"] });
  assert.equal(applyPlan({ plan, manifest }).summary.failed, 0);

  pretendPreRelocation(ws, {
    "persona:builder": (p) => p.replace(".pi/agents/personas/", "agents/"),
    "persona:code-reviewer": (p) => p.replace(".pi/agents/personas/", "agents/"),
  });

  const narrow = buildPlan({ ...common(ws), items: ["persona:builder"] });
  assert.deepEqual(narrow.selection.resolved, ["persona:builder"], "the selection really is one item");
  assert.ok(
    narrow.actions.some((a) => a.kind === "repair" && a.id === "persona:code-reviewer"),
    "an unselected item on a stale path is still planned as a repair",
  );

  assert.equal(applyPlan({ plan: narrow, manifest }).summary.failed, 0);
  assert.equal(existsSync(join(ws, "agents/builder.md")), false);
  assert.equal(existsSync(join(ws, "agents/code-reviewer.md")), false, "the unselected item is reconciled too");

  const report = await runVerify({ ...common(ws), includeDoctor: false });
  assert.equal(report.findings.some((f) => f.type === "relocated-artifacts"), false,
    "nothing is left orphaned for a later run to find");
});

test("verify reports an orphan it cannot reach, rather than staying silent", async () => {
  // The same guarantee from the other side: if a path does survive — because
  // the operator edited it, or reconciliation never ran — `verify` names it,
  // and it does so by walking the recorded state rather than any selection.
  const ws = workspace("orphan");
  const plan = buildPlan({ ...common(ws), profiles: ["recommended"] });
  assert.equal(applyPlan({ plan, manifest }).summary.failed, 0);

  pretendPreRelocation(ws, {
    "persona:code-reviewer": (p) => p.replace(".pi/agents/personas/", "agents/"),
  });

  const report = await runVerify({ ...common(ws), includeDoctor: false });
  const relocation = report.findings.find((f) => f.type === "relocated-artifacts");
  assert.ok(relocation, "an orphaned path must be reported");
  assert.match(relocation.issue, /persona:code-reviewer/);
  assert.match(relocation.fix, /items\[\]\.obsoleteFiles/);
  const entry = report.items.find((i) => i.id === "persona:code-reviewer");
  assert.deepEqual(entry.obsoleteFiles, [{ path: "agents/code-reviewer.md", retained: false }]);
});
