import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (path) => readFileSync(join(root, path), "utf8");

const setupContracts = [
	"skills/guided-workspace-setup/SKILL.md",
	".claude/commands/setup-agent-fleet.md",
	".opencode/commands/af-setup-agent-fleet.md",
	".pi/prompts/setup-agent-fleet.md",
];

test("only damage-control-continue remains in the active harness inventory", () => {
	assert.equal(existsSync(join(root, ".pi/harnesses/damage-control")), false);
	const skill = read(setupContracts[0]);
	assert.match(skill, /agent-hub` ⇒ `damage-control-continue` \+ `ask-user-remote`/);
	assert.doesNotMatch(skill, /\*safety\*.*`damage-control`,/);
	assert.doesNotMatch(skill, /both damage-control variants/i);
});

test("all setup entrypoints safely clean up an owned retired hard-stop harness", () => {
	for (const path of setupContracts) {
		const source = read(path);
		assert.match(source, /retired.*damage-control.*recorded.*symlink/is, path);
		assert.match(source, /preserv.*user-modified|user-modified.*preserv/is, path);
	}
});
