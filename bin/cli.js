#!/usr/bin/env node
// agent-fleet — deterministic workspace lifecycle CLI.
//
// setup, doctor, and uninstall are complete without a coding agent or model.
// Legacy command names remain compatibility aliases and route to setup.

import { readFileSync, existsSync, statSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
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
import { buildReconcilePlan } from "./lib/reconcile.js";
import { applyPlan, retryRuntimeRepairs } from "./lib/apply.js";
import { chooseSetup } from "./lib/tui.js";
import { defaultDesired, readDesired } from "./lib/desired.js";
import { purgeHumanConfig } from "./lib/purge.js";
import { recoverTransaction, discardUnrecoverableTransaction, journalPath, transactionRecovery } from "./lib/transaction.js";
import { readState, readLegacyRecord, isAgentFleetCheckout, STATE_REL_PATH } from "./lib/state.js";
import { detectAgent, agentLabel, AGENTS } from "./lib/detect-agent.js";
import { checkAndNotify } from "./lib/update-notifier.js";
import { setHermesTelegram, runHermesCommand } from "./lib/set-hermes-telegram.js";
import { setHermesWatchdog } from "./lib/set-hermes-watchdog.js";
import { runtimeDependencyFindings } from "../scripts/lib/runtime-dependencies.js";

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
        preset:    { type: "string" },
        features:  { type: "string" },
        "save-desired": { type: "boolean" },
        migrate: { type: "boolean" },
        "on-conflict": { type: "string" },
        "purge-config": { type: "boolean" },
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
let repairPlanNote = null;

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
  case "setup":             await cmdSetup();            break;
  case "init":              warnAlias("init"); await cmdSetup(); break;
  case "doctor":            await cmdDoctor();           break;
  case "verify":            await cmdVerify();           break;
  case "install":           warnAlias("install"); await (opts.preset || opts.features ? cmdSetup() : cmdPlanVerb("install")); break;
  case "upgrade":           warnAlias("upgrade"); await cmdPlanVerb("upgrade"); break;
  case "uninstall":         await cmdPlanVerb("uninstall"); break;
  case "update":            warnAlias("update"); await cmdSetup(); break;
  case "check-update":      await cmdCheckUpdate();      break;
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
function warnAlias(name) { console.error(`Warning: ${name} is deprecated; use setup.`); }

async function cmdSetup() {
  await mustBeDirectory(workspace, "workspace");
  if (opts["on-conflict"] !== undefined && !["ours", "theirs"].includes(opts["on-conflict"])) {
    fail('--on-conflict must be "ours" or "theirs"');
  }
  if (opts.method) resolveMethod(opts.method);
  if (opts.items || opts.profile) {
    fail("setup does not accept raw item/profile selectors; use --preset <default|full> and --features <name[,name]> instead");
  }
  const manifest = loadManifest(pkgRoot);
  const dryRun = Boolean(opts["dry-run"]);
  const interactive = !opts.yes && !dryRun;
  if (interactive && !stdin.isTTY) {
    fail("setup mutation requires --yes in non-TTY mode (or use --dry-run to preview)");
  }

  let preset = opts.preset;
  let features = opts.features;
  let tuiDesired = null;
  let setupReadLine = null;
  let setupRl = null;
  if (interactive) {
    setupRl = createInterface({ input: stdin, output: stdout });
    setupReadLine = async () => {
      try { return await setupRl.question(""); } catch { return null; }
    };
    let selection;
    try {
      selection = await chooseSetup({
        output: stdout,
        readLine: setupReadLine,
        manifest,
        currentDesired: readDesired(workspace, manifest),
      });
    } catch (err) {
      setupRl.close();
      fail(err.message);
    }
    if (selection.cancelled) {
      setupRl.close();
      console.log("Aborted — nothing was written.");
      exit(0);
    }
    preset = selection.preset;
    features = selection.features.join(",");
    if (selection.changed) {
      const desired = defaultDesired(manifest);
      desired.preset = preset;
      desired.features = Object.fromEntries(Object.keys(desired.features).map((name) => [name, selection.features.includes(name)]));
      tuiDesired = desired;
    }
  }

  const interactiveMigration = interactive && Boolean(
    readState(workspace) && !existsSync(join(workspace, ".ai", "agent-fleet.json")),
  );
  let plan;
  try {
    plan = buildReconcilePlan({ workspace, sourceRoot: pkgRoot, packageVersion: pkg.version, manifest,
      agent: opts.agent ?? "pi", method: opts.method, preset, features,
      saveDesired: opts["save-desired"], tuiDesired, dryRun,
      allowExec: Boolean(opts["allow-exec"]),
      // The interactive selector and final exact-plan confirmation are the
      // migration consent. Automation retains every explicit gate.
      migrate: opts.migrate || interactiveMigration, yes: opts.yes || interactive,
      accept: opts["on-conflict"] ?? null });
  } catch (err) {
    setupRl?.close();
    fail(err.message);
  }
  if (plan.migrationBlocked) {
    setupRl?.close();
    fail(plan.migrationError);
  }
  if (dryRun) {
    setupRl?.close();
    process.stdout.write(JSON.stringify(plan, null, 2) + "\n");
    exit(plan.conflicts.length ? 3 : 0);
  }
  if ((interactive || opts.yes) && !opts.json) printPlan(plan);
  if (interactive) {
    stdout.write(`\nApply this exact ${plan.firstMigration ? "first-migration " : ""}setup plan? [y/N] `);
    const answer = await setupReadLine();
    setupRl.close();
    if (answer === null || !/^y(es)?$/i.test(answer.trim())) {
      console.log("Aborted — nothing was written.");
      exit(0);
    }
  }
  const execOutput = (line) => (opts.json ? console.error : console.log)(`exec: ${line}`);
  let result = applyPlan({ plan, manifest, allowExec: Boolean(opts["allow-exec"]), output: execOutput });
  if (opts["allow-exec"] && result.exitCode === 0) {
    result = { ...result, retryRuntimeRepair: retryRuntimeRepairs({ workspace, output: execOutput }) };
  }
  if (opts.json) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  else console.log(result.exitCode === 0 ? "Setup complete." : result.failure?.detail ?? "Setup incomplete.");
  exit(result.exitCode);
}

async function cmdDoctor() {
  await mustBeDirectory(workspace, "workspace");

  // Recovery is itself a write, so bare doctor must not even inspect a journal
  // beyond reporting the resulting repairable state. `--fix` recovers first,
  // then plans against the restored ledger.
  const recovery = transactionRecovery(workspace);
  let recoveredTransaction = false;
  let discardedUnrecoverableJournal = false;
  if (opts.fix && !opts["dry-run"] && recovery.pending) {
    try { recoveredTransaction = recoverTransaction(workspace); }
    catch (err) {
      if (!err.unrecoverable) fail(`cannot recover pending transaction: ${err.message}`);
      discardUnrecoverableTransaction(workspace);
      discardedUnrecoverableJournal = true;
    }
  }

  const ADVISORY_FINDING_TYPES = new Set(["overrides", "yaml-shape"]);
  // These findings affect launch readiness and the doctor exit code, but npm
  // execution remains behind its dedicated explicit-consent commands.
  const MANUAL_FINDING_TYPES = new Set(["runtime-dependencies"]);
  const pendingTransaction = existsSync(journalPath(workspace));
  const unrecoverableJournal = recovery.pending && !recovery.recoverable;
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
  if (unrecoverableJournal) findings.unshift({
    type: "unrecoverable-transaction", path: relative(workspace, journalPath(workspace)),
    issue: "transaction backup is missing or unreadable", fix: "discard installer-owned journal with doctor --fix",
  });

  const manual = findings.filter((f) => MANUAL_FINDING_TYPES.has(f.type));
  const fixable = findings.filter((f) =>
    !ADVISORY_FINDING_TYPES.has(f.type) &&
    !MANUAL_FINDING_TYPES.has(f.type) &&
    f.type !== "unrecoverable-transaction"
  );
  const advisory = findings.length - fixable.length - manual.length;
  const pendingRuntime = readState(workspace)?.runtimeRepairs ?? [];
  const repairRoot = (repair) => {
    const index = repair?.args?.indexOf("--prefix") ?? -1;
    const value = index >= 0 ? repair.args[index + 1] : null;
    return typeof value === "string" ? value.replaceAll("\\", "/").replace(/^\.\//, "") : null;
  };
  // A failed setup exec already records one retryable repair. The matching npm
  // finding describes the same broken root and must not double the exit count.
  const pendingDependencyRoots = new Set(pendingRuntime.map(repairRoot).filter(Boolean));
  const manualOutstanding = manual.filter((finding) => !pendingDependencyRoots.has(finding.root));
  const outstanding = repairs.length + fixable.length + manualOutstanding.length + (pendingTransaction ? 1 : 0) + pendingRuntime.length;

  // The report comes first, then the question. Asking "apply 7 fixes?" before
  // naming them is asking for a blind yes.
  if (!opts.json) {
    printBanner(`agent-fleet v${pkg.version} — doctor`);
    console.log(`Workspace: ${workspace}`);
    if (!plan) console.log(`Recorded:  ${repairPlanNote}`);

    if (pendingTransaction) console.log("Pending transaction journal — re-run with --fix to restore the pre-transaction workspace.");
    if (repairs.length > 0) {
      printSection(`Recorded items to repair (${repairs.length})`);
      for (const a of repairs) console.log(`  ${a.id} — ${a.reason}`);
    }
    if (findings.length > 0) {
      printSection(`Scan findings (${findings.length})`);
      console.log(formatFindingsTable(findings));
      if (manual.length > 0) {
        console.log(`\n(${manual.length} launch-blocking dependency finding(s) — use the explicit remediation above; doctor --fix never runs an unplanned npm install)`);
      }
      if (advisory > 0) {
        console.log(`\n(${advisory} advisory — fix by hand per the suggestions above; never auto-applied)`);
      }
    }
  }

  // --fix is the documented flag; -y stays an alias for the pre-engine muscle
  // memory, and a bare interactive run still asks.
  // Doctor is strictly read-only unless --fix is explicit.
  const wantsFix = Boolean(opts.fix);
  const willFix = outstanding > 0 && !opts["dry-run"] && wantsFix;

  let applied = null;
  let scanRepair = null;
  if (willFix) {
    if (repairs.length > 0) applied = applyPlan({ plan, manifest: loadManifest(pkgRoot) });
    if (fixable.length > 0) scanRepair = await runDoctor({ workspace, sourceRoot: pkgRoot, apply: true });
  }

  const runtimeRepairOutput = (line) => (opts.json ? console.error : console.log)(`exec: ${line}`);
  const runtimeRepair = willFix
    ? retryRuntimeRepairs({ workspace, output: runtimeRepairOutput })
    : { attempted: 0, remaining: pendingRuntime };

  let remainingManual = manualOutstanding;
  if (willFix && manual.length > 0) {
    // A recorded npm repair may exit zero without actually producing a healthy
    // tree. Re-run the shared probe and keep any such root outstanding.
    const remainingRepairRoots = new Set(runtimeRepair.remaining.map(repairRoot).filter(Boolean));
    remainingManual = runtimeDependencyFindings({ workspace })
      .filter((finding) => !remainingRepairRoots.has(finding.root));
  }
  const remainingAfterFix = willFix
    ? remainingManual.length + (scanRepair?.skipped ?? 0) + (applied?.summary.failed ?? 0) + runtimeRepair.remaining.length
    : outstanding;

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
    pendingTransaction,
    recoveredTransaction,
    discardedUnrecoverableJournal,
    runtimeRepair,
    scanRepair: scanRepair && {
      repaired: scanRepair.repaired, deleted: scanRepair.deleted, skipped: scanRepair.skipped,
    },
    summary: {
      repairs: repairs.length,
      fixable: fixable.length,
      manual: manual.length,
      advisories: advisory,
      fixed: willFix ? Math.max(0, outstanding - remainingAfterFix) : 0,
      outstanding: remainingAfterFix,
    },
  };

  if (opts.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    exit(report.summary.outstanding > 0 ? 2 : 0);
  }

  if (outstanding === 0) {
    console.log("\n✓ Nothing to repair: recorded items and runtime dependency roots are healthy.");
    exit(0);
  }

  console.log();
  if (!willFix) {
    console.log(
      opts["dry-run"]
        ? `${outstanding} actionable issue(s) found (--dry-run: nothing was written).`
        : manual.length > 0
          ? `${outstanding} actionable issue(s) found. Follow the dependency remediation above; re-run with --fix for auto-fixable items.`
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

  // State may already be gone after a self-uninstall. The separate explicit
  // config-purge gate remains usable in that final state without inventing a
  // new ownership record.
  if (verb === "uninstall" && opts.all && opts["purge-config"] && !readState(workspace)) {
    if (!opts.yes && (!stdin.isTTY || opts.json)) fail("--purge-config requires --yes in non-TTY/JSON mode");
    if (!opts.yes && !await confirm("\nPurge human configuration? [y/N] ")) { console.log("Aborted — nothing was written."); exit(0); }
    const purge = purgeHumanConfig(workspace, { purgeConfig: true });
    if (opts.json) process.stdout.write(JSON.stringify({ plan: null, applied: null, purge }, null, 2) + "\n");
    else if (purge.removed.length) console.log(`Purged human configuration: ${purge.removed.join(", ")}`);
    else console.log("Nothing to purge.");
    exit(0);
  }

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

  // A config purge is independent of state-owned actions, so it must still
  // run after a prior --all removed every recorded item.
  if (isNoop(plan)) {
    if (verb === "uninstall" && opts["purge-config"] && !opts.yes) {
      if (!stdin.isTTY || opts.json) fail("--purge-config requires --yes in non-TTY/JSON mode");
      printPlan(plan);
      if (!await confirm("\nPurge human configuration? [y/N] ")) { console.log("Aborted — nothing was written."); exit(0); }
    }
    const purge = verb === "uninstall" && opts["purge-config"]
      ? purgeHumanConfig(workspace, { purgeConfig: true })
      : null;
    if (opts.json) {
      process.stdout.write(JSON.stringify({ plan, applied: null, purge }, null, 2) + "\n");
      exit(0);
    }
    printPlan(plan);
    if (purge?.removed.length) console.log(`Purged human configuration: ${purge.removed.join(", ")}`);
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
  const purge = verb === "uninstall" && !applied.summary.failed
    ? purgeHumanConfig(workspace, { purgeConfig: Boolean(opts["purge-config"]) })
    : null;

  // A complete --all removal has no remaining lifecycle ownership. Render the
  // report from the in-memory result first, then remove state/record/journal so
  // a self-hosted `just fleet uninstall --yes` can delete its own launcher last.
  const cleanupLifecycle = verb === "uninstall" && opts.all && !applied.summary.failed
    && Object.keys(readState(workspace)?.items ?? {}).length === 0;
  const finishLifecycleCleanup = () => {
    if (!cleanupLifecycle) return;
    for (const path of [STATE_REL_PATH, ".ai/agent-fleet-setup.md", relative(workspace, journalPath(workspace))]) {
      rmSync(join(workspace, path), { force: true });
    }
  };

  if (opts.json) {
    process.stdout.write(JSON.stringify({ plan, applied, purge }, null, 2) + "\n");
    finishLifecycleCleanup();
    exit(applied.summary.failed ? 1 : hasConflicts(plan) ? 3 : 0);
  }

  printApplied(plan, applied);
  if (purge?.removed.length) console.log(`Purged human configuration: ${purge.removed.join(", ")}`);
  else if (verb === "uninstall" && purge?.preserved.length) console.log(`Preserved human configuration: ${purge.preserved.join(", ")} (use --purge-config to remove)`);
  finishLifecycleCleanup();
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
      (plan.verb === "upgrade"
        ? "delete the `.new`, or re-run upgrade with --accept-theirs or --accept-ours."
        : "delete the `.new`, or re-run setup with --on-conflict theirs|ours."),
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
  printBanner(`agent-fleet v${pkg.version} — ${plan.verb} plan`);
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
      for (const path of a.paths ?? []) console.log(`  ${" ".repeat(width)}    state-owned deletion: ${path}`);
    }
  }

  printConfigurationWrites(plan);
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
    const resolveHint = plan.verb === "upgrade"
      ? "  Resolve with --accept-theirs (take the new version) or --accept-ours (keep yours)."
      : "  Resolve with --on-conflict theirs (take the new version) or --on-conflict ours (keep yours).";
    console.log(
      `✗ ${plan.conflicts.length} conflict(s): changed both locally and upstream.\n` +
      resolveHint,
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
function printConfigurationWrites(plan) {
  const writes = [
    plan.writeDesired ? plan.desiredPath : null,
    plan.overrides?.write ? plan.overrides.path : null,
    plan.stt?.path ?? null,
    plan.stt?.env?.missing?.length ? plan.stt.env.path : null,
  ].filter(Boolean);
  if (writes.length === 0) return;
  printSection("Configuration writes");
  for (const path of [...new Set(writes)].sort()) console.log(`  ${relative(plan.workspace, path)}`);
  if (plan.stt?.env?.missing?.length && !isGitignored(plan.workspace, ".env")) {
    console.log("  Warning: .env is not covered by the target .gitignore; it may be committed.");
  }
}

function isGitignored(workspace, path) {
  const ignore = join(workspace, ".gitignore");
  if (!existsSync(ignore)) return false;
  return readFileSync(ignore, "utf8").split(/\r?\n/).some((line) => {
    const rule = line.trim();
    return rule === path || rule === `/${path}` || rule === "*";
  });
}

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

// pi is the only coding agent Agent Fleet installs for, so there is nothing to
// ask: `--agent` is still honoured (and still validated) so scripts written
// against the old flag keep working and a wrong value fails loudly.
function chooseAgent(supplied) {
  if (supplied && !AGENTS.includes(supplied)) {
    fail(`--agent must be one of: ${AGENTS.join(", ")} (got "${supplied}")`);
  }
  return supplied ?? detectAgent();
}

function agentLaunchHint(agent) {
  return { "pi": "pi (`pi`)" }[agent] || agent;
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
  if (sub === "setup") {
    console.log(`agent-fleet setup [options]

  Reconcile the workspace to a Default or Full desired state. In a TTY without
  --yes, the interactive selector explains Default, Full, and experimental
  opt-in, then shows the exact plan before writing. Non-TTY mutations require
  --yes; --dry-run always writes nothing.

Options:
  --workspace <path>                  Target workspace (default: cwd)
  --preset <default|full>              Desired preset
  --features <name[,name]|none>        Exact feature opt-ins
  --save-desired                       Persist CLI overrides to .ai/agent-fleet.json
  --migrate                            Permit non-interactive first migration (with explicit preset/features and --yes)
  --allow-exec                         Run consented runtime commands after the file transaction
  --on-conflict <ours|theirs>           Resolve a three-way conflict before the transaction
  --dry-run                            Print a plan; write nothing
  --json                               Emit a machine-readable plan/result (--yes applies)
  -y, --yes                            Consent to non-interactive mutation
  -h, --help                           Show this help

Resolve conflicts with --on-conflict theirs (take the package version) or
--on-conflict ours (keep the local copy).
`);
    return;
  }
  if (sub === "init") {
    console.log(`agent-fleet init [options]

  Materialize the package and hand off to the runtime's Agent Fleet setup command.

Options:
  --agent pi                          Coding agent (pi is the only target)
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
  --agent pi                          Coding agent (pi is the only target)
  --fix                               Apply the repairs without prompting
  --dry-run                           Report only; never write, never prompt
  --json                              Emit the machine report on stdout
  -y, --yes                           Alias for --fix
  -h, --help                          Show this help

Exit codes:
  0   nothing to repair
  1   could not run
  2   repairable issues found, pending runtime repair, or a repair failed
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
  --agent pi                          Coding agent (pi is the only target)
  --dry-run                           Print the plan, write nothing
  --json                              Emit the machine plan/result on stdout
  --purge-config                       Also remove .ai desired/override/STT config (requires consent)
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
  --agent pi                          Coding agent (pi is the only target)
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
  --agent pi                          Coding agent (pi is the only target)${sub === "install" ? `
  --profile <name[,name]>             Named selections, unioned
  --items <id[,id]>                   Explicit item ids, added to the profiles` : ""}
  --allow-exec                        Include items that run a command
  --accept-theirs                     Resolve conflicts by taking the new version
  --accept-ours                       Resolve conflicts by keeping the local copy
  --dry-run                           Print the plan, write nothing
  --json                              Emit the machine plan/result on stdout
  -y, --yes                           Skip the confirmation (required with --json)
  -h, --help                          Show this help

Resolve conflicts with --accept-theirs (take the new version) or --accept-ours
(keep the local copy). upgrade does not support setup's --on-conflict flag.

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
  command so it is always present after an update (deterministic setup CLI
  removes it at the end of a run by default). The actual diff-aware refresh
  then runs inside your coding agent via that command.

Options:
  --agent pi                          Coding agent (pi is the only target)
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
  init                Compatibility alias for setup
  doctor              Find and repair breakage (--fix); advisory findings listed
  verify              Read-only report: manifest × install state × disk (--json)
  install             Install from a profile or explicit item ids
  upgrade             Upgrade what is installed, with a three-way merge
  setup               Reconcile Default/Full desired state (interactive in a TTY)
  uninstall           Remove recorded artifacts (--items / --all)
  update              Compatibility alias for setup
  check-update        One-line registry check (used by session hooks; safe to script)
  set-hermes-telegram Install/status the liaison and start/stop its Herdr bridge
  set-hermes-watchdog Install/status/update/uninstall the fail-closed watchdog skill

Options:
  -v, --version    Print the package version
  -h, --help       Print this help (or per-command help)

Examples:
  npx agent-fleet setup --preset default --features none --yes
  npx agent-fleet init
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
