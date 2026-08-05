import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { inspectHermesWatchdog, parseSetHermesWatchdogArgs, setHermesWatchdog, watchdogLockPath } from "../lib/set-hermes-watchdog.js";

/** Every Hermes call the controller is allowed to make: two read-only reads. */
const READ_ONLY_LEDGER = ["gateway list", "profile show default"];

function assertNoMutatingHermesCalls(calls) {
  for (const args of calls) {
    assert.deepEqual(
      args.slice(0, 2),
      args[0] === "gateway" ? ["gateway", "list"] : ["profile", "show"],
      `unexpected Hermes call: ${args.join(" ")}`,
    );
  }
  const flat = calls.map(args => args.join(" "));
  assert.deepEqual([...new Set(flat)].sort(), [...READ_ONLY_LEDGER].sort());
}

const disposables = [];

test.after(() => {
  for (const root of disposables) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "set-hermes-watchdog-"));
  disposables.push(root);
  const profilePath = join(root, "profile");
  const sourceDir = join(root, "source", "hub-watchdog");
  const runtimeRoot = join(root, "empty-runtime");
  mkdirSync(profilePath, { recursive: true });
  mkdirSync(runtimeRoot, { recursive: true });
  mkdirSync(join(sourceDir, "scripts"), { recursive: true });
  writeFileSync(join(sourceDir, "SKILL.md"), "# watchdog\n");
  writeFileSync(join(sourceDir, "scripts", "watchdog.py"), "print('watchdog')\n");
  const calls = [];
  return {
    root, profilePath, sourceDir, runtimeRoot, calls,
    receiptPath: () => join(profilePath, "agent-fleet", "hub-watchdog.receipt.json"),
    hermes: async args => {
      calls.push(args);
      if (args.join(" ") === "gateway list") return "  ✗ default (current) — not running\n";
      if (args.join(" ") === "profile show default") return `Profile: default\nPath:    ${profilePath}\nGateway: stopped\n`;
      throw new Error(`unexpected Hermes call: ${args.join(" ")}`);
    },
  };
}

function options(f, positionals, extra = {}) {
  return {
    positionals,
    profile: "default",
    packageRoot: f.root,
    skillSourceDir: f.sourceDir,
    runtimeRoot: f.runtimeRoot,
    hermes: f.hermes,
    ...extra,
  };
}

test("watchdog CLI publishes lifecycle help without promising a service action", () => {
  const output = execFileSync(process.execPath, ["bin/cli.js", "set-hermes-watchdog", "--help"], { encoding: "utf8", cwd: process.cwd() });
  assert.match(output, /set-hermes-watchdog <status\|install\|update\|uninstall>/);
  assert.match(output, /No action starts\/stops\/restarts a gateway/);
  assert.match(output, /local-journal-only/);
});

test("watchdog installer parser accepts only lifecycle verbs", () => {
  for (const action of ["status", "install", "update", "uninstall"]) {
    assert.deepEqual(parseSetHermesWatchdogArgs([action]), { action });
  }
  for (const argv of [[], ["status", "extra"], ["start"], ["install", "--force"]]) {
    assert.throws(() => parseSetHermesWatchdogArgs(argv));
  }
});

test("explicit stopped profile supports read-only status and fail-closed install", async () => {
  const f = fixture();
  const status = await setHermesWatchdog(options(f, ["status"]));
  assert.equal(status.gatewayRunning, false);
  assert.equal(status.skillState, "missing");
  const installed = await setHermesWatchdog(options(f, ["install"]));
  assert.equal(installed.changed, true);
  assert.equal(installed.skillState, "current");
  assert.equal(installed.receiptState, "managed");
  assert.equal(existsSync(installed.configPath), true);
  assert.deepEqual(JSON.parse(readFileSync(installed.configPath, "utf8")), {
    schemaVersion: 1, autonomy: "observe", maximumAutonomy: "observe", surgicalAllowlist: [], originDelivery: "required", runtimeDir: null,
  });
  assert.deepEqual(f.calls.map(args => args.join(" ")), ["gateway list", "profile show default", "gateway list", "profile show default", "gateway list", "profile show default"]);
});

test("drift requires force and managed uninstall preserves configuration", async () => {
  const f = fixture();
  await setHermesWatchdog(options(f, ["install"]));
  writeFileSync(join(f.profilePath, "skills", "hub-watchdog", "SKILL.md"), "edited\n");
  await assert.rejects(setHermesWatchdog(options(f, ["update"])), /differs/);
  const updated = await setHermesWatchdog(options(f, ["update"], { force: true }));
  assert.equal(updated.skillState, "current");
  const removed = await setHermesWatchdog(options(f, ["uninstall"]));
  assert.equal(removed.changed, true);
  assert.equal(existsSync(join(f.profilePath, "skills", "hub-watchdog")), false);
  assert.equal(existsSync(removed.configPath), true);
});

