import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { assertClaudeCodeAvailable } from "../claude-code-preflight.ts";
import { buildPeerLaunchPlan, parsePeerArgs, type PeerLaunchContext } from "./peer-launch.ts";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PEER_LAUNCH_SCRIPT = path.resolve(SCRIPT_DIR, "..", "peer-launch.ts");

function ctx(overrides: Partial<PeerLaunchContext> = {}): PeerLaunchContext {
	return {
		personaExists: (persona) => ["documenter", "web-debugger", "researcher", "reviewer"].includes(persona),
		worktreeTag: "wt2",
		...overrides,
	};
}

// ━━ the three shapes of peer ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

test("a name with no persona file is the identity-only Fleet Core peer", () => {
	const plan = buildPeerLaunchPlan({ name: "architect", project: "af" }, ctx());
	assert.equal(plan.kind, "core-peer");
	assert.equal(plan.runner, "pi");
	assert.deepEqual(plan.command, ["just", "_fleet-peer", "architect", "--project", "af"]);
	assert.equal(plan.workspaceLabel, "wt2-peer-architect--project.af");
});

test("core peers keep the model flag and pass pi arguments through", () => {
	const plan = buildPeerLaunchPlan(
		{ name: "debugger", model: "openai-codex/gpt-6-luna", piArgs: ["--session", "/tmp/s.json"] },
		ctx(),
	);
	assert.equal(plan.kind, "core-peer");
	assert.deepEqual(plan.command, ["just", "_fleet-peer", "debugger", "--model", "openai-codex/gpt-6-luna", "--session", "/tmp/s.json"]);
});

test("an undeclared name matching a persona/role file becomes that persona peer", () => {
	const plan = buildPeerLaunchPlan({ name: "researcher" }, ctx());
	assert.equal(plan.kind, "persona-peer");
	assert.equal(plan.persona, "researcher");
	assert.deepEqual(plan.command, ["just", "_peer", "researcher", "researcher"]);
	const model = buildPeerLaunchPlan({ name: "documenter", model: "anthropic/claude-opus-4-8" }, ctx());
	assert.deepEqual(model.command, ["just", "_peer", "documenter", "documenter", "anthropic/claude-opus-4-8"]);
	assert.equal(model.workspaceLabel, "wt2-peer-documenter");
});

test("--runner claude-code launches a Claude Code peer from flags alone", () => {
	const plan = buildPeerLaunchPlan({ name: "claude-reviewer", runner: "claude-code", model: "opus", project: "af" }, ctx());
	assert.equal(plan.kind, "claude-peer");
	// _claude-peer positionals: name model project
	assert.deepEqual(plan.command, ["just", "_claude-peer", "claude-reviewer", "opus", "af"]);
	assert.deepEqual(buildPeerLaunchPlan({ name: "solo", runner: "claude-code" }, ctx()).command, ["just", "_claude-peer", "solo"]);
	// A name is never looked up anywhere: without --runner it is a pi peer.
	assert.equal(buildPeerLaunchPlan({ name: "claude-reviewer" }, ctx()).runner, "pi");
});

test("the plan carries no extension choice — the recipes own D17", () => {
	const plan = buildPeerLaunchPlan({ name: "web-debugger" }, ctx()) as unknown as Record<string, unknown>;
	assert.equal("extensions" in plan, false);
	assert.equal("declared" in plan, false);
	assert.deepEqual(plan.command, ["just", "_peer", "web-debugger", "web-debugger"]);
});

// ━━ --env-file ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

test("--env-file is carried for every runner and validated without being read", () => {
	assert.equal(buildPeerLaunchPlan({ name: "researcher", envFile: ".env.peer" }, ctx()).envFile, ".env.peer");
	assert.equal(buildPeerLaunchPlan({ name: "c", runner: "claude-code", envFile: "config/peer.env" }, ctx()).envFile, "config/peer.env");
	assert.equal("envFile" in buildPeerLaunchPlan({ name: "researcher" }, ctx()), false);
	assert.throws(() => buildPeerLaunchPlan({ name: "researcher", envFile: "/etc/passwd" }, ctx()), /must be repo-relative/);
	assert.throws(() => buildPeerLaunchPlan({ name: "researcher", envFile: "../outside.env" }, ctx()), /escapes the repo root/);
	assert.throws(() => buildPeerLaunchPlan({ name: "researcher", envFile: "bad value.env" }, ctx()), /Unsafe env_file path/);
});

