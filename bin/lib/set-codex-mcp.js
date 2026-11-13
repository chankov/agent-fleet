import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, constants as fsConstants, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { SAFE_NAME_RE, atomicInstallArtifact, directoryFingerprint, writeReceipt } from "./hermes-profile-artifact.js";
import { extractSkillZip } from "./skill-zip.js";
import { probeMcpServer } from "./mcp-probe.js";

/**
 * `agent-fleet set-codex-mcp`: user-level registration of the native Codex MCP
 * server (`af-local-read`) plus the `fleet-native-voice` skill. Codex owns its
 * `config.toml`; this module only reads it through `codex mcp list --json` and
 * (in later lifecycle actions) writes through `codex mcp add/remove`. Nothing
 * here touches a workspace, `apply.js`, or the installer manifests.
 */
export const SERVER_NAME = "af-local-read";
export const SKILL_NAME = "fleet-native-voice";
export const MINIMUM_NODE = "22.18.0";
export const RUNTIME_RELATIVE = ".pi/agent-fleet/scripts/fleet-codex-local-mcp.mjs";

const ACTIONS = ["status", "install", "update", "uninstall"];
const DEFAULT_HOST_PROFILE = "desktop";
const DEFAULT_PRINCIPAL = "local-user";
/** Sibling namespaces the server derives from `--policy-root`; they must stay disjoint from every other root. */
const STATE_SUFFIXES = [".observations", ".instructions", ".reports", ".permissions", ".presence", ".bootstrap"];
const PROBE_TIMEOUT_MS = 10000;

function usage() {
  return new Error(
    "Usage: agent-fleet set-codex-mcp <status|install|update|uninstall> [--node PATH] [--registry-root DIR] [--policy-root DIR] [--host-profile NAME] [--principal NAME] [--legacy-state-root DIR] [--force] [--dry-run]",
  );
}

export function parseSetCodexMcpArgs(argv) {
  if (argv.length !== 1 || !ACTIONS.includes(argv[0])) throw usage();
  return { action: argv[0] };
}

/** Run the Codex CLI with an argv array (no shell). Returns stdout; non-zero exit throws. */
export function runCodexCommand(args, { cwd } = {}) {
  const result = spawnSync("codex", args, { encoding: "utf8", cwd, timeout: 60000 });
  if (result.error) throw new Error(`failed to run codex: ${result.error.message}`);
  if (result.status !== 0) throw new Error((result.stderr || result.stdout).trim() || `codex ${args.join(" ")} failed`);
  return result.stdout;
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Every path and label the launcher needs, from explicit options or documented defaults. */
export function resolveCodexMcpLayout({
  packageRoot,
  env = process.env,
  home = homedir(),
  cwd = process.cwd(),
  node,
  registryRoot,
  policyRoot,
  hostProfile,
  principal,
  legacyStateRoot,
}) {
  const codexHome = env.CODEX_HOME || join(home, ".codex");
  const stateDir = join(codexHome, "agent-fleet");
  const resolvedRegistryRoot = registryRoot ?? env.PI_COMS_DIR ?? join(home, ".pi", "coms");
  const resolvedPolicyRoot = policyRoot ?? join(stateDir, "state", "fleet-native");
  const resolvedHostProfile = hostProfile ?? DEFAULT_HOST_PROFILE;
  const resolvedPrincipal = principal ?? DEFAULT_PRINCIPAL;
  const runtimePath = join(packageRoot, RUNTIME_RELATIVE);
  const args = [
    runtimePath,
    "--registry-root", resolvedRegistryRoot,
    "--policy-root", resolvedPolicyRoot,
    "--host-profile", resolvedHostProfile,
    "--principal", resolvedPrincipal,
  ];
  if (legacyStateRoot) args.push("--legacy-state-root", legacyStateRoot);
  return {
    codexHome,
    home,
    stateDir,
    backupsDir: join(stateDir, "backups"),
    configPath: join(codexHome, "config.toml"),
    receipts: {
      mcp: join(stateDir, `${SERVER_NAME}.receipt.json`),
      skill: join(stateDir, `${SKILL_NAME}.receipt.json`),
    },
    skillsDir: join(home, ".agents", "skills"),
    skillDir: join(home, ".agents", "skills", SKILL_NAME),
    skillZip: join(packageRoot, "skills", `${SKILL_NAME}.zip`),
    runtimePath,
    registryRoot: resolvedRegistryRoot,
    policyRoot: resolvedPolicyRoot,
    policyRootIsDefault: policyRoot === undefined,
    hostProfile: resolvedHostProfile,
    principal: resolvedPrincipal,
    legacyStateRoot: legacyStateRoot ?? null,
    launcher: { command: node ?? process.execPath, args },
    operatorCwd: cwd,
  };
}

export function compareNodeVersion(version, minimum) {
  const parse = value => {
    const match = String(value).trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
    if (!match) throw new Error(`unrecognized Node version: ${JSON.stringify(value)}`);
    return match.slice(1, 4).map(Number);
  };
  const actual = parse(version);
  const wanted = parse(minimum);
  for (let index = 0; index < 3; index++) {
    if (actual[index] !== wanted[index]) return actual[index] - wanted[index];
  }
  return 0;
}

function detectNodeVersion(command) {
  if (command === process.execPath) return process.version;
  if (!isFile(command)) return null;
  const result = spawnSync(command, ["--version"], { encoding: "utf8", timeout: 10000 });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim() || null;
}

/** The deepest existing ancestor of `path` when it is reached through a symlink, else null. */
function symlinkInPath(path) {
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  try {
    return realpathSync(current) === current ? null : current;
  } catch {
    return current;
  }
}

/** Same containment rule as the server's own UNSAFE_PATH check. */
function overlaps(a, b) {
  const rel = relative(a, b);
  return rel === "" || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel));
}

