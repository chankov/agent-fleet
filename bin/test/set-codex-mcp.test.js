import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  MINIMUM_NODE,
  RUNTIME_RELATIVE,
  SERVER_NAME,
  SKILL_NAME,
  compareNodeVersion,
  evaluateMcpEntry,
  inspectCodexMcp,
  launcherFingerprint,
  parseSetCodexMcpArgs,
  resolveCodexMcpLayout,
  setCodexMcp,
  validateLayout,
} from "../lib/set-codex-mcp.js";
import { extractSkillZip } from "../lib/skill-zip.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const disposables = [];

test.after(() => {
  for (const root of disposables) rmSync(root, { recursive: true, force: true });
});

/** A private HOME/CODEX_HOME pair, an operator cwd, and a Codex CLI stub that only answers reads. */
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "set-codex-mcp-")));
  disposables.push(root);
  const home = join(root, "home");
  const codexHome = join(home, ".codex");
  const registryRoot = join(root, "coms");
  const project = join(root, "project");
  for (const dir of [codexHome, registryRoot, project]) mkdirSync(dir, { recursive: true });
  const calls = [];
  const f = {
    root, home, codexHome, registryRoot, project, calls,
    globalEntries: [],
    cwdEntries: null,
    codex: async (args, { cwd } = {}) => {
      calls.push({ args, cwd });
      if (args.join(" ") === "--version") return "codex-cli 0.166.0\n";
      if (args.join(" ") !== "mcp list --json") throw new Error(`unexpected codex call: ${args.join(" ")}`);
      const entries = cwd === codexHome ? f.globalEntries : (f.cwdEntries ?? f.globalEntries);
      return JSON.stringify(entries) + "\n";
    },
  };
  return f;
}

function options(f, positionals, extra = {}) {
  return {
    positionals,
    packageRoot: repoRoot,
    env: { CODEX_HOME: f.codexHome, PI_COMS_DIR: f.registryRoot },
    home: f.home,
    cwd: f.project,
    codex: f.codex,
    nodeVersion: "v25.0.0",
    ...extra,
  };
}

function layoutOf(f, extra = {}) {
  const { positionals: _ignored, codex: _codex, nodeVersion: _node, ...rest } = options(f, ["status"], extra);
  return resolveCodexMcpLayout(rest);
}

/** The entry `codex mcp list --json` prints for a registration made by this command. */
function entryFor(launcher, overrides = {}) {
  return {
    name: SERVER_NAME,
    enabled: true,
    disabled_reason: null,
    transport: { type: "stdio", command: launcher.command, args: [...launcher.args], env: null, env_vars: [], cwd: null },
    startup_timeout_sec: null,
    tool_timeout_sec: null,
    auth_status: "unsupported",
    ...overrides,
  };
}

function snapshot(root) {
  const seen = [];
  const visit = dir => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      seen.push([relative(root, path), stat.isDirectory() ? "dir" : stat.isSymbolicLink() ? "link" : `file:${stat.size}:${stat.mtimeMs}`]);
      if (stat.isDirectory()) visit(path);
    }
  };
  visit(root);
  return seen;
}

function listCalls(f) {
  return f.calls.map(call => `${call.args.join(" ")} @ ${call.cwd}`);
}

test("parser accepts only the four lifecycle verbs", () => {
  for (const action of ["status", "install", "update", "uninstall"]) assert.deepEqual(parseSetCodexMcpArgs([action]), { action });
  for (const argv of [[], ["status", "extra"], ["start"], ["remove"]]) assert.throws(() => parseSetCodexMcpArgs(argv), /Usage: agent-fleet set-codex-mcp/);
});

