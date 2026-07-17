// scripts/lib/herdr-layout.ts
//
// Pure logic for the herdr fleet recipes: peers.yaml parsing, peer→command
// construction, and peers.yaml team → herdr declarative layout tree (BSP
// splits, one pane per peer). No pi imports, no sockets, no process.exit —
// everything throws plain Errors so callers decide how to die. Testable
// under node --test; the wiring (requireHerdr, workspace.create,
// layout.apply) lives in scripts/team-up.ts.

import { resolve as resolvePath } from "node:path";

import type { LayoutNode } from "../../.pi/harnesses/lib/herdr-client.ts";
import { STAGGER_ENV_VAR } from "./spawn-stagger.ts";
import { DEFAULT_PROJECT, validateProject } from "./team-project.ts";

export type { LayoutNode };

// Safe charset for any value spliced into a command line or layout — the
// peers.yaml file is user-edited, so every manifest value is validated.
export const SAFE = /^[A-Za-z0-9._/,-]+$/;

export interface Peer {
	name?: string;
	persona?: string;
	model?: string;
	// Optional comma-separated extension names under .pi/extensions/ to load into
	// this peer (routes it through `just _peer-plus` instead of `just _peer`).
	extensions?: string;
	// Optional repo-relative KEY=VALUE file injected as the pane's env at spawn
	// (herdr injects it before the command runs — no shell `source`).
	env_file?: string;
	// Optional runner. Default (absent) is a pi peer via `_peer`/`_peer-plus`;
	// "claude-code" spawns an interactive Claude Code plus its coms bridge in
	// the pane via `_claude-peer` (model → `claude --model`).
	runner?: string;
}

function stripQuotes(v: string): string {
	if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
		return v.slice(1, -1);
	}
	return v;
}

// Minimal parser for the specific peers.yaml shape (team → list of {name,persona,model}).
// Not a general YAML parser; tolerant of comments and blank lines only.
export function parsePeersYaml(raw: string): Record<string, Peer[]> {
	const teams: Record<string, Peer[]> = {};
	let currentTeam: string | null = null;
	let currentPeer: Peer | null = null;

	for (const rawLine of raw.split("\n")) {
		const line = rawLine.replace(/\s+$/, "");
		if (line.trim() === "" || /^\s*#/.test(line)) continue;
		const indent = line.length - line.trimStart().length;
		const content = line.trim();

		if (indent === 0) {
			const m = content.match(/^([A-Za-z0-9_-]+):\s*$/);
			if (m) {
				currentTeam = m[1];
				teams[currentTeam] = [];
				currentPeer = null;
			}
			continue;
		}
		if (!currentTeam) continue;

		const itemM = content.match(/^-\s*([A-Za-z0-9_]+):\s*(.+)$/);
		if (itemM) {
			currentPeer = {};
			teams[currentTeam].push(currentPeer);
			(currentPeer as Record<string, string>)[itemM[1]] = stripQuotes(itemM[2]);
			continue;
		}
		const fieldM = content.match(/^([A-Za-z0-9_]+):\s*(.+)$/);
		if (fieldM && currentPeer) {
			(currentPeer as Record<string, string>)[fieldM[1]] = stripQuotes(fieldM[2]);
		}
	}
	return teams;
}

// Validate a peer's fields and build its launch argv. `just` recipe params are
// POSITIONAL (persona name model session) — bare positional args, never
// key=value. A peer with `extensions:` routes through `_peer-plus
// <extensions> <persona> <name> [<model>] [<session>]`; otherwise plain
// `_peer <persona> <name> [<model>] [<session>]`. `resumeRef` (a pi session
// path for `pi --session`) fills the trailing session positional — when the
// peer has no model, an empty-string placeholder keeps the positions aligned.
export function peerCommand(p: Peer, team: string, resumeRef?: string, project = DEFAULT_PROJECT): string[] {
	validateProject(project);
	if (p.runner !== undefined && p.runner !== "claude-code") {
		throw new Error(`Unknown runner "${p.runner}" for peer "${p.name}" in team "${team}" (supported: claude-code).`);
	}
	if (!p.persona && p.runner !== "claude-code") {
		throw new Error(`Peer "${p.name ?? "(unnamed)"}" in team "${team}" is missing a persona.`);
	}
	if (!p.name) {
		throw new Error(`Peer with persona "${p.persona}" in team "${team}" is missing a name.`);
	}
	for (const [k, v] of Object.entries(p)) {
		// Only string fields can reach a command line; extra non-string fields
		// (e.g. a snapshot's `resume` object) are never spliced into argv.
		if (typeof v === "string" && !SAFE.test(v)) {
			throw new Error(`Unsafe value for ${k} in team "${team}": ${JSON.stringify(v)} (allowed: ${SAFE})`);
		}
	}
	if (resumeRef !== undefined && !SAFE.test(resumeRef)) {
		throw new Error(`Unsafe resume ref for ${p.name}: ${JSON.stringify(resumeRef)} (allowed: ${SAFE})`);
	}
	if (p.runner === "claude-code" && p.extensions) {
		throw new Error(`Peer "${p.name}": extensions: are pi-only and cannot combine with runner: claude-code.`);
	}
	const parts =
		p.runner === "claude-code"
			? ["just", "_claude-peer", p.name]
			: p.extensions
				? ["just", "_peer-plus", p.extensions, p.persona, p.name]
				: ["just", "_peer", p.persona, p.name];
	if (p.model) parts.push(p.model);
	if (resumeRef !== undefined) {
		if (!p.model) parts.push(""); // keep the model positional aligned
		parts.push(resumeRef);
	}
	if (project !== DEFAULT_PROJECT) {
		if (!p.model && resumeRef === undefined) parts.push("");
		if (resumeRef === undefined) parts.push("");
		parts.push(project);
	}
	return parts;
}

// Parse a KEY=VALUE env file (B3): no shell evaluation, no expansion.
// Blank lines and #-comments are skipped; values may be single- or
// double-quoted (quotes stripped, contents taken literally).
export function parseEnvFile(raw: string, sourceName = "env file"): Record<string, string> {
	const env: Record<string, string> = {};
	const lines = raw.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		if (line === "" || line.startsWith("#")) continue;
		const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
		if (!m) {
			throw new Error(`${sourceName}:${i + 1}: not a KEY=VALUE line: ${JSON.stringify(line)}`);
		}
		env[m[1]] = stripQuotes(m[2].trim());
	}
	return env;
}

