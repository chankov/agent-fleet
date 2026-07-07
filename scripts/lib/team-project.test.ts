// Tests for project scoping helpers used by team-up/team-snapshot.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	DEFAULT_PROJECT,
	hubCommand,
	parseProjectFlag,
	teamSnapshotPath,
	teamWorkspaceLabel,
	validateProject,
} from "./team-project.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("parseProjectFlag defaults to default and accepts one explicit project", () => {
	assert.equal(parseProjectFlag([]), DEFAULT_PROJECT);
	assert.equal(parseProjectFlag(["--dry-run"]), DEFAULT_PROJECT);
	assert.equal(parseProjectFlag(["--project", "acme"]), "acme");
	assert.equal(parseProjectFlag(["--team", "docs", "--project", "acme.prod"]), "acme.prod");
});

test("parseProjectFlag rejects missing, flag-looking, duplicate, and unsafe values", () => {
	assert.throws(() => parseProjectFlag(["--project"]), /requires a name/);
	assert.throws(() => parseProjectFlag(["--project", "--dry-run"]), /requires a name/);
	assert.throws(() => parseProjectFlag(["--project", "default", "--project", "foo"]), /only be provided once/);
	assert.throws(() => parseProjectFlag(["--project", "bad value"]), /Invalid project name/);
});

test("validateProject rejects path traversal, separators, whitespace, metacharacters, and glob stars", () => {
	for (const bad of ["", ".", "..", "a..b", "a/b", "a\\b", "a b", "a;b", "$(evil)", "a*b", "--flag"]) {
		assert.throws(() => validateProject(bad), /Invalid project name/, bad);
	}
	assert.equal(validateProject("acme-prod_1.2"), "acme-prod_1.2");
});

test("workspace labels, hub commands, and snapshot paths preserve default names and distinguish projects", () => {
	assert.equal(teamWorkspaceLabel("peers", "docs"), "pi-peers-docs");
	assert.equal(teamWorkspaceLabel("hub", "docs"), "pi-hub-docs");
	assert.equal(teamWorkspaceLabel("peers", "docs", "acme"), "pi-peers-docs--project.acme");
	assert.equal(teamWorkspaceLabel("hub", "docs", "acme"), "pi-hub-docs--project.acme");
	assert.notEqual(teamWorkspaceLabel("peers", "docs--project-acme"), teamWorkspaceLabel("peers", "docs", "acme"));
	assert.notEqual(teamWorkspaceLabel("hub", "docs--project-acme"), teamWorkspaceLabel("hub", "docs", "acme"));
	assert.deepEqual(hubCommand(), ["just", "hub"]);
	assert.deepEqual(hubCommand("acme"), ["just", "hub", "--project", "acme"]);
	assert.equal(teamSnapshotPath("/snap", "docs"), join("/snap", "docs.json"));
	assert.equal(teamSnapshotPath("/snap", "docs", "acme"), join("/snap", "projects", "acme", "docs.json"));
});

test("justfile public team recipes forward trailing args and hidden peer recipes pass --project", () => {
	const justfile = readFileSync(join(REPO_ROOT, "justfile"), "utf-8");
	for (const recipe of ["team-up", "team-up-dry", "hub-team", "hub-team-dry", "team-snapshot", "team-down", "team-resume"]) {
		assert.match(justfile, new RegExp(`\\n${recipe} team=\\"full\\" \\*args:`), recipe);
	}
	for (const command of [
		"scripts/team-up.ts --team {{team}} {{args}}",
		"scripts/team-up.ts --team {{team}} --hub {{args}}",
		"scripts/team-snapshot.ts snapshot {{team}} {{args}}",
		"scripts/team-snapshot.ts down {{team}} {{args}}",
		"scripts/team-snapshot.ts resume {{team}} {{args}}",
	]) {
		assert.match(justfile, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	}
	assert.match(justfile, /_peer persona name="" model="" session="" project="default":/);
	assert.match(justfile, /_peer-plus extensions persona name="" model="" session="" project="default":/);
	assert.match(justfile, /_claude-peer name model="" session="" project="default":/);
	assert.match(justfile, /coms\/index\.ts .*--project \{\{project\}\}/);
	assert.match(justfile, /coms-claude-bridge\.ts --name \{\{name\}\} --project \{\{project\}\}/);
});
