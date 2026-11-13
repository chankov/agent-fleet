import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { notificationPreview, parseNotificationConfiguration } from '../lib/fleet-notification-validation.ts';

const fail = (): never => { throw Error('private_config_invalid_or_changed'); };
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export interface PrivateFileFingerprint { path: string; sha256: string; size: number; dev: number; ino: number; uid: number; mode: number; mtime: number; ctime: number }
export interface PrivateConfigSnapshot { files: PrivateFileFingerprint[]; sources: PrivateFileFingerprint[] }
/** Transport is parent-owned, not a tool parameter. No private body or overridable root. */
export interface PrivateConfigBinding {
 files: string[]; sources: string[]; taskId: string; sessionDir: string; declarationHash: string;
 captureId: string; generation: string; epoch: number;
}
export const PRIVATE_CONFIG_ENV = 'AGENT_FLEET_PRIVATE_CONFIG_CAPTURE';
export function privateConfigRoot(): string { return join(homedir(), '.local/state/agent-fleet/codex-events'); }
function exactPaths(value: unknown, max: number): string[] {
 if (!Array.isArray(value) || !value.length || value.length > max) return fail();
 const paths = value as unknown[];
 if (paths.some(p => typeof p !== 'string' || !p || p.length > 1024 || /[\x00-\x20\x7f\\*?\[\]{}()!]/.test(p) || p.split('/').some((v, i) => (!v && i !== 0) || v === '.' || v === '..')) || new Set(paths).size !== paths.length) return fail();
 return (paths as string[]).slice().sort();
}
function ownedDirectory(path: string): void {
 const stat = lstatSync(path);
 if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o7777) !== 0o700 || realpathSync(path) !== path) fail();
}
function fingerprint(path: string, max: number, privateFile: boolean): { metadata: PrivateFileFingerprint; bytes: Buffer } {
 const before = lstatSync(path);
 const safe = (s: typeof before) => s.isFile() && s.nlink === 1 && s.uid === process.getuid?.() && (privateFile ? [0o400, 0o600].includes(s.mode & 0o7777) : (s.mode & 0o022) === 0) && s.size > 0 && s.size <= max;
 if (!safe(before) || realpathSync(path) !== path) return fail();
 const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
 try {
  const opened = fstatSync(fd);
  if (!safe(opened) || opened.dev !== before.dev || opened.ino !== before.ino) return fail();
  // Bounded reads even if a same-user writer grows the already-opened file.
  const buffer = Buffer.alloc(max + 1); let length = 0, n: number;
  while (length < buffer.length && (n = readSync(fd, buffer, length, buffer.length - length, null)) > 0) length += n;
  const after = fstatSync(fd), current = lstatSync(path);
  const identity = (s: typeof before) => [s.dev, s.ino, s.uid, s.mode, s.nlink, s.size, s.mtimeMs, s.ctimeMs].join(':');
  if (length !== opened.size || length > max || identity(before) !== identity(opened) || identity(opened) !== identity(after) || identity(after) !== identity(current) || realpathSync(path) !== path) return fail();
  const bytes = buffer.subarray(0, length);
  return { bytes, metadata: { path, sha256: hash(bytes), size: length, dev: after.dev, ino: after.ino, uid: after.uid, mode: after.mode, mtime: after.mtimeMs, ctime: after.ctimeMs } };
 } finally { closeSync(fd); }
}
/** Reads only explicit configuration files in the app-owned namespace and declared repo helpers.
 * Errors intentionally discard parser text/paths/private values. Never returns private bytes. */
export function capturePrivateConfig(cwd: string, privateFiles: unknown, verifierSources: unknown): PrivateConfigSnapshot {
 try {
  const root = privateConfigRoot(), files = exactPaths(privateFiles, 4), sources = exactPaths(verifierSources, 32);
  // The namespace cannot be redirected through a mutable or foreign-owned ancestor.
  for (const path of [homedir(), join(homedir(), '.local'), join(homedir(), '.local/state'), join(homedir(), '.local/state/agent-fleet')]) {
   const stat = lstatSync(path);
   if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0 || realpathSync(path) !== path) return fail();
  }
  ownedDirectory(root);
  const fileMetadata = files.map(path => {
   if (!isAbsolute(path) || resolve(path) !== path) return fail();
   const rel = relative(root, path), parts = rel.split('/');
   if (parts.length !== 3 || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(parts[0]) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(parts[1]) || !/^notification(?:-[A-Za-z0-9_-]{1,96})?\.json$/.test(parts[2])) return fail();
   ownedDirectory(join(root, parts[0])); ownedDirectory(join(root, parts[0], parts[1]));
   const { metadata, bytes } = fingerprint(path, 65536, true);
   const config = parseNotificationConfiguration(bytes.toString('utf8'));
   if (config?.approval?.binding?.threadId !== parts[0] || !notificationPreview(config, config?.approval?.target).ready) return fail();
   return metadata;
  });
  const repo = realpathSync(cwd);
  const sourceMetadata = sources.map(path => {
   if (isAbsolute(path) || relative(repo, resolve(repo, path)) !== path || !/\.(?:[cm]?[jt]s|sh|py)$/.test(path)) return fail();
   return { ...fingerprint(resolve(repo, path), 1024 * 1024, false).metadata, path };
  });
  if (new Set([...fileMetadata, ...sourceMetadata].map(f => `${f.dev}:${f.ino}`)).size !== files.length + sources.length) return fail();
  return { files: fileMetadata, sources: sourceMetadata };
 } catch { return fail(); }
}
export function privateConfigRevision(cwd: string, repositoryRevision: string, binding: PrivateConfigBinding): string {
 try {
  if (!/^[a-f0-9]{64}$/.test(repositoryRevision) || !binding || !binding.taskId || !binding.sessionDir || !binding.captureId || !binding.generation || !Number.isSafeInteger(binding.epoch) || !/^[a-f0-9]{64}$/.test(binding.declarationHash)) return 'unavailable';
  return hash(JSON.stringify({ repositoryRevision, binding, snapshot: capturePrivateConfig(cwd, binding.files, binding.sources) }));
 } catch { return 'unavailable'; }
}
