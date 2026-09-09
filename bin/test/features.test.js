import test from "node:test";
import assert from "node:assert/strict";
import { loadManifest } from "../lib/manifest.js";
import { normalizeFeatureSet, resolveDesiredFeatures, resolveFeatures } from "../lib/features.js";

const manifest = loadManifest(process.cwd());

test("Full resolves stable catalogue roots but excludes experimental ChatGPT client", () => {
  const full = resolveDesiredFeatures(manifest, { preset: "full", platform: process.platform });
  assert.ok(full.selected.includes("skill:peer-coms"), "Full includes stable Claude bridge root");
  assert.equal(full.features.includes("chatgpt-client"), false);
  assert.ok(full.features.includes("voice"), "Full enables stable feature defaults");
});

test("retired Codex remote feature refuses before mutation", () => {
  assert.throws(() => resolveFeatures(manifest, ["codex-remote"]), /retired feature "codex-remote"/);
});

test("Telegram implies Hermes feature prerequisites", () => {
  assert.deepEqual(resolveFeatures(manifest, ["telegram"]), ["hermes", "telegram"]);
  const selected = resolveDesiredFeatures(manifest, { features: ["telegram"] });
  assert.ok(selected.selected.includes("hermes-skill:hub-liaison"));
  assert.ok(selected.selected.includes("hermes-plugin:agent-fleet-herdr"));
});

test("all-features snapshot excludes features introduced by a future catalogue", () => {
  const snapshot = Object.keys(manifest.features).sort();
  const future = structuredClone(manifest);
  future.features["future-experimental"] = { stability: "experimental", platform: "any", items: [] };
  const resolved = resolveDesiredFeatures(future, { preset: "full", features: snapshot, platform: process.platform });
  assert.equal(resolved.preset, "full");
  assert.equal(resolved.features.includes("future-experimental"), false, "stored exact snapshot never auto-enables a future feature");
  assert.ok(resolved.features.includes("chatgpt-client"), "snapshot remains experimental-inclusive");
});

test("transitive feature dependency rejects an incompatible platform", () => {
  const fixture = structuredClone(manifest);
  fixture.features["transitive-root"] = { stability: "experimental", platform: "any", requiresFeatures: ["transitive-platform"], items: [] };
  fixture.features["transitive-platform"] = { stability: "experimental", platform: "win32", items: [] };
  assert.throws(() => resolveFeatures(fixture, ["transitive-root"], { platform: "linux" }), /transitive-platform.*unavailable on linux/);
});

test("exact feature parsing trims, deduplicates and does not add defaults", () => {
  assert.deepEqual(normalizeFeatureSet(manifest, " browser, voice, browser "), ["browser", "voice"]);
  const exact = resolveDesiredFeatures(manifest, { preset: "full", features: " browser, voice " });
  assert.deepEqual(exact.features, ["browser", "voice"]);
});

test("unknown feature selection fails", () => {
  assert.throws(() => resolveFeatures(manifest, ["not-a-feature"]), /unknown feature/);
});
