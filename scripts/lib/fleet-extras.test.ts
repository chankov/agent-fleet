// Track B tests: env_file path guarding (B3), persona banners (B1), and the
// team-up dry-run surface (B2 hub mode + B3 redaction) via the real script
// with a temp peers.yaml — no herdr required on any of these paths.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveEnvFilePath } from "./herdr-layout.ts";
import { parsePersonaFrontmatter, renderBanner } from "./persona-banner.ts";
import { worktreeTag } from "./team-project.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TEAM_UP = join(REPO_ROOT, "scripts", "team-up.ts");
// team-up derives the workspace-label prefix from the checkout basename, so the
// expected label depends on where this repo is cloned (agent-fleet, main.wt2, …).
const TAG = worktreeTag(REPO_ROOT);

test("resolveEnvFilePath accepts repo-relative paths and rejects escapes", () => {
	assert.equal(resolveEnvFilePath(".env.peer", "/repo"), "/repo/.env.peer");
	assert.equal(resolveEnvFilePath("config/peer.env", "/repo"), "/repo/config/peer.env");
	assert.throws(() => resolveEnvFilePath("/etc/passwd", "/repo"), /must be repo-relative/);
	assert.throws(() => resolveEnvFilePath("../outside.env", "/repo"), /escapes the repo root/);
	assert.throws(() => resolveEnvFilePath("a/../../outside.env", "/repo"), /escapes the repo root/);
	assert.throws(() => resolveEnvFilePath("bad value.env", "/repo"), /Unsafe env_file path/);
});

test("persona frontmatter parses name/description/color like the coms harness", () => {
	const meta = parsePersonaFrontmatter(
		'---\nname: researcher\ndescription: "Digs up sources"\ncolor: "#72F1B8"\n---\nbody',
	);
	assert.equal(meta.name, "researcher");
	assert.equal(meta.description, "Digs up sources");
	assert.equal(meta.color, "#72F1B8");
	assert.deepEqual(parsePersonaFrontmatter("no frontmatter here"), {});
});

test("renderBanner colors the name, includes the purpose, tolerates bad colors", () => {
	const lines = renderBanner("researcher", { description: "Digs up sources", color: "#72F1B8" }, 40);
	assert.equal(lines.length, 4);
	assert.match(lines[1], /38;2;114;241;184/); // #72F1B8 as RGB
	assert.match(lines[1], /researcher/);
	assert.match(lines[2], /Digs up sources/);
	// invalid color falls back without throwing; missing purpose drops the line
	const plain = renderBanner("x", { color: "not-a-color" }, 40);
	assert.equal(plain.length, 3);
});

function dryRun(args: string[], peersYaml: string): { stdout: string; stderr: string; status: number | null } {
	const r = spawnSync(
		process.execPath,
		[TEAM_UP, ...args, "--dry-run", "--peers", peersYaml],
		{ encoding: "utf-8", cwd: REPO_ROOT },
	);
	return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}

test("dry run: hub mode labels the workspace <tag>-hub-* and includes the hub pane", () => {
	const dir = mkdtempSync(join(tmpdir(), "team-up-test-"));
	const peersYaml = join(dir, "peers.yaml");
	writeFileSync(peersYaml, "t:\n  - name: a\n    persona: researcher\n  - name: b\n    persona: documenter\n");

	const r = dryRun(["--team", "t", "--hub"], peersYaml);
	assert.equal(r.status, 0, r.stderr);
	const parsed = JSON.parse(r.stdout.slice(r.stdout.indexOf("{")));
	assert.equal(parsed.label, `${TAG}-hub-t`);
	assert.equal(parsed.layout.type, "split");
	assert.equal(parsed.layout.ratio, 0.4);
	assert.equal(parsed.layout.first.label, "hub");
	assert.deepEqual(parsed.layout.first.command, ["just", "hub"]);
});

test("dry run: hub project labels workspace and sends the project to hub plus every peer", () => {
	const dir = mkdtempSync(join(tmpdir(), "team-up-test-"));
	const peersYaml = join(dir, "peers.yaml");
	writeFileSync(peersYaml, "t:\n  - name: a\n    persona: researcher\n  - name: b\n    persona: documenter\n    model: m/x\n");

	const r = dryRun(["--team", "t", "--hub", "--project", "acme"], peersYaml);
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /project "acme"/);
	const parsed = JSON.parse(r.stdout.slice(r.stdout.indexOf("{")));
	assert.equal(parsed.label, `${TAG}-hub-t--project.acme`);
	assert.deepEqual(parsed.layout.first.command, ["just", "hub", "--project", "acme"]);
	const paneJson = JSON.stringify(parsed.layout.second);
	assert.match(paneJson, /"acme"/);
	assert.deepEqual(parsed.layout.second.first.command, ["just", "_peer", "researcher", "a", "", "", "acme"]);
	assert.deepEqual(parsed.layout.second.second.command, ["just", "_peer", "documenter", "b", "m/x", "", "acme"]);
});

test("dry run: non-hub project sends the project to every peer without a hub pane", () => {
	const dir = mkdtempSync(join(tmpdir(), "team-up-test-"));
	const peersYaml = join(dir, "peers.yaml");
	writeFileSync(peersYaml, "t:\n  - name: a\n    persona: researcher\n  - name: c\n    runner: claude-code\n");

	const r = dryRun(["--team", "t", "--project", "acme"], peersYaml);
	assert.equal(r.status, 0, r.stderr);
	const parsed = JSON.parse(r.stdout.slice(r.stdout.indexOf("{")));
	assert.equal(parsed.label, `${TAG}-peers-t--project.acme`);
	assert.equal(parsed.layout.type, "split");
	assert.deepEqual(parsed.layout.first.command, ["just", "_peer", "researcher", "a", "", "", "acme"]);
	assert.deepEqual(parsed.layout.second.command, ["just", "_claude-peer", "c", "", "", "acme"]);
});

