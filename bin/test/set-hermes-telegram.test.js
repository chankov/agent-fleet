import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import {
	inferProjectFromProcessInfo,
	parseHerdrOutput,
	parseRunningGatewayProfiles,
	parseSetHermesTelegramArgs,
	parseTelegramToolReadiness,
	setHermesTelegram,
} from "../lib/set-hermes-telegram.js";

const CURRENT = "w7:p3";
const WORKSPACE = "w7";

function fakeHerdr(existing = []) {
	const calls = [];
	const run = async (args) => {
		calls.push(args);
		const key = args.join(" ");
		if (key === `pane get ${CURRENT}`) return { result: { pane: { pane_id: CURRENT, workspace_id: WORKSPACE, cwd: "/work/repo" } } };
		if (key === `pane process-info --pane ${CURRENT}`) {
			return { result: { process_info: { foreground_processes: [{ argv: ["just", "hub", "--project", "acme.prod"] }] } } };
		}
		if (key === `pane list --workspace ${WORKSPACE}`) return { result: { panes: existing } };
		if (args[0] === "pane" && args[1] === "split") return { result: { pane: { pane_id: "w7:p9", workspace_id: WORKSPACE } } };
		return { result: {} };
	};
	return { calls, run };
}

function hermesFixture(t, options = {}) {
	const root = mkdtempSync(join(tmpdir(), "set-hermes-telegram-"));
	const profilePath = join(root, "profile");
	const sourceDir = join(root, "source", "hub-liaison");
	mkdirSync(sourceDir, { recursive: true });
	mkdirSync(profilePath, { recursive: true });
	writeFileSync(join(sourceDir, "SKILL.md"), options.source ?? "new skill\n");
	if (options.installed !== null) {
		const installedDir = join(profilePath, "skills", "hub-liaison");
		mkdirSync(installedDir, { recursive: true });
		writeFileSync(join(installedDir, "SKILL.md"), options.installed ?? options.source ?? "new skill\n");
	}
	const calls = [];
	const run = async (args) => {
		calls.push(args);
		const key = args.join(" ");
		if (key === "gateway list") {
			if (options.multipleGateways) return "  ✓ default (current) — PID 1\n  ✓ hub — PID 2\n";
			return options.gatewayRunning === false ? "  ✗ default (current) — not running\n" : "  ✓ default (current) — PID 1\n";
		}
		if (key === "profile show default") return `\nProfile: default\nPath:    ${profilePath}\nGateway: running\n`;
		if (key === "--profile default skills list --enabled-only") {
			return options.skillEnabled === false ? "" : "│ hub-liaison │ local │ local │ enabled │\n";
		}
		if (key === "--profile default tools list --platform telegram") {
			const terminal = options.terminal === false ? "✗ disabled" : "✓ enabled";
			const file = options.file === false ? "✗ disabled" : "✓ enabled";
			return `${terminal}  terminal  Terminal & Processes\n${file}  file  File Operations\n`;
		}
		if (key === "--profile default gateway restart") return "restarted\n";
		throw new Error(`unexpected Hermes call: ${key}`);
	};
	return { root, profilePath, sourceDir, calls, run };
}

function readyOptions(t, extra = {}) {
	const fixture = hermesFixture(t, extra.fixture);
	return { fixture, options: { profile: "default", packageRoot: "/opt/agent-fleet", skillSourceDir: fixture.sourceDir, hermes: fixture.run, ...extra.options } };
}

test("parser supports install/status and validates on/off Telegram destinations", () => {
	assert.deepEqual(parseSetHermesTelegramArgs(["install"]), { action: "install" });
	assert.deepEqual(parseSetHermesTelegramArgs(["status"]), { action: "status" });
	assert.deepEqual(parseSetHermesTelegramArgs(["on", "7883056502"]), { action: "on", telegramId: "7883056502", target: "telegram:7883056502" });
	assert.equal(parseSetHermesTelegramArgs(["off", "7883056502:1735"]).target, "telegram:7883056502:1735");
	for (const argv of [[], ["install", "extra"], ["start", "123"], ["on", "telegram:123"], ["on", "123:"], ["on", ":123"], ["on", "123:456:789"], ["on", "12a"], ["off", "123", "extra"]]) {
		assert.throws(() => parseSetHermesTelegramArgs(argv), /Usage:|Telegram ID/);
	}
});

