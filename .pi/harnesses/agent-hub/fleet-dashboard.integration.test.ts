import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { buildFleetRows, type FleetSource } from "../lib/fleet-read-model.ts";
import { renderFleetDashboard, renderProactiveHistory } from "../lib/fleet-dashboard-view.ts";
import { detailBodyLines, openProactiveEvidence } from "../lib/fleet-detail-view.ts";
import { projectProactive } from "../lib/fleet-read-model.ts";
import { createProactiveFindings } from "./proactive-findings.ts";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerHooks } from "node:module";
import { createProactiveRuntime } from "./proactive-runtime.ts";
const codingAgent = import.meta.resolve("@earendil-works/pi-coding-agent");
const tuiPackage = import.meta.resolve("@earendil-works/pi-tui");
registerHooks({ resolve(specifier, context, nextResolve) {
	if (specifier === "@mariozechner/pi-coding-agent") return { url: codingAgent, shortCircuit: true };
	if (specifier === "@mariozechner/pi-tui") return { url: tuiPackage, shortCircuit: true };
	return nextResolve(specifier, context);
} });
const { FULLSCREEN_OVERLAY } = await import("../lib/fleet-overlay.ts");
const { createFleetDashboard } = await import("./ui/fleet-dashboard.ts");
const { createDetailPanel } = await import("./ui/detail-panel.ts");
const { createGridUI } = await import("./ui/grid.ts");
const { createFleetSource } = await import("./ui/fleet-source.ts");

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const shortcutSource = readFileSync(new URL("./input/shortcuts.ts", import.meta.url), "utf8");
const poolSource = readFileSync(new URL("./ui/pool.ts", import.meta.url), "utf8");
const turnLifecycleSource = readFileSync(new URL("./lifecycle/turn-handlers.ts", import.meta.url), "utf8");
const dashboardSource = readFileSync(new URL("./ui/fleet-dashboard.ts", import.meta.url), "utf8");
const fleetSource = readFileSync(new URL("./ui/fleet-source.ts", import.meta.url), "utf8");
const fleetActions = readFileSync(new URL("./ui/fleet-actions.ts", import.meta.url), "utf8");
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
const metrics = { truncateToWidth, visibleWidth };
const specialist = (key: string, status: "idle" | "running") => ({ key, name: key[0].toUpperCase() + key.slice(1), status, model: "model", backend: "native" as const, contextPct: 0, contextTokens: 0, elapsed: 0, toolCount: 0, lastWork: "available", hasTimeline: true });

