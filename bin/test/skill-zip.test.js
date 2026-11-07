import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

import { SKILL_ZIP_LIMITS, crc32, extractSkillZip } from "../lib/skill-zip.js";
import { directoryFingerprint } from "../lib/hermes-profile-artifact.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const packagedZip = join(repoRoot, "skills", "fleet-native-voice.zip");
const packagedSource = join(repoRoot, "skills", "fleet-native-voice");

const disposables = [];

function scratch(prefix = "skill-zip-") {
  const root = mkdtempSync(join(tmpdir(), prefix));
  disposables.push(root);
  return root;
}

test.after(() => {
  for (const root of disposables) rmSync(root, { recursive: true, force: true });
});

/**
 * Test-side writer for the archive shapes `zip -r` produces (local headers,
 * central directory, end record). Every field can be overridden so each
 * refusal in the reader is exercised by one concrete malformed archive.
 */
function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? "", "utf8");
    const method = entry.method ?? 8;
    const stored = entry.compressed ?? (method === 8 ? deflateRawSync(data) : data);
    const crc = entry.crc ?? crc32(data);
    const size = entry.size ?? data.length;
    const flags = entry.flags ?? 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(entry.externalAttrs ?? (entry.name.endsWith("/") ? (0o40755 << 16) >>> 0 : (0o100644 << 16) >>> 0), 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, stored);
    centrals.push(central, name);
    offset += local.length + name.length + stored.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function archiveFile(bytes, root = scratch()) {
  const path = join(root, "skill.zip");
  writeFileSync(path, bytes);
  return { path, dest: join(root, "extracted") };
}