test("Hermes parsers detect running profiles and required Telegram tools", () => {
	assert.deepEqual(parseRunningGatewayProfiles("  ✓ default (current) — PID 1\n  ✗ dev — not running\n"), ["default"]);
	assert.deepEqual(parseTelegramToolReadiness("✓ enabled  terminal  Terminal\n✓ enabled  file  Files\n"), { terminal: true, file: true });
	assert.deepEqual(parseTelegramToolReadiness("✗ disabled terminal\n✓ enabled file\n"), { terminal: false, file: true });
});

test("successful Herdr mutations may return no JSON body", () => {
	assert.deepEqual(parseHerdrOutput(""), { result: {} });
	assert.deepEqual(parseHerdrOutput("  \n"), { result: {} });
	assert.deepEqual(parseHerdrOutput('{"result":{"ok":true}}'), { result: { ok: true } });
});

test("project inference follows the current hub's explicit --project flag", () => {
	assert.equal(inferProjectFromProcessInfo({ result: { process_info: { foreground_processes: [{ argv: ["just", "hub", "--project", "af"] }, { argv: ["pi", "--project=ignored-later"] }] } } }, {}), "af");
	assert.equal(inferProjectFromProcessInfo({ result: { process_info: { foreground_processes: [] } } }, { PI_COMS_PROJECT: "env-project" }), "env-project");
	assert.equal(inferProjectFromProcessInfo({}, {}), "default");
	assert.throws(() => inferProjectFromProcessInfo({ result: { process_info: { foreground_processes: [{ argv: ["pi", "--project", "../bad"] }] } } }, {}), /Invalid project/);
});

test("status auto-detects one running gateway and reports drift without writing", async (t) => {
	const fixture = hermesFixture(t, { installed: "old skill\n" });
	const result = await setHermesTelegram({ positionals: ["status"], packageRoot: "/opt", skillSourceDir: fixture.sourceDir, hermes: fixture.run });
	assert.equal(result.action, "status");
	assert.equal(result.profile, "default");
	assert.equal(result.skillState, "drifted");
	assert.equal(result.skillEnabled, true);
	assert.deepEqual(result.tools, { terminal: true, file: true });
	assert.equal(result.ready, false);
	assert.equal(readFileSync(join(fixture.profilePath, "skills", "hub-liaison", "SKILL.md"), "utf8"), "old skill\n");
});

test("install-only flags are rejected for status/on/off", async () => {
	await assert.rejects(() => setHermesTelegram({ positionals: ["status"], force: true }), /valid only with install/);
	await assert.rejects(() => setHermesTelegram({ positionals: ["off", "123"], restart: true }), /valid only with install/);
});

test("profile auto-detection fails closed when more than one gateway runs", async (t) => {
	const fixture = hermesFixture(t, { multipleGateways: true });
	await assert.rejects(() => setHermesTelegram({ positionals: ["status"], packageRoot: "/opt", skillSourceDir: fixture.sourceDir, hermes: fixture.run }), /exactly one running gateway.*--profile/);
});

test("install refuses drift without --force and preserves the installed skill", async (t) => {
	const fixture = hermesFixture(t, { installed: "locally changed\n" });
	await assert.rejects(() => setHermesTelegram({ positionals: ["install"], profile: "default", packageRoot: "/opt", skillSourceDir: fixture.sourceDir, hermes: fixture.run }), /--force/);
	assert.equal(readFileSync(join(fixture.profilePath, "skills", "hub-liaison", "SKILL.md"), "utf8"), "locally changed\n");
});

test("install refuses a symlinked Hermes skills directory", async (t) => {
	const fixture = hermesFixture(t, { installed: null });
	const external = join(fixture.root, "external-skills");
	mkdirSync(external);
	symlinkSync(external, join(fixture.profilePath, "skills"));
	await assert.rejects(() => setHermesTelegram({ positionals: ["install"], profile: "default", packageRoot: "/opt", skillSourceDir: fixture.sourceDir, hermes: fixture.run }), /unsafe Hermes directory/);
});

