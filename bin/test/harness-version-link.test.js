import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const harnesses = ["agent-hub", "coms", "damage-control-continue"];
const rootHomepage = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).homepage;

// OSC sequences pi's TUI strips before measuring width: ESC ] … BEL.
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

async function importFresh(name) {
	const path = join(root, ".pi", "harnesses", name, "version.ts");
	return import(`${pathToFileURL(path).href}?link=${Date.now()}-${Math.random()}`);
}

test("the version label is an OSC 8 hyperlink to the project homepage", async () => {
	for (const name of harnesses) {
		const module = await importFresh(name);
		assert.equal(module.VERSION_LABEL_URL, rootHomepage, name);
		assert.equal(
			module.formatVersionLabel("1.2.3"),
			`\x1b]8;;${rootHomepage}\x07agent fleet\x1b]8;;\x07 v1.2.3`,
			name,
		);
	}
});

test("the hyperlink costs no footer columns — only 'agent fleet v<version>' is visible", async () => {
	const module = await importFresh("agent-hub");
	assert.equal(module.formatVersionLabel("1.2.3").replace(OSC, ""), "agent fleet v1.2.3");
});

test("AGENT_FLEET_NO_LINKS falls back to the plain label for terminals that mangle OSC 8", async () => {
	const module = await importFresh("agent-hub");
	const previous = process.env.AGENT_FLEET_NO_LINKS;
	try {
		for (const value of ["1", "yes"]) {
			process.env.AGENT_FLEET_NO_LINKS = value;
			assert.equal(module.formatVersionLabel("1.2.3"), "agent fleet v1.2.3", value);
		}
		for (const value of ["", "0", "false"]) {
			process.env.AGENT_FLEET_NO_LINKS = value;
			assert.match(module.formatVersionLabel("1.2.3"), /^\x1b\]8;;/, value);
		}
	} finally {
		if (previous === undefined) delete process.env.AGENT_FLEET_NO_LINKS;
		else process.env.AGENT_FLEET_NO_LINKS = previous;
	}
});