/**
 * Pure checks over a resolved layout: refusals go to `errors`, advisories to
 * `warnings`. Nothing is read beyond `stat`/`realpath`, and nothing is written.
 */
export function validateLayout(layout, { platform = process.platform, nodeVersion } = {}) {
  const errors = [];
  const warnings = [];
  if (platform === "win32") errors.push(`${SERVER_NAME} runs only on POSIX hosts; Windows is not supported`);

  if (nodeVersion == null) {
    errors.push(`could not determine the Node version of --node ${layout.launcher.command}`);
  } else {
    try {
      if (compareNodeVersion(nodeVersion, MINIMUM_NODE) < 0) {
        errors.push(`Node ${nodeVersion} is too old for the native server; it needs Node ${MINIMUM_NODE} or newer`);
      }
    } catch (error) {
      errors.push(error.message);
    }
  }

  const { command } = layout.launcher;
  if (!isAbsolute(command) || resolve(command) !== command) errors.push(`--node must be an absolute, normalized path: ${command}`);
  else if (!isFile(command)) errors.push(`--node binary not found: ${command}`);
  if (command.includes("/.nvm/versions/")) {
    warnings.push(`Node at ${command} is managed by nvm; after switching Node versions run \`agent-fleet set-codex-mcp update\` so Codex keeps a working launcher`);
  }

  if (layout.runtimePath.includes("/_npx/")) {
    errors.push(`runtime ${layout.runtimePath} lives in the npx cache, which npm may evict at any time; install the package with \`npm install -g @chankov/agent-fleet\` or run from a checkout`);
  } else if (!isAbsolute(layout.runtimePath) || resolve(layout.runtimePath) !== layout.runtimePath) {
    errors.push(`runtime path must be absolute and normalized: ${layout.runtimePath}`);
  } else if (!isFile(layout.runtimePath)) {
    errors.push(`runtime not found: ${layout.runtimePath}`);
  }

  if (!isAbsolute(layout.codexHome) || resolve(layout.codexHome) !== layout.codexHome) {
    errors.push(`CODEX_HOME must be an absolute, normalized path: ${layout.codexHome}`);
  }

  const roots = [
    ["--registry-root", layout.registryRoot],
    ["--policy-root", layout.policyRoot],
  ];
  if (layout.legacyStateRoot) roots.push(["--legacy-state-root", layout.legacyStateRoot]);
  for (const [flag, path] of roots) {
    if (!isAbsolute(path)) errors.push(`${flag} must be an absolute path: ${path}`);
    else if (resolve(path) !== path) errors.push(`${flag} must be a normalized path (no trailing slash, "." or ".."): ${path}`);
    else {
      const link = symlinkInPath(path);
      if (link) errors.push(`${flag} resolves through a symlink at ${link}; use the real path: ${path}`);
    }
  }
  if (!layout.policyRootIsDefault && isAbsolute(layout.policyRoot)) {
    const parent = dirname(layout.policyRoot);
    if (!isDirectory(parent)) errors.push(`--policy-root parent directory must already exist and be yours: ${parent}`);
  }

  const disjoint = [...roots, ...STATE_SUFFIXES.map(suffix => [`--policy-root${suffix}`, layout.policyRoot + suffix])];
  for (let i = 0; i < disjoint.length; i++) {
    for (let j = i + 1; j < disjoint.length; j++) {
      const [labelA, a] = disjoint[i];
      const [labelB, b] = disjoint[j];
      if (!isAbsolute(a) || !isAbsolute(b)) continue;
      if (overlaps(a, b) || overlaps(b, a)) errors.push(`${labelA} and ${labelB} overlap: ${a} vs ${b}; state roots must be disjoint`);
    }
  }

  for (const [flag, value] of [["--host-profile", layout.hostProfile], ["--principal", layout.principal]]) {
    if (!SAFE_NAME_RE.test(value) || value.includes("..")) errors.push(`${flag} must match ${SAFE_NAME_RE}: ${JSON.stringify(value)}`);
  }

  return { errors, warnings };
}

