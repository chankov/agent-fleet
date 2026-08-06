import test from "node:test";
import assert from "node:assert/strict";
import { loadManifest } from "../lib/manifest.js";
import { resolveDesiredFeatures, resolveFeatures } from "../lib/features.js";

const manifest = loadManifest(process.cwd());

test("Full resolves stable catalogue roots but excludes experimental Codex Remote", () => {
  const full = resolveDesiredFeatures(manifest, { preset: "full", platform: process.platform });
  assert.ok(full.selected.includes("skill:peer-coms"), "Full includes stable Claude bridge root");
  assert.equal(full.selected.includes("codex:agent-fleet-codex-remote-control"), false);
  assert.equal(full.features.includes("codex-remote"), false);
  assert.ok(full.features.includes("voice"), "Full enables stable feature defaults");
});

test("Telegram implies Hermes feature prerequisites", () => {
  assert.deepEqual(resolveFeatures(manifest, ["telegram"]), ["hermes", "telegram"]);
  const selected = resolveDesiredFeatures(manifest, { features: ["telegram"] });
  assert.ok(selected.selected.includes("hermes-skill:hub-liaison"));
  assert.ok(selected.selected.includes("hermes-plugin:agent-fleet-herdr"));
});

test("unknown feature selection fails", () => {
  assert.throws(() => resolveFeatures(manifest, ["not-a-feature"]), /unknown feature/);
});
