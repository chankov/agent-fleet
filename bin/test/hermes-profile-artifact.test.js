import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  artifactState,
  atomicInstallArtifact,
  directoryFingerprint,
  ensurePlainDirectory,
  parseProfilePath,
  parseRunningGatewayProfiles,
  resolveHermesProfile,
  validateSafeName,
  writeReceipt,
} from "../lib/hermes-profile-artifact.js";

const disposables = [];

function scratch(prefix = "hermes-profile-artifact-") {
  const root = mkdtempSync(join(tmpdir(), prefix));
  disposables.push(root);
  return root;
}

test.after(() => {
  for (const root of disposables) rmSync(root, { recursive: true, force: true });
});

/** A profile tree plus a packaged source tree, with no real Hermes anywhere. */
function fixture() {
  const root = scratch();
  const profilePath = join(root, "profile");
  const sourceDir = join(root, "source", "hub-watchdog");
  mkdirSync(join(profilePath, "agent-fleet"), { recursive: true, mode: 0o700 });
  mkdirSync(join(sourceDir, "scripts"), { recursive: true });
  writeFileSync(join(sourceDir, "SKILL.md"), "# watchdog\n");
  writeFileSync(join(sourceDir, "scripts", "watchdog.py"), "print('watchdog')\n");
  return {
    root,
    profilePath,
    sourceDir,
    installedDir: join(profilePath, "skills", "hub-watchdog"),
    receipt: join(profilePath, "agent-fleet", "hub-watchdog.receipt.json"),
    backupRoot: join(profilePath, "backups", "agent-fleet"),
  };
}

function fakeHermes(responses) {
  const calls = [];
  return {
    calls,
    hermes: async args => {
      calls.push(args.join(" "));
      const reply = responses[args.join(" ")];
      if (reply === undefined) throw new Error(`unexpected Hermes call: ${args.join(" ")}`);
      return reply;
    },
  };
}

test("running-gateway parsing ignores styling and non-running entries", () => {
  const output = "  [32m✓[0m alpha (current)\n  ✗ beta — not running\n  ✓ gamma\n";

  assert.deepEqual(parseRunningGatewayProfiles(output), ["alpha", "gamma"]);
  assert.deepEqual(parseRunningGatewayProfiles(""), []);
});

test("profile description parsing refuses mismatched or relative paths", () => {
  const good = "Profile: default\nPath:    /srv/hermes/default\nGateway: stopped\n";

  assert.equal(parseProfilePath(good, "default"), "/srv/hermes/default");
  assert.throws(() => parseProfilePath(good, "other"), /invalid profile description/);
  assert.throws(() => parseProfilePath("Profile: default\nPath: relative/path\n", "default"), /invalid profile description/);
  assert.throws(() => parseProfilePath("garbage", "default"), /invalid profile description/);
});

test("unsafe profile names are refused before any Hermes call", async () => {
  for (const name of ["..", ".", "-leading", "with space", "a/b", "../escape", ""]) {
    assert.throws(() => validateSafeName(name, "Hermes profile"), /Invalid Hermes profile/);
  }
  const { hermes, calls } = fakeHermes({ "gateway list": "  ✓ default\n" });

  await assert.rejects(resolveHermesProfile("../escape", hermes), /Invalid Hermes profile/);
  assert.deepEqual(calls, ["gateway list"]);
});

test("exactly one running gateway is inferred and ambiguity is refused", async () => {
  const f = fixture();
  const one = fakeHermes({
    "gateway list": "  ✓ solo\n",
    "profile show solo": `Profile: solo\nPath: ${f.profilePath}\n`,
  });

  const resolved = await resolveHermesProfile(undefined, one.hermes);

  assert.deepEqual(resolved, { profile: "solo", profilePath: f.profilePath, gatewayRunning: true });
  assert.deepEqual(one.calls, ["gateway list", "profile show solo"]);

  const two = fakeHermes({ "gateway list": "  ✓ a\n  ✓ b\n" });
  await assert.rejects(resolveHermesProfile(undefined, two.hermes), /expected exactly one running gateway, found 2/);

  const none = fakeHermes({ "gateway list": "  ✗ a — not running\n" });
  await assert.rejects(resolveHermesProfile(undefined, none.hermes), /found 0/);
});

test("an explicit stopped profile resolves read-only and reports it is not running", async () => {
  const f = fixture();
  const { hermes, calls } = fakeHermes({
    "gateway list": "  ✗ default (current) — not running\n",
    "profile show default": `Profile: default\nPath:    ${f.profilePath}\nGateway: stopped\n`,
  });

  const resolved = await resolveHermesProfile("default", hermes);

  assert.equal(resolved.gatewayRunning, false);
  assert.equal(resolved.profilePath, f.profilePath);
  assert.deepEqual(calls, ["gateway list", "profile show default"]);
});