export function launcherFingerprint({ command, args }) {
  return createHash("sha256").update(JSON.stringify([command, args])).digest("hex");
}

/**
 * `managed` when a plain receipt names exactly `fingerprint`; `unmanaged` when
 * there is no receipt; anything else (symlink, unreadable, stale) is `drifted`.
 */
function readReceiptState(path, fingerprint) {
  if (!existsSync(path)) return "unmanaged";
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) return "drifted";
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return fingerprint !== null && parsed.fingerprint === fingerprint ? "managed" : "drifted";
  } catch {
    return "drifted";
  }
}

function emptyEnv(value) {
  return value == null || (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0);
}

function emptyList(value) {
  return value == null || (Array.isArray(value) && value.length === 0);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Classify the user-level entry Codex reports for `af-local-read`:
 * `missing`, `broken` (command or script no longer on disk), `current`
 * (matches and has a receipt), `adoptable` (matches, no receipt), or `drifted`.
 */
export function evaluateMcpEntry(entry, desired, receiptState, fileExists = isFile) {
  if (!entry) return { mcpState: "missing", transport: null, enabled: null };
  const transport = entry.transport ?? null;
  const enabled = entry.enabled !== false;
  if (transport?.type === "stdio") {
    const script = Array.isArray(transport.args) ? transport.args[0] : undefined;
    const commandMissing = typeof transport.command === "string" && isAbsolute(transport.command) && !fileExists(transport.command);
    const scriptMissing = typeof script === "string" && isAbsolute(script) && !fileExists(script);
    if (commandMissing || scriptMissing) return { mcpState: "broken", transport, enabled };
  }
  const matches = transport?.type === "stdio"
    && transport.command === desired.command
    && Array.isArray(transport.args)
    && transport.args.length === desired.args.length
    && transport.args.every((value, index) => value === desired.args[index])
    && emptyEnv(transport.env)
    && emptyList(transport.env_vars)
    && transport.cwd == null
    && enabled;
  if (!matches) return { mcpState: "drifted", transport, enabled };
  if (receiptState === "managed") return { mcpState: "current", transport, enabled };
  if (receiptState === "unmanaged") return { mcpState: "adoptable", transport, enabled };
  return { mcpState: "drifted", transport, enabled };
}

async function listServers(codex, cwd) {
  const output = await codex(["mcp", "list", "--json"], { cwd });
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    parsed = undefined;
  }
  if (!Array.isArray(parsed) || !parsed.every(entry => entry && typeof entry === "object" && typeof entry.name === "string")) {
    let version = "unknown codex version";
    try {
      version = String(await codex(["--version"])).trim() || version;
    } catch {
      // The version is only context for the error below.
    }
    throw new Error(`unexpected output from \`codex mcp list --json\` (${version}); this command understands the JSON array printed by codex-cli 0.166.0`);
  }
  return parsed;
}

/** A project `.codex/config.toml` entry visible from the operator cwd that differs from the user-level one. */
function shadowOf(globalEntry, cwdEntry) {
  if (!cwdEntry) return { shadowed: false, transport: null };
  if (globalEntry && stableJson(globalEntry.transport ?? null) === stableJson(cwdEntry.transport ?? null)) return { shadowed: false, transport: null };
  return { shadowed: true, transport: cwdEntry.transport ?? null };
}

