import { createHash, randomUUID } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

const ANSI_RE = /\x1B\[[0-?]*[ -/]*[@-~]/g;

export const SAFE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function validateSafeName(value, label = "name") {
  if (!SAFE_NAME_RE.test(value) || value === "." || value.includes("..")) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`);
  }
  return value;
}

/** Profiles Hermes reports as running, one per `✓ <profile>` line. */
export function parseRunningGatewayProfiles(output) {
  return String(output)
    .replace(ANSI_RE, "")
    .split("\n")
    .flatMap(line => line.match(/^\s*✓\s+([A-Za-z0-9][A-Za-z0-9._-]*)(?:\s|$)/u)?.[1] ?? []);
}

export function parseProfilePath(output, expectedProfile) {
  const text = String(output).replace(ANSI_RE, "");
  const profile = text.match(/^Profile:\s*(\S+)\s*$/m)?.[1];
  const path = text.match(/^Path:\s*(.+?)\s*$/m)?.[1];
  if (profile !== expectedProfile || !path || !isAbsolute(path)) {
    throw new Error(`Hermes returned an invalid profile description for ${expectedProfile}`);
  }
  return resolve(path);
}

/**
 * Resolve the target profile read-only: `gateway list` for inference plus
 * `profile show` for the path. Never starts, stops, or mutates anything.
 */
export async function resolveHermesProfile(requestedProfile, hermes) {
  const running = parseRunningGatewayProfiles(await hermes(["gateway", "list"]));
  let profile = requestedProfile?.trim();
  if (profile) {
    validateSafeName(profile, "Hermes profile");
  } else {
    if (running.length !== 1) {
      throw new Error(`cannot infer Hermes profile: expected exactly one running gateway, found ${running.length}; pass --profile NAME`);
    }
    [profile] = running;
  }
  const profilePath = parseProfilePath(await hermes(["profile", "show", profile]), profile);
  if (!existsSync(profilePath)) throw new Error(`unsafe or missing Hermes profile directory: ${profilePath}`);
  const stat = lstatSync(profilePath);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`unsafe or missing Hermes profile directory: ${profilePath}`);
  }
  return { profile, profilePath, gatewayRunning: running.includes(profile) };
}

/**
 * Content-addressed fingerprint over a plain-file tree. Symlinks and other
 * special entries are refusals, not silently skipped or followed.
 * Returns null when the tree is absent.
 */
export function directoryFingerprint(root) {
  if (!existsSync(root)) return null;
  const hash = createHash("sha256");
  const visit = current => {
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`refusing symlink in Hermes skill tree: ${current}`);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(current).sort()) visit(join(current, entry));
      return;
    }
    if (!stat.isFile()) throw new Error(`unsupported entry in Hermes skill tree: ${current}`);
    hash.update(relative(root, current));
    hash.update("\0");
    hash.update(readFileSync(current));
    hash.update("\0");
  };
  visit(root);
  return hash.digest("hex");
}

export function ensurePlainDirectory(dir, parent) {
  if (existsSync(dir)) {
    const stat = lstatSync(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`refusing unsafe Hermes directory: ${dir}`);
    return;
  }
  if (parent) ensurePlainDirectory(parent);
  mkdirSync(dir, { mode: 0o700 });
}

export function artifactState(sourceDir, installedDir) {
  const sourceFingerprint = directoryFingerprint(sourceDir);
  if (!sourceFingerprint) throw new Error(`packaged source is missing: ${sourceDir}`);
  const installedFingerprint = directoryFingerprint(installedDir);
  let state = "drifted";
  if (installedFingerprint === null) state = "missing";
  else if (installedFingerprint === sourceFingerprint) state = "current";
  return { state, sourceFingerprint, installedFingerprint };
}

/** Receipts are rewritten, never appended to, so the 0600 mode always applies. */
export function writeReceipt(receipt, { name, fingerprint }) {
  const body = JSON.stringify({ schemaVersion: 1, name, fingerprint }, null, 2) + "\n";
  rmSync(receipt, { force: true });
  writeFileSync(receipt, body, { mode: 0o600 });
}

/**
 * Install `sourceDir` at `installedDir` so the profile is left with either the
 * prior complete tree or the new complete tree plus a valid receipt — never a
 * partial tree, a stray temp entry, or a new tree without its receipt.
 * Returns the backup directory holding the replaced tree, or null.
 */
export function atomicInstallArtifact({ sourceDir, installedDir, profilePath, name, now = () => new Date(), receipt }) {
  const skillsDir = join(profilePath, "skills");
  ensurePlainDirectory(skillsDir, profilePath);
  const temp = join(skillsDir, `.${name}.tmp-${process.pid}-${randomUUID()}`);
  const backupRoot = join(profilePath, "backups", "agent-fleet");
  let backupDir = null;
  let installed = false;
  try {
    cpSync(sourceDir, temp, { recursive: true, errorOnExist: true, force: false });
    directoryFingerprint(temp);
    if (existsSync(installedDir)) {
      ensurePlainDirectory(join(profilePath, "backups"), profilePath);
      ensurePlainDirectory(backupRoot, join(profilePath, "backups"));
      backupDir = join(backupRoot, `${name}-${now().toISOString().replace(/[:.]/g, "-")}`);
      renameSync(installedDir, backupDir);
    }
    renameSync(temp, installedDir);
    installed = true;
    if (receipt) writeReceipt(receipt, { name, fingerprint: directoryFingerprint(installedDir) });
    return backupDir;
  } catch (error) {
    rmSync(temp, { recursive: true, force: true });
    // A receipt failure leaves the new tree in place; undo it so the profile
    // keeps exactly the state it had before this call.
    if (installed) rmSync(installedDir, { recursive: true, force: true });
    if (backupDir && existsSync(backupDir) && !existsSync(installedDir)) renameSync(backupDir, installedDir);
    throw error;
  }
}
