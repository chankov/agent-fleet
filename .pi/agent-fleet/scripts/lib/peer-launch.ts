// .pi/agent-fleet/scripts/lib/peer-launch.ts
//
// Pure logic for `just fleet peer <name>` — ONE addressable coms peer, in its
// own herdr pane by default. There are no peer groups and no declarations
// file (PLAN-11-01, D8/D16): a peer's settings are its flags.
//
// One verb, three shapes of peer, two placements:
//
//   --runner claude-code           → `just _claude-peer …`   (Claude + its coms bridge)
//   runner pi, persona resolved    → `just _peer …`          (guarded reusable persona peer)
//   runner pi, no persona          → `just _fleet-peer …`    (Fleet Core + coms, no persona)
//
//   default   → the command runs in a pane of its own
//   --here    → the command takes over the CALLING terminal
//
// A pi peer always loads the chrome-devtools-mcp extension; a read-only pi
// peer (`--read-only` → `_peer-read-only`) loads no extension at all (D17).
// The recipes own that, so there is no extension choice here.
//
// Resolution: explicit flag → a convention default. The persona defaults to
// the same-named role/persona file when one exists, so an undeclared name
// keeps working: persona-backed when such a file exists, else a core peer.
//
// No sockets, no process.exit, no fs — callers supply a persona-existence
// probe, and every failure is a plain Error.

import { peerCommand, resolveEnvFilePath } from "./herdr-layout.ts";
import { DEFAULT_PROJECT, teamWorkspaceLabel, validateProject } from "./team-project.ts";

/**
 * Pane label + coms identity charset. Stricter than herdr-layout's SAFE, which
 * also permits `.`, `/` and `,` — fine inside a model spec, wrong for a name
 * that becomes a pane label, a workspace label segment, and a coms address.
 */
export const PEER_NAME_SAFE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export type PeerRunner = "pi" | "claude-code";
/** Which hidden recipe launches this peer — see the header table. */
export type PeerKind = "persona-peer" | "core-peer" | "claude-peer";

export interface PeerLaunchOptions {
	name: string;
	/** --runner; defaults to pi. */
	runner?: string;
	/** --persona; omit for the same-named persona when one exists. */
	persona?: string;
	/**
	 * --no-persona: force the identity-only Fleet Core peer even when the name
	 * resolves to a persona. The escape hatch for raw pi arguments under a name
	 * that happens to match a persona file.
	 */
	noPersona?: boolean;
	model?: string;
	project?: string;
	/** --env-file: repo-relative KEY=VALUE file injected as the pane env. */
	envFile?: string;
	/** Raw pi arguments after `--`; core peers only. */
	piArgs?: string[];
	direction?: "right" | "down";
	/** --here: run in the calling terminal instead of a pane. */
	here?: boolean;
	/**
	 * --read-only: launches the peer with enforced inspection-only tools so it
	 * can declare `read_only` at registration (D3).
	 */
	readOnly?: boolean;
}

export interface PeerLaunchContext {
	/** True when a persona/role file `<persona>.md` exists in a persona directory. */
	personaExists(persona: string): boolean;
	/** worktreeTag(REPO_ROOT) — scopes the standalone workspace label. */
	worktreeTag: string;
}

export interface PeerLaunchPlan {
	name: string;
	runner: PeerRunner;
	kind: PeerKind;
	persona?: string;
	model?: string;
	/** Repo-relative env file from --env-file, if any; its values are read only at launch. */
	envFile?: string;
	project: string;
	/** argv for the pane (or for this terminal under --here). */
	command: string[];
	placement: "pane" | "here";
	direction: "right" | "down";
	/** Workspace label used only when launching a pane outside a herdr pane. */
	workspaceLabel: string;
	/** Present (true) only for a read-only launch. */
	readOnly?: true;
}

function validateName(name: string): string {
	if (!PEER_NAME_SAFE.test(name)) {
		throw new Error(
			`Invalid peer name: ${JSON.stringify(name)} (letters, numbers, underscores and hyphens; must start alphanumeric)`,
		);
	}
	return name;
}

function normalizeRunner(runner: string | undefined): PeerRunner {
	if (runner === undefined || runner === "pi") return "pi";
	if (runner === "claude-code") return runner;
	throw new Error(`Unknown runner ${JSON.stringify(runner)} from --runner (supported: pi, claude-code)`);
}

/**
 * The identity-only peer: Fleet Core + coms + chrome-devtools-mcp under the
 * given name, with no persona and arbitrary pi arguments. `--project` travels
 * as an ordinary pi flag rather than a placeholder slot.
 */
function corePeerCommand(name: string, opts: PeerLaunchOptions, project: string, model?: string): string[] {
	const command = ["just", "_fleet-peer", name];
	if (model !== undefined) {
		if (/[\r\n]/.test(model)) throw new Error(`model contains a line break: ${JSON.stringify(model)}`);
		command.push("--model", model);
	}
	if (project !== DEFAULT_PROJECT) command.push("--project", project);
	for (const arg of opts.piArgs ?? []) {
		// A pane launch types this argv at a shell prompt one line at a time, so
		// an embedded newline would execute half of it as a separate command.
		if (/[\r\n]/.test(arg)) throw new Error(`pi argument contains a line break: ${JSON.stringify(arg)}`);
		command.push(arg);
	}
	return command;
}

/**
 * Turn the flags into the launch argv. Nothing is silently dropped: a flag
 * that cannot apply to the resolved runner is an error, not a no-op.
 */
