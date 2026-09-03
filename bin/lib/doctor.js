// Doctor scan — deterministic preflight extracted from
// Both `agent-fleet doctor` (CLI) and the
// Runtime-specific Agent Fleet doctor slash commands call into this so behaviour cannot drift.
//
// Finding classes:
//   1. Broken symlinks — links whose source has been moved, renamed, or deleted
//   2. Stale persona refs — YAML configs (teams.yaml, peers.yaml) that
//      still name a persona which no longer exists in the source tree
//   3. Malformed peer entries — field lines in peers.yaml that sit under a
//      team before any `- name: ...` list item. The team-up launcher's
//      minimal parser silently drops such lines, so the peer vanishes with
//      no error. Advisory only: the fix is a hand edit.
//   4. Overrides-file problems — unknown sections/keys, invalid values, and
//      unset declared env vars in .ai/agent-fleet-overrides.md. Advisory
//      only: reported, never auto-fixed (the fix is always a hand edit).
//   5. Mixed skill/prompt ownership — project/global Pi settings enable
//      `@chankov/agent-fleet` skills/prompts while `.ai/agent-fleet-state.json`
//      also owns matching copied `skill:*` / `command:*` items. Advisory only:
//      package vs copy ownership is a user choice; doctor --fix never mutates it.
//   6. Model visibility — persona, delegate sub-role, and voices.yaml models
//      that a clean-room `pi --no-extensions` child cannot see. Read-only:
//      never auto-fixed. A missing voices.yaml is not a finding.
//
// For each broken link we look up a canonical replacement in the source
// `agents/` or `skills/` tree (many breakages are stale names from the
// pre-merge layout, e.g. `reviewer` → `code-reviewer`).

import { readdirSync, readlinkSync, existsSync, lstatSync, statSync, unlinkSync, symlinkSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, dirname, basename, relative, isAbsolute, sep } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";
import { validateOverrides } from "./validate-overrides.js";
import { readState, STATE_REL_PATH } from "./state.js";

export const AGENT_FLEET_PACKAGE_NAME = "@chankov/agent-fleet";
const AGENT_FLEET_PACKAGE_PATTERN = /(^|[/:])@chankov\/agent-fleet(@[^/]*)?$/;

// Known canonical replacements for personas renamed during the merge.
const PERSONA_RENAMES = {
  "reviewer":      "code-reviewer",
  "red-team":      "security-auditor",
  "tester":        "test-engineer",
  "qa":            "test-engineer",
};

// Install-target directories the scanner walks, when present.
//
// `.claude/hooks` is the odd one out and belongs here on purpose: the coms
// bridge's Stop hook is the one artifact pi installs into a Claude Code
// directory, because the pane reading it is a Claude Code process
// (docs/claude-code-coms-bridge.md).
const TARGET_DIRS = [
  // Personas
  "agents",
  ".pi/agents",
  // Skills
  ".pi/skills",
  ".agents/skills",
  // Prompts
  ".pi/prompts",
  // References + coms bridge hook
  ".pi/references",
  ".claude/hooks",
];

// YAML configs that may reference persona names.
const YAML_REFS = [
  ".pi/agents/teams.yaml",
  ".pi/agents/peers.yaml",
];

/**
 * Run the doctor scan.
 *
 * @param {object} opts
 * @param {string} opts.workspace  Workspace root (absolute path)
 * @param {string} opts.sourceRoot agent-fleet source root (absolute path)
 * @param {boolean} [opts.apply]   If true, apply suggested fixes; otherwise just report
 * @returns {Array|object}         Findings array (apply=false) or {repaired,deleted,skipped} (apply=true)
 */
