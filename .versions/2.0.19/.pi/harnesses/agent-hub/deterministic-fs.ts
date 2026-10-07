import { createHash, randomUUID } from "node:crypto";
import { closeSync, copyFileSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { decodeDeterministicHandle } from "../lib/deterministic-handle-path.ts";
export { deterministicHandlePath } from "../lib/deterministic-handle-path.ts";

export const INVENTORY_PAGE_ENTRIES = 500;
export const CONTENT_REPLY_BYTES = 64 * 1024;
export const PREVIEW_CHARS = 180;

type Handle = { v: 1; kind: "file" | "inventory"; path: string; hash: string; offset: number };
export class PathOutsideAllowedRootError extends Error {}
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const within = (root: string, target: string) => { const rel = relative(resolve(root), resolve(target)); return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel)); };
const encode = (value: Handle) => `t5:${Buffer.from(JSON.stringify(value)).toString("base64url")}`;
const decode = decodeDeterministicHandle;
function checkedExisting(path: string, allowedRoot = dirname(resolve(path))): string {
 const lexical = resolve(path), root = resolve(allowedRoot);
 if (!within(root, lexical)) throw new PathOutsideAllowedRootError(`Path outside allowed root: ${path}`);
 let cursor = lexical;
 while (!existsSync(cursor) && dirname(cursor) !== cursor) cursor = dirname(cursor);
 const rootReal = realpathSync(root), cursorReal = realpathSync(cursor);
 if (!within(rootReal, cursorReal)) throw new Error(`Symlink escape outside allowed root: ${path}`);
 return lexical;
}
function hashAndSize(path: string): { size: number; hash: string } {
 const fd = openSync(path, "r");
 try {
  const size = fstatSync(fd).size, hash = createHash("sha256"), chunk = Buffer.alloc(64 * 1024);
  let offset = 0;
  while (offset < size) {
   const n = readSync(fd, chunk, 0, Math.min(chunk.length, size - offset), offset);
   if (n <= 0) break;
   hash.update(chunk.subarray(0, n));
   offset += n;
  }
  return { size, hash: hash.digest("hex") };
 } finally { closeSync(fd); }
}
function readWindow(path: string, offset: number, length: number): Buffer {
 const fd = openSync(path, "r");
 try {
  const buf = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
   const n = readSync(fd, buf, filled, length - filled, offset + filled);
   if (n <= 0) break;
   filled += n;
  }
  return buf.subarray(0, filled);
 } finally { closeSync(fd); }
}
function lineAtFile(path: string, offset: number): number {
 if (offset <= 0) return 1;
 const fd = openSync(path, "r");
 try {
  const chunk = Buffer.alloc(64 * 1024);
  let seen = 0, lines = 1;
  while (seen < offset) {
   const n = readSync(fd, chunk, 0, Math.min(chunk.length, offset - seen), seen);
   if (n <= 0) break;
   for (let i = 0; i < n; i++) if (chunk[i] === 10) lines++;
   seen += n;
  }
  return lines;
 } finally { closeSync(fd); }
}
function fileState(path: string, allowedRoot?: string) {
 const checked = checkedExisting(path, allowedRoot);
 if (!existsSync(checked) || !statSync(checked).isFile()) throw new Error(`Not a regular file: ${path}`);
 return { path: checked, ...hashAndSize(checked) };
}
function directoryState(root: string, authorizePath?: (path: string) => void) {
 const checked = checkedExisting(root, root);
 if (!statSync(checked).isDirectory()) throw new Error(`Not a directory: ${root}`);
 const rootReal = realpathSync(checked);
 const entries = readdirSync(checked, { withFileTypes: true }).filter(entry => {
  if (!authorizePath) return true;
  try { authorizePath(join(checked, entry.name)); return true; } catch { return false; }
 }).sort((a, b) => a.name.localeCompare(b.name)).map(entry => {
  const path = join(checked, entry.name), lst = lstatSync(path);
  if (lst.isSymbolicLink()) {
   try {
    if (!within(rootReal, realpathSync(path))) return { name: entry.name, path, type: "symlink", bytes: null, denied: true, reason: "symlink-target-outside-root" };
   } catch {
    return { name: entry.name, path, type: "symlink", bytes: null, denied: true, reason: "symlink-target-unavailable" };
   }
  }
  return { name: entry.name, path, type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : entry.isSymbolicLink() ? "symlink" : "other", bytes: entry.isFile() ? lst.size : null };
 });
 return { root: checked, entries, hash: sha256(JSON.stringify(entries)) };
}
function utf8Preview(bytes: Buffer, chars = PREVIEW_CHARS): string {
 return [...bytes.toString("utf8")].slice(0, chars).join("");
}
export function inventory(input: { root: string; handle?: string; pageSize?: number; boundedOutput?: boolean; followSymlinkEscape?: boolean; authorizePath?: (path: string) => void }) {
 if (input.followSymlinkEscape) throw new Error("Symlink escape following is forbidden");
 const state = directoryState(input.root, input.authorizePath);
 let offset = 0;
 if (input.handle) {
  const handle = decode(input.handle);
  if (handle.kind !== "inventory" || resolve(handle.path) !== state.root || handle.hash !== state.hash) throw new Error("Stale inventory handle");
  offset = handle.offset;
 }
 const requested = input.pageSize ?? INVENTORY_PAGE_ENTRIES;
 const pageSize = input.boundedOutput === false ? requested : Math.min(requested, INVENTORY_PAGE_ENTRIES);
 const entries = state.entries.slice(offset, offset + pageSize), nextOffset = offset + entries.length;
 const nextHandle = nextOffset < state.entries.length ? encode({ v: 1, kind: "inventory", path: state.root, hash: state.hash, offset: nextOffset }) : null;
 return { root: state.root, totalEntries: state.entries.length, entries, handle: input.handle ?? encode({ v: 1, kind: "inventory", path: state.root, hash: state.hash, offset }), nextHandle, truncated: nextHandle !== null, untrusted: true, modelDelegated: false };
}