export function buildPeerLaunchPlan(opts: PeerLaunchOptions, ctx: PeerLaunchContext): PeerLaunchPlan {
	const name = validateName(opts.name);
	const project = validateProject(opts.project ?? DEFAULT_PROJECT);
	const runner = normalizeRunner(opts.runner);
	const model = opts.model;
	// Validate the path shape now so a dry run refuses it; values are read only at launch.
	if (opts.envFile !== undefined) resolveEnvFilePath(opts.envFile, "/repo");
	const readOnly = opts.readOnly === true;
	const readOnlyField = readOnly ? { read_only: "true" } : {};
	const common = {
		name,
		runner,
		...(model ? { model } : {}),
		...(opts.envFile ? { envFile: opts.envFile } : {}),
		project,
		placement: (opts.here ? "here" : "pane") as "here" | "pane",
		direction: opts.direction ?? ("right" as const),
		workspaceLabel: teamWorkspaceLabel("peer", name, project, ctx.worktreeTag),
		...(readOnly ? { readOnly: true as const } : {}),
	};

	if (runner === "claude-code") {
		if (opts.persona || opts.noPersona) throw new Error("--persona/--no-persona are pi-only; a claude-code peer carries no pi persona.");
		if (opts.piArgs?.length) throw new Error("arguments after `--` are pi arguments and cannot combine with --runner claude-code.");
		return {
			...common,
			kind: "claude-peer",
			command: peerCommand({ name, ...(model ? { model } : {}), runner, ...readOnlyField }, project),
		};
	}

	if (opts.noPersona && opts.persona) throw new Error("--no-persona and --persona are contradictory.");
	const persona = opts.noPersona
		? undefined
		: opts.persona ?? (ctx.personaExists(name) ? name : undefined);

	// No persona → the identity-only Fleet Core peer. Not an error: it is the
	// third shape of peer, and the only one that takes raw pi arguments.
	if (!persona) {
		if (readOnly) {
			throw new Error(
				`read-only launches exist for persona peers (\`_peer-read-only\`) and --runner claude-code, not for the ` +
					`personaless core peer "${name}". Pass --persona <name> or add .pi/agents/personas/${name}.md.`,
			);
		}
		return { ...common, kind: "core-peer", command: corePeerCommand(name, opts, project, model) };
	}

	if (!ctx.personaExists(persona)) throw new Error(`Persona "${persona}" not found under agents/ or .pi/agents/.`);
	if (opts.piArgs?.length) {
		throw new Error(
			`arguments after \`--\` need a personaless core peer; persona peer "${name}" builds its own pi command line. ` +
				`Add --no-persona to launch "${name}" as a plain Fleet Core peer instead.`,
		);
	}
	return {
		...common,
		kind: "persona-peer",
		persona,
		command: peerCommand({ name, persona, ...(model ? { model } : {}), ...readOnlyField }, project),
	};
}

export interface ParsedPeerArgs extends PeerLaunchOptions {
	dryRun: boolean;
}

function takeValue(argv: string[], i: number, flag: string): string {
	const value = argv[i + 1];
	if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
	return value;
}

/** Flags of the removed peer groups (D8/D16/D17), refused with the reason rather than as typos. */
const REMOVED_FLAGS: Record<string, string> = {
	"--browser": "every pi peer loads chrome-devtools-mcp, and a read-only peer loads no extension",
	"--extensions": "every pi peer loads chrome-devtools-mcp, and a read-only peer loads no extension",
	"--all-extensions": "a peer loads a deterministic extension set (Fleet Core, coms, chrome-devtools-mcp)",
	"--peers": "peers.yaml was removed; a peer's settings are its flags",
};

/**
 * `<name> [--runner pi|claude-code] [--persona p|--no-persona] [--model m]
 *  [--read-only] [--env-file path] [--project p] [--direction right|down]
 *  [--here] [--dry-run] [-- PI_ARGS…]`
 *
 * The peer name is the only positional and everything after `--` goes to pi
 * verbatim. An unrecognized flag BEFORE `--` is an error rather than silently
 * dropped argv — the failure mode `project=af` already taught this fleet about.
 */
export function parsePeerArgs(argv: string[]): ParsedPeerArgs {
	const out: ParsedPeerArgs = { name: "", dryRun: false };
	let name: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--") {
			out.piArgs = argv.slice(i + 1);
			break;
		}
		switch (arg) {
			case "--dry-run":
				out.dryRun = true;
				break;
			case "--here":
				out.here = true;
				break;
			case "--runner":
				out.runner = takeValue(argv, i++, arg);
				break;
			case "--persona":
				out.persona = takeValue(argv, i++, arg);
				break;
			case "--no-persona":
				out.noPersona = true;
				break;
			case "--read-only":
				out.readOnly = true;
				break;
			case "--model":
				out.model = takeValue(argv, i++, arg);
				break;
			case "--project":
				out.project = takeValue(argv, i++, arg);
				break;
			case "--env-file":
				// Node (≤25) scans its whole argv for `--env-file` and aborts with
				// "node: <path>: not found" before this script runs when the file is
				// missing; an existing file is passed through here, not loaded.
				out.envFile = takeValue(argv, i++, arg);
				break;
			case "--direction": {
				const value = takeValue(argv, i++, arg);
				if (value !== "right" && value !== "down") throw new Error(`--direction expects right or down, got ${JSON.stringify(value)}`);
				out.direction = value;
				break;
			}
			default:
				if (REMOVED_FLAGS[arg]) throw new Error(`${arg} was removed: ${REMOVED_FLAGS[arg]}.`);
				if (arg.startsWith("-")) {
					throw new Error(`Unknown flag: ${arg} — pass pi flags after \`--\` (e.g. just fleet peer ${name ?? "<name>"} -- ${arg})`);
				}
				if (name !== undefined) throw new Error(`fleet peer takes one peer name, got ${JSON.stringify(name)} and ${JSON.stringify(arg)}`);
				name = arg;
		}
	}
	if (!name) throw new Error("fleet peer requires a peer name");
	out.name = name;
	return out;
}
