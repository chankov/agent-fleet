import { normalizeSystem1Config } from '../../.pi/harnesses/lib/system1/config-v2.js';
import { policyRootValidationContext } from '../../.pi/harnesses/lib/policy-roots.js';
import { loadReviewedPolicyRoots, proactiveBindingDiagnostics } from './system1-policy-context.js';
import { migrateWatchdogOverride } from './system1-migration.js';
import { loadSystem1Snapshot, providerDocument, readSystem1Selected } from "../../.pi/harnesses/lib/system1/config-loader.js";
// Doctor scan — deterministic preflight extracted from
// Both `agent-fleet doctor` (CLI) and the
// Runtime-specific Agent Fleet doctor slash commands call into this so behaviour cannot drift.
//
// Finding classes:
//   1. Broken symlinks — links whose source has been moved, renamed, or deleted
//   2. Non-role dispatch routes — `.pi/agents/dispatch-policy.yaml` route keys
//      that are not a runtime role (researcher, reviewer, editor). The Hub
//      ignores such a route with a warning; a retired persona name gets its
//      role-and-practice mapping. Advisory only: the fix is a hand edit.
//   3. (retired) peers.yaml/teams.yaml scans — both files were removed with
//      peer groups and native teams (PLAN-11-01, D7/D8/D16).
//   4. Overrides-file problems — unknown sections/keys, invalid values, and
//      unset declared env vars in .ai/agent-fleet-overrides.md, plus agent-hub
//      keys that name something other than a role (`model.<x>`, `models.<x>`,
//      `thinking.<x>`, `subagents.<x>.<child>`, `delegate-depth.<x>`), with
//      file:line; a retired persona name gets its exact replacement key or,
//      when it maps to several assignments, the role-and-practice mapping
//      (D22). Advisory only: reported, never auto-fixed (always a hand edit).
//   4b. Retired persona leftovers (D1/D2/D22) — a definition file named for a
//      retired persona in agents/, .claude/agents/, .pi/agents/personas/ or
//      .pi/agents/ (type "retired-persona"), and a .pi/agents/model-profiles.yaml
//      key naming one (flat, v2 `agents:`, v2 `subagents:`; type "yaml-shape").
//      The Hub ignores both; doctor reports the mapping and never deletes or edits.
//   5. Mixed skill/prompt ownership — project/global Pi settings enable
//      `@chankov/agent-fleet` skills/prompts while `.ai/agent-fleet-state.json`
//      also owns matching copied `skill:*` / `command:*` items. Advisory only:
//      package vs copy ownership is a user choice; doctor --fix never mutates it.
//   6. Model visibility — role definition, delegate sub-role, model profile and
//      voices.yaml models that a clean-room `pi --no-extensions` child cannot
//      see. Definition files that are not a role are skipped: the Hub never
//      loads them (4b reports the retired ones). Read-only: never auto-fixed.
//      A missing voices.yaml is not a finding.
//   7. Runtime dependencies — each installed npm root is checked with `npm ls`.
//      Missing/broken dependencies are actionable but never auto-installed by
//      doctor; use the explicit dependency or setup execution consent path.
//   8. Manifest preflight — selected exact files and declared package probes are
//      reported as environment readiness, with platform unknown/unavailable kept
//      distinct from missing installation. Inspection never installs or repairs.
//   9. System 1 readiness — explicit feature selection, human configuration,
//      .env declaration and current environment presence. Advisory and read-only;
//      API validity is never inferred or probed.
//
// For each broken link we look up a canonical replacement in the source
// `agents/` or `skills/` tree (many breakages are stale names from an older
// layout, e.g. `tester` → `editor`).

import { readdirSync, readlinkSync, existsSync, lstatSync, statSync, unlinkSync, symlinkSync, readFileSync, openSync, readSync, closeSync } from "node:fs";
import { join, resolve, dirname, basename, relative, isAbsolute, sep, delimiter } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml, parseDocument, LineCounter, isMap, isScalar } from "yaml";
import { validateOverrides, formatRetiredAssignments, OVERRIDE_ROLES } from "./validate-overrides.js";
import { readInstallationState, assertLocalInstallation, RETIRED_INSTALLATION_OWNER_MESSAGE } from "../../.pi/harnesses/lib/installation-state.js";
import { readState, STATE_REL_PATH } from "./state.js";
import { runtimeDependencyFindings } from "../../.pi/agent-fleet/scripts/lib/runtime-dependencies.js";
import { resolveSystem1Readiness } from "../../.pi/harnesses/lib/system1/config.js";
import { SYSTEM1_DIRECT_TRANSPORT, system1TransportSummary } from "../../.pi/harnesses/lib/system1/transport.js";
import { system1SelectedByDesired } from "../../.pi/harnesses/lib/system1/selection.js";
import { planTaskTriageConfig } from "./task-triage-setup.js";

