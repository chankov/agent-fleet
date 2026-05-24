// Doctor scan — deterministic preflight extracted from
// guided-workspace-setup Step 5. Both `agent-skills doctor` (CLI) and the
// `/doctor-agent-skills` slash command call into this so behaviour cannot drift.
//
// Two classes of findings:
//   1. Broken symlinks — links whose source has been moved, renamed, or deleted
//   2. Stale persona refs — YAML configs (teams.yaml, agent-chain.yaml) that
//      still name a persona which no longer exists in the source tree
//
// For each broken link we look up a canonical replacement in the source
// `agents/` or `skills/` tree (many breakages are stale names from the
// pre-merge layout, e.g. `reviewer` → `code-reviewer`).

import { readdirSync, readlinkSync, existsSync, lstatSync, statSync, unlinkSync, symlinkSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, dirname, basename, relative, isAbsolute } from "node:path";

// Known canonical replacements for personas renamed during the merge.
const PERSONA_RENAMES = {
  "reviewer":      "code-reviewer",
  "red-team":      "security-auditor",
  "tester":        "test-engineer",
  "qa":            "test-engineer",
};

// Install-target directories the scanner walks, when present.
const TARGET_DIRS = [
  // Personas
  "agents",
  ".claude/agents",
  ".opencode/agents",
  ".codex/agents",
  ".gemini/agents",
  ".github/agents",
  ".pi/agents",
  ".pi/agents/pi-pi",
  // Skills
  ".claude/skills",
  ".opencode/skills",
  ".pi/skills",
  ".agents/skills",
  // Commands / prompts
  ".claude/commands",
  ".opencode/commands",
  ".pi/prompts",
  // References + hooks
  ".claude/references",
  ".claude/hooks",
];

// YAML configs that may reference persona names.
const YAML_REFS = [
  ".pi/agents/teams.yaml",
  ".pi/agents/agent-chain.yaml",
];

/**
 * Run the doctor scan.
 *
 * @param {object} opts
 * @param {string} opts.workspace  Workspace root (absolute path)
 * @param {string} opts.sourceRoot agent-skills source root (absolute path)
 * @param {boolean} [opts.apply]   If true, apply suggested fixes; otherwise just report
 * @returns {Array|object}         Findings array (apply=false) or {repaired,deleted,skipped} (apply=true)
 */
export async function runDoctor({ workspace, sourceRoot, apply = false }) {
  const findings = [];

  // 1. Broken symlinks in install-target directories.
  for (const rel of TARGET_DIRS) {
    const dir = join(workspace, rel);
    if (!existsSync(dir)) continue;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      let lst;
      try { lst = lstatSync(fullPath); } catch { continue; }
      if (!lst.isSymbolicLink()) continue;

      // Resolve where the link points.
      const linkTarget = readlinkSync(fullPath);
      const absTarget = isAbsolute(linkTarget)
        ? linkTarget
        : resolve(dirname(fullPath), linkTarget);

      if (existsSync(absTarget)) continue; // healthy link

      const replacement = findReplacement({
        brokenName: entry.name,
        kind:       inferKind(rel),
        sourceRoot,
      });

      findings.push({
        type: "broken-symlink",
        path: relative(workspace, fullPath),
        issue: `broken symlink → missing ${relative(workspace, absTarget)}`,
        fix: replacement
          ? `repoint to ${relative(workspace, join(sourceRoot, replacement))}`
          : "delete",
        replacement,
        absPath: fullPath,
      });
    }
  }

  // 2. Stale persona refs in YAML configs.
  for (const rel of YAML_REFS) {
    const file = join(workspace, rel);
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    for (const [stale, canonical] of Object.entries(PERSONA_RENAMES)) {
      // Match the persona name as a *standalone token* — bounded by
      // start-of-line, whitespace, quotes, or a YAML separator (:, [, ], ,).
      // Crucially, "-" must NOT count as a boundary, or we'd match
      // "reviewer" inside "code-reviewer".
      const re = new RegExp(
        `(^|[\\s'"\\[\\],:])${escapeRe(stale)}(?=[\\s'"\\[\\],:]|$)`,
        "gm",
      );
      if (re.test(text)) {
        findings.push({
          type: "stale-yaml-ref",
          path: relative(workspace, file),
          issue: `references "${stale}"`,
          fix: `rename to "${canonical}"`,
          stale,
          canonical,
          absPath: file,
        });
      }
    }
  }

  if (!apply) return findings;

  // ── Apply ──────────────────────────────────────────────────────────────
  let repaired = 0, deleted = 0, skipped = 0;

  for (const f of findings) {
    try {
      if (f.type === "broken-symlink") {
        if (f.replacement) {
          const newTarget = join(sourceRoot, f.replacement);
          unlinkSync(f.absPath);
          symlinkSync(newTarget, f.absPath);
          repaired++;
        } else {
          unlinkSync(f.absPath);
          deleted++;
        }
      } else if (f.type === "stale-yaml-ref") {
        const text = readFileSync(f.absPath, "utf8");
        const re = new RegExp(
          `(^|[\\s'"\\[\\],:])${escapeRe(f.stale)}(?=[\\s'"\\[\\],:]|$)`,
          "gm",
        );
        writeFileSync(f.absPath, text.replace(re, `$1${f.canonical}`));
        repaired++;
      }
    } catch (err) {
      skipped++;
      console.error(`  ⚠ skipped ${f.path}: ${err.message}`);
    }
  }

  return { repaired, deleted, skipped, findings };
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function inferKind(targetDir) {
  if (targetDir.includes("agents")) return "agents";
  if (targetDir.includes("skills")) return "skills";
  if (targetDir.includes("commands") || targetDir.includes("prompts")) return "commands";
  if (targetDir.includes("references")) return "references";
  if (targetDir.includes("hooks")) return "hooks";
  return null;
}

function findReplacement({ brokenName, kind, sourceRoot }) {
  // Strip .md if present so we can compare bare names.
  const bare = brokenName.replace(/\.md$/, "");

  // First check the known-renames map.
  const renamed = PERSONA_RENAMES[bare];
  if (renamed) {
    const candidate = kind === "skills"
      ? join("skills", renamed, "SKILL.md")
      : join("agents", `${renamed}.md`);
    if (existsSync(join(sourceRoot, candidate))) return candidate;
  }

  // Fall back: same name in the canonical source tree.
  if (kind === "agents") {
    const candidate = join("agents", `${bare}.md`);
    if (existsSync(join(sourceRoot, candidate))) return candidate;
  }
  if (kind === "skills") {
    const candidate = join("skills", bare, "SKILL.md");
    if (existsSync(join(sourceRoot, candidate))) return candidate;
  }

  return null;
}
