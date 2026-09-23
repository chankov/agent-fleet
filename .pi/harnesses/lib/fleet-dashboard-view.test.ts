import assert from "node:assert/strict";
import test from "node:test";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { dashboardTransition, renderFleetDashboard, FLEET_CHROME_ROWS, type DashboardControllerState } from "./fleet-dashboard-view.ts";

const metrics = { truncateToWidth, visibleWidth };
const theme = { fg: (_: string, s: string) => s, bold: (s: string) => s, bg: (_: string, s: string) => s };
const row = (key: string, depth = 0, contextPct: number | null = 20) => ({ key, runToken: `${key}:1`, name: key, kind: depth ? "delegate" as const : "specialist" as const, parentKey: depth ? "root" : undefined, depth, lastAtDepth: depth ? [true] : [], status: "running" as const, model: "sonnet", backend: "native" as const, contextPct, contextTokens: contextPct == null ? null : 20_000, elapsed: 62_000, startedAt: 0, toolCount: 3, lastWork: "npm test", hasTimeline: true });
const vm = (rows: any[]) => ({ rows, selection: { key: rows[0]?.key, index: 0 }, summary: { running: rows.length, done: 1, failed: 0, totalTokens: 20_000, intervals: [], wallMs: 90_000 }, filterQuery: "npm", showFinished: false });

