#!/usr/bin/env node
// agent-fleet — thin dispatcher into the LLM-driven guided setup.
//
// Main commands:
//   init               materialize the package, detect the coding agent, hand off to its setup command
//   doctor             deterministic preflight scan (broken symlinks, stale persona refs)
//   update             refresh the package, then hand off to the setup workflow for the version-diff
//   transform-persona  generate per-agent subagent files from the canonical agents/*.md
//   set-hermes-telegram install/inspect the liaison and start/stop its bridge
//
// The CLI itself never decides which skills to install or what to overwrite —
// that is the job of the guided-workspace-setup skill, run by the user's
// coding agent. We just put the source files where the agent can find them
// and print the next-step command.

import { readFileSync, existsSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { stdin, stdout, exit } from "node:process";

import { runDoctor } from "./lib/doctor.js";
import { loadManifest } from "./lib/manifest.js";
import { runVerify, hasDrift } from "./lib/verify.js";
import { buildPlan, hasConflicts, isNoop } from "./lib/plan.js";
import { applyPlan } from "./lib/apply.js";
import { readState, readLegacyRecord, isAgentFleetCheckout, STATE_REL_PATH } from "./lib/state.js";
import { listPersonas, transformPersona } from "./lib/transform-persona.js";
import { detectAgent, agentLabel, AGENTS } from "./lib/detect-agent.js";
import { checkAndNotify } from "./lib/update-notifier.js";
import { bootstrap, cleanupInstaller, readBootstrapMarker } from "./lib/bootstrap.js";
import { setHermesTelegram, runHermesCommand } from "./lib/set-hermes-telegram.js";
import { setHermesWatchdog } from "./lib/set-hermes-watchdog.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, "..");
const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));

// ── argv parsing ──────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const sub = argv[0];

if (!sub || sub === "--help" || sub === "-h" || sub === "help") {
  printHelp();
  exit(0);
}
if (sub === "--version" || sub === "-v" || sub === "version") {
  console.log(pkg.version);
  exit(0);
}

const parsed = (() => {
  try {
    return parseArgs({
      args: argv.slice(1),
      allowPositionals: true,
      options: {
        agent:     { type: "string" },
        method:    { type: "string" },
        workspace: { type: "string" },
        yes:       { type: "boolean", short: "y" },
        profile:   { type: "string" },
        force:     { type: "boolean" },
        restart:   { type: "boolean" },
        "dry-run": { type: "boolean" },
        json:      { type: "boolean" },
        "no-doctor": { type: "boolean" },
        items:     { type: "string" },
        "allow-exec":    { type: "boolean" },
        "accept-theirs": { type: "boolean" },
        "accept-ours":   { type: "boolean" },
        fix:       { type: "boolean" },
        launch:    { type: "boolean" },
        all:       { type: "boolean" },
        list:      { type: "boolean" },
        help:      { type: "boolean", short: "h" },
      },
    });
  } catch (err) {
    fail(err.message);
  }
})();

const opts = parsed.values;
const workspace = resolve(opts.workspace ?? process.cwd());

if (opts.help) {
  printHelp(sub);
  exit(0);
}

// ── dispatch ──────────────────────────────────────────────────────────────

// Update check runs first — if the cache is fresh and shows an upgrade,
// the banner prints to stderr before the command output. If the cache is
// stale, a background fetch refreshes it for the next invocation.
// `update` skips this since it has its own version-delta reporting.
// `verify` stays out of it as well: it is a machine contract (exit codes +
// --json), and a banner racing onto the stream helps nobody scripting it.
// `install` and `upgrade` join it for the same reason.
if (!["update", "check-update", "verify", "install", "upgrade", "uninstall", "doctor"].includes(sub)) {
  checkAndNotify(pkg.version);
}

switch (sub) {
  case "init":              await cmdInit();             break;
  case "doctor":            await cmdDoctor();           break;
  case "verify":            await cmdVerify();           break;
  case "install":           await cmdPlanVerb("install"); break;
  case "upgrade":           await cmdPlanVerb("upgrade"); break;
  case "uninstall":         await cmdPlanVerb("uninstall"); break;
  case "update":            await cmdUpdate();           break;
  case "check-update":      await cmdCheckUpdate();      break;
  case "cleanup-installer":  await cmdCleanupInstaller();  break;
  case "transform-persona":  await cmdTransformPersona();  break;
  case "set-hermes-telegram": await cmdSetHermesTelegram(); break;
  case "set-hermes-watchdog": await cmdSetHermesWatchdog(); break;
  default:                    fail(`unknown command: ${sub}\n\nRun "agent-fleet --help" for usage.`);
}

// ── commands ──────────────────────────────────────────────────────────────

