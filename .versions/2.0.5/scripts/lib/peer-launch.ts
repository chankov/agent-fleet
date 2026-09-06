// scripts/lib/peer-launch.ts
//
// Pure logic for `just fleet peer <name>` — ONE addressable coms peer, in its
// own herdr pane by default, with no peers.yaml team involved.
//
// One verb, three shapes of peer, two placements:
//
//   runner: claude-code            → `just _claude-peer …`   (Claude + its coms bridge)
//   runner: pi, persona resolved   → `just _peer[-plus] …`   (guarded reusable persona peer)
//   runner: pi, no persona         → `just _fleet-peer …`    (Fleet Core + coms, no persona)
//
//   default   → the command runs in a pane of its own
//   --here    → the command takes over the CALLING terminal
//
// The third shape is what `just fleet peer <name>` meant before pane placement
// existed, so `--here` reproduces the old behavior exactly while the same
// invocation without it now opens a pane.
//
// Resolution order for every field: explicit CLI flag → the peers.yaml
// declaration for that NAME (searched across all teams, see findPeerByName) →
// a convention default. So `just fleet peer code-reviewer` gets the
// `runner: claude-code` the fleet declares, and `--runner claude-code` needs no
// manifest entry at all.
//
// No sockets, no process.exit, no fs — callers supply the manifest text and a
// persona-existence probe, and every failure is a plain Error.

import { findPeerByName, parsePeersYaml, peerCommand, type Peer } from "./herdr-layout.ts";
import { DEFAULT_PROJECT, teamWorkspaceLabel, validateProject } from "./team-project.ts";

/** Synthetic team name used in peerCommand errors for a peer that has no team. */
export const ADHOC_TEAM = "ad-hoc";

/** The extension `--browser` adds to a pi persona peer (the `_peer-plus` route). */
export const BROWSER_EXTENSION = "chrome-devtools-mcp";

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
	/** --runner; omit to inherit the peers.yaml declaration, else defaults to pi. */
	runner?: string;
	/** --persona; omit to inherit the declaration, else the same-named persona. */
	persona?: string;
	/**
	 * --no-persona: force the identity-only Fleet Core peer even when the name
	 * resolves to a persona. The escape hatch for raw pi arguments and
	 * --all-extensions under a name that happens to match `agents/<name>.md`.
	 */
	noPersona?: boolean;
	model?: string;
	project?: string;
	extensions?: string;
	/** --browser: an extra extension for a persona peer, a capability flag for a core peer. */
	browser?: boolean;
	/** --all-extensions: core peers only — persona peers are deliberately deterministic. */
	allExtensions?: boolean;
	/** Raw pi arguments after `--`; core peers only. */
	piArgs?: string[];
	direction?: "right" | "down";
	/** --here: run in the calling terminal instead of a pane. */
	here?: boolean;
}

export interface PeerLaunchContext {
	/** Raw .pi/agents/peers.yaml, or "" when the repo has none. */
	peersYaml: string;
	/** True when `agents/<persona>.md` or `.pi/agents/<persona>.md` exists. */
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
	extensions?: string;
	/** Repo-relative env_file inherited from the declaration, if any. */
	envFile?: string;
	project: string;
	/** argv for the pane (or for this terminal under --here). */
	command: string[];
	placement: "pane" | "here";
	direction: "right" | "down";
	/** Workspace label used only when launching a pane outside a herdr pane. */
	workspaceLabel: string;
	/** True when peers.yaml declares this name (its fields seeded the plan). */
	declared: boolean;
}

function validateName(name: string): string {
	if (!PEER_NAME_SAFE.test(name)) {
		throw new Error(
			`Invalid peer name: ${JSON.stringify(name)} (letters, numbers, underscores and hyphens; must start alphanumeric)`,
		);
	}
	return name;
}

function normalizeRunner(runner: string | undefined, source: string): PeerRunner | undefined {
	if (runner === undefined) return undefined;
	if (runner === "pi" || runner === "claude-code") return runner;
	throw new Error(`Unknown runner ${JSON.stringify(runner)} from ${source} (supported: pi, claude-code)`);
}

function mergeExtensions(...values: (string | undefined)[]): string | undefined {
	const names = values
		.flatMap((v) => (v ?? "").split(","))
		.map((v) => v.trim())
		.filter((v) => v !== "");
	return names.length > 0 ? [...new Set(names)].join(",") : undefined;
}

/**
 * The pre-pane-placement `just fleet peer <name>` command: Fleet Core + coms
 * under the given identity, with no persona and arbitrary pi arguments. Its
 * positionals are `<name> <browser> <all_extensions>` followed by raw pi args,
 * so `--project` travels as an ordinary pi flag rather than a placeholder slot.
 */