/** Fingerprint of the packaged skill, computed from the shipped zip so checkout and npm share one code path. */
function packagedSkillFingerprint(zipPath) {
  const temp = mkdtempSync(join(tmpdir(), "agent-fleet-skill-"));
  try {
    const extracted = extractSkillZip(zipPath, join(temp, "zip"));
    if (extracted.name !== SKILL_NAME) throw new Error(`packaged archive ${zipPath} contains ${JSON.stringify(extracted.name)}, expected ${SKILL_NAME}`);
    return directoryFingerprint(extracted.root);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function inspectSkill(layout) {
  let state;
  let installedFingerprint = null;
  let stat = null;
  try {
    stat = lstatSync(layout.skillDir);
  } catch {
    stat = null;
  }
  if (!stat) state = "missing";
  else if (stat.isSymbolicLink()) state = "symlink";
  else if (!stat.isDirectory()) state = "drifted";
  else {
    try {
      installedFingerprint = directoryFingerprint(layout.skillDir);
    } catch {
      state = "drifted";
    }
  }
  const sourceFingerprint = packagedSkillFingerprint(layout.skillZip);
  if (state === undefined) state = installedFingerprint === sourceFingerprint ? "current" : "drifted";
  return {
    state,
    installedFingerprint,
    sourceFingerprint,
    receiptState: readReceiptState(layout.receipts.skill, installedFingerprint),
  };
}

/**
 * Read-only inspection: two `codex mcp list --json` reads (user-level view
 * from CODEX_HOME, operator view from cwd for shadow detection), local stats,
 * and a temporary unpack of the packaged skill for fingerprinting. Nothing
 * under HOME or CODEX_HOME is created or modified.
 */
export async function inspectCodexMcp(options) {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") throw new Error(`${SERVER_NAME} runs only on POSIX hosts; Windows is not supported`);
  const layout = resolveCodexMcpLayout(options);
  const nodeVersion = options.nodeVersion ?? detectNodeVersion(layout.launcher.command);
  const { errors, warnings } = validateLayout(layout, { platform, nodeVersion });
  const codex = options.codex ?? runCodexCommand;
  const codexCwd = isDirectory(layout.codexHome) ? layout.codexHome : layout.home;
  const globalEntries = await listServers(codex, codexCwd);
  const cwdEntries = await listServers(codex, layout.operatorCwd);
  const globalEntry = globalEntries.find(entry => entry.name === SERVER_NAME);
  const cwdEntry = cwdEntries.find(entry => entry.name === SERVER_NAME);
  const actualFingerprint = globalEntry?.transport?.type === "stdio"
    ? launcherFingerprint({ command: globalEntry.transport.command, args: Array.isArray(globalEntry.transport.args) ? globalEntry.transport.args : [] })
    : null;
  const mcpReceiptState = readReceiptState(layout.receipts.mcp, actualFingerprint);
  const mcp = evaluateMcpEntry(globalEntry, layout.launcher, mcpReceiptState);
  const skill = inspectSkill(layout);
  return {
    action: "status",
    platform,
    nodeVersion,
    codexHome: layout.codexHome,
    stateDir: layout.stateDir,
    configPath: layout.configPath,
    backupsDir: layout.backupsDir,
    operatorCwd: layout.operatorCwd,
    codexCwd,
    launcher: layout.launcher,
    runtimePath: layout.runtimePath,
    registryRoot: layout.registryRoot,
    policyRoot: layout.policyRoot,
    hostProfile: layout.hostProfile,
    principal: layout.principal,
    legacyStateRoot: layout.legacyStateRoot,
    mcpState: mcp.mcpState,
    mcpEntry: mcp.transport,
    mcpEnabled: mcp.enabled,
    mcpReceipt: layout.receipts.mcp,
    mcpReceiptState,
    projectShadow: shadowOf(globalEntry, cwdEntry),
    skillDir: layout.skillDir,
    skillState: skill.state,
    skillFingerprint: skill.installedFingerprint,
    skillSourceFingerprint: skill.sourceFingerprint,
    skillReceipt: layout.receipts.skill,
    skillReceiptState: skill.receiptState,
    warnings,
    errors,
  };
}

/** What an explicit install/update would do to the user-level entry, without touching anything. */
export function planMcpInstall(before, force) {
  switch (before.mcpState) {
    case "missing":
      return { mode: "add", reason: "no user-level entry" };
    case "adoptable":
      return { mode: "adopt", reason: "the entry matches the launcher but has no receipt" };
    case "current":
      return { mode: "none", reason: "the entry and its receipt already match" };
    default:
      if (!force) throw new Error(`${SERVER_NAME} entry is ${before.mcpState}; re-run with --force to back up config.toml and replace it`);
      return { mode: "add", reason: `${before.mcpState} entry replaced with --force` };
  }
}

/** What an explicit install/update would do to the skill copy under ~/.agents/skills. */
export function planSkillInstall(before, force) {
  switch (before.skillState) {
    case "missing":
      return { mode: "install", reason: "skill not installed" };
    case "symlink":
      throw new Error(`${before.skillDir} is a symlink; remove it yourself before installing the packaged skill copy`);
    case "current":
      if (before.skillReceiptState === "managed") return { mode: "none", reason: "the skill and its receipt already match" };
      if (before.skillReceiptState === "unmanaged") return { mode: "adopt", reason: "the skill matches the package but has no receipt" };
      if (!force) throw new Error(`${SKILL_NAME} has an unreadable or mismatched receipt; re-run with --force to back up the tree and reinstall it`);
      return { mode: "install", reason: "mismatched receipt replaced with --force" };
    default:
      if (!force) throw new Error(`${SKILL_NAME} at ${before.skillDir} differs from the packaged skill; re-run with --force to back it up and replace it`);
      return { mode: "install", reason: "drifted skill replaced with --force" };
  }
}

export const BINDINGS_HINT = "persisted bindings in --policy-root stay until forget, revoke_send or revoke_approve in a Codex chat; the policy state, any legacy archive and project .codex/config.toml files are untouched";

/** What an explicit uninstall would remove: only pieces a receipt proves this command installed, unless forced. */
export function planUninstall(before, force) {
  let mcp;
  if (before.mcpState === "missing") {
    mcp = before.mcpReceiptState === "unmanaged" ? { mode: "none", reason: "no user-level entry" } : { mode: "receipt", reason: "stale receipt without an entry" };
  } else if (before.mcpReceiptState === "managed") {
    mcp = { mode: "remove", reason: "managed entry" };
  } else if (!force) {
    throw new Error(`${SERVER_NAME} entry is ${before.mcpState} and not managed by a receipt; re-run with --force to back up config.toml and remove it anyway`);
  } else {
    mcp = { mode: "remove", reason: `${before.mcpState} entry removed with --force` };
  }
  let skill;
  if (before.skillState === "missing") {
    skill = before.skillReceiptState === "unmanaged" ? { mode: "none", reason: "skill not installed" } : { mode: "receipt", reason: "stale receipt without a skill tree" };
  } else if (before.skillState === "symlink") {
    throw new Error(`${before.skillDir} is a symlink that this command did not create; remove it yourself`);
  } else if (before.skillState === "current" && before.skillReceiptState === "managed") {
    skill = { mode: "remove", reason: "managed skill copy" };
  } else if (!force) {
    throw new Error(`${SKILL_NAME} at ${before.skillDir} is ${before.skillState}/${before.skillReceiptState}; re-run with --force to back it up and remove only this tree`);
  } else {
    skill = { mode: "remove", reason: `${before.skillState} skill removed with --force` };
  }
  return { mcp, skill };
}

function ensurePrivateDirectory(dir, parent) {
  if (existsSync(dir)) {
    const stat = lstatSync(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`refusing to use ${dir}: not a plain directory`);
    return;
  }
  if (parent) ensurePrivateDirectory(parent);
  mkdirSync(dir, { mode: 0o700 });
}

function stampOf(date) {
  return date.toISOString().replace(/[:.]/g, "-");
}

/** Copy config.toml aside (0600): `codex mcp add`/`remove` rewrite the file and drop inline comments. */
function backupConfig(configPath, backupsDir, stamp) {
  if (!existsSync(configPath)) return null;
  const stat = lstatSync(configPath);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`refusing to back up ${configPath}: not a plain file`);
  const target = join(backupsDir, `config.toml-${stamp}`);
  copyFileSync(configPath, target, fsConstants.COPYFILE_EXCL);
  chmodSync(target, 0o600);
  return target;
}

function writeMcpReceipt(path, launcher) {
  const body = JSON.stringify({ schemaVersion: 1, name: SERVER_NAME, fingerprint: launcherFingerprint(launcher), launcher }, null, 2) + "\n";
  rmSync(path, { force: true });
  writeFileSync(path, body, { mode: 0o600 });
}

/** Move a directory into the backups root, copying when the two live on different filesystems. */
function moveToBackup(source, target) {
  try {
    renameSync(source, target);
  } catch (error) {
    if (error?.code !== "EXDEV") throw error;
    cpSync(source, target, { recursive: true, errorOnExist: true, force: false });
    rmSync(source, { recursive: true, force: true });
  }
}

/** Unpack the packaged skill into a temporary directory; the caller removes it. */
function stageSkill(layout) {
  const temp = mkdtempSync(join(tmpdir(), "agent-fleet-skill-"));
  try {
    const extracted = extractSkillZip(layout.skillZip, join(temp, "zip"));
    if (extracted.name !== SKILL_NAME) throw new Error(`packaged archive ${layout.skillZip} contains ${JSON.stringify(extracted.name)}, expected ${SKILL_NAME}`);
    return { temp, sourceDir: extracted.root };
  } catch (error) {
    rmSync(temp, { recursive: true, force: true });
    throw error;
  }
}

/** cpSync creates directories with the umask default; keep the private copy 0700/0600 like the rest of our state. */
function tightenTree(root) {
  const stat = lstatSync(root);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    chmodSync(root, 0o700);
    for (const entry of readdirSync(root)) tightenTree(join(root, entry));
  } else if (stat.isFile()) {
    chmodSync(root, 0o600);
  }
}