// ━━ placement ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

test("placement defaults to a pane and --here opts back into this terminal", () => {
	assert.equal(buildPeerLaunchPlan({ name: "architect" }, ctx()).placement, "pane");
	assert.equal(buildPeerLaunchPlan({ name: "architect", here: true }, ctx()).placement, "here");
	// --here changes only where the argv runs, never what it is.
	assert.deepEqual(
		buildPeerLaunchPlan({ name: "architect", here: true }, ctx()).command,
		buildPeerLaunchPlan({ name: "architect" }, ctx()).command,
	);
});

// ━━ refusals ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

test("a named persona that does not exist is refused", () => {
	assert.throws(() => buildPeerLaunchPlan({ name: "scratch", persona: "ghost" }, ctx()), /Persona "ghost" not found/);
});

test("pi-only flags are refused for a claude-code peer", () => {
	for (const opts of [{ persona: "documenter" }, { noPersona: true }, { piArgs: ["--model", "x"] }]) {
		assert.throws(
			() => buildPeerLaunchPlan({ name: "scratch", runner: "claude-code", ...opts }, ctx()),
			/pi-only|pi arguments/,
		);
	}
});

test("persona peers refuse raw pi arguments", () => {
	assert.throws(() => buildPeerLaunchPlan({ name: "researcher", piArgs: ["--session", "x"] }, ctx()), /personaless core peer/);
});

test("--no-persona forces the Fleet Core shape for a name that matches a persona", () => {
	const plan = buildPeerLaunchPlan({ name: "researcher", noPersona: true, piArgs: ["--session", "/tmp/s.json"] }, ctx());
	assert.equal(plan.kind, "core-peer");
	assert.deepEqual(plan.command, ["just", "_fleet-peer", "researcher", "--session", "/tmp/s.json"]);
	assert.throws(() => buildPeerLaunchPlan({ name: "x", noPersona: true, persona: "researcher" }, ctx()), /contradictory/);
});

test("unknown runners and unsafe names are refused", () => {
	assert.throws(() => buildPeerLaunchPlan({ name: "scratch", runner: "codex" }, ctx()), /Unknown runner "codex" from --runner/);
	assert.throws(() => buildPeerLaunchPlan({ name: "../evil", runner: "claude-code" }, ctx()), /Invalid peer name/);
	assert.throws(() => buildPeerLaunchPlan({ name: "ok", runner: "claude-code", project: "../x" }, ctx()), /Invalid project name/);
});

test("a pi argument with a line break is refused — a pane types the argv one line at a time", () => {
	assert.throws(() => buildPeerLaunchPlan({ name: "architect", piArgs: ["a\nrm -rf /"] }, ctx()), /line break/);
});

// ━━ argument parsing ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

test("peer args parse into one name plus flags", () => {
	assert.deepEqual(parsePeerArgs(["reviewer", "--runner", "claude-code", "--model", "opus", "--project", "af", "--read-only", "--env-file", ".env.peer", "--dry-run"]), {
		name: "reviewer",
		runner: "claude-code",
		model: "opus",
		project: "af",
		readOnly: true,
		envFile: ".env.peer",
		dryRun: true,
	});
	assert.deepEqual(parsePeerArgs(["r", "--here", "--no-persona", "--direction", "down"]), {
		name: "r",
		here: true,
		noPersona: true,
		direction: "down",
		dryRun: false,
	});
});

test("everything after `--` goes to pi verbatim", () => {
	assert.deepEqual(parsePeerArgs(["r", "--project", "af", "--", "--session", "/tmp/s.json", "--dry-run"]), {
		name: "r",
		project: "af",
		piArgs: ["--session", "/tmp/s.json", "--dry-run"],
		dryRun: false,
	});
});

test("peer args reject typos instead of dropping them", () => {
	assert.throws(() => parsePeerArgs([]), /requires a peer name/);
	assert.throws(() => parsePeerArgs(["a", "b"]), /takes one peer name/);
	assert.throws(() => parsePeerArgs(["r", "--porject", "af"]), /Unknown flag: --porject/);
	assert.throws(() => parsePeerArgs(["r", "--session", "x"]), /Unknown flag: --session.*after `--`/s);
	assert.throws(() => parsePeerArgs(["r", "--project"]), /--project requires a value/);
	assert.throws(() => parsePeerArgs(["r", "--env-file"]), /--env-file requires a value/);
	assert.throws(() => parsePeerArgs(["r", "--direction", "sideways"]), /--direction expects right or down/);
});

