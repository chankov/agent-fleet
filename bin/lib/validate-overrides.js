// Advisory validation of `.ai/agent-fleet-overrides.md`.
//
// The overrides contract is "absent section/key → reader falls back to its
// built-in default", which makes every typo silent: a misspelled section
// heading or key is simply dead config nobody ever reads. The doctor surfaces
// those as WARN-ONLY findings (type "overrides") — reported next to the
// symlink/YAML findings but never auto-fixed; the fix is always a hand edit.
//
// The schema below mirrors docs/agent-fleet-setup.md. The skill sections are
// read leniently by LLM readers, so an unknown key there is a nudge, not an
// error; the agent-hub section is parsed mechanically by the pi harness, so a
// typo'd key really does nothing.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { readProjectProvenance, AI_STATE_REL_PATH } from "./project-provenance.js";

export const OVERRIDES_REL_PATH = ".ai/agent-fleet-overrides.md";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];
const SLUG = "[a-z0-9]+(?:-[a-z0-9]+)*";

// The Hub's runtime roles and practice ids (PLAN-11-01, D9), mirrored from
// .pi/harnesses/agent-hub/config/roles.ts ROLE_NAMES and config/practices.ts
// PRACTICE_IDS — this installer module must load on Node 18, which cannot
// import TypeScript. bin/test/validate-overrides.test.js fails on drift.
export const OVERRIDE_ROLES = Object.freeze(["researcher", "reviewer", "editor"]);
export const OVERRIDE_PRACTICES = Object.freeze([
  "research", "architecture", "planning", "implementation", "independent-review",
  "testing", "security", "performance", "browser-debugging", "documentation", "release",
]);

// The agent-hub key families that name the agent they configure. The Hub applies
// them to role definitions only (D2), so any other name is dead config. A
// retired persona name (D22) is reported with its replacement; the mapping is
// not restated here — the caller passes the Hub's own lookup (roles.ts
// retiredAssignments) as `retiredPersonas`, which the doctor imports lazily.
const AGENT_KEY_RE = new RegExp(`^(model|models|thinking|delegate-depth)\\.(${SLUG})$|^(subagents)\\.(${SLUG})\\.(${SLUG})$`);

function agentKey(key) {
  const m = key.match(AGENT_KEY_RE);
  if (!m) return null;
  return m[1] ? { family: m[1], name: m[2], child: null } : { family: m[3], name: m[4], child: m[5] };
}

// `model`/`thinking` have a per-practice form (D9) and move to it; the other
// families exist only per role and keep their child segment.
function replacementKeys({ family, child }, assignments) {
  const keys = family === "model" || family === "thinking"
    ? assignments.flatMap((entry) => entry.practices.map((practice) => `${family}.${entry.role}.${practice}`))
    : assignments.map((entry) => `${family}.${entry.role}${child ? `.${child}` : ""}`);
  return [...new Set(keys)];
}

function keyTemplate({ family, child }) {
  return family === "model" || family === "thinking"
    ? `${family}.<role>.<practice>`
    : `${family}.<role>${child ? `.${child}` : ""}`;
}

export function formatRetiredAssignments(assignments) {
  return assignments
    .map((entry) => `${entry.role} with practices [${entry.practices.join(", ")}] for ${entry.outcome}`)
    .join("; or ");
}

/** A finding for an agent-hub key whose agent is not a role; null when it is one. */
function nonRoleAgentKey(key, heading, retiredPersonas) {
  const parsed = agentKey(key);
  if (!parsed || OVERRIDE_ROLES.includes(parsed.name)) return null;
  const assignments = retiredPersonas(parsed.name);
  if (!assignments?.length) {
    return {
      issue: `${key} in ## ${heading}: "${parsed.name}" is not a role (${OVERRIDE_ROLES.join(", ")}) — the Hub never reads this key`,
      fix: `rename it to the role it should configure, or remove it; doctor never edits this file`,
    };
  }
  const replacements = replacementKeys(parsed, assignments);
  const issue = `${key} in ## ${heading} names the retired persona "${parsed.name}", so the Hub never reads it`;
  if (replacements.length === 1) {
    return {
      issue,
      replacement: replacements[0],
      fix: `rename to ${replacements[0]} (${formatRetiredAssignments(assignments)}); doctor never edits this file`,
    };
  }
  return {
    issue,
    fix: `"${parsed.name}" maps to more than one assignment — pick the one you meant and rename by hand to ${keyTemplate(parsed)}: ${formatRetiredAssignments(assignments)}`,
  };
}

