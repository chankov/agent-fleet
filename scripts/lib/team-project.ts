// scripts/lib/team-project.ts
//
// Shared project scoping helpers for herdr team commands. The coms harness
// already isolates peers by --project; this file only keeps team workspace
// labels, snapshot files, and generated launch argv in sync with that scope.

import * as path from "node:path";

export const DEFAULT_PROJECT = "default";

// Conservative project names: no empty string, path separators, traversal,
// whitespace, shell metacharacters, or glob stars. Dots are allowed for names
// like "acme.prod", but ".." is not allowed anywhere.
export const PROJECT_SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const TEAM_SAFE = /^[A-Za-z0-9_-]+$/;

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

export function validateTeamName(team: string): string {
	if (!TEAM_SAFE.test(team)) throw new Error(`Invalid team name: ${JSON.stringify(team)}`);
	return team;
}

// The worktree/repo identity that scopes a workspace label so the same team
// launched from different checkouts never collides. It is the LAST dot-segment
// of the checkout directory's basename — the convention the fleet uses for
// git worktrees: `main.wt2` → `wt2`, `ringithub.end2` → `end2`, a plain
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

// Workspace label = <worktree-tag>-<mode>-<team>, with a `--project.<name>`
// suffix when the coms project is non-default. The worktree tag keys the label
// to the checkout, so `just hub-team <team>` from two repos/worktrees yields
// distinct labels (e.g. `wt2-hub-plan` vs `end2-hub-plan`) instead of colliding
// on a shared `pi-hub-<team>`. Pass `tag` from worktreeTag(REPO_ROOT); it
// defaults to "repo" only for callers that have no checkout in hand.
export function teamWorkspaceLabel(
	kind: "peers" | "hub" | "conductor",
	team: string,
	project = DEFAULT_PROJECT,
	tag = "repo",
): string {
	validateTeamName(team);
	validateProject(project);
	const base = `${tag}-${kind}-${team}`;
	return project === DEFAULT_PROJECT ? base : `${base}--project.${project}`;
}

export function hubCommand(project = DEFAULT_PROJECT): string[] {
	validateProject(project);
	return project === DEFAULT_PROJECT ? ["just", "hub"] : ["just", "hub", "--project", project];
}

export function conductorCommand(): string[] {
	return ["hermes", "-p", "dev"];
}

export function teamSnapshotPath(snapshotDir: string, team: string, project = DEFAULT_PROJECT): string {
	validateTeamName(team);
	validateProject(project);
	return project === DEFAULT_PROJECT
		? path.join(snapshotDir, `${team}.json`)
		: path.join(snapshotDir, "projects", project, `${team}.json`);
}
