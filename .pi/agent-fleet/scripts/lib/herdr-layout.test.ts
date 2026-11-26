// Tests for the pure peer launch logic: peer fields → recipe argv, env files,
// and the justfile recipes those argvs name. There are no peer groups
// (PLAN-11-01, D8/D16); each peer is built from its own flags.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { parseEnvFile, peerCommand, type Peer } from "./herdr-layout.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

test("pi peers route through _peer and claude-code peers through _claude-peer", () => {
	assert.deepEqual(peerCommand({ name: "documenter", persona: "documenter", model: "m/x" }), ["just", "_peer", "documenter", "documenter", "m/x"]);
	assert.deepEqual(peerCommand({ name: "r", persona: "researcher" }), ["just", "_peer", "researcher", "r"]);
	assert.deepEqual(peerCommand({ name: "claude-main", runner: "claude-code", model: "opus" }), ["just", "_claude-peer", "claude-main", "opus"]);
	assert.deepEqual(peerCommand({ name: "c", runner: "claude-code" }), ["just", "_claude-peer", "c"]);
});

test("non-default project appends the hidden recipe project positional with a model placeholder", () => {
	assert.deepEqual(peerCommand({ name: "a", persona: "researcher" }, "acme"), ["just", "_peer", "researcher", "a", "", "acme"]);
	assert.deepEqual(peerCommand({ name: "a", persona: "researcher", model: "m/x" }, "acme"), ["just", "_peer", "researcher", "a", "m/x", "acme"]);
	assert.deepEqual(peerCommand({ name: "c", runner: "claude-code" }, "acme"), ["just", "_claude-peer", "c", "", "acme"]);
	assert.deepEqual(peerCommand({ persona: "editor", name: "plan32-editor" }, "ringithub-plan32-prd2"), ["just", "_peer", "editor", "plan32-editor", "", "ringithub-plan32-prd2"]);
	// The default pool stays on the short argv shape the recipes default to.
	assert.deepEqual(peerCommand({ persona: "editor", name: "b" }), ["just", "_peer", "editor", "b"]);
	assert.throws(() => peerCommand({ name: "a", persona: "researcher" }, "bad value"), /Invalid project name/);
});

test("unsafe values are rejected", () => {
	for (const bad of [
		{ name: "x; rm -rf /", persona: "researcher" },
		{ name: "ok", persona: "researcher", model: "$(evil)" },
		{ name: "ok", persona: "a persona with spaces" },
	] as Peer[]) {
		assert.throws(() => peerCommand(bad), /Unsafe value/);
	}
});

test("missing persona or name and unknown runners are rejected", () => {
	assert.throws(() => peerCommand({ name: "x" }), /missing a persona/);
	assert.throws(() => peerCommand({ persona: "p" }), /missing a name/);
	assert.throws(() => peerCommand({ name: "x", runner: "cursor" }), /Unknown runner/);
});

test("parseEnvFile handles comments, quotes, export prefix; rejects garbage", () => {
	const env = parseEnvFile(
		[
			"# comment",
			"",
			"PLAIN=value",
			'QUOTED="hello world"',
			"SINGLE='single quoted'",
			"export EXPORTED=yes",
			"EMPTY=",
		].join("\n"),
	);
	assert.deepEqual(env, {
		PLAIN: "value",
		QUOTED: "hello world",
		SINGLE: "single quoted",
		EXPORTED: "yes",
		EMPTY: "",
	});
	assert.throws(() => parseEnvFile("not a kv line", "peers.env"), /peers\.env:1: not a KEY=VALUE line/);
	assert.throws(() => parseEnvFile("1BAD=x"), /not a KEY=VALUE line/);
});

// ── read_only peers (PLAN-11-01, decision D3) ──

function recipe(justfile: string, name: string): { header: string; body: string } {
	const lines = justfile.split("\n");
	const i = lines.findIndex((line) => line.startsWith(`${name} `) || line.startsWith(`${name}:`));
	assert.ok(i >= 0, `recipe ${name} exists`);
	return { header: lines[i], body: lines[i + 1] };
}

test("read_only: true routes a pi peer through _peer-read-only and a claude-code peer through _claude-peer-read-only", () => {
	const claude: Peer = { name: "claude-reviewer", runner: "claude-code", read_only: "true" };
	const researcher: Peer = { name: "researcher", persona: "researcher", model: "openai-codex/gpt-6-luna", read_only: "true" };
	assert.deepEqual(peerCommand(claude), ["just", "_claude-peer-read-only", "claude-reviewer"]);
	assert.deepEqual(peerCommand(researcher), ["just", "_peer-read-only", "researcher", "researcher", "openai-codex/gpt-6-luna"]);
	assert.deepEqual(peerCommand({ name: "documenter", persona: "documenter", read_only: "false" }), ["just", "_peer", "documenter", "documenter"], "false is the default route");
	// Same positionals as the writable recipes: model/project stay aligned.
	assert.deepEqual(peerCommand(researcher, "af"), ["just", "_peer-read-only", "researcher", "researcher", "openai-codex/gpt-6-luna", "af"]);
	assert.deepEqual(peerCommand(claude, "af"), ["just", "_claude-peer-read-only", "claude-reviewer", "", "af"]);
});