export const AGENT_FLEET_PACKAGE_NAME = "@chankov/agent-fleet";
const AGENT_FLEET_PACKAGE_PATTERN = /(^|[/:])@chankov\/agent-fleet(@[^/]*)?$/;

// Known canonical replacements for old one-word aliases. `reviewer` is a runtime
// role now (PLAN-11-01), so it is no longer an alias; retired personas get the
// role-and-practice mapping instead of a token rewrite.
const PERSONA_RENAMES = {
  "red-team":      "reviewer",
  "tester":        "editor",
  "qa":            "editor",
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

// The one YAML config whose keys name agents: routes are keyed by role.
const DISPATCH_POLICY_REL = ".pi/agents/dispatch-policy.yaml";

/**
 * Run the doctor scan.
 *
 * @param {object} opts
 * @param {string} opts.workspace  Workspace root (absolute path)
 * @param {string} opts.sourceRoot agent-fleet source root (absolute path)
 * @param {boolean} [opts.apply]   If true, apply suggested fixes; otherwise just report
 * @returns {Array|object}         Findings array (apply=false) or {repaired,deleted,skipped} (apply=true)
 */
export async function runDoctor({ workspace, sourceRoot, apply = false, checkVisibility, checkDependencies, env = process.env } = {}) {
  if (apply) assertLocalInstallation(workspace, 'doctor --fix');
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

  // 2./3. Dispatch routes keyed by something other than a role (advisory, never auto-fixed).
  findings.push(...await scanDispatchPolicyRoutes(workspace));

  // 4. Advisory validation of the overrides file (never auto-fixed). The
  // retired-persona mapping comes from the Hub's role table, not a copy.
  const roles = await roleTable();
  findings.push(...validateOverrides({ workspace, retiredPersonas: roles.assignments }));

  // 4b. Retired persona definition files and profile keys (advisory, never deleted).
  findings.push(...scanRetiredDefinitions(workspace, roles));
  findings.push(...scanRetiredProfileKeys(workspace, roles));

  // 5. Mixed copied / package-native skill+prompt ownership (advisory, never auto-fixed).
  findings.push(...scanPiPackageOwnership({ workspace, sourceRoot }));

  // 6. Model visibility for roster personas, delegate sub-roles, and voices.yaml.
  findings.push(...await scanModelVisibility({ workspace, checkVisibility }));

  // 7. Every installed npm root must have its own complete dependency tree.
  // Node module resolution cannot borrow a sibling root's node_modules.
  findings.push(...runtimeDependencyFindings({ workspace, run: checkDependencies }));

  // 9. Optional System 1 readiness. This reads local declarations only; it does
  // not load .env, create a provider, or contact the API.
  findings.push(...scanSystem1Readiness({ workspace, env }));
  findings.push(...scanTaskTriageReadiness({ workspace, env }));

  const installation = readInstallationState(workspace);
  if (installation.status === 'invalid') findings.push({
    type: 'installation-state', path: '.ai/agent-fleet-state.json',
    issue: installation.reason === 'installation_owner_removed' ? RETIRED_INSTALLATION_OWNER_MESSAGE : `invalid local installation evidence: ${installation.reason}`,
    fix: 'review the local installation configuration and ledger; no automatic migration or adoption',
  });
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
      }
    } catch (err) {
      skipped++;
      console.error(`  ⚠ skipped ${f.path}: ${err.message}`);
    }
  }

  return { repaired, deleted, skipped, findings };
}

