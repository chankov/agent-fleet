import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

// AGENTS.md packages a skill as skills/<name>.zip beside its directory. A copy that
// drifts from the directory ships stale instructions, so every archive must match.
const skills = fileURLToPath(new URL("../../skills/", import.meta.url));

/** Minimal reader for the stored/deflated entries `zip -r` writes. */
function readZip(bytes) {
	let end = bytes.length - 22;
	while (end >= 0 && bytes.readUInt32LE(end) !== 0x06054b50) end--;
	assert.ok(end >= 0, "end of central directory");
	const entries = new Map();
	let offset = bytes.readUInt32LE(end + 16);
	for (let index = 0; index < bytes.readUInt16LE(end + 10); index++) {
		assert.equal(bytes.readUInt32LE(offset), 0x02014b50, "central directory entry");
		const method = bytes.readUInt16LE(offset + 10), compressed = bytes.readUInt32LE(offset + 20), size = bytes.readUInt32LE(offset + 24);
		const nameLength = bytes.readUInt16LE(offset + 28), extra = bytes.readUInt16LE(offset + 30), comment = bytes.readUInt16LE(offset + 32);
		const local = bytes.readUInt32LE(offset + 42), name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
		const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
		const data = bytes.subarray(start, start + compressed);
		if (!name.endsWith("/")) {
			assert.ok(method === 0 || method === 8, `${name}: unsupported compression ${method}`);
			entries.set(name, method === 0 ? data : inflateRawSync(data));
			assert.equal(entries.get(name).length, size, name);
		}
		offset += 46 + nameLength + extra + comment;
	}
	return entries;
}

function files(directory, base = directory) {
	return readdirSync(directory).flatMap(name => {
		const path = join(directory, name);
		return statSync(path).isDirectory() ? files(path, base) : [relative(base, path).split("\\").join("/")];
	});
}

for (const archive of readdirSync(skills).filter(name => name.endsWith(".zip"))) {
	test(`skills/${archive} matches skills/${archive.slice(0, -4)}/ byte for byte`, () => {
		const name = archive.slice(0, -4), directory = join(skills, name);
		const entries = readZip(readFileSync(join(skills, archive)));
		const expected = files(directory).map(file => `${name}/${file}`).filter(file => !file.endsWith(".DS_Store")).sort();
		assert.deepEqual([...entries.keys()].sort(), expected, "the archive lists exactly the directory's files");
		for (const [entry, bytes] of entries) assert.ok(bytes.equals(readFileSync(join(skills, entry))), `${entry} is stale; rebuild with: cd skills && zip -r ${archive} ${name}/`);
	});
}
