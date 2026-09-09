import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { loadManifest } from "../lib/manifest.js";
import { buildReconcilePlan } from "../lib/reconcile.js";
import { applyPlan } from "../lib/apply.js";
import { capturePlanFingerprints, recoverTransaction, transactionRecovery } from "../lib/transaction.js";
import { planStt } from "../lib/stt-wizard.js";
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cli = join(root, "bin/cli.js");
const manifest = loadManifest(root);
const ws = () => mkdtempSync(join(tmpdir(), "af-reliability-"));
const run = (workspace, ...args) => spawnSync(process.execPath, [cli, ...args, "--workspace", workspace], { encoding: "utf8" });
function snapshot(rootDir) {
  const out = {};
  const walk = (dir, rel = "") => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a,b)=>a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name), key = join(rel, entry.name);
      if (entry.isDirectory()) { out[key] = "dir"; walk(path, key); }
      else out[key] = readFileSync(path).toString("base64");
    }
  };
  walk(rootDir); return out;
}

test("all relevant dry runs are mutation-free and public JSON omits secret-bearing buffers", () => {
  const workspace = ws(); mkdirSync(join(workspace, ".ai"), { recursive: true });
  const marker = "SYNTHETIC_UNKNOWN_SECRET_47";
  writeFileSync(join(workspace, ".env"), `UNFAMILIAR_FIELD=${marker}\n`);
  writeFileSync(join(workspace, ".ai/stt.json"), JSON.stringify({ provider: "groq", apiKeyEnv: "GROQ_API_KEY", custom: "keep" }, null, 2) + "\n");
  let before = snapshot(workspace);
  let result = run(workspace, "setup", "--preset", "default", "--features", "voice", "--dry-run", "--json");
  assert.equal(result.status, 0, result.stderr); assert.deepEqual(snapshot(workspace), before);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(marker));
  const preview = JSON.parse(result.stdout); assert.equal(preview.publicSchemaVersion, 1); assert.equal(preview.stage, "preview");
  assert.equal(JSON.stringify(preview).includes('"text"'), false);

  result = run(workspace, "uninstall", "--all", "--purge-config", "--dry-run", "--yes", "--json");
  assert.equal(result.status, 0, result.stderr); assert.deepEqual(snapshot(workspace), before);
  assert.deepEqual(JSON.parse(result.stdout).purge.wouldRemove.sort(), [".ai/agent-fleet.json", ".ai/stt.json"].filter((p)=>existsSync(join(workspace,p))).sort());

  const noopWorkspace = ws();
  result = run(noopWorkspace, "install", "--profile", "default", "--yes", "--json");
  assert.equal(result.status, 0, result.stderr);
  result = run(noopWorkspace, "install", "--profile", "default", "--yes", "--json");
  assert.equal(result.status, 0, result.stderr);
  const noop = JSON.parse(result.stdout); assert.equal(noop.publicSchemaVersion, 1); assert.equal(noop.stage, "apply");
  assert.equal(JSON.stringify(noop).includes('"text"'), false);
});

test("doctor fix dry-run and with-state purge previews are recursively mutation-free", () => {
  for (const backupExists of [true, false]) {
    const workspace = ws(); mkdirSync(join(workspace, ".ai"));
    const backup = ".ai/.agent-fleet-recovery/x/backup";
    if (backupExists) mkdirSync(join(workspace, backup), { recursive: true });
    writeFileSync(join(workspace, ".ai/agent-fleet-transaction.json"), JSON.stringify({ schemaVersion: 3, phase: "applying", backup, paths: [], present: [] }));
    const before = snapshot(workspace);
    const result = run(workspace, "doctor", "--fix", "--dry-run", "--json");
    assert.equal(result.status, 2, result.stderr); JSON.parse(result.stdout);
    assert.deepEqual(snapshot(workspace), before, `backupExists=${backupExists}`);
  }
  const workspace = ws();
  let result = run(workspace, "setup", "--preset", "default", "--features", "none", "--yes");
  assert.equal(result.status, 0, result.stderr);
  writeFileSync(join(workspace, ".ai/stt.json"), JSON.stringify({ provider: "groq", apiKeyEnv: "GROQ_API_KEY", unknown: "SYNTHETIC_ERROR_SECRET_71" }));
  const before = snapshot(workspace);
  result = run(workspace, "uninstall", "--all", "--purge-config", "--dry-run", "--json");
  assert.equal(result.status, 0, result.stderr); JSON.parse(result.stdout);
  assert.deepEqual(snapshot(workspace), before); assert.doesNotMatch(result.stdout + result.stderr, /SYNTHETIC_ERROR_SECRET_71/);
});

