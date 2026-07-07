// scripts/team-up.ts
//
// Spawn a team of reusable coms peers (from .pi/agents/peers.yaml) into a
// herdr workspace — one pane per peer in a tiled BSP layout, each running the
// hidden `just _peer …` helper. Backs the `just team-up <name>` and
// `just hub-team <name>` recipes (see the justfile). herdr is a hard
// dependency for fleet spawning: without a running server the recipes refuse
// with an actionable message.
//
// Hard rules:
// - Entrypoint guard: launching lives inside main(); importing the module must
//   NOT spawn anything.
// - peers.yaml + the repo root are resolved relative to THIS file, so the script
//   works regardless of the caller's cwd.
// - Manifest values are validated against a safe charset before being placed in
//   a pane command (the file is user-edited) — reject anything else. The pure
//   parsing/validation/layout logic lives in scripts/lib/herdr-layout.ts.
// - --dry-run prints the resolved layout JSON and exits WITHOUT touching herdr
//   (must work with no herdr installed), so command construction is testable
//   without launching pi. env_file VALUES never appear in dry-run output —
//   only the path (secrets stay out of terminals and logs).
// - Never clobber an existing workspace of the same label; refuse and explain.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
	buildTeamLayout,
	parseEnvFile,
	parsePeersYaml,
	resolveEnvFilePath,
	type LayoutNode,
	type Peer,
} from "./lib/herdr-layout.ts";
import { DEFAULT_PROJECT, hubCommand, parseProjectFlag, teamWorkspaceLabel, validateTeamName } from "./lib/team-project.ts";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_PEERS_YAML = path.join(REPO_ROOT, ".pi", "agents", "peers.yaml");

// The guarded hub occupies this share of the workspace in --hub mode; the
// team tiles in the rest.
const HUB_RATIO = 0.4;

function flagValue(argv: string[], flag: string): string | null {
	const i = argv.indexOf(flag);
	if (i < 0) return null;
	const value = argv[i + 1];
	if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
	return value;
}

function die(msg: string): never {
	console.error(msg);
	process.exit(1);
}

function loadTeam(team: string, peersYaml: string): Peer[] {
	if (!fs.existsSync(peersYaml)) die(`peers.yaml not found at ${peersYaml}`);
	const teams = parsePeersYaml(fs.readFileSync(peersYaml, "utf-8"));
	const peers = teams[team];
	if (!peers) {
		const names = Object.keys(teams).join(", ") || "(none)";
		die(`Unknown team "${team}". Available teams: ${names}`);
	}
	if (peers.length === 0) die(`Team "${team}" has no peers.`);
	return peers;
}

// B3: resolve + validate every peer's env_file BEFORE any spawning, so a bad
// manifest refuses up front, never mid-boot. Returns a loader for the layout
// builder; when `redact` is set (dry-run) values are never read at all.
function makeEnvLoader(
	peers: Peer[],
	redact: boolean,
): (peer: Peer) => Record<string, string> | undefined {
	const resolved = new Map<Peer, string>();
	for (const p of peers) {
		if (!p.env_file) continue;
		let abs: string;
		try {
			abs = resolveEnvFilePath(p.env_file, REPO_ROOT);
		} catch (err) {
			die(err instanceof Error ? err.message : String(err));
		}
		if (!redact && !fs.existsSync(abs)) {
			die(`Peer "${p.name}": env_file not found: ${p.env_file} (resolved: ${abs})`);
		}
		resolved.set(p, abs);
	}
	return (peer) => {
		const abs = resolved.get(peer);
		if (!abs || redact) return undefined;
		try {
			return parseEnvFile(fs.readFileSync(abs, "utf-8"), peer.env_file);
		} catch (err) {
			die(err instanceof Error ? err.message : String(err));
		}
	};
}

