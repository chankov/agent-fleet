import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const harnesses = ["agent-hub", "coms", "damage-control-continue"];
const rootVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

async function importFresh(path) {
	return import(`${pathToFileURL(path).href}?fixture=${Date.now()}-${Math.random()}`);
}

function copyPair(source, destination, version) {
	mkdirSync(destination, { recursive: true });
	cpSync(join(source, "version.ts"), join(destination, "version.ts"));
	const manifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
	manifest.version = version;
	writeFileSync(join(destination, "package.json"), JSON.stringify(manifest));
}

test("three local provenance modules read their adjacent root-derived stamps and share one status key", async () => {
	const keys = new Set();
	for (const name of harnesses) {
		const dir = join(root, ".pi", "harnesses", name);
		const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
		const module = await importFresh(join(dir, "version.ts"));
		assert.equal(manifest.version, rootVersion, name);
		assert.equal(module.HARNESS_VERSION, rootVersion, name);
		keys.add(module.VERSION_STATUS_KEY);
		const statuses = new Map();
		module.registerVersionStatus({ ui: { setStatus: (key, text) => statuses.set(key, text) } });
		module.registerVersionStatus({ ui: { setStatus: (key, text) => statuses.set(key, text) } });
		assert.deepEqual([...statuses], [[module.VERSION_STATUS_KEY, `v${rootVersion}`]], name);
	}
	assert.deepEqual([...keys], ["00-agent-fleet-version"]);
});

test("copied and symlinked provenance pairs resolve their adjacent stamp from an unrelated cwd", async () => {
	const fixture = mkdtempSync(join(tmpdir(), "harness-version-provenance-"));
	const unrelated = mkdtempSync(join(tmpdir(), "harness-version-unrelated-"));
	const previousCwd = process.cwd();
	try {
		for (const method of ["copy", "symlink"]) {
			for (const name of harnesses) {
				const source = join(fixture, `${method}-source-${name}`);
				copyPair(join(root, ".pi", "harnesses", name), source, "7.8.9-fixture");
				const pair = method === "copy" ? join(fixture, `${method}-${name}`) : join(fixture, `${method}-${name}`);
				if (method === "copy") cpSync(source, pair, { recursive: true });
				else symlinkSync(source, pair, "dir");
				process.chdir(unrelated);
				const module = await importFresh(join(pair, "version.ts"));
				assert.equal(module.HARNESS_VERSION, "7.8.9-fixture", `${method}: ${name}`);
			}
		}
	} finally {
		process.chdir(previousCwd);
		rmSync(fixture, { recursive: true, force: true });
		rmSync(unrelated, { recursive: true, force: true });
	}
});

test("ask-user-remote owns no version module, version registration, or footer rendering", () => {
	const askUserDir = join(root, ".pi", "harnesses", "ask-user-remote");
	const source = readFileSync(join(askUserDir, "index.ts"), "utf8");
	assert.equal(existsSync(join(askUserDir, "version.ts")), false);
	assert.doesNotMatch(source, /registerVersionStatus|VERSION_STATUS_KEY|setStatus\(|setFooter\(/);
});
