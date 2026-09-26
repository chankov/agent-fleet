// persona-dirs.ts — where a persona markdown file may live in a workspace.
//
// One list, imported by every persona lookup (the hub's scanAgentDirs, the
// peer launcher, the banner) so they cannot disagree about precedence:
//
//   agents/                 the user's own convention — wins, and is never
//   .claude/agents/         written by the installer
//   .pi/agents/personas/    where agent-fleet installs its 15 personas
//   .pi/agents/             hand-placed files beside the fleet YAML config
//
// The installer moved out of `agents/` so a workspace keeps a clean root; the
// first two entries stay because a project that writes its own personas there
// must keep overriding ours.

export const PERSONA_DIRS: readonly (readonly string[])[] = Object.freeze([
	Object.freeze(["agents"]),
	Object.freeze([".claude", "agents"]),
	Object.freeze([".pi", "agents", "personas"]),
	Object.freeze([".pi", "agents"]),
]);

/** The same list as workspace-relative POSIX paths, for messages and docs. */
export const PERSONA_DIR_PATHS: readonly string[] = Object.freeze(
	PERSONA_DIRS.map((parts) => `${parts.join("/")}/`),
);
