import { createHash, randomUUID } from "node:crypto";
import { closeSync, copyFileSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, statSync, writeFileSync, type BigIntStats } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { decodeDeterministicHandle } from "../lib/deterministic-handle-path.ts";
export { deterministicHandlePath } from "../lib/deterministic-handle-path.ts";

export const INVENTORY_PAGE_ENTRIES = 500;
export const CONTENT_REPLY_BYTES = 64 * 1024;
export const PREVIEW_CHARS = 180;

type Handle = { v: 1; kind: "file" | "inventory"; path: string; hash: string; offset: number };
export type FilePageEncoding = "utf8" | "base64";
type FilePageOptions = { maxBytes?: number; previewChars?: number; boundedOutput?: boolean; encoding?: FilePageEncoding };
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
// Paging through a large file must not rehash it, or rescan it for a line number, on
// every page. A digest is reused only for the same device, inode, size and nanosecond
// mtime/ctime, and never for a file changed within the last two seconds: a coarse
// filesystem clock could not yet distinguish a same-size rewrite there.
const DIGEST_ENTRIES = 64, LINE_MARKS = 256, SETTLED_MS = 2_000;
const digests = new Map<string, { hash: string; lines: Map<number, number> }>();
type FileVersion = Pick<BigIntStats, "dev" | "ino" | "size" | "mtimeNs" | "ctimeNs">;
const fileVersion = (stat: FileVersion) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
export function digestCacheKey(stat: FileVersion, now = Date.now()): string | null {
 const changedMs = Number((stat.mtimeNs > stat.ctimeNs ? stat.mtimeNs : stat.ctimeNs) / 1_000_000n);
 return now - changedMs > SETTLED_MS ? fileVersion(stat) : null;
}
function hashAndSize(path: string) {
 const fd = openSync(path, "r");
 try {
  const stat = fstatSync(fd, { bigint: true }), size = Number(stat.size), key = digestCacheKey(stat), version = fileVersion(stat);
  const cached = key ? digests.get(key) : undefined;
  if (cached) { digests.delete(key!); digests.set(key!, cached); return { size, hash: cached.hash, key, version }; }
  const hash = createHash("sha256"), chunk = Buffer.alloc(64 * 1024);
  let offset = 0;
  while (offset < size) {
   const n = readSync(fd, chunk, 0, Math.min(chunk.length, size - offset), offset);
   if (n <= 0) break;
   hash.update(chunk.subarray(0, n));
   offset += n;
  }
  const digest = hash.digest("hex");
  if (key) { digests.set(key, { hash: digest, lines: new Map() }); if (digests.size > DIGEST_ENTRIES) digests.delete(digests.keys().next().value!); }
  return { size, hash: digest, key, version };
 } finally { closeSync(fd); }
}
function markLine(key: string | null, offset: number, line: number) {
 const marks = key ? digests.get(key)?.lines : undefined;
 if (!marks || marks.has(offset)) return;
 marks.set(offset, line); if (marks.size > LINE_MARKS) marks.delete(marks.keys().next().value!);
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
function lineAtFile(path: string, offset: number, key: string | null = null): number {
 if (offset <= 0) return 1;
 let seen = 0, lines = 1;
 for (const [at, line] of (key ? digests.get(key)?.lines : undefined) ?? []) if (at <= offset && at > seen) { seen = at; lines = line; }
 if (seen === offset) return lines;
 const fd = openSync(path, "r");
 try {
  const chunk = Buffer.alloc(64 * 1024);
  while (seen < offset) {
   const n = readSync(fd, chunk, 0, Math.min(chunk.length, offset - seen), seen);
   if (n <= 0) break;
   for (let i = 0; i < n; i++) if (chunk[i] === 10) lines++;
   seen += n;
  }
  markLine(key, offset, lines);
  return lines;
 } finally { closeSync(fd); }
}
const newlines = (bytes: Buffer) => { let count = 0; for (let index = bytes.indexOf(10); index >= 0; index = bytes.indexOf(10, index + 1)) count++; return count; };
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
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });
const utf8Continuation = (byte: number | undefined) => byte !== undefined && (byte & 0xc0) === 0x80;