test("forced install backs up drift, atomically installs, verifies, and restarts only explicitly", async (t) => {
	const fixture = hermesFixture(t, { installed: "old skill\n" });
	const result = await setHermesTelegram({
		positionals: ["install"], profile: "default", force: true, restart: true,
		packageRoot: "/opt", skillSourceDir: fixture.sourceDir, hermes: fixture.run,
		now: () => new Date("2026-07-24T12:34:56.000Z"),
	});
	assert.equal(result.changed, true);
	assert.equal(result.restarted, true);
	assert.equal(result.restartRequired, false);
	assert.equal(result.ready, true);
	assert.equal(readFileSync(join(fixture.profilePath, "skills", "hub-liaison", "SKILL.md"), "utf8"), "new skill\n");
	assert.equal(readFileSync(join(result.backupDir, "SKILL.md"), "utf8"), "old skill\n");
	assert.ok(fixture.calls.some((args) => args.join(" ") === "--profile default gateway restart"));
});

test("installing a missing skill needs no force and offers restart without performing it", async (t) => {
	const fixture = hermesFixture(t, { installed: null });
	const result = await setHermesTelegram({ positionals: ["install"], profile: "default", packageRoot: "/opt", skillSourceDir: fixture.sourceDir, hermes: fixture.run });
	assert.equal(result.changed, true);
	assert.equal(result.backupDir, null);
	assert.equal(result.restartRequired, true);
	assert.equal(result.restarted, false);
	assert.equal(fixture.calls.some((args) => args.includes("restart")), false);
	const restarted = await setHermesTelegram({ positionals: ["install"], profile: "default", restart: true, packageRoot: "/opt", skillSourceDir: fixture.sourceDir, hermes: fixture.run });
	assert.equal(restarted.changed, false);
	assert.equal(restarted.restarted, true);
});

test("on fails before touching Herdr when skill/tool/gateway readiness is incomplete", async (t) => {
	const fixture = hermesFixture(t, { terminal: false });
	const herdr = fakeHerdr();
	await assert.rejects(() => setHermesTelegram({
		positionals: ["on", "7883056502:1735"], profile: "default", currentPaneId: CURRENT,
		packageRoot: "/opt", skillSourceDir: fixture.sourceDir, hermes: fixture.run, herdr: herdr.run,
	}), /terminal\/file tools/);
	assert.equal(herdr.calls.length, 0);
});

test("ready on replaces an existing bridge and starts a labeled pane in the same workspace", async (t) => {
	const { fixture, options } = readyOptions(t);
	const herdr = fakeHerdr([{ pane_id: "w7:p4", workspace_id: WORKSPACE, label: "hermes-bridge" }]);
	const result = await setHermesTelegram({ ...options, positionals: ["on", "7883056502:1735"], currentPaneId: CURRENT, env: {}, herdr: herdr.run });
	assert.deepEqual(result, { action: "on", hermesProfile: "default", paneId: "w7:p9", project: "acme.prod", target: "telegram:7883056502:1735", workspaceId: WORKSPACE });
	assert.ok(herdr.calls.some((args) => args.join(" ") === "pane close w7:p4"));
	assert.ok(herdr.calls.some((args) => args.join(" ") === `pane split ${CURRENT} --direction right --ratio 0.3 --cwd /work/repo --no-focus`));
	const run = herdr.calls.find((args) => args[0] === "pane" && args[1] === "run");
	assert.match(run[3], /--project 'acme\.prod'/);
	assert.match(run[3], /--hermes-profile 'default'/);
	assert.match(run[3], /--to 'telegram:7883056502:1735'/);
	assert.ok(fixture.calls.some((args) => args.join(" ") === "--profile default tools list --platform telegram"));
});

test("off remains available without Hermes readiness and creates no pane", async () => {
	const herdr = fakeHerdr([{ pane_id: "w7:p4", workspace_id: WORKSPACE, label: "hermes-bridge" }]);
	const result = await setHermesTelegram({ positionals: ["off", "7883056502:1735"], currentPaneId: CURRENT, packageRoot: "/opt", env: {}, herdr: herdr.run });
	assert.deepEqual(result, { action: "off", closedPaneIds: ["w7:p4"], project: "acme.prod", target: "telegram:7883056502:1735", workspaceId: WORKSPACE });
	assert.equal(herdr.calls.some((args) => args[1] === "split"), false);
});

test("slash command artifacts expose install/status/on/off and profile options", () => {
	for (const file of [".pi/prompts/af-set-hermes-telegram.md", ".claude/commands/set-hermes-telegram.md"]) {
		const text = readFileSync(resolve(file), "utf8");
		assert.match(text, /install/);
		assert.match(text, /status/);
		assert.match(text, /on\|off/);
		assert.match(text, /--profile/);
	}
});
