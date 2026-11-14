// @ts-nocheck
// Caller-owned session I/O boundary; consumers use this snapshot, never legacy files.
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeSystem1Config } from './config-v2.js';
import { parseConfigJson } from './config-json.js';
import { system1SelectedByDesired } from './selection.js';
import { workspaceRoot, sessionRootsFromEnv } from '../workspace-context.js';
import { gateWorktreeSnapshot, projectWorktreeDocument } from './worktree-scopes.js';
const MAX_CONFIG_BYTES = 1024 * 1024;
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
function readWorkspaceJson(root, name) {
 let fd;
 try {
  const parent = join(root, '.ai');
  const parentStat = lstatSync(parent);
  if (!parentStat.isDirectory()) return null;
  const path = join(parent, name);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) return null;
  if (typeof constants.O_NOFOLLOW !== 'number') return null;
  fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const opened = fstatSync(fd);
  const currentParent = lstatSync(parent);
  if (!opened.isFile() || opened.size > MAX_CONFIG_BYTES || !sameFile(stat, opened) || !currentParent.isDirectory() || !sameFile(parentStat, currentParent)) return null;
  // Bound actual reads as well as metadata: a concurrently growing file is refused.
  const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
  let length = 0, count;
  while (length < buffer.length && (count = readSync(fd, buffer, length, buffer.length - length, null)) > 0) length += count;
  if (length > MAX_CONFIG_BYTES) return null;
  const after = fstatSync(fd);
  if (opened.size !== after.size || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs) return null;
  return parseConfigJson(buffer.toString('utf8', 0, length));
 } catch (error) { return error.code === 'ENOENT' ? undefined : null; }
 finally { if (fd !== undefined) closeSync(fd); }
}
export function readSystem1Document(root,binding=sessionRootsFromEnv()) { return readWorkspaceJson(binding?.workspaceRoot??root, 'system1.json'); }
export function loadSystem1Snapshot(root,binding=sessionRootsFromEnv()) {
 const document=readSystem1Document(root,binding);
 try {
  const effectiveDocument=projectWorktreeDocument(document,binding);
  const snapshot=normalizeSystem1Config(effectiveDocument);
  return gateWorktreeSnapshot(effectiveDocument===document?snapshot:Object.freeze({...snapshot,document,effectiveDocument}),binding);
 } catch { return Object.freeze({...normalizeSystem1Config(null),targetReason:'ambiguous_worktree_scope'}); }
}
export function readSystem1Selected(root) {
 return system1SelectedByDesired(readWorkspaceJson(workspaceRoot(root), 'agent-fleet.json'));
}
export function providerDocument(snapshot) {
 if (snapshot.status === 'missing') return undefined;
 if (snapshot.status === 'migration_required') return snapshot.legacyProvider;
 return snapshot.provider ?? null;
}
