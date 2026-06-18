// Persona transformer — generates per-agent subagent definitions from the
// canonical pi-flavored personas in `agents/*.md`.
//
// The canonical frontmatter carries agent-hub-only keys (`models`, `thinking`,
// `delegate_depth`, `subagents`, `kind`, `skills`). Other coding agents get a
// *generated* artifact: same name/description/body, with `tools`/`model`
// translated to the target's vocabulary and the pi-only keys dropped.
//
// Targets:
//   claude-code → .claude/agents/<name>.md   (tools renamed, model mapped)
//   opencode    → .opencode/agent/<name>.md  (mode: subagent + tool denials)
//   pi          → agents/<name>.md           (byte-identical passthrough)
//
// Used by the `agent-skills transform-persona` CLI subcommand, which the
// guided-workspace-setup skill calls during apply. Deterministic on purpose:
// the mapping lives here, in one place, under test — never in skill prose.

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export const TRANSFORM_AGENTS = ["claude-code", "opencode", "pi"];

// Personas coupled to the pi runtime: `bowser` depends on the pi runtime
// skill `bowser` (which drives the external `playwright-cli` tool); the
// `orchestrator` is the flavor-only agent-hub
// dispatcher persona — agent-hub builds the orchestration prompt itself,
// so standalone it is an empty shell.
export const PI_ONLY_PERSONAS = ["bowser", "orchestrator"];

// pi tool name → Claude Code tool name. `find`/`ls` both collapse into Glob.
const CLAUDE_TOOL_MAP = {
  read:  "Read",
  write: "Write",
  edit:  "Edit",
  bash:  "Bash",
  grep:  "Grep",
  find:  "Glob",
  ls:    "Glob",
};

// OpenCode write-capable tools we deny when the persona does not grant the
// matching pi tool. `patch` has no pi equivalent, so it follows `write`.
const OPENCODE_DENIABLE = ["write", "edit", "bash", "patch"];

export function targetRelPath(agent, name) {
  switch (agent) {
    case "claude-code": return join(".claude", "agents", `${name}.md`);
    case "opencode":    return join(".opencode", "agent", `${name}.md`);
    case "pi":          return join("agents", `${name}.md`);
    default: throw new Error(`unknown agent "${agent}" (allowed: ${TRANSFORM_AGENTS.join(", ")})`);
  }
}

/**
 * List the personas available for a target agent (availability matrix).
 *
 * @param {string} sourceRoot agent-skills source root (absolute path)
 * @param {object} opts
 * @param {string} opts.agent  one of TRANSFORM_AGENTS
 * @returns {Array<{name: string, sourcePath: string, targetRelPath: string}>}
 */
export function listPersonas(sourceRoot, { agent }) {
  if (!TRANSFORM_AGENTS.includes(agent)) {
    throw new Error(`unknown agent "${agent}" (allowed: ${TRANSFORM_AGENTS.join(", ")})`);
  }
  const dir = join(sourceRoot, "agents");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""))
    .filter((name) => agent === "pi" || !PI_ONLY_PERSONAS.includes(name))
    .sort()
    .map((name) => ({
      name,
      sourcePath: join(dir, `${name}.md`),
      targetRelPath: targetRelPath(agent, name),
    }));
}

/**
 * Transform one canonical persona for a target agent.
 *
 * @param {string} sourceText full text of the canonical agents/<name>.md
 * @param {object} opts
 * @param {string} opts.agent one of TRANSFORM_AGENTS
 * @returns {{name: string, content: string, targetRelPath: string}}
 */
export function transformPersona(sourceText, { agent }) {
  if (!TRANSFORM_AGENTS.includes(agent)) {
    throw new Error(`unknown agent "${agent}" (allowed: ${TRANSFORM_AGENTS.join(", ")})`);
  }

  const { fields, body } = splitPersona(sourceText);
  const name = fields.name;
  if (!name) throw new Error("persona has no `name:` in its frontmatter");

  if (agent !== "pi" && PI_ONLY_PERSONAS.includes(name)) {
    throw new Error(
      `persona "${name}" is pi-only (depends on the pi runtime / agent-hub) — not installable for ${agent}`,
    );
  }

  if (agent === "pi") {
    // Canonical format IS the pi format.
    return { name, content: sourceText, targetRelPath: targetRelPath("pi", name) };
  }

  const lines = [];
  if (agent === "claude-code") {
    lines.push(`name: ${name}`);
    lines.push(`description: ${fields.description ?? ""}`);
    const tools = mapClaudeTools(fields.tools);
    if (tools) lines.push(`tools: ${tools}`);
    const model = mapClaudeModel(fields.model);
    if (model) lines.push(`model: ${model}`);
    // Keep bare color names; drop hex values Claude Code does not accept.
    if (fields.color && /^[a-z]+$/.test(fields.color)) lines.push(`color: ${fields.color}`);
  } else {
    // opencode — invoked as a subagent; model inherited from the session
    // (pi provider ids do not map 1:1 onto OpenCode provider ids).
    lines.push(`description: ${fields.description ?? ""}`);
    lines.push("mode: subagent");
    const denials = opencodeDenials(fields.tools);
    if (denials.length > 0) {
      lines.push("tools:");
      for (const t of denials) lines.push(`  ${t}: false`);
    }
  }

  const content = `---\n${lines.join("\n")}\n---\n${body}`;
  return { name, content, targetRelPath: targetRelPath(agent, name) };
}

// ── mapping helpers ─────────────────────────────────────────────────────────

function mapClaudeTools(toolsValue) {
  if (!toolsValue) return null; // no tools key → inherit all
  const out = [];
  for (const raw of toolsValue.split(",")) {
    const mapped = CLAUDE_TOOL_MAP[raw.trim()];
    if (mapped && !out.includes(mapped)) out.push(mapped);
  }
  return out.length > 0 ? out.join(", ") : null;
}

function mapClaudeModel(modelValue) {
  if (!modelValue) return null;
  if (modelValue.includes("claude-opus"))   return "opus";
  if (modelValue.includes("claude-sonnet")) return "sonnet";
  if (modelValue.includes("claude-haiku"))  return "haiku";
  return null; // non-Anthropic pi route → inherit the session model
}

function opencodeDenials(toolsValue) {
  if (!toolsValue) return []; // no tools key → inherit (no denials)
  const granted = new Set(toolsValue.split(",").map((t) => t.trim()));
  if (granted.has("write")) granted.add("patch"); // patch follows write
  return OPENCODE_DENIABLE.filter((t) => !granted.has(t));
}

// ── parsing ────────────────────────────────────────────────────────────────
//
// Deliberately minimal: the canonical personas use single-line scalar values
// for every key we keep (name, description, tools, model, color). Nested
// blocks (models, subagents, skills) belong to keys we drop wholesale, so we
// only read unindented `key: value` lines and ignore everything else.

function splitPersona(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) throw new Error("persona has no YAML frontmatter (--- … ---)");
  const fields = {};
  for (const line of m[1].split(/\r?\n/)) {
    if (/^[ \t]/.test(line)) continue; // nested content of a dropped key
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv) fields[kv[1]] = kv[2].trim();
  }
  return { fields, body: text.slice(m[0].length) };
}
