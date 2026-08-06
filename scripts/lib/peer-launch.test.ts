import assert from "node:assert/strict";
import test from "node:test";

import { buildPeerLaunchPlan, parsePeerArgs, type PeerLaunchContext } from "./peer-launch.ts";

const PEERS_YAML = `
review:
  - name: code-reviewer
    runner: claude-code
  - name: documenter
    persona: documenter
    model: openai-codex/gpt-5.6-terra

web:
  - name: web-debugger
    persona: web-debugger
    model: openai-codex/gpt-5.6-terra
    extensions: chrome-devtools-mcp
    env_file: .env
`;

function ctx(overrides: Partial<PeerLaunchContext> = {}): PeerLaunchContext {
	return {
		peersYaml: PEERS_YAML,
		personaExists: (persona) => ["documenter", "web-debugger", "researcher"].includes(persona),
		worktreeTag: "wt2",
		...overrides,
	};
}

// ━━ the three shapes of peer ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

test("a name with no persona and no declaration is the identity-only Fleet Core peer", () => {
	// This is what `just fleet peer <name>` meant before pane placement existed,
	// so the argv must still be the `_fleet-peer` recipe with its two booleans.
	const plan = buildPeerLaunchPlan({ name: "architect", project: "af" }, ctx());
	assert.equal(plan.kind, "core-peer");
	assert.equal(plan.runner, "pi");
	assert.deepEqual(plan.command, ["just", "_fleet-peer", "architect", "false", "false", "--project", "af"]);
	assert.equal(plan.workspaceLabel, "wt2-peer-architect--project.af");
});

test("core peers keep model/capability flags and pass pi arguments through", () => {
	const plan = buildPeerLaunchPlan(
		{
			name: "debugger",
			model: "openai-codex/gpt-5.6-luna",
			browser: true,
			allExtensions: true,
			piArgs: ["--session", "/tmp/s.json"],
		},
		ctx(),
	);
	assert.equal(plan.kind, "core-peer");
	assert.deepEqual(plan.command, [
		"just", "_fleet-peer", "debugger", "true", "true",
		"--model", "openai-codex/gpt-5.6-luna", "--session", "/tmp/s.json",
	]);
});

test("a name matching a persona becomes that persona peer", () => {
	const plan = buildPeerLaunchPlan({ name: "researcher" }, ctx());
	assert.equal(plan.kind, "persona-peer");
	assert.equal(plan.persona, "researcher");
	assert.deepEqual(plan.command, ["just", "_peer", "researcher", "researcher"]);
});

test("an undeclared name launches a Claude Code peer with no manifest entry", () => {
	const plan = buildPeerLaunchPlan({ name: "scratch-reviewer", runner: "claude-code", model: "opus", project: "af" }, ctx());
	assert.equal(plan.kind, "claude-peer");
	assert.equal(plan.declared, false);
	// _claude-peer positionals: name model session project
	assert.deepEqual(plan.command, ["just", "_claude-peer", "scratch-reviewer", "opus", "", "af"]);
});

// ━━ peers.yaml resolution ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

test("a declared name keeps its peers.yaml runner without --runner", () => {
	const plan = buildPeerLaunchPlan({ name: "code-reviewer", project: "af" }, ctx());
	assert.equal(plan.kind, "claude-peer");
	assert.equal(plan.declared, true);
	assert.deepEqual(plan.command, ["just", "_claude-peer", "code-reviewer", "", "", "af"]);
});

test("a declared pi peer inherits its persona, model, extensions and env_file", () => {
	const plan = buildPeerLaunchPlan({ name: "web-debugger", project: "af" }, ctx());
	assert.equal(plan.kind, "persona-peer");
	assert.equal(plan.envFile, ".env");
	assert.deepEqual(plan.command, [
		"just", "_peer-plus", "chrome-devtools-mcp", "web-debugger", "web-debugger",
		"openai-codex/gpt-5.6-terra", "", "af",
	]);
});

