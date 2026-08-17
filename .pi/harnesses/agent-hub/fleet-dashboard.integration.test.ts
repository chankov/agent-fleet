import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildFleetRows, type FleetSource } from "../lib/fleet-read-model.ts";
import { gridColumnsForItems, gridColumnsForSize, renderCardGrid } from "../lib/fleet-dashboard-ops.ts";
import { renderFleetDashboard } from "../lib/fleet-dashboard-view.ts";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text };
const specialist = (key: string, status: "idle" | "running") => ({ key, name: key[0].toUpperCase() + key.slice(1), status, model: "model", backend: "native" as const, contextPct: 0, contextTokens: 0, elapsed: 0, toolCount: 0, lastWork: "available", hasTimeline: true });

test("fleet integration retains idle roster rows with coms and reconciles the same key on dispatch", () => {
	const source: FleetSource = { specialists: [specialist("builder", "idle"), specialist("researcher", "idle")], research: [], peers: [{ key: "peer:coms", name: "Coms", model: "peer-model", lastWork: "available", pending: true }] };
	const initial = buildFleetRows(source, { showFinished: false });
	assert.deepEqual(initial.map(row => row.key), ["peer:coms", "builder", "researcher"]);
	assert.match(renderFleetDashboard({ rows: initial, selection: { index: 0 }, summary: { running: 0, done: 0, failed: 0, totalTokens: 0, intervals: [], wallMs: 0 }, showFinished: false }, 120, 4, theme).join("\n"), /Builder[\s\S]*Researcher[\s\S]*Coms|Coms[\s\S]*Builder[\s\S]*Researcher/);

	const running = buildFleetRows({ ...source, specialists: [specialist("builder", "running"), specialist("researcher", "idle")] }, { showFinished: false });
	assert.equal(running.filter(row => row.key === "builder").length, 1);
	assert.equal(running.find(row => row.key === "builder")?.status, "running");
});

test("empty native roster renders one research card through the production grid helpers", () => {
	const gridCols = gridColumnsForSize(0);
	const states = [{ id: 1, task: "investigate" }];
	const cols = gridColumnsForItems(gridCols, states.length);
	assert.equal(cols, 1);
	assert.doesNotThrow(() => renderCardGrid(states, cols, 1, state => [`r${state.id}: ${state.task}`]));
	assert.deepEqual(renderCardGrid(states, cols, 1, state => [`r${state.id}: ${state.task}`]), ["r1: investigate"]);
});

test("agent hub wires Fleet Dashboard, detail, stable selection, confirmation, and wall time", () => {
	assert.match(source, /buildFleetRows\(/);
	assert.match(source, /reconcileSelection\(selection, rows\)/);
	assert.match(source, /wallMs: unionMs\(summary\.intervals\)/);
	// C1: wall time comes from histEntry via fleetTiming, not Date.now()-elapsed re-anchor
	assert.match(source, /\.\.\.fleetTiming\(state\.histEntry\)/);
	assert.doesNotMatch(source, /startedAt:\s*state\.status === "idle" \? undefined : Date\.now\(\) - state\.elapsed/);
	assert.match(source, /dashboardTransition\(/);
	assert.match(source, /press \$\{confirm\.action === "kill" \? "x" : "r"\} again/);
	assert.match(source, /openFleetDetail\(selected, ctx\)/);
	assert.match(source, /detailTransition\(/);
	// C3–C7 wiring: pure ops drive kill/restart/ticker/timeline/compact guards
	assert.match(source, /resolveFleetKill\(/);
	assert.match(source, /resolveFleetRestart\(/);
	assert.match(source, /attachFleetDashboardTicker\(/);
	assert.match(source, /liveTimeline\(target\)/);
	assert.match(source, /gridCols = gridColumnsForSize\(agentStates\.size\);/, "an empty specialist roster cannot zero the research grid");
	assert.match(source, /const cols = gridColumnsForItems\(gridCols, states\.length\);/, "research rendering defensively rejects zero columns");
	assert.match(source, /const grid = renderCardGrid\(/, "research cards use the tested non-empty grid renderer");
	assert.equal((source.match(/compactWidgetsEnabled\(viewMode\)/g) ?? []).length, 5, "all production compact-widget guards use the shared predicate");
	// confirmation window is owned by the pure controller
	const dash = readFileSync(new URL("../lib/fleet-dashboard-view.ts", import.meta.url), "utf8");
	assert.match(dash, /until: now \+ 2000/);
});

test("task lifecycle closes at agent_end and mode/reset mutations are auditable", () => {
	assert.match(source, /pi\.on\("agent_end"[\s\S]*?closeTurnActiveTime\(turnEndedAt\);[\s\S]*?turnActive = false;[\s\S]*?currentTurnStartedAt = 0;/);
	assert.match(source, /taskClock = resetTaskClock\(taskClock, now\);/);
	assert.match(source, /appendEntry\("agent-hub-mode", buildHubModeAudit\(/);
	assert.match(source, /appendEntry\("agent-hub-task-reset", buildTaskResetAudit\(/);
	assert.match(source, /source: "slash-command"/);
	assert.match(source, /source: overrides\.hubModeSource/);
	assert.match(source, /appendTaskResetEntry\("tool:set_task_tier"/);
});

test("shortcuts, command, compact toggle, footer, and pool use the separate fleet flow", () => {
	// A12 — each named route/key/hint individually
	assert.match(source, /registerShortcut\("alt\+a"[\s\S]*?void openFleetDashboard\(ctx\)/);
	assert.match(source, /pi\.registerCommand\("af-agents-list"[\s\S]*?await openFleetDashboard\(_ctx\)/);
	assert.match(source, /registerShortcut\("alt\+shift\+a"[\s\S]*?viewMode = viewMode === "compact" \? "off" : "compact"/);
	assert.ok(source.includes('registerShortcut("alt+\\\\",'));
	assert.match(source, /registerShortcut\("alt\+\\\\"[\s\S]*?await openFleetDetail\(row, ctx\)/);
	assert.match(source, /pi\.registerCommand\("af-zoom"[\s\S]*?const rowKey = \(rid != null \? `r\$\{rid\}` : arg\)\.toLowerCase\(\)[\s\S]*?r\.key\.toLowerCase\(\) === rowKey/);
	assert.match(source, /function findDelegationChild[\s\S]*?candidate\.id\.toLowerCase\(\) === lower/);
	assert.match(source, /const hint = theme\.fg\("dim", composeFleetFooterHint\(viewMode\)\);/);
	assert.doesNotMatch(source, /theme\.fg\("muted", "Alt\+A "\) \+ theme\.fg\("dim", composeFleetFooterHint/);
	assert.match(source, /function fleetPeerInputs[\s\S]*?pending: true/);
	assert.match(source, /function renderPool[\s\S]*?buildFleetRows\([\s\S]*?peers: fleetPeerInputs\(\)/);
	assert.doesNotMatch(source, /function renderPool[\s\S]*?staleCount.*>= 3/);
	assert.match(source, /function fleetRows\(unfiltered = false\)[\s\S]*?Array\.from\(agentStates\.entries\(\)\)\.map\(\(\[key, state\]\)[\s\S]*?fleetPeerInputs\(model => `⇄ \$\{abbreviateModel\(model\)\}`\)[\s\S]*?return buildFleetRows/);
	assert.match(source, /dashboardTransition\(/);
});
