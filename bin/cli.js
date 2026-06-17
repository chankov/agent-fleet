#!/usr/bin/env node
// agent-skills — thin dispatcher into the LLM-driven guided setup.
//
// Main commands:
//   init               materialize the package, detect the coding agent, hand off to /setup-agent-skills
//   doctor             deterministic preflight scan (broken symlinks, stale persona refs)
//   update             refresh the package, then hand off to /setup-agent-skills for the version-diff
//   transform-persona  generate per-agent subagent files from the canonical agents/*.md
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
import { listPersonas, transformPersona } from "./lib/transform-persona.js";
import { detectAgent, agentLabel, AGENTS } from "./lib/detect-agent.js";
import { checkAndNotify } from "./lib/update-notifier.js";
import { bootstrap, cleanupInstaller, readBootstrapMarker } from "./lib/bootstrap.js";

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
        "dry-run": { type: "boolean" },
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
if (sub !== "update" && sub !== "check-update") {
  checkAndNotify(pkg.version);
}

switch (sub) {
  case "init":              await cmdInit();             break;
  case "doctor":            await cmdDoctor();           break;
  case "update":            await cmdUpdate();           break;
  case "check-update":      await cmdCheckUpdate();      break;
  case "cleanup-installer":  await cmdCleanupInstaller();  break;
  case "transform-persona":  await cmdTransformPersona();  break;
  default:                  fail(`unknown command: ${sub}\n\nRun "agent-skills --help" for usage.`);
}

// ── commands ──────────────────────────────────────────────────────────────

