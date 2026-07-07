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

export function teamWorkspaceLabel(kind: "peers" | "hub", team: string, project = DEFAULT_PROJECT): string {
	validateTeamName(team);
	validateProject(project);
	const prefix = kind === "hub" ? "pi-hub" : "pi-peers";
	return project === DEFAULT_PROJECT ? `${prefix}-${team}` : `${prefix}-${team}--project.${project}`;
}

export function hubCommand(project = DEFAULT_PROJECT): string[] {
	validateProject(project);
	return project === DEFAULT_PROJECT ? ["just", "hub"] : ["just", "hub", "--project", project];
}

export function teamSnapshotPath(snapshotDir: string, team: string, project = DEFAULT_PROJECT): string {
	validateTeamName(team);
	validateProject(project);
	return project === DEFAULT_PROJECT
		? path.join(snapshotDir, `${team}.json`)
		: path.join(snapshotDir, "projects", project, `${team}.json`);
}
