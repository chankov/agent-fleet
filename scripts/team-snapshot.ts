// scripts/team-snapshot.ts
//
// Fleet resume (B5): snapshot / tear down / rebuild a running peer team.
// Backs the `just team-snapshot`, `just team-down`, `just team-resume`
// recipes. herdr is a hard dependency (requireHerdr refuses readably).
//
//   snapshot <team>  — capture peers + per-peer session refs to
//                      ~/.pi/team-snapshots/<team>.json (team keeps running)
//   down <team>      — snapshot, then workspace.close (peers get SIGTERM →
//                      coms clean shutdown removes their registry entries)
//   resume <team>    — rebuild the workspace from the snapshot; every pi peer
//                      relaunches with `--session <ref>` and continues its
//                      conversation; peers whose ref is gone start fresh with
//                      a warning
//
// Snapshots live OUTSIDE the repo (~/.pi/team-snapshots/) because
// .pi/agent-sessions/ is wiped at hub session start. Pure logic in
// scripts/lib/team-snapshot.ts; entrypoint-guarded like team-up.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { buildTeamLayout, parsePeersYaml, type Peer } from "./lib/herdr-layout.ts";
import {
	buildSnapshot,
	parseSnapshot,
	resumeRefForPeer,
	type PeerSnapshot,
	type TeamSnapshot,
} from "./lib/team-snapshot.ts";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const PEERS_YAML = path.join(REPO_ROOT, ".pi", "agents", "peers.yaml");
const SNAPSHOT_DIR = path.join(os.homedir(), ".pi", "team-snapshots");

function die(msg: string): never {
	console.error(msg);
	process.exit(1);
}

function snapshotPath(team: string): string {
	if (!/^[A-Za-z0-9_-]+$/.test(team)) die(`Invalid team name: ${JSON.stringify(team)}`);
	return path.join(SNAPSHOT_DIR, `${team}.json`);
}

async function requireClient() {
	const client = await import("../.pi/harnesses/lib/herdr-client.ts");
	try {
		await client.requireHerdr();
	} catch (err) {
		if (err instanceof client.HerdrUnavailableError) die(err.message);
		throw err;
	}
	return client;
}

type Client = Awaited<ReturnType<typeof requireClient>>;

async function findTeamWorkspace(client: Client, team: string) {
	const { workspaces } = await client.herdr.workspaceList();
	return (
		workspaces.find((w) => w.label === `pi-peers-${team}`) ??
		workspaces.find((w) => w.label === `pi-hub-${team}`) ??
		null
	);
}

async function captureSnapshot(client: Client, team: string): Promise<TeamSnapshot> {
	const ws = await findTeamWorkspace(client, team);
	if (!ws) {
		die(
			`No running workspace "pi-peers-${team}" or "pi-hub-${team}" found.\n` +
				`Start one with: just team-up ${team}   (or just hub-team ${team})`,
		);
	}
	if (!fs.existsSync(PEERS_YAML)) die(`peers.yaml not found at ${PEERS_YAML}`);
	const teams = parsePeersYaml(fs.readFileSync(PEERS_YAML, "utf-8"));
	const peers = teams[team];
	if (!peers || peers.length === 0) die(`Team "${team}" not found in peers.yaml.`);

	const { panes } = await client.herdr.paneList({ workspace_id: ws.workspace_id });
	const { agents } = await client.herdr.agentList();
	const inWorkspace = agents.filter((a) => (a as { workspace_id?: string }).workspace_id === ws.workspace_id);

	const snap = buildSnapshot({
		team,
		hub: ws.label === `pi-hub-${team}`,
		peers,
		panes,
		agents: inWorkspace as Parameters<typeof buildSnapshot>[0]["agents"],
	});
	fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
	fs.writeFileSync(snapshotPath(team), JSON.stringify(snap, null, 2) + "\n");
	const withRef = snap.peers.filter((p) => p.resume).length;
	console.log(
		`Snapshot: ${snapshotPath(team)} — ${snap.peers.length} peer(s), ${withRef} with a session ref.`,
	);
	return snap;
}

async function cmdSnapshot(team: string): Promise<void> {
	const client = await requireClient();
	await captureSnapshot(client, team);
}

async function cmdDown(team: string): Promise<void> {
	const client = await requireClient();
	await captureSnapshot(client, team);
	const ws = await findTeamWorkspace(client, team);
	if (ws) {
		await client.herdr.workspaceClose(ws.workspace_id);
		console.log(`Closed workspace ${ws.workspace_id} ("${ws.label}"). Resume with: just team-resume ${team}`);
	}
}

async function cmdResume(team: string): Promise<void> {
	const file = snapshotPath(team);
	if (!fs.existsSync(file)) {
		die(`No snapshot at ${file}.\nTake one while the team runs: just team-snapshot ${team} (or just team-down ${team}).`);
	}
	const snap = parseSnapshot(fs.readFileSync(file, "utf-8"));

	const client = await requireClient();
	const existing = await findTeamWorkspace(client, team);
	if (existing) {
		die(
			`Workspace "${existing.label}" (${existing.workspace_id}) is already running.\n` +
				`  focus: herdr workspace focus ${existing.workspace_id}\n` +
				`  close: herdr workspace close ${existing.workspace_id}`,
		);
	}

	const resumedNames = new Set<string>();
	const resumeFor = (peer: Peer): string | undefined => {
		const ref = resumeRefForPeer(
			peer as PeerSnapshot,
			// path refs must still exist on disk; id refs (claude-code) cannot
			// be pre-checked and are handed to `claude --resume` as-is
			(r) => (r.kind === "id" ? true : fs.existsSync(r.value)),
			(p, reason) => console.warn(`  ⚠ ${p.name}: ${reason}`),
		);
		if (ref && peer.name) resumedNames.add(peer.name);
		return ref;
	};
	const layout = buildTeamLayout({
		team: snap.team,
		peers: snap.peers,
		repoRoot: REPO_ROOT,
		resumeForPeer: resumeFor,
		...(snap.hub ? { hub: { command: ["just", "hub"], label: "hub", ratio: 0.4 } } : {}),
	});

	const created = await client.herdr.workspaceCreate({
		label: snap.workspace_label,
		cwd: REPO_ROOT,
		focus: false,
	});
	const wsId = created.workspace.workspace_id;
	const initialTab = created.workspace.active_tab_id ?? created.tab?.tab_id;
	await client.herdr.layoutApply({ workspace_id: wsId, root: layout });
	if (initialTab) {
		try {
			await client.herdr.tabClose(initialTab);
		} catch {
			// cosmetic
		}
	}
	console.log(`Resumed team "${snap.team}" in workspace "${snap.workspace_label}" (${wsId}):`);
	for (const p of snap.peers) {
		console.log(`  • ${p.name}${p.name && resumedNames.has(p.name) ? " (session resumed)" : " (fresh)"}`);
	}
	console.log(`Focus: herdr workspace focus ${wsId}`);
}

async function main(): Promise<void> {
	const [cmd, team] = process.argv.slice(2);
	if (!cmd || !team) {
		console.error("usage: team-snapshot.ts <snapshot|down|resume> <team>");
		process.exit(2);
	}
	if (cmd === "snapshot") return cmdSnapshot(team);
	if (cmd === "down") return cmdDown(team);
	if (cmd === "resume") return cmdResume(team);
	die(`Unknown command "${cmd}" (want snapshot | down | resume).`);
}

const isEntry = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) void main();
