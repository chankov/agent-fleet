import assert from "node:assert/strict";
import test from "node:test";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { DETAIL_CHROME_ROWS, detailContent, detailEntryOffsets, detailTransition, fleetModelChoices, modelPickerTransition, normalizeFleetDetailInput, renderFleetDetail, renderFleetModelPicker, renderFleetSubstitutionPicker } from "./fleet-detail-view.ts";

const theme = { fg: (_: string, s: string) => s, bold: (s: string) => s };
const row = { key: "a", name: "Architect", kind: "specialist" as const, depth: 0, status: "running" as const, model: "opus", backend: "native" as const, contextPct: 42, contextTokens: 42_000, elapsed: 1_000, toolCount: 3, lastWork: "work", hasTimeline: true };
const timeline = Array.from({ length: 500 }, (_, i) => ({ kind: i === 2 ? "tool" as const : "text" as const, title: `entry ${i}`, content: i === 2 ? "first\nsecond" : `content ${i}`, timestamp: i }));

test("detail has headers, timelines, expansion, tail content, and fixed height", () => {
	for (const entries of [[], timeline]) for (const body of [1, 5, 10]) assert.equal(renderFleetDetail(row, entries, 999, 100, body, theme, 2).length, body + DETAIL_CHROME_ROWS);
	assert.match(renderFleetDetail(row, timeline, 999, 100, 5, theme).join("\n"), /entry 499/);
	const collapsed = renderFleetDetail(row, timeline, 0, 100, 5, theme).join("\n");
	const expanded = renderFleetDetail(row, timeline, 0, 100, 5, theme, 2).join("\n");
	assert.match(collapsed, /Architect.*opus/); assert.match(collapsed, /m model/); assert.notEqual(collapsed, expanded); assert.match(expanded, /first/);
});

test("expanded tool content determines the scroll bound", () => {
	const entries = [{ kind: "tool" as const, title: "tool", content: "one\ntwo\nthree\nfour", timestamp: 0 }];
	const content = detailContent(entries, 80, 0);
	const state = { scrollOffset: 0, selectedIndex: 0, expandedIndex: 0 as number | null, followTail: false };
	detailTransition("\u001b[F", state, entries, 2, content.length);
	assert.equal(state.scrollOffset, content.length - 2);
	assert.match(renderFleetDetail(row, entries, state.scrollOffset, 80, 2, theme, 0).join("\n"), /four/);
});

test("detail transitions scroll, follow tail, verbose, expand, copy, and close", () => {
	const state = { scrollOffset: 0, selectedIndex: 2, expandedIndex: null as number | null, followTail: false, verbose: false };
	assert.equal(detailTransition("\r", state, timeline, 4), null); assert.equal(state.expandedIndex, 2);
	assert.equal(detailTransition("v", state, timeline, 4), null); assert.equal(state.verbose, true);
	assert.equal(detailTransition("\u0003", state, timeline, 4), "copy"); assert.equal(detailTransition("\u001b[F", state, timeline, 4), null); assert.equal(state.followTail, true); assert.ok(state.scrollOffset > 0);
	assert.equal(detailTransition("m", state, timeline, 4), "model");
	assert.equal(detailTransition("\u001b", state, timeline, 4), "close");
});

test("verbose detail wraps complete assistant, thinking, tool args and tool results", () => {
	const entries = [
		{ kind: "text" as const, title: "Assistant", content: "alpha beta gamma delta epsilon", timestamp: 1 },
		{ kind: "thinking" as const, title: "Thinking", content: "reasoning line one\nreasoning line two", timestamp: 2 },
		{ kind: "tool-start" as const, title: "Tool: bash", content: "{\"command\":\"printf a-very-long-command\"}", timestamp: 3, callId: "c1" },
		{ kind: "tool-result" as const, title: "Result: bash", content: "stdout first\nstdout second", timestamp: 4, callId: "c1", status: "success" as const, durationMs: 1250 },
	];
	const content = detailContent(entries, 24, null, true, 3);
	const joined = content.join("\n");
	for (const expected of ["alpha", "epsilon", "reasoning line one", "reasoning line two", "printf", "stdout first", "stdout second", "success", "1.25s"]) assert.match(joined, new RegExp(expected));
	assert.ok(content.every(line => Array.from(line).length <= 24));
	assert.deepEqual(detailEntryOffsets(entries, 24, null, true).map(item => item.index), [0, 1, 2, 3]);
	const rendered = renderFleetDetail(row, entries, 0, 24, 12, theme, null, true, 3).join("\n");
	assert.match(rendered, /Verbose/);
	assert.match(rendered, /v compact/);
});

test("compact detail remains one line per entry unless a tool is expanded", () => {
	const entries = [{ kind: "tool-start" as const, title: "Tool: bash", content: "one\ntwo", timestamp: 1 }];
	assert.equal(detailContent(entries, 80, null, false).length, 1);
	assert.equal(detailContent(entries, 80, 0, false).length, 3);
});