export async function runDoctor({ workspace, sourceRoot, apply = false, checkVisibility } = {}) {
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

  // 3. Malformed peer entries in peers.yaml (advisory, never auto-fixed).
  findings.push(...scanPeersYamlShape(workspace));

  // 4. Advisory validation of the overrides file (never auto-fixed).
  findings.push(...validateOverrides({ workspace }));

  // 5. Mixed copied / package-native skill+prompt ownership (advisory, never auto-fixed).
  findings.push(...scanPiPackageOwnership({ workspace, sourceRoot }));

  // 6. Model visibility for roster personas, delegate sub-roles, and voices.yaml.
  findings.push(...await scanModelVisibility({ workspace, checkVisibility }));

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

// Scan peers.yaml for field lines that sit under a team heading before any
// `- name: ...` list item. scripts/team-up.ts parses this file with a minimal
// hand-rolled parser that only attaches `key: value` lines to the CURRENT list
// item — an orphan field block (typically a peer whose leading `- name:` line
// was lost in an edit) is dropped without an error and the peer silently
// never spawns. One finding per team, pointing at the first orphan line.
const PEERS_YAML_REL = ".pi/agents/peers.yaml";

function scanPeersYamlShape(workspace) {
  const file = join(workspace, PEERS_YAML_REL);
  if (!existsSync(file)) return [];
  let text;
  try { text = readFileSync(file, "utf8"); } catch { return []; }

  const findings = [];
  let currentTeam = null;
  let inItem = false;
  let reportedTeam = null;

  text.split("\n").forEach((rawLine, i) => {
    const line = rawLine.replace(/\s+$/, "");
    if (line.trim() === "" || /^\s*#/.test(line)) return;
    const content = line.trim();

    if (!/^\s/.test(line)) {
      const m = content.match(/^([A-Za-z0-9_-]+):\s*$/);
      if (m) {
        currentTeam = m[1];
        inItem = false;
        reportedTeam = null;
      }
      return;
    }
    if (!currentTeam) return;

    if (/^-\s/.test(content)) {
      inItem = true;
      return;
    }
    if (!inItem && /^[A-Za-z0-9_]+:\s*\S/.test(content) && reportedTeam !== currentTeam) {
      reportedTeam = currentTeam;
      findings.push({
        type: "yaml-shape",
        path: PEERS_YAML_REL,
        issue: `team "${currentTeam}": line ${i + 1} ("${content}") appears before any "- name: ..." item — the team-up launcher silently drops it`,
        fix: `add the missing "- name: <peer>" line above it in ${PEERS_YAML_REL}`,
      });
    }
  });

  return findings;
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

  // Skills resolve against both roots; the fleet-native tree shadows the
  // vendored upstream import (see docs/UPSTREAM-SKILLS.md).
  const skillRoots = ["skills", join("vendor", "agent-skills-upstream", "skills")];

  // First check the known-renames map.
  const renamed = PERSONA_RENAMES[bare];
  if (renamed) {
    if (kind === "skills") {
      for (const root of skillRoots) {
        const candidate = join(root, renamed, "SKILL.md");
        if (existsSync(join(sourceRoot, candidate))) return candidate;
      }
    } else {
      const candidate = join("agents", `${renamed}.md`);
      if (existsSync(join(sourceRoot, candidate))) return candidate;
    }
  }

  // Fall back: same name in the canonical source tree.
  if (kind === "agents") {
    const candidate = join("agents", `${bare}.md`);
    if (existsSync(join(sourceRoot, candidate))) return candidate;
  }
  if (kind === "skills") {
    for (const root of skillRoots) {
      const candidate = join(root, bare, "SKILL.md");
      if (existsSync(join(sourceRoot, candidate))) return candidate;
    }
  }

  return null;
}

// ── mixed copied / package-native ownership ─────────────────────────────────

/**
 * Parse a Pi settings `packages` entry into a normalized source + filters shape.
 * String entries enable every resource type. Object entries follow Pi filter rules:
 * omit a key to load all of that type, `[]` loads none, patterns narrow the set.
 *
 * @param {unknown} entry
 * @returns {{ source: string, filters: { skills?: unknown, prompts?: unknown, extensions?: unknown, themes?: unknown }, raw: unknown } | null}
 */
export function parsePiPackageEntry(entry) {
  if (typeof entry === "string" && entry.trim()) {
    return { source: entry.trim(), filters: {}, raw: entry };
  }
  if (entry && typeof entry === "object" && typeof entry.source === "string" && entry.source.trim()) {
    return {
      source: entry.source.trim(),
      filters: {
        skills: entry.skills,
        prompts: entry.prompts,
        extensions: entry.extensions,
        themes: entry.themes,
      },
      raw: entry,
    };
  }
  return null;
}

/** True when a package source refers to `@chankov/agent-fleet` (npm identity, optional pin). */
export function isAgentFleetPackageSource(source) {
  if (typeof source !== "string") return false;
  return AGENT_FLEET_PACKAGE_PATTERN.test(source.trim());
}

/**
 * Resolve the effective Agent Fleet package entry across project then global
 * settings. Project wins unless it sets `autoload: false` (Pi delta semantics):
 * in that case the project filters layer over the global entry.
 *
 * @param {object} opts
 * @param {string} opts.workspace
 * @param {string} [opts.home]
 * @returns {{ entry: ReturnType<typeof parsePiPackageEntry>, settingsPath: string } | null}
 */
export function findAgentFleetPackageEntry({ workspace, home = homedir() }) {
  const projectPath = join(workspace, ".pi", "settings.json");
  const globalPath = join(home, ".pi", "agent", "settings.json");
  const project = readPackageEntries(projectPath).find((e) => isAgentFleetPackageSource(e.source)) ?? null;
  const global = readPackageEntries(globalPath).find((e) => isAgentFleetPackageSource(e.source)) ?? null;

  if (project) {
    const autoload = project.raw && typeof project.raw === "object" ? project.raw.autoload : undefined;
    if (autoload === false && global) {
      return {
        entry: {
          source: project.source,
          filters: { ...global.filters, ...project.filters },
          raw: project.raw,
        },
        settingsPath: projectPath,
      };
    }
    return { entry: project, settingsPath: projectPath };
  }
  if (global) return { entry: global, settingsPath: globalPath };
  return null;
}

function readPackageEntries(settingsPath) {
  if (!existsSync(settingsPath)) return [];
  let packages;
  try {
    packages = JSON.parse(readFileSync(settingsPath, "utf8"))?.packages;
  } catch {
    return [];
  }
  if (!Array.isArray(packages)) return [];
  return packages.map(parsePiPackageEntry).filter(Boolean);
}

/**
 * Decide whether a resource type is enabled by a package filter.
 * Omit/undefined → all; empty array → none; non-empty → treated as enabled
 * (name-level filter matching is applied later against concrete names).
 */
export function resourceTypeEnabled(filter) {
  if (filter === undefined) return true;
  if (!Array.isArray(filter)) return true;
  return filter.length > 0;
}

/**
 * Whether a concrete resource name survives the package filter list.
 * Patterns are basename / relative-path globs simplified to:
 * - exact name or path segment match
 * - `!name` / `!path` exclusions
 * - `*` wildcards via simple glob → RegExp
 * Empty/omitted filter admits every name.
 */
export function resourceNameAllowed(name, filter) {
  if (filter === undefined) return true;
  if (!Array.isArray(filter)) return true;
  if (filter.length === 0) return false;

  let allowed = false;
  let sawPositive = false;
  for (const raw of filter) {
    if (typeof raw !== "string" || !raw) continue;
    const negated = raw.startsWith("!") || raw.startsWith("-");
    const pattern = negated ? raw.slice(1) : raw.startsWith("+") ? raw.slice(1) : raw;
    const matches = matchResourcePattern(name, pattern);
    if (negated) {
      if (matches) allowed = false;
      continue;
    }
    sawPositive = true;
    if (matches) allowed = true;
  }
  // Pi: a filter list of only exclusions still starts from the full set.
  if (!sawPositive) return allowed !== false ? true : false;
  return allowed;
}

function matchResourcePattern(name, pattern) {
  const base = basename(pattern).replace(/\/+$/, "");
  const bare = base.replace(/\.md$/i, "");
  if (bare === name || base === name || pattern === name) return true;
  // Path-ish patterns: skills/foo or prompts/af-build.md
  if (pattern.includes(name)) return true;
  if (!pattern.includes("*") && !pattern.includes("?")) return false;
  const re = new RegExp(
    `^${escapeRe(pattern).replaceAll("\\*", ".*").replaceAll("\\?", ".")}$`,
    "i",
  );
  return re.test(name) || re.test(base) || re.test(pattern);
}

/** Skill directory names the Agent Fleet package exposes via its pi manifest. */
export function listPackageSkillNames(sourceRoot) {
  const roots = [
    join(sourceRoot, "skills"),
    join(sourceRoot, "vendor", "agent-skills-upstream", "skills"),
    join(sourceRoot, ".pi", "skills"),
  ];
  const names = new Set();
  for (const root of roots) {
    if (!existsSync(root)) continue;
    let entries;
    try { entries = readdirSync(root, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      if (existsSync(join(root, entry.name, "SKILL.md"))) names.add(entry.name);
    }
  }
  return [...names].sort();
}

/** Prompt template basenames (no `.md`) the package exposes. */
export function listPackagePromptNames(sourceRoot) {
  const dir = join(sourceRoot, ".pi", "prompts");
  if (!existsSync(dir)) return [];
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch { return []; }
  return entries
    .filter((e) => (e.isFile() || e.isSymbolicLink()) && e.name.endsWith(".md"))
    .map((e) => e.name.replace(/\.md$/i, ""))
    .sort();
}

/**
 * Names of copied skills/prompts owned by the workspace state file.
 * Skills use the `skill:<name>` id; prompts are taken from recorded file paths
 * under `.pi/prompts/` so they match Pi's template names (`af-build`, …).
 */
export function listCopiedSkillAndPromptNames(state) {
  const skills = new Set();
  const prompts = new Set();
  if (!state?.items || typeof state.items !== "object") return { skills, prompts };

  for (const [id, item] of Object.entries(state.items)) {
    if (id.startsWith("skill:")) {
      skills.add(id.slice("skill:".length));
      continue;
    }
    if (id.startsWith("pi-runtime-skill:")) {
      skills.add(id.slice("pi-runtime-skill:".length));
      continue;
    }
    if (!id.startsWith("command:")) continue;
    for (const file of item?.files ?? []) {
      const rel = typeof file === "string" ? file : file?.path;
      if (typeof rel !== "string") continue;
      const normalized = rel.split(sep).join("/");
      const m = normalized.match(/(?:^|\/)\.pi\/prompts\/([^/]+)\.md$/i);
      if (m) prompts.add(m[1]);
    }
    // Fall back to sourceRoot on older state shapes.
    if (typeof item?.sourceRoot === "string") {
      const m = item.sourceRoot.split(sep).join("/").match(/(?:^|\/)\.pi\/prompts\/([^/]+)\.md$/i);
      if (m) prompts.add(m[1]);
    }
  }
  return { skills, prompts };
}

/**
 * Advisory finding when package-native Agent Fleet skills/prompts overlap
 * copied install items. Never auto-fixed — the user must pick one ownership path.
 */
export function scanPiPackageOwnership({ workspace, sourceRoot, home = homedir() }) {
  const located = findAgentFleetPackageEntry({ workspace, home });
  if (!located) return [];

  const skillsEnabled = resourceTypeEnabled(located.entry.filters.skills);
  const promptsEnabled = resourceTypeEnabled(located.entry.filters.prompts);
  if (!skillsEnabled && !promptsEnabled) return [];

  const state = readState(workspace);
  if (!state) return [];
  const copied = listCopiedSkillAndPromptNames(state);

  const packageSkills = skillsEnabled
    ? listPackageSkillNames(sourceRoot).filter((name) => resourceNameAllowed(name, located.entry.filters.skills))
    : [];
  const packagePrompts = promptsEnabled
    ? listPackagePromptNames(sourceRoot).filter((name) => resourceNameAllowed(name, located.entry.filters.prompts))
    : [];

  const skillOverlap = packageSkills.filter((name) => copied.skills.has(name)).sort();
  const promptOverlap = packagePrompts.filter((name) => copied.prompts.has(name)).sort();
  if (skillOverlap.length === 0 && promptOverlap.length === 0) return [];

  const parts = [];
  if (skillOverlap.length) parts.push(`skills: ${skillOverlap.join(", ")}`);
  if (promptOverlap.length) parts.push(`prompts: ${promptOverlap.join(", ")}`);

  return [{
    type: "pi-package-ownership",
    path: STATE_REL_PATH,
    issue:
      `mixed ownership — Pi package "${located.entry.source}" (from ${relative(workspace, located.settingsPath) || located.settingsPath}) ` +
      `and copied Agent Fleet items both expose ${parts.join("; ")}. Pi keeps the first discovery and warns on collisions.`,
    fix:
      "pick one ownership path: (1) copied skills/prompts — disable Agent Fleet package skills/prompts " +
      "(`pi config`, or object-form filters with `\"skills\": []`, `\"prompts\": []`) and keep harnesses; " +
      "or (2) package-native skills/prompts — `agent-fleet uninstall` the overlapping skill:*/command:* items " +
      "and keep the Pi package entry. Harness-only composition (package skills + copied harnesses) is safe.",
    skillOverlap,
    promptOverlap,
    packageSource: located.entry.source,
    settingsPath: located.settingsPath,
  }];
}

const AGENT_DIRS = ["agents", ".claude/agents", ".pi/agents"];
const VOICES_REL = ".pi/agents/voices.yaml";

/**
 * Models the clean-room child must be able to see: each persona's primary model,
 * each declared delegate sub-role, and every voice in voices.yaml (when present).
 */
export function collectModelTargets(workspace) {
  const targets = [];
  for (const rel of AGENT_DIRS) {
    const dir = join(workspace, rel);
    if (!existsSync(dir)) continue;
    let entries;
    try { entries = readdirSync(dir); } catch { continue; }
    for (const file of entries) {
      if (!file.endsWith(".md")) continue;
      const abs = join(dir, file);
      try { targets.push(...parsePersonaModelTargets(abs, `${rel}/${file}`)); }
      catch { /* unreadable persona is not a visibility finding */ }
    }
  }
  targets.push(...collectVoiceTargets(workspace));
  return targets;
}

function collectVoiceTargets(workspace) {
  const file = join(workspace, VOICES_REL);
  if (!existsSync(file)) return [];
  let raw;
  try { raw = parseYaml(readFileSync(file, "utf8")); } catch { return []; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const targets = [];
  for (const [panel, list] of Object.entries(raw)) {
    if (!Array.isArray(list)) continue;
    for (const voice of list) {
      if (!voice || typeof voice !== "object" || typeof voice.name !== "string" || typeof voice.model !== "string") continue;
      targets.push({ kind: "voice", subject: `${panel}/${voice.name}`, model: voice.model, path: VOICES_REL });
    }
  }
  return targets;
}

function parsePersonaModelTargets(absPath, relPath) {
  const raw = readFileSync(absPath, "utf8");
  const match = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return [];
  const lines = match[1].split("\n");
  let name, model;
  const subagents = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const idx = line.indexOf(":");
    if (idx <= 0 || /^\s/.test(line)) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key === "name" && value) name = value;
    else if (key === "model" && value) model = value;
    else if (key === "subagents") {
      let currentRole = null;
      let roleIndent = -1;
      let j = i + 1;
      while (j < lines.length) {
        const found = lines[j].match(/^(\s+)([a-z0-9]+(?:-[a-z0-9]+)*)\s*:\s*(.*)$/);
        if (!found) break;
        const indent = found[1].length;
        if (roleIndent === -1) roleIndent = indent;
        if (indent < roleIndent) break;
        if (indent === roleIndent) {
          currentRole = found[2];
          const inline = found[3].trim();
          let roleModel;
          if (inline.startsWith("{")) roleModel = inline.match(/model\s*:\s*([^\s,}]+)/)?.[1];
          else if (inline) roleModel = inline.split(",")[0].trim();
          if (roleModel) subagents.push({ role: currentRole, model: roleModel });
        } else if (currentRole && found[2] === "model" && found[3].trim()) {
          subagents.push({ role: currentRole, model: found[3].trim() });
        }
        j++;
      }
      i = j - 1;
    }
  }
  if (!name) return [];
  const targets = [];
  if (model) targets.push({ kind: "persona", subject: name, model, path: relPath });
  for (const entry of subagents) {
    targets.push({ kind: "subagent", subject: `${name}/${entry.role}`, model: entry.model, path: relPath });
  }
  return targets;
}

function subjectLabel(target) {
  if (target.kind === "voice") return `voice "${target.subject}"`;
  if (target.kind === "subagent") return `subagent "${target.subject}"`;
  return `persona "${target.subject}"`;
}

export async function scanModelVisibility({ workspace, checkVisibility } = {}) {
  const targets = collectModelTargets(workspace);
  if (targets.length === 0) return [];
  let check = checkVisibility;
  if (!check) {
    const mod = await import("./model-visibility.js");
    check = (models) => mod.checkChildVisibility(models);
  }
  const unique = [...new Set(targets.map((target) => target.model))];
  const report = check(unique);
  if (report?.diagnostic) {
    return [{
      type: "model-visibility",
      path: ".",
      issue: `model-visibility listing failed — ${report.diagnostic}`,
      fix: "ensure `pi --no-extensions --list-models` runs in this workspace",
      check: "child-visible",
    }];
  }
  const byModel = new Map((report?.models ?? []).map((item) => [item.model, item]));
  const findings = [];
  for (const target of targets) {
    const result = byModel.get(target.model);
    if (!result || result.ok) continue;
    const checkName = result.failed?.[0] ?? "child-visible";
    findings.push({
      type: "model-visibility",
      path: target.path,
      issue: `${subjectLabel(target)} model ${target.model}: ${checkName} check failed`,
      fix: "choose a model listed by `pi --no-extensions --list-models` or configure its provider auth",
      subject: target.subject,
      model: target.model,
      check: checkName,
    });
  }
  return findings;
}