test("a symlinked or missing profile directory is refused", async () => {
  const f = fixture();
  const link = join(f.root, "linked-profile");
  symlinkSync(f.profilePath, link);
  const linked = fakeHermes({
    "gateway list": "  ✗ default\n",
    "profile show default": `Profile: default\nPath: ${link}\n`,
  });

  await assert.rejects(resolveHermesProfile("default", linked.hermes), /unsafe or missing Hermes profile directory/);

  const absent = fakeHermes({
    "gateway list": "  ✗ default\n",
    "profile show default": `Profile: default\nPath: ${join(f.root, "nope")}\n`,
  });
  await assert.rejects(resolveHermesProfile("default", absent.hermes), /unsafe or missing Hermes profile directory/);
});

test("fingerprints are deterministic, path-sensitive, and content-sensitive", () => {
  const f = fixture();
  const copy = join(f.root, "copy");
  mkdirSync(join(copy, "scripts"), { recursive: true });
  writeFileSync(join(copy, "SKILL.md"), "# watchdog\n");
  writeFileSync(join(copy, "scripts", "watchdog.py"), "print('watchdog')\n");

  const first = directoryFingerprint(f.sourceDir);

  assert.equal(first, directoryFingerprint(f.sourceDir), "repeat reads agree");
  assert.equal(first, directoryFingerprint(copy), "identical content in a different root agrees");
  assert.equal(directoryFingerprint(join(f.root, "absent")), null);

  writeFileSync(join(copy, "scripts", "watchdog.py"), "print('watchdog') \n");
  assert.notEqual(first, directoryFingerprint(copy), "content edits change the fingerprint");

  const renamed = join(f.root, "renamed");
  mkdirSync(join(renamed, "scripts"), { recursive: true });
  writeFileSync(join(renamed, "SKILL.md"), "# watchdog\n");
  writeFileSync(join(renamed, "scripts", "watchdog2.py"), "print('watchdog')\n");
  assert.notEqual(first, directoryFingerprint(renamed), "renames change the fingerprint");
});

test("fingerprinting refuses symlinks and unsupported entries in the tree", () => {
  const f = fixture();
  symlinkSync(join(f.sourceDir, "SKILL.md"), join(f.sourceDir, "scripts", "link.md"));

  assert.throws(() => directoryFingerprint(f.sourceDir), /refusing symlink in Hermes skill tree/);
});

test("extra files in an installed tree drift it away from packaged source", () => {
  const f = fixture();
  atomicInstallArtifact({ ...f, name: "hub-watchdog" });

  assert.equal(artifactState(f.sourceDir, f.installedDir).state, "current");

  writeFileSync(join(f.installedDir, "extra.txt"), "surprise\n");
  const drifted = artifactState(f.sourceDir, f.installedDir);

  assert.equal(drifted.state, "drifted");
  assert.notEqual(drifted.installedFingerprint, drifted.sourceFingerprint);
});

test("artifact state reports missing trees and refuses missing packaged source", () => {
  const f = fixture();

  const missing = artifactState(f.sourceDir, f.installedDir);
  assert.equal(missing.state, "missing");
  assert.equal(missing.installedFingerprint, null);
  assert.equal(typeof missing.sourceFingerprint, "string");

  assert.throws(() => artifactState(join(f.root, "gone"), f.installedDir), /packaged source is missing/);
});

test("ensurePlainDirectory creates 0700 directories and refuses unsafe ones", () => {
  const f = fixture();
  const parent = join(f.profilePath, "agent-fleet");
  const child = join(parent, "nested");

  ensurePlainDirectory(child, parent);

  assert.equal(statSync(child).isDirectory(), true);
  assert.equal(statSync(child).mode & 0o777, 0o700);

  const linked = join(f.profilePath, "linked");
  symlinkSync(parent, linked);
  assert.throws(() => ensurePlainDirectory(linked), /refusing unsafe Hermes directory/);

  const file = join(f.profilePath, "afile");
  writeFileSync(file, "x");
  assert.throws(() => ensurePlainDirectory(file), /refusing unsafe Hermes directory/);
});

test("atomic install writes the complete tree plus a 0600 receipt and leaves no temp entry", () => {
  const f = fixture();

  const backupDir = atomicInstallArtifact({ ...f, name: "hub-watchdog" });

  assert.equal(backupDir, null, "nothing to back up on a first install");
  assert.equal(readFileSync(join(f.installedDir, "SKILL.md"), "utf8"), "# watchdog\n");
  assert.equal(readFileSync(join(f.installedDir, "scripts", "watchdog.py"), "utf8"), "print('watchdog')\n");
  assert.equal(artifactState(f.sourceDir, f.installedDir).state, "current");

  const receipt = JSON.parse(readFileSync(f.receipt, "utf8"));
  assert.deepEqual(receipt, { schemaVersion: 1, name: "hub-watchdog", fingerprint: directoryFingerprint(f.installedDir) });
  assert.equal(statSync(f.receipt).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(join(f.profilePath, "skills")), ["hub-watchdog"], "no temp entry survives");
});

