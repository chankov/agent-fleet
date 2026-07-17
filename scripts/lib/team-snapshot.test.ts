// Tests for the pure fleet-resume logic (B5): snapshot build (peer × pane ×
// agent-session join), resume-ref resolution with fallbacks, snapshot
// parsing, and the resume command construction through the layout builder.

import test from "node:test";
import assert from "node:assert/strict";

import { buildTeamLayout, peerCommand, type LayoutNode } from "./herdr-layout.ts";
import { hubCommand, teamSnapshotPath } from "./team-project.ts";
import {
	assertSnapshotProject,
	buildSnapshot,
	parseSnapshot,
	resumeRefForPeer,
	type PeerSnapshot,
} from "./team-snapshot.ts";

const PEERS = [
	{ name: "documenter", persona: "documenter", model: "openai-codex/gpt-5.3-codex-spark" },
	{ name: "researcher", persona: "researcher" },
];
const PANES = [
	{ pane_id: "w7:p2", label: "documenter" },
	{ pane_id: "w7:p3", label: "researcher" },
];
const AGENTS = [
	{ pane_id: "w7:p2", agent: "pi", agent_session: { kind: "path", value: "/home/u/.pi/sessions/doc.jsonl" } },
	{ pane_id: "w7:p3", agent: "pi", agent_session: { kind: "path", value: "/home/u/.pi/sessions/res.jsonl" } },
];

test("buildSnapshot joins peers to session refs via pane labels", () => {
	const snap = buildSnapshot({ team: "docs", hub: false, peers: PEERS, panes: PANES, agents: AGENTS, tag: "wt2" });
	assert.equal(snap.version, 1);
	assert.equal(snap.project, "default");
	assert.equal(snap.workspace_label, "wt2-peers-docs");
	assert.deepEqual(snap.peers[0].resume, { kind: "path", value: "/home/u/.pi/sessions/doc.jsonl" });
	assert.deepEqual(snap.peers[1].resume, { kind: "path", value: "/home/u/.pi/sessions/res.jsonl" });
	// manifest fields survive
	assert.equal(snap.peers[0].model, "openai-codex/gpt-5.3-codex-spark");
});

test("buildSnapshot: missing pane or session snapshots as resume:null; hub label", () => {
	const snap = buildSnapshot({ team: "docs", hub: true, peers: PEERS, panes: [PANES[0]], agents: [], tag: "wt2" });
	assert.equal(snap.workspace_label, "wt2-hub-docs");
	assert.equal(snap.peers[0].resume, null);
	assert.equal(snap.peers[1].resume, null);
});

test("snapshot JSON round-trips through parseSnapshot; garbage is rejected", () => {
	const snap = buildSnapshot({ team: "docs", hub: false, peers: PEERS, panes: PANES, agents: AGENTS });
	assert.deepEqual(parseSnapshot(JSON.stringify(snap)), snap);
	assert.throws(() => parseSnapshot("not json"), /not valid JSON/);
	assert.throws(() => parseSnapshot('{"version":2}'), /unexpected shape/);
	assert.throws(() => parseSnapshot(JSON.stringify({ ...snap, project: 7 })), /project must be a string/);
	assert.throws(() => parseSnapshot(JSON.stringify({ ...snap, team: "bad/team" })), /Invalid team name/);
});

test("project-specific snapshots use distinct labels/paths and old snapshots default to default", () => {
	const snap = buildSnapshot({ team: "docs", project: "acme", hub: true, peers: PEERS, panes: PANES, agents: AGENTS, tag: "wt2" });
	assert.equal(snap.project, "acme");
	assert.equal(snap.workspace_label, "wt2-hub-docs--project.acme");
	assert.equal(teamSnapshotPath("/snap", "docs"), "/snap/docs.json");
	assert.equal(teamSnapshotPath("/snap", "docs", "acme"), "/snap/projects/acme/docs.json");

	const old = { version: 1, team: "docs", hub: false, workspace_label: "pi-peers-docs", taken_at: "t", peers: [] };
	assert.equal(parseSnapshot(JSON.stringify(old)).project, "default");
	assert.doesNotThrow(() => assertSnapshotProject(snap, "acme"));
	assert.throws(() => assertSnapshotProject(snap, "default"), /Snapshot project mismatch/);
});

