// transaction.js — durable, crash-recoverable managed workspace commits.
import { closeSync, cpSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { STATE_REL_PATH, LEGACY_RECORD_REL_PATH } from "./state.js";
import { acquireWorkspaceLock, assertSafeWorkspaceTarget, ownedRelativePath } from "./workspace-safety.js";

export const JOURNAL_REL_PATH = ".ai/agent-fleet-transaction.json";
export const RECOVERY_REL_PATH = ".ai/.agent-fleet-recovery";
const DESIRED_REL_PATH = ".ai/agent-fleet.json";
const OVERRIDES_REL_PATH = ".ai/agent-fleet-overrides.md";
const STT_REL_PATH = ".ai/stt.json";
export function journalPath(workspace) { return join(workspace, JOURNAL_REL_PATH); }

function sourceLeaves(path) {
  if (!statSync(path).isDirectory()) return [""];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => sourceLeaves(join(path, entry.name)).map((leaf) => join(entry.name, leaf)));
}

export function touchedPaths(plan, manifest) {
  const paths = new Set([STATE_REL_PATH, LEGACY_RECORD_REL_PATH]);
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
  if (plan?.stt?.env?.missing?.length) paths.add(ownedRelativePath(plan.workspace, plan.stt.env.path));
  const collapseManagedLink = (value) => {
    const rel = ownedRelativePath(plan.workspace, value); const parts = rel.split(/[/\\]/); let cursor = plan.workspace;
    for (let i = 0; i < parts.length - 1; i++) { cursor = join(cursor, parts[i]); if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) return parts.slice(0, i + 1).join("/"); }
    return rel;
  };
  return [...new Set([...paths].map(collapseManagedLink))].sort();
}

function fingerprint(path) {
  if (!existsSync(path)) return "absent";
  const stat = lstatSync(path);
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
    if (fingerprint(join(plan.workspace, rel)) !== expected) throw new Error(`workspace changed since preview: ${rel}; re-run setup`);
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
  value.backup = ownedRelativePath(workspace, value.backup, "journal backup");
  if (!value.backup.startsWith(`${RECOVERY_REL_PATH}/`) && value.backup !== RECOVERY_REL_PATH) throw new Error("transaction backup is not installer-owned");
  for (const rel of value.paths) assertSafeWorkspaceTarget(workspace, rel);
  assertSafeWorkspaceTarget(workspace, value.backup, { allowLeafSymlink: false });
  return value;
}
function backupTouchedPaths(workspace, paths) {
  const rootRel = join(RECOVERY_REL_PATH, randomUUID());
  const backupRel = join(rootRel, "backup");
  const backup = assertSafeWorkspaceTarget(workspace, backupRel, { allowLeafSymlink: false });
  mkdirSync(backup, { recursive: true });
  const present = [];
  for (const rel of paths) {
    assertSafeWorkspaceTarget(workspace, rel);
    const source = join(workspace, rel);
    if (!existsSync(source)) continue;
    const destination = join(backup, rel); mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination, { recursive: true, dereference: false }); present.push(rel);
  }
  // Durably materialize every regular backup leaf and the recovery directory metadata.
  const syncTree = (path) => { for (const entry of readdirSync(path, { withFileTypes: true })) { const child = join(path, entry.name); if (entry.isDirectory()) syncTree(child); else if (!entry.isSymbolicLink()) fsyncPath(child); } fsyncPath(path); };
  syncTree(join(workspace, rootRel));
  return { backup: backupRel, present, rootRel };
}
function restoreTouchedPaths(workspace, journal) {
  for (const rel of journal.paths) { assertSafeWorkspaceTarget(workspace, rel); rmSync(join(workspace, rel), { recursive: true, force: true }); }
  for (const rel of journal.present) {
    const source = assertSafeWorkspaceTarget(workspace, join(journal.backup, rel));
    if (!existsSync(source)) throw Object.assign(new Error(`transaction backup is missing ${rel}; journal preserved for diagnosis`), { unrecoverable: true });
    // The prior target was removed above. Reject any newly introduced leaf or
    // parent link before copying; a backed-up leaf symlink itself remains a
    // legitimate object because cpSync does not dereference it.
    const destination = assertSafeWorkspaceTarget(workspace, rel, { allowLeafSymlink: false });
    mkdirSync(dirname(destination), { recursive: true }); cpSync(source, destination, { recursive: true, dereference: false });
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
  rmSync(join(workspace, dirname(journal.backup)), { recursive: true, force: true }); rmSync(path, { force: true });
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
    const saved = backupTouchedPaths(workspace, paths);
    journal = { schemaVersion: 3, phase: "prepared", backup: saved.backup, paths, present: saved.present };
    mkdirSync(dirname(journalPath(workspace)), { recursive: true }); durableJson(journalPath(workspace), journal);
    if (failAt === "after-journal") throw new Error("injected transaction interruption");
    journal.phase = "applying"; durableJson(journalPath(workspace), journal);
    const result = commit();
    if (failAt === "after-commit") throw new Error("injected transaction interruption");
    journal.phase = "committed"; durableJson(journalPath(workspace), journal);
    if (failAt === "after-durable-commit") throw Object.assign(new Error("files committed; cleanup incomplete"), { postCommit: true });
    rmSync(join(workspace, dirname(journal.backup)), { recursive: true, force: true }); rmSync(journalPath(workspace), { force: true });
    return result;
  } catch (error) {
    if (journal && journal.phase !== "committed") {
      try { restoreTouchedPaths(workspace, journal); rmSync(join(workspace, dirname(journal.backup)), { recursive: true, force: true }); rmSync(journalPath(workspace), { force: true }); }
      catch (rollback) { throw Object.assign(new Error(`apply failed: ${error.message}; rollback failed: ${rollback.message}; recovery diagnostics preserved`), { rollbackFailed: true }); }
    }
    throw error;
  } finally { lock?.release(); }
}
