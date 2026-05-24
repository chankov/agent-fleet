#!/usr/bin/env node
// agent-skills — thin dispatcher into the LLM-driven guided setup.
//
// Three commands:
//   init     materialize the package, detect the coding agent, hand off to /setup
//   doctor   deterministic preflight scan (broken symlinks, stale persona refs)
//   update   refresh the package, then hand off to /setup for the version-diff
//
// The CLI itself never decides which skills to install or what to overwrite —
// that is the job of the guided-workspace-setup skill, run by the user's
// coding agent. We just put the source files where the agent can find them
// and print the next-step command.

import { readFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { stdin, stdout, exit } from "node:process";

import { runDoctor } from "./lib/doctor.js";
import { detectAgent, agentLabel, AGENTS } from "./lib/detect-agent.js";

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

switch (sub) {
  case "init":    await cmdInit();    break;
  case "doctor":  await cmdDoctor();  break;
  case "update":  await cmdUpdate();  break;
  default:        fail(`unknown command: ${sub}\n\nRun "agent-skills --help" for usage.`);
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

  // The CLI doesn't write any skill / persona / command files itself —
  // that is the job of `guided-workspace-setup` running inside the agent.
  // What it CAN do is record the chosen agent + method as a hint the skill
  // will pick up, and print the exact next-step command.
  const method = opts.method ?? "copy";
  if (!["copy", "symlink"].includes(method)) {
    fail(`--method must be "copy" or "symlink" (got "${method}")`);
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
    "Re-run /setup inside your coding agent if you also want to add or remove artifacts.",
  );
}

async function cmdUpdate() {
  await mustBeDirectory(workspace, "workspace");

  printBanner(`agent-skills v${pkg.version} — update`);
  console.log(`Workspace: ${workspace}`);
  console.log();

  // npm itself does the package upgrade. The CLI's job here is to read the
  // workspace's install record, surface the version delta, and tell the user
  // to run /setup so the skill can drive the diff-aware refresh.
  const recordPath = join(workspace, ".ai", "agent-skills-setup.md");
  if (!existsSync(recordPath)) {
    console.log("This workspace has no .ai/agent-skills-setup.md install record.");
    console.log("Run `npx agent-skills init` first, then re-run `update` later.");
    exit(1);
  }

  const recorded = readRecordedVersion(recordPath);
  const current  = pkg.version;

  if (recorded === current) {
    console.log(`Recorded version (${recorded}) matches the installed package.`);
    console.log("Nothing to do. To upgrade the package itself, run:");
    console.log("  npm install -g agent-skills@latest    # global");
    console.log("  npx agent-skills@latest update         # one-shot");
    exit(0);
  }

  console.log(`Recorded in workspace: v${recorded ?? "(pre-versioning)"}`);
  console.log(`Installed package:     v${current}`);
  console.log();
  console.log("Run /setup inside your coding agent — the guided-workspace-setup");
  console.log("skill will detect the version delta, show the CHANGELOG between");
  console.log("the two versions, and offer a per-artifact three-way diff before");
  console.log("touching any file.");
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
  const lines = [
    `agent-skills v${version} is ready.`,
    "",
    `Workspace:       ${rel}`,
    `Coding agent:    ${agentLabel(agent)}`,
    `Install method:  ${method}`,
    `Source root:     ${source}`,
    "",
    "Open your coding agent in this directory and run:",
    "",
    `  /setup`,
    "",
    "The guided-workspace-setup skill will:",
    "  • analyse the workspace",
    "  • show grouped install menus with recommendations",
    "  • offer project overrides",
    "  • confirm everything before writing a single file",
    "",
    "Re-run `npx agent-skills doctor` any time to scan for broken symlinks.",
  ];
  for (const line of lines) console.log(line);
}

function tryLaunch(agent, cwd) {
  const cmd = { "claude-code": "claude", "opencode": "opencode", "pi": "pi" }[agent];
  if (!cmd) return;
  console.log(`\nLaunching: ${cmd} (cwd: ${cwd})`);
  const r = spawnSync(cmd, [], { cwd, stdio: "inherit" });
  if (r.error) {
    console.log(`(could not launch ${cmd}: ${r.error.message})`);
    console.log(`Open ${cmd} manually and run /setup.`);
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

  Materialize the package and hand off to the LLM-driven /setup skill.

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
  if (sub === "update") {
    console.log(`agent-skills update [options]

  Read the workspace's install record and surface the version delta. The
  actual diff-aware refresh runs inside your coding agent via /setup.

Options:
  --workspace <path>   Target workspace (default: cwd)
  -h, --help           Show this help

To upgrade the package itself first:
  npm install -g agent-skills@latest
  npx agent-skills@latest update
`);
    return;
  }
  console.log(`agent-skills v${pkg.version}

Usage:
  npx agent-skills <command> [options]

Commands:
  init       Materialize the package + hand off to /setup in your agent
  doctor     Scan for broken symlinks and stale persona references
  update     Surface the version delta + hand off to /setup for the refresh

Options:
  -v, --version    Print the package version
  -h, --help       Print this help (or per-command help)

Examples:
  npx agent-skills init
  npx agent-skills init --agent claude-code --method copy
  npx agent-skills doctor --workspace ~/projects/foo
  npx agent-skills update

Docs: https://github.com/chankov/agent-skills#readme
`);
}
