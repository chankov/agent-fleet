import { createHash, randomUUID } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const TELEGRAM_ID_RE = /^\d+(?::\d+)?$/;
const SAFE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const BRIDGE_LABEL = "hermes-bridge";
const LIAISON_SKILL = "hub-liaison";

function usageError(detail) {
	return new Error(`${detail}\nUsage:\n  agent-fleet set-hermes-telegram install [--profile NAME] [--force] [--restart]\n  agent-fleet set-hermes-telegram status [--profile NAME]\n  agent-fleet set-hermes-telegram <on|off> <telegram-id[:topic-id]> [--profile NAME]`);
}

export function parseSetHermesTelegramArgs(argv) {
	const [action, telegramId, ...extra] = argv;
	if (["install", "status"].includes(action) && telegramId === undefined && extra.length === 0) return { action };
	if (!["on", "off"].includes(action) || telegramId === undefined || extra.length > 0) {
		throw usageError("Expected install, status, or an on/off action with one Telegram ID.");
	}
	if (!TELEGRAM_ID_RE.test(telegramId)) {
		throw usageError("Telegram ID must be digits, optionally followed by a colon and a numeric topic ID.");
	}
	return { action, telegramId, target: `telegram:${telegramId}` };
}

function validateSafeName(value, label) {
	if (!SAFE_NAME_RE.test(value) || value === "." || value.includes("..")) {
		throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`);
	}
	return value;
}

function validateProject(project) {
	return validateSafeName(project, "project inferred from the current pane");
}

export function inferProjectFromProcessInfo(response, env = process.env) {
	const processes = response?.result?.process_info?.foreground_processes ?? [];
	for (const processInfo of processes) {
		const argv = Array.isArray(processInfo?.argv) ? processInfo.argv : [];
		for (let i = 0; i < argv.length; i++) {
			if (argv[i] === "--project" && typeof argv[i + 1] === "string") return validateProject(argv[i + 1]);
			if (typeof argv[i] === "string" && argv[i].startsWith("--project=")) {
				return validateProject(argv[i].slice("--project=".length));
			}
		}
	}
	const envProject = env.PI_COMS_PROJECT?.trim();
	return validateProject(envProject || "default");
}

function shellQuote(value) {
	return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

export function parseHerdrOutput(stdout) {
	const text = stdout.trim();
	if (!text) return { result: {} };
	return JSON.parse(text);
}

function runCommand(command, args) {
	const result = spawnSync(command, args, { encoding: "utf8" });
	if (result.error) throw new Error(`failed to run ${command}: ${result.error.message}`);
	if (result.status !== 0) throw new Error((result.stderr || result.stdout).trim() || `${command} ${args.join(" ")} failed`);
	return { stdout: result.stdout, stderr: result.stderr };
}

export function runHerdrCommand(args) {
	const result = runCommand("herdr", args);
	try {
		return parseHerdrOutput(result.stdout);
	} catch {
		throw new Error(`herdr returned invalid JSON for ${args.slice(0, 2).join(" ")}`);
	}
}

export function runHermesCommand(args) {
	return runCommand("hermes", args).stdout;
}

function stripAnsi(text) {
	return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

export function parseRunningGatewayProfiles(output) {
	const profiles = [];
	for (const line of stripAnsi(output).split("\n")) {
		const match = line.match(/^\s*✓\s+([A-Za-z0-9][A-Za-z0-9._-]*)(?:\s|$)/u);
		if (match) profiles.push(match[1]);
	}
	return profiles;
}

export function parseProfilePath(output, expectedProfile) {
	const clean = stripAnsi(output);
	const profile = clean.match(/^Profile:\s*(\S+)\s*$/m)?.[1];
	const profilePath = clean.match(/^Path:\s*(.+?)\s*$/m)?.[1];
	if (profile !== expectedProfile || !profilePath || !isAbsolute(profilePath)) {
		throw new Error(`Hermes returned an invalid profile description for ${expectedProfile}`);
	}
	return resolve(profilePath);
}

function directoryFingerprint(root) {
	if (!existsSync(root)) return null;
	const hash = createHash("sha256");
	function visit(current) {
		const stat = lstatSync(current);
		if (stat.isSymbolicLink()) throw new Error(`refusing symlink in Hermes skill tree: ${current}`);
		if (stat.isDirectory()) {
			for (const name of readdirSync(current).sort()) visit(join(current, name));
			return;
		}
		if (!stat.isFile()) throw new Error(`unsupported entry in Hermes skill tree: ${current}`);
		const rel = relative(root, current);
		hash.update(rel); hash.update("\0"); hash.update(readFileSync(current)); hash.update("\0");
	}
	visit(root);
	return hash.digest("hex");
}

function skillState(sourceDir, installedDir) {
	const sourceFingerprint = directoryFingerprint(sourceDir);
	if (!sourceFingerprint) throw new Error(`packaged ${LIAISON_SKILL} source is missing: ${sourceDir}`);
	const installedFingerprint = directoryFingerprint(installedDir);
	return {
		state: installedFingerprint === null ? "missing" : installedFingerprint === sourceFingerprint ? "current" : "drifted",
		sourceFingerprint,
		installedFingerprint,
	};
}

function parseSkillEnabled(output) {
	return stripAnsi(output).split("\n").some((line) => line.includes(LIAISON_SKILL) && /\benabled\b/i.test(line));
}

export function parseTelegramToolReadiness(output) {
	const clean = stripAnsi(output);
	const enabled = (name) => new RegExp(`^\\s*✓\\s+enabled\\s+${name}\\b`, "m").test(clean);
	return { terminal: enabled("terminal"), file: enabled("file") };
}

async function resolveHermesProfile(requestedProfile, hermes) {
	const gatewaysOutput = await hermes(["gateway", "list"]);
	const runningProfiles = parseRunningGatewayProfiles(gatewaysOutput);
	let profile = requestedProfile?.trim();
	if (profile) validateSafeName(profile, "Hermes profile");
	else {
		if (runningProfiles.length !== 1) {
			throw new Error(`cannot infer Hermes profile: expected exactly one running gateway, found ${runningProfiles.length}; pass --profile NAME`);
		}
		[profile] = runningProfiles;
	}
	const profileOutput = await hermes(["profile", "show", profile]);
	const profilePath = parseProfilePath(profileOutput, profile);
	if (!existsSync(profilePath) || !lstatSync(profilePath).isDirectory() || lstatSync(profilePath).isSymbolicLink()) {
		throw new Error(`unsafe or missing Hermes profile directory: ${profilePath}`);
	}
	return { profile, profilePath, gatewayRunning: runningProfiles.includes(profile) };
}

export async function inspectHermesTelegram(options) {
	const hermes = options.hermes ?? (async (args) => runHermesCommand(args));
	const resolvedProfile = await resolveHermesProfile(options.profile, hermes);
	const sourceDir = options.skillSourceDir ?? join(options.packageRoot, "hermes", "skills", LIAISON_SKILL);
	const installedDir = join(resolvedProfile.profilePath, "skills", LIAISON_SKILL);
	const skill = skillState(sourceDir, installedDir);
	const [skillsOutput, toolsOutput] = await Promise.all([
		hermes(["--profile", resolvedProfile.profile, "skills", "list", "--enabled-only"]),
		hermes(["--profile", resolvedProfile.profile, "tools", "list", "--platform", "telegram"]),
	]);
	const tools = parseTelegramToolReadiness(toolsOutput);
	const skillEnabled = parseSkillEnabled(skillsOutput);
	return {
		...resolvedProfile,
		sourceDir,
		installedDir,
		skillState: skill.state,
		skillEnabled,
		tools,
		ready: skill.state === "current" && skillEnabled && tools.terminal && tools.file && resolvedProfile.gatewayRunning,
	};
}

function readinessError(status) {
	const problems = [];
	if (status.skillState !== "current") problems.push(`${LIAISON_SKILL} is ${status.skillState}`);
	if (!status.skillEnabled) problems.push(`${LIAISON_SKILL} is not enabled`);
	if (!status.tools.terminal || !status.tools.file) problems.push("Telegram terminal/file tools are not both enabled");
	if (!status.gatewayRunning) problems.push(`gateway profile ${status.profile} is not running`);
	return `${problems.join("; ")}. Run: agent-fleet set-hermes-telegram install --profile ${status.profile}${status.skillState === "drifted" ? " --force" : ""}`;
}

function backupName(now) {
	return `${LIAISON_SKILL}-${now().toISOString().replace(/[:.]/g, "-")}`;
}

function ensurePlainDirectory(dir, parent) {
	if (existsSync(dir)) {
		const stat = lstatSync(dir);
		if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`refusing unsafe Hermes directory: ${dir}`);
		return;
	}
	if (parent) ensurePlainDirectory(parent);
	mkdirSync(dir, { mode: 0o700 });
}

function atomicInstallSkill(sourceDir, installedDir, profilePath, now) {
	const skillsDir = join(profilePath, "skills");
	ensurePlainDirectory(skillsDir, profilePath);
	const tempDir = join(skillsDir, `.${LIAISON_SKILL}.tmp-${process.pid}-${randomUUID()}`);
	const backupRoot = join(profilePath, "backups", "agent-fleet");
	let backupDir = null;
	try {
		cpSync(sourceDir, tempDir, { recursive: true, errorOnExist: true, force: false });
		directoryFingerprint(tempDir);
		if (existsSync(installedDir)) {
			ensurePlainDirectory(join(profilePath, "backups"), profilePath);
			ensurePlainDirectory(backupRoot, join(profilePath, "backups"));
			backupDir = join(backupRoot, backupName(now));
			renameSync(installedDir, backupDir);
		}
		renameSync(tempDir, installedDir);
		return backupDir;
	} catch (error) {
		rmSync(tempDir, { recursive: true, force: true });
		if (backupDir && existsSync(backupDir) && !existsSync(installedDir)) renameSync(backupDir, installedDir);
		throw error;
	}
}

export async function installHermesTelegram(options) {
	const hermes = options.hermes ?? (async (args) => runHermesCommand(args));
	const before = await inspectHermesTelegram({ ...options, hermes });
	if (before.skillState === "drifted" && !options.force) {
		throw new Error(`${LIAISON_SKILL} differs from the packaged Agent Fleet version in profile ${before.profile}; re-run with --force to back it up and replace it`);
	}
	let backupDir = null;
	let changed = false;
	if (before.skillState !== "current") {
		backupDir = atomicInstallSkill(before.sourceDir, before.installedDir, before.profilePath, options.now ?? (() => new Date()));
		changed = true;
	}
	const after = await inspectHermesTelegram({ ...options, profile: before.profile, hermes });
	if (after.skillState !== "current") throw new Error(`${LIAISON_SKILL} verification failed after install`);
	let restarted = false;
	if (options.restart && after.gatewayRunning) {
		await hermes(["--profile", after.profile, "gateway", "restart"]);
		restarted = true;
	}
	return {
		action: "install",
		profile: after.profile,
		profilePath: after.profilePath,
		skillState: after.skillState,
		skillEnabled: after.skillEnabled,
		tools: after.tools,
		gatewayRunning: after.gatewayRunning,
		ready: after.skillEnabled && after.tools.terminal && after.tools.file && after.gatewayRunning,
		changed,
		backupDir,
		restarted,
		restartRequired: changed && after.gatewayRunning && !restarted,
	};
}

async function controlBridge(options, parsed) {
	const herdr = options.herdr ?? (async (args) => runHerdrCommand(args));
	const currentPaneId = options.currentPaneId;
	if (!currentPaneId) throw new Error("HERDR_PANE_ID is required; run this command inside a Herdr pane");

	let hermesProfile = null;
	if (parsed.action === "on") {
		const status = await inspectHermesTelegram(options);
		if (!status.ready) throw new Error(readinessError(status));
		hermesProfile = status.profile;
	}

	const currentResponse = await herdr(["pane", "get", currentPaneId]);
	const currentPane = currentResponse?.result?.pane;
	if (!currentPane?.workspace_id) throw new Error(`cannot resolve workspace for current pane ${currentPaneId}`);
	const workspaceId = currentPane.workspace_id;
	const processInfo = await herdr(["pane", "process-info", "--pane", currentPaneId]);
	const project = inferProjectFromProcessInfo(processInfo, options.env);
	const list = await herdr(["pane", "list", "--workspace", workspaceId]);
	const bridgePanes = (list?.result?.panes ?? []).filter((pane) => pane.label === BRIDGE_LABEL && pane.pane_id !== currentPaneId);
	for (const pane of bridgePanes) await herdr(["pane", "close", pane.pane_id]);

	if (parsed.action === "off") {
		return { action: "off", closedPaneIds: bridgePanes.map((pane) => pane.pane_id), project, target: parsed.target, workspaceId };
	}

	const split = await herdr(["pane", "split", currentPaneId, "--direction", "right", "--ratio", "0.3", "--cwd", currentPane.cwd || process.cwd(), "--no-focus"]);
	const paneId = split?.result?.pane?.pane_id;
	if (!paneId) throw new Error("herdr did not return the new bridge pane ID");
	try {
		await herdr(["pane", "rename", paneId, BRIDGE_LABEL]);
		const command = [
			shellQuote(process.execPath), "--experimental-strip-types",
			shellQuote(join(options.packageRoot, "scripts", "coms-hermes-bridge.ts")),
			"--project", shellQuote(project), "--hermes-profile", shellQuote(hermesProfile),
			"--timeout", "1800000", "--to", shellQuote(parsed.target),
		].join(" ");
		await herdr(["pane", "run", paneId, command]);
	} catch (error) {
		await herdr(["pane", "close", paneId]).catch(() => {});
		throw error;
	}
	return { action: "on", hermesProfile, paneId, project, target: parsed.target, workspaceId };
}

export async function setHermesTelegram(options) {
	const positionals = options.positionals ?? [options.action, options.telegramId].filter((value) => value !== undefined);
	const parsed = parseSetHermesTelegramArgs(positionals);
	if (parsed.action !== "install" && (options.force || options.restart)) {
		throw usageError("--force and --restart are valid only with install.");
	}
	if (parsed.action === "status") return { action: "status", ...(await inspectHermesTelegram(options)) };
	if (parsed.action === "install") return installHermesTelegram(options);
	return controlBridge(options, parsed);
}
