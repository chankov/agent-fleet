import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  artifactState,
  atomicInstallArtifact,
  ensurePlainDirectory,
  resolveHermesProfile,
  writeReceipt,
} from "./hermes-profile-artifact.js";

const NAME = "hub-watchdog";
const ACTIONS = ["status", "install", "update", "uninstall"];

const defaultConfig = {
  schemaVersion: 1,
  autonomy: "observe",
  maximumAutonomy: "observe",
  surgicalAllowlist: [],
  originDelivery: "required",
  runtimeDir: null,
};

export function watchdogLockPath(runtimeRoot, profileId) {
  // Keep lifecycle inspection byte-for-byte aligned with watchdog.py profile_root().
  const profileHash = createHash("sha256").update(profileId).digest("hex");
  return join(runtimeRoot, "agent-fleet-hermes-watchdog", profileHash, "watch.lock");
}

function usage() {
  return new Error("Usage: agent-fleet set-hermes-watchdog <status|install|update|uninstall> [--profile NAME] [--force] [--dry-run]");
}

export function parseSetHermesWatchdogArgs(argv) {
  if (argv.length !== 1 || !ACTIONS.includes(argv[0])) throw usage();
  return { action: argv[0] };
}

function plainFile(path) {
  if (!existsSync(path)) return false;
  const stat = lstatSync(path);
  return !stat.isSymbolicLink() && stat.isFile();
}

/**
 * `managed` only when a plain receipt names the exact installed fingerprint;
 * `unmanaged` when no receipt exists at all; anything else is `drifted`.
 */
function receiptState(receipt, installedFingerprint) {
  if (!existsSync(receipt)) return "unmanaged";
  if (!plainFile(receipt)) return "drifted";
  try {
    const parsed = JSON.parse(readFileSync(receipt, "utf8"));
    return parsed.fingerprint === installedFingerprint ? "managed" : "drifted";
  } catch {
    return "drifted";
  }
}

/** Read-only inspection: two Hermes reads, no profile, service, or tool mutation. */
export async function inspectHermesWatchdog(options) {
  const resolved = await resolveHermesProfile(options.profile, options.hermes);
  const sourceDir = options.skillSourceDir ?? join(options.packageRoot, "hermes", "skills", NAME);
  const installedDir = join(resolved.profilePath, "skills", NAME);
  const receipt = join(resolved.profilePath, "agent-fleet", `${NAME}.receipt.json`);
  const skill = artifactState(sourceDir, installedDir);
  const runtimeRoot = options.runtimeRoot ?? process.env.XDG_RUNTIME_DIR ?? "/tmp";
  return {
    ...resolved,
    sourceDir,
    installedDir,
    receipt,
    configPath: join(resolved.profilePath, "agent-fleet", "watchdog.json"),
    skillState: skill.state,
    receiptState: receiptState(receipt, skill.installedFingerprint),
    lockActive: existsSync(watchdogLockPath(runtimeRoot, resolved.profile)),
    originDelivery: false,
  };
}

/**
 * What an explicit install/update would do, without touching anything.
 * `adopt` covers an identical unmanaged tree: only the receipt is missing.
 */
function planInstall(before, force) {
  if (before.skillState === "missing") return { mode: "install" };
  if (before.skillState === "drifted") {
    if (!force) throw new Error(`${NAME} differs from packaged Agent Fleet source; re-run with --force to back it up and replace it`);
    return { mode: "install" };
  }
  if (before.receiptState === "managed") return { mode: "none" };
  if (before.receiptState === "unmanaged") return { mode: "adopt" };
  if (!force) throw new Error(`${NAME} has an unreadable or mismatched receipt; re-run with --force to back up the tree and reinstall it`);
  return { mode: "install" };
}

/**
 * Adopt an identical unmanaged tree by writing only the receipt. The
 * fingerprint is recomputed here so a tree that changed since inspection —
 * or that grew a symlink — is refused instead of blessed.
 */
function adoptUnmanaged(before) {
  const fresh = artifactState(before.sourceDir, before.installedDir);
  if (fresh.state !== "current") {
    throw new Error(`${NAME} changed while being adopted; re-run status and retry`);
  }
  ensurePlainDirectory(join(before.profilePath, "agent-fleet"), before.profilePath);
  writeReceipt(before.receipt, { name: NAME, fingerprint: fresh.installedFingerprint });
}

function writeDefaultConfig(before) {
  if (existsSync(before.configPath)) return;
  ensurePlainDirectory(join(before.profilePath, "agent-fleet"), before.profilePath);
  writeFileSync(before.configPath, JSON.stringify(defaultConfig, null, 2) + "\n", { mode: 0o600 });
}

/**
 * Remove only a matching managed tree. Config and journals are preserved, and
 * an active watcher is reported by `lockActive` but never signalled.
 */
function removeManaged(before, { force, dryRun }) {
  if (before.skillState === "missing") return { changed: false };
  const managed = before.skillState === "current" && before.receiptState === "managed";
  if (!managed && !force) {
    throw new Error(`${NAME} is ${before.skillState}/${before.receiptState}; re-run with --force to back it up and remove only this tree`);
  }
  if (dryRun) return { changed: true, dryRun: true };
  const backupRoot = join(before.profilePath, "backups", "agent-fleet");
  ensurePlainDirectory(join(before.profilePath, "backups"), before.profilePath);
  ensurePlainDirectory(backupRoot, join(before.profilePath, "backups"));
  const backupDir = join(backupRoot, `${NAME}-uninstall-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  renameSync(before.installedDir, backupDir);
  rmSync(before.receipt, { force: true });
  return { changed: true, backupDir };
}

export async function setHermesWatchdog(options) {
  const { action } = parseSetHermesWatchdogArgs(options.positionals);
  const before = await inspectHermesWatchdog(options);

  if (action === "status") return { action, ...before };
  if (action === "uninstall") return { action, ...before, ...removeManaged(before, options) };

  const planned = planInstall(before, options.force);
  const configPending = !existsSync(before.configPath);
  if (options.dryRun) {
    return { action, ...before, changed: planned.mode !== "none" || configPending, adopted: planned.mode === "adopt", dryRun: true };
  }

  let backupDir = null;
  if (planned.mode === "install") {
    ensurePlainDirectory(join(before.profilePath, "agent-fleet"), before.profilePath);
    backupDir = atomicInstallArtifact({
      sourceDir: before.sourceDir,
      installedDir: before.installedDir,
      profilePath: before.profilePath,
      name: NAME,
      receipt: before.receipt,
      now: options.now,
    });
  } else if (planned.mode === "adopt") {
    adoptUnmanaged(before);
  }
  writeDefaultConfig(before);

  return {
    action,
    changed: planned.mode !== "none" || configPending,
    adopted: planned.mode === "adopt",
    backupDir,
    ...await inspectHermesWatchdog(options),
  };
}
