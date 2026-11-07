import { lstatSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { inflateRawSync } from "node:zlib";

/**
 * Minimal reader for the skill archives this package ships (`skills/<name>.zip`,
 * written by `zip -r` per AGENTS.md). It exists so an installer command can
 * unpack a packaged skill without a new dependency and without trusting the
 * archive: every entry is validated and fully inflated in memory before a
 * single byte reaches the destination.
 *
 * Supported: stored (0) and deflate (8) entries, one top-level directory,
 * regular files and directories. Refused: zip64 and multi-disk archives,
 * encryption, other compression methods, symlinks and special files, unsafe
 * paths, duplicates, size or CRC mismatches, and anything over the limits.
 */
export const SKILL_ZIP_LIMITS = Object.freeze({
  maxArchiveBytes: 2 * 1024 * 1024,
  maxEntries: 64,
  maxExtractedBytes: 1024 * 1024,
});

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_RECORD = 0x06054b50;
const END_RECORD_SIZE = 22;
const MAX_COMMENT = 0xffff;
const FLAG_ENCRYPTED = 0x0001;
// Deflate option bits, the data-descriptor bit, and the UTF-8 name bit carry
// no risk for this reader; every other general-purpose flag is refused.
const FLAGS_ALLOWED = 0x0006 | 0x0008 | 0x0800;
const ZIP64_MARKER = 0xffffffff;
const MODE_TYPE_MASK = 0o170000;
const MODE_SYMLINK = 0o120000;
const MODE_REGULAR = 0o100000;
const MODE_DIRECTORY = 0o040000;

const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c;
}

/** CRC-32 (IEEE 802.3), as stored in zip entries. */
export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function fail(message) {
  throw new Error(`skill zip: ${message}`);
}

function parseEntryPath(name) {
  const shown = JSON.stringify(name);
  if (!name || name.includes("\0") || name.includes("\\") || name.startsWith("/")) fail(`unsafe entry path ${shown}`);
  const isDirectory = name.endsWith("/");
  const segments = (isDirectory ? name.slice(0, -1) : name).split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") fail(`unsafe entry path ${shown}`);
  }
  return { path: segments.join("/"), segments, isDirectory };
}

function findEndRecord(bytes) {
  const lowest = Math.max(0, bytes.length - END_RECORD_SIZE - MAX_COMMENT);
  for (let offset = bytes.length - END_RECORD_SIZE; offset >= lowest; offset--) {
    if (bytes.readUInt32LE(offset) === END_RECORD) return offset;
  }
  return fail("end of central directory record not found");
}