/** Validate through the end of a character that straddles the page boundary. */
function utf8Page(window: Buffer, maxBytes: number, offset: number): Buffer {
 if (offset > 0 && utf8Continuation(window[0])) throw new Error("Offset is not at a UTF-8 character boundary. Use an aligned offset or encoding=base64.");
 const page = utf8Prefix(window, maxBytes);
 let end = Math.min(maxBytes, window.length);
 while (utf8Continuation(window[end])) end++;
 try { strictUtf8.decode(window.subarray(0, end)); }
 catch { throw new Error("Invalid UTF-8 in this page. Use encoding=base64 for exact bytes."); }
 if (page.length === 0 && end > 0) throw new Error(`The next UTF-8 character needs ${end} bytes. Increase max_bytes or use encoding=base64.`);
 return page;
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

function filePage(state: ReturnType<typeof fileState>, offset: number, input: FilePageOptions) {
 if (!Number.isSafeInteger(offset) || offset < 0 || offset > state.size) throw new Error("Invalid excerpt offset");
 if (input.maxBytes !== undefined && (!Number.isSafeInteger(input.maxBytes) || input.maxBytes <= 0)) throw new Error("Invalid max_bytes; use a positive integer");
 // Base64 uses four output bytes for every three source bytes.
 const limit = input.encoding === "base64" ? Math.floor(CONTENT_REPLY_BYTES / 4) * 3 : CONTENT_REPLY_BYTES;
 const requested = input.maxBytes ?? (input.boundedOutput === false ? state.size : limit);
 const maxBytes = input.boundedOutput === false ? requested : Math.min(requested, limit);
 const length = Math.min(maxBytes + (input.encoding === "utf8" ? 3 : 0), state.size - offset);
 const window = readWindow(state.path, offset, length);
 const line = lineAtFile(state.path, offset, state.key);
 if (window.length !== length || fileVersion(statSync(state.path, { bigint: true })) !== state.version) throw new Error("File changed during read");
 const content = input.encoding === "utf8" ? utf8Page(window, maxBytes, offset) : window;
 const nextOffset = offset + content.length, nextHandle = nextOffset < state.size ? encode({ v: 1, kind: "file", path: state.path, hash: state.hash, offset: nextOffset }) : null;
 if (nextHandle) markLine(state.key, nextOffset, line + newlines(content));
 const preview = input.encoding === "base64" ? "" : utf8Preview(content, Math.min(input.previewChars ?? PREVIEW_CHARS, PREVIEW_CHARS));
 return { path: state.path, reference: `${state.path}:${line}`, hash: state.hash, offset, content, contentBytes: content.length, totalBytes: state.size, preview, onDiskHandle: encode({ v: 1, kind: "file", path: state.path, hash: state.hash, offset }), nextHandle, truncated: nextHandle !== null, untrusted: true, modelDelegated: false };
}

export function excerpt(input: FilePageOptions & { path: string; allowedRoot?: string; handle?: string; offset?: number }) {
 const state = fileState(input.path, input.allowedRoot);
 if (!input.handle) return filePage(state, input.offset ?? 0, input);
 const handle = decode(input.handle);
 if (handle.kind !== "file" || resolve(handle.path) !== state.path || handle.hash !== state.hash) throw new Error("Stale file handle");
 return filePage(state, handle.offset, input);
}

export function readback(input: FilePageOptions & { handle: string; expectedHash?: string; allowedRoot?: string }) {
 const handle = decode(input.handle);
 if (handle.kind !== "file") throw new Error("Readback requires a file handle");
 const state = fileState(handle.path, input.allowedRoot);
 if (state.hash !== handle.hash || (input.expectedHash && state.hash !== input.expectedHash)) throw new Error("Stale file handle: source bytes changed");
 return filePage(state, handle.offset, input);
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
 while (end > 0 && utf8Continuation(buffer[end])) end--;
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