async function cmdSetHermesWatchdog() {
  try {
    const result = await setHermesWatchdog({
      positionals: parsed.positionals,
      profile: opts.profile,
      force: opts.force,
      dryRun: opts["dry-run"],
      packageRoot: pkgRoot,
      hermes: runHermesCommand,
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

async function cmdSetHermesTelegram() {
  try {
    const result = await setHermesTelegram({
      positionals: parsed.positionals,
      profile: opts.profile,
      force: opts.force,
      restart: opts.restart,
      currentPaneId: process.env.HERDR_PANE_ID,
      packageRoot: pkgRoot,
      env: process.env,
    });
    if (result.action === "status") {
      console.log(`Hermes Telegram status (${result.profile})`);
      console.log(`  profile: ${result.profilePath}`);
      console.log(`  gateway: ${result.gatewayRunning ? "running" : "stopped"}`);
      console.log(`  hub-liaison: ${result.skillState}, ${result.skillEnabled ? "enabled" : "disabled"}`);
      console.log(`  Telegram tools: terminal=${result.tools.terminal ? "enabled" : "disabled"}, file=${result.tools.file ? "enabled" : "disabled"}`);
      console.log(`  ready: ${result.ready ? "yes" : "no"}`);
    } else if (result.action === "install") {
      console.log(`✓ hub-liaison is ${result.skillState} in Hermes profile ${result.profile}.`);
      console.log(`  ${result.changed ? "installed packaged Agent Fleet copy" : "no skill files changed"}`);
      if (result.backupDir) console.log(`  backup: ${result.backupDir}`);
      console.log(`  gateway: ${result.gatewayRunning ? "running" : "stopped"}`);
      console.log(`  Telegram tools: terminal=${result.tools.terminal ? "enabled" : "disabled"}, file=${result.tools.file ? "enabled" : "disabled"}`);
      if (!result.skillEnabled) console.log(`  action required: enable hub-liaison with: hermes --profile ${result.profile} skills config`);
      if (!result.tools.terminal || !result.tools.file) console.log(`  action required: hermes --profile ${result.profile} tools enable --platform telegram terminal file`);
      if (!result.gatewayRunning) console.log(`  action required: hermes --profile ${result.profile} gateway start`);
      if (result.restarted) console.log("  gateway restarted by explicit --restart");
      else if (result.restartRequired) console.log(`  restart required: hermes --profile ${result.profile} gateway restart`);
      console.log(`  ready: ${result.ready && (!result.restartRequired || result.restarted) ? "yes" : "pending actions above"}`);
    } else if (result.action === "on") {
      console.log(`✓ Hermes Telegram bridge is on: ${result.target}`);
      console.log(`  project: ${result.project}`);
      console.log(`  Hermes profile: ${result.hermesProfile}`);
      console.log(`  workspace: ${result.workspaceId}`);
      console.log(`  pane: ${result.paneId} (hermes-bridge)`);
    } else if (result.closedPaneIds.length > 0) {
      console.log(`✓ Hermes Telegram bridge is off in ${result.workspaceId} (closed ${result.closedPaneIds.join(", ")}).`);
    } else {
      console.log(`✓ Hermes Telegram bridge is already off in ${result.workspaceId}.`);
    }
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

async function cmdInit() {
  await mustBeDirectory(workspace, "workspace");

  printBanner(`agent-fleet v${pkg.version} — guided init`);
  console.log(`Workspace: ${workspace}`);
  console.log(`Source:    ${pkgRoot}`);
  console.log();

  const agent = await chooseAgent(opts.agent);
  console.log(`Coding agent: ${agentLabel(agent)}`);

  const method = resolveMethod(opts.method);

  // Bootstrap the installer artifacts (setup + doctor + the skill they invoke).
  // Without this, the agent has no setup command to hand off to. The command itself
  // is one of the files this writes; the rest of the catalogue (skills, personas,
  // etc.) is the setup workflow's job inside the agent.
  printSection("Bootstrap installer");
  const { written, skipped, removed, warnings } = bootstrap({
    agent,
    sourceRoot: pkgRoot,
    workspace,
    method,
    dryRun: opts["dry-run"],
  });

  for (const w of warnings) console.log(`  ⚠ ${w}`);
  for (const p of removed) {
    const tag = opts["dry-run"] ? "would remove (legacy)" : "removed legacy";
    console.log(`  − ${tag}: ${relative(workspace, p)}`);
  }
  for (const f of written) {
    const tag = opts["dry-run"] ? "would write" : (method === "symlink" ? "linked" : "wrote");
    console.log(`  ✓ ${tag}: ${relative(workspace, f.dest)}`);
  }
  for (const f of skipped) {
    console.log(`  ✗ skipped: ${relative(workspace, f.dest)} — ${f.error}`);
  }
  if (written.length === 0 && skipped.length === 0 && removed.length === 0) {
    console.log("  (nothing to do — sources missing from package)");
  }

  printSection("Next step");
  printHandoff({ agent, method, workspace, source: pkgRoot, version: pkg.version });

  if (opts.launch) {
    tryLaunch(agent, workspace);
  }
}

// Doctor has two repair sources, and the split is deliberate:
//
//   • the engine — for every item the state file records. Repair is `plan()`
//     narrowed to the three breakage states and `apply()` executing it, so a
//     file the doctor restores is byte-identical to one `install` writes. That
//     is the guarantee the whole plan exists for: setup and repair cannot drift.
//   • the legacy scan — for what the state file cannot own: broken links in a
//     pre-engine workspace, and stale persona names inside YAML the manifest
//     does not manage. These need rename heuristics, not a manifest lookup.
//
// Everything else the scan reports (overrides problems, malformed peer entries)
// is advisory: printed, never auto-fixed, because the fix is always a hand edit.
async function cmdDoctor() {
  await mustBeDirectory(workspace, "workspace");

  const ADVISORY_FINDING_TYPES = new Set(["overrides", "yaml-shape"]);
  const plan = buildRepairPlan();
  const repairs = plan?.actions ?? [];

  // The two scans overlap on a broken link that the state file also records.
  // The engine's repair wins — it rebuilds the item in the exact form the
  // manifest declares, where the scan can only guess a replacement from the
  // filename. Letting both fire would have the second collide with the first.
  const enginePaths = new Set(
    repairs.flatMap((a) => [a.target, ...(a.files ?? []).map((f) => f.path)]).filter(Boolean),
  );
  const findings = (await runDoctor({ workspace, sourceRoot: pkgRoot }))
    .filter((f) => !(f.type === "broken-symlink" && enginePaths.has(f.path)));

  const fixable = findings.filter((f) => !ADVISORY_FINDING_TYPES.has(f.type));
  const advisory = findings.length - fixable.length;
  const outstanding = repairs.length + fixable.length;

  // The report comes first, then the question. Asking "apply 7 fixes?" before
  // naming them is asking for a blind yes.
  if (!opts.json) {
    printBanner(`agent-fleet v${pkg.version} — doctor`);
    console.log(`Workspace: ${workspace}`);
    if (!plan) console.log(`Recorded:  ${repairPlanNote}`);

    if (repairs.length > 0) {
      printSection(`Recorded items to repair (${repairs.length})`);
      for (const a of repairs) console.log(`  ${a.id} — ${a.reason}`);
    }
    if (findings.length > 0) {
      printSection(`Scan findings (${findings.length})`);
      console.log(formatFindingsTable(findings));
      if (advisory > 0) {
        console.log(`\n(${advisory} advisory — fix by hand per the suggestions above; never auto-applied)`);
      }
    }
  }

  // --fix is the documented flag; -y stays an alias for the pre-engine muscle
  // memory, and a bare interactive run still asks.
  const wantsFix = Boolean(opts.fix || opts.yes);
  const willFix = outstanding > 0 && !opts["dry-run"] &&
    (wantsFix || (!opts.json && stdin.isTTY && await confirm(
      `\nApply the ${outstanding} suggested fix(es) now? [y/N] `,
    )));

  let applied = null;
  let scanRepair = null;
  if (willFix) {
    if (repairs.length > 0) applied = applyPlan({ plan, manifest: loadManifest(pkgRoot) });
    if (fixable.length > 0) scanRepair = await runDoctor({ workspace, sourceRoot: pkgRoot, apply: true });
  }

  const report = {
    schemaVersion: 1,
    verb: "doctor",
    workspace,
    agent: plan?.agent ?? null,
    packageVersion: pkg.version,
    repairs,
    findings,
    planNote: plan ? null : repairPlanNote,
    applied,
    scanRepair: scanRepair && {
      repaired: scanRepair.repaired, deleted: scanRepair.deleted, skipped: scanRepair.skipped,
    },
    summary: {
      repairs: repairs.length,
      fixable: fixable.length,
      advisories: advisory,
      fixed: willFix ? outstanding - (scanRepair?.skipped ?? 0) - (applied?.summary.failed ?? 0) : 0,
      outstanding: willFix ? (scanRepair?.skipped ?? 0) + (applied?.summary.failed ?? 0) : outstanding,
    },
  };

  if (opts.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    exit(report.summary.outstanding > 0 ? 2 : 0);
  }

  if (outstanding === 0) {
    console.log("\n✓ Nothing to repair: no broken recorded items, no broken symlinks, no stale persona references.");
    exit(findings.length > 0 ? 2 : 0);
  }

  console.log();
  if (!willFix) {
    console.log(
      opts["dry-run"]
        ? `${outstanding} repairable issue(s) found (--dry-run: nothing was written).`
        : `${outstanding} repairable issue(s) found. Re-run with --fix to apply them.`,
    );
    exit(2);
  }

  if (applied) {
    printSection("Repaired");
    for (const r of applied.results) {
      console.log(`  ${r.status.padEnd(8)}  ${r.id}${r.detail ? ` — ${r.detail}` : ""}`);
    }
    console.log(`  state: ${applied.statePath}`);
  }
  if (scanRepair) {
    console.log(
      `\nScan fixes — repaired ${scanRepair.repaired}, deleted ${scanRepair.deleted}, skipped ${scanRepair.skipped}.`,
    );
  }
  console.log(
    report.summary.outstanding > 0
      ? `\n✗ ${report.summary.outstanding} issue(s) could not be repaired — see above.`
      : "\n✓ Doctor finished. Run `agent-fleet verify` to confirm.",
  );
  exit(report.summary.outstanding > 0 ? 2 : 0);
}

let repairPlanNote = null;

/**
 * The engine half of `doctor`. Returns null (with a note) rather than failing
 * when there is nothing to plan against — a workspace with no install record is
 * not broken, it is simply not ours, and the scan still has something to say.
 */
function buildRepairPlan() {
  try {
    return buildPlan({
      workspace,
      sourceRoot: pkgRoot,
      packageVersion: pkg.version,
      manifest: loadManifest(pkgRoot),
      verb: "repair",
      agent: opts.agent && AGENTS.includes(opts.agent) ? opts.agent : null,
    });
  } catch (err) {
    repairPlanNote = err.message;
    return null;
  }
}

async function cmdVerify() {
  // Read-only inspection: manifest × state × disk. Never writes, never fixes.
  // Exit 0 = clean, 2 = findings or broken items, 1 = could not run.
  await mustBeDirectory(workspace, "workspace");

  let manifest;
  try { manifest = loadManifest(pkgRoot); }
  catch (err) { fail(err.message); }

  if (opts.agent && !AGENTS.includes(opts.agent)) {
    fail(`--agent must be one of: ${AGENTS.join(", ")} (got "${opts.agent}")`);
  }

  const agent = opts.agent
    ?? readState(workspace)?.agent
    ?? readLegacyRecord(workspace)?.agent
    ?? detectAgent({ workspace, env: process.env, preferWorkspaceHints: true })
    ?? null;

  const report = await runVerify({
    workspace,
    sourceRoot: pkgRoot,
    packageVersion: pkg.version,
    manifest,
    agent: AGENTS.includes(agent) ? agent : null,
    includeDoctor: !opts["no-doctor"],
  });

  if (opts.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    exit(hasDrift(report) ? 2 : 0);
  }

  printBanner(`agent-fleet v${pkg.version} — verify`);
  console.log(`Workspace: ${report.workspace}`);
  console.log(`Agent:     ${report.agent ? agentLabel(report.agent) : "(unknown)"}`);
  console.log(
    `State:     ${
      report.stateSource === "state-file"  ? `${STATE_REL_PATH} (recorded v${report.recordedVersion})`
      : report.stateSource === "legacy-record" ? `.ai/agent-fleet-setup.md (pre-engine, recorded v${report.recordedVersion ?? "unknown"})`
      : "none — this workspace has no agent-fleet install record"
    }`,
  );

  const s = report.summary;
  console.log(
    `\nItems: ${s.total} catalogued · ${s.installed} recorded · ${s.present} present on disk` +
    `${s.upgradable ? ` · ${s.upgradable} outdated` : ""}${s.broken ? ` · ${s.broken} broken` : ""}`,
  );

  const notable = report.items.filter(
    (i) => !["absent", "not-applicable", "up-to-date", "linked", "unchecked"].includes(i.state),
  );
  if (notable.length > 0) {
    printSection("Items needing attention");
    const width = Math.max(...notable.map((i) => i.state.length));
    for (const item of notable) {
      // The per-file note is the specific one ("link target does not exist");
      // the item note is the general one ("not recorded"). Specific wins.
      const detail = item.files?.[0]?.detail
        ?? item.detail
        ?? (item.changedCount ? `${item.changedCount} file(s) differ` : null);
      console.log(`  ${item.state.padEnd(width)}  ${item.id}${detail ? ` — ${detail}` : ""}`);
    }
  }

  if (report.findings.length > 0) {
    printSection(`Findings (${s.problems} problem(s), ${s.advisories} advisory)`);
    console.log(formatFindingsTable(report.findings));
    if (s.advisories > 0) {
      console.log("\n(advisories are reported but never fail the run)");
    }
  }

  if (s.versionDrift) {
    console.log(
      `\nRecorded v${report.recordedVersion} → package v${report.packageVersion}: an upgrade is available.`,
    );
  }

  console.log();
  if (hasDrift(report)) {
    console.log(`✗ ${s.broken} broken item(s), ${s.problems} problem finding(s).`);
    exit(2);
  }
  console.log(
    s.advisories > 0
      ? `✓ No broken items and no problems (${s.advisories} advisory).`
      : "✓ No broken items and no findings.",
  );
}

// `install`, `upgrade`, and `uninstall` differ only in which action classes
// they admit, so they share one command: build a plan, show it, gate on one
// confirmation, apply it. Every difference between them lives in the planner's
// decision table, not here.
async function cmdPlanVerb(verb) {
  await mustBeDirectory(workspace, "workspace");

  let manifest;
  try { manifest = loadManifest(pkgRoot); }
  catch (err) { fail(err.message); }

  if (opts.agent && !AGENTS.includes(opts.agent)) {
    fail(`--agent must be one of: ${AGENTS.join(", ")} (got "${opts.agent}")`);
  }
  if (opts.method) resolveMethod(opts.method); // refuses symlink outside a checkout
  if (opts["accept-theirs"] && opts["accept-ours"]) {
    fail("--accept-theirs and --accept-ours are mutually exclusive");
  }
  if (verb === "upgrade" && (opts.profile || opts.items)) {
    fail("upgrade acts on what is already installed — use `install` to add items");
  }
  if (verb === "uninstall" && opts.profile) {
    fail("uninstall names items, not profiles — use --items <id[,id]> or --all");
  }

  let profiles = splitList(opts.profile);
  const requested = splitList(opts.items);
  if (verb === "uninstall" && requested.length === 0 && !opts.all) {
    // Removal is the one verb where an empty selection could plausibly mean
    // "everything". It must be said out loud.
    fail("uninstall needs --items <id[,id]> or an explicit --all");
  }
  if (verb === "install" && profiles.length === 0 && requested.length === 0) {
    // A terminal can be asked; a pipe cannot. Guessing a profile for someone
    // scripting this would install a catalogue they never chose.
    if (!stdin.isTTY || opts.yes || opts.json) {
      fail(
        "install needs a selection: --profile <name[,name]> or --items <id[,id]>.\n" +
        `Available profiles: ${Object.keys(manifest.profiles ?? {}).join(", ")}`,
      );
    }
    profiles = [await askProfile(manifest)];
  }

  const agent = opts.agent
    ?? readState(workspace)?.agent
    ?? readLegacyRecord(workspace)?.agent
    ?? detectAgent({ workspace, env: process.env, preferWorkspaceHints: true })
    ?? null;

  let plan;
  try {
    plan = buildPlan({
      workspace,
      sourceRoot: pkgRoot,
      packageVersion: pkg.version,
      manifest,
      verb,
      agent: AGENTS.includes(agent) ? agent : null,
      method: opts.method ?? null,
      profiles,
      items: requested,
      all: Boolean(opts.all),
      allowExec: Boolean(opts["allow-exec"]),
      accept: opts["accept-theirs"] ? "theirs" : opts["accept-ours"] ? "ours" : null,
    });
  } catch (err) { fail(err.message); }

  if (opts["dry-run"]) {
    if (opts.json) {
      process.stdout.write(JSON.stringify(plan, null, 2) + "\n");
      exit(hasConflicts(plan) ? 3 : 0);
    }
    printPlan(plan);
    exit(hasConflicts(plan) ? 3 : 0);
  }

  // Nothing to do is a success, not a prompt.
  if (isNoop(plan)) {
    if (opts.json) {
      process.stdout.write(JSON.stringify({ plan, applied: null }, null, 2) + "\n");
      exit(0);
    }
    printPlan(plan);
    exit(0);
  }

  // The single gate. Past this point apply() runs straight through without
  // asking again — the plan above is what the user is agreeing to.
  if (!opts.yes) {
    if (opts.json) fail("--json requires --yes (or --dry-run): there is nobody to answer the prompt");
    printPlan(plan);
    const overwrites = plan.summary.overwrites;
    const ok = await confirm(
      verb === "uninstall"
        ? `\nRemove ${plan.summary.remove} item(s)? Files you have edited are kept. [y/N] `
        : `\nApply ${plan.summary.changes} change(s)` +
          `${overwrites ? `, overwriting local edits in ${overwrites} item(s)` : ""}? [y/N] `,
    );
    if (!ok) { console.log("Aborted — nothing was written."); exit(0); }
  }

  const applied = applyPlan({ plan, manifest, allowExec: Boolean(opts["allow-exec"]) });

  if (opts.json) {
    process.stdout.write(JSON.stringify({ plan, applied }, null, 2) + "\n");
    exit(applied.summary.failed ? 1 : hasConflicts(plan) ? 3 : 0);
  }

  printApplied(plan, applied);
  exit(applied.summary.failed ? 1 : hasConflicts(plan) ? 3 : 0);
}

function printApplied(plan, applied) {
  const s = applied.summary;
  printBanner(`agent-fleet v${pkg.version} — ${plan.verb}`);
  console.log(`Workspace: ${applied.workspace}`);
  console.log(`Agent:     ${agentLabel(applied.agent)}   Method: ${applied.method}`);

  const notable = applied.results.filter(
    (r) => !["unchanged", "not-reached"].includes(r.status),
  );
  if (notable.length > 0) {
    printSection("Applied");
    const width = Math.max(...notable.map((r) => r.status.length));
    for (const r of notable) {
      console.log(`  ${r.status.padEnd(width)}  ${r.id}${r.detail ? ` — ${r.detail}` : ""}`);
    }
  }

  if (applied.conflictFiles.length > 0) {
    printSection("Conflicts — your files were NOT changed");
    for (const path of applied.conflictFiles) console.log(`  ${path}`);
    console.log(
      "\nEach `.new` file is the incoming version. Compare, merge what you want,\n" +
      "delete the `.new`, or re-run with --accept-theirs / --accept-ours.",
    );
  }

  printOperatorSteps(plan.actions);

  printSection("Summary");
  console.log(
    `  ${s.applied} applied · ${s.adopted} adopted · ${s.removed} removed · ` +
    `${s.skipped} skipped · ${s.unchanged} unchanged`,
  );
  console.log(`  State:  ${applied.statePath}`);
  console.log(`  Record: ${applied.recordPath}`);

  console.log();
  if (applied.failure) {
    console.log(
      `✗ Stopped at ${applied.failure.id}: ${applied.failure.detail}\n` +
      `  ${s.notReached} action(s) not reached. What was applied is recorded — fix the cause and re-run.`,
    );
    return;
  }
  if (applied.conflictFiles.length > 0) {
    console.log(`✓ Applied, with ${s.conflicts} conflict(s) left for you to resolve.`);
    return;
  }
  console.log("✓ Applied. Run `agent-fleet verify` to confirm.");
}

function printPlan(plan) {
  const s = plan.summary;
  printBanner(`agent-fleet v${pkg.version} — ${plan.verb} (dry run)`);
  console.log(`Workspace: ${plan.workspace}`);
  console.log(`Agent:     ${agentLabel(plan.agent)}   Method: ${plan.method}`);
  if (plan.verb === "install") {
    const picked = [
      plan.selection.profiles.length ? `profiles: ${plan.selection.profiles.join(", ")}` : null,
      plan.selection.requested.length ? `items: ${plan.selection.requested.length}` : null,
    ].filter(Boolean).join("   ");
    console.log(`Selection: ${picked} → ${plan.selection.resolved.length} item(s) after closure`);
  } else if (plan.verb === "uninstall") {
    console.log(
      `Removing:  ${plan.selection.resolved.length} recorded item(s)` +
      `${plan.selection.requested.length ? "" : " (--all)"}`,
    );
  } else {
    console.log(
      `Version:   recorded v${plan.recordedVersion ?? "unknown"} → package v${plan.packageVersion}` +
      `${plan.baseAvailable ? "" : "   (no merge base — two-way comparison)"}`,
    );
  }

  if (plan.selection.unknown.length > 0) {
    printSection("Unknown selectors (ignored)");
    for (const id of plan.selection.unknown) console.log(`  ${id}`);
  }

  for (const note of plan.notes) console.log(`\nNote: ${note.detail}`);

  // Only the interesting half. A hundred `keep` lines buries the four that matter.
  const shown = plan.actions.filter((a) => a.kind !== "keep");
  if (shown.length > 0) {
    printSection("Planned actions");
    const width = Math.max(...shown.map((a) => a.kind.length));
    for (const a of shown) {
      console.log(`  ${a.kind.padEnd(width)}  ${a.id}${a.reason ? ` — ${a.reason}` : ""}`);
      for (const f of a.files ?? []) console.log(`  ${" ".repeat(width)}    ${f.state}: ${f.path}`);
    }
  }

  printOperatorSteps(plan.actions);

  printSection("Summary");
  console.log(
    `  ${s.changes} change(s): ${s.create} create · ${s.refresh} refresh · ` +
    `${s.repair} repair · ${s.remove} remove`,
  );
  console.log(
    `  ${s.keep} kept${s.preserved ? ` (${s.preserved} local edit(s) preserved)` : ""}` +
    `${s.overwrites ? ` · ${s.overwrites} overwrite local edits` : ""}`,
  );
  if (s.skip || s.exec || s.external || s.operator) {
    console.log(
      `  not applied: ${s.skip} skipped · ${s.exec} exec · ` +
      `${s.external} external · ${s.operator} operator`,
    );
  }
  if (s.newAvailable > 0 && plan.verb !== "uninstall") {
    console.log(`  ${s.newAvailable} catalogued item(s) not selected — widen with --profile full`);
  }

  console.log();
  if (hasConflicts(plan)) {
    console.log(
      `✗ ${plan.conflicts.length} conflict(s): changed both locally and upstream.\n` +
      "  Resolve with --accept-theirs (take the new version) or --accept-ours (keep yours).",
    );
    return;
  }
  console.log(
    isNoop(plan)
      ? "✓ Nothing to do — the workspace already matches this plan."
      : `✓ Plan is clean: ${s.changes} change(s), no conflicts.`,
  );
}

/**
 * The half of a plan the engine will not perform: Hermes profiles, user systemd
 * units, packages that must be installed by hand. These items exist precisely
 * because their targets sit outside the workspace the engine is allowed to
 * write to, so the only useful thing to emit is the exact command list — which
 * the manifest declares, so it cannot rot away from the artifact it describes.
 */
function printOperatorSteps(actions) {
  const external = actions.filter((a) => a.kind === "external");
  const operator = actions.filter((a) => a.kind === "operator");
  if (external.length === 0 && operator.length === 0) return;

  printSection("Do these yourself — the engine performs none of them");
  for (const a of external) {
    console.log(`  ${a.id}`);
    console.log(`    install the package: ${a.packageSpec ?? "(unspecified)"}`);
  }
  for (const a of operator) {
    console.log(`  ${a.id}`);
    for (const step of a.operatorSteps ?? []) console.log(`    - ${step}`);
    if ((a.operatorSteps ?? []).length === 0) console.log("    - (no steps declared)");
  }
}

/**
 * Validate `--method`, and refuse `symlink` outside an agent-fleet checkout.
 *
 * Symlinks are only sound where the source is meant to be edited in place —
 * that is, in agent-fleet itself. Anywhere else the link target must never move
 * again: an npx cache clean breaks every link at once, and a `git pull` in the
 * source rewrites artifacts the workspace never agreed to change. A copy plus
 * `agent-fleet upgrade` gives the same freshness with none of that.
 *
 * Explicit is refused rather than downgraded — a flag the user typed deserves
 * an answer, not a silent substitution. Workspaces that merely *recorded*
 * symlink from before are migrated to copies by the planner instead.
 *
 * @returns {"copy"|"symlink"} the method to use
 */
function resolveMethod(supplied, fallback = "copy") {
  const method = supplied ?? fallback;
  if (!["copy", "symlink"].includes(method)) {
    fail(`--method must be "copy" or "symlink" (got "${method}")`);
  }
  if (method === "symlink" && !isAgentFleetCheckout(workspace)) {
    if (supplied === "symlink") {
      fail(
        "--method symlink is supported only inside an agent-fleet checkout.\n" +
        "  Everywhere else it breaks as soon as the source moves or an npx cache is cleaned.\n" +
        "  Install with --method copy and keep it current with `agent-fleet upgrade`.",
      );
    }
    return "copy"; // recorded from before the restriction — migrate quietly
  }
  return method;
}

function splitList(value) {
  return (value ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

// A numbered list, not a TUI: this runs inside `npx` on machines whose terminal
// capabilities are unknown, and the flags remain the primary interface.
async function askProfile(manifest) {
  const names = Object.keys(manifest.profiles ?? {});
  if (names.length === 0) fail("the manifest declares no profiles");

  printSection("Which set of artifacts?");
  names.forEach((name, i) => {
    console.log(`  ${i + 1}) ${name.padEnd(16)} ${manifest.profiles[name].title ?? ""}`);
  });

  const answer = (await prompt(`\nProfile [1-${names.length}, or a name]: `)).trim();
  const byIndex = names[Number(answer) - 1];
  const chosen = byIndex ?? names.find((n) => n === answer);
  if (!chosen) fail(`not a profile: "${answer}"`);
  return chosen;
}

async function cmdUpdate() {
  await mustBeDirectory(workspace, "workspace");

  printBanner(`agent-fleet v${pkg.version} — update`);
  console.log(`Workspace: ${workspace}`);
  console.log();

  // npm itself does the package upgrade. The CLI's job here is to read the
  // workspace's install record, surface the version delta, re-install the
  // setup command, and hand off to the skill for the diff-aware
  // refresh.
  const recordPath = join(workspace, ".ai", "agent-fleet-setup.md");
  if (!existsSync(recordPath)) {
    console.log("This workspace has no .ai/agent-fleet-setup.md install record.");
    console.log("Run `npx agent-fleet init` first, then re-run `update` later.");
    exit(1);
  }

  const recorded = readRecordedVersion(recordPath);
  const current  = pkg.version;

  console.log(`Recorded in workspace: v${recorded ?? "(pre-versioning)"}`);
  console.log(`Installed package:     v${current}`);
  console.log();

  // Re-bootstrap the installer artifacts so the runtime's setup command is present
  // after the update. guided-workspace-setup removes these at the end of a
  // run by default (Step 10b / cleanupInstaller), so a workspace that has
  // completed setup once no longer has the command — and `update` used to
  // only print a stale setup instruction while pointing at a command that no
  // longer existed. The marker recovers the agent/method from init time; if
  // it was cleaned up too, fall back to detection (and prompt if ambiguous).
  const marker = readBootstrapMarker(workspace);
  let agent = opts.agent ?? marker?.agent
    ?? detectAgent({ workspace, env: process.env, preferWorkspaceHints: true });
  if (agent && !AGENTS.includes(agent)) agent = null;
  if (!agent) agent = await chooseAgent(opts.agent);

  const method = resolveMethod(opts.method, marker?.method ?? "copy");

  printSection("Refresh installer command");
  const { written, skipped, removed, warnings } = bootstrap({
    agent,
    sourceRoot: pkgRoot,
    workspace,
    method,
    dryRun: opts["dry-run"],
  });
  for (const w of warnings) console.log(`  ⚠ ${w}`);
  for (const p of removed) {
    const tag = opts["dry-run"] ? "would remove (legacy)" : "removed legacy";
    console.log(`  − ${tag}: ${relative(workspace, p)}`);
  }
  for (const f of written) {
    const tag = opts["dry-run"] ? "would write" : (method === "symlink" ? "linked" : "wrote");
    console.log(`  ✓ ${tag}: ${relative(workspace, f.dest)}`);
  }
  for (const f of skipped) {
    console.log(`  ✗ skipped: ${relative(workspace, f.dest)} — ${f.error}`);
  }

  const setupCmd = agent === "claude-code" ? "/setup-agent-fleet" : "/af-setup-agent-fleet";

  printSection("Next step");
  if (recorded === current) {
    console.log(`Recorded version (${recorded}) matches the installed package — no version delta.`);
    console.log(`${setupCmd} is back in your workspace; run it inside ${agentLabel(agent)} if you`);
    console.log("want to re-review your artifacts. To upgrade the package itself, run:");
    console.log("  npm install -g @chankov/agent-fleet@latest    # global");
    console.log("  npx @chankov/agent-fleet@latest update         # one-shot");
    return;
  }
  console.log(`Open ${agentLaunchHint(agent)} in this directory and run:`);
  console.log();
  console.log(`  ${setupCmd}`);
  console.log();
  console.log("The guided-workspace-setup skill will detect the version delta, show the");
  console.log("CHANGELOG between the two versions, and offer a per-artifact three-way diff");
  console.log("before touching any file.");
}

async function cmdCleanupInstaller() {
  // Removes the bootstrap artifacts (setup-agent-fleet, doctor-agent-fleet,
  // guided-workspace-setup skill body) from the workspace. Invoked by the
  // skill itself at the end of Step 10 — keeps the workspace's slash-command
  // list clean. Re-running `init` brings them back.
  await mustBeDirectory(workspace, "workspace");

  const agent = opts.agent ?? detectAgent({ workspace, env: process.env });
  if (!agent || !AGENTS.includes(agent)) {
    fail(`cleanup-installer needs --agent (one of: ${AGENTS.join(", ")})`);
  }

  const { removed, kept, warnings } = cleanupInstaller({
    agent,
    workspace,
    dryRun: opts["dry-run"],
  });

  for (const w of warnings) console.log(`  ⚠ ${w}`);
  for (const p of removed) {
    const tag = opts["dry-run"] ? "would remove" : "removed";
    console.log(`  − ${tag}: ${relative(workspace, p)}`);
  }
  if (removed.length === 0 && warnings.length === 0) {
    console.log("Nothing to clean up — installer files already absent.");
  }
}

async function cmdTransformPersona() {
  // Generates per-agent subagent definitions from the canonical agents/*.md.
  // The guided-workspace-setup skill calls this during apply, so the
  // frontmatter mapping stays deterministic and under test (lib/transform-persona.js).
  const agent = opts.agent;
  if (!agent || !AGENTS.includes(agent)) {
    fail(`transform-persona needs --agent (one of: ${AGENTS.join(", ")})`);
  }

  const available = listPersonas(pkgRoot, { agent });

  if (opts.list) {
    for (const p of available) console.log(`${p.name} → ${p.targetRelPath}`);
    return;
  }

  const names = opts.all ? available.map((p) => p.name) : parsed.positionals;
  if (names.length === 0) {
    fail("name one or more personas, or pass --all / --list");
  }

  // Writing only happens when --workspace is given explicitly; otherwise the
  // transformed content goes to stdout (workspace would default to cwd, which
  // is too easy to splat by accident).
  const wantsWrite = opts.workspace !== undefined;
  if (wantsWrite) await mustBeDirectory(workspace, "workspace");

  for (const name of names) {
    const sourcePath = join(pkgRoot, "agents", `${name}.md`);
    if (!existsSync(sourcePath)) {
      fail(`unknown persona "${name}" — run \`agent-fleet transform-persona --list --agent ${agent}\``);
    }
    let out;
    try {
      out = transformPersona(readFileSync(sourcePath, "utf8"), { agent });
    } catch (err) {
      fail(err.message); // e.g. pi-only persona requested for claude-code
    }
    if (wantsWrite) {
      const dest = join(workspace, out.targetRelPath);
      if (opts["dry-run"]) {
        console.log(`  ✓ would write: ${out.targetRelPath}`);
      } else {
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, out.content);
        console.log(`  ✓ wrote: ${out.targetRelPath}`);
      }
    } else {
      process.stdout.write(out.content);
    }
  }
}

async function cmdCheckUpdate() {
  // Entry point for hook scripts and pi extensions. Blocks on a single
  // registry fetch (short timeout); emits a one-line banner to stdout if an
  // upgrade is available, otherwise prints nothing. Always exits 0 so a
  // failed check never breaks the calling hook.
  const { fetchLatestSync, readCacheStatus, formatBanner, gt } =
    await import("./lib/update-notifier.js");

  let latest = readCacheStatus();
  if (!latest || latest.stale) {
    const fetched = await fetchLatestSync(2000);
    if (fetched) latest = { latest: fetched };
  }
  if (latest?.latest && gt(latest.latest, pkg.version)) {
    process.stdout.write(formatBanner(pkg.version, latest.latest) + "\n");
  }
  exit(0);
}

// ── helpers ───────────────────────────────────────────────────────────────

async function chooseAgent(supplied) {
  if (supplied) {
    if (!AGENTS.includes(supplied)) {
      fail(`--agent must be one of: ${AGENTS.join(", ")} (got "${supplied}")`);
    }
    return supplied;
  }
  const detected = detectAgent({ workspace, env: process.env });
  if (detected) return detected;

  console.log("Could not auto-detect your coding agent.");
  const answer = (await prompt(
    `Which coding agent? [${AGENTS.join("/")}] (claude-code): `,
  )).trim() || "claude-code";

  if (!AGENTS.includes(answer)) {
    fail(`Unknown agent "${answer}". Allowed: ${AGENTS.join(", ")}`);
  }
  return answer;
}

function printHandoff({ agent, method, workspace, source, version }) {
  const rel = relative(process.cwd(), workspace) || ".";
  const setupCmd =
    agent === "claude-code" ? "/setup-agent-fleet" : "/af-setup-agent-fleet";
  const lines = [
    `agent-fleet v${version} is ready.`,
    "",
    `Workspace:       ${rel}`,
    `Coding agent:    ${agentLabel(agent)}`,
    `Install method:  ${method}`,
    `Source root:     ${source}`,
    "",
    `Open ${agentLaunchHint(agent)} in this directory and run:`,
    "",
    `  ${setupCmd}`,
    "",
    "The guided-workspace-setup skill will:",
    "  • analyse the workspace",
    "  • show grouped install menus with recommendations",
    "  • offer project overrides",
    "  • confirm everything before writing a single file",
    "  • remove the installer commands from your workspace at the end so",
    "    they don't pollute your agent's command list (reply 'keep' in",
    "    Step 9 if you'd rather leave them in)",
    "",
  ];
  lines.push("Re-run `npx @chankov/agent-fleet init` later to re-bootstrap (commands are removed by default once setup completes).");
  for (const line of lines) console.log(line);
}

function agentLaunchHint(agent) {
  return { "claude-code": "Claude Code (`claude`)", "pi": "pi (`pi`)" }[agent] || agent;
}

function tryLaunch(agent, cwd) {
  const cmd = { "claude-code": "claude", "pi": "pi" }[agent];
  if (!cmd) return;
  console.log(`\nLaunching: ${cmd} (cwd: ${cwd})`);
  const r = spawnSync(cmd, [], { cwd, stdio: "inherit" });
  if (r.error) {
    console.log(`(could not launch ${cmd}: ${r.error.message})`);
    const setupCmd = agent === "claude-code" ? "/setup-agent-fleet" : "/af-setup-agent-fleet";
    console.log(`Open ${cmd} manually and run ${setupCmd}.`);
  }
}

function readRecordedVersion(path) {
  const text = readFileSync(path, "utf8");
  const m = text.match(/^version:\s*([^\s#]+)/m);
  return m ? m[1].trim() : null;
}

function formatFindingsTable(findings) {
  const rows = findings.map((f, i) => [
    String(i + 1),
    f.path,
    f.issue,
    f.fix,
  ]);
  const headers = ["#", "Path", "Issue", "Suggested fix"];
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length)),
  );
  const pad = (cells) =>
    cells.map((c, i) => c.padEnd(widths[i])).join("  ");
  return [
    pad(headers),
    pad(widths.map((w) => "─".repeat(w))),
    ...rows.map(pad),
  ].join("\n");
}

async function mustBeDirectory(p, label) {
  if (!existsSync(p) || !statSync(p).isDirectory()) {
    fail(`${label} is not a directory: ${p}`);
  }
}

async function prompt(question) {
  const rl = createInterface({ input: stdin, output: stdout });
  try { return await rl.question(question); }
  finally { rl.close(); }
}

async function confirm(question) {
  const ans = (await prompt(question)).trim().toLowerCase();
  return ans === "y" || ans === "yes";
}

function printBanner(text) {
  const bar = "─".repeat(Math.min(text.length, 70));
  console.log(`\n${text}\n${bar}`);
}

function printSection(text) {
  console.log(`\n── ${text} ${"─".repeat(Math.max(0, 60 - text.length))}`);
}

function fail(msg) {
  console.error(`agent-fleet: ${msg}`);
  exit(1);
}

function printHelp(sub) {
  if (sub === "init") {
    console.log(`agent-fleet init [options]

  Materialize the package and hand off to the runtime's Agent Fleet setup command.

Options:
  --agent <claude-code|pi>            Skip the agent auto-detection
  --workspace <path>                  Target workspace (default: cwd)
  --launch                            Attempt to launch the coding agent after init
  -h, --help                          Show this help
`);
    return;
  }
  if (sub === "doctor") {
    console.log(`agent-fleet doctor [options]

  Find and repair breakage. Two sources, one report:

    • recorded items that are missing, dangling, or linked outside the source
      root — repaired through the same apply() path \`install\` writes with, so
      a repaired file is byte-identical to a freshly installed one;
    • broken symlinks and stale persona names the install record cannot own
      (pre-engine workspaces, hand-edited .pi/agents/*.yaml).

  Overrides problems and malformed peers.yaml entries are advisory: reported,
  never auto-fixed, because the fix is always a hand edit.

Options:
  --workspace <path>                  Target workspace (default: cwd)
  --agent <claude-code|pi>            Override the recorded/detected agent
  --fix                               Apply the repairs without prompting
  --dry-run                           Report only; never write, never prompt
  --json                              Emit the machine report on stdout
  -y, --yes                           Alias for --fix
  -h, --help                          Show this help

Exit codes:
  0   nothing to repair
  1   could not run
  2   repairable issues found (or advisory findings), or a repair failed
`);
    return;
  }
  if (sub === "uninstall") {
    console.log(`agent-fleet uninstall [options]

  Remove artifacts agent-fleet installed. Bound by the ownership rule: only
  paths recorded in .ai/agent-fleet-state.json are eligible, and a recorded
  file whose bytes no longer match what we wrote is kept and listed as skipped.
  Nothing else in the workspace is ever touched.

  Removing an item takes its companions with it, unless another installed item
  still needs them; an item another installed item pins is refused by name.

Options:
  --workspace <path>                  Target workspace (default: cwd)
  --items <id[,id]>                   Item ids to remove
  --all                               Remove everything the state file records
  --agent <claude-code|pi>            Override the recorded agent
  --dry-run                           Print the plan, write nothing
  --json                              Emit the machine plan/result on stdout
  -y, --yes                           Skip the confirmation
  -h, --help                          Show this help

Exit codes:
  0   removed (or nothing to remove)
  1   could not plan (no install record, no selection, unknown agent)
`);
    return;
  }
  if (sub === "verify") {
    console.log(`agent-fleet verify [options]

  Read-only inspection of a workspace against the install manifest: what is
  recorded, what is on disk, what differs, and what is broken. Writes nothing.

Options:
  --workspace <path>                  Target workspace (default: cwd)
  --agent <claude-code|pi>            Override the recorded/detected agent
  --json                              Emit the machine report on stdout
  --no-doctor                         Skip the symlink/persona/overrides scan
  -h, --help                          Show this help

Exit codes:
  0   no broken items and no findings
  1   could not run (bad flags, missing manifest, unreadable workspace)
  2   findings, or items in a broken state

An available upgrade (state "outdated") and a deliberate local edit (state
"modified") are reported but do not fail the run.
`);
    return;
  }
  if (sub === "install" || sub === "upgrade") {
    console.log(`agent-fleet ${sub} [options]

  ${sub === "install"
    ? "Install the selected artifacts into a workspace."
    : "Upgrade what this workspace already has to the current package, with a\n  three-way merge against the snapshot of the version it recorded."}

Options:
  --workspace <path>                  Target workspace (default: cwd)
  --agent <claude-code|pi>            Override the recorded/detected agent${sub === "install" ? `
  --profile <name[,name]>             Named selections, unioned
  --items <id[,id]>                   Explicit item ids, added to the profiles` : ""}
  --allow-exec                        Include items that run a command
  --accept-theirs                     Resolve conflicts by taking the new version
  --accept-ours                       Resolve conflicts by keeping the local copy
  --dry-run                           Print the plan, write nothing
  --json                              Emit the machine plan/result on stdout
  -y, --yes                           Skip the confirmation (required with --json)
  -h, --help                          Show this help

Exit codes:
  0   applied, or nothing to do
  1   could not plan, or a write failed partway
  3   conflicts — changed both locally and upstream, needs a decision

${sub === "install"
  ? "A selection never removes anything: installing a narrower profile keeps what\nis already there. Local edits to a selected item ARE overwritten — selecting\nan item is the consent — and every such item is listed as `overwrites`."
  : "Upgrade never widens the install. Locally modified files are preserved, not\noverwritten; artifacts retired upstream are proposed for removal by name."}

Artifacts are installed as copies. --method symlink exists only inside an
agent-fleet checkout, where editing an artifact is meant to edit the source; a
workspace that recorded symlinks before that restriction is migrated to copies
on the next install or upgrade.
`);
    return;
  }
  if (sub === "transform-persona") {
    console.log(`agent-fleet transform-persona --agent <agent> [options] [persona…]

  Generate per-agent subagent definitions from the canonical agents/*.md
  personas. pi gets the canonical file unchanged; claude-code gets a
  transformed copy (tools/model translated, agent-hub-only keys dropped).
  pi-only personas (bowser, orchestrator) are refused for other agents.

Options:
  --agent <claude-code|pi>            Target agent (required)
  --list                              List available personas + target paths
  --all                               Transform every available persona
  --workspace <path>                  Write into <path>/<target>; omit to print to stdout
  --dry-run                           With --workspace: show what would be written
  -h, --help                          Show this help

Examples:
  agent-fleet transform-persona --list --agent claude-code
  agent-fleet transform-persona --agent claude-code code-reviewer
  agent-fleet transform-persona --agent claude-code --all --workspace ~/projects/foo
`);
    return;
  }
  if (sub === "set-hermes-watchdog") {
    console.log(`agent-fleet set-hermes-watchdog <status|install|update|uninstall> [options]

Actions:
  status                 Inspect profile, packaged-skill drift, receipt, and active-lock state
  install | update       Atomically install/reconcile the optional foreground watchdog skill
  uninstall              Remove only a managed unchanged skill tree; preserve config and journals

Options:
  --profile <name>       Hermes profile; required unless exactly one gateway is running
  --force                Back up a drifted tree before replacement/removal
  --dry-run              Report the write that would occur without changing files
  -h, --help             Show this help

No action starts/stops/restarts a gateway, changes tools, kills a watcher, or enables delivery.
Gate O remains fail-closed: without genuine live origin proof the installed watcher is local-journal-only.
`);
    return;
  }
  if (sub === "set-hermes-telegram") {
    console.log(`agent-fleet set-hermes-telegram <action> [arguments] [options]

Actions:
  install                Atomically install/reconcile the packaged hub-liaison skill
  status                 Inspect gateway, skill drift/enabled state, and Telegram tools
  on <id[:topic]>        Start a ready bridge in a new pane in this Herdr workspace
  off <id[:topic]>       Stop bridge panes in this Herdr workspace

Options:
  --profile <name>       Hermes gateway profile; auto-detect only when exactly one runs
  --force                Back up and replace a drifted installed skill
  --restart              Explicitly restart a running gateway after install
  -h, --help             Show this help

The on action fails closed unless hub-liaison is current and enabled, the
profile gateway is running, and Telegram terminal/file tools are enabled.
No action sends a test Telegram message.

Examples:
  agent-fleet set-hermes-telegram status --profile default
  agent-fleet set-hermes-telegram install --profile default
  agent-fleet set-hermes-telegram install --profile default --force --restart
  agent-fleet set-hermes-telegram on 7883056502:1735 --profile default
  agent-fleet set-hermes-telegram off 7883056502:1735
`);
    return;
  }
  if (sub === "update") {
    console.log(`agent-fleet update [options]

  Surface the version delta and re-install the runtime's Agent Fleet setup
  command so it is always present after an update (guided-workspace-setup
  removes it at the end of a run by default). The actual diff-aware refresh
  then runs inside your coding agent via that command.

Options:
  --agent <claude-code|pi>            Override the agent (default: marker → auto-detect)
  --workspace <path>                  Target workspace (default: cwd)
  --dry-run                           Show what would be written; touch nothing
  -h, --help                          Show this help

To upgrade the package itself first:
  npm install -g @chankov/agent-fleet@latest
  npx @chankov/agent-fleet@latest update
`);
    return;
  }
  console.log(`agent-fleet v${pkg.version}

Usage:
  npx agent-fleet <command> [options]

Commands:
  init                Bootstrap installer files + hand off to the setup workflow
  doctor              Find and repair breakage (--fix); advisory findings listed
  verify              Read-only report: manifest × install state × disk (--json)
  install             Install from a profile or explicit item ids
  upgrade             Upgrade what is installed, with a three-way merge
  uninstall           Remove recorded artifacts (--items / --all)
  update              Surface the version delta + hand off to the setup workflow
  check-update        One-line registry check (used by session hooks; safe to script)
  cleanup-installer   Remove the installer slash commands from a workspace (used
                      by the skill at end of setup; safe to run by hand)
  transform-persona   Generate per-agent subagent files from the canonical
                      agents/*.md personas (used by the setup skill during apply)
  set-hermes-telegram Install/status the liaison and start/stop its Herdr bridge
  set-hermes-watchdog Install/status/update/uninstall the fail-closed watchdog skill

Options:
  -v, --version    Print the package version
  -h, --help       Print this help (or per-command help)

Examples:
  npx agent-fleet init
  npx agent-fleet init --agent claude-code --method copy
  npx agent-fleet doctor --workspace ~/projects/foo --fix
  npx agent-fleet verify --agent pi --json
  npx agent-fleet install --agent pi --profile recommended --yes
  npx agent-fleet install --agent pi --profile hermes-plugins --dry-run
  npx agent-fleet upgrade --accept-ours --yes
  npx agent-fleet uninstall --items skill:peer-coms --yes
  npx agent-fleet update
  npx agent-fleet set-hermes-telegram on 7883056502:1735
  npx agent-fleet set-hermes-watchdog status --profile default

Environment:
  AGENT_SKILLS_NO_UPDATE_CHECK=1   Disable the background update check
  NO_UPDATE_NOTIFIER=1             Same (conventional opt-out, also honoured)
  CI=true                          Auto-disables the update check

Docs: https://github.com/chankov/agent-fleet#readme
`);
}
