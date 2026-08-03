// manifest.js — build, load, and validate the install manifest.
//
// The manifest is the deterministic installer's catalogue: what can be
// installed, for which agent, from where, to where, with which strategy.
// See plans/deterministic-installer-manifest-spec.md for the normative schema.
//
// It is GENERATED from the repository tree, never hand-written. Everything
// mechanical (which skills exist, which agent has a source for a command) is
// derived by walking the source root; only curated judgement (grouping,
// recommendations, consent class, companions) lives in `manifest-meta.json`.
// A hand-maintained parallel list is exactly how a catalogue rots — the
// generator plus `build-manifest.js --check` makes drift a CI failure.
//
// Determinism is a hard requirement: same tree + same meta → byte-identical
// JSON. That is why there is no `generatedAt` timestamp in the output.

import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { listPersonas, targetRelPath } from "./transform-persona.js";

export const MANIFEST_SCHEMA_VERSION = 1;

// Fixed order everywhere the manifest emits per-agent data, so output is stable.
export const MANIFEST_AGENTS = ["claude-code", "opencode", "pi"];

export const MANIFEST_FILE = "install-manifest.json";
export const MANIFEST_META_FILE = "manifest-meta.json";

const STRATEGIES = [
  "copy-file",
  "copy-tree",
  "transform-persona",
  "managed-region",
  "json-merge",
  "exec",
  "external",
  "operator",
];
const CONSENT = ["file", "exec", "external", "operator"];
const PLATFORMS = ["any", "linux", "darwin"];
const ID_RE = /^[a-z][a-z-]*:[a-z0-9][a-z0-9._-]*$/;

// Skill catalogue roots, in resolution order. The fleet-native tree shadows the
// vendored upstream import (docs/UPSTREAM-SKILLS.md) — same rule the doctor's
// findReplacement() already applies.
const SKILL_ROOTS = ["skills", join("vendor", "agent-skills-upstream", "skills")];

const SKILL_TARGET_DIR = {
  "claude-code": ".claude/skills",
  "opencode":    ".opencode/skills",
  "pi":          ".pi/skills",
};

const COMMAND_SOURCE = {
  "claude-code": { dir: ".claude/commands", prefix: "" },
  "opencode":    { dir: ".opencode/commands", prefix: "af-" },
  "pi":          { dir: ".pi/prompts", prefix: "af-" },
};

// ── build ───────────────────────────────────────────────────────────────────

/**
 * Build the manifest from a source tree.
 *
 * @param {object} opts
 * @param {string} opts.sourceRoot      agent-fleet package root (absolute)
 * @param {string} opts.packageVersion  version stamped into the manifest
 * @param {object} [opts.meta]          parsed manifest-meta.json (default: read from sourceRoot)
 * @returns {object} manifest
 */
export function buildManifest({ sourceRoot, packageVersion, meta = null }) {
  const m = meta ?? loadMeta(sourceRoot);
  const items = [
    ...deriveSkills(sourceRoot, m),
    ...derivePersonas(sourceRoot, m),
    ...deriveCommands(sourceRoot, m),
    ...deriveReferences(sourceRoot, m),
    ...deriveHooks(sourceRoot, m),
    ...derivePiTrees(sourceRoot, m),
    ...deriveOperatorItems(sourceRoot, m),
    ...deriveCompanions(sourceRoot, m),
    ...deriveExternals(m),
  ];

  // Companion back-references: an item lists its companions, and each companion
  // records its parents so removal can tell whether anyone still needs it.
  const byId = new Map(items.map((i) => [i.id, i]));
  for (const item of items) {
    for (const cid of item.companions ?? []) {
      const c = byId.get(cid);
      if (c) (c.parents ??= []).push(item.id);
    }
  }
  for (const item of items) if (item.parents) item.parents = uniqSorted(item.parents);

  return orderedManifest({
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    packageVersion,
    groups: m.groups,
    profiles: m.profiles,
    items: items.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  });
}

/** Deterministic serialization — the byte form `--check` compares against. */
export function serializeManifest(manifest) {
  return JSON.stringify(manifest, null, 2) + "\n";
}

export function loadMeta(sourceRoot) {
  return JSON.parse(readFileSync(join(sourceRoot, MANIFEST_META_FILE), "utf8"));
}

