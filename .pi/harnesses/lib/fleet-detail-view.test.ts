import assert from "node:assert/strict";
import test from "node:test";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { DETAIL_CHROME_ROWS, applyLiveFleetDetailRow, detailBodyLines, detailBodyOffsets, detailContent, detailEntryOffsets, detailTransition, fleetModelChoices, modelPickerTransition, normalizeFleetDetailInput, openProactiveEvidence, proactiveEvidenceContent, evidenceScroll, proactiveHistoryLines, renderFleetDetail, renderFleetModelPicker, renderFleetSubstitutionPicker } from "./fleet-detail-view.ts";

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

test("A17 System 1 detail uses its own glyph and keeps the tool timeline", () => {
	const system1 = { dispatchId: "d", attemptId: "attempt-22", checkId: "check-fast", snapshotId: "snap", runToken: "a:1", phase: "result" as const, compact: "S1 on_track", label: "S1 on_track", detail: "check check-fast / attempt attempt\nJev: on_track · confidence unknown\nsource none", effectiveMode: "shadow" as const, llmRelation: "parallel" as const, rule: "failures", elapsedMs: 402, retainUntil: 20_000, status: "ok", reason: "unknown", statusChoice: "on_track", confidence: null, returnedModel: "unknown", stateVersion: "unknown", questionsVersion: "unknown", policyVersion: "none" as const, usage: "unknown" as const, source: "none" as const, applied: "no" as const, outcome: "unknown", llm: "none", llmVerdict: "unknown", degraded: false };
	const entries = [
		{ kind: "tool" as const, title: "Tool: read", content: "src/a.ts", timestamp: 1 },
		{ kind: "text" as const, title: "System 1", content: "System 1 · watchdog · failures · shadow\ncheck check-fa / attempt attempt · ok · 402ms\nsource none", timestamp: 2 },
		{ kind: "text" as const, title: "Assistant", content: "worker text", timestamp: 3 },
	];
	const live = renderFleetDetail({ ...row, runToken: "a:1", system1, toolCount: 3 }, entries, 0, 80, 12, theme).join("\n");
	assert.match(live, /S1 on_track/);
	assert.match(live, /check check-fast/);
	assert.match(live, /S1 System 1/);
	assert.match(live, /source none/);
	assert.match(live, /Tool: read/);
	assert.doesNotMatch(live, /🤖/);
	const reopened = renderFleetDetail(row, entries, 0, 36, 10, theme).join("\n");
	assert.match(reopened, /S1 System 1/);
	assert.match(reopened, /source none/);
	assert.match(reopened, /Tool: read/);
	assert.ok(reopened.split("\n").filter(line => line.includes("S1")).every(line => line.length <= 36));
	const state = { scrollOffset: 0, selectedIndex: 0, expandedIndex: null, followTail: false };
	assert.equal(detailTransition("\r", state, entries, 8), null);
	assert.equal(state.expandedIndex, 0);
});

test("F-14 System 1 preface is inside follow-tail and keyboard scroll bounds", () => {
	const preface = Array.from({ length: 7 }, (_, i) => `meta-${i}`).join("\n");
	const system1 = { dispatchId: "d", attemptId: "a", checkId: "c", snapshotId: "s", runToken: "a:1", phase: "evaluating" as const, compact: "S1 evaluating", label: "S1 evaluating", detail: preface, effectiveMode: "shadow" as const, llmRelation: "parallel" as const, rule: "failures", elapsedMs: 400, retainUntil: Number.POSITIVE_INFINITY, status: "unknown", reason: "unknown", statusChoice: "unknown", confidence: null, returnedModel: "unknown", stateVersion: "unknown", questionsVersion: "unknown", policyVersion: "none" as const, usage: "unknown" as const, source: "none" as const, applied: "unknown" as const, outcome: "unknown", llm: "running", llmVerdict: "unknown", degraded: false };
	const live = { ...row, runToken: "a:1", system1 };
	const entries = Array.from({ length: 30 }, (_, i) => ({ kind: "text" as const, title: "Assistant", content: `line-${i}`, timestamp: i }));
	const body = 12;
	const content = detailBodyLines(live, entries, 80, null, false, 29);
	assert.equal(content.length, 7 + 30);
	const tail = Math.max(0, content.length - body);
	const tailed = renderFleetDetail(live, entries, tail, 80, body, theme).join("\n");
	assert.equal(tail, 25);
	assert.match(tailed, /line-29/);
	assert.doesNotMatch(tailed, /line-17\b/);
	const offsets = detailBodyOffsets(live, entries, 80, null, false);
	const state = { scrollOffset: 0, selectedIndex: 0, expandedIndex: null as number | null, followTail: false };
	for (let i = 0; i < 20; i++) detailTransition("\u001b[B", state, entries, body, content.length, offsets);
	assert.equal(state.selectedIndex, 20);
	const selected = offsets[20]!;
	assert.ok(selected.start >= state.scrollOffset && selected.start < state.scrollOffset + body);
	detailTransition("\u001b[F", state, entries, body, content.length, offsets);
	assert.match(renderFleetDetail(live, entries, state.scrollOffset, 80, body, theme, null, false, state.selectedIndex).join("\n"), /line-29/);
});