// One entry per known `## section`. `keys` maps exact key names to an optional
// value check; `patterns` covers the agent-hub `<key>.<role>` families.
// A value check returns a problem string, or null when the value is fine.
const KNOWN_SECTIONS = {
  "spec-driven-development": {
    keys: { "spec-dir": null, "naming": null },
  },
  "planning-and-task-breakdown": {
    keys: {
      "plan-dir": null,
      "naming": null,
      "todo": oneOf(["embedded", "separate"]),
    },
  },
  "browser-testing-with-devtools": {
    keys: {
      "dev-server": null, "ready-check": null, "base-url": null,
      "auth-flow": null, "roles": null, "notes": null,
    },
  },
  "git-workflow-and-versioning": {
    keys: { "branching": oneOf(["never", "allow"]) },
  },
  "agent-hub": {
    keys: {
      "language": null,
      "persona-gate": (value) => `ignored — dispatcher persona selection was removed and the Hub now has one operator work mode. Remove this key (was "${value}")`,
      "rules": checkRuleRoots(),
      "docs": checkPaths("docs entry point"),
      "recon-search-timeout-s": oneOfIntegerOrOff(1, 3600),
      "mode": (value) => `ignored — execution modes were removed; budgets follow task tier. Remove this key (was "${value}")`,
      "max-dispatches-per-turn": retiredQuota,
      "max-research-per-turn": retiredQuota,
      "turn-wall-time-s": retiredQuota,
      "agent-turn-timeout-s": oneOfIntegerOrOff(1, 86400),
      "session-recycle-runs": oneOfIntegerOrOff(1, 1000),
      "watchdog": oneOf(["on", "off", "auto"]),
      "watchdog-judge-model": null,
      "poll-panel": checkPollPanel(),
      "append-prompt": checkPaths("append-prompt file"),
    },
    patterns: [
      { re: new RegExp(`^model\\.${SLUG}$`), example: "model.<role>" },
      { re: new RegExp(`^models\\.${SLUG}$`), example: "models.<role>" },
      {
        re: new RegExp(`^thinking\\.${SLUG}$`), example: "thinking.<role>",
        check: oneOf(THINKING_LEVELS),
      },
      // `model.<role>.<practice>` / `thinking.<role>.<practice>`: the per-practice
      // model choice the Hub reads (D9). Checked before the subagents family.
      {
        re: new RegExp(`^model\\.${SLUG}\\.${SLUG}$`), example: "model.<role>.<practice>",
        check: (value, ctx, key) => checkRolePractice(key),
      },
      {
        re: new RegExp(`^thinking\\.${SLUG}\\.${SLUG}$`), example: "thinking.<role>.<practice>",
        check: (value, ctx, key) => checkRolePractice(key) ?? oneOf(THINKING_LEVELS)(value),
      },
      { re: new RegExp(`^subagents\\.${SLUG}\\.${SLUG}$`), example: "subagents.<role>.<child>" },
      {
        re: new RegExp(`^delegate-depth\\.${SLUG}$`), example: "delegate-depth.<role>",
        check: (value) =>
          /^\d+$/.test(value) ? null : `"${value}" is not a non-negative integer`,
      },
    ],
  },
  "env": {
    keys: { "required": checkEnvVars() },
  },
  // Read by `just flow` (.pi/agent-fleet/scripts/workflows/lib/quality.ts).
  // A nested repository path containing `/` is not a key line for the parser
  // below, so `quality.apps/api:` is skipped rather than flagged.
  "workflows": {
    keys: { "quality": null },
    patterns: [{ re: /^quality\.[\w.-]+$/, example: "quality.<repository>" }],
  },
};

// A per-practice key is dead config unless both segments name what the Hub
// resolves: the role must be a runtime role, the practice a known practice.
function checkRolePractice(key) {
  const [, role, practice] = key.split(".");
  if (!OVERRIDE_ROLES.includes(role)) {
    return `"${role}" is not a role (${OVERRIDE_ROLES.join(", ")}) — the Hub never reads this key`;
  }
  if (!OVERRIDE_PRACTICES.includes(practice)) {
    return `"${practice}" is not a known practice (${OVERRIDE_PRACTICES.join(", ")}) — the Hub ignores it`;
  }
  return null;
}

function retiredQuota(value) {
  return `ignored — continuation quotas were removed; usage stays visible and the watchdog supervises progress. Remove this key (was "${value}")`;
}

// `## agent-team` is the legacy alias the pi harness still accepts.
const SECTION_ALIASES = { "agent-team": "agent-hub" };

function oneOf(values) {
  return (value) => {
    const v = value.trim().toLowerCase();
    return values.includes(v) ? null : `"${value}" is not one of: ${values.join("|")}`;
  };
}

function oneOfIntegerOrOff(min, max) {
  return (value) => {
    const v = value.trim().toLowerCase();
    if (v === "off") return null;
    return /^\d+$/.test(v) && Number(v) >= min && Number(v) <= max
      ? null
      : `"${value}" is not an integer from ${min} to ${max} or "off"`;
  };
}