/** Parse, validate, and inflate every entry; nothing touches the filesystem. */
function readArchive(bytes) {
  if (bytes.length > SKILL_ZIP_LIMITS.maxArchiveBytes) {
    fail(`archive is ${bytes.length} bytes; the limit is ${SKILL_ZIP_LIMITS.maxArchiveBytes} bytes`);
  }
  const end = findEndRecord(bytes);
  const total = bytes.readUInt16LE(end + 10);
  if (bytes.readUInt16LE(end + 4) !== 0 || bytes.readUInt16LE(end + 6) !== 0 || bytes.readUInt16LE(end + 8) !== total) {
    fail("multi-disk and zip64 archives are not supported");
  }
  if (total > SKILL_ZIP_LIMITS.maxEntries) fail(`archive declares ${total} entries; the limit is ${SKILL_ZIP_LIMITS.maxEntries}`);
  const directorySize = bytes.readUInt32LE(end + 12);
  const directoryOffset = bytes.readUInt32LE(end + 16);
  if (directorySize === ZIP64_MARKER || directoryOffset === ZIP64_MARKER) fail("multi-disk and zip64 archives are not supported");
  if (directoryOffset + directorySize > end) fail("central directory lies outside the archive");

  const entries = [];
  const seen = new Set();
  const topLevel = new Set();
  let declaredBytes = 0;
  let offset = directoryOffset;
  for (let index = 0; index < total; index++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== CENTRAL_HEADER) fail("central directory entry is malformed");
    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const crc = bytes.readUInt32LE(offset + 16);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const size = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const mode = bytes.readUInt32LE(offset + 38) >>> 16;
    const localOffset = bytes.readUInt32LE(offset + 42);
    if (offset + 46 + nameLength > end) fail("central directory entry is malformed");
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    const shown = JSON.stringify(name);
    if (flags & FLAG_ENCRYPTED) fail(`encrypted entry ${shown} is not supported`);
    if (flags & ~FLAGS_ALLOWED) fail(`unsupported general-purpose flags on entry ${shown}`);
    if (compressedSize === ZIP64_MARKER || size === ZIP64_MARKER || localOffset === ZIP64_MARKER) fail("multi-disk and zip64 archives are not supported");
    if (method !== 0 && method !== 8) fail(`unsupported compression method ${method} on entry ${shown}`);
    const type = mode & MODE_TYPE_MASK;
    if (type === MODE_SYMLINK) fail(`symlink entry ${shown} is not supported`);
    const entry = parseEntryPath(name);
    if (entry.isDirectory) {
      if (size !== 0) fail(`directory entry ${shown} declares content`);
      if (type !== 0 && type !== MODE_DIRECTORY) fail(`directory entry ${shown} has a conflicting file type`);
    } else {
      if (type !== 0 && type !== MODE_REGULAR) fail(`entry ${shown} is not a regular file`);
      if (entry.segments.length === 1) fail(`entry ${shown} lies outside the top-level directory`);
      declaredBytes += size;
      if (declaredBytes > SKILL_ZIP_LIMITS.maxExtractedBytes) {
        fail(`declared extracted size exceeds the limit of ${SKILL_ZIP_LIMITS.maxExtractedBytes} bytes`);
      }
    }
    if (seen.has(entry.path)) fail(`duplicate entry ${shown}`);
    seen.add(entry.path);
    topLevel.add(entry.segments[0]);

    if (localOffset + 30 > directoryOffset || bytes.readUInt32LE(localOffset) !== LOCAL_HEADER) fail(`local header of entry ${shown} is malformed`);
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > directoryOffset) fail(`data of entry ${shown} lies outside the archive`);
    if (!bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength).equals(bytes.subarray(offset + 46, offset + 46 + nameLength))) {
      fail(`local header of entry ${shown} names a different path`);
    }
    entries.push({ ...entry, method, crc, size, raw: bytes.subarray(dataStart, dataEnd) });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if (topLevel.size !== 1) fail(`archive must contain exactly one top-level directory, found ${[...topLevel].map(v => JSON.stringify(v)).join(", ") || "none"}`);
  if (!entries.some(entry => !entry.isDirectory)) fail("archive contains no files");

  let bytesTotal = 0;
  for (const entry of entries) {
    const shown = JSON.stringify(entry.path);
    let data;
    if (entry.method === 0) {
      data = entry.raw;
    } else {
      try {
        data = inflateRawSync(entry.raw, { maxOutputLength: Math.max(1, entry.size) });
      } catch (error) {
        if (error?.code === "ERR_BUFFER_TOO_LARGE") fail(`size mismatch on entry ${shown}: inflated data exceeds the declared size`);
        fail(`corrupt deflate data on entry ${shown}: ${error.message}`);
      }
    }
    if (data.length !== entry.size) fail(`size mismatch on entry ${shown}: declared ${entry.size}, actual ${data.length}`);
    if (!entry.isDirectory && crc32(data) !== entry.crc) fail(`CRC mismatch on entry ${shown}`);
    entry.data = data;
    bytesTotal += entry.isDirectory ? 0 : data.length;
  }
  return { name: [...topLevel][0], entries, bytes: bytesTotal };
}

/**
 * Unpack `zipPath` into the new directory `destDir` (parent must exist, the
 * directory itself must not, not even as a symlink). Directories are created
 * 0700 and files 0600. Returns the top-level name, its path under `destDir`,
 * the sorted relative file paths, and the total extracted bytes. On any
 * failure the destination is removed again.
 */
export function extractSkillZip(zipPath, destDir) {
  const parent = dirname(destDir);
  let parentStat;
  try {
    parentStat = statSync(parent);
  } catch {
    fail(`parent directory of the destination does not exist: ${parent}`);
  }
  if (!parentStat.isDirectory()) fail(`parent directory of the destination does not exist: ${parent}`);
  let existing = false;
  try {
    lstatSync(destDir);
    existing = true;
  } catch {
    existing = false;
  }
  if (existing) fail(`destination already exists: ${destDir}`);
  const archiveStat = statSync(zipPath);
  if (!archiveStat.isFile()) fail(`archive is not a regular file: ${zipPath}`);
  if (archiveStat.size > SKILL_ZIP_LIMITS.maxArchiveBytes) {
    fail(`archive is ${archiveStat.size} bytes; the limit is ${SKILL_ZIP_LIMITS.maxArchiveBytes} bytes`);
  }
  const archive = readArchive(readFileSync(zipPath));
  const root = join(destDir, archive.name);
  try {
    mkdirSync(destDir, { mode: 0o700 });
    mkdirSync(root, { mode: 0o700 });
    for (const entry of archive.entries) {
      const target = join(destDir, ...entry.segments);
      if (entry.isDirectory) {
        mkdirSync(target, { recursive: true, mode: 0o700 });
      } else {
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
        writeFileSync(target, entry.data, { mode: 0o600, flag: "wx" });
      }
    }
  } catch (error) {
    rmSync(destDir, { recursive: true, force: true });
    throw error;
  }
  const files = archive.entries
    .filter(entry => !entry.isDirectory)
    .map(entry => entry.segments.slice(1).join("/"))
    .sort();
  return { name: archive.name, root, files, bytes: archive.bytes };
}
