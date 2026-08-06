import assert from "node:assert/strict";
import test from "node:test";
import { DETAIL_CHROME_ROWS, detailContent, detailTransition, renderFleetDetail } from "./fleet-detail-view.ts";

const theme = { fg: (_: string, s: string) => s, bold: (s: string) => s };
const row = { key: "a", name: "Architect", kind: "specialist" as const, depth: 0, status: "running" as const, model: "opus", backend: "native" as const, contextPct: 42, contextTokens: 42_000, elapsed: 1_000, toolCount: 3, lastWork: "work", hasTimeline: true };
const timeline = Array.from({ length: 500 }, (_, i) => ({ kind: i === 2 ? "tool" as const : "text" as const, title: `entry ${i}`, content: i === 2 ? "first\nsecond" : `content ${i}`, timestamp: i }));

test("detail has headers, timelines, expansion, tail content, and fixed height", () => {
	for (const entries of [[], timeline]) for (const body of [1, 5, 10]) assert.equal(renderFleetDetail(row, entries, 999, 100, body, theme, 2).length, body + DETAIL_CHROME_ROWS);
	assert.match(renderFleetDetail(row, timeline, 999, 100, 5, theme).join("\n"), /entry 499/);
	const collapsed = renderFleetDetail(row, timeline, 0, 100, 5, theme).join("\n");
	const expanded = renderFleetDetail(row, timeline, 0, 100, 5, theme, 2).join("\n");
	assert.match(collapsed, /Architect.*opus/); assert.notEqual(collapsed, expanded); assert.match(expanded, /first/);
});

test("expanded tool content determines the scroll bound", () => {
	const entries = [{ kind: "tool" as const, title: "tool", content: "one\ntwo\nthree\nfour", timestamp: 0 }];
	const content = detailContent(entries, 80, 0);
	const state = { scrollOffset: 0, selectedIndex: 0, expandedIndex: 0 as number | null, followTail: false };
	detailTransition("\u001b[F", state, entries, 2, content.length);
	assert.equal(state.scrollOffset, content.length - 2);
	assert.match(renderFleetDetail(row, entries, state.scrollOffset, 80, 2, theme, 0).join("\n"), /four/);
});

test("detail transitions scroll, follow tail, expand, copy, and close", () => {
	const state = { scrollOffset: 0, selectedIndex: 2, expandedIndex: null as number | null, followTail: false };
	assert.equal(detailTransition("\r", state, timeline, 4), null); assert.equal(state.expandedIndex, 2);
	assert.equal(detailTransition("\u0003", state, timeline, 4), "copy"); assert.equal(detailTransition("\u001b[F", state, timeline, 4), null); assert.equal(state.followTail, true); assert.ok(state.scrollOffset > 0);
	assert.equal(detailTransition("\u001b", state, timeline, 4), "close");
});

test("coms peers show a notice rather than an empty transcript", () => {
	const peer = { ...row, backend: "coms" as const, hasTimeline: false, contextPct: null };
	const output = renderFleetDetail(peer, [], 0, 80, 4, theme);
	assert.equal(output.length, 4 + DETAIL_CHROME_ROWS); assert.match(output.join("\n"), /no local transcript/);
});