// The rules key holds comma-separated repo-relative folders; a listed folder
// that doesn't exist is the folder-level equivalent of a typo'd key.
function checkFolders(label) {
  return (value, ctx) => {
    const missing = value.split(",").map((s) => s.trim()).filter(Boolean)
      .filter((dir) => !existsSync(join(ctx.workspace, dir)));
    return missing.length
      ? `${label} folder${missing.length > 1 ? "s" : ""} not found in the workspace: ${missing.join(", ")}`
      : null;
  };
}

// Rules roots add one structural check: an existing root without an index
// still loads (recursive discovery is the fallback), but planning cannot
// select by bundle — worth one advisory line, never auto-created.
function checkRuleRoots() {
  const missing = checkFolders("rules");
  return (value, ctx) => {
    const problems = [];
    const absent = missing(value, ctx);
    if (absent) problems.push(absent);
    for (const dir of value.split(",").map((s) => s.trim()).filter(Boolean)) {
      const abs = join(ctx.workspace, dir);
      if (!existsSync(abs)) continue;
      if (!existsSync(join(abs, "README.md")) && !existsSync(join(abs, "index.md"))) {
        problems.push(`rules root "${dir}" has no index (README.md/index.md); discovery falls back to recursive scan`);
      }
    }
    return problems.length ? problems.join("; ") : null;
  };
}

function checkPollPanel() {
  return (value, ctx) => {
    const name = value.trim();
    if (!name) return "poll-panel requires a panel name";
    const file = join(ctx.workspace, ".pi/agents/voices.yaml");
    if (!existsSync(file)) return null;
    let raw;
    try { raw = parseYaml(readFileSync(file, "utf8")); }
    catch { return "could not parse .pi/agents/voices.yaml to check poll-panel"; }
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || !(name in raw)) {
      const names = raw && typeof raw === "object" && !Array.isArray(raw) ? Object.keys(raw) : [];
      return `panel "${name}" was not found in .pi/agents/voices.yaml${names.length ? ` (available: ${names.join(", ")})` : ""}`;
    }
    return null;
  };
}

// The docs key holds comma-separated repo-relative documentation entry
// points — files or folders both work; existence is the only mechanical check.
function checkPaths(label) {
  return (value, ctx) => {
    const missing = value.split(",").map((s) => s.trim()).filter(Boolean)
      .filter((p) => !existsSync(join(ctx.workspace, p)));
    return missing.length
      ? `${label}${missing.length > 1 ? "s" : ""} not found in the workspace: ${missing.join(", ")}`
      : null;
  };
}

// `## env` / `required:` lists env-var NAMES the project's readers expect
// (test accounts, STT keys, ...). Values never live in this file — the check
// is only that each name is exported in the environment or declared in the
// workspace root `.env`.
function checkEnvVars() {
  return (value, ctx) => {
    const problems = [];
    for (const name of value.split(",").map((s) => s.trim()).filter(Boolean)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        problems.push(`"${name}" is not a valid env var name`);
      } else if (ctx.env[name] === undefined && !ctx.dotEnvNames.has(name)) {
        problems.push(`${name} is not set and not declared in .env`);
      }
    }
    return problems.length ? problems.join("; ") : null;
  };
}

function readDotEnvNames(workspace) {
  const names = new Set();
  const path = join(workspace, ".env");
  if (!existsSync(path)) return names;
  let text;
  try { text = readFileSync(path, "utf8"); } catch { return names; }
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (m) names.add(m[1]);
  }
  return names;
}

/**
 * Validate a workspace's `.ai/agent-fleet-overrides.md`.
 *
 * @param {object} opts
 * @param {string} opts.workspace Workspace root (absolute path)
 * @param {object} [opts.env]     Environment map for the `## env` check
 * @param {(name: string) => ReadonlyArray<{role: string, practices: readonly string[], outcome: string}> | null} [opts.retiredPersonas]
 *        The Hub's retired-persona lookup (roles.ts `retiredAssignments`). Without
 *        it a retired name is still reported, as a name that is not a role.
 * @returns {Array} Advisory findings shaped like the doctor's
 *                  ({type: "overrides", path, issue, fix}); [] when the file
 *                  is absent or clean. A key that names something other than
 *                  a role carries `path: "<file>:<line>"` and `line`.
 */