test("crc32 matches the IEEE check vector", () => {
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

test("extracts the packaged fleet-native-voice archive into a tree identical to its source", () => {
  const dest = join(scratch(), "out");
  const result = extractSkillZip(packagedZip, dest);
  assert.equal(result.name, "fleet-native-voice");
  assert.equal(result.root, join(dest, "fleet-native-voice"));
  assert.deepEqual(result.files, ["SKILL.md", "agents/openai.yaml"]);
  assert.equal(result.bytes, statSync(join(packagedSource, "SKILL.md")).size + statSync(join(packagedSource, "agents", "openai.yaml")).size);
  assert.equal(directoryFingerprint(result.root), directoryFingerprint(packagedSource));
  assert.equal(statSync(dest).mode & 0o777, 0o700);
  assert.equal(statSync(result.root).mode & 0o777, 0o700);
  assert.equal(statSync(join(result.root, "agents")).mode & 0o777, 0o700);
  assert.equal(statSync(join(result.root, "SKILL.md")).mode & 0o777, 0o600);
});

test("extracts stored and deflated entries, creating directories that have no explicit entry", () => {
  const { path, dest } = archiveFile(buildZip([
    { name: "demo/", data: "" },
    { name: "demo/SKILL.md", data: "# demo\n", method: 8 },
    { name: "demo/deep/nested/file.txt", data: "stored bytes", method: 0 },
  ]));
  const result = extractSkillZip(path, dest);
  assert.equal(result.name, "demo");
  assert.deepEqual(result.files, ["SKILL.md", "deep/nested/file.txt"]);
  assert.equal(readFileSync(join(result.root, "SKILL.md"), "utf8"), "# demo\n");
  assert.equal(readFileSync(join(result.root, "deep", "nested", "file.txt"), "utf8"), "stored bytes");
  assert.equal(statSync(join(result.root, "deep", "nested")).mode & 0o777, 0o700);
});

test("accepts exactly the entry limit", () => {
  const entries = [{ name: "demo/", data: "" }];
  for (let index = 1; index < SKILL_ZIP_LIMITS.maxEntries; index++) entries.push({ name: `demo/file-${index}.txt`, data: `${index}\n`, method: 0 });
  assert.equal(entries.length, SKILL_ZIP_LIMITS.maxEntries);
  const { path, dest } = archiveFile(buildZip(entries));
  assert.equal(extractSkillZip(path, dest).files.length, SKILL_ZIP_LIMITS.maxEntries - 1);
});

test("refuses an existing destination, whether a directory, a file, or a symlink", () => {
  const root = scratch();
  const asDirectory = join(root, "dir");
  mkdirSync(asDirectory);
  assert.throws(() => extractSkillZip(packagedZip, asDirectory), /already exists/);
  const asFile = join(root, "file");
  writeFileSync(asFile, "");
  assert.throws(() => extractSkillZip(packagedZip, asFile), /already exists/);
  const asLink = join(root, "link");
  symlinkSync(join(root, "missing-target"), asLink);
  assert.throws(() => extractSkillZip(packagedZip, asLink), /already exists/);
  assert.throws(() => extractSkillZip(packagedZip, join(root, "missing-parent", "out")), /parent/);
});

const big = Buffer.alloc(SKILL_ZIP_LIMITS.maxExtractedBytes + 1, 0x61);
const half = Buffer.alloc(Math.floor(SKILL_ZIP_LIMITS.maxExtractedBytes / 2) + 1, 0x62);
const sample = Buffer.from("sample content for size checks\n");
const refusals = [
  ["an absolute entry path", [{ name: "/demo/a.txt", data: "a" }], /entry path/],
  ["a parent traversal segment", [{ name: "demo/../a.txt", data: "a" }], /entry path/],
  ["a current-directory segment", [{ name: "demo/./a.txt", data: "a" }], /entry path/],
  ["a backslash separator", [{ name: "demo\\a.txt", data: "a" }], /entry path/],
  ["an empty path segment", [{ name: "demo//a.txt", data: "a" }], /entry path/],
  ["a file outside any top-level directory", [{ name: "a.txt", data: "a" }], /top-level/],
  ["more than one top-level directory", [{ name: "a/x.txt", data: "x" }, { name: "b/y.txt", data: "y" }], /top-level/],
  ["a symlink entry", [{ name: "demo/link", data: "../target", externalAttrs: (0o120777 << 16) >>> 0 }], /symlink/],
  ["an unsupported compression method", [{ name: "demo/a.txt", data: "a", method: 12, compressed: Buffer.from("a") }], /compression/],
  ["an encrypted entry", [{ name: "demo/a.txt", data: "a", flags: 1 }], /encrypted/],
  ["a duplicate entry", [{ name: "demo/a.txt", data: "a" }, { name: "demo/a.txt", data: "b" }], /duplicate/],
  ["a directory entry with content", [{ name: "demo/", data: "junk", method: 0 }], /directory entry/],
  ["more entries than the limit", [{ name: "demo/", data: "" }, ...Array.from({ length: SKILL_ZIP_LIMITS.maxEntries }, (_, index) => ({ name: `demo/f${index}`, data: "", method: 0 }))], /entries/],
  ["more extracted bytes than the limit in one entry", [{ name: "demo/big.bin", data: big, method: 0 }], /extracted/],
  ["more extracted bytes than the limit across entries", [{ name: "demo/a.bin", data: half, method: 0 }, { name: "demo/b.bin", data: half, method: 0 }], /extracted/],
  ["a declared size smaller than the inflated data", [{ name: "demo/a.txt", data: sample, size: sample.length - 1 }], /size/],
  ["a declared size larger than the inflated data", [{ name: "demo/a.txt", data: sample, size: sample.length + 1 }], /size/],
  ["a CRC mismatch", [{ name: "demo/a.txt", data: sample, crc: (crc32(sample) ^ 1) >>> 0 }], /CRC/],
];

for (const [label, entries, pattern] of refusals) {
  test(`refuses ${label} and leaves no destination behind`, () => {
    const { path, dest } = archiveFile(buildZip(entries));
    assert.throws(() => extractSkillZip(path, dest), pattern);
    assert.equal(existsSync(dest), false);
  });
}

test("refuses truncated, non-zip, and oversized archives", () => {
  const valid = buildZip([{ name: "demo/", data: "" }, { name: "demo/a.txt", data: "a" }]);
  const truncated = archiveFile(valid.subarray(0, valid.length - 10));
  assert.throws(() => extractSkillZip(truncated.path, truncated.dest), /end of central directory/);
  const garbage = archiveFile(Buffer.from("this is not a zip archive"));
  assert.throws(() => extractSkillZip(garbage.path, garbage.dest), /end of central directory/);
  const oversized = archiveFile(buildZip([{ name: "demo/a.bin", data: Buffer.alloc(SKILL_ZIP_LIMITS.maxArchiveBytes + 1), method: 0 }]));
  assert.throws(() => extractSkillZip(oversized.path, oversized.dest), /archive/);
  assert.equal(existsSync(oversized.dest), false);
});
