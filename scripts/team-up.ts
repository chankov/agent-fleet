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
import * as os from "node:os";
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
import { planSpawnDelays } from "./lib/spawn-stagger.ts";
import {
	DEFAULT_PROJECT,
	conductorSpec,
	hubCommand,
	parseProjectFlag,
	teamWorkspaceLabel,
	validateTeamName,
	worktreeTag,
	type ConductorBackend,
	type ConductorSpec,
} from "./lib/team-project.ts";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = fs.realpathSync(path.resolve(SCRIPT_DIR, ".."));
// Scopes the workspace label to this checkout so the same team from another
// repo/worktree gets its own workspace instead of colliding (see worktreeTag).
const WORKTREE_TAG = worktreeTag(REPO_ROOT);
const DEFAULT_PEERS_YAML = path.join(REPO_ROOT, ".pi", "agents", "peers.yaml");

// The guarded hub or Hermes conductor occupies this share of the workspace in
// --hub/--conductor mode; the team tiles in the rest.
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

function parseConductorBackend(argv: string[]): ConductorBackend | null {
	const indexes = argv.flatMap((value, index) => value === "--conductor" ? [index] : []);
	if (indexes.length > 1) throw new Error("--conductor may only be provided once");
	if (indexes.length === 0) return null;
	const value = argv[indexes[0] + 1];
	if (!value || value.startsWith("--")) return "hermes"; // legacy bare --conductor
	if (value === "hermes" || value === "codex") return value;
	throw new Error(`Unknown conductor backend: ${JSON.stringify(value)} (expected hermes or codex)`);
}

