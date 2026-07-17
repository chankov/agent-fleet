// Tests for the pure herdr fleet layout logic: peers.yaml → command argvs →
// declarative layout trees, against the REAL .pi/agents/peers.yaml so the
// shipped teams stay spawnable.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
	buildTeamLayout,
	parseEnvFile,
	parsePeersYaml,
	peerCommand,
	type LayoutNode,
	type Peer,
} from "./herdr-layout.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const realPeersYaml = readFileSync(join(REPO_ROOT, ".pi", "agents", "peers.yaml"), "utf-8");

function panesOf(node: LayoutNode): Array<Extract<LayoutNode, { type: "pane" }>> {
	if (node.type === "pane") return [node];
	return [...panesOf(node.first), ...panesOf(node.second)];
}

test("real peers.yaml parses into the shipped teams", () => {
	const teams = parsePeersYaml(realPeersYaml);
	assert.deepEqual(Object.keys(teams).sort(), [
		"debug",
		"default",
		"docs",
		"frontend",
		"full",
		"hotfix",
		"info",
		"plan",
		"release",
		"review",
		"security",
		"web",
	]);
	assert.equal(teams.full.length, 3);
	assert.equal(teams.web.length, 1);
	assert.equal(teams.docs.length, 2);
	assert.equal(teams.default.length, 6);
	assert.equal(teams.debug.length, 3);
	assert.equal(teams.frontend.length, 4);
	assert.equal(teams.security.length, 4);
	assert.equal(teams.hotfix.length, 2);
	assert.equal(teams.release.length, 2);
	assert.equal(teams.info.length, 2);
	assert.equal(teams.plan.length, 2);
	assert.equal(teams.review.length, 2);
});

test("full team produces a stable layout tree with one labeled pane per peer", () => {
	const teams = parsePeersYaml(realPeersYaml);
	const tree = buildTeamLayout({ team: "full", peers: teams.full, repoRoot: REPO_ROOT });
	const panes = panesOf(tree);
	assert.deepEqual(
		panes.map((p) => p.label),
		["web-debugger", "documenter", "researcher"],
	);
	for (const p of panes) assert.equal(p.cwd, REPO_ROOT);
	// 3 peers → root split right (2|1), first half splits down.
	assert.equal(tree.type, "split");
	if (tree.type === "split") {
		assert.equal(tree.direction, "right");
		assert.equal(tree.ratio, 2 / 3);
		assert.equal(tree.first.type, "split");
		if (tree.first.type === "split") assert.equal(tree.first.direction, "down");
		assert.equal(tree.second.type, "pane");
	}
});

test("_peer-plus routing is preserved for extensions: peers", () => {
	const teams = parsePeersYaml(realPeersYaml);
	const web = buildTeamLayout({ team: "web", peers: teams.web, repoRoot: REPO_ROOT });
	const panes = panesOf(web);
	assert.equal(panes.length, 1);
	assert.deepEqual(panes[0].command, [
		"just",
		"_peer-plus",
		"chrome-devtools-mcp",
		"web-debugger",
		"web-debugger",
		"openai-codex/gpt-5.5",
	]);
});

test("docs team peers route through plain _peer with their models", () => {
	const teams = parsePeersYaml(realPeersYaml);
	const docs = buildTeamLayout({ team: "docs", peers: teams.docs, repoRoot: REPO_ROOT });
	const panes = panesOf(docs);
	assert.deepEqual(panes[0].command, [
		"just",
		"_peer",
		"documenter",
		"documenter",
		"openai-codex/gpt-5.3-codex-spark",
	]);
	assert.deepEqual(panes[1].command, [
		"just",
		"_peer",
		"researcher",
		"researcher",
		"openai-codex/gpt-5.3-codex-spark",
	]);
});

test("review peers in mirrored teams route through Claude Code", () => {
	const teams = parsePeersYaml(realPeersYaml);
	const defaultTeam = buildTeamLayout({ team: "default", peers: teams.default, repoRoot: REPO_ROOT });
	const panes = panesOf(defaultTeam);
	assert.deepEqual(panes[1].command, ["just", "_claude-peer", "plan-reviewer"]);
	assert.deepEqual(panes[4].command, ["just", "_claude-peer", "code-reviewer"]);
	for (const team of ["debug", "frontend", "security", "hotfix", "info"]) {
		const reviewer = teams[team].find((p) => p.name === "code-reviewer");
		assert.deepEqual(peerCommand(reviewer as Peer, team), ["just", "_claude-peer", "code-reviewer"]);
	}
});

test("non-default project appends the hidden recipe project positional with placeholders", () => {
	assert.deepEqual(peerCommand({ name: "a", persona: "researcher" }, "t", undefined, "acme"), [
		"just",
		"_peer",
		"researcher",
		"a",
		"",
		"",
		"acme",
	]);
	assert.deepEqual(peerCommand({ name: "a", persona: "researcher", model: "m/x" }, "t", undefined, "acme"), [
		"just",
		"_peer",
		"researcher",
		"a",
		"m/x",
		"",
		"acme",
	]);
	assert.deepEqual(peerCommand({ name: "a", persona: "researcher" }, "t", "/tmp/s.jsonl", "acme"), [
		"just",
		"_peer",
		"researcher",
		"a",
		"",
		"/tmp/s.jsonl",
		"acme",
	]);
	assert.deepEqual(
		peerCommand({ name: "a", persona: "web-debugger", extensions: "chrome-devtools-mcp" }, "t", undefined, "acme"),
		["just", "_peer-plus", "chrome-devtools-mcp", "web-debugger", "a", "", "", "acme"],
	);
	assert.deepEqual(peerCommand({ name: "c", runner: "claude-code" }, "t", undefined, "acme"), [
		"just",
		"_claude-peer",
		"c",
		"",
		"",
		"acme",
	]);
});

