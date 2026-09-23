/**
 * Test-only C4 mock driver (fake S1 + fake workers). Opt-in dump: AF_C4_MOCK=1.
 * Does not edit production config or launch a provider. Load with
 * --import ./bin/test/helpers/system1-no-network.js
 */
import "./system1-no-network.js";
import assert from "node:assert/strict";
import test from "node:test";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { renderFleetDashboard } from "../../../.pi/harnesses/lib/fleet-dashboard-view.ts";
import { renderFleetDetail } from "../../../.pi/harnesses/lib/fleet-detail-view.ts";
import { selectWidgetRows, summariseWidget, type FleetRow } from "../../../.pi/harnesses/lib/fleet-read-model.ts";
import { renderFleetStrip, visibleWindow } from "../../../.pi/harnesses/lib/fleet-strip-view.ts";

const dump = process.env.AF_C4_MOCK === "1";
const log = (title: string, text: string) => { if (dump) process.stdout.write(`\n=== ${title} ===\n${text}\n`); };

const metrics = { visibleWidth, truncateToWidth };
const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text, bg: (_: string, text: string) => text };

const s1 = (over: Record<string, unknown> = {}) => ({
	dispatchId: "d", attemptId: "a", checkId: "check-fast", snapshotId: "s", runToken: "builder:1",
	phase: "evaluating", compact: "S1 evaluating", label: "S1 evaluating · failures · 0.4s · LLM parallel",
	detail: "check check-fast", effectiveMode: "shadow", llmRelation: "parallel", rule: "failures", elapsedMs: 400,
	retainUntil: Number.POSITIVE_INFINITY, status: "unknown", reason: "unknown", statusChoice: "unknown",
	confidence: null, returnedModel: "unknown", stateVersion: "unknown", questionsVersion: "unknown",
	policyVersion: "none", usage: "unknown", source: "none", applied: "unknown", outcome: "unknown",
	llm: "running", llmVerdict: "unknown", degraded: false, ...over,
});

const row = (key: string, over: Partial<FleetRow> = {}): FleetRow => ({
	key, runToken: `${key}:1`, kind: "specialist", name: key === "builder" ? "Builder" : "Reviewer", depth: 0,
	status: "running", model: "m", backend: "native", contextPct: 20, contextTokens: 1, elapsed: 1000, startedAt: 0,
	timingKind: "run", toolCount: 1, lastWork: "edit", hasTimeline: true, lastAtDepth: [], ...over,
});

function strip(rows: FleetRow[], width: number, active: boolean) {
	const summary = summariseWidget(rows);
	return renderFleetStrip({
		active, interactiveAvailable: true, selectedKey: rows[0]?.key, summary,
		window: visibleWindow(rows, 0, 0, 4), maxRows: 6,
	}, width, theme, metrics);
}

test("C4 mock: concurrent owners, statuses, widths, fast finish, cancel retention, dashboard, detail", () => {
	const evaluating = [
		row("builder", { system1: s1() as FleetRow["system1"] }),
		row("reviewer", { system1: s1({ runToken: "reviewer:1", phase: "unavailable", compact: "S1 unavailable → LLM judging", label: "S1 unavailable → LLM judging", llmRelation: "fallback" }) as FleetRow["system1"] }),
	];
	const w120 = strip(evaluating, 120, true).join("\n");
	const w40 = strip(evaluating, 40, true).join("\n");
	const w20 = strip(evaluating, 20, true).join("\n");
	log("strip 120", w120);
	log("strip 40", w40);
	log("strip 20", w20);
	assert.match(w120, /Builder/);
	assert.match(w120, /S1 evaluating/);
	assert.match(w120, /LLM parallel/);
	assert.match(w120, /Reviewer/);
	assert.match(w120, /S1 unavailable → LLM judging/);
	assert.match(w120, /1 tools/);
	assert.match(w120, /edit/);
	assert.match(w40, /S1/);
	assert.match(w20, /S1/);
	assert.ok(w20.split("\n").every(line => visibleWidth(line) <= 20));

	const collapsed = strip(evaluating, 120, false).join("\n");
	log("collapsed", collapsed);
	assert.match(collapsed, /S1 mixed|S1 1 evaluating/);

	const fastRow = row("builder", {
		system1: s1({ phase: "result", compact: "S1 on_track", label: "S1 on_track · 402ms · shadow · LLM parallel", elapsedMs: 402, retainUntil: 15_000 }) as FleetRow["system1"],
	});
	const fastText = strip([fastRow], 120, true).join("\n");
	log("fast result", fastText);
	assert.match(fastText, /S1 on_track/);
	assert.match(fastText, /1 tools/);
	assert.match(fastText, /edit/);

	const idle = row("builder", {
		status: "idle",
		system1: s1({ phase: "cancelled", compact: "S1 cancelled", label: "S1 cancelled", retainUntil: 15_000 }) as FleetRow["system1"],
	});
	assert.equal(selectWidgetRows([idle], 14_999).length, 1);
	assert.equal(selectWidgetRows([idle], 15_000).length, 0);
	const keep = strip(selectWidgetRows([idle], 14_999), 100, false).join("\n");
	log("cancel t=14999", keep);
	assert.match(keep, /S1 cancelled/);

	const dashRows = [
		row("builder", { name: "Builder", system1: s1({ phase: "result", compact: "S1 on_track", label: "S1 on_track" }) as FleetRow["system1"] }),
		row("reviewer", { name: "Reviewer" }),
	];
	const dashVm = { rows: dashRows, selection: { key: "builder", index: 0 }, summary: { running: 2, done: 0, failed: 0, totalTokens: 2, intervals: [], wallMs: 1000 }, filterQuery: "", showFinished: false };
	const dash120 = renderFleetDashboard(dashVm, 120, 4, theme, metrics).join("\n");
	const dash40 = renderFleetDashboard(dashVm, 40, 4, theme, metrics).join("\n");
	log("dashboard 120", dash120);
	log("dashboard 40", dash40);
	assert.match(dash120, /S1 on_track/);
	assert.equal(dash120.split("\n").filter(line => /Builder|Reviewer/.test(line)).length, 2);
	assert.match(dash40, /S1 on_track/);

	const entries = [
		{ kind: "tool" as const, title: "Tool: read", content: "src/a.ts", timestamp: 1 },
		{ kind: "text" as const, title: "System 1", content: "System 1 · watchdog · failures · shadow\ncheck check-fast · ok · 402ms\nsource none", timestamp: 2 },
		{ kind: "text" as const, title: "Assistant", content: "worker text", timestamp: 3 },
	];
	const live = renderFleetDetail({ ...fastRow, name: "Builder" }, entries, 0, 80, 12, theme).join("\n");
	const reopen = renderFleetDetail({ ...row("builder", { name: "Builder", status: "idle" }), system1: undefined }, entries, 0, 36, 10, theme).join("\n");
	log("detail live", live);
	log("detail reopen 36", reopen);
	assert.match(live, /check-fast/);
	assert.match(live, /source none/);
	assert.match(live, /Tool: read/);
	assert.match(reopen, /S1 System 1/);
	assert.match(reopen, /source none/);
	assert.doesNotMatch(live + reopen + w120, /sendMessage/);
});