export function loadManifest(sourceRoot) {
  const path = join(sourceRoot, MANIFEST_FILE);
  if (!existsSync(path)) {
    throw new Error(
      `${MANIFEST_FILE} is missing from ${sourceRoot} — run \`node bin/build-manifest.js\``,
    );
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

// ── derivation ──────────────────────────────────────────────────────────────

function deriveSkills(sourceRoot, meta) {
  const excluded = new Set(meta.exclude?.skills ?? []);
  const names = new Set();
  for (const root of SKILL_ROOTS) {
    for (const name of dirsIn(join(sourceRoot, root))) {
      if (excluded.has(name)) continue;
      if (!existsSync(join(sourceRoot, root, name, "SKILL.md"))) continue;
      names.add(name);
    }
  }

  return [...names].sort().map((name) => {
    const sources = SKILL_ROOTS
      .map((root) => `${root}/${name}`)
      .filter((rel) => existsSync(join(sourceRoot, rel)));
    const agents = {};
    for (const agent of MANIFEST_AGENTS) {
      agents[agent] = {
        source: sources,
        target: `${SKILL_TARGET_DIR[agent]}/${name}`,
        strategy: "copy-tree",
      };
    }
    return makeItem(meta, {
      id: `skill:${name}`,
      kind: "skill",
      group: "skills",
      title: name,
      summary: frontmatterDescription(join(sourceRoot, sources[0], "SKILL.md")),
      agents,
    });
  });
}

function derivePersonas(sourceRoot, meta) {
  const excluded = new Set(meta.exclude?.personas ?? []);
  const perAgent = new Map(
    MANIFEST_AGENTS.map((agent) => [
      agent,
      new Map(listPersonas(sourceRoot, { agent }).map((p) => [p.name, p])),
    ]),
  );

  const names = uniqSorted(
    [...perAgent.get("pi").keys()].filter((n) => !excluded.has(n)),
  );

  return names.map((name) => {
    const agents = {};
    for (const agent of MANIFEST_AGENTS) {
      if (!perAgent.get(agent).has(name)) continue; // pi-only persona
      agents[agent] = {
        source: [`agents/${name}.md`],
        target: targetRelPath(agent, name).split("\\").join("/"),
        strategy: agent === "pi" ? "copy-file" : "transform-persona",
      };
    }
    return makeItem(meta, {
      id: `persona:${name}`,
      kind: "persona",
      group: "personas",
      title: name,
      summary: frontmatterDescription(join(sourceRoot, "agents", `${name}.md`)),
      agents,
    });
  });
}

function deriveCommands(sourceRoot, meta) {
  const excluded = new Set(meta.exclude?.commands ?? []);
  const names = new Set();
  for (const { dir, prefix } of Object.values(COMMAND_SOURCE)) {
    for (const file of filesIn(join(sourceRoot, dir))) {
      if (!file.endsWith(".md")) continue;
      const base = file.slice(0, -3);
      if (prefix && !base.startsWith(prefix)) continue;
      const name = prefix ? base.slice(prefix.length) : base;
      if (!excluded.has(name)) names.add(name);
    }
  }

  return [...names].sort().map((name) => {
    const agents = {};
    for (const agent of MANIFEST_AGENTS) {
      const { dir, prefix } = COMMAND_SOURCE[agent];
      const rel = `${dir}/${prefix}${name}.md`;
      // Source-availability filter: an agent without its own file does not get
      // the row. Never substitute another runtime's file (see SKILL.md step 6).
      if (!existsSync(join(sourceRoot, rel))) continue;
      agents[agent] = {
        source: [rel],
        target: rel,
        strategy: "copy-file",
        // pi and opencode commands used to install unprefixed. A workspace set
        // up before the `af-` namespace still has the old file, and pi will
        // happily keep offering `/spec` from it. Declaring the old path lets
        // apply() retire it under the same ownership rule as anything else.
        ...(prefix ? { legacyTargets: [`${dir}/${name}.md`] } : {}),
      };
    }
    const first = MANIFEST_AGENTS.find((a) => agents[a]);
    return makeItem(meta, {
      id: `command:${name}`,
      kind: "command",
      group: "commands",
      title: name,
      summary: first
        ? frontmatterDescription(join(sourceRoot, agents[first].source[0]))
        : "",
      agents,
    });
  });
}

function deriveReferences(sourceRoot, meta) {
  const excluded = new Set(meta.exclude?.references ?? []);
  return filesIn(join(sourceRoot, "references"))
    .filter((f) => f.endsWith(".md") && !excluded.has(f))
    .sort()
    .map((file) => {
      const name = file.slice(0, -3);
      // claude-code only: neither docs/pi-setup.md nor docs/opencode-setup.md
      // defines a reference install path, and inventing one is worse than not
      // offering the row (SKILL.md step 3: ask rather than guess).
      return makeItem(meta, {
        id: `reference:${name}`,
        kind: "reference",
        group: "references-hooks",
        title: name,
        summary: "",
        agents: {
          "claude-code": {
            source: [`references/${file}`],
            target: `.claude/references/${file}`,
            strategy: "copy-file",
          },
        },
      });
    });
}

function deriveHooks(sourceRoot, meta) {
  const excluded = new Set(meta.exclude?.hooks ?? []);
  return filesIn(join(sourceRoot, "hooks"))
    .filter((f) => (f.endsWith(".sh") || f.endsWith(".mjs")) && !excluded.has(f))
    .sort()
    .map((file) => {
      const name = file.replace(/\.(sh|mjs)$/, "");
      // Hooks register into .claude/settings.json; no hook install path is
      // defined for opencode or pi.
      return makeItem(meta, {
        id: `hook:${name}`,
        kind: "hook",
        group: "references-hooks",
        title: name,
        summary: "",
        agents: {
          "claude-code": {
            source: [`hooks/${file}`],
            target: `.claude/hooks/${file}`,
            strategy: "copy-file",
          },
        },
      });
    });
}

// pi extensions, harnesses, and runtime skills — same shape, pi only.
function derivePiTrees(sourceRoot, meta) {
  const specs = [
    { dir: ".pi/extensions", kind: "pi-extension",    group: "pi-extensions", exclude: meta.exclude?.piExtensions },
    { dir: ".pi/harnesses",  kind: "pi-harness",      group: "pi-harnesses",  exclude: meta.exclude?.piHarnesses },
    { dir: ".pi/skills",     kind: "pi-runtime-skill", group: "pi-extensions", exclude: meta.exclude?.piRuntimeSkills },
  ];
  const out = [];
  for (const spec of specs) {
    const excluded = new Set(["node_modules", ...(spec.exclude ?? [])]);
    for (const name of dirsIn(join(sourceRoot, spec.dir))) {
      if (excluded.has(name)) continue;
      out.push(makeItem(meta, {
        id: `${spec.kind}:${name}`,
        kind: spec.kind,
        group: spec.group,
        title: name,
        summary: "",
        agents: {
          pi: {
            source: [`${spec.dir}/${name}`],
            target: `${spec.dir}/${name}`,
            strategy: "copy-tree",
          },
        },
      }));
    }
  }
  return out;
}

// Hermes plugins/skills and the Codex bridge install outside the workspace (a
// Hermes profile, a user systemd unit). They are catalogued so a plan can name
// them, but carry `consent: "operator"` and no workspace target — the engine
// prints next steps and performs nothing. Phase 6 gives them real handling.
function deriveOperatorItems(sourceRoot, meta) {
  const out = [];

  const pluginIds = new Set([
    ...dirsIn(join(sourceRoot, "hermes", "plugins")),
    ...dirsIn(join(sourceRoot, "hermes", "desktop-plugins")),
  ]);
  for (const id of [...pluginIds].sort()) {
    const source = ["hermes/plugins", "hermes/desktop-plugins"]
      .map((root) => `${root}/${id}`)
      .filter((rel) => existsSync(join(sourceRoot, rel)));
    out.push(makeItem(meta, {
      id: `hermes-plugin:${id}`,
      kind: "hermes-plugin",
      group: "hermes",
      title: id,
      summary: "",
      consent: "operator",
      agents: { pi: { source, target: null, targetScope: "hermes-profile", strategy: "operator" } },
    }));
  }

  for (const name of dirsIn(join(sourceRoot, "hermes", "skills")).sort()) {
    out.push(makeItem(meta, {
      id: `hermes-skill:${name}`,
      kind: "hermes-skill",
      group: "hermes",
      title: name,
      summary: frontmatterDescription(join(sourceRoot, "hermes", "skills", name, "SKILL.md")),
      consent: "operator",
      agents: {
        pi: {
          source: [`hermes/skills/${name}`],
          target: null,
          targetScope: "hermes-profile",
          strategy: "operator",
        },
      },
    }));
  }

  for (const file of filesIn(join(sourceRoot, "systemd", "user")).sort()) {
    const name = file.replace(/\.(service|timer)?(\.in)?$/, "");
    out.push(makeItem(meta, {
      id: `codex:${name}`,
      kind: "codex",
      group: "codex-bridge",
      title: name,
      summary: "",
      consent: "operator",
      platform: "linux",
      agents: {
        pi: {
          source: [`systemd/user/${file}`],
          target: null,
          targetScope: "user-systemd",
          strategy: "operator",
        },
      },
    }));
  }

  return out;
}

// Companions are applied with their parents and are never selectable rows.
// Most are hand-declared in meta; the pi-harness runtime closure is derived
// from the existing companion-manifest.json so the two cannot diverge.
function deriveCompanions(sourceRoot, meta) {
  const out = [];

  for (const [id, decl] of Object.entries(meta.companions ?? {})) {
    out.push(makeItem(meta, {
      id,
      kind: "companion",
      group: decl.group ?? "companions",
      title: decl.title ?? id.split(":")[1],
      summary: decl.summary ?? "",
      consent: decl.consent ?? "file",
      agents: decl.agents ?? {},
      exec: decl.exec,
      operatorSteps: decl.operatorSteps,
    }));
  }

  const closurePath = join(
    sourceRoot, "skills", "guided-workspace-setup", "companion-manifest.json",
  );
  if (existsSync(closurePath)) {
    const closure = JSON.parse(readFileSync(closurePath, "utf8"));
    // `justfile` is in the closure list but needs the managed-region strategy,
    // not a whole-file copy — meta declares it as its own companion.
    const files = (closure.files ?? []).filter((f) => f !== "justfile").sort();
    const dirs = (closure.directories ?? []).slice().sort();
    out.push(makeItem(meta, {
      id: "companion:harness-runtime-closure",
      kind: "companion",
      group: "companions",
      title: "harness-runtime-closure",
      summary: "Runtime files the pi harness recipes shell out to",
      agents: {
        pi: {
          source: [...dirs, ...files],
          sourceMode: "all",
          // Every entry keeps its repo-relative path in the workspace, so
          // `scripts/lib/team-project.ts` lands where the recipes expect it.
          target: null,
          preserveLayout: true,
          strategy: "copy-tree",
        },
      },
    }));
  }

  return out;
}

function deriveExternals(meta) {
  return Object.entries(meta.externalPackages ?? {}).map(([id, decl]) =>
    makeItem(meta, {
      id,
      kind: "external-package",
      group: decl.group ?? "external-packages",
      title: decl.title ?? id.split(":")[1],
      summary: decl.summary ?? "",
      consent: "external",
      agents: Object.fromEntries(
        (decl.agents ?? ["pi"]).map((a) => [
          a, { source: [], target: null, strategy: "external" },
        ]),
      ),
      package: decl.package,
    }),
  );
}

// ── item assembly ───────────────────────────────────────────────────────────

function makeItem(meta, base) {
  const overrides = meta.items?.[base.id] ?? {};
  const item = {
    id: base.id,
    kind: base.kind,
    group: overrides.group ?? base.group,
    subcategory: overrides.subcategory ?? meta.subcategory?.[base.id] ?? null,
    title: base.title,
    summary: overrides.summary ?? base.summary ?? "",
    recommended: (meta.recommended ?? []).includes(base.id),
    consent: overrides.consent ?? base.consent ?? "file",
    platform: overrides.platform ?? base.platform ?? "any",
    agents: orderAgents(base.agents),
  };
  if (base.exec ?? overrides.exec) item.exec = base.exec ?? overrides.exec;
  if (base.package) item.package = base.package;
  // Operator items are the ones the engine refuses to perform. A row that only
  // says "do this yourself" without saying what to do is worse than no row, so
  // the steps are declared data and validateManifest insists on them.
  const steps = overrides.operatorSteps ?? base.operatorSteps;
  if (steps?.length) item.operatorSteps = [...steps];
  if (overrides.retired) item.retired = overrides.retired;

  for (const key of ["companions", "requires", "recommendsWith", "pinnedBy"]) {
    const value = overrides[key];
    if (value?.length) item[key] = uniqSorted(value);
  }
  return item;
}

function orderAgents(agents) {
  const out = {};
  for (const agent of MANIFEST_AGENTS) {
    if (!agents?.[agent]) continue;
    const a = agents[agent];
    out[agent] = {
      source: a.source ?? [],
      // "first" (default): `source` is an ordered candidate list — the first
      // existing path wins (this is how native skills shadow the vendored
      // copy). "all": every source is installed, and `target` names the
      // directory they land in (or, with preserveLayout, they keep their own
      // repo-relative path).
      sourceMode: a.sourceMode === "all" ? "all" : "first",
      target: a.target ?? null,
      strategy: a.strategy,
      ...(a.targetScope ? { targetScope: a.targetScope } : {}),
      ...(a.preserveLayout ? { preserveLayout: true } : {}),
      ...(a.legacyTargets?.length ? { legacyTargets: [...a.legacyTargets].sort() } : {}),
    };
  }
  return out;
}

function orderedManifest({ schemaVersion, packageVersion, groups, profiles, items }) {
  return { schemaVersion, packageVersion, groups, profiles, items };
}

// ── validation ──────────────────────────────────────────────────────────────

/**
 * Validate a manifest. Returns an array of human-readable problems; empty
 * means valid. `sourceRoot` enables the source-existence checks.
 *
 * @param {object} manifest
 * @param {object} [opts]
 * @param {string} [opts.sourceRoot]
 * @returns {string[]}
 */
export function validateManifest(manifest, { sourceRoot = null } = {}) {
  const problems = [];

  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    problems.push(
      `schemaVersion is ${manifest.schemaVersion}, expected ${MANIFEST_SCHEMA_VERSION}`,
    );
  }
  if (!manifest.packageVersion) problems.push("packageVersion is missing");

  const groupIds = new Set((manifest.groups ?? []).map((g) => g.id));
  const seen = new Set();
  const targets = new Map(); // `${agent}\0${target}` → item id

  for (const item of manifest.items ?? []) {
    const at = `item ${item.id}`;
    if (!ID_RE.test(item.id ?? "")) problems.push(`${at}: id does not match ${ID_RE}`);
    if (seen.has(item.id)) problems.push(`${at}: duplicate id`);
    seen.add(item.id);

    if (!groupIds.has(item.group)) problems.push(`${at}: unknown group "${item.group}"`);
    if (!CONSENT.includes(item.consent)) problems.push(`${at}: unknown consent "${item.consent}"`);
    if (!PLATFORMS.includes(item.platform)) problems.push(`${at}: unknown platform "${item.platform}"`);

    const agents = Object.keys(item.agents ?? {});
    if (agents.length === 0) problems.push(`${at}: has no agent bindings`);
    for (const agent of agents) {
      if (!MANIFEST_AGENTS.includes(agent)) {
        problems.push(`${at}: unknown agent "${agent}"`);
        continue;
      }
      const binding = item.agents[agent];
      if (!STRATEGIES.includes(binding.strategy)) {
        problems.push(`${at} (${agent}): unknown strategy "${binding.strategy}"`);
      }
      if (!["first", "all"].includes(binding.sourceMode)) {
        problems.push(`${at} (${agent}): unknown sourceMode "${binding.sourceMode}"`);
      }
      if (binding.sourceMode === "all" && !binding.target && !binding.preserveLayout) {
        problems.push(`${at} (${agent}): sourceMode "all" needs either a target directory or preserveLayout`);
      }
      if (binding.sourceMode === "first" && (binding.source ?? []).length > 0 && !binding.target
          && !["exec", "operator", "external"].includes(binding.strategy)) {
        problems.push(`${at} (${agent}): has sources but no target`);
      }
      if (sourceRoot) {
        for (const rel of binding.source ?? []) {
          if (!existsSync(join(sourceRoot, rel))) {
            problems.push(`${at} (${agent}): source does not exist — ${rel}`);
          }
        }
      }
      // Two items writing the same path for the same agent is a silent
      // clobber waiting to happen; catch it at build time instead.
      if (binding.target && binding.target !== ".") {
        const key = `${agent}\0${binding.target}`;
        if (targets.has(key)) {
          problems.push(`${at} (${agent}): target collides with ${targets.get(key)} — ${binding.target}`);
        } else {
          targets.set(key, item.id);
        }
      }
      if (item.consent === "operator" && binding.target) {
        problems.push(`${at} (${agent}): operator-consent items must not declare a workspace target`);
      }
    }

    if (item.consent === "exec" && !item.exec) problems.push(`${at}: consent "exec" without an exec block`);
    if (item.exec && item.consent !== "exec") problems.push(`${at}: exec block requires consent "exec"`);
    if (item.consent === "operator" && !(item.operatorSteps ?? []).length) {
      problems.push(`${at}: consent "operator" without operatorSteps — an unactionable row`);
    }
    if (item.operatorSteps && item.consent !== "operator") {
      problems.push(`${at}: operatorSteps requires consent "operator"`);
    }

    for (const key of ["companions", "requires", "pinnedBy", "parents"]) {
      for (const ref of item[key] ?? []) {
        if (!(manifest.items ?? []).some((i) => i.id === ref)) {
          problems.push(`${at}: ${key} references unknown item "${ref}"`);
        }
      }
    }
  }

  for (const [name, profile] of Object.entries(manifest.profiles ?? {})) {
    if (profile.rule && profile.items) {
      problems.push(`profile ${name}: declares both "rule" and "items"`);
    }
    if (!profile.rule && !profile.items) {
      problems.push(`profile ${name}: declares neither "rule" nor "items"`);
    }
    if (profile.rule && !["recommended", "all"].includes(profile.rule)) {
      problems.push(`profile ${name}: unknown rule "${profile.rule}"`);
    }
    for (const id of profile.items ?? []) {
      if (!seen.has(id)) problems.push(`profile ${name}: unknown item "${id}"`);
    }
  }

  return problems;
}

// ── queries ─────────────────────────────────────────────────────────────────

/** Items installable for one agent, with that agent's binding resolved. */
export function itemsForAgent(manifest, agent) {
  return (manifest.items ?? [])
    .filter((i) => i.agents?.[agent])
    .map((i) => ({ ...i, binding: i.agents[agent] }));
}

/**
 * Turn profiles and/or explicit item ids into the selected id set, applying
 * the `requires` and `companions` closures. Selection never implies removal.
 *
 * @returns {{ selected: string[], unknown: string[] }}
 */
export function resolveSelection(manifest, agent, { profiles = [], items = [] } = {}) {
  const available = new Map(itemsForAgent(manifest, agent).map((i) => [i.id, i]));
  const selected = new Set();
  const unknown = [];

  for (const name of profiles) {
    const profile = manifest.profiles?.[name];
    if (!profile) { unknown.push(`profile:${name}`); continue; }
    if (profile.rule === "all") {
      for (const [id, item] of available) if (item.kind !== "companion") selected.add(id);
    } else if (profile.rule === "recommended") {
      for (const [id, item] of available) if (item.recommended) selected.add(id);
    }
    for (const id of profile.items ?? []) {
      if (available.has(id)) selected.add(id);
      else unknown.push(id);
    }
  }
  for (const id of items) {
    if (available.has(id)) selected.add(id);
    else unknown.push(id);
  }

  // Closure: requires are hard, companions travel with their parent.
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of [...selected]) {
      for (const ref of [...(available.get(id)?.requires ?? []), ...(available.get(id)?.companions ?? [])]) {
        if (available.has(ref) && !selected.has(ref)) { selected.add(ref); changed = true; }
      }
    }
  }

  return { selected: [...selected].sort(), unknown: uniqSorted(unknown) };
}

// ── helpers ─────────────────────────────────────────────────────────────────

function dirsIn(dir) {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map((e) => e.name)
      .sort();
  } catch { return []; }
}

function filesIn(dir) {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .sort();
  } catch { return []; }
}

// Reads `description:` from YAML frontmatter. Single-line scalars only — the
// artifacts we read all use them, and a full YAML parse here would pull the
// whole `yaml` dependency into a path that must stay cheap.
function frontmatterDescription(path) {
  if (!existsSync(path)) return "";
  let text;
  try { text = readFileSync(path, "utf8"); } catch { return ""; }
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return "";
  const line = fm[1].split(/\r?\n/).find((l) => /^description:\s*\S/.test(l));
  if (!line) return "";
  const value = line.replace(/^description:\s*/, "").trim().replace(/^["']|["']$/g, "");
  // First sentence, capped — summaries are one-line labels in every front-end.
  const first = value.split(/(?<=\.)\s+(?=[A-Z])/)[0] ?? value;
  return first.length > 120 ? first.slice(0, 117).trimEnd() + "…" : first;
}

function uniqSorted(list) {
  return [...new Set(list)].sort();
}