export function scanSystem1Readiness({ workspace, env = process.env }) {
  const selected = readSystem1Selected(workspace);
  const loaded = loadSystem1Snapshot(workspace);
  const policyRoots = loadReviewedPolicyRoots(workspace);
  const snapshot = loaded.document ? normalizeSystem1Config(loaded.document, policyRootValidationContext(policyRoots)) : loaded;
  const config = providerDocument(snapshot);
  const legacyMarkdown = [];
  try {
    const path = join(workspace, '.ai/agent-fleet-overrides.md');
    const stat = lstatSync(path);
    if (lstatSync(join(workspace, '.ai')).isDirectory() && stat.isFile() && stat.size <= 1024 * 1024 && migrateWatchdogOverride(readFileSync(path, 'utf8')).mode !== undefined) legacyMarkdown.push({ type: 'system1-legacy', path: '.ai/agent-fleet-overrides.md#agent-hub.watchdog-system1', classification: 'advisory', issue: 'legacy watchdog-system1 is not used by runtime', fix: 'review setup --migrate-system1-config --dry-run' });
  } catch (error) {
    if (error.code !== 'ENOENT') legacyMarkdown.push({ type: 'system1-config', path: '.ai/agent-fleet-overrides.md#agent-hub.watchdog-system1', classification: 'advisory', issue: 'legacy override could not be validated for migration', fix: 'review legacy override locally; no automatic changes' });
  }
  const legacyPaths = ['.ai/proactive-review.json', '.ai/dispatch-triage.json', '.ai/task-triage.json'].filter(path => {
    try { return lstatSync(join(workspace, path)).isFile() || lstatSync(join(workspace, path)).isSymbolicLink(); } catch { return false; }
  });
  const retainedBackups = [];
  try {
    const recovery = join(workspace, '.ai/.agent-fleet-recovery');
    if (lstatSync(join(workspace, '.ai')).isDirectory() && lstatSync(recovery).isDirectory()) {
      for (const entry of readdirSync(recovery, { withFileTypes: true }).slice(0, 128)) {
        if (!entry.isDirectory()) continue;
        const relative = `.ai/.agent-fleet-recovery/${entry.name}/backup`;
        try {
          if (lstatSync(join(recovery, entry.name, '.gitignore')).isFile() && lstatSync(join(workspace, relative)).isDirectory()) retainedBackups.push({ type: 'system1-backup', path: relative, classification: 'advisory', issue: 'protected recovery backup may contain sensitive human configuration; kept after successful migration and ignored by Git', fix: 'retain for operator-led recovery; no automatic deletion' });
        } catch { /* incomplete recovery belongs to journal diagnostics */ }
      }
    }
  } catch { /* no retained backup directory, or unsafe path */ }
  if (!selected && snapshot.status === 'missing' && !legacyPaths.length && !legacyMarkdown.length && !retainedBackups.length) return [];
  const readiness = resolveSystem1Readiness({ selected, config, env });
  // .env can contain secret values. Report declaration status as unknown rather
  // than reading that file merely to improve an advisory message.
  const envDeclared = null;
  const environmentPresent = typeof env.TYPESAFE_API_KEY === "string" && env.TYPESAFE_API_KEY.trim().length > 0;
  const readinessName = readiness.status === "ready" ? "ready" : readiness.reason;
  const detail = {
    disabled: "remote inference is off; independently valid local proactive capture may remain enabled",
    migration_required: "v1 requires explicit setup --migrate-system1-config; no inference",
    missing_config: ".ai/system1.json is absent",
    missing_key: "TYPESAFE_API_KEY is not present in the current process environment; .env was not inspected or loaded",
    invalid_config: ".ai/system1.json is invalid",
    ready: "configuration and current environment are locally ready",
  }[readinessName];
  // A working direct adapter is locally ready even though Pi's native classifier is unavailable (D32).
  const enabled = !["disabled", "missing_config"].includes(readinessName);
  return [{
    type: "system1",
    path: ".ai/system1.json",
    issue: `System 1: ${detail}; API validity is unverified${enabled ? `; ${system1TransportSummary()}` : ""}`,
    fix: readinessName === "ready" || readinessName === "disabled"
      ? "no automatic action"
      : "review the operator-owned System 1 configuration and process environment",
    classification: "advisory",
    readiness: readinessName,
    envDeclared,
    environmentPresent,
    apiValidity: "unverified",
    consumerEvidence: "unverified",
    ...(enabled ? { transport: SYSTEM1_DIRECT_TRANSPORT, nativeClassifier: "not used" } : {}),
    consumers: Object.fromEntries(Object.entries(snapshot.consumers).map(([name, section]) => [name, section.status])),
  }, ...agenticAskDiagnostics(snapshot, readinessName), ...proactiveBindingDiagnostics(snapshot, policyRoots), ...legacyMarkdown, ...retainedBackups, ...snapshot.errors.map(error => ({ type: "system1-config", path: error.path, classification: "advisory", issue: `${error.path}: ${error.code}`, fix: "review the human-owned .ai/system1.json; no automatic changes" })),
  ...legacyPaths.map(path => ({ type: 'system1-legacy', path, classification: 'advisory', issue: snapshot.status === 'missing' ? 'consumer-only legacy configuration has no provider document; runtime ignores it, and migration will not choose provider/model' : snapshot.document ? 'stale legacy file is not used by runtime' : 'legacy file requires explicit migration; not used by runtime', fix: snapshot.status === 'missing' ? 'review docs/system1-config.md#consumer-only-legacy-workspaces; manually author v2 with mode: off and reviewed consumer sections; preserve a private backup' : 'review setup --migrate-system1-config --dry-run; conflicts are never deleted automatically' }))];
}