test("status is read-only and reports every lifecycle dimension", async () => {
  const f = fixture();
  const runtimeRoot = join(f.root, "runtime");
  const activeLock = join(runtimeRoot, "agent-fleet-hermes-watchdog", createHash("sha256").update("default").digest("hex"), "watch.lock");
  mkdirSync(join(activeLock, ".."), { recursive: true });
  writeFileSync(activeLock, "123");

  const status = await setHermesWatchdog(options(f, ["status"], { runtimeRoot }));

  assert.equal(status.action, "status");
  assert.equal(status.profile, "default");
  assert.equal(status.profilePath, f.profilePath);
  assert.equal(status.gatewayRunning, false);
  assert.equal(status.skillState, "missing");
  assert.equal(status.receiptState, "unmanaged");
  assert.equal(status.lockActive, true, "an active watcher is reported, never signalled");
  assert.equal(status.originDelivery, false);
  assert.equal(existsSync(join(f.profilePath, "skills")), false, "status writes nothing");
  assert.equal(existsSync(status.configPath), false);
  assertNoMutatingHermesCalls(f.calls);
});

test("installer derives the same hashed lock identity as the foreground Python watcher", () => {
  const runtime = "/tmp/runtime";
  const expected = createHash("sha256").update("profile.with-dash").digest("hex");
  assert.equal(watchdogLockPath(runtime, "profile.with-dash"), join(runtime, "agent-fleet-hermes-watchdog", expected, "watch.lock"));
  assert.notEqual(watchdogLockPath(runtime, "profile.with-dash"), join(runtime, "agent-fleet-hermes-watchdog", "profile.with-dash", "watch.lock"));
});

test("install adopts an identical unmanaged tree by writing only a receipt", async () => {
  const f = fixture();
  const installedDir = join(f.profilePath, "skills", "hub-watchdog");
  mkdirSync(join(f.profilePath, "skills"), { recursive: true });
  cpSync(f.sourceDir, installedDir, { recursive: true });

  const before = await inspectHermesWatchdog(options(f, ["status"]));
  assert.equal(before.skillState, "current");
  assert.equal(before.receiptState, "unmanaged");

  const adopted = await setHermesWatchdog(options(f, ["install"]));

  assert.equal(adopted.adopted, true);
  assert.equal(adopted.changed, true);
  assert.equal(adopted.backupDir, null, "adoption never moves the tree it adopts");
  assert.equal(adopted.skillState, "current");
  assert.equal(adopted.receiptState, "managed");
  assert.equal(existsSync(join(f.profilePath, "backups")), false);
  assert.equal(statSync(adopted.receipt).mode & 0o777, 0o600);
  assertNoMutatingHermesCalls(f.calls);
});

test("a second install after adoption is a no-op", async () => {
  const f = fixture();
  mkdirSync(join(f.profilePath, "skills"), { recursive: true });
  cpSync(f.sourceDir, join(f.profilePath, "skills", "hub-watchdog"), { recursive: true });
  await setHermesWatchdog(options(f, ["install"]));
  const receiptBefore = readFileSync(join(f.profilePath, "agent-fleet", "hub-watchdog.receipt.json"), "utf8");

  const again = await setHermesWatchdog(options(f, ["update"]));

  assert.equal(again.changed, false);
  assert.equal(again.adopted, false);
  assert.equal(again.receiptState, "managed");
  assert.equal(readFileSync(again.receipt, "utf8"), receiptBefore);
});

test("adoption refuses a drifted, symlinked, or unsupported unmanaged tree", async () => {
  const drifted = fixture();
  const driftedDir = join(drifted.profilePath, "skills", "hub-watchdog");
  mkdirSync(join(drifted.profilePath, "skills"), { recursive: true });
  cpSync(drifted.sourceDir, driftedDir, { recursive: true });
  writeFileSync(join(driftedDir, "extra.py"), "print('foreign')\n");

  await assert.rejects(setHermesWatchdog(options(drifted, ["install"])), /differs from packaged Agent Fleet source/);
  assert.equal(existsSync(join(drifted.profilePath, "agent-fleet", "hub-watchdog.receipt.json")), false);
  assert.equal(readFileSync(join(driftedDir, "extra.py"), "utf8"), "print('foreign')\n", "a refused tree is left alone");

  const linked = fixture();
  const linkedDir = join(linked.profilePath, "skills", "hub-watchdog");
  mkdirSync(join(linked.profilePath, "skills"), { recursive: true });
  cpSync(linked.sourceDir, linkedDir, { recursive: true });
  symlinkSync(join(linkedDir, "SKILL.md"), join(linkedDir, "scripts", "alias.md"));

  await assert.rejects(setHermesWatchdog(options(linked, ["install"])), /refusing symlink in Hermes skill tree/);
  assert.equal(existsSync(join(linked.profilePath, "agent-fleet", "hub-watchdog.receipt.json")), false);
});

