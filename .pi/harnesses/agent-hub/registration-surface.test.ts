import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const extensionPath = fileURLToPath(new URL("./index.ts", import.meta.url));
const fixturePath = new URL("./fixtures/registration-surface.json", import.meta.url);
const loaderUrl = new URL(
	"../../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js",
	import.meta.url,
);

function sortedKeys(collection: Map<string, unknown>): string[] {
	return [...collection.keys()].sort();
}

function removeAddedSignalListeners(signal: NodeJS.Signals, before: Set<NodeJS.SignalsListener>): void {
	for (const listener of process.listeners(signal)) {
		if (!before.has(listener)) process.removeListener(signal, listener);
	}
}

test("agent-hub registration surface matches the checked-in fixture", async () => {
	const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
	const sigintBefore = new Set(process.listeners("SIGINT"));
	const sigtermBefore = new Set(process.listeners("SIGTERM"));

	try {
		// Use Pi's production extension loader so this captures registrations made by
		// the executed factory rather than names inferred from source text.
		const { loadExtensions } = await import(loaderUrl.href);
		const result = await loadExtensions([extensionPath], repoRoot);
		assert.deepEqual(result.errors, []);
		assert.equal(result.extensions.length, 1);

		const extension = result.extensions[0];
		const actual = {
			tools: sortedKeys(extension.tools),
			commands: sortedKeys(extension.commands),
			flags: sortedKeys(extension.flags),
		};
		assert.deepEqual(actual, fixture);
	} finally {
		// The hub installs shutdown hooks when its factory runs. Avoid leaking them
		// into other tests when this file shares a Node test process.
		removeAddedSignalListeners("SIGINT", sigintBefore);
		removeAddedSignalListeners("SIGTERM", sigtermBefore);
	}
});