/**
 * Ask System 1 (PLAN-11-01 task 17): the canonical configured mode and whether the parent Hub's
 * `ask_system1` tool is actually available, with the first missing prerequisite. Offline: local
 * configuration and environment presence only; no provider or catalog call.
 */
export function agenticAskDiagnostics(snapshot, readinessName) {
  const raw = snapshot.document?.consumers?.agenticAsk;
  if (!raw) return [];
  const section = snapshot.consumers?.agenticAsk;
  const config = section?.config;
  if (!config) return [];
  const legacy = config.legacyMode;
  const configured = `${config.mode}${legacy ? ` (legacy "${legacy}", read as "on")` : ""}`;
  const blocker = config.mode === "off" ? "the consumer is off"
    : !config.remoteContextApproved ? "remoteContextApproved is not true"
    : snapshot.status === "off" ? "root System 1 mode is off"
    : readinessName === "disabled" ? "the system1 feature is not enabled for this workspace (.ai/agent-fleet.json)"
    : readinessName !== "ready" ? `System 1 is not locally ready (${readinessName})`
    : null;
  return [{
    type: "system1-agentic-ask",
    path: ".ai/system1.json#consumers.agenticAsk",
    classification: "advisory",
    configuredMode: config.mode,
    ...(legacy ? { legacyMode: legacy } : {}),
    effective: config.mode === "off" ? "off" : blocker ? "unavailable" : "available",
    issue: config.mode === "off"
      ? "Ask System 1: configured off"
      : blocker
      ? `Ask System 1: configured ${configured}; ask_system1 is unavailable because ${blocker}`
      : `Ask System 1: configured ${configured}; ask_system1 is available to the parent Hub only, used at the operator's discretion; API validity is unverified`,
    fix: legacy
      ? `write "on" instead of "${legacy}" when you next edit .ai/system1.json; the Hub now shows the recommended guidance for any "on" consumer`
      : blocker && config.mode !== "off"
        ? "review the operator-owned .ai/system1.json and process environment; consent is never granted automatically"
        : "no automatic action",
  }];
}

export function scanTaskTriageReadiness({ workspace, env = process.env }) {
  const aiPath = join(workspace, ".ai");
  try { if (!lstatSync(aiPath).isDirectory()) return [taskTriageFinding("invalid_selection", false)]; }
  catch (error) { if (error.code === "ENOENT") return []; return [taskTriageFinding("invalid_selection", false)]; }
  const installation = readInstallationState(workspace);
  if (installation.status === 'invalid') return [taskTriageFinding('invalid_selection', false)];
  const state = installation.state;
  const selection = state?.taskTriageSelected;
  const snapshot = loadSystem1Snapshot(workspace);
  if (selection === false) return snapshot.document?.consumers.taskTriage
    ? [taskTriageFinding("disabled_by_setup", false)] : [];
  let config;
  try { config = planTaskTriageConfig(workspace, snapshot); }
  catch { config = { status: "invalid", alreadyApproved: false }; }
  if (selection !== true && config.status === "missing") return [];
  if (selection === "invalid" || (selection !== true && selection !== undefined)) return [taskTriageFinding("invalid_selection", false)];
  let readiness = { missing: "missing_config", invalid: "invalid_config", policy_mismatch: "policy_mismatch", migration_required: "migration_required",
    off: "disabled", unapproved: "unapproved" }[config.status];
  if (!readiness && config.status === "active") {
    const result = resolveSystem1Readiness({ selected: true, config: providerDocument(snapshot), env });
    readiness = ({ disabled: "provider_off", missing_config: "missing_provider", invalid_config: "invalid_provider", migration_required: "migration_required",
      missing_key: "missing_key" })[result.reason] ?? (result.status === "ready" ? "locally_ready" : "invalid_provider");
  }
  const producers = config.status === "active" ? localStageProducers(workspace) : null;
  if (readiness === "locally_ready" && producers?.status === "missing") readiness = "missing_local_producer";
  return [taskTriageFinding(readiness ?? "invalid_config", selection === true || config.alreadyApproved,
    config.status === "active", producers)];
}

