// Tests for project scoping helpers used by team-up/team-snapshot.

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
	assert.equal(teamWorkspaceLabel("conductor-hermes", "docs"), "repo-conductor-hermes-docs");
	assert.equal(teamWorkspaceLabel("conductor-codex", "docs"), "repo-conductor-codex-docs");
	// The worktree tag keys the label to the checkout (wt2-hub-plan).
	assert.equal(teamWorkspaceLabel("hub", "plan", DEFAULT_PROJECT, "wt2"), "wt2-hub-plan");
	assert.equal(teamWorkspaceLabel("peers", "plan", DEFAULT_PROJECT, "wt2"), "wt2-peers-plan");
	assert.equal(teamWorkspaceLabel("conductor-hermes", "plan", DEFAULT_PROJECT, "wt2"), "wt2-conductor-hermes-plan");
	assert.equal(teamWorkspaceLabel("conductor-codex", "plan", DEFAULT_PROJECT, "wt2"), "wt2-conductor-codex-plan");
	// Same team from a different worktree never collides.
	assert.notEqual(
		teamWorkspaceLabel("hub", "plan", DEFAULT_PROJECT, "wt2"),
		teamWorkspaceLabel("hub", "plan", DEFAULT_PROJECT, "end2"),
	);
	assert.equal(teamWorkspaceLabel("peers", "docs", "acme", "wt2"), "wt2-peers-docs--project.acme");
	assert.equal(teamWorkspaceLabel("hub", "docs", "acme", "wt2"), "wt2-hub-docs--project.acme");
	assert.equal(teamWorkspaceLabel("conductor-hermes", "docs", "acme", "wt2"), "wt2-conductor-hermes-docs--project.acme");
	assert.equal(teamWorkspaceLabel("conductor-codex", "docs", "acme", "wt2"), "wt2-conductor-codex-docs--project.acme");
	assert.notEqual(teamWorkspaceLabel("peers", "docs--project-acme"), teamWorkspaceLabel("peers", "docs", "acme"));
	assert.notEqual(teamWorkspaceLabel("hub", "docs--project-acme"), teamWorkspaceLabel("hub", "docs", "acme"));
	assert.notEqual(teamWorkspaceLabel("conductor-hermes", "docs--project-acme"), teamWorkspaceLabel("conductor-hermes", "docs", "acme"));
	assert.notEqual(teamWorkspaceLabel("conductor-codex", "docs--project-acme"), teamWorkspaceLabel("conductor-codex", "docs", "acme"));
	assert.deepEqual(hubCommand(), ["just", "hub"]);
	assert.deepEqual(hubCommand("acme"), ["just", "hub", "--project", "acme"]);
	assert.deepEqual(conductorCommand(), ["hermes", "-p", "dev"]);
	assert.equal(teamSnapshotPath("/snap", "docs"), join("/snap", "docs.json"));
	assert.equal(teamSnapshotPath("/snap", "docs", "acme"), join("/snap", "projects", "acme", "docs.json"));
});

