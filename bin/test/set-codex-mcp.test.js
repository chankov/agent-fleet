import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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
const nodeTooOld = compareNodeVersion(process.version, MINIMUM_NODE) < 0;
const CONFIG_TOML = `# user config\nmodel = "gpt-5" # inline comment\n\n[mcp_servers.other]\ncommand = "other"\n`;
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
  const probeCalls = [];
  const f = {
    root, home, codexHome, registryRoot, project, calls, probeCalls,
    globalEntries: [],
    cwdEntries: null,
    addMode: "apply",
    removeMode: "apply",
    probeFails: false,
    tick: 0,
    codex: async (args, { cwd } = {}) => {
      calls.push({ args, cwd });
      if (args.join(" ") === "--version") return "codex-cli 0.166.0\n";
      if (args[0] === "mcp" && args[1] === "remove") {
        if (f.removeMode !== "ignore") f.globalEntries = f.globalEntries.filter(entry => entry.name !== args[2]);
        return `Removed global MCP server '${args[2]}'.\n`;
      }
      if (args[0] === "mcp" && args[1] === "add") {
        assert.equal(args[3], "--", "launcher argv is separated from codex options");
        if (f.addMode === "ignore") return "";
        const [command, ...launcherArgs] = args.slice(4);
        f.globalEntries = [...f.globalEntries.filter(entry => entry.name !== args[2]), { ...entryFor({ command, args: launcherArgs }), name: args[2] }];
        return `Added global MCP server '${args[2]}'.\n`;
      }
      if (args.join(" ") !== "mcp list --json") throw new Error(`unexpected codex call: ${args.join(" ")}`);
      const entries = cwd === codexHome ? f.globalEntries : (f.cwdEntries ?? f.globalEntries);
      return JSON.stringify(entries) + "\n";
    },
    probe: async launcher => {
      probeCalls.push(launcher);
      if (f.probeFails) throw new Error("af-local-read probe failed: server exited before replying (code 1, signal null)\nstderr: LOCAL_MCP_START_FAILED");
      return { serverInfo: { name: SERVER_NAME, version: "0.1.0" }, protocolVersion: "2025-06-18", toolCount: 24, toolNames: ["fleet_discover"], durationMs: 5 };
    },
  };
  return f;
}

function seedConfig(f) {
  writeFileSync(join(f.codexHome, "config.toml"), CONFIG_TOML, { mode: 0o600 });
}

function options(f, positionals, extra = {}) {
  return {
    positionals,
    packageRoot: repoRoot,
    env: { CODEX_HOME: f.codexHome, PI_COMS_DIR: f.registryRoot },
    home: f.home,
    cwd: f.project,
    codex: f.codex,
    probe: f.probe,
    now: () => new Date(Date.UTC(2026, 10, 7, 12, 0, 0, f.tick++)),
    nodeVersion: "v25.0.0",
    ...extra,
  };
}