// Resolve a peer's env_file to an absolute path inside the repo. The SAFE
// charset (enforced on every peer field) already excludes shell metacharacters;
// this adds the traversal guard: repo-relative, no escaping the repo root.
export function resolveEnvFilePath(envFile: string, repoRoot: string): string {
	if (!SAFE.test(envFile)) {
		throw new Error(`Unsafe env_file path: ${JSON.stringify(envFile)} (allowed: ${SAFE})`);
	}
	if (envFile.startsWith("/")) {
		throw new Error(`env_file must be repo-relative, got absolute path: ${envFile}`);
	}
	const abs = resolvePath(repoRoot, envFile);
	if (abs !== repoRoot && !abs.startsWith(repoRoot + "/")) {
		throw new Error(`env_file escapes the repo root: ${envFile}`);
	}
	return abs;
}

export interface TeamLayoutOptions {
	team: string;
	peers: Peer[];
	repoRoot: string;
	// B3 hook: resolve a peer's extra env (e.g. from its env_file). Returning
	// undefined means no extra env for that peer.
	envForPeer?: (peer: Peer) => Record<string, string> | undefined;
	// B5 hook: resume ref (pi session path) for a peer being restored from a
	// team snapshot. Returning undefined starts the peer fresh.
	resumeForPeer?: (peer: Peer) => string | undefined;
	// Pre-warm/stagger hook (see spawn-stagger.ts): seconds this pane should
	// sleep before launching pi, injected as AGENT_FLEET_SPAWN_DELAY in the
	// pane env. undefined or 0 launches immediately.
	delayForPeer?: (peer: Peer) => number | undefined;
	// B2 hook: when set, the hub occupies a larger root pane (ratio of the
	// horizontal split) and the team tiles in the remaining space.
	// Coms project scope shared by all panes in this layout. The default keeps
	// existing argv shapes; non-default projects are appended to hidden recipe
	// positional args after model/session.
	project?: string;
	hub?: { command: string[]; label: string; ratio?: number };
}

function paneNode(
	peer: Peer,
	team: string,
	repoRoot: string,
	envForPeer?: TeamLayoutOptions["envForPeer"],
	resumeForPeer?: TeamLayoutOptions["resumeForPeer"],
	project = DEFAULT_PROJECT,
	delayForPeer?: TeamLayoutOptions["delayForPeer"],
): LayoutNode {
	validateProject(project);
	const env = { ...envForPeer?.(peer) };
	const delay = delayForPeer?.(peer);
	if (delay !== undefined) {
		if (!Number.isFinite(delay) || delay < 0) {
			throw new Error(`Invalid spawn delay for peer "${peer.name}": ${delay}`);
		}
		if (delay > 0) env[STAGGER_ENV_VAR] = String(Math.round(delay));
	}
	return {
		type: "pane",
		command: peerCommand(peer, team, resumeForPeer?.(peer), project),
		cwd: repoRoot,
		label: peer.name as string,
		...(Object.keys(env).length > 0 ? { env } : {}),
	};
}

// Balanced BSP over a list of panes: split the list in half, alternating
// split direction by depth — the herdr equivalent of tmux's tiled layout.
function bsp(nodes: LayoutNode[], depth: number): LayoutNode {
	if (nodes.length === 1) return nodes[0];
	const mid = Math.ceil(nodes.length / 2);
	return {
		type: "split",
		direction: depth % 2 === 0 ? "right" : "down",
		ratio: mid / nodes.length,
		first: bsp(nodes.slice(0, mid), depth + 1),
		second: bsp(nodes.slice(mid), depth + 1),
	};
}

// peers.yaml team → herdr layout tree for layout.apply.
export function buildTeamLayout(opts: TeamLayoutOptions): LayoutNode {
	const { team, peers, repoRoot, envForPeer, resumeForPeer, delayForPeer, hub, project = DEFAULT_PROJECT } = opts;
	validateProject(project);
	if (peers.length === 0) throw new Error(`Team "${team}" has no peers.`);
	const panes = peers.map((p) => paneNode(p, team, repoRoot, envForPeer, resumeForPeer, project, delayForPeer));
	const grid = bsp(panes, hub ? 1 : 0);
	if (!hub) return grid;
	return {
		type: "split",
		direction: "right",
		ratio: hub.ratio ?? 0.4,
		first: { type: "pane", command: hub.command, cwd: repoRoot, label: hub.label },
		second: grid,
	};
}