test("flags of the removed peer groups are refused with the reason", () => {
	for (const [flag, reason] of [
		[["--browser"], /--browser was removed: every pi peer loads chrome-devtools-mcp/],
		[["--extensions", "btw"], /--extensions was removed/],
		[["--all-extensions"], /--all-extensions was removed: a peer loads a deterministic extension set/],
		[["--peers", "x.yaml"], /--peers was removed: peers\.yaml was removed/],
	] as const) {
		assert.throws(() => parsePeerArgs(["r", ...flag]), reason);
	}
});

// ━━ read-only peers (PLAN-11-01, decision D3) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

test("--read-only selects the read-only launch for both runners; without it nothing changes", () => {
	assert.deepEqual(parsePeerArgs(["r", "--read-only"]), { name: "r", readOnly: true, dryRun: false });
	const pi = buildPeerLaunchPlan({ name: "researcher", readOnly: true, model: "openai-codex/gpt-6-luna" }, ctx());
	assert.equal(pi.readOnly, true);
	assert.deepEqual(pi.command, ["just", "_peer-read-only", "researcher", "researcher", "openai-codex/gpt-6-luna"]);
	const claude = buildPeerLaunchPlan({ name: "claude-reviewer", runner: "claude-code", readOnly: true, project: "af" }, ctx());
	assert.equal(claude.readOnly, true);
	assert.deepEqual(claude.command, ["just", "_claude-peer-read-only", "claude-reviewer", "", "af"]);

	const plain = buildPeerLaunchPlan({ name: "researcher" }, ctx());
	assert.equal(Object.hasOwn(plain, "readOnly"), false, "the default plan carries no read-only claim");
	assert.deepEqual(plain.command, ["just", "_peer", "researcher", "researcher"]);
});

test("read-only refuses the personaless core peer, which cannot carry an enforced tool set", () => {
	assert.throws(() => buildPeerLaunchPlan({ name: "architect", readOnly: true }, ctx()), /read-only launches exist for persona peers/);
});

// ━━ Claude Code executable preflight ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

test("Claude Code preflight accepts a runnable version command", () => {
	assert.equal(
		assertClaudeCodeAvailable(() => ({ status: 0, stdout: "2.1.260 (Claude Code)\n" })),
		"2.1.260 (Claude Code)",
	);
});

test("Claude Code preflight explains missing and non-executable installations", () => {
	for (const code of ["ENOENT", "EACCES"] as const) {
		const error = Object.assign(new Error(`spawnSync claude ${code}`), { code });
		assert.throws(
			() => assertClaudeCodeAvailable(() => ({ status: null, error })),
			new RegExp(`preflight failed.*${code}.*repair Claude Code.*claude --version`, "is"),
		);
	}
});

test("Claude Code preflight preserves the useful output from a broken npm placeholder", () => {
	assert.throws(
		() =>
			assertClaudeCodeAvailable(() => ({
				status: 1,
				stdout: "",
				stderr: "Error: claude native binary not installed.\nEither postinstall did not run.",
			})),
		/preflight failed.*status 1.*native binary not installed.*repair Claude Code/is,
	);
});

test("standalone launcher runs the Claude preflight, but dry-run deliberately skips it", () => {
	const run = (extra: string[]) =>
		spawnSync(
			process.execPath,
			["--experimental-strip-types", PEER_LAUNCH_SCRIPT, "probe-reviewer", "--runner", "claude-code", ...extra],
			{
				encoding: "utf8",
				env: { ...process.env, PATH: "" },
			},
		);

	const refused = run(["--here"]);
	assert.equal(refused.status, 1, refused.stderr);
	assert.match(refused.stderr, /fleet peer: Claude Code preflight failed.*ENOENT/is);

	const dryRun = run(["--dry-run"]);
	assert.equal(dryRun.status, 0, dryRun.stderr);
	assert.match(dryRun.stdout, /fleet peer \(dry run\).*claude-peer/is);
	assert.doesNotMatch(dryRun.stderr, /preflight failed/i);
});