function layoutOf(f, extra = {}) {
  const { positionals: _ignored, codex: _codex, probe: _probe, now: _now, nodeVersion: _node, ...rest } = options(f, ["status"], extra);
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
  for (const derived of ['.presence', '.bootstrap']) {
    const overlap = validateLayout(layoutOf(f, { registryRoot: join(f.root, 'policy') + derived, policyRoot: join(f.root, 'policy') }), { platform: 'linux', nodeVersion: 'v25.0.0' });
    assert.match(overlap.errors.join('\n'), /overlap/);
    assert.ok(overlap.errors.join('\n').includes(derived));
  }
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

test("full lifecycle: status → install → status → update → uninstall → status", async () => {
  const f = fixture();
  seedConfig(f);
  const layout = layoutOf(f);
  assert.equal((await setCodexMcp(options(f, ["status"]))).mcpState, "missing");

  const installed = await setCodexMcp(options(f, ["install"]));
  assert.equal(installed.mcpState, "current");
  assert.equal(installed.skillState, "current");

  const status = await setCodexMcp(options(f, ["status"]));
  assert.equal(status.mcpState, "current");
  assert.equal(status.skillState, "current");
  assert.equal(status.skillReceiptState, "managed");

  const updated = await setCodexMcp(options(f, ["update"]));
  assert.equal(updated.changed, false);

  f.calls.length = 0;
  const removed = await setCodexMcp(options(f, ["uninstall"]));
  assert.equal(removed.action, "uninstall");
  assert.equal(removed.changed, true);
  assert.equal(removed.mode, "remove");
  assert.equal(removed.skillMode, "remove");
  assert.equal(removed.bindingsRetained, true);
  assert.match(removed.bindingsHint, /forget, revoke_send or revoke_approve/);
  assert.equal(removed.mcpState, "missing");
  assert.equal(removed.skillState, "missing");
  assert.equal(removed.mcpReceiptState, "unmanaged");
  assert.equal(removed.skillReceiptState, "unmanaged");
  assert.deepEqual(f.calls.find(call => call.args[1] === "remove"), { args: ["mcp", "remove", SERVER_NAME], cwd: f.codexHome });
  assert.deepEqual(f.calls.map(call => call.args.slice(0, 2).join(" ")), ["mcp list", "mcp list", "mcp remove", "mcp list", "mcp list", "mcp list"]);
  assert.equal(existsSync(layout.skillDir), false);
  assert.equal(existsSync(layout.receipts.mcp), false);
  assert.equal(existsSync(layout.receipts.skill), false);
  assert.ok(removed.skillBackupDir.startsWith(join(layout.backupsDir, `${SKILL_NAME}-uninstall-`)));
  assert.equal(readFileSync(join(removed.skillBackupDir, "SKILL.md"), "utf8"), readFileSync(join(repoRoot, "skills", SKILL_NAME, "SKILL.md"), "utf8"));
  assert.ok(removed.backupPath.startsWith(join(layout.backupsDir, "config.toml-")));
  assert.equal(readFileSync(removed.backupPath, "utf8"), CONFIG_TOML);
  assert.equal(statSync(removed.backupPath).mode & 0o777, 0o600);
  assert.equal(existsSync(join(layout.stateDir, "state")), true, "the policy state parent is left alone");

  assert.equal((await setCodexMcp(options(f, ["status"]))).mcpState, "missing");
});

test("skill install refuses a symlinked target even with --force and applies nothing", async () => {
  const f = fixture();
  seedConfig(f);
  const layout = layoutOf(f);
  mkdirSync(layout.skillsDir, { recursive: true });
  symlinkSync(join(repoRoot, "skills", SKILL_NAME), layout.skillDir);
  const before = snapshot(f.root);
  await assert.rejects(setCodexMcp(options(f, ["install"], { force: true })), /is a symlink; remove it yourself/);
  assert.deepEqual(snapshot(f.root), before);
  assert.deepEqual(f.probeCalls, []);
  assert.equal(f.calls.some(call => call.args[1] === "add"), false);
});

test("a drifted skill copy refuses without --force and is backed up with it; an identical copy is adopted", async () => {
  const f = fixture();
  seedConfig(f);
  const layout = layoutOf(f);
  await setCodexMcp(options(f, ["install"]));
  writeFileSync(join(layout.skillDir, "SKILL.md"), "edited\n");
  await assert.rejects(setCodexMcp(options(f, ["update"])), /differs from the packaged skill.*--force/);
  assert.equal(readFileSync(join(layout.skillDir, "SKILL.md"), "utf8"), "edited\n");

  const forced = await setCodexMcp(options(f, ["update"], { force: true }));
  assert.equal(forced.skillMode, "install");
  assert.equal(forced.skillState, "current");
  assert.equal(forced.mode, "none", "the MCP entry was already current");
  assert.equal(forced.probe, null);
  assert.ok(forced.skillBackupDir.startsWith(join(layout.backupsDir, `${SKILL_NAME}-`)));
  assert.equal(readFileSync(join(forced.skillBackupDir, "SKILL.md"), "utf8"), "edited\n");

  const adopt = fixture();
  const adoptLayout = layoutOf(adopt);
  const staged = extractSkillZip(adoptLayout.skillZip, join(adopt.root, "staging"));
  mkdirSync(adoptLayout.skillsDir, { recursive: true });
  renameSync(staged.root, adoptLayout.skillDir);
  const adopted = await setCodexMcp(options(adopt, ["install"]));
  assert.equal(adopted.skillMode, "adopt");
  assert.equal(adopted.skillReceiptState, "managed");
  assert.equal(adopted.skillBackupDir, null);
  assert.equal(statSync(adoptLayout.receipts.skill).mode & 0o777, 0o600);
});

test("uninstall refuses unmanaged or drifted pieces without --force and never touches a symlinked skill", async () => {
  const f = fixture();
  seedConfig(f);
  const layout = layoutOf(f);
  f.globalEntries = [entryFor(layout.launcher)];
  await assert.rejects(setCodexMcp(options(f, ["uninstall"])), /not managed by a receipt.*--force/);
  assert.equal(f.calls.some(call => call.args[1] === "remove"), false);
  const forced = await setCodexMcp(options(f, ["uninstall"], { force: true }));
  assert.equal(forced.mode, "remove");
  assert.equal(forced.mcpState, "missing");
  assert.equal(readFileSync(forced.backupPath, "utf8"), CONFIG_TOML);

  const drifted = fixture();
  seedConfig(drifted);
  const driftedLayout = layoutOf(drifted);
  await setCodexMcp(options(drifted, ["install"]));
  writeFileSync(join(driftedLayout.skillDir, "SKILL.md"), "edited\n");
  await assert.rejects(setCodexMcp(options(drifted, ["uninstall"])), /is drifted\/drifted.*--force/);
  assert.equal(existsSync(driftedLayout.skillDir), true);
  assert.equal((await inspectCodexMcp(options(drifted, ["status"]))).mcpState, "current", "a refused uninstall removes nothing, not even the managed entry");
  const removed = await setCodexMcp(options(drifted, ["uninstall"], { force: true }));
  assert.equal(removed.skillMode, "remove");
  assert.equal(readFileSync(join(removed.skillBackupDir, "SKILL.md"), "utf8"), "edited\n");
  assert.equal(removed.mcpState, "missing");
  assert.equal(removed.skillState, "missing");

  const linked = fixture();
  const linkedLayout = layoutOf(linked);
  mkdirSync(linkedLayout.skillsDir, { recursive: true });
  symlinkSync(join(repoRoot, "skills", SKILL_NAME), linkedLayout.skillDir);
  await assert.rejects(setCodexMcp(options(linked, ["uninstall"], { force: true })), /symlink that this command did not create; remove it yourself/);
  assert.equal(lstatSync(linkedLayout.skillDir).isSymbolicLink(), true);
});

test("uninstall dry-run reports removals without writing, and a clean host is a no-op", async () => {
  const f = fixture();
  seedConfig(f);
  const layout = layoutOf(f);
  const clean = await setCodexMcp(options(f, ["uninstall"]));
  assert.equal(clean.changed, false);
  assert.equal(clean.bindingsRetained, true);
  assert.equal(f.calls.some(call => call.args[1] === "remove"), false);

  await setCodexMcp(options(f, ["install"]));
  const before = snapshot(f.root);
  f.calls.length = 0;
  const dry = await setCodexMcp(options(f, ["uninstall"], { dryRun: true }));
  assert.equal(dry.dryRun, true);
  assert.equal(dry.changed, true);
  assert.equal(dry.mode, "remove");
  assert.equal(dry.skillMode, "remove");
  assert.ok(dry.backupPath.startsWith(join(layout.backupsDir, "config.toml-")));
  assert.ok(dry.skillBackupDir.startsWith(join(layout.backupsDir, `${SKILL_NAME}-uninstall-`)));
  assert.deepEqual(f.calls.map(call => call.args.slice(0, 2).join(" ")), ["mcp list", "mcp list"]);
  assert.deepEqual(snapshot(f.root), before);

  f.removeMode = "ignore";
  await assert.rejects(setCodexMcp(options(f, ["uninstall"])), /still reports an af-local-read entry after remove; receipt kept/);
  assert.equal(existsSync(layout.receipts.mcp), true);
  assert.equal(existsSync(layout.skillDir), true, "the skill is removed only after the entry is confirmed gone");
});

test("install on a missing entry probes, backs up config.toml, adds through codex, re-reads, and writes a receipt", async () => {
  const f = fixture();
  seedConfig(f);
  const layout = layoutOf(f);
  const result = await setCodexMcp(options(f, ["install"]));
  assert.equal(result.action, "install");
  assert.equal(result.mode, "add");
  assert.equal(result.changed, true);
  assert.equal(result.mcpState, "current");
  assert.equal(result.mcpReceiptState, "managed");
  assert.equal(result.probe.toolCount, 24);
  assert.deepEqual(f.probeCalls, [{ command: layout.launcher.command, args: layout.launcher.args, expectedName: SERVER_NAME, timeoutMs: 10000 }]);
  assert.deepEqual(result.codexArgv, ["mcp", "add", SERVER_NAME, "--", layout.launcher.command, ...layout.launcher.args]);
  assert.deepEqual(f.calls.find(call => call.args[1] === "add"), { args: result.codexArgv, cwd: f.codexHome });
  assert.deepEqual(
    f.calls.map(call => call.args.slice(0, 2).join(" ")),
    ["mcp list", "mcp list", "mcp add", "mcp list", "mcp list", "mcp list"],
    "inspect, add, re-read, inspect again",
  );
  const receipt = JSON.parse(readFileSync(layout.receipts.mcp, "utf8"));
  assert.deepEqual(receipt, { schemaVersion: 1, name: SERVER_NAME, fingerprint: launcherFingerprint(layout.launcher), launcher: layout.launcher });
  assert.equal(statSync(layout.receipts.mcp).mode & 0o777, 0o600);
  assert.equal(result.backupPath, join(layout.backupsDir, "config.toml-2026-11-07T12-00-00-000Z"));
  assert.equal(readFileSync(result.backupPath, "utf8"), CONFIG_TOML);
  assert.equal(statSync(result.backupPath).mode & 0o777, 0o600);
  for (const dir of [layout.stateDir, layout.backupsDir, join(layout.stateDir, "state")]) assert.equal(statSync(dir).mode & 0o777, 0o700, dir);
  assert.equal(existsSync(layout.policyRoot), false, "the server, not the installer, creates the policy root on first use");
  assert.equal(result.skillMode, "install");
  assert.equal(result.skillState, "current");
  assert.equal(result.skillReceiptState, "managed");
  assert.equal(result.skillBackupDir, null);
  assert.equal(readFileSync(join(layout.skillDir, "SKILL.md"), "utf8"), readFileSync(join(repoRoot, "skills", SKILL_NAME, "SKILL.md"), "utf8"));
  assert.equal(statSync(join(f.home, ".agents")).mode & 0o777, 0o700);
  assert.equal(statSync(layout.skillsDir).mode & 0o777, 0o700);
  assert.equal(statSync(layout.skillDir).mode & 0o777, 0o700);
  assert.equal(statSync(join(layout.skillDir, "SKILL.md")).mode & 0o777, 0o600);
  assert.equal(statSync(layout.receipts.skill).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(layout.skillsDir), [SKILL_NAME], "no temp entry survives beside the skill");
});

test("install adopts a matching unmanaged entry by writing only the receipt", async () => {
  const f = fixture();
  seedConfig(f);
  const layout = layoutOf(f);
  f.globalEntries = [entryFor(layout.launcher)];
  const result = await setCodexMcp(options(f, ["install"]));
  assert.equal(result.mode, "adopt");
  assert.equal(result.changed, true);
  assert.equal(result.mcpState, "current");
  assert.equal(result.backupPath, null);
  assert.equal(result.codexArgv, null);
  assert.equal(f.probeCalls.length, 1, "adoption still proves the launcher starts");
  assert.equal(f.calls.some(call => call.args[1] === "add"), false);
  assert.equal(existsSync(layout.backupsDir), false);
  assert.equal(statSync(layout.receipts.mcp).mode & 0o777, 0o600);
});

test("update on a current entry changes nothing and runs no probe", async () => {
  const f = fixture();
  seedConfig(f);
  await setCodexMcp(options(f, ["install"]));
  const before = snapshot(f.root);
  f.calls.length = 0;
  f.probeCalls.length = 0;
  const result = await setCodexMcp(options(f, ["update"]));
  assert.equal(result.mode, "none");
  assert.equal(result.skillMode, "none");
  assert.equal(result.changed, false);
  assert.equal(result.probe, null);
  assert.deepEqual(f.probeCalls, []);
  assert.deepEqual(f.calls.map(call => call.args.slice(0, 2).join(" ")), ["mcp list", "mcp list"]);
  assert.deepEqual(snapshot(f.root), before);
});

test("drifted and broken entries refuse without --force and are replaced with it after a backup", async () => {
  const f = fixture();
  seedConfig(f);
  const layout = layoutOf(f);
  f.globalEntries = [entryFor({ command: layout.launcher.command, args: layout.launcher.args.map(arg => (arg === "desktop" ? "old-profile" : arg)) })];
  const before = snapshot(f.root);
  await assert.rejects(setCodexMcp(options(f, ["update"])), /drifted.*--force/);
  assert.deepEqual(snapshot(f.root), before);
  assert.equal(f.calls.some(call => call.args[1] === "add"), false);
  assert.deepEqual(f.probeCalls, []);

  const forced = await setCodexMcp(options(f, ["update"], { force: true }));
  assert.equal(forced.mode, "add");
  assert.equal(forced.mcpState, "current");
  assert.equal(readFileSync(forced.backupPath, "utf8"), CONFIG_TOML);

  const broken = fixture();
  broken.globalEntries = [entryFor({ command: join(broken.root, "missing-node"), args: layoutOf(broken).launcher.args })];
  await assert.rejects(setCodexMcp(options(broken, ["install"])), /broken.*--force/);
  const repaired = await setCodexMcp(options(broken, ["install"], { force: true }));
  assert.equal(repaired.mcpState, "current");
  assert.equal(repaired.backupPath, null, "no config.toml existed to back up");
});

test("a failed probe or a refusal in status prevents every write", async () => {
  const f = fixture();
  seedConfig(f);
  const before = snapshot(f.root);
  f.probeFails = true;
  await assert.rejects(setCodexMcp(options(f, ["install"])), /probe failed[\s\S]*LOCAL_MCP_START_FAILED/);
  assert.equal(f.calls.some(call => call.args[1] === "add"), false);
  assert.deepEqual(snapshot(f.root), before, "no directories, backup, or receipt after a failed probe");

  f.probeFails = false;
  f.probeCalls.length = 0;
  await assert.rejects(setCodexMcp(options(f, ["install"], { nodeVersion: "v20.0.0" })), /refusing install[\s\S]*Node v20\.0\.0/);
  await assert.rejects(setCodexMcp(options(f, ["install"], { nodeVersion: "v20.0.0", dryRun: true })), /refusing install/);
  assert.deepEqual(f.probeCalls, []);
  assert.deepEqual(snapshot(f.root), before);
});

test("a re-read that does not show the exact launcher leaves no receipt and names the backup", async () => {
  const f = fixture();
  seedConfig(f);
  const layout = layoutOf(f);
  f.addMode = "ignore";
  await assert.rejects(setCodexMcp(options(f, ["install"])), /no af-local-read entry after add[\s\S]*receipt not written[\s\S]*config\.toml-2026-11-07T12-00-00-000Z/);
  assert.equal(existsSync(layout.receipts.mcp), false);
  assert.equal(readFileSync(join(layout.backupsDir, "config.toml-2026-11-07T12-00-00-000Z"), "utf8"), CONFIG_TOML);
});

test("dry-run reports the mode and argv without probing or writing", async () => {
  const f = fixture();
  seedConfig(f);
  const layout = layoutOf(f);
  const before = snapshot(f.root);
  const result = await setCodexMcp(options(f, ["install"], { dryRun: true }));
  assert.equal(result.dryRun, true);
  assert.equal(result.mode, "add");
  assert.equal(result.changed, true);
  assert.equal(result.probe, null);
  assert.deepEqual(result.codexArgv, ["mcp", "add", SERVER_NAME, "--", layout.launcher.command, ...layout.launcher.args]);
  assert.equal(result.backupPath, join(layout.backupsDir, "config.toml-2026-11-07T12-00-00-000Z"));
  assert.deepEqual(f.probeCalls, []);
  assert.equal(f.calls.some(call => call.args[1] === "add"), false);
  assert.deepEqual(snapshot(f.root), before);

  f.globalEntries = [entryFor(layout.launcher)];
  const adopt = await setCodexMcp(options(f, ["update"], { dryRun: true }));
  assert.equal(adopt.mode, "adopt");
  assert.equal(adopt.codexArgv, null);
  assert.equal(adopt.backupPath, null);
  assert.deepEqual(snapshot(f.root), before);
});

test("paths with spaces survive the launcher, the codex argv, and the backup", async () => {
  const f = fixture();
  const home = join(f.root, "home dir");
  const codexHome = join(home, ".codex");
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(join(codexHome, "config.toml"), CONFIG_TOML);
  const registryRoot = join(f.root, "coms root");
  mkdirSync(registryRoot);
  const spaced = { ...f, home, codexHome };
  spaced.codex = async (args, { cwd } = {}) => f.codex(args, { cwd: cwd === codexHome ? f.codexHome : cwd });
  const result = await setCodexMcp(options(spaced, ["install"], { env: { CODEX_HOME: codexHome, PI_COMS_DIR: registryRoot } }));
  assert.equal(result.mode, "add");
  assert.equal(result.mcpState, "current");
  assert.ok(result.codexArgv.includes(registryRoot));
  assert.ok(result.codexArgv.includes(join(codexHome, "agent-fleet", "state", "fleet-native")));
  assert.equal(result.registryRoot, registryRoot);
  assert.equal(readFileSync(result.backupPath, "utf8"), CONFIG_TOML);
  assert.equal(result.backupPath.startsWith(join(codexHome, "agent-fleet", "backups")), true);
});

test("install with the real probe starts the packaged runtime and creates no policy state", { skip: nodeTooOld && `needs Node ${MINIMUM_NODE}` }, async () => {
  const f = fixture();
  const layout = layoutOf(f);
  const result = await setCodexMcp(options(f, ["install"], { probe: undefined }));
  assert.equal(result.mode, "add");
  assert.equal(result.probe.serverInfo.name, SERVER_NAME);
  assert.ok(result.probe.toolCount >= 1);
  assert.equal(result.mcpState, "current");
  assert.equal(existsSync(layout.policyRoot), false);
  for (const suffix of [".observations", ".instructions", ".reports", ".permissions"]) assert.equal(existsSync(layout.policyRoot + suffix), false);
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
