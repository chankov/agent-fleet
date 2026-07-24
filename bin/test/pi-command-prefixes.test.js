import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { bootstrap } from "../lib/bootstrap.js";

const commandSources = [
	".pi/extensions/btw/index.ts",
	".pi/extensions/pi-voice-stt/index.ts",
	".pi/harnesses/agent-hub/index.ts",
	".pi/harnesses/coms/index.ts",
	".pi/harnesses/damage-control-continue/index.ts",
];

test("Agent Fleet pi extensions and harnesses namespace public commands with af-", () => {
	for (const path of commandSources) {
		const source = readFileSync(resolve(path), "utf8");
		const commands = [...source.matchAll(/registerCommand\("([^"]+)"/g)].map((match) => match[1]);
		assert.ok(commands.length > 0, `${path} should register at least one command`);
		for (const command of commands) {
			assert.match(command, /^af-/, `${path} registers unprefixed /${command}`);
		}
	}
});

test("Agent Fleet's Chrome DevTools wrapper namespaces its generated status command", () => {
	const source = readFileSync(resolve(".pi/extensions/chrome-devtools-mcp/index.ts"), "utf8");
	assert.match(source, /statusCommandName:\s*"af-chrome-devtools-status"/);
});

test("Agent Fleet pi prompt-template filenames namespace public commands with af-", () => {
	const prompts = readdirSync(resolve(".pi/prompts")).filter((name) => name.endsWith(".md"));
	assert.ok(prompts.length > 0, ".pi/prompts should contain prompt templates");
	for (const prompt of prompts) {
		assert.match(prompt, /^af-/, `.pi/prompts/${prompt} exposes an unprefixed command`);
	}
});

test("pi bootstrap removes pre-prefix installer prompts during upgrade", () => {
	const workspace = mkdtempSync(join(tmpdir(), "agent-fleet-af-prefix-"));
	const promptsDir = join(workspace, ".pi", "prompts");
	mkdirSync(promptsDir, { recursive: true });
	writeFileSync(join(promptsDir, "setup-agent-fleet.md"), "legacy setup");
	writeFileSync(join(promptsDir, "doctor-agent-fleet.md"), "legacy doctor");

	const result = bootstrap({ agent: "pi", sourceRoot: resolve("."), workspace, method: "copy" });

	assert.deepEqual(
		result.removed.map((path) => path.slice(workspace.length + 1)).sort(),
		[".pi/prompts/doctor-agent-fleet.md", ".pi/prompts/setup-agent-fleet.md"],
	);
	assert.deepEqual(
		readdirSync(promptsDir).sort(),
		["af-doctor-agent-fleet.md", "af-setup-agent-fleet.md"],
	);
});

test("pi init handoff names the prefixed setup command", () => {
	const workspace = mkdtempSync(join(tmpdir(), "agent-fleet-af-handoff-"));
	const result = spawnSync(
		process.execPath,
		["bin/cli.js", "init", "--agent", "pi", "--workspace", workspace, "--dry-run"],
		{ cwd: resolve("."), encoding: "utf8" },
	);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /Open pi .*\/af-setup-agent-fleet/s);
	assert.doesNotMatch(result.stdout, /run:\s*\n\s*\/setup-agent-fleet/);
});

test("guided setup safely migrates recorded legacy pi prompt targets", () => {
	const skill = readFileSync(resolve("skills/guided-workspace-setup/SKILL.md"), "utf8");
	assert.match(skill, /Pi `\/af-\*` migration/);
	assert.match(skill, /recorded in `## install-status` and unchanged/);
	assert.match(skill, /Preserve user-modified and unowned legacy files/);
});