test("existing STT config is bytewise preserved and replacement is explicit", () => {
  const workspace = ws(); mkdirSync(join(workspace, ".ai"), { recursive: true });
  const original = '{\n  "provider": "groq",\n  "apiKeyEnv": "TEAM_GROQ_KEY",\n  "endpoint": "custom",\n  "unknown": {"human": true}\n}\n';
  writeFileSync(join(workspace, ".ai/stt.json"), original);
  let result = run(workspace, "setup", "--preset", "default", "--features", "voice", "--yes");
  assert.equal(result.status, 0, result.stderr); assert.equal(readFileSync(join(workspace, ".ai/stt.json"), "utf8"), original);
  assert.throws(() => planStt(workspace, "openai"), /requires explicit approval/);
  result = run(workspace, "setup", "--preset", "default", "--features", "voice", "--stt-provider", "openai", "--yes");
  assert.equal(result.status, 0, result.stderr);
  const replaced = JSON.parse(readFileSync(join(workspace, ".ai/stt.json"), "utf8"));
  assert.equal(replaced.provider, "openai"); assert.equal(replaced.unknown.human, true); assert.equal(replaced.endpoint, "custom");
  const fresh = ws(); result = run(fresh, "setup", "--preset", "default", "--features", "voice", "--yes");
  assert.equal(result.status, 1); assert.match(result.stderr, /explicit STT provider/);
});

test("lock, pending journal, fingerprints and symlink parents fail closed", () => {
  const locked = ws(); mkdirSync(join(locked, ".ai")); writeFileSync(join(locked, ".ai/agent-fleet.lock"), '{"pid":999,"operation":"other"}\n');
  let result = run(locked, "setup", "--preset", "default", "--features", "none", "--yes");
  assert.equal(result.status, 4); assert.match(result.stderr, /never stolen/);
  const pending = ws(); mkdirSync(join(pending, ".ai")); writeFileSync(join(pending, ".ai/agent-fleet-transaction.json"), "bad");
  result = run(pending, "setup", "--preset", "default", "--features", "none", "--dry-run");
  assert.equal(result.status, 1); assert.match(result.stderr, /pending transaction/);

  const changed = ws(); const plan = buildReconcilePlan({ workspace: changed, sourceRoot: root, packageVersion: manifest.packageVersion, manifest, preset: "default", features: "none", yes: true });
  plan.fingerprints = capturePlanFingerprints(plan, manifest); mkdirSync(join(changed, ".ai")); writeFileSync(join(changed, ".ai/agent-fleet.json"), "intervening");
  const applied = applyPlan({ plan, manifest }); assert.equal(applied.exitCode, 1); assert.match(applied.failure.detail, /changed since preview/);

  const outside = ws(), linked = ws(); writeFileSync(join(outside, "sentinel"), "outside"); symlinkSync(outside, join(linked, ".ai"), "dir");
  result = run(linked, "setup", "--preset", "default", "--features", "none", "--yes");
  assert.notEqual(result.status, 0); assert.equal(readFileSync(join(outside, "sentinel"), "utf8"), "outside");

  const leafWorkspace = ws(), leafOutside = ws(); mkdirSync(join(leafWorkspace, ".ai"));
  const sttSentinel = join(leafOutside, "stt.json");
  const sttOriginal = JSON.stringify({ provider: "groq", apiKeyEnv: "GROQ_API_KEY", custom: "outside" }) + "\n";
  writeFileSync(sttSentinel, sttOriginal); symlinkSync(sttSentinel, join(leafWorkspace, ".ai/stt.json"));
  result = run(leafWorkspace, "setup", "--preset", "default", "--features", "voice", "--stt-provider", "openai", "--yes");
  assert.notEqual(result.status, 0); assert.match(result.stdout + result.stderr, /symlink/);
  assert.equal(readFileSync(sttSentinel, "utf8"), sttOriginal);

  const envWorkspace = ws(), envOutside = ws(); mkdirSync(join(envWorkspace, ".ai"));
  writeFileSync(join(envWorkspace, ".ai/stt.json"), JSON.stringify({ provider: "groq", apiKeyEnv: "GROQ_API_KEY" }));
  const envSentinel = join(envOutside, "env"); writeFileSync(envSentinel, "OUTSIDE=keep\n"); symlinkSync(envSentinel, join(envWorkspace, ".env"));
  result = run(envWorkspace, "setup", "--preset", "default", "--features", "voice", "--yes");
  assert.notEqual(result.status, 0); assert.match(result.stdout + result.stderr, /symlink/);
  assert.equal(readFileSync(envSentinel, "utf8"), "OUTSIDE=keep\n");
});

