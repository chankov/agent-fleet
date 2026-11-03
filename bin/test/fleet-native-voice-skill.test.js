import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildManifest, itemsForAgent } from "../lib/manifest.js";

const root = fileURLToPath(new URL("../../", import.meta.url));

test("Codex native voice skill is available as source without installing Codex MCP instructions into Pi", () => {
	assert.ok(existsSync(new URL("../../skills/fleet-native-voice/SKILL.md", import.meta.url)));
	const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
	const manifest = buildManifest({ sourceRoot: root, packageVersion: pkg.version });
	assert.equal(itemsForAgent(manifest, "pi").some(item => item.id === "skill:fleet-native-voice"), false);
});