test("dashboard has fixed height with hierarchy, columns, bars, and aggregates", () => {
	for (const body of [0, 1, 5, 12]) assert.equal(renderFleetDashboard(vm([row("root"), row("child", 1), row("peer", 0, null)]), 140, body, theme, metrics).length, body + FLEET_CHROME_ROWS);
	const text = renderFleetDashboard(vm([row("root"), row("child", 1), row("peer", 0, null)]), 140, 5, theme, metrics).join("\n");
	assert.match(text, /Fleet.*3 running.*1 done.*1:30.*20k tok/); assert.match(text, /└─ ● child/); assert.match(text, /\[automatic\].*—/); assert.match(text, /\[##/); assert.match(text, /npm test/);
});

test("dashboard footer lists supported bindings without continue", () => {
	const footer = renderFleetDashboard(vm([row("root")]), 200, 3, theme, metrics).at(-1)!;
	assert.doesNotMatch(footer, /c continue/);
	assert.equal(footer, "↑↓ select · Enter open · h history · m substitute · x kill · r restart · f filter · a all · q close");
});

test("dashboard pins coms lines below chrome", () => {
	const lines = renderFleetDashboard({ ...vm([row("root")]), comsLines: [" coms ", " alpha "] }, 80, 3, theme, metrics);
	assert.equal(lines.length, 3 + FLEET_CHROME_ROWS + 2);
	assert.equal(lines.at(-2), " coms ");
	assert.equal(lines.at(-1), " alpha ");
});

test("dashboard degrades at narrow widths and has a fixed-height empty state", () => {
	const narrow = renderFleetDashboard(vm([row("long-agent-name")]), 60, 4, theme, metrics);
	assert.equal(narrow.length, 4 + FLEET_CHROME_ROWS); assert.ok(narrow.every(line => visibleWidth(line) <= 60));
	for (const width of [12, 20, 80]) {
		const empty = renderFleetDashboard(vm([]), width, 5, theme, metrics);
		assert.equal(empty.length, 5 + FLEET_CHROME_ROWS);
		assert.ok(empty.every(line => visibleWidth(line) <= width));
	}
	assert.match(renderFleetDashboard(vm([]), 80, 5, theme, metrics).join("\n"), /no agents dispatched yet/);
});

test("A14 dashboard badge matches the strip owner and does not add a specialist row", () => {
	const system1 = { dispatchId: "d", attemptId: "a", checkId: "check-fast", snapshotId: "s", runToken: "root:1", phase: "result" as const, compact: "S1 on_track", label: "S1 on_track · 402ms · shadow", detail: "check check-fast", effectiveMode: "shadow" as const, llmRelation: "parallel" as const, rule: "failures", elapsedMs: 402, retainUntil: 20_000, status: "ok", reason: "unknown", statusChoice: "on_track", confidence: 0.88, returnedModel: "jev", stateVersion: "v", questionsVersion: "v", policyVersion: "none" as const, usage: "unknown" as const, source: "llm" as const, applied: "no" as const, outcome: "continue", llm: "finished", llmVerdict: "stuck", degraded: false };
	const rows = [row("root"), { ...row("child", 1), system1: { ...system1, runToken: "child:1" } }, { ...row("root"), key: "root", system1 }];
	const visible = [rows[2], rows[1]];
	for (const width of [40, 79, 80, 120]) {
		const lines = renderFleetDashboard(vm(visible), width, 4, theme, metrics);
		assert.equal(lines.filter(line => /root|child/.test(line)).length, 2);
		assert.ok(lines.every(line => visibleWidth(line) <= width));
		if (width >= 40) assert.match(lines.join("\n"), /S1 on_track/);
	}
	const state: DashboardControllerState = { selection: { index: 0 }, scrollOffset: 0, filtering: false, filterQuery: "", showFinished: true, confirm: null };
	assert.equal(dashboardTransition("\r", state, visible, 4)?.open, "root");
});

test("dashboard truncates ANSI styling by visible width and retains its reset", () => {
	const ansiTheme = { fg: (_: string, s: string) => `\x1b[2m${s}\x1b[0m`, bold: (s: string) => `\x1b[1m${s}\x1b[0m` };
	const lines = renderFleetDashboard(vm([row("agent")]), 40, 2, ansiTheme, metrics);
	assert.ok(lines.every(line => visibleWidth(line) <= 40));
	assert.ok(lines.at(-1)?.endsWith("\x1b[0m"));
});

test("dashboard uses real cell metrics and scrubs hostile source fields before styling", () => {
	const unsafe = row("safe"); unsafe.name = "漢字👩‍💻é\n\x1b]8;;bad\x07link"; unsafe.model = "m\x1b[2J"; unsafe.lastWork = "work\rnext";
	const lines = renderFleetDashboard(vm([unsafe]), 48, 2, theme, metrics);
	assert.ok(lines.every(line => visibleWidth(line) <= 48));
	assert.doesNotMatch(lines.join("\n"), /\x1b\]|\x1b\[2J|work\r/);
	assert.equal(visibleWidth(lines[2]!), 48, "selected background is padded by display cells");
});

const keys = (...ks: string[]) => ks.map((key) => ({ key, runToken: `${key}:1` }));
function freshState(index = 0): DashboardControllerState {
	return { selection: { key: "a", index }, scrollOffset: 0, filtering: false, filterQuery: "", showFinished: false, confirm: null };
}

test("dashboardTransition moves selection, pages, filters, toggles finished, and closes", () => {
	const rows = keys("a", "b", "c");
	const state = freshState(0);
	assert.equal(dashboardTransition("j", state, rows, 2), null);
	assert.equal(state.selection.index, 1);
	assert.equal(dashboardTransition("\u001b[A", state, rows, 2), null);
	assert.equal(state.selection.index, 0);
	assert.equal(dashboardTransition("\u001b[6~", state, rows, 2), null);
	assert.equal(state.scrollOffset, 1);
	assert.equal(dashboardTransition("\u001b[5~", state, rows, 2), null);
	assert.equal(state.scrollOffset, 0);
	assert.equal(dashboardTransition("f", state, rows, 2), null);
	assert.equal(state.filtering, true);
	assert.equal(dashboardTransition("x", state, rows, 2), null);
	assert.equal(state.filterQuery, "x");
	assert.equal(dashboardTransition("\u007f", state, rows, 2), null);
	assert.equal(state.filterQuery, "");
	assert.equal(dashboardTransition("\r", state, rows, 2), null);
	assert.equal(state.filtering, false);
	assert.equal(dashboardTransition("f", state, rows, 2), null);
	assert.equal(dashboardTransition("\u001b", state, rows, 2), null);
	assert.equal(state.filtering, false);
	assert.equal(state.filterQuery, "");
	assert.equal(dashboardTransition("a", state, rows, 2), null);
	assert.equal(state.showFinished, true);
	assert.equal(dashboardTransition("m", state, rows, 2), "substitute");
	assert.equal(dashboardTransition("M", state, rows, 2), "substitute");
	assert.equal(dashboardTransition("h", state, rows, 2), "history");
	assert.equal(dashboardTransition("H", state, rows, 2), "history");
	assert.deepEqual(dashboardTransition("\r", state, rows, 2), { open: "a" });
	assert.equal(dashboardTransition("q", state, rows, 2), "close");
});

test("dashboardTransition keeps selection visible and actions target the paged row", () => {
	const rows = keys(...Array.from({ length: 20 }, (_, i) => String(i)));
	const state = freshState();
	for (let i = 0; i < 19; i++) dashboardTransition("j", state, rows, 5);
	assert.equal(state.selection.index, 19);
	assert.equal(state.scrollOffset, 15);
	dashboardTransition("\u001b[5~", state, rows, 5);
	assert.equal(state.selection.index, 14);
	assert.equal(state.scrollOffset, 14);
	assert.ok(state.scrollOffset <= state.selection.index && state.selection.index < state.scrollOffset + 5);
	const rendered = renderFleetDashboard({ ...vm(Array.from({ length: 20 }, (_, i) => row(String(i)))), selection: state.selection, scrollOffset: state.scrollOffset }, 100, 5, theme, metrics).join("\n");
	assert.match(rendered, /❯.*14/);
	assert.equal(dashboardTransition("x", state, rows, 5, 1_000), null);
	assert.deepEqual(dashboardTransition("x", state, rows, 5, 1_001), { kill: "14" });
	for (let i = 0; i < 20; i++) dashboardTransition("\u001b[6~", state, rows, 5);
	assert.equal(state.selection.index, 19);
	assert.equal(state.scrollOffset, 15);
	assert.ok(state.scrollOffset <= state.selection.index && state.selection.index < state.scrollOffset + 5);
});

test("dashboardTransition requires a second press within 2s for kill and restart", () => {
	const rows = keys("a", "b");
	const state = freshState(0);
	const t0 = 1_000_000;
	assert.equal(dashboardTransition("x", state, rows, 2, t0), null);
	assert.deepEqual(state.confirm, { action: "kill", key: "a", runToken: "a:1", until: t0 + 2000 });
	assert.equal(dashboardTransition("x", state, rows, 2, t0 + 2500), null);
	assert.deepEqual(state.confirm, { action: "kill", key: "a", runToken: "a:1", until: t0 + 4500 });
	assert.deepEqual(dashboardTransition("x", state, rows, 2, t0 + 4000), { kill: "a" });
	assert.equal(state.confirm, null);
	assert.equal(dashboardTransition("r", state, rows, 2, t0 + 5000), null);
	assert.deepEqual(dashboardTransition("r", state, rows, 2, t0 + 5500), { restart: "a" });
	assert.equal(dashboardTransition("x", state, rows, 2, t0 + 6000), null);
	dashboardTransition("j", state, rows, 2, t0 + 6100);
	assert.equal(dashboardTransition("x", state, rows, 2, t0 + 6200), null);
	assert.deepEqual(state.confirm, { action: "kill", key: "b", runToken: "b:1", until: t0 + 8200 });
});