export function validateOverrides({ workspace, env = process.env, retiredPersonas = () => null }) {
  const path = join(workspace, OVERRIDES_REL_PATH);
  if (!existsSync(path)) return [];
  let text;
  try { text = readFileSync(path, "utf8"); } catch { return []; }

  const ctx = { workspace, env, dotEnvNames: readDotEnvNames(workspace) };
  const findings = [];
  const finding = (issue, fix, path = OVERRIDES_REL_PATH, type = "overrides") =>
    findings.push({ type, path, issue, fix });

  let section = null;        // canonical section name, or null outside/unknown
  let sectionHeading = null; // heading as written, for messages
  const hubKeys = new Map(); // agent-hub key → first line, to spot a replacement already set
  const agentKeyFindings = [];

  for (const [index, rawLine] of text.split("\n").entries()) {
    const line = rawLine.replace(/\r$/, "");
    const lineNo = index + 1;

    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      const name = heading[1].trim().toLowerCase();
      const canonical = SECTION_ALIASES[name] ?? name;
      if (KNOWN_SECTIONS[canonical]) {
        section = canonical;
        sectionHeading = heading[1].trim();
        if (SECTION_ALIASES[name]) {
          finding(
            `legacy section name "## ${name}"`,
            `rename to "## ${canonical}" (the legacy name still works)`,
          );
        }
      } else {
        section = null;
        sectionHeading = null;
        finding(
          `unknown section "## ${heading[1].trim()}" — no reader loads it`,
          `known sections: ${Object.keys(KNOWN_SECTIONS).join(", ")}`,
        );
      }
      continue;
    }

    // Only column-0 `key: value` lines are keys; indented lines are the
    // content of `key: |` blocks (auth-flow, roles, notes) and stay unparsed.
    if (section === null) continue;
    if (/^\s/.test(line) || line.startsWith("#")) continue;
    const kv = line.match(/^([A-Za-z][\w.-]*)\s*:\s*(.*)$/);
    if (!kv) continue;

    const key = kv[1].toLowerCase();
    const value = kv[2].trim();
    const schema = KNOWN_SECTIONS[section];
    if (section === "agent-hub" && !hubKeys.has(key)) hubKeys.set(key, lineNo);

    if (key in schema.keys) {
      const check = schema.keys[key];
      // Empty / `|` values open a multi-line block — nothing to value-check.
      if (check && value && value !== "|") {
        const problem = check(value, ctx);
        if (problem) finding(`${key} in ## ${sectionHeading}: ${problem}`, "fix the value");
      }
      continue;
    }

    const pattern = (schema.patterns ?? []).find((p) => p.re.test(key));
    if (pattern) {
      const dead = section === "agent-hub" ? nonRoleAgentKey(key, sectionHeading, retiredPersonas) : null;
      if (dead) {
        const entry = { type: "overrides", path: `${OVERRIDES_REL_PATH}:${lineNo}`, line: lineNo, key, issue: dead.issue, fix: dead.fix };
        if (dead.replacement) entry.replacement = dead.replacement;
        findings.push(entry);
        agentKeyFindings.push(entry);
        continue;
      }
      if (pattern.check && value && value !== "|") {
        const problem = pattern.check(value, ctx, key);
        if (problem) finding(`${key} in ## ${sectionHeading}: ${problem}`, "fix the value");
      }
      continue;
    }

    const known = [
      ...Object.keys(schema.keys),
      ...(schema.patterns ?? []).map((p) => p.example),
    ];
    finding(
      `unknown key "${key}" in ## ${sectionHeading} — the reader will silently ignore it`,
      `known keys: ${known.join(", ")}`,
    );
  }

  // Two retired names can share one replacement (code-reviewer and plan-reviewer
  // both become reviewer.independent-review), and the replacement may already be
  // set. Say so on the finding rather than suggest a rename that collides.
  for (const entry of agentKeyFindings) {
    if (!entry.replacement) continue;
    const existing = hubKeys.get(entry.replacement);
    const siblings = agentKeyFindings.filter((other) => other !== entry && other.replacement === entry.replacement);
    if (existing !== undefined) {
      entry.fix = `${entry.replacement} is already set on line ${existing} — keep that value and remove this key; doctor never edits this file`;
    } else if (siblings.length) {
      entry.fix += ` — ${siblings.map((other) => `${other.key} (line ${other.line})`).join(", ")} also map${siblings.length > 1 ? "" : "s"} to ${entry.replacement}; keep one value`;
    }
  }

  // Project AI provenance is advisory here: a corrupt sidecar blocks every
  // setup apply, so it gets a file/reason finding — never an auto-fix.
  // Absence is normal (no setup run yet) and stays silent.
  const provenance = readProjectProvenance(workspace);
  if (provenance.status === "corrupt") {
    finding(
      `project provenance is corrupt (${provenance.error}); setup cannot classify or apply until it is repaired`,
      "repair or re-adopt via /af-setup-rules; the sidecar is preserved, never auto-fixed",
      AI_STATE_REL_PATH,
      "provenance",
    );
  }

  return findings;
}