function installSkill(mode, before, layout, at) {
  ensurePrivateDirectory(layout.stateDir, layout.codexHome);
  if (mode === "adopt") {
    const fresh = directoryFingerprint(layout.skillDir);
    if (fresh !== before.skillSourceFingerprint) throw new Error(`${SKILL_NAME} changed while being adopted; re-run status and retry`);
    writeReceipt(layout.receipts.skill, { name: SKILL_NAME, fingerprint: fresh });
    return null;
  }
  const staged = stageSkill(layout);
  try {
    const backupDir = atomicInstallArtifact({
      sourceDir: staged.sourceDir,
      installedDir: layout.skillDir,
      skillsDir: layout.skillsDir,
      backupRoot: layout.backupsDir,
      name: SKILL_NAME,
      receipt: layout.receipts.skill,
      now: () => at,
      label: "Codex skills",
    });
    tightenTree(layout.skillDir);
    return backupDir;
  } finally {
    rmSync(staged.temp, { recursive: true, force: true });
  }
}

/**
 * install/update: refuse on status errors, plan both pieces, prove the
 * launcher starts, back up config.toml, register through `codex mcp add`,
 * re-read, write the receipt, then install the skill copy. A dry run reports
 * the modes, argv and planned backups and neither probes nor writes.
 */