test("dry run: Hermes and pilot Codex conductors have distinct shared-layout roots", () => {
	const dir = mkdtempSync(join(tmpdir(), "team-up-test-"));
	const peersYaml = join(dir, "peers.yaml");
	writeFileSync(peersYaml, "t:\n  - name: a\n    persona: researcher\n");

	const hermes = dryRun(["--team", "t", "--conductor", "--project", "af"], peersYaml);
	assert.equal(hermes.status, 0, hermes.stderr);
	const hermesLayout = JSON.parse(hermes.stdout.slice(hermes.stdout.indexOf("{")));
	assert.equal(hermesLayout.label, `${TAG}-conductor-hermes-t--project.af`);
	assert.equal(hermesLayout.layout.first.label, "conductor-hermes");
	assert.deepEqual(hermesLayout.layout.first.command, ["hermes", "-p", "dev"]);

	const codex = dryRun(["--team", "t", "--conductor", "codex", "--project", "af"], peersYaml);
	assert.equal(codex.status, 0, codex.stderr);
	assert.match(codex.stdout, /Codex conductor/);
	const codexLayout = JSON.parse(codex.stdout.slice(codex.stdout.indexOf("{")));
	assert.equal(codexLayout.label, `${TAG}-conductor-codex-t--project.af`);
	assert.equal(codexLayout.layout.type, "split");
	assert.equal(codexLayout.layout.first.label, "conductor-codex-control");
	assert.deepEqual(codexLayout.layout.first.command.slice(-1), ["control-pane"]);
	assert.equal(codexLayout.layout.first.command.includes("remote-control"), false);
	const runtimeWorkspace = join(homedir(), ".local", "state", "agent-fleet", "codex-conductor", "workspace");
	assert.equal(codexLayout.layout.first.cwd, runtimeWorkspace);
	assert.deepEqual(codexLayout.layout.first.env, {
		AGENT_FLEET_REPO_ROOT: REPO_ROOT,
		COMS_CLI_PROJECT: "af",
		COMS_CLI_NAME: "codex-t-conductor",
		COMS_CLI_TIMEOUT_MS: "300000",
		AGENT_FLEET_CODEX_CONTRACT_PATH: join(runtimeWorkspace, "AGENTS.md"),
		AGENT_FLEET_CODEX_CONTRACT_IDENTITY: "agent-fleet-codex-conductor-pilot-v1",
		AGENT_FLEET_CONDUCTOR_BACKEND: "codex",
	});
});

test("dry run: invalid conductor backend, duplicate flag, and hub combination refuse", () => {
	const dir = mkdtempSync(join(tmpdir(), "team-up-test-"));
	const peersYaml = join(dir, "peers.yaml");
	writeFileSync(peersYaml, "t:\n  - name: a\n    persona: researcher\n");
	for (const [args, message] of [
		[["--team", "t", "--conductor", "other"], /Unknown conductor backend/],
		[["--team", "t", "--conductor", "codex", "--conductor", "hermes"], /may only be provided once/],
		[["--team", "t", "--hub", "--conductor", "codex"], /mutually exclusive/],
	] as const) {
		const result = dryRun(args, peersYaml);
		assert.equal(result.status, 1);
		assert.match(result.stderr, message);
	}
});

test("dry run: env_file values are redacted (path only), and layout carries no env", () => {
	const dir = mkdtempSync(join(tmpdir(), "team-up-test-"));
	const peersYaml = join(dir, "peers.yaml");
	// env_file is repo-relative; point at a path that does NOT exist — dry-run
	// must still work (existence is checked only at spawn).
	writeFileSync(
		peersYaml,
		"t:\n  - name: a\n    persona: researcher\n    env_file: .env.does-not-exist\n",
	);

	const r = dryRun(["--team", "t"], peersYaml);
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /env_file: \.env\.does-not-exist — values redacted/);
	const parsed = JSON.parse(r.stdout.slice(r.stdout.indexOf("{")));
	assert.equal(JSON.stringify(parsed).includes('"env"'), false, "dry-run layout must not embed env values");
});

test("dry run: unsafe env_file refuses before printing anything", () => {
	const dir = mkdtempSync(join(tmpdir(), "team-up-test-"));
	const peersYaml = join(dir, "peers.yaml");
	writeFileSync(peersYaml, "t:\n  - name: a\n    persona: researcher\n    env_file: ../../etc/secrets\n");
	const r = dryRun(["--team", "t"], peersYaml);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /escapes the repo root/);
});

test("dry run: invalid or missing project/team values are rejected before JSON output", () => {
	const dir = mkdtempSync(join(tmpdir(), "team-up-test-"));
	const peersYaml = join(dir, "peers.yaml");
	writeFileSync(peersYaml, "t:\n  - name: a\n    persona: researcher\n");

	const badProject = dryRun(["--team", "t", "--project", "bad value"], peersYaml);
	assert.equal(badProject.status, 1);
	assert.match(badProject.stderr, /Invalid project name/);
	assert.equal(badProject.stdout, "");

	const missingTeam = dryRun(["--team", "--project", "acme"], peersYaml);
	assert.equal(missingTeam.status, 1);
	assert.match(missingTeam.stderr, /--team requires a value/);
	assert.equal(missingTeam.stdout, "");
});