test("verbose navigation uses wrapped entry offsets and manual movement pauses tail follow", () => {
	const entries = [
		{ kind: "text" as const, title: "A", content: "one ".repeat(20), timestamp: 1 },
		{ kind: "text" as const, title: "B", content: "two", timestamp: 2 },
	];
	const offsets = detailEntryOffsets(entries, 20, null, true);
	const content = detailContent(entries, 20, null, true);
	const state = { scrollOffset: 0, selectedIndex: 0, expandedIndex: null as number | null, followTail: true, verbose: true };
	detailTransition("\u001b[B", state, entries, 3, content.length, offsets);
	assert.equal(state.selectedIndex, 1);
	assert.equal(state.followTail, false);
	assert.equal(state.scrollOffset, Math.max(0, offsets[1].start - 2));
	detailTransition("\u001b[F", state, entries, 3, content.length, offsets);
	assert.equal(state.followTail, true);
});

test("model choices expose every valid Pi model with stable specs", () => {
	const choices = fleetModelChoices([
		{ provider: "openai", id: "gpt-5", name: "GPT 5" },
		{ provider: "anthropic", id: "claude", name: "claude" },
		{ provider: "openai", id: "gpt-5", name: "duplicate" },
		{ provider: "", id: "invalid" },
	], "openai/gpt-5");
	assert.deepEqual(choices, [
		{ spec: "anthropic/claude", label: "anthropic/claude" },
		{ spec: "openai/gpt-5", label: "openai/gpt-5 — GPT 5 (current)" },
	]);
});

test("inline model picker visibly renders options above the detail layer", () => {
	const choices = fleetModelChoices([
		{ provider: "anthropic", id: "claude-opus", name: "Claude Opus" },
		{ provider: "openai", id: "gpt-5", name: "GPT 5" },
	]);
	const state = { index: 0, scrollOffset: 0 };
	const first = renderFleetModelPicker("Architect", choices, state, 100, 3, theme).join("\n");
	assert.match(first, /Model for Architect.*2 available/);
	assert.match(first, /anthropic\/claude-opus.*Claude Opus/);
	assert.match(first, /openai\/gpt-5.*GPT 5/);
	assert.match(first, /Enter apply.*Esc cancel/);
	assert.equal(modelPickerTransition("\u001b[B", state, choices.length, 3), null);
	assert.equal(state.index, 1);
	assert.equal(modelPickerTransition("\r", state, choices.length, 3), "select");
	assert.equal(modelPickerTransition("\u001b", state, choices.length, 3), "cancel");
});

test("session substitution picker renders source and available-target stages", () => {
	const choices = [{ spec: "openai/spark", label: "openai/spark → moonshot/una (active this session)" }];
	const state = { index: 0, scrollOffset: 0 };
	assert.match(renderFleetSubstitutionPicker("source", undefined, choices, state, 100, 3, theme).join("\n"), /1\/2 choose configured source/);
	const target = renderFleetSubstitutionPicker("target", "openai/spark", [{ spec: "moonshot/una", label: "moonshot/una" }], state, 100, 3, theme).join("\n");
	assert.match(target, /2\/2 choose available target/);
	assert.match(target, /Esc back/);
});

test("detail input normalizes keys identified from Kitty and legacy sequences", () => {
	assert.equal(matchesKey("\u001b[1;1A", Key.up), true);
	assert.equal(matchesKey("\u001b[1;1B", Key.down), true);
	assert.equal(normalizeFleetDetailInput("\u001b[1;1A", "up"), "\u001b[A");
	assert.equal(normalizeFleetDetailInput("\u001b[1;1B", "down"), "\u001b[B");
	assert.equal(normalizeFleetDetailInput("\u001b[5;1~", "pageUp"), "\u001b[5~");
	assert.equal(normalizeFleetDetailInput("\u001b[6;1~", "pageDown"), "\u001b[6~");
	assert.equal(normalizeFleetDetailInput("\u001b[1;1H", "home"), "\u001b[H");
	assert.equal(normalizeFleetDetailInput("\u001b[1;1F", "end"), "\u001b[F");
	assert.equal(normalizeFleetDetailInput("j"), "j");
});

test("normalized Kitty arrows move the inline model picker", () => {
	const state = { index: 1, scrollOffset: 0 };
	modelPickerTransition(normalizeFleetDetailInput("\u001b[1;1A", "up"), state, 4, 4);
	assert.equal(state.index, 0);
	modelPickerTransition(normalizeFleetDetailInput("\u001b[1;1B", "down"), state, 4, 4);
	assert.equal(state.index, 1);
});

test("inline model picker pages and keeps the selected option visible", () => {
	const choices = Array.from({ length: 20 }, (_, i) => ({ spec: `p/m${i}`, label: `p/m${i}` }));
	const state = { index: 0, scrollOffset: 0 };
	modelPickerTransition("\u001b[6~", state, choices.length, 4);
	assert.equal(state.index, 4);
	assert.equal(state.scrollOffset, 1);
	modelPickerTransition("\u001b[F", state, choices.length, 4);
	assert.equal(state.index, 19);
	assert.equal(state.scrollOffset, 16);
	assert.match(renderFleetModelPicker("Builder", choices, state, 80, 4, theme).join("\n"), /› p\/m19/);
});

test("coms peers show a notice rather than an empty transcript", () => {
	const peer = { ...row, kind: "peer" as const, backend: "coms" as const, hasTimeline: false, contextPct: null };
	const output = renderFleetDetail(peer, [], 0, 80, 4, theme);
	assert.equal(output.length, 4 + DETAIL_CHROME_ROWS); assert.match(output.join("\n"), /no local transcript/); assert.doesNotMatch(output.join("\n"), /m model/);
});