test("bad read_only values are refused", () => {
	for (const bad of ["yes", "TRUE", "1", ""]) {
		assert.throws(() => peerCommand({ name: "r", persona: "researcher", read_only: bad }), /(Invalid|Unsafe value for) read_only/, JSON.stringify(bad));
	}
});

test("every pi peer recipe loads chrome-devtools-mcp except the read-only one, which loads no extension (D17)", async () => {
	const justfile = readFileSync(join(REPO_ROOT, "justfile"), "utf-8");
	const { READ_ONLY_TOOL_NAMES } = await import("../../../harnesses/lib/coms-core-io.ts");

	const peer = recipe(justfile, "_peer");
	const corePeer = recipe(justfile, "_fleet-peer");
	const peerReadOnly = recipe(justfile, "_peer-read-only");
	for (const [name, r] of [["_peer", peer], ["_fleet-peer", corePeer]] as const) {
		assert.match(r.body, /--no-extensions \{\{fleet_core_extensions\}\} -e \.pi\/harnesses\/coms\/index\.ts \{\{fleet_browser_extension\}\} /, `${name} always loads the browser extension`);
		assert.doesNotMatch(r.body, /browser=|all_extensions|discovery=/, `${name} has no extension choice`);
	}
	assert.match(justfile, /\nfleet_browser_extension := "-e \.pi\/extensions\/chrome-devtools-mcp\/index\.ts"/);
	assert.doesNotMatch(justfile, /\n_peer-plus /, "the extension-list route is gone");

	assert.equal(peerReadOnly.header.replace("_peer-read-only", "_peer"), peer.header, "same positionals as _peer");
	assert.doesNotMatch(peerReadOnly.body, /fleet_browser_extension|chrome-devtools-mcp|\.pi\/extensions\//, "a read-only peer loads no extension");
	const tools = peerReadOnly.body.match(/--coms-read-only --tools (\S+) --no-mcp --project \{\{project\}\}/);
	assert.ok(tools, "pi gets --coms-read-only, the --tools allowlist and --no-mcp");
	assert.deepEqual(tools[1].split(","), ["read", "grep", "find", "ls"], "inspection tools only — no coms_* (no asking a writable peer)");
	for (const name of tools[1].split(",")) assert.ok(READ_ONLY_TOOL_NAMES.has(name), `${name} is in the coms read-only set`);
	assert.deepEqual([...READ_ONLY_TOOL_NAMES].sort(), [...tools[1].split(",")].sort(), "the launch list and the declared set are the same set");
	assert.equal(
		peerReadOnly.body.replace(/ --coms-read-only --tools \S+ --no-mcp/, ""),
		peer.body.replace(" {{fleet_browser_extension}}", ""),
		"otherwise identical to _peer",
	);
	for (const name of ["_peer", "_fleet-peer", "_claude-peer"]) {
		assert.doesNotMatch(recipe(justfile, name).body, /--coms-read-only|--read-only|--no-mcp|--tools /, `${name} is not read-only`);
	}

	const claude = recipe(justfile, "_claude-peer");
	const claudeReadOnly = recipe(justfile, "_claude-peer-read-only");
	assert.equal(claudeReadOnly.header.replace("_claude-peer-read-only", "_claude-peer"), claude.header, "same positionals as _claude-peer");
	assert.match(claudeReadOnly.body, /claude-code-preflight\.ts \|\| exit \$\?; /);
	assert.match(claudeReadOnly.body, /coms-claude-bridge\.ts --name \{\{name\}\} --project \{\{project\}\} --read-only /);
	assert.doesNotMatch(claudeReadOnly.body, /exec-at-target|&\s*bridge_pid/, "the bridge, not the recipe, starts Claude");
});

test("peer recipes carry no session/resume positional (team resume was removed)", () => {
	const justfile = readFileSync(join(REPO_ROOT, "justfile"), "utf-8");
	assert.match(justfile, /\n_peer persona name="" model="" project="default":/);
	assert.match(justfile, /\n_peer-read-only persona name="" model="" project="default":/);
	assert.match(justfile, /\n_claude-peer name model="" project="default":/);
	assert.match(justfile, /\n_claude-peer-read-only name model="" project="default":/);
	assert.match(justfile, /\n_fleet-peer name \*args:/);
	for (const name of ["_peer", "_peer-read-only", "_claude-peer", "_claude-peer-read-only"]) {
		assert.doesNotMatch(recipe(justfile, name).body, /\{\{ *session|--session |--resume/, `${name} has no resume path`);
	}
});
