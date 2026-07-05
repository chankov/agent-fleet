// Advisory validation of `.ai/agent-skills-overrides.md`.
//
// The overrides contract is "absent section/key → reader falls back to its
// built-in default", which makes every typo silent: a misspelled section
// heading or key is simply dead config nobody ever reads. The doctor surfaces
// those as WARN-ONLY findings (type "overrides") — reported next to the
// symlink/YAML findings but never auto-fixed; the fix is always a hand edit.
//
// The schema below mirrors docs/agent-skills-setup.md. The skill sections are
// read leniently by LLM readers, so an unknown key there is a nudge, not an
// error; the agent-hub section is parsed mechanically by the pi harness, so a
// typo'd key really does nothing.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const OVERRIDES_REL_PATH = ".ai/agent-skills-overrides.md";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];
const SLUG = "[a-z0-9]+(?:-[a-z0-9]+)*";

// One entry per known `## section`. `keys` maps exact key names to an optional
// value check; `patterns` covers the agent-hub `<key>.<persona>` families.
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
      "persona-gate": oneOf(["on", "off", "true", "false", "yes", "no", "1", "0"]),
      "rules": checkFolders("rules"),
      "docs": checkPaths("docs entry point"),
    },
    patterns: [
      { re: new RegExp(`^model\\.${SLUG}$`), example: "model.<persona>" },
      { re: new RegExp(`^models\\.${SLUG}$`), example: "models.<persona>" },
      {
        re: new RegExp(`^thinking\\.${SLUG}$`), example: "thinking.<persona>",
        check: oneOf(THINKING_LEVELS),
      },
      { re: new RegExp(`^subagents\\.${SLUG}\\.${SLUG}$`), example: "subagents.<persona>.<role>" },
      {
        re: new RegExp(`^delegate-depth\\.${SLUG}$`), example: "delegate-depth.<persona>",
        check: (value) =>
          /^\d+$/.test(value) ? null : `"${value}" is not a non-negative integer`,
      },
    ],
  },
  "env": {
    keys: { "required": checkEnvVars() },
  },
};

// `## agent-team` is the legacy alias the pi harness still accepts.
const SECTION_ALIASES = { "agent-team": "agent-hub" };

function oneOf(values) {
  return (value) => {
    const v = value.trim().toLowerCase();
    return values.includes(v) ? null : `"${value}" is not one of: ${values.join("|")}`;
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
 * Validate a workspace's `.ai/agent-skills-overrides.md`.
 *
 * @param {object} opts
 * @param {string} opts.workspace Workspace root (absolute path)
 * @param {object} [opts.env]     Environment map for the `## env` check
 * @returns {Array} Advisory findings shaped like the doctor's
 *                  ({type: "overrides", path, issue, fix}); [] when the file
 *                  is absent or clean.
 */
export function validateOverrides({ workspace, env = process.env }) {
  const path = join(workspace, OVERRIDES_REL_PATH);
  if (!existsSync(path)) return [];
  let text;
  try { text = readFileSync(path, "utf8"); } catch { return []; }

  const ctx = { workspace, env, dotEnvNames: readDotEnvNames(workspace) };
  const findings = [];
  const finding = (issue, fix) =>
    findings.push({ type: "overrides", path: OVERRIDES_REL_PATH, issue, fix });

  let section = null;        // canonical section name, or null outside/unknown
  let sectionHeading = null; // heading as written, for messages

  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\r$/, "");

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
      if (pattern.check && value && value !== "|") {
        const problem = pattern.check(value, ctx);
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

  return findings;
}
