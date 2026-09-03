import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildFleetRows, type FleetSource } from "../lib/fleet-read-model.ts";
import { renderFleetDashboard } from "../lib/fleet-dashboard-view.ts";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const shortcutSource = readFileSync(new URL("./input/shortcuts.ts", import.meta.url), "utf8");
const poolSource = readFileSync(new URL("./ui/pool.ts", import.meta.url), "utf8");
const turnLifecycleSource = readFileSync(new URL("./lifecycle/turn-handlers.ts", import.meta.url), "utf8");
const dashboardSource = readFileSync(new URL("./ui/fleet-dashboard.ts", import.meta.url), "utf8");
const detailSource = readFileSync(new URL("./ui/detail-panel.ts", import.meta.url), "utf8");
const uiSource = dashboardSource + detailSource;
const budgetSource = readFileSync(new URL("./context/budgets.ts", import.meta.url), "utf8");
const gridSource = readFileSync(new URL("./ui/grid.ts", import.meta.url), "utf8");
const timelineSource = readFileSync(new URL("./timeline.ts", import.meta.url), "utf8");
const modelPolicySource = readFileSync(new URL("./policy/models.ts", import.meta.url), "utf8");
const researchSpawnSource = readFileSync(new URL("./research/spawn-run.ts", import.meta.url), "utf8");
const actionExecutorsSource = readFileSync(new URL("./tools/action-executors.ts", import.meta.url), "utf8");
const sessionStartPromptSource = readFileSync(new URL("./prompts/session-start.ts", import.meta.url), "utf8");
const historyStoreSource = readFileSync(new URL("./ui/history-store.ts", import.meta.url), "utf8");
const agentsListCommandSource = readFileSync(new URL("./commands/agents-list.ts", import.meta.url), "utf8");
const zoomCommandSource = readFileSync(new URL("./commands/zoom.ts", import.meta.url), "utf8");
const agentModelsSubstituteCommandSource = readFileSync(new URL("./commands/agent-models-substitute.ts", import.meta.url), "utf8");

const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text };
const specialist = (key: string, status: "idle" | "running") => ({ key, name: key[0].toUpperCase() + key.slice(1), status, model: "model", backend: "native" as const, contextPct: 0, contextTokens: 0, elapsed: 0, toolCount: 0, lastWork: "available", hasTimeline: true });

test("running research appears in Fleet Dashboard rows and vanishes after settlement even with showFinished", () => {
	const research = [{ key: "r1", name: "r1 research", status: "running" as const, model: "model", backend: "native" as const, contextPct: 0, contextTokens: null, elapsed: 1000, toolCount: 1, lastWork: "searching", hasTimeline: true }];
	const live = buildFleetRows({ specialists: [], research, peers: [] }, { showFinished: true });
	assert.deepEqual(live.map(row => row.key), ["r1"]);
	const settled = buildFleetRows({ specialists: [], research: [], peers: [] }, { showFinished: true });
	assert.equal(settled.some(row => row.kind === "research"), false);
});

test("fleet integration retains idle roster rows with coms and reconciles the same key on dispatch", () => {
	const source: FleetSource = { specialists: [specialist("builder", "idle"), specialist("researcher", "idle")], research: [], peers: [{ key: "peer:coms", name: "Coms", model: "peer-model", lastWork: "available", pending: true }] };
	const initial = buildFleetRows(source, { showFinished: false });
	assert.deepEqual(initial.map(row => row.key), ["peer:coms", "builder", "researcher"]);
	assert.match(renderFleetDashboard({ rows: initial, selection: { index: 0 }, summary: { running: 0, done: 0, failed: 0, totalTokens: 0, intervals: [], wallMs: 0 }, showFinished: false }, 120, 4, theme).join("\n"), /Builder[\s\S]*Researcher[\s\S]*Coms|Coms[\s\S]*Builder[\s\S]*Researcher/);

	const running = buildFleetRows({ ...source, specialists: [specialist("builder", "running"), specialist("researcher", "idle")] }, { showFinished: false });
	assert.equal(running.filter(row => row.key === "builder").length, 1);
	assert.equal(running.find(row => row.key === "builder")?.status, "running");
});