// The stage producers task triage needs: the editor writes the plan and the
// change, the reviewer reviews them (PLAN-11-01 runtime roles).
const TASK_TRIAGE_ROLES = ["editor", "reviewer"];

function localStageProducers(workspace) {
  const found = new Set();
  let uncertain = false, count = 0;
  for (const relativeDir of AGENT_DIRS) {
    const dir = join(workspace, relativeDir);
    if (!existsSync(dir)) continue;
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.name.endsWith(".md")) continue;
        if (++count > 128 || !entry.isFile()) { uncertain = true; continue; }
        const fd = openSync(join(dir, entry.name), "r");
        const buffer = Buffer.alloc(4096);
        let size;
        try { size = readSync(fd, buffer, 0, buffer.length, 0); } finally { closeSync(fd); }
        const header = buffer.toString("utf8", 0, size).match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
        if (!header) { uncertain = true; continue; }
        const name = header[1].match(/^name:\s*([^\r\n]+)$/m)?.[1]?.trim().toLowerCase();
        if (TASK_TRIAGE_ROLES.includes(name)) found.add(name);
      }
    } catch { uncertain = true; }
  }
  const missing = TASK_TRIAGE_ROLES.filter(name => !found.has(name));
  return { status: uncertain ? "unverified" : missing.length ? "missing" : "local_files_present_roster_unverified",
    missing: uncertain ? [] : missing };
}