test("P11b ledger → projection → pure detail/history → explicit retained readback, never live source", t => {
	const sha = (s: string) => createHash("sha256").update(s).digest("hex");
	const dir = mkdtempSync(join(tmpdir(), "p11b-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
	const sourcePath = join(dir, "live.md"), captured = "captured-private-payload", live = "modified-live-payload";
	writeFileSync(sourcePath, captured);
	const excerpt = { text: captured, hash: sha(captured), offset: 0, endOffset: captured.length, startLine: 1, endLine: 1, truncated: false };
	const snapshot = { snapshotId: sha(captured), turnId: "hub:one:1", head: "h", context: { task: { path: "task", revision: "r", hash: sha("task") }, rules: [{ path: "rules.md", revision: "r", hash: sha("rule") }], exceptions: [] }, planStatus: "task_only" as const, status: "complete" as const, gaps: [], units: [{ id: "unit-1", path: "docs/x.md", kind: "modified" as const, after: excerpt, attribution: "uncertain" as const }], observedPaths: 1, coverage: { retainedUnits: 1, omittedPaths: 0, retainedBytes: captured.length } };
	const ledger = createProactiveFindings({ directory: dir });
	const review = ledger.observe("hub", "one", snapshot, "reviewed", { status: "reviewed", drift: { task: "aligned", plan: "not_checked" }, rules: [], findings: [{ source: "system1", snapshotId: snapshot.snapshotId, unitId: "unit-1", reference: "rules.md#section", verdict: "potential_violation", evidenceStatus: "complete", delivery: "not_applicable" }], gaps: [], evaluations: [] });
	const projected = projectProactive({ records: [{ owner: "hub", attempt: "one", turnId: review.turnId, status: review.status }], history: ledger.history, current: ledger.current, activity: [{ type: "job_finished", jobId: "job", at: 1 }] });
	const owner = projected.owners[0], ref = owner.history[0].findings[0];
	const dashboard = renderFleetDashboard({ rows: [], selection: { index: 0 }, summary: { running: 0, done: 0, failed: 0, totalTokens: 0, intervals: [], wallMs: 0 }, showFinished: false, proactive: projected }, 160, 4, theme, metrics).join("\n");
	const detail = detailBodyLines({ ...buildFleetRows({ specialists: [specialist("hub", "running")], research: [], peers: [] }, { showFinished: true })[0], runToken: "hub:one", proactive: owner }, [], 160, null).join("\n");
	const history = renderProactiveHistory(projected, 160).join("\n");
	assert.match(dashboard, /Review/); assert.match(detail, /System 1 suspicion.*rules.md#section/); assert.match(history, /coverage[\s\S]*rules.md#section/);
	assert.doesNotMatch(dashboard + detail + history, new RegExp(captured));
	writeFileSync(sourcePath, live);
	assert.equal(openProactiveEvidence(ref, ledger.readback), captured);
	unlinkSync(sourcePath);
	assert.equal(openProactiveEvidence(ref, ledger.readback), captured);
	assert.equal(openProactiveEvidence({ ...ref, snapshotHash: sha("wrong") }, ledger.readback), null);
	unlinkSync(join(dir, `${ref.snapshotHandle}.json`));
	assert.equal(openProactiveEvidence(ref, ledger.readback), null);
});

test("mounted controller: zero-row review history, explicit retained evidence and stale session fence", async t => {
	const sha = (s: string) => createHash("sha256").update(s).digest("hex");
	const dir = mkdtempSync(join(tmpdir(), "p11-controller-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
	const live = join(dir, "source.txt"), captured = "captured\u001b[31m\nprivate evidence";
	writeFileSync(live, captured);
	const snapshot = { snapshotId: sha("snap"), turnId: "session:hub:direct:1", head: "h", context: { task: { path: "task", revision: "r", hash: sha("task") }, rules: [] }, planStatus: "task_only" as const, status: "complete" as const, gaps: [], units: [{ id: "unit", path: "docs/x.md", kind: "modified" as const, after: { text: captured, hash: sha(captured), offset: 0, endOffset: captured.length, startLine: 1, endLine: 2, truncated: false }, attribution: "uncertain" as const }], observedPaths: 1, coverage: { retainedUnits: 1, omittedPaths: 0, retainedBytes: captured.length } };
	let notices = 0; const runtime = createProactiveRuntime({ config: { version: 1, mode: "shadow", remoteContext: "disabled", include: ["docs/**"], maxEvaluationsPerSession: 1 }, findingsDirectory: dir, onChange: () => notices++ });
	assert.equal(runtime.submit("hub", "direct", snapshot, 1), true);
	assert.ok(notices >= 2, "start and close both notify idle widget");
	const review = runtime.findings.observe("hub", "direct", snapshot, "reviewed", { status: "reviewed", drift: { task: "aligned", plan: "not_checked" }, rules: [], findings: [{ source: "system1", snapshotId: snapshot.snapshotId, unitId: "unit", reference: "rule", verdict: "potential_violation", evidenceStatus: "complete", delivery: "not_applicable" }], gaps: [], evaluations: [] });
	let projection = projectProactive({ records: [{ owner: "hub", attempt: "direct", turnId: review.turnId, status: review.status }], history: runtime.findings.history, current: runtime.findings.current, activity: [{ type: "job_finished", jobId: "job", at: Date.now() - 20_000 }] });
	let reads = 0, historyCalls = 0, panel: any, close!: () => void;
	const tui = { terminal: { rows: 20, columns: 100 }, requestRender() {} };
	const ctx = { ui: { custom: (factory: any) => { panel = factory(tui, theme, null, () => close()); return new Promise<void>(resolve => { close = resolve; }); }, notify() {} } } as any;
	const dashboard = createFleetDashboard({ getFleetRows: () => [], getProactive: () => projection, readProactiveEvidence: finding => { reads++; return runtime.findings.readback(finding.snapshotHandle, finding.snapshotHash, finding.snapshotId, finding.unitId, finding.excerptHash); }, getFilter: () => "", setFilter() {}, getShowFinished: () => false, setShowFinished() {}, getComsLines: () => ["coms status"], openHistory: async () => { historyCalls++; }, modelPolicy: { allKnownModels: () => [] }, actions: { open: async () => false, execute: async () => {} } } as any);
	const opened = dashboard.openFleetDashboard(ctx);
	t.after(() => { close(); panel.dispose(); });
	const assertFullFrame = () => {
		for (const [rows, width] of [[20, 100], [40, 60], [24, 160]]) {
			tui.terminal.rows = rows; tui.terminal.columns = width;
			const lines = panel.render(width);
			assert.equal(lines.length, rows - 1, "subview must cover the dashboard footprint, not expose dispatcher chat");
			assert.ok(lines.every((line: string) => visibleWidth(line) <= width));
			// Use Pi's real compositor, not just a line-count assertion: blank
			// padding must erase the old dispatcher chat across the overlay width.
			const compositor = new TUI({ ...tui.terminal, hideCursor() {} } as any) as any;
			compositor.requestRender = () => {};
			compositor.showOverlay(panel, FULLSCREEN_OVERLAY.overlayOptions);
			const painted: string[] = compositor.compositeOverlays(Array(rows).fill("DISPATCHER_CHAT_SENTINEL"), width, rows);
			assert.equal(painted.filter(line => line.includes("DISPATCHER_CHAT_SENTINEL")).length, 1, "only the same single row reserved by the parent dashboard may remain outside the overlay");
		}
		tui.terminal.rows = 20; tui.terminal.columns = 100;
	};
	assertFullFrame();
	assert.match(panel.render(100).join("\n"), /Review/);
	assert.equal(reads, 0, "render must never read private evidence");
	await panel.handleInput("h"); assert.equal(historyCalls, 1, "execution history remains reachable");
	await panel.handleInput("p"); assertFullFrame(); assert.match(panel.render(100).join("\n"), /hub.*direct/);
	writeFileSync(live, "changed live file"); await panel.handleInput("e");
	assertFullFrame(); assert.equal(reads, 1); assert.match(panel.render(100).join("\n"), /captured/); assert.doesNotMatch(panel.render(100).join("\n"), /\u001b\[31m|changed live file/);
	await panel.handleInput("\u001b"); unlinkSync(live);
	projection = projectProactive({ records: [], history: [], current: [], activity: [] });
	await panel.handleInput("e"); assertFullFrame(); assert.equal(reads, 1, "old session selection cannot read back"); assert.match(panel.render(100).join("\n"), /unavailable/);
	await panel.handleInput("\u001b"); assertFullFrame(); assert.match(panel.render(100).join("\n"), /history unavailable/); await panel.handleInput("\u001b"); assertFullFrame(); await panel.handleInput("q"); await opened;
});

test("common fleet source feeds zero-row mounted grid with idle review retention", () => {
	let now = 1000, widget: any, renders = 0, scheduled: (() => void) | undefined;
	let projection: any = { records: [{ owner: "hub", attempt: "direct", turnId: "turn", status: "not_checked" }], history: [], current: [], activity: [{ type: "job_started", jobId: "one", at: now }] };
	const source = createFleetSource({ getAgents: () => new Map(), getResearch: () => new Map(), getPeerInputs: () => [], getPeerCards: () => new Map(), getPendingReplies: () => [], displayName: (s: string) => s, modelForAgent: () => "", modelForResearch: () => "", modelForPeer: () => "", getProactive: () => projection } as any);
	const context: any = { mode: "headless", ui: { setWidget: (_: string, value: any) => { if (value) widget = value({ terminal: { rows: 21, columns: 30 }, requestRender() { renders++; } }, theme); } } };
	const grid = createGridUI({ getWidgetContext: () => context, getRows: value => source.rows(value, { showFinished: true }), getSnapshot: value => { const snapshot = source.snapshot(value); return { rows: buildFleetRows(snapshot, { showFinished: true }), proactive: snapshot.proactive }; }, now: () => now, setTimeout: fn => { scheduled = fn; return 1 as any; }, clearTimeout: () => { scheduled = undefined; } });
	grid.updateWidget(); assert.match(widget.render(30).join("\n"), /Review|review/i); assert.equal(source.rows(now, { showFinished: true }).length, 0);
	projection = { ...projection, activity: [...projection.activity, { type: "job_finished", jobId: "one", at: now }] }; grid.updateWidget();
	now += 9_000; scheduled?.(); assert.match(widget.render(30).join("\n"), /Review|review/i);
	now += 1_500; scheduled?.(); assert.doesNotMatch(widget.render(30).join("\n"), /Review|review/i); assert.ok(renders > 0); grid.dispose();
});

test("mounted specialist detail pins attempt and reads selected evidence only on e", async () => {
	const ref = { id: "a".repeat(64), owner: "builder", attempt: "old", runToken: "builder:old", state: "new", source: "system1", claim: "suspicion", ruleId: "rule", ruleHash: "b".repeat(64), subject: "docs/file.md", snapshotHandle: "c".repeat(64), snapshotHash: "d".repeat(64), snapshotId: "snapshot", unitId: "unit", excerptHash: "e".repeat(64), occurrences: 1 } as const;
	let view: any = { owners: [{ owner: "builder", attempt: "old", runToken: "builder:old", findings: [ref] }] }, reads = 0, panel: any, close!: () => void;
	const state = { def: { name: "builder", subagents: {} }, status: "done", timeline: [] } as any;
	const row = { ...buildFleetRows({ specialists: [specialist("builder", "running")], research: [], peers: [] }, { showFinished: true })[0], runToken: "builder:old" };
	const ctx: any = { ui: { custom: (factory: any) => { panel = factory({ terminal: { rows: 20, columns: 100 }, requestRender() {} }, theme, null, () => close()); return new Promise<void>(resolve => { close = resolve; }); }, notify() {} } };
	const detail = createDetailPanel({ getAgent: () => state, getResearch: () => undefined, parseResearchHandle: () => null, findDelegationChild: () => null, modelPolicy: {}, displayName: (s: string) => s, shortModel: (s: string) => s, refreshUi() {}, getDispatchPreference: () => "native", maxLiveEntryChars: 1000, getProactive: () => view, readProactiveEvidence: () => { reads++; return "retained only"; }, currentFleetRow: () => row } as any);
	const opened = detail.openFleetDetail(row, ctx); assert.equal(reads, 0); assert.match(panel.render(100).join("\n"), /finding 1\/1/);
	await panel.handleInput("e"); assert.equal(panel.render(100).length, 19); assert.equal(reads, 1); assert.match(panel.render(100).join("\n"), /retained only/);
	await panel.handleInput("\u001b"); view = { owners: [{ ...view.owners[0], runToken: "builder:new", findings: [ref] }] };
	await panel.handleInput("e"); assert.equal(panel.render(100).length, 19); assert.equal(reads, 1); assert.match(panel.render(100).join("\n"), /unavailable/);
	await panel.handleInput("\u001b"); await panel.handleInput("q"); await opened;
});

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
	assert.match(renderFleetDashboard({ rows: initial, selection: { index: 0 }, summary: { running: 0, done: 0, failed: 0, totalTokens: 0, intervals: [], wallMs: 0 }, showFinished: false }, 120, 4, theme, metrics).join("\n"), /Builder[\s\S]*Researcher[\s\S]*Coms|Coms[\s\S]*Builder[\s\S]*Researcher/);

	const running = buildFleetRows({ ...source, specialists: [specialist("builder", "running"), specialist("researcher", "idle")] }, { showFinished: false });
	assert.equal(running.filter(row => row.key === "builder").length, 1);
	assert.equal(running.find(row => row.key === "builder")?.status, "running");
});

test("agent hub wires Fleet Dashboard, detail, stable selection, confirmation, and wall time", () => {
	assert.match(fleetSource, /buildFleetRows\(/);
	assert.match(dashboardSource, /reconcileSelection\(selection, rows\)/);
	assert.match(dashboardSource, /wallMs: unionMs\(summary\.intervals\)/);
	// C1: the shared source uses authoritative history intervals, not elapsed re-anchoring.
	assert.match(fleetSource, /\.\.\.fleetTiming\(state\.histEntry, now\)/);
	assert.doesNotMatch(fleetSource, /Date\.now\(\) - state\.elapsed/);
	assert.match(dashboardSource, /dashboardTransition\(/);
	assert.match(dashboardSource, /press \$\{confirm\.action === "kill" \? "x" : "r"\} again/);
	assert.match(dashboardSource, /deps\.actions\.open\(selected\.key, selected\.runToken, ctx, detailVerbose\)/);
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
	assert.match(dashboardSource, /intent === "history"[\s\S]*?deps\.openHistory\(ctx\)/);
	assert.match(modelPolicySource, /substitutions\.set\(source, target\)/);
	assert.match(detailSource, /resolvedSubagentModel\(/);
	assert.match(detailSource, /matchedInput[\s\S]*?matchesKey\(data, Key\.up\)[\s\S]*?matchesKey\(data, Key\.down\)/);
	assert.match(detailSource, /modelRegistry\?\.getAvailable/);
	assert.match(detailSource, /modelPolicy\.setPersonaOverride/);
	assert.match(detailSource, /target\.state\.model = picked/);
	assert.match(detailSource, /modelPolicy\.setSubagentOverride/);
	assert.match(detailSource, /current runs are not interrupted/);
	// C3–C7 wiring: pure ops drive kill/restart/ticker/timeline/compact guards
	assert.match(fleetActions, /resolveFleetKill\(/);
	assert.match(fleetActions, /resolveFleetRestart\(/);
	assert.match(dashboardSource, /attachFleetDashboardTicker\(/);
	assert.match(detailSource, /liveTimeline\(target\)/);
	assert.match(detailSource, /snapshotFleetDetailRow\(applyLiveFleetDetailRow\(detailRow, deps\.currentFleetRow\?\.\(detailRow\.key\), !!deps\.currentFleetRow\), target\)/);
	assert.match(detailSource, /detailBodyLines\(liveRow/);
	assert.match(source, /currentFleetRow: key => fleetSource\.rows\(Date\.now\(\), \{ showFinished: true \}\)/);
	assert.match(source, /gridCols = gridColumnsForSize\(agentStates\.size\);/);
	assert.doesNotMatch(gridSource, /agent-research/);
	assert.doesNotMatch(gridSource, /getResearchStates/);
	assert.doesNotMatch(source + gridSource, /compactWidgetsEnabled/);
	assert.doesNotMatch(shortcutSource, /ports\.isCompact\(\)/);
	assert.doesNotMatch(uiSource, /function (?:shortModel|thinkingSuffix|modelWithThinking)\(/, "Phase 6.5 UI consumes the root-owned formatters");
	assert.match(source, /createFleetDashboard<[\s\S]*?shortModel,[\s\S]*?thinkingSuffix,[\s\S]*?modelWithThinking,/, "dashboard receives shared runtime formatters explicitly");
	assert.doesNotMatch(source, /declare const (?:shortModel|thinkingSuffix|modelWithThinking)/, "runtime formatters cannot be ambient-only declarations");
	assert.match(source, /function shortModel\(model: string \| undefined\)[\s\S]*?function thinkingSuffix\(rawThinking: string \| undefined\)[\s\S]*?function modelWithThinking\(def: AgentDef\)/, "composition root owns the shared model presentation helpers");
	assert.match(source, /createGridUI\(\{[\s\S]*?getWidgetContext[\s\S]*?getRows:/, "grid consumes the shared source");
	assert.match(source, /getSystem1: \(\) => watchdogActivity\?\.live\(\) \?\? null/, "strip and dashboard share the in-memory System 1 projection");
	assert.match(gridSource, /system1Visible/);
	assert.doesNotMatch(gridSource, /sendMessage|readFileSync|events\.jsonl/);
	assert.doesNotMatch(gridSource, /function (?:shortModel|thinkingSuffix|modelWithThinking)\(/, "grid does not duplicate shared presentation semantics");
	assert.match(source, /import \{[\s\S]*?abbreviateModel,[\s\S]*?\} from "\.\.\/lib\/coms-core\.ts"/, "coms model abbreviation remains separate");
	// confirmation window is owned by the pure controller
	const dash = readFileSync(new URL("../lib/fleet-dashboard-view.ts", import.meta.url), "utf8");
	const ops = readFileSync(new URL("../lib/fleet-dashboard-ops.ts", import.meta.url), "utf8");
	assert.match(ops, /until: now \+ 2000/);
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

test("shortcuts, command, footer, and pool use the separate fleet flow", () => {
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
	assert.doesNotMatch(shortcutSource, /alt\+shift\+a/);
	assert.doesNotMatch(shortcutSource, /openMarkedAgent/);
	assert.match(source, /registerZoom\(pi, commandCtx\)/);
	assert.match(zoomCommandSource, /registerCommand\("af-zoom"[\s\S]*?getZoomCompletions[\s\S]*?handleZoom/);
	assert.match(source, /handleZoom: async \(args, ctx\) => \{[\s\S]*?const rowKey = \(rid != null \? `r\$\{rid\}` : arg\)\.toLowerCase\(\)[\s\S]*?r\.key\.toLowerCase\(\) === rowKey/);
	assert.match(source, /function findDelegationChild[\s\S]*?candidate\.id\.toLowerCase\(\) === lower/);
	assert.match(source, /getHint: \(\) => composeFleetFooterHint\(compactWorkMode\(getWorkMode\(\)\)\)/);
	assert.match(sessionStartPromptSource, /const hint = theme\.fg\("dim", deps\.getHint\(\)\);/);
	assert.doesNotMatch(source + sessionStartPromptSource, /theme\.fg\("muted", "Alt\+A "\) \+ theme\.fg\("dim", composeFleetFooterHint/);
	assert.match(poolSource, /const peerInputs[\s\S]*?pending: true/);
	assert.match(poolSource, /const render[\s\S]*?buildFleetRows\([\s\S]*?peers: peerInputs\(\)/);
	assert.doesNotMatch(poolSource, /const render[\s\S]*?staleCount.*>= 3/);
	assert.match(dashboardSource, /function fleetRows\(unfiltered = false, now = Date\.now\(\)\)[\s\S]*?deps\.getFleetRows\(now, unfiltered\)/);
	assert.match(source, /createFleetSource\(\{[\s\S]*?getPeerCards:[\s\S]*?getPendingReplies:/);
	assert.match(dashboardSource, /dashboardTransition\(/);
});
