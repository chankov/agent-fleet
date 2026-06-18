// scripts/team-up.ts
//
// Spawn a team of reusable coms peers (from .pi/agents/peers.yaml) into a tmux
// session — one tiled pane per peer, each running the hidden `just _peer …` helper.
// Backs the `just team-up <name>` recipe (see the justfile).
//
// Hard rules:
// - Entrypoint guard: launching lives inside main(); importing the module must
//   NOT spawn anything.
// - peers.yaml + the repo root are resolved relative to THIS file, so the script
//   works regardless of the caller's cwd.
// - Manifest values are validated against a safe charset before being placed on
//   a shell command line (the file is user-edited) — reject anything else.
// - --dry-run prints the resolved per-peer commands and exits without tmux, so
//   the parser + command construction are testable without launching pi.
// - Never clobber an existing tmux session of the same name; refuse and explain.

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const PEERS_YAML = path.join(REPO_ROOT, ".pi", "agents", "peers.yaml");

// Safe charset for any value spliced into a shell command line.
const SAFE = /^[A-Za-z0-9._/,-]+$/;

interface Peer {
	name?: string;
	persona?: string;
	model?: string;
	// Optional comma-separated extension names under .pi/extensions/ to load into
	// this peer (routes it through `just _peer-plus` instead of `just _peer`).
	extensions?: string;
}

function stripQuotes(v: string): string {
	if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
		return v.slice(1, -1);
	}
	return v;
}

// Minimal parser for the specific peers.yaml shape (team → list of {name,persona,model}).
// Not a general YAML parser; tolerant of comments and blank lines only.
function parsePeersYaml(raw: string): Record<string, Peer[]> {
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

function flagValue(argv: string[], flag: string): string | null {
	const i = argv.indexOf(flag);
	return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

function tmuxOk(args: string[]): boolean {
	const r = spawnSync("tmux", args, { stdio: "ignore" });
	return !r.error && r.status === 0;
}

function runTmux(args: string[]): void {
	const r = spawnSync("tmux", args, { stdio: "inherit" });
	if (r.error || r.status !== 0) {
		console.error(`tmux ${args.join(" ")} failed (status ${r.status ?? "n/a"})`);
		process.exit(1);
	}
}

function main(): void {
	const argv = process.argv.slice(2);
	const team = flagValue(argv, "--team");
	const dryRun = argv.includes("--dry-run");

	if (!team) {
		console.error("usage: team-up.ts --team <name> [--dry-run]");
		process.exit(2);
	}
	if (!fs.existsSync(PEERS_YAML)) {
		console.error(`peers.yaml not found at ${PEERS_YAML}`);
		process.exit(1);
	}

	const teams = parsePeersYaml(fs.readFileSync(PEERS_YAML, "utf-8"));
	const peers = teams[team];
	if (!peers) {
		const names = Object.keys(teams).join(", ") || "(none)";
		console.error(`Unknown team "${team}". Available teams: ${names}`);
		process.exit(1);
	}
	if (peers.length === 0) {
		console.error(`Team "${team}" has no peers.`);
		process.exit(1);
	}

	// Build + validate one `just _peer …` command per peer. `just` recipe params are
	// POSITIONAL (persona name model) — emit them as bare positional args, never
	// key=value (which just would treat as a literal positional value).
	const cmds: { label: string; cmd: string }[] = [];
	for (const p of peers) {
		if (!p.persona) {
			console.error(`Peer "${p.name ?? "(unnamed)"}" in team "${team}" is missing a persona.`);
			process.exit(1);
		}
		if (!p.name) {
			console.error(`Peer with persona "${p.persona}" in team "${team}" is missing a name.`);
			process.exit(1);
		}
		for (const [k, v] of Object.entries(p)) {
			if (v !== undefined && !SAFE.test(v)) {
				console.error(`Unsafe value for ${k} in team "${team}": ${JSON.stringify(v)} (allowed: ${SAFE})`);
				process.exit(1);
			}
		}
		// A peer that needs extra extensions (e.g. chrome-devtools-mcp) routes through
		// `_peer-plus <extensions> <persona> <name> [<model>]`; otherwise plain `_peer`.
		const parts = p.extensions
			? ["just", "_peer-plus", p.extensions, p.persona, p.name]
			: ["just", "_peer", p.persona, p.name];
		if (p.model) parts.push(p.model);
		cmds.push({ label: p.name, cmd: parts.join(" ") });
	}

	const session = `pi-peers-${team}`;

	if (dryRun) {
		console.log(`# team-up (dry run) — team "${team}", ${cmds.length} peer(s), tmux session "${session}"`);
		for (const c of cmds) console.log(`${c.label}\t${c.cmd}`);
		return;
	}

	if (!tmuxOk(["-V"])) {
		console.error("tmux not found on PATH — install tmux, or run with dry=1 to print the commands.");
		process.exit(1);
	}
	if (tmuxOk(["has-session", "-t", session])) {
		console.error(`tmux session "${session}" already exists.`);
		console.error(`  attach: tmux attach -t ${session}`);
		console.error(`  kill:   tmux kill-session -t ${session}`);
		process.exit(1);
	}

	runTmux(["new-session", "-d", "-s", session, "-n", team, "-c", REPO_ROOT, cmds[0].cmd]);
	for (let i = 1; i < cmds.length; i++) {
		runTmux(["split-window", "-t", session, "-c", REPO_ROOT, cmds[i].cmd]);
		runTmux(["select-layout", "-t", session, "tiled"]);
	}

	console.log(`Launched ${cmds.length} peer(s) for team "${team}" in tmux session "${session}":`);
	for (const c of cmds) console.log(`  • ${c.label}`);
	console.log(`Attach: tmux attach -t ${session}`);
	console.log(`Kill:   tmux kill-session -t ${session}`);
}

const isEntry = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) main();
