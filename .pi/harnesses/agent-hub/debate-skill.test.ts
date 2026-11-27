/**
 * PLAN-11-01 task 12: the Debate skill's examples are accepted by both entry points exactly as
 * written, the skill resolves through the practices' native-first lookup, and it adds no role or
 * practice to the catalog.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Value } from "@sinclair/typebox/value";
import { checkDebateRounds, parseAfDebateArgs } from "./debate-command.ts";
import { PRACTICE_IDS, resolveSkill } from "./config/practices.ts";
import { ROLE_NAMES } from "./config/roles.ts";
import { resolveVoicePersona } from "./poll-command.ts";
import { DEBATE_PANEL_PARAMETERS } from "./tools/debate-panel-core.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const skillPath = join(repoRoot, "skills", "debate", "SKILL.md");
const skill = readFileSync(skillPath, "utf8");

function fenced(language: string): string[] {
	// Blocks may be indented inside a list item; the indentation is not part of the example.
	return [...skill.matchAll(new RegExp("^([ \\t]*)```" + language + "\\n([\\s\\S]*?)^[ \\t]*```", "gm"))]
		.map(match => match[2].split("\n").map(line => line.startsWith(match[1]) ? line.slice(match[1].length) : line).join("\n"));
}

test("the skill has the required frontmatter and anatomy", () => {
	assert.match(skill, /^---\nname: debate\ndescription: [^\n]+Use when[^\n]+\n---\n/);
	for (const section of ["Overview", "When to Use", "Process", "Common Rationalizations", "Red Flags", "Verification"]) {
		assert.match(skill, new RegExp(`^## ${section}$`, "m"), section);
	}
});

test("every debate_panel example is a valid typed call", () => {
	const examples = fenced("json").map(body => JSON.parse(body));
	assert.ok(examples.length >= 2, "at least two tool examples");
	for (const example of examples) {
		assert.ok(Value.Check(DEBATE_PANEL_PARAMETERS, example), JSON.stringify([...Value.Errors(DEBATE_PANEL_PARAMETERS, example)]));
		assert.ok(!("error" in resolveVoicePersona(example.persona)), `persona ${example.persona}`);
		assert.ok(!("error" in checkDebateRounds(example.rounds)), `rounds ${example.rounds}`);
	}
	assert.ok(examples.some(example => Object.keys(example).length === 1), "a minimal example with only the question");
	assert.ok(examples.some(example => example.panel && example.persona && example.rounds), "an example with panel, persona and rounds");
});

test("every /af-debate example parses with an accepted persona and round count", () => {
	const lines = fenced("text").flatMap(body => body.split("\n")).filter(line => line.startsWith("/af-debate "));
	assert.ok(lines.length >= 2, "at least two command examples");
	for (const line of lines) {
		const parsed = parseAfDebateArgs(line.slice("/af-debate ".length));
		assert.equal(parsed.error, undefined, line);
		assert.ok(parsed.question.length > 0, line);
		assert.ok(!("error" in resolveVoicePersona(parsed.persona)), line);
	}
});

test("the skill resolves like a practice skill and leaves three roles and eleven practices", () => {
	assert.equal(resolveSkill("debate", [repoRoot]).path, skillPath);
	assert.equal(ROLE_NAMES.length, 3);
	assert.equal(PRACTICE_IDS.length, 11);
	assert.ok(!(PRACTICE_IDS as readonly string[]).includes("debate"), "Debate is orchestration guidance, not a practice");
});