async function cmdInit() {
  await mustBeDirectory(workspace, "workspace");

  printBanner(`agent-skills v${pkg.version} — guided init`);
  console.log(`Workspace: ${workspace}`);
  console.log(`Source:    ${pkgRoot}`);
  console.log();

  const agent = await chooseAgent(opts.agent);
  console.log(`Coding agent: ${agentLabel(agent)}`);

  const method = opts.method ?? "copy";
  if (!["copy", "symlink"].includes(method)) {
    fail(`--method must be "copy" or "symlink" (got "${method}")`);
  }

  // Bootstrap the installer artifacts (setup + doctor + the skill they invoke).
  // Without this, the agent has no /setup-agent-skills command to hand off to — the
  // /setup-agent-skills command is itself one of the files this writes. The rest of the
  // catalogue (skills, personas, etc.) is the job of /setup-agent-skills running inside
  // the agent; we only drop the plumbing it needs to exist.
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

async function cmdDoctor() {
  await mustBeDirectory(workspace, "workspace");

  printBanner(`agent-skills v${pkg.version} — doctor scan`);
  console.log(`Workspace: ${workspace}`);
  console.log();

  const findings = await runDoctor({ workspace, sourceRoot: pkgRoot });

  if (findings.length === 0) {
    console.log("✓ No broken symlinks or stale persona references found.");
    exit(0);
  }

  console.log(`Found ${findings.length} issue(s):\n`);
  console.log(formatFindingsTable(findings));
  console.log();

  if (opts["dry-run"]) {
    console.log("(--dry-run set: no fixes applied)");
    exit(0);
  }

  const apply = opts.yes
    ? true
    : await confirm("Apply the suggested fixes now? [y/N] ");

  if (!apply) {
    console.log("No changes made. Re-run without --dry-run to apply.");
    exit(0);
  }

  const { repaired, deleted, skipped } = await runDoctor({
    workspace,
    sourceRoot: pkgRoot,
    apply:      true,
  });

  console.log(
    `\n✓ Doctor finished — repaired ${repaired}, deleted ${deleted}, skipped ${skipped}.`,
  );
  console.log(
    "Re-run /setup-agent-skills inside your coding agent if you also want to add or remove artifacts.",
  );
}

async function cmdUpdate() {
  await mustBeDirectory(workspace, "workspace");

  printBanner(`agent-skills v${pkg.version} — update`);
  console.log(`Workspace: ${workspace}`);
  console.log();

  // npm itself does the package upgrade. The CLI's job here is to read the
  // workspace's install record, surface the version delta, re-install the
  // /setup-agent-skills command, and hand off to the skill for the diff-aware
  // refresh.
  const recordPath = join(workspace, ".ai", "agent-skills-setup.md");
  if (!existsSync(recordPath)) {
    console.log("This workspace has no .ai/agent-skills-setup.md install record.");
    console.log("Run `npx agent-skills init` first, then re-run `update` later.");
    exit(1);
  }

  const recorded = readRecordedVersion(recordPath);
  const current  = pkg.version;

  console.log(`Recorded in workspace: v${recorded ?? "(pre-versioning)"}`);
  console.log(`Installed package:     v${current}`);
  console.log();

  // Re-bootstrap the installer artifacts so /setup-agent-skills is present
  // after the update. guided-workspace-setup removes these at the end of a
  // run by default (Step 10b / cleanupInstaller), so a workspace that has
  // completed setup once no longer has the command — and `update` used to
  // only print "run /setup-agent-skills" while pointing at a command that no
  // longer existed. The marker recovers the agent/method from init time; if
  // it was cleaned up too, fall back to detection (and prompt if ambiguous).
  const marker = readBootstrapMarker(workspace);
  let agent = opts.agent ?? marker?.agent
    ?? detectAgent({ workspace, env: process.env, preferWorkspaceHints: true });
  if (agent && !AGENTS.includes(agent)) agent = null;
  if (!agent) agent = await chooseAgent(opts.agent);

  const method = opts.method ?? marker?.method ?? "copy";
  if (!["copy", "symlink"].includes(method)) {
    fail(`--method must be "copy" or "symlink" (got "${method}")`);
  }

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

  const setupCmd = agent === "opencode" ? "/as-setup-agent-skills" : "/setup-agent-skills";

  printSection("Next step");
  if (recorded === current) {
    console.log(`Recorded version (${recorded}) matches the installed package — no version delta.`);
    console.log(`${setupCmd} is back in your workspace; run it inside ${agentLabel(agent)} if you`);
    console.log("want to re-review your artifacts. To upgrade the package itself, run:");
    console.log("  npm install -g @chankov/agent-skills@latest    # global");
    console.log("  npx @chankov/agent-skills@latest update         # one-shot");
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
  // Removes the bootstrap artifacts (setup-agent-skills, doctor-agent-skills,
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
      fail(`unknown persona "${name}" — run \`agent-skills transform-persona --list --agent ${agent}\``);
    }
    let out;
    try {
      out = transformPersona(readFileSync(sourcePath, "utf8"), { agent });
    } catch (err) {
      fail(err.message); // e.g. pi-only persona requested for claude-code/opencode
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
    agent === "opencode" ? "/as-setup-agent-skills" : "/setup-agent-skills";
  const lines = [
    `agent-skills v${version} is ready.`,
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
  if (agent === "opencode") {
    lines.push(
      "OpenCode note: project-local skill discovery is limited. If",
      "/as-setup-agent-skills does not load the skill, follow",
      "docs/opencode-setup.md to link it into ~/.config/opencode/skills/",
      "and add a reference in AGENTS.md.",
      "",
    );
  }
  lines.push("Re-run `npx @chankov/agent-skills init` later to re-bootstrap (commands are removed by default once setup completes).");
  for (const line of lines) console.log(line);
}

function agentLaunchHint(agent) {
  return { "claude-code": "Claude Code (`claude`)", "opencode": "OpenCode (`opencode`)", "pi": "pi (`pi`)" }[agent] || agent;
}

function tryLaunch(agent, cwd) {
  const cmd = { "claude-code": "claude", "opencode": "opencode", "pi": "pi" }[agent];
  if (!cmd) return;
  console.log(`\nLaunching: ${cmd} (cwd: ${cwd})`);
  const r = spawnSync(cmd, [], { cwd, stdio: "inherit" });
  if (r.error) {
    console.log(`(could not launch ${cmd}: ${r.error.message})`);
    console.log(`Open ${cmd} manually and run /setup-agent-skills.`);
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
  console.error(`agent-skills: ${msg}`);
  exit(1);
}

function printHelp(sub) {
  if (sub === "init") {
    console.log(`agent-skills init [options]

  Materialize the package and hand off to the LLM-driven /setup-agent-skills skill.

Options:
  --agent <claude-code|opencode|pi>   Skip the agent auto-detection
  --method <copy|symlink>             Default install method (default: copy)
  --workspace <path>                  Target workspace (default: cwd)
  --launch                            Attempt to launch the coding agent after init
  -h, --help                          Show this help
`);
    return;
  }
  if (sub === "doctor") {
    console.log(`agent-skills doctor [options]

  Scan the workspace for broken symlinks and stale persona references.

Options:
  --workspace <path>   Target workspace (default: cwd)
  --dry-run            Show findings, do not apply fixes
  -y, --yes            Apply all suggested fixes without prompting
  -h, --help           Show this help
`);
    return;
  }
  if (sub === "transform-persona") {
    console.log(`agent-skills transform-persona --agent <agent> [options] [persona…]

  Generate per-agent subagent definitions from the canonical agents/*.md
  personas. pi gets the canonical file unchanged; claude-code and opencode get
  a transformed copy (tools/model translated, agent-hub-only keys dropped).
  pi-only personas (bowser, orchestrator) are refused for other agents.

Options:
  --agent <claude-code|opencode|pi>   Target agent (required)
  --list                              List available personas + target paths
  --all                               Transform every available persona
  --workspace <path>                  Write into <path>/<target>; omit to print to stdout
  --dry-run                           With --workspace: show what would be written
  -h, --help                          Show this help

Examples:
  agent-skills transform-persona --list --agent claude-code
  agent-skills transform-persona --agent claude-code code-reviewer
  agent-skills transform-persona --agent opencode --all --workspace ~/projects/foo
`);
    return;
  }
  if (sub === "update") {
    console.log(`agent-skills update [options]

  Surface the version delta and re-install the /setup-agent-skills command so
  it is always present after an update (guided-workspace-setup removes it at
  the end of a run by default). The actual diff-aware refresh then runs inside
  your coding agent via /setup-agent-skills.

Options:
  --agent <claude-code|opencode|pi>   Override the agent (default: marker → auto-detect)
  --method <copy|symlink>             Install method for the command (default: copy)
  --workspace <path>                  Target workspace (default: cwd)
  --dry-run                           Show what would be written; touch nothing
  -h, --help                          Show this help

To upgrade the package itself first:
  npm install -g @chankov/agent-skills@latest
  npx @chankov/agent-skills@latest update
`);
    return;
  }
  console.log(`agent-skills v${pkg.version}

Usage:
  npx agent-skills <command> [options]

Commands:
  init                Bootstrap installer files + hand off to /setup-agent-skills-agent-skills
  doctor              Scan for broken symlinks and stale persona references
  update              Surface the version delta + hand off to /setup-agent-skills-agent-skills
  check-update        One-line registry check (used by session hooks; safe to script)
  cleanup-installer   Remove the installer slash commands from a workspace (used
                      by the skill at end of setup; safe to run by hand)
  transform-persona   Generate per-agent subagent files from the canonical
                      agents/*.md personas (used by the setup skill during apply)

Options:
  -v, --version    Print the package version
  -h, --help       Print this help (or per-command help)

Examples:
  npx agent-skills init
  npx agent-skills init --agent claude-code --method copy
  npx agent-skills doctor --workspace ~/projects/foo
  npx agent-skills update

Environment:
  AGENT_SKILLS_NO_UPDATE_CHECK=1   Disable the background update check
  NO_UPDATE_NOTIFIER=1             Same (conventional opt-out, also honoured)
  CI=true                          Auto-disables the update check

Docs: https://github.com/chankov/agent-skills#readme
`);
}