function loadTeam(team: string, peersYaml: string): Peer[] {
	if (!fs.existsSync(peersYaml)) die(`peers.yaml not found at ${peersYaml}`);
	const teams = parsePeersYaml(fs.readFileSync(peersYaml, "utf-8"));
	const peers = teams[team];
	if (!peers) {
		const names = Object.keys(teams).join(", ") || "(none)";
		die(`Unknown team "${team}". Available teams: ${names}`);
	}
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

// Pre-warm/stagger (see scripts/lib/spawn-stagger.ts): when auth.json holds a
// stale OAuth token, simultaneous pi boots race on its file lock and the
// losers come up with every provider "unconfigured". One pi pane (the hub
// when present, else the first pi peer) starts immediately and refreshes the
// token; the others get a small AGENT_FLEET_SPAWN_DELAY via pane env. The
// auth file is only read for `type`/`expires` — values never leave this
// process. Dry-run never reaches this (no live-state reads on that path).
function makeDelayLoader(peers: Peer[], mode: "peers" | "hub" | "conductor"): (peer: Peer) => number | undefined {
	let raw: string | undefined;
	try {
		raw = fs.readFileSync(path.join(os.homedir(), ".pi", "agent", "auth.json"), "utf-8");
	} catch {
		raw = undefined;
	}
	// The conductor root is Hermes, not pi — the first pi peer warms instead.
	const { needed, delayForPeer } = planSpawnDelays(peers, mode === "hub", raw);
	if (needed) {
		console.log("Stale pi OAuth token detected — staggering pane starts so one pane can refresh it first.");
	}
	return delayForPeer;
}

async function validateCodexLaunchOrDie(spec: ConductorSpec, project: string): Promise<void> {
	try {
		const { assertConductorContext, lifecyclePaths, loadOwnedConfig, preflight, requestedState } = await import("./lib/codex-remote-control.ts");
		const config = loadOwnedConfig(lifecyclePaths().configPath);
		assertConductorContext(config, {
			repoRoot: REPO_ROOT,
			project,
			team: spec.team,
			name: spec.conductorName,
			timeoutMs: Number(spec.env.COMS_CLI_TIMEOUT_MS),
			contractPath: String(spec.env.AGENT_FLEET_CODEX_CONTRACT_PATH),
			contractIdentity: String(spec.env.AGENT_FLEET_CODEX_CONTRACT_IDENTITY),
		});
		preflight(config);
		const state = requestedState();
		if (state.active !== "active" || state.sub !== "exited") {
			throw new Error(`Codex user service is not in requested active (exited) state: ${state.active} (${state.sub})`);
		}
	} catch (err) {
		die(`Codex launch refused before Herdr: ${err instanceof Error ? err.message : String(err)}`);
	}
}

function buildLayoutOrDie(
	team: string,
	peers: Peer[],
	envForPeer: (p: Peer) => Record<string, string> | undefined,
	project: string,
	rootPane?: { command: string[]; label: string; ratio: number; cwd?: string; env?: Record<string, string> },
	delayForPeer?: (p: Peer) => number | undefined,
): LayoutNode {
	try {
		return buildTeamLayout({
			team,
			peers,
			repoRoot: REPO_ROOT,
			envForPeer,
			project,
			...(delayForPeer ? { delayForPeer } : {}),
			...(rootPane ? { hub: rootPane } : {}),
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
	let conductor: ConductorBackend | null;
	try {
		conductor = parseConductorBackend(argv);
	} catch (err) {
		die(err instanceof Error ? err.message : String(err));
	}
	if (hub && conductor) die("--hub and --conductor are mutually exclusive");
	const mode: "peers" | "hub" | "conductor" = hub ? "hub" : conductor ? "conductor" : "peers";

	if (!team) {
		console.error("usage: team-up.ts --team <name> [--hub|--conductor] [--dry-run] [--peers <peers.yaml>] [--project <name>]");
		process.exit(2);
	}

	try {
		validateTeamName(team);
	} catch (err) {
		die(err instanceof Error ? err.message : String(err));
	}
	const peers = loadTeam(team, peersYaml);
	if (peers.length === 0 && mode === "peers") {
		die(`Team "${team}" has no peers. Empty teams require --hub or --conductor.`);
	}
	let spec: ConductorSpec | undefined;
	let label: string;
	try {
		spec = conductor ? conductorSpec(conductor, {
			repoRoot: REPO_ROOT,
			runtimeDir: path.join(os.homedir(), ".local", "state", "agent-fleet", "codex-conductor"),
			team,
			project,
			nodeBin: process.execPath,
		}) : undefined;
		label = teamWorkspaceLabel(spec?.workspaceMode ?? (hub ? "hub" : "peers"), team, project, WORKTREE_TAG);
	} catch (err) {
		die(err instanceof Error ? err.message : String(err));
	}
	const rootPane = hub
		? { command: hubCommand(project), label: "hub", ratio: HUB_RATIO }
		: spec
			? { command: spec.command, label: spec.paneLabel, ratio: spec.ratio, cwd: spec.cwd, env: spec.env }
			: undefined;

	if (dryRun) {
		// No herdr calls and no env_file reads on this path — must work with no
		// herdr installed, and secrets never reach the output.
		const layout = buildLayoutOrDie(team, peers, makeEnvLoader(peers, true), project, rootPane);
		const projectNote = project === DEFAULT_PROJECT ? "" : `, project "${project}"`;
		const extra = mode === "hub" ? " + hub" : spec ? ` + ${spec.backend === "codex" ? "Codex conductor" : "Hermes conductor"}` : "";
		console.log(
			`# team-up (dry run) — team "${team}"${projectNote}, ${peers.length} peer(s)${extra}, herdr workspace "${label}"`,
		);
		for (const p of peers) {
			const cmd = layoutCommands(layout, p.name as string) ?? [];
			const envNote = p.env_file ? `  [env_file: ${p.env_file} — values redacted]` : "";
			console.log(`${p.name}\t${cmd.join(" ")}${envNote}`);
		}
		console.log(JSON.stringify({ label, layout }, null, 2));
		return;
	}

	if (spec?.backend === "codex") await validateCodexLaunchOrDie(spec, project);
	const layout = buildLayoutOrDie(team, peers, makeEnvLoader(peers, false), project, rootPane, makeDelayLoader(peers, mode));

	// Import lazily so --dry-run never touches the client (or the socket).
	const { herdr, requireHerdr, HerdrUnavailableError } = await import(
		"../.pi/harnesses/lib/herdr-client.ts"
	);

	try {
		await requireHerdr();
	} catch (err) {
		if (err instanceof HerdrUnavailableError) {
			console.error(err.message);
			const dryRecipe = mode === "hub" ? "hub-team-dry" : spec?.backend === "codex" ? "conductor-codex-dry" : mode === "conductor" ? "conductor-dry" : "team-up-dry";
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

	const launchedPrefix = mode === "hub" ? "hub + " : spec ? `${spec.backend} conductor + ` : "";
	console.log(
		`Launched ${launchedPrefix}${peers.length} peer(s) for team "${team}" in herdr workspace "${label}" (${wsId}):`,
	);
	if (mode === "hub") console.log(`  • hub (${hubCommand(project).join(" ")} — guarded dispatcher)`);
	if (spec) console.log(`  • ${spec.paneLabel} (${spec.command.join(" ")} — ${spec.displayText})`);
	if (spec?.backend === "codex") console.log("  • Closing this workspace does not stop the enabled Codex user service; stop it explicitly.");
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