function taskTriageFinding(readiness, selected, configured = false, producers = null) {
  const remoteApproved = configured;
  const missingLocalProducers = producers?.missing ?? [];
  return {
    type: "task-triage", path: ".ai/system1.json#consumers.taskTriage", classification: "advisory",
    selected, configured, remoteApproved, readiness, apiValidity: "unverified",
    ...(producers ? { stageProducerStatus: producers.status, missingLocalProducers } : {}),
    issue: `Task triage: ${readiness}; API validity is unverified${missingLocalProducers.length ? `; locally missing ${missingLocalProducers.join(", ")}` : ""}`,
    fix: missingLocalProducers.length ? `install the ${missingLocalProducers.join(" and ")} role definition${missingLocalProducers.length > 1 ? "s" : ""}: run agent-fleet setup (the Hub brings all three roles, ${OVERRIDE_ROLES.map(name => `persona:${name}`).join(", ")}), or add ${missingLocalProducers.map(name => `agents/${name}.md`).join(" and ")}; doctor never changes them`
      : readiness === "locally_ready" || readiness === "disabled_by_setup" || readiness === "disabled"
        ? "no automatic action" : "review the human-owned task triage configuration and local provider readiness; doctor never starts inference",
  };
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Routes in dispatch-policy.yaml are keyed by runtime role (PLAN-11-01, D11):
// the Hub warns about and ignores any other key, so a route written for a
// retired persona or a peer name silently stops routing. Report each such key
// with the role-and-practice mapping the Hub's own role table gives a retired
// persona. Advisory ("yaml-shape"): the fix is a hand edit.
async function scanDispatchPolicyRoutes(workspace) {
  const file = join(workspace, DISPATCH_POLICY_REL);
  let text;
  try { text = readFileSync(file, "utf8"); } catch { return []; }
  let doc;
  try { doc = parseYaml(text); } catch { return []; } // the Hub warns about unparseable lines itself
  const routes = doc && typeof doc === "object" ? (doc.routes ?? doc.substitutions) : null;
  if (!routes || typeof routes !== "object" || Array.isArray(routes)) return [];
  const roles = await roleTable();
  return Object.keys(routes)
    .filter((key) => !roles.names.includes(key.toLowerCase()))
    .map((key) => {
      const retired = roles.retired(key);
      const targets = [...new Set((roles.assignments(key) ?? []).map((entry) => entry.role))];
      return {
        type: "yaml-shape",
        path: DISPATCH_POLICY_REL,
        issue: `route "${key}" is not a role, so the Hub ignores it; ${retired ?? `routes are keyed by ${roles.names.join(", ")}`}`,
        fix: targets.length === 1
          ? `key the route by "${targets[0]}:" and keep the peer address as "peer: ${key}"`
          : `key the route by its role (${roles.names.join(", ")}) and name the peer with "peer: ${key}"`,
      };
    });
}

// The role names and retired-persona mapping live in the Hub
// (.pi/harnesses/agent-hub/config/roles.ts). Importing TypeScript needs a Node
// that strips types; on an older runtime the scan still names the roles but
// leaves the retired-persona mapping out rather than restating it here.
let roleTablePromise;
function roleTable() {
  roleTablePromise ??= import("../../.pi/harnesses/agent-hub/config/roles.ts")
    .then((roles) => ({ names: [...roles.ROLE_NAMES], retired: roles.retiredPersonaDiagnostic, assignments: roles.retiredAssignments }))
    .catch(() => ({ names: [...OVERRIDE_ROLES], retired: () => null, assignments: () => null }));
  return roleTablePromise;
}

/** The frontmatter `name:` of a definition file (the name the Hub uses), else its basename. */
function definitionName(abs, fileName) {
  let head = "";
  try {
    const fd = openSync(abs, "r");
    try {
      const buffer = Buffer.alloc(4096);
      head = buffer.toString("utf8", 0, readSync(fd, buffer, 0, buffer.length, 0));
    } finally { closeSync(fd); }
  } catch { /* unreadable: fall back to the file name */ }
  const frontmatter = head.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
  return (frontmatter.match(/^name:\s*["']?([^"'\r\n]+?)["']?\s*$/m)?.[1] ?? fileName.replace(/\.md$/, "")).trim().toLowerCase();
}

// A definition file under a retired persona name. The Hub loads only the three
// role definitions and names each ignored file at session start (D1/D2), so
// such a file is dead weight that still reads like a working agent. An install
// record may own it until the next setup retires it; once setup kept an edited
// copy it is the user's. Advisory either way: reported with the mapping, never
// deleted — the user decides what of its prompt to carry into a role file.
function scanRetiredDefinitions(workspace, roles) {
  const owned = new Set(Object.values(readInstallationState(workspace).state?.items ?? {})
    .flatMap((item) => (item?.files ?? []).map((file) => file?.path)).filter(Boolean));
  const findings = [];
  for (const rel of AGENT_DIRS) {
    const dir = join(workspace, rel);
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.name.endsWith(".md")) continue;
      const abs = join(dir, entry.name);
      // A dangling link is the broken-symlink scan's finding, not this one.
      try { if (!statSync(abs).isFile()) continue; } catch { continue; }
      const name = definitionName(abs, entry.name);
      const diagnostic = roles.retired(name);
      if (!diagnostic) continue;
      const path = `${rel}/${entry.name}`;
      findings.push({
        type: "retired-persona",
        path,
        classification: "advisory",
        persona: name,
        issue: `${diagnostic} The Hub ignores this definition file.`,
        fix: owned.has(path)
          ? "run agent-fleet setup to retire it (an unedited copy is removed; an edited one is kept, becomes yours, and stays reported here)"
          : `carry anything you still need into a role file (${roles.names.map((role) => `agents/${role}.md`).join(", ")}), then delete it by hand; doctor never deletes it`,
      });
    }
  }
  return findings;
}

const MODEL_PROFILES_REL = ".pi/agents/model-profiles.yaml";