function corePeerCommand(name: string, opts: PeerLaunchOptions, project: string, model?: string): string[] {
	const command = ["just", "_fleet-peer", name, opts.browser ? "true" : "false", opts.allExtensions ? "true" : "false"];
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
 * Merge CLI options with the peers.yaml declaration for the same name and
 * produce the launch argv. Nothing is silently dropped: a flag that cannot
 * apply to the resolved runner is an error, not a no-op.
 */
export function buildPeerLaunchPlan(opts: PeerLaunchOptions, ctx: PeerLaunchContext): PeerLaunchPlan {
	const name = validateName(opts.name);
	const project = validateProject(opts.project ?? DEFAULT_PROJECT);
	const teams = ctx.peersYaml ? parsePeersYaml(ctx.peersYaml) : {};
	const declared: Peer | undefined = findPeerByName(teams, name);

	const runner =
		normalizeRunner(opts.runner, "--runner") ??
		normalizeRunner(declared?.runner, `peers.yaml peer "${name}"`) ??
		"pi";

	const model = opts.model ?? declared?.model;
	const common = {
		name,
		runner,
		...(model ? { model } : {}),
		...(declared?.env_file ? { envFile: declared.env_file } : {}),
		project,
		placement: (opts.here ? "here" : "pane") as "here" | "pane",
		direction: opts.direction ?? ("right" as const),
		workspaceLabel: teamWorkspaceLabel("peer", name, project, ctx.worktreeTag),
		declared: declared !== undefined,
	};

	if (runner === "claude-code") {
		if (opts.persona) throw new Error("--persona is pi-only; a claude-code peer carries no pi persona.");
		if (opts.extensions || opts.browser || opts.allExtensions) {
			throw new Error("--extensions/--browser/--all-extensions are pi-only and cannot combine with --runner claude-code.");
		}
		if (opts.piArgs?.length) throw new Error("arguments after `--` are pi arguments and cannot combine with --runner claude-code.");
		return {
			...common,
			kind: "claude-peer",
			command: peerCommand({ name, ...(model ? { model } : {}), runner }, ADHOC_TEAM, undefined, project),
		};
	}

	if (opts.noPersona && opts.persona) throw new Error("--no-persona and --persona are contradictory.");
	const persona = opts.noPersona
		? undefined
		: opts.persona ?? declared?.persona ?? (ctx.personaExists(name) ? name : undefined);

	// No persona anywhere → the identity-only Fleet Core peer, which is exactly
	// what this command did before pane placement existed. Not an error: it is
	// the third shape of peer, and the only one that takes raw pi arguments.
	if (!persona) {
		if (opts.extensions) {
			throw new Error(
				`--extensions needs a persona peer. Pass --persona <name>, add agents/${name}.md, ` +
					"or use --all-extensions / raw pi flags after `--`.",
			);
		}
		return { ...common, kind: "core-peer", command: corePeerCommand(name, opts, project, model) };
	}

	if (!ctx.personaExists(persona)) throw new Error(`Persona "${persona}" not found under agents/ or .pi/agents/.`);
	if (opts.allExtensions) {
		throw new Error(
			`--all-extensions is not available to persona peer "${name}": reusable peers load a deterministic set. ` +
				"Use --extensions <names>, declare extensions: in .pi/agents/peers.yaml, or --no-persona for a plain Fleet Core peer.",
		);
	}
	if (opts.piArgs?.length) {
		throw new Error(
			`arguments after \`--\` need a personaless core peer; persona peer "${name}" builds its own pi command line. ` +
				`Add --no-persona to launch "${name}" as a plain Fleet Core peer instead.`,
		);
	}
	const extensions = mergeExtensions(opts.extensions ?? declared?.extensions, opts.browser ? BROWSER_EXTENSION : undefined);

	return {
		...common,
		kind: "persona-peer",
		persona,
		...(extensions ? { extensions } : {}),
		command: peerCommand(
			{ name, persona, ...(model ? { model } : {}), ...(extensions ? { extensions } : {}) },
			ADHOC_TEAM,
			undefined,
			project,
		),
	};
}

export interface ParsedPeerArgs extends PeerLaunchOptions {
	dryRun: boolean;
	/** --peers: alternate manifest path (tests use it). */
	peersYaml?: string;
}

function takeValue(argv: string[], i: number, flag: string): string {
	const value = argv[i + 1];
	if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
	return value;
}

/**
 * `<name> [--runner r] [--persona p|--no-persona] [--model m] [--project p]
 *  [--extensions a,b] [--browser] [--all-extensions] [--direction right|down]
 *  [--here] [--dry-run] [--peers path] [-- PI_ARGS…]`
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
			case "--browser":
				out.browser = true;
				break;
			case "--all-extensions":
				out.allExtensions = true;
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
			case "--model":
				out.model = takeValue(argv, i++, arg);
				break;
			case "--project":
				out.project = takeValue(argv, i++, arg);
				break;
			case "--extensions":
				out.extensions = takeValue(argv, i++, arg);
				break;
			case "--peers":
				out.peersYaml = takeValue(argv, i++, arg);
				break;
			case "--direction": {
				const value = takeValue(argv, i++, arg);
				if (value !== "right" && value !== "down") throw new Error(`--direction expects right or down, got ${JSON.stringify(value)}`);
				out.direction = value;
				break;
			}
			default:
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