test("layout defaults come from CODEX_HOME, PI_COMS_DIR, the running Node, and the package runtime", () => {
  const f = fixture();
  const layout = layoutOf(f);
  assert.equal(layout.codexHome, f.codexHome);
  assert.equal(layout.stateDir, join(f.codexHome, "agent-fleet"));
  assert.equal(layout.registryRoot, f.registryRoot);
  assert.equal(layout.policyRoot, join(f.codexHome, "agent-fleet", "state", "fleet-native"));
  assert.equal(layout.hostProfile, "desktop");
  assert.equal(layout.principal, "local-user");
  assert.equal(layout.legacyStateRoot, null);
  assert.equal(layout.runtimePath, join(repoRoot, RUNTIME_RELATIVE));
  assert.equal(layout.launcher.command, process.execPath);
  assert.deepEqual(layout.launcher.args, [
    layout.runtimePath,
    "--registry-root", f.registryRoot,
    "--policy-root", layout.policyRoot,
    "--host-profile", "desktop",
    "--principal", "local-user",
  ]);
  assert.equal(layout.receipts.mcp, join(f.codexHome, "agent-fleet", `${SERVER_NAME}.receipt.json`));
  assert.equal(layout.receipts.skill, join(f.codexHome, "agent-fleet", `${SKILL_NAME}.receipt.json`));
  assert.equal(layout.skillDir, join(f.home, ".agents", "skills", SKILL_NAME));
  assert.equal(layout.skillZip, join(repoRoot, "skills", `${SKILL_NAME}.zip`));
  assert.equal(layout.operatorCwd, f.project);
});

test("explicit launcher options override every default and append the legacy root last", () => {
  const f = fixture();
  const legacy = join(f.root, "legacy");
  const layout = layoutOf(f, {
    node: "/opt/node/bin/node",
    registryRoot: join(f.root, "registry"),
    policyRoot: join(f.root, "policy"),
    hostProfile: "laptop",
    principal: "me",
    legacyStateRoot: legacy,
  });
  assert.equal(layout.launcher.command, "/opt/node/bin/node");
  assert.deepEqual(layout.launcher.args.slice(1), [
    "--registry-root", join(f.root, "registry"),
    "--policy-root", join(f.root, "policy"),
    "--host-profile", "laptop",
    "--principal", "me",
    "--legacy-state-root", legacy,
  ]);
  const withoutCodexHome = resolveCodexMcpLayout({ packageRoot: repoRoot, env: {}, home: f.home, cwd: f.project });
  assert.equal(withoutCodexHome.codexHome, join(f.home, ".codex"));
  assert.equal(withoutCodexHome.registryRoot, join(f.home, ".pi", "coms"));
});

test("Node versions compare numerically against the runtime minimum", () => {
  assert.equal(MINIMUM_NODE, "22.18.0");
  assert.ok(compareNodeVersion("v22.18.0", MINIMUM_NODE) >= 0);
  assert.ok(compareNodeVersion("v22.17.9", MINIMUM_NODE) < 0);
  assert.ok(compareNodeVersion("v25.2.1", MINIMUM_NODE) > 0);
  assert.ok(compareNodeVersion("v9.99.99", MINIMUM_NODE) < 0);
  assert.throws(() => compareNodeVersion("weird", MINIMUM_NODE), /Node version/);
});

test("status on an empty host reports missing state, no shadow, and writes nothing", async () => {
  const f = fixture();
  const before = snapshot(f.root);
  const status = await setCodexMcp(options(f, ["status"]));
  assert.equal(status.action, "status");
  assert.equal(status.mcpState, "missing");
  assert.equal(status.mcpEntry, null);
  assert.equal(status.mcpReceiptState, "unmanaged");
  assert.equal(status.skillState, "missing");
  assert.equal(status.skillReceiptState, "unmanaged");
  assert.deepEqual(status.projectShadow, { shadowed: false, transport: null });
  assert.equal(status.nodeVersion, "v25.0.0");
  assert.equal(status.codexCwd, f.codexHome);
  assert.equal(status.operatorCwd, f.project);
  assert.deepEqual(status.errors, []);
  assert.deepEqual(status.warnings.filter(warning => !/nvm/.test(warning)), []);
  assert.deepEqual(snapshot(f.root), before, "status leaves HOME and CODEX_HOME byte-for-byte untouched");
  assert.deepEqual(listCalls(f), [`mcp list --json @ ${f.codexHome}`, `mcp list --json @ ${f.project}`]);
});

test("status falls back to HOME as the global view when CODEX_HOME does not exist yet", async () => {
  const f = fixture();
  rmSync(f.codexHome, { recursive: true });
  const status = await inspectCodexMcp(options(f, ["status"]));
  assert.equal(status.codexCwd, f.home);
  assert.equal(status.mcpState, "missing");
  assert.equal(existsSync(f.codexHome), false);
});

