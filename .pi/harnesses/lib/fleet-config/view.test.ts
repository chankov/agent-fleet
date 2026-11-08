import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { MIN_BODY_ROWS } from "../fleet-overlay.ts";
import { collectFleetConfigSnapshot, type FleetConfigSnapshot } from "./snapshot.ts";
import { fleetConfigTransition, KEYS } from "./transition.ts";
import { fleetConfigHeadlessText, fleetConfigRows, fleetConfigTabs, FLEET_CONFIG_CHROME_ROWS, initialViewState, renderFleetConfig, resolveTabArgument, TAB_IDS } from "./view.ts";

const metrics = { truncateToWidth, visibleWidth };
const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text };
const env = { PATH: "/usr/bin" } as NodeJS.ProcessEnv;
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/;
// pi-tui adds SGR resets while truncating; only non-SGR control bytes count as leaks from file content.
const plain = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");

function fixture(): { root: string; snapshot: FleetConfigSnapshot } {
	const root = mkdtempSync(join(tmpdir(), "fleet-config-view-"));
	mkdirSync(join(root, ".ai"), { recursive: true }); mkdirSync(join(root, ".pi", "agents"), { recursive: true });
	writeFileSync(join(root, ".ai", "agent-fleet.json"), JSON.stringify({ schemaVersion: 1, preset: "default", features: { system1: true, voice: false } }));
	writeFileSync(join(root, ".ai", "agent-fleet-state.json"), JSON.stringify({ schemaVersion: 2, agent: "pi", method: "copy", packageVersion: "2.0.14", items: { "skill:a": { kind: "skill", version: "2.0.14", method: "copy", files: [{ path: "skills/a/SKILL.md", sha256: "0".repeat(64) }] } } }));
	writeFileSync(join(root, ".ai", "agent-fleet-overrides.md"), `## agent-hub\nlanguage: Bulgarian\nmodel.builder: \u001b[31mhostile\u001b[0m value\n`);
	writeFileSync(join(root, ".pi", "agents", "teams.yaml"), "default:\n  - builder\n");
	const hub = { language: "Bulgarian", personaModels: { builder: "hostile value" }, personaModelLists: {}, personaThinking: {}, personaDelegateDepth: {}, rulesDirs: [], docsPaths: [], reconSearchTimeoutMs: 120_000, budgetOverrides: {}, watchdogSetting: "auto", watchdogJudgeModel: null, runHistoryKeep: 5, pollPanel: null, warnings: ["mode is ignored"] };
	const snapshot = collectFleetConfigSnapshot({ cwd: root, env, readHubOverrides: () => hub, runtimeRows: () => [{ label: "Work mode", detail: "operator" }], latestKnownVersion: "2.1.0" });
	return { root, snapshot };
}