// `.pi/agents/model-profiles.yaml` keys that name a retired persona: a flat
// profile key or v2 `agents:` key (`<name>` or `<name>.<practice>`), and a v2
// `subagents:` parent. The Hub refuses such a profile entry when it is applied
// ("unknown persona"); doctor names the replacement ahead of that. Only retired
// names are reported — the Hub already explains any other unknown name.
function scanRetiredProfileKeys(workspace, roles) {
  let text;
  try { text = readFileSync(join(workspace, MODEL_PROFILES_REL), "utf8"); } catch { return []; }
  const lineCounter = new LineCounter();
  let doc;
  try { doc = parseDocument(text, { lineCounter }); } catch { return []; }
  if (doc.errors.length || !isMap(doc.contents)) return [];
  const entries = (node) => (isMap(node) ? node.items : [])
    .filter((pair) => isScalar(pair.key))
    .map((pair) => ({ key: String(pair.key.value), value: pair.value, line: pair.key.range ? lineCounter.linePos(pair.key.range[0]).line : null }));
  const findings = [];
  const check = (profile, section, { key, line }, parentOnly) => {
    const dot = key.indexOf(".");
    const name = (dot > 0 ? key.slice(0, dot) : key).toLowerCase();
    const assignments = roles.assignments(name);
    if (!assignments?.length) return;
    const practice = dot > 0 ? key.slice(dot + 1) : null;
    const candidates = [...new Set(parentOnly || practice
      ? assignments.map((entry) => practice ? `${entry.role}.${practice}` : entry.role)
      : assignments.flatMap((entry) => entry.practices.map((id) => `${entry.role}.${id}`)))];
    const where = `profile "${profile}"${section ? ` ${section}:` : ""} key "${key}"`;
    const mapping = formatRetiredAssignments(assignments);
    findings.push({
      type: "yaml-shape",
      path: line ? `${MODEL_PROFILES_REL}:${line}` : MODEL_PROFILES_REL,
      ...(line ? { line } : {}),
      issue: `${where} names the retired persona "${name}", so the Hub cannot apply it`,
      fix: candidates.length === 1
        ? `rename the key to "${candidates[0]}" (${mapping}); doctor never edits this file`
        : `"${name}" maps to more than one assignment — pick the one you meant and rename by hand to ${parentOnly ? "<role>" : "<role>.<practice>"}: ${mapping}`,
    });
  };
  for (const { key: profile, value } of entries(doc.contents)) {
    if (!isMap(value)) continue;
    const fields = entries(value);
    const version = fields.find((field) => field.key === "version")?.value;
    if (!(isScalar(version) && version.value === 2)) {
      for (const field of fields) check(profile, null, field, false);
      continue;
    }
    for (const field of entries(fields.find((entry) => entry.key === "agents")?.value)) check(profile, "agents", field, false);
    for (const field of entries(fields.find((entry) => entry.key === "subagents")?.value)) check(profile, "subagents", field, true);
  }
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

// ── manifest-backed installation preflight ──────────────────────────────────

function selectedManifestIds(manifest, state) {
  const selected = new Set(state ? Object.keys(state.items ?? {}) : manifest.presets?.default?.items ?? []);
  const byId = new Map((manifest.items ?? []).map((item) => [item.id, item]));
  const queue = [...selected];
  while (queue.length) {
    const item = byId.get(queue.shift());
    for (const id of [...(item?.companions ?? []), ...(item?.requires ?? [])]) if (!selected.has(id)) { selected.add(id); queue.push(id); }
  }
  return { selected: [...selected].sort(), byId };
}

function sourceFiles(sourceRoot, source, target) {
  const abs = join(sourceRoot, source);
  if (!existsSync(abs)) return [];
  let stat;
  try { stat = lstatSync(abs); } catch { return []; }
  if (!stat.isDirectory()) return [target];
  const files = [];
  const walk = (dir, rel = "") => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = join(dir, entry.name), childRel = rel ? join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) walk(child, childRel);
      else files.push(join(target, childRel));
    }
  };
  walk(abs);
  return files;
}

function executableOnPath(name, pathValue) {
  if (!name || name.includes("/") || name.includes("\\")) return false;
  const suffixes = process.platform === "win32" ? ["", ".cmd", ".exe", ".bat"] : [""];
  return String(pathValue ?? "").split(delimiter).filter(Boolean).some((dir) => suffixes.some((suffix) => {
    const path = join(dir, `${name}${suffix}`);
    try { return lstatSync(path).isFile(); } catch { return false; }
  }));
}

