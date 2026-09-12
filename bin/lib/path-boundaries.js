// path-boundaries.js — the guard that makes a directory move finishable.
//
// Moving `scripts/`, `hermes/` and `hooks/` under `.pi/agent-fleet/` broke two
// classes of reference that nothing else in the repository was watching:
//
//   1. Relative import specifiers crossing the boundary. `.pi/harnesses/**`
//      does not move and imports into the fleet runtime that does. Those
//      imports are lazy — `just fleet` starts fine and the failure surfaces
//      only when an operator runs `/debate` or spawns a peer. `tsc` cannot
//      stand in for this: the harness packages are not installed at the
//      repository root, so its resolution errors are all about npm packages.
//
//   2. Workspace paths written as text — in the justfile, in the catalogue, in
//      agent-readable markdown. A stale path in a reference file never throws;
//      it just teaches the next agent to write to `agents/` again, and the
//      footprint grows back a session at a time.
//
// Both are pure functions over a file list so the test can state the rule and
// the CLI can reuse it.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";

/** Directories that no longer exist at a workspace root. */
export const RETIRED_ROOTS = Object.freeze(["scripts", "hermes", "hooks"]);

/** Where each retired root lives now — used only for the failure message. */
export const MOVED_TO = Object.freeze({
  scripts: ".pi/agent-fleet/scripts",
  hermes: ".pi/agent-fleet/hermes",
  hooks: ".pi/agent-fleet/hooks",
  agents: ".pi/agents/personas",
});

const SPECIFIER = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["'](\.\.?\/[^"']+)["']|new URL\(\s*["'](\.\.?[^"']*)["']/g;

/**
 * Relative specifiers in `source` that do not resolve to a file on disk.
 *
 * `.js` is accepted for a `.ts` file: that is the NodeNext spelling the
 * harnesses already use, and Node strips types at runtime.
 */
export function unresolvedSpecifiers({ root, file, source }) {
  const dir = dirname(join(root, file));
  const out = [];
  for (const match of source.matchAll(SPECIFIER)) {
    const spec = match[1] ?? match[2];
    const target = resolve(dir, spec);
    if (existsSync(target)) continue;
    if (target.endsWith(".js") && existsSync(`${target.slice(0, -3)}.ts`)) continue;
    out.push({ file, specifier: spec, resolved: relative(root, target) });
  }
  return out;
}

/**
 * Workspace-relative mentions of a retired root.
 *
 * Matched only at a path boundary, so a skill's own `scripts/` directory
 * (`skills/drafting-workflows/scripts/`), `.claude/hooks/` and the npm scope
 * `@hermes/plugin-sdk` are not hits.
 */
export function retiredRootMentions({ file, source, roots = RETIRED_ROOTS }) {
  const pattern = new RegExp(String.raw`(^|[^A-Za-z0-9_./\-@])(${roots.join("|")})/`, "gm");
  const out = [];
  source.split("\n").forEach((line, index) => {
    pattern.lastIndex = 0;
    for (const match of line.matchAll(pattern)) {
      out.push({ file, line: index + 1, root: match[2], text: line.trim().slice(0, 120) });
    }
  });
  return out;
}

/** Every `.md` file an item installs into a workspace, as repo-relative paths. */
export function installedMarkdown({ root, manifest, walk }) {
  const files = new Set();
  for (const item of manifest.items ?? []) {
    for (const binding of Object.values(item.agents ?? {})) {
      if (!binding.target) continue; // operator/external items install nothing
      for (const rel of binding.source ?? []) {
        const abs = join(root, rel);
        if (!existsSync(abs)) continue;
        if (rel.endsWith(".md")) { files.add(normalize(rel)); continue; }
        for (const leaf of walk(abs)) {
          if (leaf.endsWith(".md")) files.add(normalize(`${rel}/${leaf}`));
        }
      }
    }
  }
  return [...files].sort();
}

export function readSource(root, file) {
  return readFileSync(join(root, file), "utf8");
}
