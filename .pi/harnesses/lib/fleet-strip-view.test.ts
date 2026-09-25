import assert from "node:assert/strict";
import test from "node:test";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { renderFleetStrip, safeTerminalText, summaryText, treePrefix, visibleWindow } from "./fleet-strip-view.ts";
import { projectSystem1Owner, summariseWidget, type FleetRow, type ProactiveSessionView, type System1CheckInput } from "./fleet-read-model.ts";

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

test("A15 strip keeps text System 1 labels at narrow widths without replacing worker fields", () => {
	const owner = row("builder", {
		name: "Builder", toolCount: 2, lastWork: "edit", model: "sonnet",
		system1: { dispatchId: "d", attemptId: "a", checkId: "check-fast", snapshotId: "s", runToken: "builder:1", phase: "result", compact: "S1 on_track", label: "S1 on_track · 402ms · shadow · LLM parallel", detail: "check check-fast", effectiveMode: "shadow", llmRelation: "parallel", rule: "failures", elapsedMs: 402, retainUntil: 20_000, status: "ok", reason: "unknown", statusChoice: "on_track", confidence: null, returnedModel: "unknown", stateVersion: "unknown", questionsVersion: "unknown", policyVersion: "none", usage: "unknown", source: "none", applied: "no", outcome: "unknown", llm: "finished", llmVerdict: "unknown", degraded: false },
	});
	const other = row("reviewer", { name: "Reviewer", system1: { ...owner.system1!, runToken: "reviewer:1", compact: "S1 unavailable → LLM judging", label: "S1 unavailable → LLM judging", llmRelation: "fallback", phase: "unavailable" } });
	const summary = { running: 2, peerActive: 0, done: 0, failed: 0, contextMax: 20, contextKnown: 2, contextTotal: 2, wallMs: 1000, wallKnown: 2, wallTotal: 2, system1Evaluating: 1, system1Mode: null, system1Last: null, system1Mixed: true };
	for (const width of [20, 40, 79, 80, 104, 105, 120]) {
		const lines = renderFleetStrip({ active: true, interactiveAvailable: true, selectedKey: "builder", summary, window: visibleWindow([owner, other], 0, 0, 2), maxRows: 6 }, width, theme, metrics);
		assert.ok(lines.every(line => visibleWidth(line) <= width), String(width));
		const text = lines.join("\n");
		if (width >= 40) assert.match(text, /S1/);
		assert.match(text, /Builder/);
		assert.doesNotMatch(text, /sendMessage/);
	}
	const narrow = renderFleetStrip({ active: true, interactiveAvailable: false, summary, window: visibleWindow([owner], 0, 0, 1), maxRows: 6 }, 40, theme, metrics).join("\n");
	assert.match(narrow, /S1 on_track/);
	assert.match(narrow, /2 tools|edit|sonnet|Builder/);
	const collapsed = renderFleetStrip({ active: false, interactiveAvailable: false, summary, window: visibleWindow([owner, other], 0, 0, 2), maxRows: 5 }, 80, theme, metrics)[0]!;
	assert.match(collapsed, /S1 mixed/);
	assert.doesNotMatch(collapsed, /on_track|unavailable → LLM/);
	const retained = renderFleetStrip({ active: false, interactiveAvailable: false, summary: { ...summary, system1Evaluating: 0, system1Mode: "shadow", system1Last: "S1 cancelled", system1Mixed: false }, window: visibleWindow([owner], 0, 0, 1), maxRows: 5 }, 100, theme, metrics)[0]!;
	assert.match(retained, /S1 cancelled/);
	assert.match(retained, /shadow/);
});

test("review summary survives zero workers and narrow/collapsed budget without pretending suspicion is violation", () => {
	const review: ProactiveSessionView = { consumer: "proactive-review", owners: [], turns: 3, reviewed: 1, partial: 1, evaluating: 1, currentViolations: 1, currentSuspicions: 2, stale: 1, resolved: 0, lastFinishedAt: 1000, retainUntil: 11_000 };
	const empty = summariseWidget([]);
	for (const active of [false, true]) for (const width of [20, 40, 80]) {
		const lines = renderFleetStrip({ active, interactiveAvailable: false, summary: empty, proactive: review, window: visibleWindow([], 0, 0, 3), maxRows: 6 }, width, theme, metrics);
		assert.ok(lines.length > 0);
		assert.ok(lines.every(line => visibleWidth(line) <= width));
		assert.match(lines.join("\n"), /Review 1 violation/);
	}
	assert.match(summaryText(empty, review), /2 suspects.*1 stale.*1 partial/);
	assert.doesNotMatch(summaryText(empty, review), /checked/);
	assert.match(summaryText(empty, { ...review, turns: 1, reviewed: 1, partial: 0, evaluating: 0, currentViolations: 0, currentSuspicions: 0, stale: 0 }), /Review checked/);
	assert.match(summaryText(empty, { ...review, turns: 1, reviewed: 0, partial: 0, evaluating: 0, currentViolations: 0, currentSuspicions: 0, stale: 0 }), /Review skipped/);
});

test("owner review badge is fenced to its run; existing worker counters remain unchanged", () => {
	const proactive: ProactiveSessionView = { consumer: "proactive-review", owners: [], turns: 1, reviewed: 0, partial: 1, evaluating: 0, currentViolations: 1, currentSuspicions: 0, stale: 0, resolved: 0, lastFinishedAt: 1000, retainUntil: 11_000 };
	const owner = { ...proactive, owner: "builder", attempt: "1", runToken: "builder:1", lastStatus: "reviewed", coverage: "partial" as const, findings: [], history: [] };
	const worker = row("builder", { proactive: owner });
	const view = (item: FleetRow) => renderFleetStrip({ active: true, interactiveAvailable: true, summary: summariseWidget([item]), proactive, window: visibleWindow([item], 0, 0, 1), maxRows: 5 }, 120, theme, metrics).join("\n");
	assert.match(view(worker), /Builder|builder.*Review 1 violation/);
	assert.match(view(worker), /1 tools/);
	assert.doesNotMatch(view({ ...worker, runToken: "builder:2" }).split("\n").slice(2).join("\n"), /Review/);
});

test("F-20 collapsed summary does not repeat the mode or emit a bare unknown", () => {
	const input: System1CheckInput = {
		dispatchId: "d", attemptId: "a", checkId: "c", snapshotId: "s", evaluation: "finished", llm: "finished",
		status: "ok", reason: "unknown", elapsedMs: 402, finishedAt: 1_000, rule: "failures", effectiveMode: "shadow",
		configuredMode: "shadow", statusChoice: "on_track", source: "none", applied: "no", outcome: "continue", llmVerdict: "unknown",
	};
	const view = projectSystem1Owner(input, "builder:1", 2_000)!;
	const owner = row("builder", { runToken: "builder:1", system1: view });
	const text = summaryText(summariseWidget([owner]));
	assert.equal(text.split("shadow").length - 1, 1);
	assert.match(text, /S1 on_track/);
	const unknown = projectSystem1Owner({ ...input, effectiveMode: undefined, configuredMode: "active" }, "builder:1", 2_000)!;
	const bare = summaryText(summariseWidget([row("builder", { runToken: "builder:1", system1: unknown })]));
	assert.doesNotMatch(bare, /(^| · )unknown( · |$)/);
});
