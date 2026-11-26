// .pi/agent-fleet/scripts/herdr-hub.ts
//
// `just fleet --herdr` and `just fleet conductor hermes [name]` — open ONE
// herdr workspace with ONE pane: the guarded Fleet Hub, or the Hermes
// conductor in its place. Peers are not part of it; each is started on its own
// with `just fleet peer <name>` or the Hub's herdr_spawn_peer (PLAN-11-01,
// D14/D15).
//
//   herdr-hub.ts [--project <name>] [--no-coms] [--browser] [--voice] [--all-extensions] [--dry-run]
//   herdr-hub.ts --conductor hermes [--name <label>] [--project <name>] [--dry-run]
//
// Hard rules:
// - Entrypoint guard: launching lives inside main(); importing the module must
//   NOT spawn anything.
// - The repo root is resolved relative to THIS file, not the caller's cwd.
// - --dry-run prints the resolved layout JSON and exits WITHOUT touching herdr
//   (must work with no herdr installed) and without reading monitor state.
// - Never clobber an existing workspace of the same label; refuse and explain.
// - Unknown flags are refused, never dropped: this launcher forwards no Pi
//   arguments into the pane.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { workspaceRoot } from "../../harnesses/lib/workspace-context.ts";
import type { LayoutNode } from "./lib/herdr-layout.ts";
import { resolveMonitorEnv } from "./lib/monitor-env.ts";
import { bindTargetLayout, peerTarget } from "./lib/peer-target.ts";
import {
	DEFAULT_PROJECT,
	conductorSpec,
	hubCommand,
	validateProject,
	teamWorkspaceLabel,
	worktreeTag,
	type HubCommandOptions,
} from "./lib/team-project.ts";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = workspaceRoot(fs.realpathSync(path.resolve(SCRIPT_DIR, "..", "..", "..")));

/** The Hub workspace keeps its historical `<tag>-hub-base` label. */
const HUB_WORKSPACE_NAME = "base";
const DEFAULT_CONDUCTOR_NAME = "full";

const USAGE =
	"usage: herdr-hub.ts [--project <name>] [--no-coms] [--browser] [--voice] [--all-extensions] [--dry-run]\n" +
	"       herdr-hub.ts --conductor hermes [--name <label>] [--project <name>] [--dry-run]";

interface Args {
	project: string;
	conductor: boolean;
	name?: string;
	dryRun: boolean;
	hub: HubCommandOptions;
}

const BOOLEAN_FLAGS: Record<string, keyof HubCommandOptions | "dryRun"> = {
	"--dry-run": "dryRun",
	"--no-coms": "noComs",
	"--browser": "browser",
	"--voice": "voice",
	"--all-extensions": "allExtensions",
};

export function parseHerdrHubArgs(argv: string[]): Args {
	const out: Args = { project: DEFAULT_PROJECT, conductor: false, dryRun: false, hub: {} };
	const seen = new Set<string>();
	const value = (i: number, flag: string): string => {
		const v = argv[i + 1];
		if (!v || v.startsWith("--")) throw new Error(`${flag} requires a value`);
		return v;
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (seen.has(arg)) throw new Error(`${arg} may only be provided once`);
		seen.add(arg);
		if (arg in BOOLEAN_FLAGS) {
			const key = BOOLEAN_FLAGS[arg];
			if (key === "dryRun") out.dryRun = true;
			else out.hub[key] = true;
		} else if (arg === "--project") {
			out.project = validateProject(value(i++, arg));
		} else if (arg === "--conductor") {
			const backend = value(i++, arg);
			if (backend !== "hermes") throw new Error(`Unknown conductor backend: ${JSON.stringify(backend)} (expected hermes)`);
			out.conductor = true;
		} else if (arg === "--name") {
			out.name = value(i++, arg);
		} else {
			throw new Error(`Unknown argument: ${arg} (this launcher forwards no Pi arguments)`);
		}
	}
	if (out.conductor && Object.keys(out.hub).length > 0) {
		throw new Error("--no-coms/--browser/--voice/--all-extensions apply to the Hub pane, not the Hermes conductor");
	}
	if (!out.conductor && out.name !== undefined) throw new Error("--name labels a conductor workspace and requires --conductor hermes");
	return out;
}

function die(msg: string): never {
	console.error(msg);
	process.exit(1);
}