test("conductorSpec types backend identity and injects only validated Codex context", () => {
	const hermes = conductorSpec("hermes", { repoRoot: "/repo", team: "docs", project: "af" });
	assert.equal(hermes.workspaceMode, "conductor-hermes");
	assert.equal(hermes.paneLabel, "conductor-hermes");
	assert.equal(hermes.conductorName, "hermes-docs-conductor");
	assert.deepEqual(hermes.command, ["hermes", "-p", "dev"]);
	assert.equal(hermes.cwd, "/repo");
	assert.deepEqual(hermes.env, {});

	const codex = conductorSpec("codex", { repoRoot: "/repo", team: "docs", project: "af" });
	assert.equal(codex.workspaceMode, "conductor-codex");
	assert.equal(codex.paneLabel, "conductor-codex-control");
	assert.equal(codex.conductorName, "codex-docs-conductor");
	assert.deepEqual(codex.command, ["node", "--experimental-strip-types", "/repo/scripts/codex-remote-control.ts", "control-pane"]);
	assert.equal(codex.cwd, "/repo/codex/conductor");
	assert.deepEqual(codex.env, {
		AGENT_FLEET_REPO_ROOT: "/repo",
		COMS_CLI_PROJECT: "af",
		COMS_CLI_NAME: "codex-docs-conductor",
		COMS_CLI_TIMEOUT_MS: "300000",
		AGENT_FLEET_CODEX_CONTRACT_PATH: "/repo/codex/conductor/AGENTS.md",
		AGENT_FLEET_CODEX_CONTRACT_IDENTITY: "agent-fleet-codex-conductor-pilot-v1",
		AGENT_FLEET_CONDUCTOR_BACKEND: "codex",
	});
	for (const bad of ["relative", "/repo/../other"]) {
		assert.throws(() => conductorSpec("codex", { repoRoot: bad, team: "docs", project: "af" }), /absolute repository root/);
	}
	assert.throws(() => conductorSpec("codex", { repoRoot: "/repo", team: "bad team", project: "af" }), /Invalid team name/);
	assert.throws(() => conductorSpec("codex", { repoRoot: "/repo", team: "docs", project: "bad project" }), /Invalid project name/);
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
	for (const recipe of ["team-up", "team-up-dry", "hub-team", "hub-team-dry", "conductor", "conductor-dry", "conductor-codex", "conductor-codex-dry", "conductor-codex-setup", "conductor-codex-reconfigure", "conductor-codex-pilot", "conductor-codex-pilot-dry", "conductor-codex-pilot-setup", "conductor-codex-pilot-reconfigure", "team-snapshot", "team-down", "team-resume"]) {
		assert.match(justfile, new RegExp(`\\n${recipe} team=\\"full\\" \\*args:`), recipe);
	}
	for (const recipe of ["pair", "start", "status", "stop", "recover", "uninstall"]) {
		assert.match(justfile, new RegExp(`\\nconductor-codex-${recipe}:`), `public ${recipe}`);
		assert.match(justfile, new RegExp(`\\nconductor-codex-pilot-${recipe}:`), `pilot alias ${recipe}`);
	}
	for (const command of [
		"scripts/team-up.ts --team {{team}} {{args}}",
		"scripts/team-up.ts --team {{team}} --hub {{args}}",
		"scripts/team-up.ts --team {{team}} --conductor {{args}}",
		"scripts/team-up.ts --team {{team}} --conductor --dry-run {{args}}",
		"scripts/team-up.ts --team {{team}} --conductor codex {{args}}",
		"scripts/team-up.ts --team {{team}} --conductor codex --dry-run {{args}}",
		"scripts/codex-remote-control.ts setup-conductor --codex-bin \"$(command -v codex)\" --repo-root \"$(pwd -P)\" --coms-dir \"$HOME/.pi/coms\" --team \"{{team}}\" --timeout 300000 {{args}}",
		"scripts/codex-remote-control.ts reconfigure-conductor --codex-bin \"$(command -v codex)\" --repo-root \"$(pwd -P)\" --coms-dir \"$HOME/.pi/coms\" --team \"{{team}}\" --timeout 300000 {{args}}",
		"scripts/codex-remote-control.ts setup-pilot --codex-bin \"$(command -v codex)\" --repo-root \"$(pwd -P)\" --coms-dir \"$HOME/.pi/coms\" --team \"{{team}}\" --timeout 300000 {{args}}",
		"scripts/codex-remote-control.ts reconfigure-pilot --codex-bin \"$(command -v codex)\" --repo-root \"$(pwd -P)\" --coms-dir \"$HOME/.pi/coms\" --team \"{{team}}\" --timeout 300000 {{args}}",
		"scripts/codex-remote-control.ts pair",
		"scripts/codex-remote-control.ts start",
		"scripts/codex-remote-control.ts status",
		"scripts/codex-remote-control.ts stop",
		"scripts/codex-remote-control.ts recover --confirm operator-confirmed",
		"scripts/codex-remote-control.ts uninstall --confirm operator-confirmed",
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
	assert.match(justfile, /\nconductor-codex team=/, "Gate-P-proven public Codex recipe is promoted");
});
