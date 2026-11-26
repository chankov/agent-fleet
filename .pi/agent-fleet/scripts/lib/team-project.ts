// .pi/agent-fleet/scripts/lib/team-project.ts
//
// Shared project scoping helpers for the Herdr launchers (`just fleet --herdr`,
// `just fleet conductor hermes`, `just fleet peer <name>`). The coms harness
// already isolates peers by --project; this file only keeps workspace labels
// and generated launch argv in sync with that scope. (The file name predates
// the removal of peer groups; it is kept because installed workspaces and the
// package tests reference it.)

import * as path from "node:path";

export const DEFAULT_PROJECT = "default";

// Conservative project names: no empty string, path separators, traversal,
// whitespace, shell metacharacters, or glob stars. Dots are allowed for names
// like "acme.prod", but ".." is not allowed anywhere.
export const PROJECT_SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Charset of the name segment of a workspace label (a peer or conductor name). */
const LABEL_NAME_SAFE = /^[A-Za-z0-9_-]+$/;

export type ConductorBackend = "hermes";
// "peer" is the `just fleet peer <name>` workspace (labelled by the peer name),
// "hub" the `just fleet --herdr` workspace, "conductor-hermes" the
// `just fleet conductor hermes [name]` workspace. Each holds a single pane.
export type WorkspaceMode = "peer" | "hub" | "conductor-hermes";

export interface ConductorSpec {
	backend: ConductorBackend;
	workspaceMode: Extract<WorkspaceMode, `conductor-${string}`>;
	paneLabel: string;
	command: string[];
	cwd: string;
	env: Record<string, string>;
	displayText: string;
}

function validateAbsoluteRepoRoot(repoRoot: string): string {
	if (!path.isAbsolute(repoRoot) || path.resolve(repoRoot) !== repoRoot || repoRoot.includes("..")) {
		throw new Error(`Invalid absolute repository root: ${JSON.stringify(repoRoot)}`);
	}
	return repoRoot;
}

export function validateProject(project: string): string {
	if (
		project.length === 0 ||
		project === "." ||
		project.includes("..") ||
		project.includes("/") ||
		project.includes("\\") ||
		!PROJECT_SAFE.test(project)
	) {
		throw new Error(
			`Invalid project name: ${JSON.stringify(project)} (use letters, numbers, dots, underscores, or hyphens; no '..')`,
		);
	}
	return project;
}

// The worktree/repo identity that scopes a workspace label so the same launch
// from different checkouts never collides. It is the LAST dot-segment of the
// checkout directory's basename — the convention the fleet uses for git
// worktrees: `main.wt2` → `wt2`, `ringithub.end2` → `end2`, a plain
// `agent-fleet` checkout → `agent-fleet`. Sanitized to the label-safe charset;
// falls back to "repo" when nothing usable remains.
export function worktreeTag(repoRoot: string): string {
	const base = path.basename(repoRoot);
	const dot = base.lastIndexOf(".");
	const seg = dot > 0 ? base.slice(dot + 1) : base;
	const safe = seg.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
	return safe || "repo";
}

export function parseProjectFlag(argv: string[]): string {
	let project = DEFAULT_PROJECT;
	let seen = false;
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] !== "--project") continue;
		if (seen) throw new Error("--project may only be provided once");
		seen = true;
		const value = argv[i + 1];
		if (!value || value.startsWith("--")) throw new Error("--project requires a name");
		project = value;
		i++;
	}
	return validateProject(project);
}

// Workspace label = <worktree-tag>-<mode>-<name>, with a `--project.<name>`
// suffix when the coms project is non-default. The worktree tag keys the label
// to the checkout, so the same launch from two repos/worktrees yields distinct
// labels (e.g. `wt2-hub-base` vs `end2-hub-base`) instead of colliding. Pass
// `tag` from worktreeTag(REPO_ROOT); it defaults to "repo" only for callers
// that have no checkout in hand. The label is display and collision scope only.
export function teamWorkspaceLabel(
	kind: WorkspaceMode,
	name: string,
	project = DEFAULT_PROJECT,
	tag = "repo",
): string {
	if (!LABEL_NAME_SAFE.test(name)) throw new Error(`Invalid workspace name: ${JSON.stringify(name)}`);
	validateProject(project);
	const base = `${tag}-${kind}-${name}`;
	return project === DEFAULT_PROJECT ? base : `${base}--project.${project}`;
}

export interface HubCommandOptions {
	noComs?: boolean;
	browser?: boolean;
	voice?: boolean;
	allExtensions?: boolean;
}

/** The Hub pane's argv: the ordinary `just fleet` launch with the Hub's own flags. */
export function hubCommand(
	project = DEFAULT_PROJECT,
	options: HubCommandOptions = {},
): string[] {
	validateProject(project);
	const command = ["just", "fleet"];
	if (options.noComs) command.push("--no-coms");
	if (options.browser) command.push("--browser");
	if (options.voice) command.push("--voice");
	if (options.allExtensions) command.push("--all-extensions");
	if (project !== DEFAULT_PROJECT) command.push("--project", project);
	return command;
}

export function conductorCommand(): string[] {
	return ["hermes", "-p", "dev"];
}

export function conductorSpec(
	backend: ConductorBackend,
	input: { repoRoot: string; project?: string },
): ConductorSpec {
	const repoRoot = validateAbsoluteRepoRoot(input.repoRoot);
	validateProject(input.project ?? DEFAULT_PROJECT);
	if (backend !== "hermes") {
		throw new Error(`Unknown conductor backend: ${JSON.stringify(backend)} (expected hermes)`);
	}
	return {
		backend,
		workspaceMode: "conductor-hermes",
		paneLabel: "conductor-hermes",
		command: conductorCommand(),
		cwd: repoRoot,
		env: {},
		displayText: "Hermes conductor; no herdr control",
	};
}