test("resumeRefForPeer: usable path refs resolve; gone/unsupported refs fall back with a reason", () => {
	const mk = (resume: PeerSnapshot["resume"]): PeerSnapshot => ({ name: "x", persona: "p", resume });
	const skips: string[] = [];
	const onSkip = (_p: PeerSnapshot, reason: string) => skips.push(reason);

	assert.equal(resumeRefForPeer(mk({ kind: "path", value: "/tmp/s.jsonl" }), () => true, onSkip), "/tmp/s.jsonl");
	assert.equal(resumeRefForPeer(mk({ kind: "path", value: "/tmp/s.jsonl" }), () => false, onSkip), undefined);
	assert.equal(resumeRefForPeer(mk({ kind: "id", value: "uuid" }), () => true, onSkip), undefined);
	assert.equal(resumeRefForPeer(mk(null), () => true, onSkip), undefined);
	assert.equal(skips.length, 3);
	assert.match(skips[0], /session file gone/);
	assert.match(skips[1], /unsupported resume kind/);
	assert.match(skips[2], /no session ref/);
});

test("peerCommand fills the session positional (empty model placeholder when needed)", () => {
	assert.deepEqual(
		peerCommand({ name: "a", persona: "researcher", model: "m/x" }, "t", "/tmp/s.jsonl"),
		["just", "_peer", "researcher", "a", "m/x", "/tmp/s.jsonl"],
	);
	// no model → empty placeholder keeps `session` in the 4th slot
	assert.deepEqual(
		peerCommand({ name: "a", persona: "researcher" }, "t", "/tmp/s.jsonl"),
		["just", "_peer", "researcher", "a", "", "/tmp/s.jsonl"],
	);
	assert.throws(() => peerCommand({ name: "a", persona: "p" }, "t", "/tmp/bad path"), /Unsafe resume ref/);
});

test("buildTeamLayout resumeForPeer hook lands refs in the pane commands", () => {
	const snap = buildSnapshot({ team: "docs", hub: false, peers: PEERS, panes: PANES, agents: AGENTS });
	const tree = buildTeamLayout({
		team: snap.team,
		peers: snap.peers,
		repoRoot: "/repo",
		resumeForPeer: (p) => resumeRefForPeer(p as PeerSnapshot, () => true),
	});
	const panes: Array<Extract<LayoutNode, { type: "pane" }>> = [];
	(function walk(n: LayoutNode) {
		if (n.type === "pane") panes.push(n);
		else {
			walk(n.first);
			walk(n.second);
		}
	})(tree);
	assert.deepEqual(panes[0].command?.slice(-1), ["/home/u/.pi/sessions/doc.jsonl"]);
	assert.deepEqual(panes[1].command, ["just", "_peer", "researcher", "researcher", "", "/home/u/.pi/sessions/res.jsonl"]);
});

test("resume command construction can relaunch hub and peers with the requested project", () => {
	const snap = buildSnapshot({ team: "docs", project: "acme", hub: true, peers: PEERS, panes: PANES, agents: AGENTS });
	const tree = buildTeamLayout({
		team: snap.team,
		peers: snap.peers,
		repoRoot: "/repo",
		project: snap.project,
		resumeForPeer: (p) => resumeRefForPeer(p as PeerSnapshot, () => true),
		hub: { command: hubCommand(snap.project), label: "hub", ratio: 0.4 },
	});
	assert.equal(tree.type, "split");
	if (tree.type === "split") {
		assert.equal(tree.first.type, "pane");
		if (tree.first.type === "pane") assert.deepEqual(tree.first.command, ["just", "hub", "--project", "acme"]);
	}
	const panes: Array<Extract<LayoutNode, { type: "pane" }>> = [];
	(function walk(n: LayoutNode) {
		if (n.type === "pane") panes.push(n);
		else {
			walk(n.first);
			walk(n.second);
		}
	})(tree);
	for (const pane of panes.filter((p) => p.label !== "hub")) assert.equal(pane.command?.at(-1), "acme");
});
