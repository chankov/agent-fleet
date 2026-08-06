// transaction.js — crash-recoverable managed workspace commits.

import { closeSync, cpSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, relative, sep } from "node:path";
import { STATE_REL_PATH, LEGACY_RECORD_REL_PATH } from "./state.js";

export const JOURNAL_REL_PATH = ".ai/agent-fleet-transaction.json";
const DESIRED_REL_PATH = ".ai/agent-fleet.json";
const OVERRIDES_REL_PATH = ".ai/agent-fleet-overrides.md";
const STT_REL_PATH = ".ai/stt.json";

export function journalPath(workspace) { return join(workspace, JOURNAL_REL_PATH); }

function relativeOwnedPath(workspace, path) {
  const rel = relative(workspace, resolve(workspace, path));
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || rel.split(sep).includes("..")) {
    throw new Error(`transaction path is outside the workspace: ${path}`);
  }
  return rel;
}

// Never snapshot the workspace root or a broad target directory: a transaction
// owns only the exact files its plan can alter. This deliberately leaves .git,
// foreign files, and concurrently-created siblings untouched.
function sourceLeaves(path) {
  if (!statSync(path).isDirectory()) return [""];
  const leaves = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    for (const leaf of sourceLeaves(child)) leaves.push(join(entry.name, leaf));
  }
  return leaves;
}

function touchedPaths(plan, manifest) {
  const paths = new Set([STATE_REL_PATH, LEGACY_RECORD_REL_PATH]);
  const catalogue = new Map((manifest?.items ?? []).map((item) => [item.id, item]));
  for (const action of plan.actions ?? []) {
    for (const file of action.files ?? []) if (file.path) paths.add(file.path);
    for (const path of action.paths ?? []) if (path) paths.add(path);
    const binding = catalogue.get(action.id)?.agents?.[plan.agent];
    if (!binding?.target) continue;
    const source = (binding.source ?? []).map((path) => join(plan.sourceRoot, path)).find(existsSync);
    if (binding.strategy === "copy-tree" && source) {
      for (const leaf of sourceLeaves(source)) paths.add(join(binding.target, leaf));
    } else {
      paths.add(binding.target);
    }
  }
  if (plan.writeDesired) paths.add(relativeOwnedPath(plan.workspace, plan.desiredPath ?? DESIRED_REL_PATH));
  if (plan.overrides?.write) paths.add(relativeOwnedPath(plan.workspace, plan.overrides.path ?? OVERRIDES_REL_PATH));
  if (plan.stt?.path) paths.add(relativeOwnedPath(plan.workspace, plan.stt.path ?? STT_REL_PATH));
  if (plan.stt?.env?.missing?.length) paths.add(relativeOwnedPath(plan.workspace, plan.stt.env.path));
  return [...paths].map((path) => relativeOwnedPath(plan.workspace, path)).sort();
}

function backupTouchedPaths(workspace, paths) {
  const backup = join(tmpdir(), `agent-fleet-tx-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(backup, { recursive: true });
  const present = [];
  for (const rel of paths) {
    const source = join(workspace, rel);
    if (!existsSync(source)) continue;
    const destination = join(backup, rel);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination, { recursive: true, dereference: false });
    present.push(rel);
  }
  return { backup, present };
}

function restoreTouchedPaths(workspace, journal) {
  for (const rel of journal.paths ?? []) rmSync(join(workspace, rel), { recursive: true, force: true });
  for (const rel of journal.present ?? []) {
    const source = join(journal.backup, rel);
    if (!existsSync(source)) continue;
    const destination = join(workspace, rel);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination, { recursive: true, dereference: false });
  }
}

export function transactionRecovery(workspace) {
  const path = journalPath(workspace);
  if (!existsSync(path)) return { pending: false, recoverable: false };
  try {
    const journal = JSON.parse(readFileSync(path, "utf8"));
    return { pending: true, recoverable: Boolean(journal.backup && existsSync(journal.backup)) };
  } catch {
    return { pending: true, recoverable: false };
  }
}

/** Restore an interrupted transaction, returning false when none exists. */
export function recoverTransaction(workspace) {
  const path = journalPath(workspace);
  if (!existsSync(path)) return false;
  let journal;
  try { journal = JSON.parse(readFileSync(path, "utf8")); }
  catch { throw Object.assign(new Error("transaction journal is unreadable or has no recoverable backup"), { unrecoverable: true }); }
  if (!journal.backup || !existsSync(journal.backup)) {
    throw Object.assign(new Error("transaction journal has no recoverable backup"), { unrecoverable: true });
  }
  restoreTouchedPaths(workspace, journal);
  rmSync(journal.backup, { recursive: true, force: true });
  rmSync(path, { force: true });
  return true;
}

/** The backup was reaped, so only the installer-owned journal can be discarded. */
export function discardUnrecoverableTransaction(workspace) {
  rmSync(journalPath(workspace), { force: true });
}

/**
 * Journal before mutation; restore only managed paths if commit throws.
 * `validate` runs before journal creation, which is critical for conflicts,
 * unsupported snapshot metadata, and rejected migrations.
 */
export function runTransaction({ workspace, plan, manifest, validate = () => {}, commit, failAt = null }) {
  validate();
  const paths = plan ? touchedPaths(plan, manifest) : [];
  const { backup, present } = backupTouchedPaths(workspace, paths);
  const path = journalPath(workspace);
  mkdirSync(dirname(path), { recursive: true });
  const journal = { schemaVersion: 2, backup, paths, present };
  // Durable pre-image: fsync the journal before any managed workspace write.
  const fd = openSync(path, "w");
  try {
    writeSync(fd, JSON.stringify(journal, null, 2) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    if (failAt === "after-journal") throw new Error("injected transaction interruption");
    const result = commit();
    if (failAt === "after-commit") throw new Error("injected transaction interruption");
    rmSync(path, { force: true });
    rmSync(backup, { recursive: true, force: true });
    return result;
  } catch (error) {
    restoreTouchedPaths(workspace, journal);
    rmSync(path, { force: true });
    rmSync(backup, { recursive: true, force: true });
    throw error;
  }
}
