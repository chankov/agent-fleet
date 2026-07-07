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
import { DEFAULT_PROJECT, hubCommand, parseProjectFlag, teamSnapshotPath, teamWorkspaceLabel, validateTeamName } from "./lib/team-project.ts";
import {
	assertSnapshotProject,
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

function snapshotPath(team: string, project = DEFAULT_PROJECT): string {
	try {
		return teamSnapshotPath(SNAPSHOT_DIR, team, project);
	} catch (err) {
		die(err instanceof Error ? err.message : String(err));
	}
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

async function findTeamWorkspace(client: Client, team: string, project = DEFAULT_PROJECT) {
	let peersLabel: string;
	let hubLabel: string;
	try {
		peersLabel = teamWorkspaceLabel("peers", team, project);
		hubLabel = teamWorkspaceLabel("hub", team, project);
	} catch (err) {
		die(err instanceof Error ? err.message : String(err));
	}
	const { workspaces } = await client.herdr.workspaceList();
	return workspaces.find((w) => w.label === peersLabel) ?? workspaces.find((w) => w.label === hubLabel) ?? null;
}

async function captureSnapshot(client: Client, team: string, project = DEFAULT_PROJECT): Promise<TeamSnapshot> {
	const peersLabel = teamWorkspaceLabel("peers", team, project);
	const hubLabel = teamWorkspaceLabel("hub", team, project);
	const ws = await findTeamWorkspace(client, team, project);
	if (!ws) {
		const projectArgs = project === DEFAULT_PROJECT ? "" : ` --project ${project}`;
		die(
			`No running workspace "${peersLabel}" or "${hubLabel}" found.\n` +
				`Start one with: just team-up ${team}${projectArgs}   (or just hub-team ${team}${projectArgs})`,
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
		project,
		hub: ws.label === hubLabel,
		peers,
		panes,
		agents: inWorkspace as Parameters<typeof buildSnapshot>[0]["agents"],
	});
	const file = snapshotPath(team, project);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(snap, null, 2) + "\n");
	const withRef = snap.peers.filter((p) => p.resume).length;
	console.log(`Snapshot: ${file} — ${snap.peers.length} peer(s), ${withRef} with a session ref.`);
	return snap;
}

async function cmdSnapshot(team: string, project = DEFAULT_PROJECT): Promise<void> {
	const client = await requireClient();
	await captureSnapshot(client, team, project);
}

async function cmdDown(team: string, project = DEFAULT_PROJECT): Promise<void> {
	const client = await requireClient();
	await captureSnapshot(client, team, project);
	const ws = await findTeamWorkspace(client, team, project);
	if (ws) {
		await client.herdr.workspaceClose(ws.workspace_id);
		const projectArgs = project === DEFAULT_PROJECT ? "" : ` --project ${project}`;
		console.log(`Closed workspace ${ws.workspace_id} ("${ws.label}"). Resume with: just team-resume ${team}${projectArgs}`);
	}
}

async function cmdResume(team: string, project = DEFAULT_PROJECT): Promise<void> {
	const file = snapshotPath(team, project);
	if (!fs.existsSync(file)) {
		const projectArgs = project === DEFAULT_PROJECT ? "" : ` --project ${project}`;
		die(`No snapshot at ${file}.\nTake one while the team runs: just team-snapshot ${team}${projectArgs} (or just team-down ${team}${projectArgs}).`);
	}
	const snap = parseSnapshot(fs.readFileSync(file, "utf-8"));
	try {
		assertSnapshotProject(snap, project);
		if (snap.team !== team) throw new Error(`Snapshot team mismatch: snapshot is ${JSON.stringify(snap.team)}, requested ${JSON.stringify(team)}.`);
	} catch (err) {
		die(err instanceof Error ? err.message : String(err));
	}

	const client = await requireClient();
	const existing = await findTeamWorkspace(client, team, project);
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
	const workspaceLabel = teamWorkspaceLabel(snap.hub ? "hub" : "peers", snap.team, project);
	const layout = buildTeamLayout({
		team: snap.team,
		peers: snap.peers,
		repoRoot: REPO_ROOT,
		resumeForPeer: resumeFor,
		project,
		...(snap.hub ? { hub: { command: hubCommand(project), label: "hub", ratio: 0.4 } } : {}),
	});

	const created = await client.herdr.workspaceCreate({
		label: workspaceLabel,
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
	console.log(`Resumed team "${snap.team}" in workspace "${workspaceLabel}" (${wsId}):`);
	for (const p of snap.peers) {
		console.log(`  • ${p.name}${p.name && resumedNames.has(p.name) ? " (session resumed)" : " (fresh)"}`);
	}
	console.log(`Focus: herdr workspace focus ${wsId}`);
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const [cmd, team] = argv;
	if (!cmd || !team) {
		console.error("usage: team-snapshot.ts <snapshot|down|resume> <team> [--project <name>]");
		process.exit(2);
	}
	let project = DEFAULT_PROJECT;
	try {
		validateTeamName(team);
		project = parseProjectFlag(argv.slice(2));
	} catch (err) {
		die(err instanceof Error ? err.message : String(err));
	}
	if (cmd === "snapshot") return cmdSnapshot(team, project);
	if (cmd === "down") return cmdDown(team, project);
	if (cmd === "resume") return cmdResume(team, project);
	die(`Unknown command "${cmd}" (want snapshot | down | resume).`);
}

const isEntry = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) void main();