test("atomic install backs up the replaced tree and rewrites the receipt at 0600", () => {
  const f = fixture();
  atomicInstallArtifact({ ...f, name: "hub-watchdog" });
  writeFileSync(join(f.installedDir, "SKILL.md"), "locally edited\n");
  chmodSync(f.receipt, 0o644);
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 0, 1, 0, 0, ++tick));

  const backupDir = atomicInstallArtifact({ ...f, name: "hub-watchdog", now });

  assert.equal(backupDir, join(f.backupRoot, "hub-watchdog-2026-01-01T00-00-01-000Z"));
  assert.equal(readFileSync(join(backupDir, "SKILL.md"), "utf8"), "locally edited\n", "the prior tree is preserved");
  assert.equal(artifactState(f.sourceDir, f.installedDir).state, "current");
  assert.equal(statSync(f.receipt).mode & 0o777, 0o600, "the receipt mode is reasserted, not inherited");
  assert.deepEqual(readdirSync(join(f.profilePath, "skills")), ["hub-watchdog"]);
});

test("a copy failure leaves the prior tree untouched and removes the temp entry", () => {
  const f = fixture();
  atomicInstallArtifact({ ...f, name: "hub-watchdog" });
  const before = directoryFingerprint(f.installedDir);

  assert.throws(
    () => atomicInstallArtifact({ ...f, sourceDir: join(f.root, "does-not-exist"), name: "hub-watchdog" }),
    /ENOENT/,
  );

  assert.equal(directoryFingerprint(f.installedDir), before);
  assert.deepEqual(readdirSync(join(f.profilePath, "skills")), ["hub-watchdog"]);
  assert.equal(existsSync(f.backupRoot), false, "no backup is created when the copy never lands");
});

test("a source tree containing a symlink is refused before the prior tree is moved", () => {
  const f = fixture();
  atomicInstallArtifact({ ...f, name: "hub-watchdog" });
  const before = directoryFingerprint(f.installedDir);
  symlinkSync(join(f.sourceDir, "SKILL.md"), join(f.sourceDir, "scripts", "link.md"));

  assert.throws(() => atomicInstallArtifact({ ...f, name: "hub-watchdog" }), /refusing symlink in Hermes skill tree/);

  assert.equal(directoryFingerprint(f.installedDir), before);
  assert.deepEqual(readdirSync(join(f.profilePath, "skills")), ["hub-watchdog"]);
});

test("a rename failure restores the prior tree from its backup", () => {
  const f = fixture();
  atomicInstallArtifact({ ...f, name: "hub-watchdog" });
  writeFileSync(join(f.installedDir, "SKILL.md"), "prior tree\n");
  const before = directoryFingerprint(f.installedDir);
  // A plain file where the backups root must be a directory fails the rename
  // of the prior tree only after the temp copy has landed.
  mkdirSync(join(f.profilePath, "backups"), { recursive: true });
  writeFileSync(f.backupRoot, "not a directory\n");

  assert.throws(() => atomicInstallArtifact({ ...f, name: "hub-watchdog" }), /refusing unsafe Hermes directory/);

  assert.equal(directoryFingerprint(f.installedDir), before, "the prior tree is intact");
  assert.deepEqual(readdirSync(join(f.profilePath, "skills")), ["hub-watchdog"], "no temp entry survives");
});

test("a receipt failure rolls the new tree back to the prior complete tree", () => {
  const f = fixture();
  atomicInstallArtifact({ ...f, name: "hub-watchdog" });
  writeFileSync(join(f.installedDir, "SKILL.md"), "prior tree\n");
  const before = directoryFingerprint(f.installedDir);
  // The receipt's parent directory is missing, so the write fails after the
  // new tree has already been renamed into place.
  const receipt = join(f.profilePath, "agent-fleet", "absent", "hub-watchdog.receipt.json");

  assert.throws(() => atomicInstallArtifact({ ...f, receipt, name: "hub-watchdog" }), /ENOENT/);

  assert.equal(directoryFingerprint(f.installedDir), before, "the profile keeps the tree it had");
  assert.equal(existsSync(receipt), false);
  assert.deepEqual(readdirSync(join(f.profilePath, "skills")), ["hub-watchdog"], "no temp entry survives");
});

test("a receipt failure on a first install leaves no partial tree behind", () => {
  const f = fixture();
  const receipt = join(f.profilePath, "agent-fleet", "absent", "hub-watchdog.receipt.json");

  assert.throws(() => atomicInstallArtifact({ ...f, receipt, name: "hub-watchdog" }), /ENOENT/);

  assert.equal(existsSync(f.installedDir), false);
  assert.deepEqual(readdirSync(join(f.profilePath, "skills")), []);
});

test("writeReceipt replaces an existing receipt rather than inheriting its mode", () => {
  const f = fixture();
  mkdirSync(join(f.profilePath, "agent-fleet"), { recursive: true });
  writeFileSync(f.receipt, "stale\n", { mode: 0o644 });

  writeReceipt(f.receipt, { name: "hub-watchdog", fingerprint: "abc" });

  assert.deepEqual(JSON.parse(readFileSync(f.receipt, "utf8")), { schemaVersion: 1, name: "hub-watchdog", fingerprint: "abc" });
  assert.equal(statSync(f.receipt).mode & 0o777, 0o600);
  assert.equal(lstatSync(f.receipt).isSymbolicLink(), false);
});