test("agent hub wires Fleet Dashboard, detail, stable selection, confirmation, and wall time", () => {
	assert.match(dashboardSource, /buildFleetRows\(/);
	assert.match(dashboardSource, /reconcileSelection\(selection, rows\)/);
	assert.match(dashboardSource, /wallMs: unionMs\(summary\.intervals\)/);
	// C1: wall time comes from histEntry via fleetTiming, not Date.now()-elapsed re-anchor
	assert.match(dashboardSource, /\.\.\.fleetTiming\(state\.histEntry\)/);
	assert.doesNotMatch(dashboardSource, /startedAt:\s*state\.status === "idle" \? undefined : Date\.now\(\) - state\.elapsed/);
	assert.match(dashboardSource, /dashboardTransition\(/);
	assert.match(dashboardSource, /press \$\{confirm\.action === "kill" \? "x" : "r"\} again/);
	assert.match(dashboardSource, /deps\.openDetail\(selected, ctx, detailVerbose\)/);
	assert.match(detailSource, /resources\.every\(2000, \(\) => tui\.requestRender\(\)\)/);
	assert.match(source, /createTranscriptStore: createFleetTranscriptStore/);
	assert.match(researchSpawnSource, /createTranscriptStore\(/);
	assert.match(detailSource, /readFleetTranscriptTail\(/);
	assert.match(detailSource, /readFleetTranscriptBefore\(/);
	assert.match(timelineSource, /MAX_LIVE_TIMELINE_ENTRIES = 500/);
	assert.match(researchSpawnSource, /kind: "tool-result"/);
	assert.match(detailSource, /detailTransition\(/);
	assert.match(detailSource, /if \(modelPicker\) return renderFleetModelPicker/);
	assert.match(detailSource, /action === "model"[\s\S]*?loadAvailableModelChoices/);
	assert.match(uiSource, /modelPickerTransition\(/);
	assert.match(dashboardSource, /renderFleetSubstitutionPicker\(/);
	assert.match(dashboardSource, /intent === "substitute"[\s\S]*?substitutionSourceChoices\(\)/);
	assert.match(modelPolicySource, /substitutions\.set\(source, target\)/);
	assert.match(detailSource, /resolvedSubagentModel\(/);
	assert.match(detailSource, /matchedInput[\s\S]*?matchesKey\(data, Key\.up\)[\s\S]*?matchesKey\(data, Key\.down\)/);
	assert.match(detailSource, /modelRegistry\?\.getAvailable/);
	assert.match(detailSource, /modelPolicy\.setPersonaOverride/);
	assert.match(detailSource, /target\.state\.model = picked/);
	assert.match(detailSource, /modelPolicy\.setSubagentOverride/);
	assert.match(detailSource, /current runs are not interrupted/);
	// C3–C7 wiring: pure ops drive kill/restart/ticker/timeline/compact guards
	assert.match(dashboardSource, /resolveFleetKill\(/);
	assert.match(dashboardSource, /resolveFleetRestart\(/);
	assert.match(dashboardSource, /attachFleetDashboardTicker\(/);
	assert.match(detailSource, /liveTimeline\(target\)/);
	assert.match(detailSource, /snapshotFleetDetailRow\(detailRow, target\)/);
	assert.match(source, /gridCols = gridColumnsForSize\(agentStates\.size\);/);
	assert.doesNotMatch(gridSource, /agent-research/);
	assert.doesNotMatch(gridSource, /getResearchStates/);
	assert.equal(((source + gridSource).match(/compactWidgetsEnabled\(/g) ?? []).length, 3, "composition and grid guards use the shared predicate");
	assert.match(source, /isCompact: \(\) => compactWidgetsEnabled\(viewMode\)/, "extracted shortcuts and pool receive the shared predicate");
	assert.match(shortcutSource, /ports\.isCompact\(\)/);
	assert.doesNotMatch(uiSource, /function (?:shortModel|thinkingSuffix|modelWithThinking)\(/, "Phase 6.5 UI consumes the root-owned formatters");
	assert.match(source, /createFleetDashboard<[\s\S]*?shortModel,[\s\S]*?thinkingSuffix,[\s\S]*?modelWithThinking,/, "dashboard receives shared runtime formatters explicitly");
	assert.doesNotMatch(source, /declare const (?:shortModel|thinkingSuffix|modelWithThinking)/, "runtime formatters cannot be ambient-only declarations");
	assert.match(source, /function shortModel\(model: string \| undefined\)[\s\S]*?function thinkingSuffix\(rawThinking: string \| undefined\)[\s\S]*?function modelWithThinking\(def: AgentDef\)/, "composition root owns the shared model presentation helpers");
	assert.match(source, /createGridUI\(\{[\s\S]*?displayName, shortModel, modelWithThinking,/, "grid receives the shared runtime helpers explicitly");
	assert.doesNotMatch(gridSource, /function (?:shortModel|thinkingSuffix|modelWithThinking)\(/, "grid does not duplicate shared presentation semantics");
	assert.match(gridSource, /deps\.shortModel\([\s\S]*?deps\.modelWithThinking\(/, "extracted grid calls its injected formatters");
	assert.match(source, /import \{[\s\S]*?abbreviateModel,[\s\S]*?\} from "\.\.\/lib\/coms-core\.ts"/, "coms model abbreviation remains separate");
	// confirmation window is owned by the pure controller
	const dash = readFileSync(new URL("../lib/fleet-dashboard-view.ts", import.meta.url), "utf8");
	assert.match(dash, /until: now \+ 2000/);
});

test("task lifecycle closes at agent_end and task-reset mutations are auditable", () => {
	assert.match(source, /pi\.on\("agent_end"[\s\S]*?turnHandlers\.agentEnd\(ctx\)/);
	assert.match(turnLifecycleSource, /const endedAt = Date\.now\(\);[\s\S]*?ports\.closeTurnActiveTime\(endedAt\);[\s\S]*?ports\.endHistoryTurn\(endedAt\);/);
	assert.match(historyStoreSource, /endTurn\(endedAt = now\(\)\)[\s\S]*?turnActive = false;[\s\S]*?currentTurnStartedAt = 0;/);
	assert.match(budgetSource, /setTaskClock\(resetTaskClock\(state\.getTaskClock\(\), now\)\)/);
	assert.doesNotMatch(source + budgetSource, /appendEntry\("agent-hub-mode"/);
	assert.match(budgetSource, /appendEntry\("agent-hub-task-reset", buildTaskResetAudit\(/);
	assert.match(actionExecutorsSource, /appendTaskResetEntry\("tool:set_task_tier"/);
	assert.doesNotMatch(source, /registerCommand\("af-new-task"/);
	assert.doesNotMatch(source, /registerCommand\("af-hub-mode"/);
});

test("shortcuts, command, compact toggle, footer, and pool use the separate fleet flow", () => {
	// A12 — each named route/key/hint individually
	assert.match(source, /registerInputShortcuts\(pi,/);
	assert.match(shortcutSource, /registerShortcut\("alt\+a"[\s\S]*?ports\.openFleetDashboard\(ctx\)/);
	assert.match(source, /registerAgentsList\(pi, commandCtx\)/);
	assert.match(agentsListCommandSource, /registerCommand\("af-agents-list"[\s\S]*?handleAgentsList/);
	assert.match(source, /handleAgentsList: async \(_args, _ctx\) => \{[\s\S]*?await openFleetDashboard\(_ctx\)/);
	assert.match(source, /registerAgentModelsSubstitute\(pi, commandCtx\)/);
	assert.match(agentModelsSubstituteCommandSource, /registerCommand\("af-agent-models-substitute"[\s\S]*?getSubstituteCompletions[\s\S]*?handleAgentModelsSubstitute/);
	assert.match(source, /handleAgentModelsSubstitute: async \(args, ctx\) => \{[\s\S]*?tokens\.length === 0[\s\S]*?openFleetDashboard\(ctx, true\)/);
	assert.match(shortcutSource, /registerShortcut\("alt\+m"[\s\S]*?ports\.openWorkModePicker\(ctx\)/);
	assert.match(shortcutSource, /registerShortcut\("alt\+shift\+a"[\s\S]*?ports\.toggleCompact\(\)/);
	assert.ok(shortcutSource.includes('registerShortcut("alt+\\\\",'));
	assert.match(shortcutSource, /registerShortcut\("alt\+\\\\"[\s\S]*?ports\.openMarkedAgent\(ctx, marked\)/);
	assert.match(source, /registerZoom\(pi, commandCtx\)/);
	assert.match(zoomCommandSource, /registerCommand\("af-zoom"[\s\S]*?getZoomCompletions[\s\S]*?handleZoom/);
	assert.match(source, /handleZoom: async \(args, ctx\) => \{[\s\S]*?const rowKey = \(rid != null \? `r\$\{rid\}` : arg\)\.toLowerCase\(\)[\s\S]*?r\.key\.toLowerCase\(\) === rowKey/);
	assert.match(source, /function findDelegationChild[\s\S]*?candidate\.id\.toLowerCase\(\) === lower/);
	assert.match(source, /getHint: \(\) => composeFleetFooterHint\(viewMode, compactWorkMode\(getWorkMode\(\)\)\)/);
	assert.match(sessionStartPromptSource, /const hint = theme\.fg\("dim", deps\.getHint\(\)\);/);
	assert.doesNotMatch(source + sessionStartPromptSource, /theme\.fg\("muted", "Alt\+A "\) \+ theme\.fg\("dim", composeFleetFooterHint/);
	assert.match(poolSource, /const peerInputs[\s\S]*?pending: true/);
	assert.match(poolSource, /const render[\s\S]*?buildFleetRows\([\s\S]*?peers: peerInputs\(\)/);
	assert.doesNotMatch(poolSource, /const render[\s\S]*?staleCount.*>= 3/);
	assert.match(dashboardSource, /function fleetRows\(unfiltered = false\)[\s\S]*?Array\.from\(deps\.getAgents\(\)\.entries\(\)\)\.map\(\(\[key, state\]\)[\s\S]*?deps\.getPeerInputs\(model => `⇄ \$\{deps\.abbreviatePeerModel\(model\)\}`\)[\s\S]*?return buildFleetRows/);
	assert.match(dashboardSource, /dashboardTransition\(/);
});
