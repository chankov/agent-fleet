import assert from "node:assert/strict";
import test from "node:test";
import { dashboardTransition, renderFleetDashboard, FLEET_CHROME_ROWS, type DashboardControllerState } from "./fleet-dashboard-view.ts";

const theme = { fg: (_: string, s: string) => s, bold: (s: string) => s, bg: (_: string, s: string) => s };
const row = (key: string, depth = 0, contextPct: number | null = 20) => ({ key, name: key, kind: depth ? "delegate" as const : "specialist" as const, parentKey: depth ? "root" : undefined, depth, status: "running" as const, model: "sonnet", backend: "native" as const, contextPct, contextTokens: contextPct == null ? null : 20_000, elapsed: 62_000, startedAt: 0, toolCount: 3, lastWork: "npm test", hasTimeline: true });
const vm = (rows: any[]) => ({ rows, selection: { key: rows[0]?.key, index: 0 }, summary: { running: rows.length, done: 1, failed: 0, totalTokens: 20_000, intervals: [], wallMs: 90_000 }, filterQuery: "npm", showFinished: false });

test("dashboard has fixed height with hierarchy, columns, bars, and aggregates", () => {
	for (const body of [0, 1, 5, 12]) assert.equal(renderFleetDashboard(vm([row("root"), row("child", 1), row("peer", 0, null)]), 140, body, theme).length, body + FLEET_CHROME_ROWS);
	const text = renderFleetDashboard(vm([row("root"), row("child", 1), row("peer", 0, null)]), 140, 5, theme).join("\n");
	assert.match(text, /Fleet.*3 running.*1 done.*1:30.*20k tok/); assert.match(text, /└ child/); assert.match(text, /\[automatic\].*—/); assert.match(text, /\[##/); assert.match(text, /npm test/);
});

test("dashboard degrades at narrow widths and has a fixed-height empty state", () => {
	const narrow = renderFleetDashboard(vm([row("long-agent-name")]), 60, 4, theme);
	assert.equal(narrow.length, 4 + FLEET_CHROME_ROWS); assert.ok(narrow.every(line => Array.from(line).length <= 60));
	for (const width of [12, 20, 80]) {
		const empty = renderFleetDashboard(vm([]), width, 5, theme);
		assert.equal(empty.length, 5 + FLEET_CHROME_ROWS);
		assert.ok(empty.every(line => Array.from(line).length <= width));
	}
	assert.match(renderFleetDashboard(vm([]), 80, 5, theme).join("\n"), /no agents dispatched yet/);
});

test("dashboard truncates ANSI styling by visible width and retains its reset", () => {
	const ansiTheme = { fg: (_: string, s: string) => `\x1b[2m${s}\x1b[0m`, bold: (s: string) => `\x1b[1m${s}\x1b[0m` };
	const lines = renderFleetDashboard(vm([row("agent")]), 40, 2, ansiTheme);
	const plain = (s: string) => s.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
	assert.ok(lines.every(line => Array.from(plain(line)).length <= 40));
	assert.ok(lines.at(-1)?.endsWith("\x1b[0m"));
});

const keys = (...ks: string[]) => ks.map((key) => ({ key }));
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
	const rendered = renderFleetDashboard({ ...vm(Array.from({ length: 20 }, (_, i) => row(String(i)))), selection: state.selection, scrollOffset: state.scrollOffset }, 100, 5, theme).join("\n");
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
	assert.deepEqual(state.confirm, { action: "kill", key: "a", until: t0 + 2000 });
	assert.equal(dashboardTransition("x", state, rows, 2, t0 + 2500), null);
	assert.deepEqual(state.confirm, { action: "kill", key: "a", until: t0 + 4500 });
	assert.deepEqual(dashboardTransition("x", state, rows, 2, t0 + 4000), { kill: "a" });
	assert.equal(state.confirm, null);
	assert.equal(dashboardTransition("r", state, rows, 2, t0 + 5000), null);
	assert.deepEqual(dashboardTransition("r", state, rows, 2, t0 + 5500), { restart: "a" });
	assert.equal(dashboardTransition("x", state, rows, 2, t0 + 6000), null);
	dashboardTransition("j", state, rows, 2, t0 + 6100);
	assert.equal(dashboardTransition("x", state, rows, 2, t0 + 6200), null);
	assert.deepEqual(state.confirm, { action: "kill", key: "b", until: t0 + 8200 });
});
