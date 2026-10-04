// transaction.js — durable, crash-recoverable managed workspace commits.
import { chmodSync, closeSync, constants, cpSync, existsSync, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { STATE_REL_PATH, LEGACY_RECORD_REL_PATH } from "./state.js";
import { acquireWorkspaceLock, assertSafeWorkspaceTarget, ownedRelativePath } from "./workspace-safety.js";

export const JOURNAL_REL_PATH = ".ai/agent-fleet-transaction.json";
export const RECOVERY_REL_PATH = ".ai/.agent-fleet-recovery";
const DESIRED_REL_PATH = ".ai/agent-fleet.json";
const OVERRIDES_REL_PATH = ".ai/agent-fleet-overrides.md";
const STT_REL_PATH = ".ai/stt.json";
const SYSTEM1_REL_PATH = ".ai/system1.json";
export function journalPath(workspace) { return join(workspace, JOURNAL_REL_PATH); }
function pathExists(path) {
  try { lstatSync(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function copySnapshot(source, destination) {
  // Handle the link object explicitly, including dangling links on Node 25.
  if (lstatSync(source).isSymbolicLink()) symlinkSync(readlinkSync(source), destination);
  else cpSync(source, destination, { recursive: true, dereference: false, verbatimSymlinks: true });
}

function sourceLeaves(path) {
  if (!statSync(path).isDirectory()) return [""];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => sourceLeaves(join(path, entry.name)).map((leaf) => join(entry.name, leaf)));
}

export function touchedPaths(plan, manifest) {
  const paths = new Set(plan?.verb === "configure" ? [] : [STATE_REL_PATH, LEGACY_RECORD_REL_PATH]);
  const catalogue = new Map((manifest?.items ?? []).map((item) => [item.id, item]));
  for (const action of plan?.actions ?? []) {
    for (const file of action.files ?? []) if (file.path) paths.add(file.path);
    for (const path of action.paths ?? []) if (path) paths.add(path);
    const binding = catalogue.get(action.id)?.agents?.[plan.agent];
    if (!binding) continue;
    if (binding.sourceMode === "all" && binding.preserveLayout) {
      for (const rel of binding.source ?? []) {
        const source = join(plan.sourceRoot, rel);
        if (!existsSync(source)) continue;
        if (binding.strategy === "copy-tree" && statSync(source).isDirectory()) for (const leaf of sourceLeaves(source)) paths.add(join(rel, leaf));
        else paths.add(rel);
      }
    } else if (binding.target) {
      const source = (binding.source ?? []).map((path) => join(plan.sourceRoot, path)).find(existsSync);
      if (binding.strategy === "copy-tree" && source) for (const leaf of sourceLeaves(source)) paths.add(join(binding.target, leaf));
      else paths.add(binding.target);
    }
  }
  if (plan?.writeDesired) paths.add(ownedRelativePath(plan.workspace, plan.desiredPath ?? DESIRED_REL_PATH));
  if (plan?.overrides?.write) paths.add(ownedRelativePath(plan.workspace, plan.overrides.path ?? OVERRIDES_REL_PATH));
  if (plan?.stt?.write) paths.add(ownedRelativePath(plan.workspace, plan.stt.path ?? STT_REL_PATH));
  if (plan?.taskTriage?.write) paths.add(ownedRelativePath(plan.workspace, plan.taskTriage.path ?? SYSTEM1_REL_PATH));
  if (plan?.taskTriageProvider?.write) paths.add(ownedRelativePath(plan.workspace, plan.taskTriageProvider.path ?? SYSTEM1_REL_PATH));
  if (plan?.stt?.env?.missing?.length) paths.add(ownedRelativePath(plan.workspace, plan.stt.env.path));
  const collapseManagedLink = (value) => {
    const rel = ownedRelativePath(plan.workspace, value); const parts = rel.split(/[/\\]/); let cursor = plan.workspace;
    for (let i = 0; i < parts.length - 1; i++) { cursor = join(cursor, parts[i]); if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) return parts.slice(0, i + 1).join("/"); }
    return rel;
  };
  return [...new Set([...paths].map(collapseManagedLink))].sort();
}

function fingerprint(path) {
  let stat;
  try { stat = lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return 'absent'; throw error; }
  if (stat.isSymbolicLink()) return `link:${readlinkSync(path)}`;
  if (stat.isDirectory()) return `dir:${readdirSync(path).sort().join("\0")}`;
  return `file:${createHash("sha256").update(readFileSync(path)).digest("hex")}:${stat.mode & 0o777}`;
}

export function capturePlanFingerprints(plan, manifest) {
  return Object.fromEntries(touchedPaths(plan, manifest).map((rel) => [rel, fingerprint(join(plan.workspace, rel))]));
}

export function assertPlanFingerprints(plan, manifest) {
  if (!plan.fingerprints) return;
  for (const [rel, expected] of Object.entries(plan.fingerprints)) {
    assertSafeWorkspaceTarget(plan.workspace, rel);
    if (fingerprint(join(plan.workspace, rel)) !== expected) throw Object.assign(new Error(`workspace changed since preview: ${rel}; re-run setup`), { exitCode: 3 });
  }
}

function fsyncPath(path) {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function durableJson(path, value) {
  const temp = `${path}.tmp-${process.pid}`;
  const fd = openSync(temp, "wx", 0o600);
  try { writeSync(fd, JSON.stringify(value, null, 2) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, path);
  // Persist the directory entry after the atomic replacement.
  fsyncPath(dirname(path));
}
function validateJournal(workspace, value) {
  if (!value || value.schemaVersion !== 3 || !["prepared", "applying", "committed"].includes(value.phase)) throw new Error("transaction journal schema or phase is invalid");
  if (!Array.isArray(value.paths) || !Array.isArray(value.present) || !value.paths.every((x) => typeof x === "string") || !value.present.every((x) => value.paths.includes(x))) throw new Error("transaction journal paths are invalid");
  value.paths = value.paths.map((rel) => ownedRelativePath(workspace, rel, "journal path"));
  value.present = value.present.map((rel) => ownedRelativePath(workspace, rel, "journal present path"));
  if (value.preserveBackup !== undefined && typeof value.preserveBackup !== 'boolean') throw new Error('transaction journal backup metadata is invalid');
  if (value.originalModes !== undefined || value.preserveBackup === true) {
    const modes = value.originalModes;
    if (!modes || typeof modes !== 'object' || Array.isArray(modes) || Object.keys(modes).length !== value.present.length || !value.present.every(rel => Object.hasOwn(modes, rel)) || Object.entries(modes).some(([rel, mode]) => !value.present.includes(rel) || !Number.isInteger(mode) || mode < 0 || mode > 0o777)) throw new Error('transaction journal original mode metadata is invalid');
  }
  value.backup = ownedRelativePath(workspace, value.backup, "journal backup");
  if (!value.backup.startsWith(`${RECOVERY_REL_PATH}/`) && value.backup !== RECOVERY_REL_PATH) throw new Error("transaction backup is not installer-owned");
  for (const rel of value.paths) assertSafeWorkspaceTarget(workspace, rel);
  assertSafeWorkspaceTarget(workspace, value.backup, { allowLeafSymlink: false });
  return value;
}
function backupTouchedPaths(workspace, paths, protectedBackup = false) {
  const rootRel = join(RECOVERY_REL_PATH, randomUUID());
  const backupRel = join(rootRel, "backup");
  const backup = assertSafeWorkspaceTarget(workspace, backupRel, { allowLeafSymlink: false });
  mkdirSync(backup, { recursive: true, mode: 0o700 });
  if (protectedBackup) {
    chmodSync(join(workspace, rootRel), 0o700); chmodSync(backup, 0o700);
    // Retained human configuration must not be included by a normal git add.
    writeFileSync(join(workspace, rootRel, '.gitignore'), '*\n', { mode: 0o600 });
  }
  const present = [];
  for (const rel of paths) {
    assertSafeWorkspaceTarget(workspace, rel, { allowLeafSymlink: !protectedBackup });
    const source = join(workspace, rel);
    if (!pathExists(source)) continue;
    const destination = join(backup, rel); mkdirSync(dirname(destination), { recursive: true });
    copySnapshot(source, destination);
    if (protectedBackup) { chmodSync(dirname(destination), 0o700); chmodSync(destination, 0o600); }
    present.push(rel);
  }
  // Durably materialize every regular backup leaf and the recovery directory metadata.
  const syncTree = (path) => { for (const entry of readdirSync(path, { withFileTypes: true })) { const child = join(path, entry.name); if (entry.isDirectory()) syncTree(child); else if (!entry.isSymbolicLink()) fsyncPath(child); } fsyncPath(path); };
  syncTree(join(workspace, rootRel));
  fsyncPath(join(workspace, RECOVERY_REL_PATH));
  fsyncPath(dirname(join(workspace, RECOVERY_REL_PATH)));
  return { backup: backupRel, present, rootRel };
}
function restoreTouchedPaths(workspace, journal) {
  // Validate the complete recovery source before removing any current target.
  for (const rel of journal.present) {
    const source = assertSafeWorkspaceTarget(workspace, join(journal.backup, rel), { allowLeafSymlink: !journal.originalModes });
    if (!pathExists(source) || (journal.originalModes && !lstatSync(source).isFile())) throw Object.assign(new Error(`transaction backup is missing or invalid for ${rel}; journal preserved for diagnosis`), { unrecoverable: true });
  }
  for (const rel of journal.paths) {
    const path = assertSafeWorkspaceTarget(workspace, rel);
    if (pathExists(path) && lstatSync(path).isSymbolicLink()) unlinkSync(path);
    else rmSync(path, { recursive: true, force: true });
  }
  for (const rel of journal.present) {
    const source = assertSafeWorkspaceTarget(workspace, join(journal.backup, rel));
    if (!pathExists(source)) throw Object.assign(new Error(`transaction backup is missing ${rel}; journal preserved for diagnosis`), { unrecoverable: true });
    // The prior target was removed above. Reject any newly introduced leaf or
    // parent link before copying; a backed-up leaf symlink itself remains a
    // legitimate object because cpSync does not dereference it.
    const destination = assertSafeWorkspaceTarget(workspace, rel, { allowLeafSymlink: false });
    mkdirSync(dirname(destination), { recursive: true }); copySnapshot(source, destination);
    if (journal.originalModes?.[rel] !== undefined) {
      const fd = openSync(destination, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (!fstatSync(fd).isFile()) throw new Error('mode restoration requires a regular file');
        fchmodSync(fd, journal.originalModes[rel]);
      } finally { closeSync(fd); }
    }
  }
}
function readJournal(workspace) { return validateJournal(workspace, JSON.parse(readFileSync(journalPath(workspace), "utf8"))); }
export function transactionRecovery(workspace) {
  if (!existsSync(journalPath(workspace))) return { pending: false, recoverable: false };
  try { const journal = readJournal(workspace); return { pending: true, recoverable: journal.phase === "committed" || existsSync(join(workspace, journal.backup)), phase: journal.phase }; }
  catch (error) { return { pending: true, recoverable: false, error: error.message }; }
}
export function recoverTransaction(workspace) {
  const path = journalPath(workspace); if (!existsSync(path)) return false;
  let journal;
  try { journal = readJournal(workspace); } catch (error) { throw Object.assign(new Error(`transaction journal is unreadable: ${error.message}; preserved for diagnosis`), { unrecoverable: true }); }
  if (journal.phase !== "committed") {
    if (!existsSync(join(workspace, journal.backup))) throw Object.assign(new Error("transaction backup is missing; journal preserved for diagnosis"), { unrecoverable: true });
    restoreTouchedPaths(workspace, journal);
  }
  if (!(journal.phase === 'committed' && journal.preserveBackup)) rmSync(join(workspace, dirname(journal.backup)), { recursive: true, force: true });
  rmSync(path, { force: true });
  return { recovered: journal.phase !== "committed", finalized: journal.phase === "committed", phase: journal.phase };
}
/** Explicit diagnostic discard; never called automatically. */
export function discardUnrecoverableTransaction(workspace) { rmSync(journalPath(workspace), { force: true }); }

export function runTransaction({ workspace, plan, manifest, validate = () => {}, commit, failAt = null, lockHeld = false }) {
  validate();
  if (existsSync(journalPath(workspace))) throw new Error("pending transaction journal exists; run doctor --fix before replanning");
  const lock = lockHeld ? null : acquireWorkspaceLock(workspace, plan?.verb ?? "transaction");
  let journal;
  try {
    assertPlanFingerprints(plan ?? { workspace }, manifest);
    const paths = plan ? touchedPaths(plan, manifest) : [];
    const saved = backupTouchedPaths(workspace, paths, Boolean(plan?.preserveBackup));
    if (plan) plan.backup = saved.backup;
    journal = { schemaVersion: 3, phase: "prepared", backup: saved.backup, paths, present: saved.present, ...(plan?.preserveBackup ? { preserveBackup: true, originalModes: Object.fromEntries(saved.present.map(rel => [rel, lstatSync(join(workspace, rel)).mode & 0o777])) } : {}) };
    mkdirSync(dirname(journalPath(workspace)), { recursive: true }); durableJson(journalPath(workspace), journal);
    if (failAt === "after-journal") throw new Error("injected transaction interruption");
    journal.phase = "applying"; durableJson(journalPath(workspace), journal);
    const result = commit();
    if (failAt === "after-commit") throw new Error("injected transaction interruption");
    journal.phase = "committed"; durableJson(journalPath(workspace), journal);
    if (failAt === "after-durable-commit") throw Object.assign(new Error("files committed; cleanup incomplete"), { postCommit: true });
    if (!journal.preserveBackup) rmSync(join(workspace, dirname(journal.backup)), { recursive: true, force: true });
    rmSync(journalPath(workspace), { force: true });
    return result;
  } catch (error) {
    if (journal && journal.phase !== "committed") {
      try { restoreTouchedPaths(workspace, journal); rmSync(join(workspace, dirname(journal.backup)), { recursive: true, force: true }); rmSync(journalPath(workspace), { force: true }); }
      catch (rollback) { throw Object.assign(new Error(`apply failed: ${error.message}; rollback failed: ${rollback.message}; recovery diagnostics preserved`), { rollbackFailed: true }); }
    }
    throw error;
  } finally { lock?.release(); }
}
