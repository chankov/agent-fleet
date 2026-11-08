// `agent-fleet inspect` — read-only JSON composition for in-session screens.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { runInspect, INSPECT_SCHEMA_VERSION } from "../lib/inspect.js";
import { loadManifest } from "../lib/manifest.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cli = join(root, "bin", "cli.js");
const run = (args) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
const listing = (dir) => readdirSync(dir, { recursive: true }).sort();

test("inspect on an empty workspace emits the composed report, exits 0 and writes nothing", () => {
  const ws = mkdtempSync(join(tmpdir(), "af-inspect-"));
  try {
    const before = listing(ws);
    const result = run(["inspect", "--workspace", ws]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.verb, "inspect"); assert.equal(report.readOnly, true); assert.equal(report.schemaVersion, INSPECT_SCHEMA_VERSION); assert.equal(report.publicSchemaVersion, 1);
    assert.deepEqual(report.installation, { status: "missing", reason: "missing_state" });
    assert.equal(report.verify.stateSource, "none"); assert.ok(report.verify.summary.total > 0); assert.ok(report.verify.items.every((item) => typeof item.state === "string"));
    assert.equal(report.doctor.preflight.status, "unavailable"); assert.ok(Array.isArray(report.doctor.findings));
    assert.equal(report.desired.status, "missing"); assert.equal(report.desired.effective.preset, "default"); assert.ok(report.desired.catalogue.some((feature) => feature.name === "voice" && feature.enabled === false && feature.available === true));
    assert.deepEqual(report.provenance, { status: "missing", error: null, entries: 0, path: ".ai/agent-fleet-ai-state.json" });
    assert.deepEqual(listing(ws), before, "inspect must not create files");
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("inspect reports a desired file with a retired feature as invalid without failing the run", async () => {
  const ws = mkdtempSync(join(tmpdir(), "af-inspect-"));
  try {
    mkdirSync(join(ws, ".ai"));
    writeFileSync(join(ws, ".ai", "agent-fleet.json"), JSON.stringify({ schemaVersion: 1, preset: "default", features: { "codex-remote": false, voice: true } }));
    writeFileSync(join(ws, ".ai", "agent-fleet-ai-state.json"), "{ corrupt");
    const report = await runInspect({ workspace: ws, sourceRoot: root, packageVersion: "0.0.0-test", manifest: loadManifest(root), agent: "pi", platform: "linux", env: { PATH: process.env.PATH } });
    assert.equal(report.desired.status, "invalid"); assert.match(report.desired.error, /retired feature "codex-remote"/);
    assert.deepEqual(report.desired.enabled, [], "an invalid file contributes no enabled features; the default desired state is evaluated instead");
    assert.equal(report.provenance.status, "corrupt"); assert.ok(report.provenance.error);
    assert.equal(report.installation.status, "missing", "a desired file without an install record is still a missing installation");
    const telegram = report.desired.catalogue.find((feature) => feature.name === "telegram");
    assert.deepEqual(telegram.requiresFeatures, ["hermes"]);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("inspect --help documents the verb and the top-level help lists it", () => {
  assert.match(run(["inspect", "--help"]).stdout, /agent-fleet inspect \[options\][\s\S]*Writes nothing/);
  assert.match(run(["--help"]).stdout, /\n  inspect\s+Read-only JSON composition/);
  assert.equal(run(["inspect", "--workspace", join(tmpdir(), "does-not-exist-af")]).status, 1);
});