test("F-15 an open detail row takes the current System 1 view without dropping a model edit", () => {
	const open = { ...row, runToken: "a:1", model: "opus → haiku next", system1: { dispatchId: "d", attemptId: "a", checkId: "c", snapshotId: "s", runToken: "a:1", phase: "evaluating" as const, compact: "S1 evaluating", label: "S1 evaluating", detail: "old", effectiveMode: "shadow" as const, llmRelation: "parallel" as const, rule: "failures", elapsedMs: 400, retainUntil: Number.POSITIVE_INFINITY, status: "unknown", reason: "unknown", statusChoice: "unknown", confidence: null, returnedModel: "unknown", stateVersion: "unknown", questionsVersion: "unknown", policyVersion: "none" as const, usage: "unknown" as const, source: "none" as const, applied: "unknown" as const, outcome: "unknown", llm: "running", llmVerdict: "unknown", degraded: false } };
	const fresh = { ...open, model: "opus", system1: { ...open.system1, phase: "result" as const, compact: "S1 on_track", detail: "check check-fast\nsource none" } };
	const merged = applyLiveFleetDetailRow(open, fresh, true);
	assert.equal(merged.model, "opus → haiku next");
	assert.match(renderFleetDetail(merged, [], 0, 80, 8, theme).join("\n"), /S1 on_track/);
	assert.doesNotMatch(renderFleetDetail(merged, [], 0, 80, 8, theme).join("\n"), /S1 evaluating/);
	assert.equal(applyLiveFleetDetailRow(open, undefined, true).system1, undefined);
	assert.equal(applyLiveFleetDetailRow(open, undefined, false).system1?.compact, "S1 evaluating");
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

test("P11b detail and history keep reviews separate from assistant messages and from strip expiry", () => {
	const hex = "a".repeat(64);
	const base = { id: hex, owner: "a", attempt: "1", runToken: "a:1", source: "system1" as const, claim: "suspicion" as const, state: "new" as const, ruleId: "rules.md#heading", ruleHash: hex, subject: "docs/x.md", snapshotHandle: hex, snapshotHash: hex, snapshotId: "snapshot-1", unitId: "unit-1", excerptHash: hex, occurrences: 1 };
	const states = ["new", "repeated", "stale", "resolved"] as const;
	const owner = { owner: "a", attempt: "1", runToken: "a:1", lastStatus: "reviewed", coverage: "partial" as const, turns: 4, reviewed: 1, partial: 3, evaluating: 0, currentViolations: 1, currentSuspicions: 1, stale: 1, resolved: 1, findings: [base], history: states.map((state, index) => ({ turnId: `turn-${index}`, status: "reviewed", coverage: { status: "partial", gaps: ["coverage_gap"], checked: ["rules.md#heading:unit-1"] }, findings: [{ ...base, state, source: index === 1 ? "deterministic" as const : "system1" as const }] })) };
	const live = { ...row, runToken: "a:1", proactive: owner };
	const entries = [{ kind: "text" as const, title: "Assistant", content: "assistant-only", timestamp: 0 }];
	const content = detailBodyLines(live, entries, 140, null);
	assert.match(content.join("\n"), /rule rules.md#heading.*source docs\/x.md.*snapshot snapshot-1.*unit unit-1/);
	assert.match(content.join("\n"), /System 1 suspicion/);
	assert.match(proactiveHistoryLines(owner, 140).join("\n"), /new[\s\S]*repeated.*deterministic violation[\s\S]*stale[\s\S]*resolved/);
	assert.equal(detailBodyOffsets(live, entries, 140, null)[0].start, content.length - 1);
	assert.equal(entries.length, 1);
	assert.doesNotMatch(JSON.stringify(owner), /assistant-only/);
	assert.doesNotMatch(detailBodyLines({ ...live, runToken: "a:2" }, entries, 140, null).join("\n"), /snapshot-1/);
	assert.equal(applyLiveFleetDetailRow(live, undefined, true).proactive, undefined);
});

test("P11b explicit evidence request validates refs and delegates exclusively to private readback", () => {
	const hex = "b".repeat(64);
	const ref = { snapshotHandle: hex, snapshotHash: hex, snapshotId: "captured", unitId: "unit", excerptHash: hex } as Parameters<typeof openProactiveEvidence>[0];
	let calls = 0;
	const retained = (handle: string, digest: string, snapshot: string, unit: string, excerpt: string) => { calls++; assert.deepEqual([handle, digest, snapshot, unit, excerpt], [hex, hex, "captured", "unit", hex]); return "captured bytes"; };
	assert.equal(openProactiveEvidence(ref, retained), "captured bytes");
	assert.equal(openProactiveEvidence({ ...ref, snapshotHash: "bad" }, retained), null);
	assert.equal(calls, 1);
	assert.equal(openProactiveEvidence(ref, () => null), null, "deleted or corrupt retained snapshot is unavailable, not live source");
});

test("D1 narrow and tall evidence scroll exposes every exact label identity without truncating or showing an unavailable template", () => {
 const hex="a".repeat(64), id=`rules/README.md#${"Long heading ".repeat(12)}@1:${hex}`;
 const finding={snapshotId:hex,ruleId:id,ruleHash:hex,subject:"docs/long-source.md"} as Parameters<typeof proactiveEvidenceContent>[1];
 const lines=proactiveEvidenceContent("captured\n"+"evidence ".repeat(50),finding,17);
 assert.ok(lines.every(line=>Array.from(line).length<=17));
 const template=JSON.stringify({snapshotId:hex,ruleId:id,ruleHash:hex,subject:finding.subject,expected:"unknown"});
 // The heading itself can exceed the viewport; keys remain reconstructable from wrapped rows.
 const first=lines.findIndex(line=>line.startsWith(" {\"snapshotId\""));
 assert.ok(first>=0);assert.equal(lines.slice(first,first+Math.ceil(Array.from(template).length/16)).map(line=>line.slice(1)).join(""),template);
 for(const height of [2,80]) { let offset=0; const seen=new Set<string>();
  for(let i=0;i<lines.length+2;i++){ for(const line of lines.slice(offset,offset+height))seen.add(line);offset=evidenceScroll("\u001b[B",offset,lines.length,height); }
  assert.equal(offset,Math.max(0,lines.length-height));assert.ok(lines.every(line=>seen.has(line)));
  assert.equal(evidenceScroll("\u001b[H",offset,lines.length,height),0);
  assert.equal(evidenceScroll("\u001b[F",0,lines.length,height),offset);
  assert.equal(evidenceScroll("\u001b[5~",offset,lines.length,height),Math.max(0,offset-height));
 }
 assert.deepEqual(proactiveEvidenceContent(null,finding,17),[" Evidence unavail", " able (retained", " snapshot missing", " or invalid)."]);
 assert.ok(proactiveEvidenceContent(null,finding,17).every(line => line.length <= 17));
});

test("D1 preface scroll reaches long wrapped identities even when no timeline entry moves", () => {
 const hex="a".repeat(64), finding={id:hex,owner:"a",attempt:"1",runToken:"a:1",source:"system1" as const,claim:"suspicion" as const,state:"new" as const,ruleId:`rules/README.md#Long heading@1:${hex}`,ruleHash:hex,subject:"docs/x.md",snapshotHandle:hex,snapshotHash:hex,snapshotId:hex,unitId:"u",excerptHash:hex,occurrences:1};
 const review={turnId:"turn",status:"reviewed",coverage:{status:"checked",gaps:[],checked:[]},findings:[finding]};
 const live={...row,runToken:"a:1",proactive:{owner:"a",attempt:"1",runToken:"a:1",lastStatus:"reviewed",coverage:"checked" as const,turns:1,reviewed:1,partial:0,evaluating:0,currentViolations:0,currentSuspicions:1,stale:0,resolved:0,findings:[finding],history:[review]}};
 const entries=[{kind:"text" as const,title:"assistant",content:"end",timestamp:0}],width=21,body=3;
 const content=detailBodyLines(live,entries,width,null),offsets=detailBodyOffsets(live,entries,width,null);
 assert.ok(content.some(line=>line.includes("rules/README")));
 assert.ok(content.every(line=>Array.from(line).length<=width));
 const state={scrollOffset:content.length-body,selectedIndex:0,expandedIndex:null,followTail:true};
 for(let i=0;i<content.length;i++)detailTransition("\u001b[A",state,entries,body,content.length,offsets);
 assert.equal(state.scrollOffset,0);
 assert.match(renderFleetDetail(live,entries,state.scrollOffset,width,body,theme).join("\n"),/Review/);
});

test("coms peers show a notice rather than an empty transcript", () => {
	const peer = { ...row, kind: "peer" as const, backend: "coms" as const, hasTimeline: false, contextPct: null };
	const output = renderFleetDetail(peer, [], 0, 80, 4, theme);
	assert.equal(output.length, 4 + DETAIL_CHROME_ROWS); assert.match(output.join("\n"), /no local transcript/); assert.doesNotMatch(output.join("\n"), /m model/);
});