test("flags override the declaration", () => {
	const plan = buildPeerLaunchPlan({ name: "documenter", model: "anthropic/claude-opus-4-8" }, ctx());
	assert.deepEqual(plan.command, ["just", "_peer", "documenter", "documenter", "anthropic/claude-opus-4-8"]);
	assert.equal(plan.workspaceLabel, "wt2-peer-documenter");
});

test("a missing peers.yaml still launches a Claude Code peer", () => {
	const plan = buildPeerLaunchPlan({ name: "solo", runner: "claude-code" }, ctx({ peersYaml: "" }));
	assert.equal(plan.declared, false);
	assert.deepEqual(plan.command, ["just", "_claude-peer", "solo"]);
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

// ━━ --browser on a persona peer ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

test("--browser adds the devtools extension to a persona peer without duplicating it", () => {
	const plan = buildPeerLaunchPlan({ name: "researcher", browser: true }, ctx());
	assert.deepEqual(plan.command, ["just", "_peer-plus", "chrome-devtools-mcp", "researcher", "researcher"]);

	const declared = buildPeerLaunchPlan({ name: "web-debugger", browser: true }, ctx());
	assert.equal(declared.extensions, "chrome-devtools-mcp");
});

// ━━ refusals ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

test("a named persona that does not exist is refused", () => {
	assert.throws(() => buildPeerLaunchPlan({ name: "scratch", persona: "ghost" }, ctx()), /Persona "ghost" not found/);
});

test("pi-only flags are refused for a claude-code peer", () => {
	for (const opts of [{ persona: "documenter" }, { extensions: "chrome-devtools-mcp" }, { browser: true }, { piArgs: ["--model", "x"] }]) {
		assert.throws(
			() => buildPeerLaunchPlan({ name: "scratch", runner: "claude-code", ...opts }, ctx()),
			/pi-only|pi arguments/,
		);
	}
});

test("persona peers refuse the flags that would make them non-deterministic", () => {
	assert.throws(() => buildPeerLaunchPlan({ name: "researcher", allExtensions: true }, ctx()), /--all-extensions is not available/);
	assert.throws(() => buildPeerLaunchPlan({ name: "researcher", piArgs: ["--session", "x"] }, ctx()), /personaless core peer/);
});

test("--no-persona forces the Fleet Core shape for a name that matches a persona", () => {
	// The escape hatch the refusals above point at: `researcher` resolves to a
	// persona by name, but the pre-merge meaning of `just fleet peer researcher`
	// — Fleet Core + coms under that identity — must stay reachable.
	const plan = buildPeerLaunchPlan({ name: "researcher", noPersona: true, piArgs: ["--session", "/tmp/s.json"] }, ctx());
	assert.equal(plan.kind, "core-peer");
	assert.deepEqual(plan.command, ["just", "_fleet-peer", "researcher", "false", "false", "--session", "/tmp/s.json"]);
	assert.throws(() => buildPeerLaunchPlan({ name: "x", noPersona: true, persona: "researcher" }, ctx()), /contradictory/);
});

test("--extensions without a persona is refused rather than silently ignored", () => {
	assert.throws(() => buildPeerLaunchPlan({ name: "architect", extensions: "btw" }, ctx()), /--extensions needs a persona peer/);
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
	assert.deepEqual(parsePeerArgs(["reviewer", "--runner", "claude-code", "--model", "opus", "--project", "af", "--dry-run"]), {
		name: "reviewer",
		runner: "claude-code",
		model: "opus",
		project: "af",
		dryRun: true,
	});
	assert.deepEqual(parsePeerArgs(["r", "--here", "--browser", "--all-extensions", "--direction", "down"]), {
		name: "r",
		here: true,
		browser: true,
		allExtensions: true,
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
	assert.throws(() => parsePeerArgs(["r", "--direction", "sideways"]), /--direction expects right or down/);
});
