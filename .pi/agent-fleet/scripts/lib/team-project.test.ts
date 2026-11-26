// Tests for project scoping helpers used by the one-pane Herdr launchers.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	DEFAULT_PROJECT,
	conductorCommand,
	conductorSpec,
	hubCommand,
	parseProjectFlag,
	teamWorkspaceLabel,
	validateProject,
	worktreeTag,
} from "./team-project.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

test("parseProjectFlag defaults to default and accepts one explicit project", () => {
	assert.equal(parseProjectFlag([]), DEFAULT_PROJECT);
	assert.equal(parseProjectFlag(["--dry-run"]), DEFAULT_PROJECT);
	assert.equal(parseProjectFlag(["--project", "acme"]), "acme");
	assert.equal(parseProjectFlag(["--dry-run", "--project", "acme.prod"]), "acme.prod");
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
	assert.equal(teamWorkspaceLabel("hub", "base"), "repo-hub-base");
	assert.equal(teamWorkspaceLabel("peer", "scout"), "repo-peer-scout");
	assert.equal(teamWorkspaceLabel("conductor-hermes", "full"), "repo-conductor-hermes-full");
	// The worktree tag keys the label to the checkout (wt2-hub-base).
	assert.equal(teamWorkspaceLabel("hub", "base", DEFAULT_PROJECT, "wt2"), "wt2-hub-base");
	assert.equal(teamWorkspaceLabel("conductor-hermes", "full", DEFAULT_PROJECT, "wt2"), "wt2-conductor-hermes-full");
	// The same launch from a different worktree never collides.
	assert.notEqual(
		teamWorkspaceLabel("hub", "base", DEFAULT_PROJECT, "wt2"),
		teamWorkspaceLabel("hub", "base", DEFAULT_PROJECT, "end2"),
	);
	assert.equal(teamWorkspaceLabel("hub", "base", "acme", "wt2"), "wt2-hub-base--project.acme");
	assert.equal(teamWorkspaceLabel("peer", "scout", "acme", "wt2"), "wt2-peer-scout--project.acme");
	assert.equal(teamWorkspaceLabel("conductor-hermes", "full", "acme", "wt2"), "wt2-conductor-hermes-full--project.acme");
	assert.notEqual(teamWorkspaceLabel("hub", "base--project-acme"), teamWorkspaceLabel("hub", "base", "acme"));
	assert.throws(() => teamWorkspaceLabel("hub", "bad name"), /Invalid workspace name/);
	assert.throws(() => teamWorkspaceLabel("hub", "base", "bad project"), /Invalid project name/);
});

test("hubCommand is the ordinary Fleet launch with the Hub's own flags", () => {
	assert.deepEqual(hubCommand(), ["just", "fleet"]);
	assert.deepEqual(hubCommand("acme"), ["just", "fleet", "--project", "acme"]);
	assert.deepEqual(hubCommand("acme", { noComs: true, browser: true, voice: true, allExtensions: true }), [
		"just", "fleet", "--no-coms", "--browser", "--voice", "--all-extensions", "--project", "acme",
	]);
	assert.throws(() => hubCommand("bad project"), /Invalid project name/);
	assert.deepEqual(conductorCommand(), ["hermes", "-p", "dev"]);
});

test("conductorSpec types Hermes backend identity", () => {
	const hermes = conductorSpec("hermes", { repoRoot: "/repo", project: "af" });
	assert.equal(hermes.workspaceMode, "conductor-hermes");
	assert.equal(hermes.paneLabel, "conductor-hermes");
	assert.deepEqual(hermes.command, ["hermes", "-p", "dev"]);
	assert.equal(hermes.cwd, "/repo");
	assert.deepEqual(hermes.env, {});
	for (const bad of ["relative", "/repo/../other"]) {
		assert.throws(() => conductorSpec("hermes", { repoRoot: bad, project: "af" }), /absolute repository root/);
	}
	assert.throws(() => conductorSpec("hermes", { repoRoot: "/repo", project: "bad project" }), /Invalid project name/);
	assert.throws(() => conductorSpec("codex" as "hermes", { repoRoot: "/repo" }), /Unknown conductor backend/);
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

test("justfile exposes one Fleet entry point while hidden runtime recipes forward arguments", () => {
	const justfile = readFileSync(join(REPO_ROOT, "justfile"), "utf-8");
	assert.match(justfile, /\nfleet \*args:/);
	assert.match(justfile, /\n_fleet-herdr \*args:\n\s+\{\{node_ts\}\} \.pi\/agent-fleet\/scripts\/herdr-hub\.ts \{\{args\}\}\n/);
	assert.match(justfile, /\n_fleet-conductor name="full" \*args:\n\s+\{\{node_ts\}\} \.pi\/agent-fleet\/scripts\/herdr-hub\.ts --conductor hermes --name \{\{name\}\} \{\{args\}\}\n/);
	// Peer groups, their snapshots and resume are gone (PLAN-11-01, D8/D14).
	for (const removed of ["team-up", "team-up-dry", "hub-team", "hub-team-dry", "conductor-dry", "team-snapshot", "team-down", "team-resume"]) {
		assert.doesNotMatch(justfile, new RegExp(`\\n_fleet-${removed}(?: |:)`), removed);
		assert.doesNotMatch(justfile, new RegExp(`\\n${removed}(?: |:)`), `legacy public ${removed}`);
	}
	assert.doesNotMatch(justfile, /team-up\.ts|team-snapshot\.ts|peers\.yaml|teams\.yaml/);
	assert.doesNotMatch(justfile, /_fleet-conductor-codex/);
	assert.doesNotMatch(justfile, /\n(?:hub|hub-solo|safe-coms|ext-damage-control-continue|pi)(?: |:)/);
	assert.match(justfile, /coms\/index\.ts .*--project \{\{project\}\}/);
	assert.match(justfile, /claude-code-preflight\.ts \|\| exit \$\?; .*coms-claude-bridge\.ts/);
	assert.match(justfile, /coms-claude-bridge\.ts --name \{\{name\}\} --project \{\{project\}\}/);
});