test("two live setup processes enforce the single-writer lock", { timeout: 15000 }, async () => {
  const workspace = ws(), fakeBin = ws();
  const npm = join(fakeBin, "npm"); writeFileSync(npm, "#!/bin/sh\nsleep 0.2\nexit 0\n"); chmodSync(npm, 0o755);
  const env = { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` };
  const first = spawn(process.execPath, [cli, "setup", "--workspace", workspace, "--preset", "full", "--features", "none", "--allow-exec", "--yes"], { env, stdio: "ignore" });
  const lock = join(workspace, ".ai/agent-fleet.lock");
  for (let i = 0; i < 100 && !existsSync(lock); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(existsSync(lock), "first live setup owns the workspace lock");
  const second = run(workspace, "setup", "--preset", "default", "--features", "none", "--yes");
  assert.equal(second.status, 4); assert.match(second.stderr, /workspace is locked/);
  const firstExit = await new Promise((resolve) => first.once("exit", (code, signal) => resolve({ code, signal })));
  assert.equal(firstExit.signal, null); assert.equal(firstExit.code, 0);
  JSON.parse(readFileSync(join(workspace, ".ai/agent-fleet.json"), "utf8"));
});

test("malformed and escaping journals preserve outside sentinels and diagnostics", () => {
  const workspace = ws(), outside = ws(); const sentinel = join(outside, "sentinel"); writeFileSync(sentinel, "keep"); mkdirSync(join(workspace, ".ai"));
  const journal = join(workspace, ".ai/agent-fleet-transaction.json");
  writeFileSync(journal, JSON.stringify({ schemaVersion: 3, phase: "applying", backup: ".ai/.agent-fleet-recovery/x/backup", paths: [sentinel], present: [] }));
  assert.equal(transactionRecovery(workspace).recoverable, false);
  assert.throws(() => recoverTransaction(workspace), /outside the workspace|unreadable/);
  assert.equal(readFileSync(sentinel, "utf8"), "keep"); assert.ok(existsSync(journal));
});

test("recovery unlinks destination leaf links and rejects nested backup symlink escapes", () => {
  const workspace = ws(), outside = ws(); mkdirSync(join(workspace, ".ai/.agent-fleet-recovery/x/backup"), { recursive: true });
  const sentinel = join(outside, "sentinel"); writeFileSync(sentinel, "outside");
  writeFileSync(join(workspace, ".ai/.agent-fleet-recovery/x/backup/owned.txt"), "restored");
  symlinkSync(sentinel, join(workspace, "owned.txt"));
  const journal = join(workspace, ".ai/agent-fleet-transaction.json");
  writeFileSync(journal, JSON.stringify({ schemaVersion: 3, phase: "applying", backup: ".ai/.agent-fleet-recovery/x/backup", paths: ["owned.txt"], present: ["owned.txt"] }));
  assert.equal(recoverTransaction(workspace).recovered, true);
  assert.equal(readFileSync(join(workspace, "owned.txt"), "utf8"), "restored");
  assert.equal(readFileSync(sentinel, "utf8"), "outside");

  const malicious = ws(); mkdirSync(join(malicious, ".ai/.agent-fleet-recovery/x/backup"), { recursive: true });
  symlinkSync(outside, join(malicious, ".ai/.agent-fleet-recovery/x/backup/nested"), "dir");
  writeFileSync(join(malicious, ".ai/agent-fleet-transaction.json"), JSON.stringify({ schemaVersion: 3, phase: "applying", backup: ".ai/.agent-fleet-recovery/x/backup", paths: ["nested/sentinel"], present: ["nested/sentinel"] }));
  assert.throws(() => recoverTransaction(malicious), /symlink/);
  assert.equal(readFileSync(sentinel, "utf8"), "outside");
  assert.ok(existsSync(join(malicious, ".ai/agent-fleet-transaction.json")), "diagnostics remain");
});

test("SIGKILL leaves workspace-owned applying journal and explicit recovery restores pre-image", () => {
  const workspace = ws(); writeFileSync(join(workspace, "owned.txt"), "before");
  const script = `import {runTransaction} from ${JSON.stringify(new URL("../lib/transaction.js", import.meta.url).href)}; import {writeFileSync} from 'node:fs'; runTransaction({workspace:process.argv[1],plan:{workspace:process.argv[1],verb:'test',actions:[{files:[{path:'owned.txt'}]}]},commit(){writeFileSync(process.argv[1]+'/owned.txt','after');process.kill(process.pid,'SIGKILL')}});`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script, workspace], { encoding: "utf8" });
  assert.equal(child.signal, "SIGKILL"); const status = transactionRecovery(workspace); assert.equal(status.phase, "applying"); assert.equal(status.recoverable, true);
  const recovered = recoverTransaction(workspace); assert.equal(recovered.recovered, true); assert.equal(readFileSync(join(workspace, "owned.txt"), "utf8"), "before");
});