/** Read-only exact-file/tool readiness derived from the existing install manifest and state. */
export function manifestPreflight({ workspace, sourceRoot, manifest, state = readState(workspace), platform = process.platform, pathValue = process.env.PATH } = {}) {
  const currentPlatform = platform === "linux" || platform === "darwin" ? platform : "unknown";
  const { selected, byId } = selectedManifestIds(manifest, state);
  const unavailablePlatform = [], unknownManifestItems = [], requiredFiles = new Set(), tools = [];
  for (const id of selected) {
    const item = byId.get(id);
    if (!item) { unknownManifestItems.push(id); continue; }
    if (item.platform !== "any" && item.platform !== currentPlatform) {
      unavailablePlatform.push({ itemId: id, status: currentPlatform === "unknown" ? "unknown_platform" : "unavailable_platform", requiredPlatform: item.platform });
      continue;
    }
    const binding = item.agents?.[state?.agent ?? "pi"] ?? item.agents?.pi;
    if (state?.items?.[id]?.files) {
      for (const file of state.items[id].files) if (typeof file?.path === "string") requiredFiles.add(file.path);
    } else if (binding?.target && ["copy-file", "copy-tree"].includes(binding.strategy)) {
      const source = binding.source?.find((candidate) => existsSync(join(sourceRoot, candidate)));
      if (source) for (const file of sourceFiles(sourceRoot, source, binding.target)) requiredFiles.add(file);
    } else if (binding?.target && ["managed-region", "json-merge"].includes(binding.strategy)) requiredFiles.add(binding.target);
    if (item.package?.probe) {
      const available = item.package.manager === "npm" ? executableOnPath(item.package.probe, pathValue) : null;
      tools.push({ itemId: id, probe: item.package.probe, status: available === true ? "available" : available === false ? "missing" : "unknown", remediation: "agent-fleet setup --allow-exec --yes" });
    }
  }
  const missingFiles = [...requiredFiles].sort().filter((path) => !existsSync(join(workspace, path)));
  const noRecord = !state;
  const missingTools = tools.filter((tool) => tool.status === "missing");
  const status = noRecord ? "unavailable" : missingFiles.length || missingTools.length ? "missing_install" : unknownManifestItems.length || unavailablePlatform.some((item) => item.status === "unknown_platform") || tools.some((tool) => tool.status === "unknown") ? "unknown" : "ready";
  return {
    schema: "agent-fleet.installation-preflight/v1", classification: "environment", readOnly: true, status,
    manifestVersion: manifest.packageVersion ?? null, selectedItems: selected.length,
    requiredFiles: [...requiredFiles].sort(), missingFiles, tools, unavailablePlatform, unknownManifestItems,
    remediation: noRecord ? ["agent-fleet setup --preset default --yes"] : [
      ...(missingFiles.length ? ["agent-fleet doctor --fix"] : []),
      ...(missingTools.length ? ["agent-fleet setup --allow-exec --yes"] : []),
    ],
  };
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

  const state = readInstallationState(workspace).state;
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

const AGENT_DIRS = ["agents", ".claude/agents", ".pi/agents/personas", ".pi/agents"];
const VOICES_REL = ".pi/agents/voices.yaml";

/**
 * Models the clean-room child must be able to see: each role definition's primary
 * model, each declared delegate sub-role, every model profile selection, and every
 * voice in voices.yaml (when present). A definition that is not a role is never
 * loaded by the Hub (D2), so its models are not a readiness question.
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
      try {
        targets.push(...parsePersonaModelTargets(abs, `${rel}/${file}`)
          .filter((target) => OVERRIDE_ROLES.includes(target.subject.split("/")[0].toLowerCase())));
      }
      catch { /* unreadable persona is not a visibility finding */ }
    }
  }
  targets.push(...collectVoiceTargets(workspace), ...collectProfileTargets(workspace));
  return targets;
}

function collectProfileTargets(workspace) {
  const path = ".pi/agents/model-profiles.yaml", file = join(workspace, path);
  if (!existsSync(file)) return [];
  let profiles;
  try { profiles = parseYaml(readFileSync(file, "utf8")); } catch { return []; }
  if (!profiles || typeof profiles !== "object" || Array.isArray(profiles)) return [];
  const targets = [];
  const add = (subject, selection) => {
    const model = typeof selection === "string" ? selection : selection?.model;
    if (typeof model === "string") targets.push({ kind: "profile", subject, model, path });
  };
  for (const [name, profile] of Object.entries(profiles)) {
    if (!profile || typeof profile !== "object" || Array.isArray(profile)) continue;
    if (profile.version !== 2) { for (const [persona, model] of Object.entries(profile)) add(`${name}/${persona}`, model); continue; }
    add(`${name}/defaults`, profile.defaults);
    add(`${name}/dispatcher`, profile.dispatcher);
    for (const [persona, value] of Object.entries(profile.agents ?? {})) add(`${name}/${persona}`, value);
    for (const [persona, roles] of Object.entries(profile.subagents ?? {})) for (const [role, value] of Object.entries(roles ?? {})) add(`${name}/${persona}/${role}`, value);
    for (const [service, value] of Object.entries(profile.services ?? {})) add(`${name}/${service}`, value);
    if (Array.isArray(profile.panel)) for (const voice of profile.panel) add(`${name}/panel/${voice?.name}`, voice);
  }
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
  if (target.kind === "profile") return `profile "${target.subject}"`;
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