test("buildTeamLayout threads a non-default project to every peer pane", () => {
	const teams = parsePeersYaml(realPeersYaml);
	const docs = buildTeamLayout({ team: "docs", peers: teams.docs, repoRoot: REPO_ROOT, project: "acme" });
	const panes = panesOf(docs);
	assert.equal(panes.length, 2);
	for (const pane of panes) assert.deepEqual(pane.command?.slice(-2), ["", "acme"]);
	assert.throws(() => buildTeamLayout({ team: "docs", peers: teams.docs, repoRoot: REPO_ROOT, project: "bad value" }), /Invalid project name/);
});

test("unsafe manifest values are rejected", () => {
	for (const bad of [
		{ name: "x; rm -rf /", persona: "researcher" },
		{ name: "ok", persona: "researcher", model: "$(evil)" },
		{ name: "ok", persona: "a persona with spaces" },
		{ name: "ok", persona: "researcher", extensions: "a`b" },
	] as Peer[]) {
		assert.throws(() => peerCommand(bad, "t"), /Unsafe value/);
	}
});

test("missing persona or name is rejected", () => {
	assert.throws(() => peerCommand({ name: "x" }, "t"), /missing a persona/);
	assert.throws(() => peerCommand({ persona: "p" }, "t"), /missing a name/);
	assert.throws(() => buildTeamLayout({ team: "t", peers: [], repoRoot: "/r" }), /has no peers/);
});

test("hub option puts the hub in a larger root pane with the team tiled beside it", () => {
	const teams = parsePeersYaml(realPeersYaml);
	const tree = buildTeamLayout({
		team: "docs",
		peers: teams.docs,
		repoRoot: REPO_ROOT,
		hub: { command: ["just", "hub"], label: "hub" },
	});
	assert.equal(tree.type, "split");
	if (tree.type === "split") {
		assert.equal(tree.direction, "right");
		assert.equal(tree.ratio, 0.4);
		assert.equal(tree.first.type, "pane");
		if (tree.first.type === "pane") {
			assert.equal(tree.first.label, "hub");
			assert.deepEqual(tree.first.command, ["just", "hub"]);
		}
		assert.equal(panesOf(tree.second).length, 2);
	}
});

test("conductor option puts Hermes in a root pane with the team tiled beside it", () => {
	const teams = parsePeersYaml(realPeersYaml);
	const tree = buildTeamLayout({
		team: "docs",
		peers: teams.docs,
		repoRoot: REPO_ROOT,
		hub: { command: ["hermes", "-p", "dev"], label: "conductor", ratio: 0.35 },
	});
	assert.equal(tree.type, "split");
	if (tree.type === "split") {
		assert.equal(tree.direction, "right");
		assert.equal(tree.ratio, 0.35);
		assert.equal(tree.first.type, "pane");
		if (tree.first.type === "pane") {
			assert.equal(tree.first.label, "conductor");
			assert.deepEqual(tree.first.command, ["hermes", "-p", "dev"]);
		}
		assert.deepEqual(panesOf(tree.second).map((p) => p.label), ["documenter", "researcher"]);
	}
});

test("envForPeer hook injects per-pane env only when it returns entries", () => {
	const peers: Peer[] = [
		{ name: "a", persona: "researcher", env_file: ".env.a" },
		{ name: "b", persona: "researcher" },
	];
	const tree = buildTeamLayout({
		team: "t",
		peers,
		repoRoot: "/r",
		envForPeer: (p) => (p.env_file ? { FROM_FILE: p.env_file } : undefined),
	});
	const [a, b] = panesOf(tree);
	assert.deepEqual(a.env, { FROM_FILE: ".env.a" });
	assert.equal("env" in b, false);
});

test("delayForPeer hook injects AGENT_FLEET_SPAWN_DELAY only for positive delays", () => {
	const peers: Peer[] = [
		{ name: "a", persona: "researcher", env_file: ".env.a" },
		{ name: "b", persona: "researcher" },
		{ name: "c", persona: "researcher" },
	];
	const delays = new Map([["a", 0], ["b", 4], ["c", 5]]);
	const tree = buildTeamLayout({
		team: "t",
		peers,
		repoRoot: "/r",
		envForPeer: (p) => (p.env_file ? { FROM_FILE: p.env_file } : undefined),
		delayForPeer: (p) => delays.get(p.name as string),
	});
	const [a, b, c] = panesOf(tree);
	// zero delay → no stagger var; env_file entries survive alongside
	assert.deepEqual(a.env, { FROM_FILE: ".env.a" });
	assert.deepEqual(b.env, { AGENT_FLEET_SPAWN_DELAY: "4" });
	assert.deepEqual(c.env, { AGENT_FLEET_SPAWN_DELAY: "5" });
	assert.throws(
		() => buildTeamLayout({ team: "t", peers, repoRoot: "/r", delayForPeer: () => -1 }),
		/Invalid spawn delay/,
	);
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

test("layout trees are deterministic (stable across calls)", () => {
	const teams = parsePeersYaml(realPeersYaml);
	const a = buildTeamLayout({ team: "full", peers: teams.full, repoRoot: "/r" });
	const b = buildTeamLayout({ team: "full", peers: teams.full, repoRoot: "/r" });
	assert.deepEqual(a, b);
});
