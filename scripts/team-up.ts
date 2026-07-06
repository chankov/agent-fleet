// scripts/team-up.ts
//
// Spawn a team of reusable coms peers (from .pi/agents/peers.yaml) into a
// herdr workspace — one pane per peer in a tiled BSP layout, each running the
// hidden `just _peer …` helper. Backs the `just team-up <name>` recipe (see
// the justfile). herdr is a hard dependency for fleet spawning: without a
// running server the recipe refuses with an actionable message.
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
//   without launching pi.
// - Never clobber an existing workspace of the same label; refuse and explain.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
	buildTeamLayout,
	parsePeersYaml,
	type LayoutNode,
	type Peer,
} from "./lib/herdr-layout.ts";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const PEERS_YAML = path.join(REPO_ROOT, ".pi", "agents", "peers.yaml");

function flagValue(argv: string[], flag: string): string | null {
	const i = argv.indexOf(flag);
	return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

function loadTeam(team: string): Peer[] {
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
	return peers;
}

function buildLayoutOrDie(team: string, peers: Peer[]): LayoutNode {
	try {
		return buildTeamLayout({ team, peers, repoRoot: REPO_ROOT });
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	}
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const team = flagValue(argv, "--team");
	const dryRun = argv.includes("--dry-run");

	if (!team) {
		console.error("usage: team-up.ts --team <name> [--dry-run]");
		process.exit(2);
	}

	const peers = loadTeam(team);
	const layout = buildLayoutOrDie(team, peers);
	const label = `pi-peers-${team}`;

	if (dryRun) {
		// No herdr calls on this path — must work with no herdr installed.
		console.log(`# team-up (dry run) — team "${team}", ${peers.length} peer(s), herdr workspace "${label}"`);
		for (const p of peers) console.log(`${p.name}\t${(layoutCommands(layout, p.name as string) ?? []).join(" ")}`);
		console.log(JSON.stringify({ label, layout }, null, 2));
		return;
	}

	// Import lazily so --dry-run never touches the client (or the socket).
	const { herdr, requireHerdr, HerdrUnavailableError } = await import(
		"../.pi/harnesses/lib/herdr-client.ts"
	);

	try {
		await requireHerdr();
	} catch (err) {
		if (err instanceof HerdrUnavailableError) {
			console.error(err.message);
			console.error("(dry run still works: just team-up-dry " + team + ")");
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

	console.log(`Launched ${peers.length} peer(s) for team "${team}" in herdr workspace "${label}" (${wsId}):`);
	for (const p of peers) console.log(`  • ${p.name}`);
	console.log(`Focus: herdr workspace focus ${wsId}`);
	console.log(`Close: herdr workspace close ${wsId}`);
}

async function request_ignoring_errors<T>(f: () => Promise<T>): Promise<T | null> {
	try {
		return await f();
	} catch {
		return null;
	}
}

// Dry-run helper: find the command argv for the pane labeled `name`.
function layoutCommands(node: LayoutNode, name: string): string[] | undefined {
	if (node.type === "pane") return node.label === name ? node.command : undefined;
	return layoutCommands(node.first, name) ?? layoutCommands(node.second, name);
}

const isEntry = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) void main();
