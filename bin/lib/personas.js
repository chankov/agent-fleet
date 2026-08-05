// personas.js — the canonical persona catalogue.
//
// `agents/*.md` is written in pi's own frontmatter dialect, so installing a
// persona is a plain file copy: source and target carry identical bytes.
// There is no per-agent frontmatter translation any more — the `transform-persona`
// CLI subcommand and its mapping table went away with Claude Code as an
// install target (docs/claude-code-coms-bridge.md explains what remains).
//
// Used by manifest.js to derive the `persona:*` items.

import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

/** Install path for a persona, relative to the workspace root. */
export function targetRelPath(name) {
  return join("agents", `${name}.md`);
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