async function installAll(action, before, options) {
  if (before.errors.length) throw new Error(`refusing ${action}:\n- ${before.errors.join("\n- ")}`);
  const mcpPlan = planMcpInstall(before, options.force);
  const skillPlan = planSkillInstall(before, options.force);
  const layout = resolveCodexMcpLayout(options);
  const codexArgv = mcpPlan.mode === "add" ? ["mcp", "add", SERVER_NAME, "--", before.launcher.command, ...before.launcher.args] : null;
  const changed = mcpPlan.mode !== "none" || skillPlan.mode !== "none";
  const summary = { action, mode: mcpPlan.mode, reason: mcpPlan.reason, skillMode: skillPlan.mode, skillReason: skillPlan.reason, changed, codexArgv };
  if (!changed) return { ...before, ...summary, probe: null, backupPath: null, skillBackupDir: null };
  const at = (options.now ?? (() => new Date()))();
  const stamp = stampOf(at);
  if (options.dryRun) {
    return {
      ...before,
      ...summary,
      dryRun: true,
      probe: null,
      backupPath: mcpPlan.mode === "add" && existsSync(layout.configPath) ? join(layout.backupsDir, `config.toml-${stamp}`) : null,
      skillBackupDir: skillPlan.mode === "install" && before.skillState !== "missing" ? join(layout.backupsDir, `${SKILL_NAME}-${stamp}`) : null,
    };
  }

  let probed = null;
  let backupPath = null;
  if (mcpPlan.mode !== "none") {
    const probe = options.probe ?? probeMcpServer;
    probed = await probe({ command: before.launcher.command, args: before.launcher.args, expectedName: SERVER_NAME, timeoutMs: PROBE_TIMEOUT_MS });
    const codex = options.codex ?? runCodexCommand;
    ensurePrivateDirectory(layout.stateDir, layout.codexHome);
    // The server creates --policy-root itself on first use but requires its parent to exist.
    if (layout.policyRootIsDefault) ensurePrivateDirectory(dirname(layout.policyRoot), layout.stateDir);
    if (mcpPlan.mode === "add") {
      ensurePrivateDirectory(layout.backupsDir, layout.stateDir);
      backupPath = backupConfig(layout.configPath, layout.backupsDir, stamp);
      await codex(codexArgv, { cwd: before.codexCwd });
    }
    const entry = (await listServers(codex, before.codexCwd)).find(candidate => candidate.name === SERVER_NAME);
    const check = evaluateMcpEntry(entry, before.launcher, "unmanaged");
    if (check.mcpState !== "adoptable") {
      const seen = check.mcpState === "missing" ? "no" : `a ${check.mcpState}`;
      throw new Error(`codex reports ${seen} ${SERVER_NAME} entry after ${mcpPlan.mode}; receipt not written${backupPath ? `; config.toml backup: ${backupPath}` : ""}`);
    }
    writeMcpReceipt(layout.receipts.mcp, before.launcher);
  }
  let skillBackupDir = null;
  if (skillPlan.mode !== "none") skillBackupDir = installSkill(skillPlan.mode, before, layout, at);
  const after = await inspectCodexMcp(options);
  return { ...after, ...summary, probe: probed, backupPath, skillBackupDir };
}

