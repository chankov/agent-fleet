import assert from "node:assert/strict";
import test from "node:test";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { renderFleetStrip, safeTerminalText, treePrefix, visibleWindow } from "./fleet-strip-view.ts";
import type { FleetRow } from "./fleet-read-model.ts";

const metrics = { visibleWidth, truncateToWidth };
const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text, bg: (_: string, text: string) => text };
const row = (key: string, options: Partial<FleetRow> = {}): FleetRow => ({ key, kind: "specialist", name: key, depth: 0, status: "running", model: "sonnet", backend: "native", contextPct: 20, contextTokens: 2, elapsed: 1000, startedAt: 0, timingKind: "run", runToken: `${key}:1`, toolCount: 1, lastWork: "edit", hasTimeline: true, lastAtDepth: [], ...options });
const summary = { running: 8, peerActive: 1, done: 0, failed: 0, contextMax: 38, contextKnown: 2, contextTotal: 4, wallMs: 1000, wallKnown: 2, wallTotal: 3 };

test("tree prefixes encode real sibling metadata and depth fallback is whitespace", () => {
	assert.equal(treePrefix([]), "");
	assert.equal(treePrefix([false]), "├─ ");
	assert.equal(treePrefix([false, true]), "│  └─ ");
	assert.equal(treePrefix(undefined, 2), "      ");
});

test("viewport is contiguous, selection-visible and reports exact hidden active counts", () => {
	const rows = Array.from({ length: 8 }, (_, i) => row(String(i), { status: i === 1 ? "done" : "running" }));
	const window = visibleWindow(rows, 6, 0, 3);
	assert.deepEqual(window.rows.map(item => item.key), ["4", "5", "6"]);
	assert.equal(window.above, 4); assert.equal(window.below, 1);
	assert.equal(window.activeAbove, 3); assert.equal(window.activeBelow, 1);
});

test("viewport provides ancestor breadcrumb without duplicating parents", () => {
	const rows = [row("root"), row("child", { kind: "delegate", parentKey: "root", depth: 1, lastAtDepth: [true] }), row("grand", { kind: "delegate", parentKey: "child", depth: 2, lastAtDepth: [true, true] })];
	const window = visibleWindow(rows, 2, 2, 1);
	assert.deepEqual(window.rows.map(item => item.key), ["grand"]);
	assert.deepEqual(window.ancestorPath, ["root", "child"]);
});

test("renderer obeys one-third budget and actual display-cell width for Unicode and hostile input", () => {
	const rows = [row("one", { name: "漢字👩‍💻é\n\x1b]8;;bad\x07link\x1b[31m", lastWork: "\x1b[2Junsafe\rwork" }), ...Array.from({ length: 7 }, (_, i) => row(`row-${i}`))];
	const window = visibleWindow(rows, 0, 0, 3);
	const lines = renderFleetStrip({ active: true, interactiveAvailable: true, selectedKey: "one", summary, window, maxRows: Math.floor(18 / 3) }, 42, theme, metrics);
	assert.equal(lines.length, 6);
	assert.ok(lines.every(line => visibleWidth(line) <= 42));
	assert.doesNotMatch(lines.join("\n"), /\x1b\]|\x1b\[2J|unsafe\r/);
	assert.match(lines.at(-1)!, /↓ 5 more · 5 active/);
});

test("collapsed renderer omits misleading hint when interaction is unavailable", () => {
	const window = visibleWindow([row("one")], 0, 0, 1);
	const fallback = renderFleetStrip({ active: false, interactiveAvailable: false, summary, window, maxRows: 5 }, 100, theme, metrics);
	assert.equal(fallback.length, 1); assert.doesNotMatch(fallback[0], /inspect/);
	assert.match(fallback[0], /ctx max 38% \(2\/4 known\)/);
	assert.match(fallback[0], /wall 1s \(2\/3 known\)/);
	assert.deepEqual(renderFleetStrip({ active: false, interactiveAvailable: true, summary, window, maxRows: 0 }, 80, theme, metrics), []);
});

test("interactive hints advertise Alt+I toggle and j/k without arrow controls", () => {
	const window = visibleWindow([row("one")], 0, 0, 1);
	const collapsed = renderFleetStrip({ active: false, interactiveAvailable: true, summary, window, maxRows: 5 }, 120, theme, metrics)[0]!;
	assert.match(collapsed, /Alt\+I inspect/); assert.doesNotMatch(collapsed, /←|↑|↓/);
	const expanded = renderFleetStrip({ active: true, interactiveAvailable: true, selectedKey: "one", summary, window, maxRows: 5 }, 120, theme, metrics)[0]!;
	assert.match(expanded, /j\/k select · Alt\+I collapse/); assert.doesNotMatch(expanded, /←|↑|↓/);
});

test("narrow collapsed summary drops whole secondary fields instead of clipping labels", () => {
	const window = visibleWindow([row("one")], 0, 0, 1);
	const line = renderFleetStrip({ active: false, interactiveAvailable: true, summary, window, maxRows: 5 }, 45, theme, metrics)[0]!;
	assert.ok(visibleWidth(line) <= 45);
	assert.doesNotMatch(line, /ctx(?:\s|$)|ctx ma$|known\)?$/);
});

test("safeTerminalText strips ANSI, OSC, controls and newlines", () => {
	assert.equal(safeTerminalText("a\n\x1b[31mb\x1b[0m\x1b]0;title\x07c"), "a bc");
});
