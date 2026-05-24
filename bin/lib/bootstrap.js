// bootstrap.js — drop the minimum installer artifacts a coding agent needs
// to recognize `/setup-agent-skills` and `/doctor-agent-skills`.
//
// The CLI's `init` calls this before the handoff message. Without it, a
// fresh workspace has no `.claude/commands/setup-agent-skills.md`, `.pi/prompts/setup-agent-skills.md`,
// etc., so the agent has no idea what `/setup-agent-skills` is and the whole hand-off
// breaks silently.
//
// What we bootstrap (per agent):
//   - The `setup` slash command (so the user can invoke it)
//   - The `doctor` slash command (same)
//   - The `guided-workspace-setup` skill body (the slash command says
//     "load this skill" — the skill must be present somewhere the agent
//     auto-discovers)
//
// What we do NOT bootstrap:
//   - Any of the user-facing skills (spec-driven-development,
//     test-driven-development, …). Those are picked by the user inside
//     /setup-agent-skills, by design. The CLI never decides the workspace's catalogue
//     for the user.
//
// Method:
//   `copy`    — safe default; works for npx caches that may be cleaned
//   `symlink` — leaner; only safe when the source root is stable
//               (global install / git clone). Warning printed if the
//               source path looks like an npx cache.

import { existsSync, mkdirSync, copyFileSync, symlinkSync, unlinkSync, lstatSync, rmSync, readdirSync, rmdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

// Marker file the skill reads to find the authoritative source root. Written
// by bootstrap, deleted by cleanupInstaller. Without this, the skill would
// have to guess the source root from its own SKILL.md location — but bootstrap
// copies SKILL.md into the workspace, so that heuristic always lies.
const BOOTSTRAP_MARKER = join(".ai", ".agent-skills-bootstrap.json");

function writeMarker({ workspace, sourceRoot, agent, method }) {
  const path = join(workspace, BOOTSTRAP_MARKER);
  const version = readPackageVersion(sourceRoot);
  const payload = {
    sourceRoot,
    version,
    agent,
    method,
    bootstrappedAt: new Date().toISOString(),
    _comment: "Written by `npx @chankov/agent-skills init`. Read by the guided-workspace-setup skill to locate the source package. Safe to delete; will be regenerated on next init.",
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(payload, null, 2) + "\n", "utf8");
  return path;
}

function readPackageVersion(sourceRoot) {
  try {
    const pkg = JSON.parse(readFileSync(join(sourceRoot, "package.json"), "utf8"));
    return pkg.version;
  } catch { return null; }
}

// (agent → list of {kind, src, dest}) — kind is just for the report.
//
// All installer slash commands are namespaced with `-agent-skills` so they
// don't collide with workspace-defined or other-tool slash commands. The
// short names (setup, doctor, as-setup, as-doctor) were used in 0.2.0 and
// earlier — cleanupLegacyNames() removes those if found.
function plan({ agent, sourceRoot, workspace }) {
  const skillSrc = join(sourceRoot, "skills", "guided-workspace-setup", "SKILL.md");

  switch (agent) {
    case "claude-code":
      return [
        { kind: "command", src: join(sourceRoot, ".claude/commands/setup-agent-skills.md"),
          dest: join(workspace, ".claude/commands/setup-agent-skills.md") },
        { kind: "command", src: join(sourceRoot, ".claude/commands/doctor-agent-skills.md"),
          dest: join(workspace, ".claude/commands/doctor-agent-skills.md") },
        { kind: "skill",   src: skillSrc,
          dest: join(workspace, ".claude/skills/guided-workspace-setup/SKILL.md") },
      ];

    case "pi":
      return [
        { kind: "prompt", src: join(sourceRoot, ".pi/prompts/setup-agent-skills.md"),
          dest: join(workspace, ".pi/prompts/setup-agent-skills.md") },
        { kind: "prompt", src: join(sourceRoot, ".pi/prompts/doctor-agent-skills.md"),
          dest: join(workspace, ".pi/prompts/doctor-agent-skills.md") },
        // pi auto-discovers skills from .pi/skills/ and .agents/skills/ —
        // we use .pi/skills/ to avoid polluting a shared .agents/ dir if
        // the user has other tools there.
        { kind: "skill",  src: skillSrc,
          dest: join(workspace, ".pi/skills/guided-workspace-setup/SKILL.md") },
      ];

    case "opencode":
      // OpenCode discovers skills + commands from ~/.config/opencode/ (global)
      // and references AGENTS.md. A project-local bootstrap is awkward — we
      // drop the command file into .opencode/commands/ (which OpenCode does
      // load from the project) and the skill alongside it, then flag the
      // AGENTS.md gap for the user.
      return [
        { kind: "command", src: join(sourceRoot, ".opencode/commands/as-setup-agent-skills.md"),
          dest: join(workspace, ".opencode/commands/as-setup-agent-skills.md") },
        { kind: "command", src: join(sourceRoot, ".opencode/commands/as-doctor-agent-skills.md"),
          dest: join(workspace, ".opencode/commands/as-doctor-agent-skills.md") },
        { kind: "skill",   src: skillSrc,
          dest: join(workspace, ".opencode/skills/guided-workspace-setup/SKILL.md") },
      ];

    default:
      throw new Error(`bootstrap: unknown agent "${agent}"`);
  }
}

// Files that were the bootstrap targets in 0.2.0 and earlier (pre-rename).
// Removed during bootstrap so a workspace upgraded from 0.2.0 doesn't end
// up with both the old and new slash commands.
function legacyPaths({ agent, workspace }) {
  switch (agent) {
    case "claude-code":
      return [
        join(workspace, ".claude/commands/setup.md"),
        join(workspace, ".claude/commands/doctor.md"),
      ];
    case "pi":
      return [
        join(workspace, ".pi/prompts/setup.md"),
        join(workspace, ".pi/prompts/doctor.md"),
      ];
    case "opencode":
      return [
        join(workspace, ".opencode/commands/as-setup.md"),
        join(workspace, ".opencode/commands/as-doctor.md"),
      ];
    default:
      return [];
  }
}

/**
 * Run the bootstrap.
 *
 * @param {object} opts
 * @param {string} opts.agent       claude-code | opencode | pi
 * @param {string} opts.sourceRoot  Absolute path to the installed package
 * @param {string} opts.workspace   Absolute path to the target workspace
 * @param {"copy"|"symlink"} opts.method
 * @param {boolean} [opts.dryRun]
 * @returns {{written:Array, skipped:Array, warnings:Array}}
 */
export function bootstrap({ agent, sourceRoot, workspace, method, dryRun = false }) {
  const items = plan({ agent, sourceRoot, workspace });
  const written = [], skipped = [], removed = [], warnings = [];

  // Warn if the user asked for symlink against an unstable source.
  if (method === "symlink" && /\/\.npm\/_npx\//.test(sourceRoot)) {
    warnings.push(
      "--method symlink against an npx cache path: links will break when " +
      "the cache is cleaned. Consider --method copy or install globally " +
      "with `npm install -g @chankov/agent-skills`.",
    );
  }

  // Clean up pre-0.3.0 file names if present — they were renamed to
  // *-agent-skills so they don't collide with other slash commands.
  for (const oldPath of legacyPaths({ agent, workspace })) {
    if (!existsSync(oldPath) && !isSymlink(oldPath)) continue;
    if (dryRun) {
      removed.push(oldPath);
      continue;
    }
    try {
      unlinkSync(oldPath);
      removed.push(oldPath);
    } catch (err) {
      warnings.push(`could not remove legacy file ${relative(workspace, oldPath)}: ${err.message}`);
    }
  }

  for (const item of items) {
    if (!existsSync(item.src)) {
      warnings.push(`missing source: ${relative(sourceRoot, item.src)} (skipping ${item.kind})`);
      continue;
    }

    if (dryRun) {
      written.push({ ...item, method });
      continue;
    }

    try {
      mkdirSync(dirname(item.dest), { recursive: true });

      // Always replace — the bootstrap is installer scaffolding, not user
      // data. If we left it stale, an upgraded package would still hand off
      // to the old /setup-agent-skills command. Step 6 of guided-workspace-setup explicitly
      // never offers these files in the install menu, so we are the only
      // mechanism that refreshes them.
      if (existsSync(item.dest) || isSymlink(item.dest)) {
        unlinkSync(item.dest);
      }

      if (method === "symlink") {
        symlinkSync(item.src, item.dest);
      } else {
        // copyFileSync handles plain files; for the SKILL.md case the source
        // may have sibling support files in some skills — but
        // guided-workspace-setup is a single-file skill, so copyFileSync is
        // fine. Switch to cpSync if that ever changes.
        copyFileSync(item.src, item.dest);
      }
      written.push({ ...item, method });
    } catch (err) {
      skipped.push({ ...item, error: err.message });
    }
  }

  // Write the marker file as the LAST step — only after all the bootstrap
  // files landed successfully. If the marker exists, the skill trusts it
  // absolutely; if it does not, the skill falls back to safer paths.
  if (!dryRun && written.length > 0) {
    try {
      const markerPath = writeMarker({ workspace, sourceRoot, agent, method });
      written.push({ kind: "marker", dest: markerPath, method: "write" });
    } catch (err) {
      warnings.push(`could not write bootstrap marker: ${err.message}`);
    }
  } else if (dryRun) {
    written.push({ kind: "marker", dest: join(workspace, BOOTSTRAP_MARKER), method: "write" });
  }

  return { written, skipped, removed, warnings };
}

/**
 * Remove every bootstrap artifact this module knows how to write. Called
 * by guided-workspace-setup at the end of Step 10 unless the user chose
 * to keep the installer commands. After cleanup, the only way back to
 * /setup-agent-skills is to re-run `npx @chankov/agent-skills init`.
 *
 * The same `agent` value must be supplied that was used at bootstrap time —
 * we don't have a tracking file, so we delete based on the plan map.
 *
 * @param {object} opts
 * @param {string} opts.agent
 * @param {string} opts.workspace
 * @param {boolean} [opts.dryRun]
 * @returns {{removed:string[], kept:string[], warnings:string[]}}
 */
export function cleanupInstaller({ agent, workspace, dryRun = false }) {
  const planned = plan({ agent, sourceRoot: workspace, workspace });
  const removed = [], kept = [], warnings = [];

  // Marker file goes too — it pointed at a source root that no longer
  // matters once the install is done.
  const markerPath = join(workspace, BOOTSTRAP_MARKER);
  if (existsSync(markerPath)) {
    if (dryRun) {
      removed.push(markerPath);
    } else {
      try { unlinkSync(markerPath); removed.push(markerPath); }
      catch (err) { warnings.push(`could not remove ${relative(workspace, markerPath)}: ${err.message}`); }
    }
  }

  for (const item of planned) {
    if (!existsSync(item.dest) && !isSymlink(item.dest)) {
      kept.push(item.dest); // already gone — count it as a no-op, not an error
      continue;
    }
    if (dryRun) {
      removed.push(item.dest);
      continue;
    }
    try {
      const lst = lstatSync(item.dest);
      if (lst.isDirectory() && !lst.isSymbolicLink()) {
        rmSync(item.dest, { recursive: true });
      } else {
        unlinkSync(item.dest);
      }
      removed.push(item.dest);

      // If we removed the only file in a parent directory we created
      // (.claude/skills/guided-workspace-setup/), prune the directory too.
      pruneEmptyDirsUpTo(dirname(item.dest), workspace);
    } catch (err) {
      warnings.push(`could not remove ${relative(workspace, item.dest)}: ${err.message}`);
    }
  }

  return { removed, kept, warnings };
}

function pruneEmptyDirsUpTo(dir, workspace) {
  // Walk upward removing empty parent dirs until we hit a non-empty one or
  // the workspace root. Never delete the workspace itself.
  try {
    while (dir !== workspace && dir.startsWith(workspace)) {
      const entries = readdirSync(dir);
      if (entries.length > 0) return;
      rmdirSync(dir);
      dir = dirname(dir);
    }
  } catch { /* prune is best-effort */ }
}

function isSymlink(path) {
  try { return lstatSync(path).isSymbolicLink(); }
  catch { return false; }
}
