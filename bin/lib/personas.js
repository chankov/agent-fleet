// personas.js — the canonical persona catalogue.
//
// `agents/*.md` is written in pi's own frontmatter dialect, so installing a
// persona is a plain file copy: source and target carry identical bytes. The
// package keeps its own personas in `agents/`; a workspace receives them under
// `.pi/agents/personas/` so the repository root stays clean (the YAML fleet
// configuration owns `.pi/agents/` itself, hence the subdirectory).
// There is no per-agent frontmatter translation any more — the `transform-persona`
// CLI subcommand and its mapping table went away with Claude Code as an
// install target (docs/claude-code-coms-bridge.md explains what remains).
//
// Used by manifest.js to derive the `persona:*` items.

import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

/** Install path for a persona, relative to the workspace root. */
export function targetRelPath(name) {
  return join(".pi", "agents", "personas", `${name}.md`);
}

/**
 * Where the installer used to write this persona. Declared on every persona
 * binding so `verify` reports a surviving `agents/<name>.md` instead of letting
 * `scanAgentDirs` silently prefer it over the installed copy — it scans
 * `agents/` first and keeps the first definition per name.
 */
export function legacyTargetRelPaths(name) {
  return [join("agents", `${name}.md`)];
}

/**
 * Every persona in `<sourceRoot>/agents`, sorted by name.
 *
 * @param {string} sourceRoot  agent-fleet package root (absolute)
 * @returns {Array<{name: string, sourcePath: string, targetRelPath: string}>}
 */
export function listPersonas(sourceRoot) {
  const dir = join(sourceRoot, "agents");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""))
    .sort()
    .map((name) => ({
      name,
      sourcePath: join(dir, `${name}.md`),
      targetRelPath: targetRelPath(name),
    }));
}
