import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadManifest } from "../lib/manifest.js";
import { defaultDesired, resolveDesiredState, renderDesired } from "../lib/desired.js";

const root = process.cwd();
const manifest = loadManifest(root);

function workspace() { return mkdtempSync(join(tmpdir(), "af-desired-")); }

test("missing desired state resolves to Default without features and is transactionally creatable", () => {
  const result = resolveDesiredState({ workspace: workspace(), manifest });
  assert.deepEqual(result.desired, defaultDesired(manifest));
  assert.equal(result.writeDesired, true);
  assert.match(renderDesired(result.desired), /"preset": "default"/);
  assert.equal(resolveDesiredState({ workspace: workspace(), manifest, dryRun: true }).writeDesired, false);
});

test("CLI overrides are ephemeral over existing desired state unless explicitly saved", () => {
  const dir = workspace();
  mkdirSync(join(dir, ".ai"));
  writeFileSync(join(dir, ".ai", "agent-fleet.json"), JSON.stringify({
    schemaVersion: 1, preset: "default", features: { voice: true },
  }));
  const ephemeral = resolveDesiredState({ workspace: dir, manifest, preset: "full", features: "browser" });
  assert.equal(ephemeral.desired.preset, "full");
  assert.equal(ephemeral.desired.features.browser, true);
  assert.equal(ephemeral.desired.features.voice, false, "--features is an exact set");
  assert.equal(ephemeral.writeDesired, false);
  assert.equal(resolveDesiredState({ workspace: dir, manifest, features: "none", saveDesired: true }).writeDesired, true);
});

test("unknown desired presets and features fail instead of being ignored", () => {
  assert.throws(() => resolveDesiredState({ workspace: workspace(), manifest, preset: "unknown" }), /unknown preset/);
  assert.throws(() => resolveDesiredState({ workspace: workspace(), manifest, features: "unknown" }), /unknown feature/);
});