test("a mismatched receipt refuses until force reinstalls with a backup", async () => {
  const f = fixture();
  await setHermesWatchdog(options(f, ["install"]));
  writeFileSync(f.receiptPath(), JSON.stringify({ schemaVersion: 1, name: "hub-watchdog", fingerprint: "forged" }) + "\n");

  const stale = await inspectHermesWatchdog(options(f, ["status"]));
  assert.equal(stale.skillState, "current");
  assert.equal(stale.receiptState, "drifted");

  await assert.rejects(setHermesWatchdog(options(f, ["update"])), /unreadable or mismatched receipt/);

  const forced = await setHermesWatchdog(options(f, ["update"], { force: true }));

  assert.equal(forced.receiptState, "managed");
  assert.equal(forced.skillState, "current");
  assert.notEqual(forced.backupDir, null, "force backs the tree up before replacing it");
  assert.equal(existsSync(forced.backupDir), true);
});

test("dry-run reports the pending write without touching the profile", async () => {
  const f = fixture();

  const planned = await setHermesWatchdog(options(f, ["install"], { dryRun: true }));

  assert.equal(planned.dryRun, true);
  assert.equal(planned.changed, true);
  assert.equal(planned.skillState, "missing");
  assert.equal(existsSync(join(f.profilePath, "skills")), false);
  assert.equal(existsSync(planned.configPath), false);

  mkdirSync(join(f.profilePath, "skills"), { recursive: true });
  cpSync(f.sourceDir, join(f.profilePath, "skills", "hub-watchdog"), { recursive: true });
  const adoption = await setHermesWatchdog(options(f, ["install"], { dryRun: true }));

  assert.equal(adoption.adopted, true);
  assert.equal(adoption.changed, true);
  assert.equal(existsSync(adoption.receipt), false, "a dry-run adoption writes no receipt");
  assertNoMutatingHermesCalls(f.calls);
});

test("uninstall refuses an unmanaged tree, preserves journals, and never kills a watcher", async () => {
  const f = fixture();
  const installedDir = join(f.profilePath, "skills", "hub-watchdog");
  mkdirSync(join(f.profilePath, "skills"), { recursive: true });
  cpSync(f.sourceDir, installedDir, { recursive: true });
  const runtimeRoot = join(f.root, "runtime");
  const lockDir = join(runtimeRoot, "agent-fleet-hermes-watchdog", createHash("sha256").update("default").digest("hex"));
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(join(lockDir, "watch.lock"), "123");

  await assert.rejects(setHermesWatchdog(options(f, ["uninstall"], { runtimeRoot })), /current\/unmanaged/);
  assert.equal(existsSync(installedDir), true);

  await setHermesWatchdog(options(f, ["install"], { runtimeRoot }));
  mkdirSync(join(f.profilePath, "agent-fleet", "journals"), { recursive: true });
  writeFileSync(join(f.profilePath, "agent-fleet", "journals", "events.jsonl"), "{}\n");

  const removed = await setHermesWatchdog(options(f, ["uninstall"], { runtimeRoot }));

  assert.equal(removed.changed, true);
  assert.equal(removed.lockActive, true, "the active lock is reported, not cleared");
  assert.equal(existsSync(join(lockDir, "watch.lock")), true);
  assert.equal(existsSync(installedDir), false);
  assert.equal(existsSync(removed.configPath), true);
  assert.equal(readFileSync(join(f.profilePath, "agent-fleet", "journals", "events.jsonl"), "utf8"), "{}\n");
  assert.equal(existsSync(f.receiptPath()), false);
  assert.equal(readdirSync(join(f.profilePath, "backups", "agent-fleet")).length, 1, "the removed tree is backed up");
  assertNoMutatingHermesCalls(f.calls);
});

test("uninstall on a missing tree changes nothing", async () => {
  const f = fixture();

  const removed = await setHermesWatchdog(options(f, ["uninstall"]));

  assert.equal(removed.changed, false);
  assert.equal(removed.skillState, "missing");
  assert.equal(existsSync(join(f.profilePath, "backups")), false);
});

test("guided watchdog commands mirror the deterministic CLI on every surface", () => {
  const surfaces = [
    { path: ".pi/prompts/af-set-hermes-watchdog.md", command: "af-set-hermes-watchdog" },
    { path: ".claude/commands/set-hermes-watchdog.md", command: "set-hermes-watchdog" },
  ];

  for (const { path, command } of surfaces) {
    const text = readFileSync(path, "utf8");
    const label = `${path}: `;

    assert.equal(path.endsWith(`${command}.md`), true, `${label}file name must match its command`);
    assert.match(text, /argument-hint: "<status\|install\|update\|uninstall> \[--profile NAME\] \[--force\] \[--dry-run\]"/, `${label}argument hint`);
    assert.match(text, /confirm|Ask for confirmation|Ask the user/i, `${label}human confirmation before writes`);
    assert.match(text, /--force/, `${label}force is named`);
    assert.match(text, /Gate O/, `${label}Gate O stays closed`);
    assert.doesNotMatch(text, /\b(restart|start|stop|kill)\s+the\s+gateway\b/i, `${label}no service verb is invented`);
    assert.doesNotMatch(text, /agent-fleet set-hermes-watchdog\s+\w+\s+--profile\s+(?!NAME)\S+/, `${label}no real profile id`);
  }
});