export function excerpt(input: { path: string; allowedRoot?: string; handle?: string; offset?: number; maxBytes?: number; previewChars?: number; boundedOutput?: boolean }) {
 const state = fileState(input.path, input.allowedRoot);
 let offset = input.offset ?? 0;
 if (input.handle) {
  const handle = decode(input.handle);
  if (handle.kind !== "file" || resolve(handle.path) !== state.path || handle.hash !== state.hash) throw new Error("Stale file handle");
  offset = handle.offset;
 }
 if (!Number.isSafeInteger(offset) || offset < 0 || offset > state.size) throw new Error("Invalid excerpt offset");
 const requested = input.maxBytes ?? (input.boundedOutput === false ? state.size : CONTENT_REPLY_BYTES);
 const maxBytes = input.boundedOutput === false ? requested : Math.min(requested, CONTENT_REPLY_BYTES);
 const content = readWindow(state.path, offset, Math.min(maxBytes, state.size - offset));
 const nextOffset = offset + content.length, nextHandle = nextOffset < state.size ? encode({ v: 1, kind: "file", path: state.path, hash: state.hash, offset: nextOffset }) : null;
 return { path: state.path, reference: `${state.path}:${lineAtFile(state.path, offset)}`, hash: state.hash, offset, content: Buffer.from(content), contentBytes: content.length, totalBytes: state.size, preview: utf8Preview(content, Math.min(input.previewChars ?? PREVIEW_CHARS, PREVIEW_CHARS)), onDiskHandle: encode({ v: 1, kind: "file", path: state.path, hash: state.hash, offset }), nextHandle, truncated: nextHandle !== null, untrusted: true, modelDelegated: false };
}

export function readback(input: { handle: string; expectedHash?: string; allowedRoot?: string; maxBytes?: number; boundedOutput?: boolean }) {
 const handle = decode(input.handle);
 if (handle.kind !== "file") throw new Error("Readback requires a file handle");
 const state = fileState(handle.path, input.allowedRoot);
 if (state.hash !== handle.hash || (input.expectedHash && state.hash !== input.expectedHash)) throw new Error("Stale file handle: source bytes changed");
 return excerpt({ path: state.path, allowedRoot: input.allowedRoot, offset: handle.offset, maxBytes: input.maxBytes, boundedOutput: input.boundedOutput });
}

export function snapshotSource(input: { origin: "file"; path: string; allowedRoot?: string; sessionDir?: string }) {
 if (input.origin !== "file") throw new Error(`Unsupported origin ${String(input.origin)}: snapshots accept local files only and never fetch the network`);
 const state = fileState(input.path, input.allowedRoot);
 const sessionDir = resolve(input.sessionDir ?? join(dirname(state.path), ".snapshots"));
 mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
 const root = checkedExisting(sessionDir, sessionDir);
 const dir = join(root, "artifacts", "evidence", "snapshots"); mkdirSync(dir, { recursive: true, mode: 0o700 }); checkedExisting(dir, root);
 const contentPath = join(dir, `${state.hash}-${basename(state.path)}`);
 if (!existsSync(contentPath)) copyFileSync(state.path, contentPath);
 else {
  const existing = fileState(contentPath, root);
  if (existing.hash !== state.hash) throw new Error(`Snapshot collision or stale target: ${contentPath}`);
 }
 const metadataPath = `${contentPath}.json`;
 if (!existsSync(metadataPath)) writeFileSync(metadataPath, JSON.stringify({ source: { origin: "file", path: state.path, bytes: state.size }, sha256: state.hash, contentPath, untrusted: true, modelDelegated: false }, null, 2), { mode: 0o600 });
 else checkedExisting(metadataPath, root);
 return { source: { origin: "file" as const, path: state.path, bytes: state.size }, hash: state.hash, contentPath, metadataPath, handle: encode({ v: 1, kind: "file", path: contentPath, hash: state.hash, offset: 0 }), untrusted: true, modelDelegated: false };
}

function utf8Prefix(buffer: Buffer, maxBytes: number): Buffer {
 let end = Math.min(maxBytes, buffer.length);
 while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
 return buffer.subarray(0, end);
}
export function boundOutput(input: { content: string | Buffer; retentionDir: string; label?: string }) {
 const bytes = Buffer.isBuffer(input.content) ? input.content : Buffer.from(input.content, "utf8");
 const dir = resolve(input.retentionDir); mkdirSync(dir, { recursive: true, mode: 0o700 });
 const hash = sha256(bytes), contentPath = join(dir, `${input.label ?? "output"}-${randomUUID()}`); writeFileSync(contentPath, bytes, { mode: 0o600 });
 const handle = encode({ v: 1, kind: "file", path: contentPath, hash, offset: 0 });
 if (bytes.length <= CONTENT_REPLY_BYTES) return { reply: bytes.toString("utf8"), contentPath, handle, hash, totalBytes: bytes.length, truncated: false };
 const suffix = Buffer.from(`\n\n[truncated: ${bytes.length} bytes total; full output handle ${handle}; path ${contentPath}]`, "utf8");
 const prefix = utf8Prefix(bytes, CONTENT_REPLY_BYTES - suffix.length);
 return { reply: Buffer.concat([prefix, suffix]).toString("utf8"), contentPath, handle, hash, totalBytes: bytes.length, truncated: true };
}