test("the MCP entry state follows the launcher match, the receipt, and the files on disk", async () => {
  const f = fixture();
  const layout = layoutOf(f);
  const desired = layout.launcher;

  f.globalEntries = [entryFor(desired)];
  let status = await inspectCodexMcp(options(f, ["status"]));
  assert.equal(status.mcpState, "adoptable");
  assert.deepEqual(status.mcpEntry, f.globalEntries[0].transport);
  assert.equal(status.mcpEnabled, true);

  mkdirSync(layout.stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(layout.receipts.mcp, JSON.stringify({ schemaVersion: 1, name: SERVER_NAME, fingerprint: launcherFingerprint(desired), launcher: desired }) + "\n", { mode: 0o600 });
  status = await inspectCodexMcp(options(f, ["status"]));
  assert.equal(status.mcpState, "current");
  assert.equal(status.mcpReceiptState, "managed");

  writeFileSync(layout.receipts.mcp, JSON.stringify({ schemaVersion: 1, name: SERVER_NAME, fingerprint: "forged" }) + "\n");
  status = await inspectCodexMcp(options(f, ["status"]));
  assert.equal(status.mcpState, "drifted");
  assert.equal(status.mcpReceiptState, "drifted");
  rmSync(layout.receipts.mcp);

  f.globalEntries = [entryFor({ command: desired.command, args: desired.args.map(arg => (arg === "desktop" ? "personal-local-smoke" : arg)) })];
  assert.equal((await inspectCodexMcp(options(f, ["status"]))).mcpState, "drifted");

  f.globalEntries = [entryFor(desired, { enabled: false, disabled_reason: "user" })];
  status = await inspectCodexMcp(options(f, ["status"]));
  assert.equal(status.mcpState, "drifted");
  assert.equal(status.mcpEnabled, false);

  f.globalEntries = [entryFor(desired)];
  f.globalEntries[0].transport.env = { FLEET_DEBUG: "1" };
  assert.equal((await inspectCodexMcp(options(f, ["status"]))).mcpState, "drifted");

  f.globalEntries = [entryFor({ command: join(f.root, "missing-node"), args: desired.args })];
  assert.equal((await inspectCodexMcp(options(f, ["status"]))).mcpState, "broken");
  f.globalEntries = [entryFor({ command: desired.command, args: [join(f.root, "missing.mjs"), ...desired.args.slice(1)] })];
  assert.equal((await inspectCodexMcp(options(f, ["status"]))).mcpState, "broken");

  f.globalEntries = [entryFor(desired, { transport: { type: "streamable_http", url: "http://127.0.0.1:1/mcp" } })];
  assert.equal((await inspectCodexMcp(options(f, ["status"]))).mcpState, "drifted");
});

test("evaluateMcpEntry is a pure comparison usable without a host", () => {
  const desired = { command: process.execPath, args: ["/tmp/x.mjs", "--registry-root", "/r", "--policy-root", "/p", "--host-profile", "desktop", "--principal", "local-user"] };
  assert.equal(evaluateMcpEntry(undefined, desired, "unmanaged").mcpState, "missing");
  assert.equal(evaluateMcpEntry(entryFor(desired), desired, "unmanaged", () => true).mcpState, "adoptable");
  assert.equal(evaluateMcpEntry(entryFor(desired), desired, "managed", () => true).mcpState, "current");
  assert.equal(evaluateMcpEntry(entryFor(desired), desired, "drifted", () => true).mcpState, "drifted");
  assert.equal(evaluateMcpEntry(entryFor(desired), desired, "managed", () => false).mcpState, "broken");
  assert.equal(evaluateMcpEntry(entryFor({ command: desired.command, args: [] }), desired, "managed", () => true).mcpState, "drifted");
});

test("a project-level table in the operator cwd is reported as a shadow, never modified", async () => {
  const f = fixture();
  const desired = layoutOf(f).launcher;
  const projectLauncher = { command: desired.command, args: [join(f.project, ".pi/agent-fleet/scripts/fleet-codex-local-mcp.mjs"), ...desired.args.slice(1)] };
  f.globalEntries = [];
  f.cwdEntries = [entryFor(projectLauncher)];
  let status = await inspectCodexMcp(options(f, ["status"]));
  assert.equal(status.mcpState, "missing", "the user-level view decides the state");
  assert.deepEqual(status.projectShadow, { shadowed: true, transport: f.cwdEntries[0].transport });

  f.globalEntries = [entryFor(desired)];
  status = await inspectCodexMcp(options(f, ["status"]));
  assert.equal(status.projectShadow.shadowed, true, "a different project table shadows the user entry");

  f.cwdEntries = [entryFor(desired)];
  status = await inspectCodexMcp(options(f, ["status"]));
  assert.deepEqual(status.projectShadow, { shadowed: false, transport: null });
  assert.deepEqual(listCalls(f).filter(call => !call.startsWith("mcp list --json")), []);
});

test("skill state distinguishes missing, current, drifted, and a symlinked target", async () => {
  const f = fixture();
  const layout = layoutOf(f);
  const staging = join(f.root, "staging");
  const extracted = extractSkillZip(layout.skillZip, staging);
  mkdirSync(layout.skillsDir, { recursive: true, mode: 0o700 });
  renameSync(extracted.root, layout.skillDir);

  let status = await inspectCodexMcp(options(f, ["status"]));
  assert.equal(status.skillState, "current");
  assert.equal(status.skillReceiptState, "unmanaged");

  mkdirSync(layout.stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(layout.receipts.skill, JSON.stringify({ schemaVersion: 1, name: SKILL_NAME, fingerprint: status.skillFingerprint }) + "\n", { mode: 0o600 });
  status = await inspectCodexMcp(options(f, ["status"]));
  assert.equal(status.skillReceiptState, "managed");

  writeFileSync(join(layout.skillDir, "SKILL.md"), "edited\n");
  status = await inspectCodexMcp(options(f, ["status"]));
  assert.equal(status.skillState, "drifted");
  assert.equal(status.skillReceiptState, "drifted");

  rmSync(layout.skillDir, { recursive: true });
  symlinkSync(join(repoRoot, "skills", SKILL_NAME), layout.skillDir);
  status = await inspectCodexMcp(options(f, ["status"]));
  assert.equal(status.skillState, "symlink");
  assert.equal(lstatSync(layout.skillDir).isSymbolicLink(), true, "status never replaces or follows the link");
});

test("validation refuses unsafe launchers and warns about nvm-managed Node paths", () => {
  const f = fixture();
  const ok = validateLayout(layoutOf(f), { platform: "linux", nodeVersion: "v25.0.0" });
  assert.deepEqual(ok.errors, []);

  const oldNode = validateLayout(layoutOf(f), { platform: "linux", nodeVersion: "v22.17.9" });
  assert.match(oldNode.errors.join("\n"), /Node v22\.17\.9 .*22\.18\.0/);
  assert.deepEqual(validateLayout(layoutOf(f), { platform: "linux", nodeVersion: "v22.18.0" }).errors, []);

  const npx = validateLayout({ ...layoutOf(f), runtimePath: "/home/u/.npm/_npx/abc/node_modules/@chankov/agent-fleet/.pi/x.mjs" }, { platform: "linux", nodeVersion: "v25.0.0" });
  assert.match(npx.errors.join("\n"), /npx cache.*npm install -g @chankov\/agent-fleet/s);

  const relative = validateLayout(layoutOf(f, { registryRoot: "relative/coms" }), { platform: "linux", nodeVersion: "v25.0.0" });
  assert.match(relative.errors.join("\n"), /--registry-root.*absolute/);
  const unnormalized = validateLayout(layoutOf(f, { policyRoot: `${f.root}/policy/../policy` }), { platform: "linux", nodeVersion: "v25.0.0" });
  assert.match(unnormalized.errors.join("\n"), /--policy-root.*normalized/);

  const nested = validateLayout(layoutOf(f, { policyRoot: join(f.registryRoot, "policy") }), { platform: "linux", nodeVersion: "v25.0.0" });
  assert.match(nested.errors.join("\n"), /overlap/);
  const suffix = validateLayout(layoutOf(f, { registryRoot: `${join(f.root, "policy")}.permissions`, policyRoot: join(f.root, "policy") }), { platform: "linux", nodeVersion: "v25.0.0" });
  assert.match(suffix.errors.join("\n"), /overlap.*\.permissions/);
  const legacy = validateLayout(layoutOf(f, { legacyStateRoot: f.registryRoot }), { platform: "linux", nodeVersion: "v25.0.0" });
  assert.match(legacy.errors.join("\n"), /overlap/);

  const names = validateLayout(layoutOf(f, { hostProfile: "bad name!", principal: "../x" }), { platform: "linux", nodeVersion: "v25.0.0" });
  assert.match(names.errors.join("\n"), /--host-profile/);
  assert.match(names.errors.join("\n"), /--principal/);

  const linkedRegistry = join(f.root, "linked-coms");
  symlinkSync(f.registryRoot, linkedRegistry);
  const symlinked = validateLayout(layoutOf(f, { registryRoot: linkedRegistry }), { platform: "linux", nodeVersion: "v25.0.0" });
  assert.match(symlinked.errors.join("\n"), /--registry-root.*symlink/);

  const missingParent = validateLayout(layoutOf(f, { policyRoot: join(f.root, "nowhere", "policy") }), { platform: "linux", nodeVersion: "v25.0.0" });
  assert.match(missingParent.errors.join("\n"), /--policy-root.*parent/);

  const missingNode = validateLayout(layoutOf(f, { node: join(f.root, "no-such-node") }), { platform: "linux", nodeVersion: "v25.0.0" });
  assert.match(missingNode.errors.join("\n"), /--node.*not found/);

  const nvmNode = join(f.root, ".nvm", "versions", "node", "v25.2.1", "bin", "node");
  mkdirSync(join(nvmNode, ".."), { recursive: true });
  writeFileSync(nvmNode, "#!/bin/sh\n", { mode: 0o755 });
  const nvm = validateLayout(layoutOf(f, { node: nvmNode }), { platform: "linux", nodeVersion: "v25.2.1" });
  assert.deepEqual(nvm.errors, []);
  assert.match(nvm.warnings.join("\n"), /nvm.*set-codex-mcp update/);
});

test("the command refuses Windows before reading anything and surfaces status errors in the report", async () => {
  const f = fixture();
  await assert.rejects(setCodexMcp(options(f, ["status"], { platform: "win32" })), /POSIX/);
  assert.deepEqual(f.calls, []);

  const status = await setCodexMcp(options(f, ["status"], { nodeVersion: "v20.0.0" }));
  assert.equal(status.mcpState, "missing");
  assert.match(status.errors.join("\n"), /Node v20\.0\.0/);
});

test("unexpected Codex output is refused with the Codex version in the message", async () => {
  const f = fixture();
  f.codex = async (args, { cwd } = {}) => {
    f.calls.push({ args, cwd });
    if (args.join(" ") === "--version") return "codex-cli 9.9.9\n";
    return "this is not json\n";
  };
  await assert.rejects(setCodexMcp(options(f, ["status"])), /codex mcp list --json.*codex-cli 9\.9\.9/s);
  f.codex = async () => JSON.stringify({ not: "an array" });
  await assert.rejects(setCodexMcp(options(f, ["status"])), /codex mcp list --json/);
});

test("install, update, and uninstall are not available at this checkpoint and write nothing", async () => {
  const f = fixture();
  const before = snapshot(f.root);
  for (const action of ["install", "update", "uninstall"]) {
    await assert.rejects(setCodexMcp(options(f, [action])), /not available/);
  }
  assert.deepEqual(snapshot(f.root), before);
});

test("CLI publishes per-command help, lists the command, and rejects unknown actions", () => {
  const help = spawnSync(process.execPath, ["bin/cli.js", "set-codex-mcp", "--help"], { encoding: "utf8", cwd: repoRoot });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /set-codex-mcp <status\|install\|update\|uninstall>/);
  assert.match(help.stdout, /--registry-root/);
  assert.match(help.stdout, /--legacy-state-root/);
  assert.match(help.stdout, /does not grant/i);

  const general = spawnSync(process.execPath, ["bin/cli.js", "--help"], { encoding: "utf8", cwd: repoRoot });
  assert.match(general.stdout, /set-codex-mcp\s+Install\/status/);

  const unknown = spawnSync(process.execPath, ["bin/cli.js", "set-codex-mcp", "bogus"], { encoding: "utf8", cwd: repoRoot });
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Usage: agent-fleet set-codex-mcp/);
});