/**
 * uninstall: remove only what a receipt proves this command installed (or
 * anything, with --force, after backing it up). Policy state, legacy archives
 * and project config files are never touched, and bindings are not revoked.
 */
async function uninstallAll(before, options) {
  const planned = planUninstall(before, options.force);
  const layout = resolveCodexMcpLayout(options);
  const changed = planned.mcp.mode !== "none" || planned.skill.mode !== "none";
  const summary = {
    action: "uninstall",
    mode: planned.mcp.mode,
    reason: planned.mcp.reason,
    skillMode: planned.skill.mode,
    skillReason: planned.skill.reason,
    changed,
    bindingsRetained: true,
    bindingsHint: BINDINGS_HINT,
  };
  if (!changed) return { ...before, ...summary, backupPath: null, skillBackupDir: null };
  const stamp = stampOf((options.now ?? (() => new Date()))());
  const skillBackupDir = planned.skill.mode === "remove" ? join(layout.backupsDir, `${SKILL_NAME}-uninstall-${stamp}`) : null;
  if (options.dryRun) {
    return {
      ...before,
      ...summary,
      dryRun: true,
      backupPath: planned.mcp.mode === "remove" && existsSync(layout.configPath) ? join(layout.backupsDir, `config.toml-${stamp}`) : null,
      skillBackupDir,
    };
  }

  const codex = options.codex ?? runCodexCommand;
  let backupPath = null;
  if (planned.mcp.mode === "remove") {
    ensurePrivateDirectory(layout.stateDir, layout.codexHome);
    ensurePrivateDirectory(layout.backupsDir, layout.stateDir);
    backupPath = backupConfig(layout.configPath, layout.backupsDir, stamp);
    await codex(["mcp", "remove", SERVER_NAME], { cwd: before.codexCwd });
    const entry = (await listServers(codex, before.codexCwd)).find(candidate => candidate.name === SERVER_NAME);
    if (entry) throw new Error(`codex still reports an ${SERVER_NAME} entry after remove; receipt kept${backupPath ? `; config.toml backup: ${backupPath}` : ""}`);
  }
  if (planned.mcp.mode !== "none") rmSync(layout.receipts.mcp, { force: true });
  if (planned.skill.mode === "remove") {
    ensurePrivateDirectory(layout.stateDir, layout.codexHome);
    ensurePrivateDirectory(layout.backupsDir, layout.stateDir);
    moveToBackup(layout.skillDir, skillBackupDir);
  }
  if (planned.skill.mode !== "none") rmSync(layout.receipts.skill, { force: true });
  const after = await inspectCodexMcp(options);
  return { ...after, ...summary, backupPath, skillBackupDir };
}

export async function setCodexMcp(options) {
  const { action } = parseSetCodexMcpArgs(options.positionals);
  const before = await inspectCodexMcp(options);
  if (action === "status") return before;
  if (action === "uninstall") return uninstallAll(before, options);
  return installAll(action, before, options);
}