function buildLayoutOrDie(
	team: string,
	peers: Peer[],
	envForPeer: (p: Peer) => Record<string, string> | undefined,
	hub: boolean,
	project: string,
): LayoutNode {
	try {
		return buildTeamLayout({
			team,
			peers,
			repoRoot: REPO_ROOT,
			envForPeer,
			project,
			...(hub ? { hub: { command: hubCommand(project), label: "hub", ratio: HUB_RATIO } } : {}),
		});
	} catch (err) {
		die(err instanceof Error ? err.message : String(err));
	}
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	let team: string | null = null;
	let peersYaml = DEFAULT_PEERS_YAML;
	let project = DEFAULT_PROJECT;
	try {
		team = flagValue(argv, "--team");
		project = parseProjectFlag(argv);
		// --peers: alternate manifest path (tests use it; defaults to the repo's).
		peersYaml = flagValue(argv, "--peers") ?? DEFAULT_PEERS_YAML;
	} catch (err) {
		die(err instanceof Error ? err.message : String(err));
	}
	const dryRun = argv.includes("--dry-run");
	const hub = argv.includes("--hub");

	if (!team) {
		console.error("usage: team-up.ts --team <name> [--hub] [--dry-run] [--peers <peers.yaml>] [--project <name>]");
		process.exit(2);
	}

	try {
		validateTeamName(team);
	} catch (err) {
		die(err instanceof Error ? err.message : String(err));
	}
	const peers = loadTeam(team, peersYaml);
	let label: string;
	try {
		label = teamWorkspaceLabel(hub ? "hub" : "peers", team, project);
	} catch (err) {
		die(err instanceof Error ? err.message : String(err));
	}

	if (dryRun) {
		// No herdr calls and no env_file reads on this path — must work with no
		// herdr installed, and secrets never reach the output.
		const layout = buildLayoutOrDie(team, peers, makeEnvLoader(peers, true), hub, project);
		const projectNote = project === DEFAULT_PROJECT ? "" : `, project "${project}"`;
		console.log(
			`# team-up (dry run) — team "${team}"${projectNote}, ${peers.length} peer(s)${hub ? " + hub" : ""}, herdr workspace "${label}"`,
		);
		for (const p of peers) {
			const cmd = layoutCommands(layout, p.name as string) ?? [];
			const envNote = p.env_file ? `  [env_file: ${p.env_file} — values redacted]` : "";
			console.log(`${p.name}\t${cmd.join(" ")}${envNote}`);
		}
		console.log(JSON.stringify({ label, layout }, null, 2));
		return;
	}

	const layout = buildLayoutOrDie(team, peers, makeEnvLoader(peers, false), hub, project);

	// Import lazily so --dry-run never touches the client (or the socket).
	const { herdr, requireHerdr, HerdrUnavailableError } = await import(
		"../.pi/harnesses/lib/herdr-client.ts"
	);

	try {
		await requireHerdr();
	} catch (err) {
		if (err instanceof HerdrUnavailableError) {
			console.error(err.message);
			const dryRecipe = hub ? "hub-team-dry" : "team-up-dry";
			console.error(`(dry run still works: just ${dryRecipe} ${team}${project === DEFAULT_PROJECT ? "" : ` --project ${project}`})`);
			process.exit(1);
		}
		throw err;
	}

	const { workspaces } = await herdr.workspaceList();
	const existing = workspaces.find((w) => w.label === label);
	if (existing) {
		console.error(`herdr workspace "${label}" already exists (${existing.workspace_id}).`);
		console.error(`  focus: herdr workspace focus ${existing.workspace_id}`);
		console.error(`  close: herdr workspace close ${existing.workspace_id}`);
		process.exit(1);
	}

	const created = await herdr.workspaceCreate({ label, cwd: REPO_ROOT, focus: false });
	const wsId = created.workspace.workspace_id;
	const initialTab = created.workspace.active_tab_id ?? created.tab?.tab_id;
	await herdr.layoutApply({ workspace_id: wsId, root: layout });
	// layout.apply lands in a fresh tab; drop the empty shell tab
	// workspace.create made so the team tab is the only one.
	if (initialTab) {
		try {
			await herdr.tabClose(initialTab);
		} catch {
			// non-fatal: an extra empty tab is cosmetic
		}
	}

	console.log(
		`Launched ${hub ? "hub + " : ""}${peers.length} peer(s) for team "${team}" in herdr workspace "${label}" (${wsId}):`,
	);
	if (hub) console.log(`  • hub (${hubCommand(project).join(" ")} — guarded dispatcher)`);
	for (const p of peers) console.log(`  • ${p.name}`);
	console.log(`Focus: herdr workspace focus ${wsId}`);
	console.log(`Close: herdr workspace close ${wsId}`);
}

// Dry-run helper: find the command argv for the pane labeled `name`.
function layoutCommands(node: LayoutNode, name: string): string[] | undefined {
	if (node.type === "pane") return node.label === name ? node.command : undefined;
	return layoutCommands(node.first, name) ?? layoutCommands(node.second, name);
}

const isEntry = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) void main();
