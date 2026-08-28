import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildFleetRows, type FleetSource } from "../lib/fleet-read-model.ts";
import { gridColumnsForItems, gridColumnsForSize, renderCardGrid } from "../lib/fleet-dashboard-ops.ts";
import { renderFleetDashboard } from "../lib/fleet-dashboard-view.ts";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const agentsListCommandSource = readFileSync(new URL("./commands/agents-list.ts", import.meta.url), "utf8");
const zoomCommandSource = readFileSync(new URL("./commands/zoom.ts", import.meta.url), "utf8");
const agentModelsSubstituteCommandSource = readFileSync(new URL("./commands/agent-models-substitute.ts", import.meta.url), "utf8");

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
	assert.match(source, /openFleetDetail\(selected, ctx, detailVerbose\)/);
	assert.match(source, /resources\.every\(2000, \(\) => tui\.requestRender\(\)\)/);
	assert.match(source, /createFleetTranscriptStore\(/);
	assert.match(source, /readFleetTranscriptTail\(/);
	assert.match(source, /readFleetTranscriptBefore\(/);
	assert.match(source, /MAX_LIVE_TIMELINE_ENTRIES = 500/);
	assert.match(source, /kind: "tool-result"/);
	assert.match(source, /detailTransition\(/);
	assert.match(source, /if \(modelPicker\) return renderFleetModelPicker/);
	assert.match(source, /action === "model"[\s\S]*?loadFleetDetailModelChoices/);
	assert.match(source, /modelPickerTransition\(/);
	assert.match(source, /renderFleetSubstitutionPicker\(/);
	assert.match(source, /intent === "substitute"[\s\S]*?substitutionSourceChoices\(\)/);
	assert.match(source, /modelSubstitutions\.set\(source, target\)/);
	assert.match(source, /resolvedSubagentModel\(/);
	assert.match(source, /matchedFleetDetailInput[\s\S]*?matchesKey\(data, Key\.up\)[\s\S]*?matchesKey\(data, Key\.down\)/);
	assert.match(source, /modelRegistry\?\.getAvailable/);
	assert.match(source, /modelOverrides\.set\(key, picked\)/);
	assert.match(source, /target\.state\.model = picked/);
	assert.match(source, /subagentModelOverrides\.set\(target\.overrideKey, picked\)/);
	assert.match(source, /current runs are not interrupted/);
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

test("task lifecycle closes at agent_end and task-reset mutations are auditable", () => {
	assert.match(source, /pi\.on\("agent_end"[\s\S]*?closeTurnActiveTime\(turnEndedAt\);[\s\S]*?turnActive = false;[\s\S]*?currentTurnStartedAt = 0;/);
	assert.match(source, /taskClock = resetTaskClock\(taskClock, now\);/);
	assert.doesNotMatch(source, /appendEntry\("agent-hub-mode"/);
	assert.match(source, /appendEntry\("agent-hub-task-reset", buildTaskResetAudit\(/);
	assert.match(source, /appendTaskResetEntry\("tool:set_task_tier"/);
	assert.doesNotMatch(source, /registerCommand\("af-new-task"/);
	assert.doesNotMatch(source, /registerCommand\("af-hub-mode"/);
});

test("shortcuts, command, compact toggle, footer, and pool use the separate fleet flow", () => {
	// A12 — each named route/key/hint individually
	assert.match(source, /registerShortcut\("alt\+a"[\s\S]*?void openFleetDashboard\(ctx\)/);
	assert.match(source, /registerAgentsList\(pi, commandCtx\)/);
	assert.match(agentsListCommandSource, /registerCommand\("af-agents-list"[\s\S]*?handleAgentsList/);
	assert.match(source, /handleAgentsList: async \(_args, _ctx\) => \{[\s\S]*?await openFleetDashboard\(_ctx\)/);
	assert.match(source, /registerAgentModelsSubstitute\(pi, commandCtx\)/);
	assert.match(agentModelsSubstituteCommandSource, /registerCommand\("af-agent-models-substitute"[\s\S]*?getSubstituteCompletions[\s\S]*?handleAgentModelsSubstitute/);
	assert.match(source, /handleAgentModelsSubstitute: async \(args, ctx\) => \{[\s\S]*?tokens\.length === 0[\s\S]*?openFleetDashboard\(ctx, true\)/);
	assert.match(source, /registerShortcut\("alt\+m"[\s\S]*?void openWorkModePicker\(ctx\)/);
	assert.match(source, /registerShortcut\("alt\+shift\+a"[\s\S]*?viewMode = viewMode === "compact" \? "off" : "compact"/);
	assert.ok(source.includes('registerShortcut("alt+\\\\",'));
	assert.match(source, /registerShortcut\("alt\+\\\\"[\s\S]*?await openFleetDetail\(row, ctx\)/);
	assert.match(source, /registerZoom\(pi, commandCtx\)/);
	assert.match(zoomCommandSource, /registerCommand\("af-zoom"[\s\S]*?getZoomCompletions[\s\S]*?handleZoom/);
	assert.match(source, /handleZoom: async \(args, ctx\) => \{[\s\S]*?const rowKey = \(rid != null \? `r\$\{rid\}` : arg\)\.toLowerCase\(\)[\s\S]*?r\.key\.toLowerCase\(\) === rowKey/);
	assert.match(source, /function findDelegationChild[\s\S]*?candidate\.id\.toLowerCase\(\) === lower/);
	assert.match(source, /const hint = theme\.fg\("dim", composeFleetFooterHint\(viewMode, compactWorkMode\(workMode\)\)\);/);
	assert.doesNotMatch(source, /theme\.fg\("muted", "Alt\+A "\) \+ theme\.fg\("dim", composeFleetFooterHint/);
	assert.match(source, /function fleetPeerInputs[\s\S]*?pending: true/);
	assert.match(source, /function renderPool[\s\S]*?buildFleetRows\([\s\S]*?peers: fleetPeerInputs\(\)/);
	assert.doesNotMatch(source, /function renderPool[\s\S]*?staleCount.*>= 3/);
	assert.match(source, /function fleetRows\(unfiltered = false\)[\s\S]*?Array\.from\(agentStates\.entries\(\)\)\.map\(\(\[key, state\]\)[\s\S]*?fleetPeerInputs\(model => `⇄ \$\{abbreviateModel\(model\)\}`\)[\s\S]*?return buildFleetRows/);
	assert.match(source, /dashboardTransition\(/);
});