test("render has fixed height, respects width and strips control characters from file content at 60/80/120 columns", () => {
	const { root, snapshot } = fixture();
	try {
		for (const tab of fleetConfigTabs(snapshot)) {
			const state = initialViewState(tab);
			state.expanded = new Set(fleetConfigRows(snapshot, tab).filter(row => row.expandable).map(row => row.key));
			for (const width of [60, 80, 120]) for (const body of [MIN_BODY_ROWS, 12]) {
				const lines = renderFleetConfig(snapshot, state, width, body, theme, metrics);
				assert.equal(lines.length, body + FLEET_CONFIG_CHROME_ROWS, `${tab} ${width}x${body}`);
				for (const line of lines) { assert.ok(visibleWidth(line) <= width, `${tab} ${width}: ${line}`); assert.doesNotMatch(plain(line), CONTROL); }
			}
		}
		const text = renderFleetConfig(snapshot, initialViewState("overview"), 400, 20, theme, metrics).join("\n");
		assert.match(text, /FLEET CONFIG/); assert.match(text, /\[1 Overview\]/); assert.match(text, /writes only via CLI/); assert.match(text, /newer than recorded/);
		assert.match(renderFleetConfig(snapshot, initialViewState("overview"), 120, 20, theme, metrics)[1], /0 Runtime/, "full labels fit at 120 columns");
		assert.match(renderFleetConfig(snapshot, initialViewState("safety"), 80, 20, theme, metrics)[1], /1 Ove .*\[9 Safety\] .*0 Run/, "inactive tabs abbreviate at 80 columns while the active one keeps its label");
		assert.match(renderFleetConfig(snapshot, initialViewState("stt"), 40, 20, theme, metrics)[1], /^1 2 3 .*\[7 STT\] 8 9 0$/, "numbers only at 40 columns");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("rows carry origin and level; overrides expand to keys with file:line and the hub warnings", () => {
	const { root, snapshot } = fixture();
	try {
		const collapsed = fleetConfigRows(snapshot, "overrides");
		assert.ok(collapsed.some(row => row.key === "ovr/section/agent-hub" && row.expandable && row.origin === ".ai/agent-fleet-overrides.md"));
		const expanded = fleetConfigRows(snapshot, "overrides", new Set(["ovr/section/agent-hub", "ovr/hub"]));
		const modelRow = expanded.find(row => row.key.startsWith("ovr/section/agent-hub/model.builder"))!;
		assert.equal(modelRow.origin, ".ai/agent-fleet-overrides.md:3"); assert.equal(modelRow.detail, "hostile value");
		assert.ok(expanded.some(row => row.key === "ovr/hub/warning/0" && row.level === "warn" && row.detail === "mode is ignored"));
		const stateRows = fleetConfigRows(snapshot, "state", new Set(["state/kind/skill", "state/item/skill:a"]));
		assert.deepEqual(stateRows.filter(row => row.key.startsWith("state/item/")).map(row => [row.depth, row.level]), [[1, "warn"], [2, "warn"]]);
		assert.equal(fleetConfigRows(snapshot, "runtime")[0].detail, "operator");
		assert.ok(fleetConfigRows(snapshot, "setup").some(row => row.key === "setup/feature/system1" && row.detail === "on" && row.path === ".ai/agent-fleet.json"));
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("transition: tabs by arrows, Tab and digits reset selection; Enter toggles; o opens only rows with a path; q and r are intents", () => {
	const { root, snapshot } = fixture();
	try {
		const state = initialViewState();
		assert.equal(fleetConfigTransition(KEYS.right, state, snapshot, 10), undefined); assert.equal(state.tab, "setup");
		assert.equal(fleetConfigTransition(KEYS.left, state, snapshot, 10), undefined); assert.equal(state.tab, "overview");
		fleetConfigTransition(KEYS.left, state, snapshot, 10); assert.equal(state.tab, "runtime", "wraps to the last tab");
		fleetConfigTransition("3", state, snapshot, 10); assert.equal(state.tab, "state"); assert.equal(state.selection.index, 0);
		fleetConfigTransition(KEYS.down, state, snapshot, 10); fleetConfigTransition(KEYS.down, state, snapshot, 10);
		assert.equal(state.selection.key, "state/kind/skill");
		fleetConfigTransition(KEYS.enter, state, snapshot, 10); assert.ok(state.expanded.has("state/kind/skill"));
		fleetConfigTransition(KEYS.down, state, snapshot, 10); assert.equal(state.selection.key, "state/item/skill:a");
		fleetConfigTransition(KEYS.enter, state, snapshot, 10); fleetConfigTransition(KEYS.down, state, snapshot, 10);
		assert.equal(fleetConfigTransition("o", state, snapshot, 10), undefined, "a missing recorded file cannot be opened");
		fleetConfigTransition("g", state, snapshot, 10);
		assert.deepEqual(fleetConfigTransition("o", state, snapshot, 10), { open: ".ai/agent-fleet-state.json" });
		fleetConfigTransition("G", state, snapshot, 2); const scrolled = state.scrollOffset; assert.ok(scrolled > 0, "selection stays visible by scrolling");
		fleetConfigTransition(KEYS.pageUp, state, snapshot, 2); assert.ok(state.scrollOffset < scrolled); assert.equal(state.selection.index, state.scrollOffset);
		assert.equal(fleetConfigTransition("q", state, snapshot, 10), "close"); assert.equal(fleetConfigTransition(KEYS.escape, state, snapshot, 10), "close");
		assert.equal(fleetConfigTransition("r", state, snapshot, 10), "refresh");
		fleetConfigTransition(KEYS.tab, state, snapshot, 10); assert.equal(state.tab, "overrides");
		fleetConfigTransition(KEYS.shiftTab, state, snapshot, 10); assert.equal(state.tab, "state");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("runtime tab exists only when the host supplies rows, and tab arguments resolve by id, label or prefix", () => {
	const { root, snapshot } = fixture();
	try {
		assert.deepEqual(fleetConfigTabs(snapshot), [...TAB_IDS]);
		const peer = collectFleetConfigSnapshot({ cwd: root, env });
		assert.ok(!fleetConfigTabs(peer).includes("runtime"));
		const state = initialViewState("runtime");
		renderFleetConfig(peer, state, 80, 6, theme, metrics); assert.equal(state.tab, "overview");
		assert.equal(resolveTabArgument("", snapshot), "overview"); assert.equal(resolveTabArgument("ai state", snapshot), "aiState"); assert.equal(resolveTabArgument("ai-state", snapshot), "aiState");
		assert.equal(resolveTabArgument("sys", snapshot), "system1"); assert.equal(resolveTabArgument("s", snapshot), null); assert.equal(resolveTabArgument("runtime", peer), null);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("headless text covers the overview without control characters", () => {
	const { root, snapshot } = fixture();
	try {
		const text = fleetConfigHeadlessText(snapshot);
		assert.match(text, /^Fleet config · Overview/); assert.match(text, /Recorded version: 2\.0\.14/); assert.doesNotMatch(text, CONTROL);
		assert.match(fleetConfigHeadlessText(snapshot, "overrides"), /## agent-hub/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

const fakeReport = (overrides: Record<string, unknown> = {}) => ({
	schemaVersion: 1, verb: "inspect" as const, packageVersion: "2.0.23", platform: "linux", agent: "pi", installation: { status: "local", reason: null },
	verify: { recordedVersion: "2.0.14", stateSource: "state-file", baseAvailable: false, summary: { total: 3, installed: 1, present: 1, broken: 1, upgradable: 0, findings: 1, problems: 0, advisories: 1, versionDrift: true, byState: { missing: 1, absent: 2 } }, items: [{ id: "skill:a", kind: "skill", state: "missing", owned: true, target: "skills/a", detail: null, retired: false, changedFiles: [], obsoleteFiles: 0 }], findings: [{ type: "base-snapshot-missing", path: ".versions/2.0.14", issue: "no snapshot", fix: "informational", severity: "advisory" }] },
	doctor: { findings: [{ type: "overrides", path: ".ai/agent-fleet-overrides.md", issue: "unknown key", fix: "remove it" }], preflight: { status: "missing_install", missingFiles: ["skills/a/SKILL.md"], tools: [], remediation: ["agent-fleet doctor --fix"] } },
	desired: { status: "valid", error: null, preset: "default", enabled: ["system1"], presets: ["default", "full", "minimal"], effective: { preset: "default", features: ["system1"], roots: 25, selected: 45 }, featureError: null, catalogue: [
		{ name: "system1", title: "System 1", stability: "experimental", platform: "any", requiresFeatures: [], items: ["companion:system1-config"], enabled: true, effective: true, available: true },
		{ name: "voice", title: "Voice", stability: "stable", platform: "any", requiresFeatures: [], items: ["pi-extension:pi-voice-stt"], enabled: false, effective: false, available: true },
		{ name: "telegram", title: "Telegram", stability: "stable", platform: "any", requiresFeatures: ["hermes"], items: [], enabled: false, effective: false, available: true },
	] },
	provenance: { status: "corrupt", error: "invalid provenance schema", entries: 0 },
	...overrides,
});
const source = { kind: "source" as const, command: "node", args: ["/pkg/bin/cli.js"], root: "/pkg" };

test("inspect states: idle names the CLI, running and failed are shown, ok enriches Overview, Setup, State and AI State with the installer's words", () => {
	const { root, snapshot } = fixture();
	try {
		snapshot.inspect = { status: "idle", resolution: source };
		assert.match(fleetConfigRows(snapshot, "overview").find(row => row.key === "inspect/idle")!.detail, /press i to run agent-fleet inspect via \/pkg\/bin\/cli\.js/);
		snapshot.inspect = { status: "idle", resolution: { kind: "unavailable", reason: "no recorded source root or package version" } };
		assert.equal(fleetConfigRows(snapshot, "overview").find(row => row.key === "inspect/idle")!.level, "warn");
		snapshot.inspect = { status: "running", startedAt: 1, resolution: source };
		assert.match(renderFleetConfig(snapshot, initialViewState("overview"), 400, 10, theme, metrics)[0], /inspect running/, "wide render: a long temp path must not truncate the status");
		snapshot.inspect = { status: "failed", reason: "timeout", detail: "no result within 120s", resolution: source, at: 2 };
		assert.match(fleetConfigRows(snapshot, "overview").find(row => row.key === "inspect/failed")!.detail, /^timeout: no result within 120s/);
		snapshot.inspect = { status: "ok", report: fakeReport(), exitCode: 0, resolution: source, at: 3 };
		const overview = fleetConfigRows(snapshot, "overview", new Set(["inspect/verify-findings", "inspect/doctor-findings"]));
		assert.match(overview.find(row => row.key === "inspect/verify")!.detail, /3 items · installed 1 · broken 1 .* recorded 2\.0\.14 ≠ running 2\.0\.23 · no base snapshot/);
		assert.match(overview.find(row => row.key === "inspect/verify-findings/0")!.detail, /\.versions\/2\.0\.14 — no snapshot · fix: informational/);
		assert.match(overview.find(row => row.key === "inspect/doctor-findings")!.detail, /1 · preflight missing_install · 1 required file missing/);
		assert.equal(overview.find(row => row.key === "inspect/remediation")!.detail, "agent-fleet doctor --fix");
		const setup = fleetConfigRows(snapshot, "setup");
		assert.match(setup.find(row => row.key === "setup/feature/system1")!.detail, /^on · experimental · 1 item$/);
		assert.match(setup.find(row => row.key === "setup/feature/voice")!.detail, /^off · stable/);
		assert.match(setup.find(row => row.key === "setup/feature/telegram")!.detail, /^not in file \(off\) · stable · requires hermes$/);
		assert.match(setup.find(row => row.key === "setup/effective")!.detail, /^system1 · 25 roots → 45 items$/);
		assert.match(setup.find(row => row.key === "setup/preset")!.detail, /known presets: default, full, minimal/);
		const invalid = { ...snapshot, inspect: { status: "ok" as const, report: fakeReport({ desired: { status: "invalid", error: 'retired feature "codex-remote"', catalogue: [], presets: [], effective: null, featureError: null } }), exitCode: 0, resolution: source, at: 4 } };
		assert.match(fleetConfigRows(invalid as any, "setup").find(row => row.key === "setup/invalid")!.detail, /retired feature "codex-remote"/);
		const state = fleetConfigRows(snapshot, "state", new Set(["state/kind/skill"]));
		assert.match(state.find(row => row.key === "state/installer")!.detail, /^missing 1 · absent 2 · repair: agent-fleet setup$/);
		assert.match(state.find(row => row.key === "state/item/skill:a")!.detail, /^missing · v2\.0\.14/);
		assert.match(fleetConfigRows(snapshot, "aiState").find(row => row.key === "ai/installer")!.detail, /^corrupt · invalid provenance schema · 0 entries$/);
		assert.equal(fleetConfigRows(snapshot, "aiState").find(row => row.key === "ai/installer")!.level, "error");
		assert.equal(fleetConfigTransition("i", initialViewState(), snapshot, 10), "inspect");
		for (const width of [60, 80, 120]) for (const line of renderFleetConfig(snapshot, initialViewState("overview"), width, 14, theme, metrics)) assert.ok(visibleWidth(line) <= width);
	} finally { rmSync(root, { recursive: true, force: true }); }
});
