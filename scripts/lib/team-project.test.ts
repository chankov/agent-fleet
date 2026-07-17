// Tests for project scoping helpers used by team-up/team-snapshot.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	DEFAULT_PROJECT,
	conductorCommand,
	hubCommand,
	parseProjectFlag,
	teamSnapshotPath,
	teamWorkspaceLabel,
	validateProject,
	worktreeTag,
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

test("workspace labels embed the worktree tag + mode and distinguish projects", () => {
	// Default tag is "repo" (no checkout in hand); mode is carried verbatim.
	assert.equal(teamWorkspaceLabel("peers", "docs"), "repo-peers-docs");
	assert.equal(teamWorkspaceLabel("hub", "docs"), "repo-hub-docs");
	assert.equal(teamWorkspaceLabel("conductor", "docs"), "repo-conductor-docs");
	// The worktree tag keys the label to the checkout (wt2-hub-plan).
	assert.equal(teamWorkspaceLabel("hub", "plan", DEFAULT_PROJECT, "wt2"), "wt2-hub-plan");
	assert.equal(teamWorkspaceLabel("peers", "plan", DEFAULT_PROJECT, "wt2"), "wt2-peers-plan");
	assert.equal(teamWorkspaceLabel("conductor", "plan", DEFAULT_PROJECT, "wt2"), "wt2-conductor-plan");
	// Same team from a different worktree never collides.
	assert.notEqual(
		teamWorkspaceLabel("hub", "plan", DEFAULT_PROJECT, "wt2"),
		teamWorkspaceLabel("hub", "plan", DEFAULT_PROJECT, "end2"),
	);
	assert.equal(teamWorkspaceLabel("peers", "docs", "acme", "wt2"), "wt2-peers-docs--project.acme");
	assert.equal(teamWorkspaceLabel("hub", "docs", "acme", "wt2"), "wt2-hub-docs--project.acme");
	assert.equal(teamWorkspaceLabel("conductor", "docs", "acme", "wt2"), "wt2-conductor-docs--project.acme");
	assert.notEqual(teamWorkspaceLabel("peers", "docs--project-acme"), teamWorkspaceLabel("peers", "docs", "acme"));
	assert.notEqual(teamWorkspaceLabel("hub", "docs--project-acme"), teamWorkspaceLabel("hub", "docs", "acme"));
	assert.notEqual(teamWorkspaceLabel("conductor", "docs--project-acme"), teamWorkspaceLabel("conductor", "docs", "acme"));
	assert.deepEqual(hubCommand(), ["just", "hub"]);
	assert.deepEqual(hubCommand("acme"), ["just", "hub", "--project", "acme"]);
	assert.deepEqual(conductorCommand(), ["hermes", "-p", "dev"]);
	assert.equal(teamSnapshotPath("/snap", "docs"), join("/snap", "docs.json"));
	assert.equal(teamSnapshotPath("/snap", "docs", "acme"), join("/snap", "projects", "acme", "docs.json"));
});

test("worktreeTag takes the last dot-segment of the checkout basename, sanitized", () => {
	assert.equal(worktreeTag("/media/nchankov/data/repos/main.wt2"), "wt2");
	assert.equal(worktreeTag("/media/nchankov/data/repos/ringithub.end2"), "end2");
	// No dot → whole basename.
	assert.equal(worktreeTag("/home/nchankov/repos/agent-fleet"), "agent-fleet");
	// Nested dots → still the last segment.
	assert.equal(worktreeTag("/x/acme.prod.wt3"), "wt3");
	// Trailing slash is ignored by basename.
	assert.equal(worktreeTag("/x/main.wt2/"), "wt2");
	// Unsafe characters collapse to hyphens; empty result falls back to "repo".
	assert.equal(worktreeTag("/x/my repo.a b"), "a-b");
	assert.equal(worktreeTag("/x/."), "repo");
});

test("justfile public team recipes forward trailing args and hidden peer recipes pass --project", () => {
	const justfile = readFileSync(join(REPO_ROOT, "justfile"), "utf-8");
	for (const recipe of ["team-up", "team-up-dry", "hub-team", "hub-team-dry", "conductor", "conductor-dry", "team-snapshot", "team-down", "team-resume"]) {
		assert.match(justfile, new RegExp(`\\n${recipe} team=\\"full\\" \\*args:`), recipe);
	}
	for (const command of [
		"scripts/team-up.ts --team {{team}} {{args}}",
		"scripts/team-up.ts --team {{team}} --hub {{args}}",
		"scripts/team-up.ts --team {{team}} --conductor {{args}}",
		"scripts/team-up.ts --team {{team}} --conductor --dry-run {{args}}",
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
