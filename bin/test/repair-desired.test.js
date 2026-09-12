import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { loadManifest } from "../lib/manifest.js";
import { inspectDesiredRepair, applyDesiredRepair, prepareDesiredRepair } from "../lib/repair-desired.js";
const root = process.cwd();

// `npm pack --json` lists every shipped file — over 8,000 of them, since each
// release adds a `.versions/<x.y.z>/` snapshot. The listing passed Node's 1 MiB
// spawn default at 2.0.8, so give it room that a few hundred releases cannot use up.
const PACK_MAX_BUFFER = 64 * 1024 * 1024;
const manifest = loadManifest(root);
function fixture(t, enabled = false) {
  const workspace = mkdtempSync(join(tmpdir(), "af-config-repair-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  mkdirSync(join(workspace, ".ai"));
  const path = join(workspace, ".ai/agent-fleet.json");
  const value = { schemaVersion: 1, preset: "default", features: { "codex-remote": enabled, browser: true } };
  const original = JSON.stringify(value, null, 2) + "\n";
  writeFileSync(path, original);
  return { workspace, path, original, value };
}
for (const enabled of [false, true]) test(`repair preserves settings, backs up original, is idempotent (${enabled})`, t => {
  const f = fixture(t, enabled);
  const proposal = inspectDesiredRepair(f.workspace, manifest);
  const backup = applyDesiredRepair(proposal);
  assert.equal(readFileSync(backup, "utf8"), f.original);
  const result = JSON.parse(readFileSync(f.path, "utf8"));
  delete f.value.features["codex-remote"];
  assert.deepEqual(result, f.value);
  assert.equal(inspectDesiredRepair(f.workspace, manifest), null);
});
test("changed files are not overwritten", t => {
  const f = fixture(t);
  const proposal = inspectDesiredRepair(f.workspace, manifest);
  writeFileSync(f.path, f.original + "\n");
  assert.throws(() => applyDesiredRepair(proposal), /changed since/);
  assert.equal(readFileSync(f.path, "utf8"), f.original + "\n");
  assert.equal(readdirSync(join(f.workspace, ".ai")).length, 1);
});
for (const invalid of ['{', '{"schemaVersion":99,"preset":"default","features":{"codex-remote":false}}', '{"schemaVersion":1,"preset":"default","features":{"codex-remote":false,"typo":true}}', '{"schemaVersion":1,"preset":"default","features":{"codex-remote":"false"}}']) {
  test(`invalid config requires manual repair: ${invalid}`, t => {
    const f = fixture(t); writeFileSync(f.path, invalid);
    assert.throws(() => inspectDesiredRepair(f.workspace, manifest));
    assert.equal(readFileSync(f.path, "utf8"), invalid);
  });
}
for (const answer of ["n", "", null]) test(`refusal/interruption writes nothing: ${answer}`, async t => {
  const f = fixture(t);
  const result = await prepareDesiredRepair({ ...f, manifest, interactive: true, output: { write() {} }, confirm: async () => answer });
  assert.equal(result.cancelled, true);
  assert.equal(readFileSync(f.path, "utf8"), f.original);
  assert.equal(readdirSync(join(f.workspace, ".ai")).length, 1);
});
test("interactive approval shows exact removal and saves backup", async t => {
  const f = fixture(t); let output = "";
  const result = await prepareDesiredRepair({ ...f, manifest, interactive: true, output: { write(s) { output += s; } }, confirm: async () => "yes" });
  assert.equal(result.repaired, true);
  assert.match(output, /"codex-remote": false/);
  assert.match(output, /NOT be enabled/);
  assert.equal(readFileSync(result.backup, "utf8"), f.original);
});

function cliContract(t, cli) {
  const f = fixture(t);
  // Avoid optional runtime installations: exact CLI overrides remain ephemeral.
  const run = (...args) => spawnSync(process.execPath, [cli, "setup", "--workspace", f.workspace, "--features", "none", ...args], { encoding: "utf8" });
  let r = run("--yes");
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /--repair-config/);
  assert.equal(readFileSync(f.path, "utf8"), f.original);
  r = run("--dry-run", "--repair-config");
  assert.equal(r.status, 0, r.stderr);
  const publicRepair = JSON.parse(r.stdout);
  assert.equal(publicRepair.configRepair.requiresApproval, true);
  assert.equal(publicRepair.publicSchemaVersion, 1);
  assert.equal(JSON.stringify(publicRepair).includes('"before"'), false);
  assert.equal(JSON.stringify(publicRepair).includes('"after"'), false);
  assert.equal(readFileSync(f.path, "utf8"), f.original);
  assert.equal(readdirSync(join(f.workspace, ".ai")).length, 1);
  r = run("--yes", "--repair-config");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(JSON.parse(readFileSync(f.path, "utf8")).features.browser, true);
  const backups = readdirSync(join(f.workspace, ".ai")).filter(n => n.startsWith("agent-fleet.json.backup-"));
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(join(f.workspace, ".ai", backups[0]), "utf8"), f.original);
  r = run("--yes");
  assert.equal(r.status, 0, r.stdout + r.stderr);
}
test("CLI requires repair-specific approval and supports repeat setup", t => cliContract(t, join(root, "bin/cli.js")));
test("packed release supports config repair in a disposable workspace", t => {
  const dir = mkdtempSync(join(tmpdir(), "af-repair-pack-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pack = spawnSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", dir], { cwd: root, encoding: "utf8", maxBuffer: PACK_MAX_BUFFER });
  assert.equal(pack.status, 0, pack.stderr);
  const filename = JSON.parse(pack.stdout)[0].filename;
  const unpack = spawnSync("tar", ["-xzf", join(dir, filename), "-C", dir], { encoding: "utf8" });
  assert.equal(unpack.status, 0, unpack.stderr);
  cliContract(t, join(dir, "package/bin/cli.js"));
});
