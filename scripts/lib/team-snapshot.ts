// scripts/lib/team-snapshot.ts
//
// Pure logic for fleet resume (B5): snapshot a running team (peer manifest +
// per-peer session resume refs harvested from herdr) and rebuild it later.
// See docs/plans/herdr/b5-resume-notes.md for the decisions: pane exit closes
// the pane (nothing to re-attach), layout.export cannot target an unfocused
// workspace, so snapshots store peers + refs and the grid is regenerated with
// the same builder team-up uses.
//
// No sockets, no fs, no process.exit here — the wiring lives in
// scripts/team-snapshot.ts.

import type { Peer } from "./herdr-layout.ts";
import { DEFAULT_PROJECT, teamWorkspaceLabel, validateProject, validateTeamName } from "./team-project.ts";

// Shape of herdr's agent_session (agent.list): pi panes carry
// {kind:"path", value:<session .jsonl>}, claude panes {kind:"id", value:<uuid>}.
export interface ResumeRef {
	kind: string;
	value: string;
}

export interface PeerSnapshot extends Peer {
	resume: ResumeRef | null;
}

export interface TeamSnapshot {
	version: 1;
	team: string;
	project: string;
	hub: boolean;
	workspace_label: string;
	taken_at: string;
	peers: PeerSnapshot[];
}

// Minimal shapes of the herdr responses the builder joins over.
export interface PaneLite {
	pane_id: string;
	label?: string;
	[key: string]: unknown;
}
export interface AgentLite {
	pane_id?: string;
	agent?: string;
	agent_session?: { kind?: string; value?: string };
	[key: string]: unknown;
}

// Join: peers.yaml manifest × pane labels (pane label = peer name, set by the
// layout) × agent sessions (keyed by pane_id). A peer whose pane or session
// is missing snapshots with resume: null — it will start fresh on resume.
export function buildSnapshot(opts: {
	team: string;
	hub: boolean;
	peers: Peer[];
	panes: PaneLite[];
	agents: AgentLite[];
	now?: Date;
	project?: string;
}): TeamSnapshot {
	const { team, hub, peers, panes, agents, project = DEFAULT_PROJECT } = opts;
	validateTeamName(team);
	validateProject(project);
	const paneByLabel = new Map<string, string>();
	for (const p of panes) {
		if (p.label) paneByLabel.set(p.label, p.pane_id);
	}
	const sessionByPane = new Map<string, ResumeRef>();
	for (const a of agents) {
		const s = a.agent_session;
		if (a.pane_id && s && typeof s.kind === "string" && typeof s.value === "string") {
			sessionByPane.set(a.pane_id, { kind: s.kind, value: s.value });
		}
	}
	return {
		version: 1,
		team,
		project,
		hub,
		workspace_label: teamWorkspaceLabel(hub ? "hub" : "peers", team, project),
		taken_at: (opts.now ?? new Date()).toISOString(),
		peers: peers.map((peer) => {
			const paneId = peer.name ? paneByLabel.get(peer.name) : undefined;
			const resume = paneId ? sessionByPane.get(paneId) ?? null : null;
			return { ...peer, resume };
		}),
	};
}

// The resume ref usable by this peer's launch recipe, or undefined to start
// fresh. `refUsable` is injected (fs check for pi paths); refs of kinds the
// recipes cannot consume yet (e.g. claude ids before the Phase-4 runner
// lands) resolve undefined with a reason via `onSkip`.
export function resumeRefForPeer(
	peer: PeerSnapshot,
	refUsable: (ref: ResumeRef) => boolean,
	onSkip?: (peer: PeerSnapshot, reason: string) => void,
): string | undefined {
	if (!peer.resume) {
		onSkip?.(peer, "no session ref in snapshot — starting fresh");
		return undefined;
	}
	// pi peers resume by session file path; claude-code peers by session id
	// (herdr reports {kind:"id"} for claude — `claude --resume <id>`).
	const wantKind = peer.runner === "claude-code" ? "id" : "path";
	if (peer.resume.kind !== wantKind) {
		onSkip?.(peer, `unsupported resume kind "${peer.resume.kind}" — starting fresh`);
		return undefined;
	}
	if (!refUsable(peer.resume)) {
		onSkip?.(peer, `session file gone (${peer.resume.value}) — starting fresh`);
		return undefined;
	}
	return peer.resume.value;
}

export function parseSnapshot(raw: string): TeamSnapshot {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		throw new Error(`Snapshot is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
	}
	const s = parsed as TeamSnapshot;
	if (!s || s.version !== 1 || typeof s.team !== "string" || !Array.isArray(s.peers)) {
		throw new Error("Snapshot has an unexpected shape (want {version:1, team, peers[]}).");
	}
	validateTeamName(s.team);
	if (!("project" in (s as Record<string, unknown>))) {
		(s as { project: string }).project = DEFAULT_PROJECT;
	} else if (typeof (s as { project?: unknown }).project !== "string") {
		throw new Error("Snapshot has an unexpected shape (project must be a string when present).");
	}
	validateProject(s.project);
	return s;
}

export function assertSnapshotProject(snap: TeamSnapshot, requestedProject: string): void {
	validateProject(requestedProject);
	if (snap.project !== requestedProject) {
		throw new Error(
			`Snapshot project mismatch: snapshot is ${JSON.stringify(snap.project)}, requested ${JSON.stringify(requestedProject)}.`,
		);
	}
}