async function main(): Promise<void> {
	let args: Args;
	let target: ReturnType<typeof peerTarget>;
	try {
		args = parseHerdrHubArgs(process.argv.slice(2));
		target = peerTarget(args.project);
		if (target) {
			if (args.conductor) throw new Error("Targeted Hermes conductor is unsupported: external profile split-root contract is unverified; use the Hub or a targeted Pi peer");
			if (args.hub.allExtensions) throw new Error("Targeted Hub refuses --all-extensions; select explicit workspace resources");
			args.project = target.project;
		}
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		console.error(USAGE);
		process.exit(2);
	}

	const project = args.project;
	const tag = worktreeTag(target ? target.roots.executionRoot : REPO_ROOT);
	let label: string;
	let pane: Extract<LayoutNode, { type: "pane" }>;
	let what: string;
	try {
		// The pane is spawned BY herdr, whose daemon was started at some other
		// time from some other shell — so unlike `just fleet`, it inherits nothing
		// from this process. The monitor variables have to travel as pane env or
		// the launcher most likely to want a task tree never gets one.
		const monitorEnv = args.dryRun ? null : resolveMonitorEnv();
		if (args.conductor) {
			const spec = conductorSpec("hermes", { repoRoot: REPO_ROOT, project });
			label = teamWorkspaceLabel(spec.workspaceMode, args.name ?? DEFAULT_CONDUCTOR_NAME, project, tag);
			const env = { ...spec.env, ...(monitorEnv ?? {}) };
			pane = { type: "pane", command: spec.command, cwd: spec.cwd, label: spec.paneLabel, ...(Object.keys(env).length > 0 ? { env } : {}) };
			what = `${spec.paneLabel} (${spec.command.join(" ")} — ${spec.displayText})`;
		} else {
			label = teamWorkspaceLabel("hub", HUB_WORKSPACE_NAME, project, tag);
			const command = hubCommand(project, args.hub);
			pane = { type: "pane", command, cwd: REPO_ROOT, label: "hub", ...(monitorEnv ? { env: { ...monitorEnv } } : {}) };
			what = `hub (${command.join(" ")} — guarded dispatcher)`;
		}
	} catch (err) {
		die(err instanceof Error ? err.message : String(err));
	}
	let layout: LayoutNode;
	try {
		layout = bindTargetLayout(pane, target);
	} catch (err) {
		die(err instanceof Error ? err.message : String(err));
	}

	const dryCommand = args.conductor
		? `just fleet conductor hermes ${args.name ?? DEFAULT_CONDUCTOR_NAME} --dry-run`
		: "just fleet --herdr --dry-run";
	const projectArgs = project === DEFAULT_PROJECT ? "" : ` --project ${project}`;

	if (args.dryRun) {
		// No herdr calls and no monitor-state reads on this path.
		const projectNote = project === DEFAULT_PROJECT ? "" : `, project "${project}"`;
		console.log(`# herdr-hub (dry run) — ${args.conductor ? "Hermes conductor" : "hub"}${projectNote}, herdr workspace "${label}"`);
		console.log(JSON.stringify({
			label,
			layout,
			...(target ? { workspaceRoot: target.roots.workspaceRoot, executionRoot: target.roots.executionRoot, targetId: target.roots.targetId, baseProject: target.baseProject, project: target.project } : {}),
		}, null, 2));
		return;
	}

	// Import lazily so --dry-run never touches the client (or the socket).
	const { herdr, requireHerdr, HerdrUnavailableError } = await import("../../../.pi/harnesses/lib/herdr-client.ts");
	try {
		await requireHerdr();
	} catch (err) {
		if (err instanceof HerdrUnavailableError) {
			console.error(err.message);
			console.error(`(dry run still works: ${dryCommand}${projectArgs})`);
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

	const created = await herdr.workspaceCreate({ label, cwd: target?.roots.executionRoot ?? REPO_ROOT, focus: false });
	const wsId = created.workspace.workspace_id;
	const initialTab = created.workspace.active_tab_id ?? (typeof created.tab?.tab_id === "string" ? created.tab.tab_id : undefined);
	await herdr.layoutApply({ workspace_id: wsId, root: layout });
	// layout.apply lands in a fresh tab; drop the empty shell tab
	// workspace.create made so the launched tab is the only one.
	if (initialTab) {
		try {
			await herdr.tabClose(initialTab);
		} catch {
			// non-fatal: an extra empty tab is cosmetic
		}
	}
	console.log(`Launched ${what} in herdr workspace "${label}" (${wsId}).`);
	console.log(`Focus: herdr workspace focus ${wsId}`);
	console.log(`Close: herdr workspace close ${wsId}`);
}

const isEntry = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) void main();
