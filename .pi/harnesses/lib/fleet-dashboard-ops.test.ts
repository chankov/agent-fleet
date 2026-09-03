import assert from "node:assert/strict";
import test from "node:test";
import {
	attachFleetDashboardTicker,
	compactWidgetsEnabled,
	gridColumnsForItems,
	gridColumnsForSize,
	liveTimeline,
	renderCardGrid,
	resolveFleetKill,
	resolveFleetRestart,
	snapshotFleetDetailRow,
} from "./fleet-dashboard-ops.ts";
import { createPanelResources } from "./fleet-panel.ts";
import { renderFleetDetail, type TimelineEntry } from "./fleet-detail-view.ts";

const theme = { fg: (_: string, s: string) => s, bold: (s: string) => s };

const row = (kind: "specialist" | "research" | "delegate" | "peer", name = kind) =>
	({ key: kind === "research" ? "r1" : kind === "peer" ? "peer:1" : name, kind, name, status: "running" as const });

// ── C3: confirmed kill outcomes per row kind ──────────────────────────────

test("C3 resolveFleetKill kills owned specialist process and research rows", () => {
	const proc = { pid: 1 };
	assert.deepEqual(
		resolveFleetKill(row("specialist", "Builder"), {
			researchExists: () => false,
			agentHandles: () => ({ proc }),
		}),
		{ action: "kill-proc", message: "Killing Builder..." },
	);
	assert.deepEqual(
		resolveFleetKill(row("research", "r1 explore"), {
			researchExists: () => true,
			agentHandles: () => undefined,
		}),
		{ action: "kill-research", message: "Killed research r1 explore." },
	);
});

test("C3 resolveFleetKill aborts coms-backed specialists via comsAbort", () => {
	let aborted = false;
	const outcome = resolveFleetKill(row("specialist", "Coder"), {
		researchExists: () => false,
		agentHandles: () => ({ comsAbort: () => { aborted = true; } }),
	});
	assert.equal(outcome.action, "coms-abort");
	assert.match(outcome.message, /Abandoning Coder's coms dispatch/);
	// The production decision helper must not perform the hub-owned side effect.
	assert.equal(aborted, false);
});

test("C3 resolveFleetKill gives explicit feedback for peer, delegate, and idle rows", () => {
	const noHandles = { researchExists: () => false, agentHandles: () => undefined };
	const finished = resolveFleetKill({ ...row("specialist", "Builder"), status: "done" }, {
		researchExists: () => false,
		agentHandles: () => ({}), // present but no proc/abort
	});
	assert.equal(finished.action, "unsupported");
	assert.match(finished.message, /Builder is already finished/);

	const peer = resolveFleetKill(row("peer", "Claude"), noHandles);
	assert.equal(peer.action, "unsupported");
	assert.match(peer.message, /Kill is unsupported for peer/);

	const del = resolveFleetKill(row("delegate", "child"), noHandles);
	assert.equal(del.action, "unsupported");
	assert.match(del.message, /Kill is unsupported for delegate/);

	const missingResearch = resolveFleetKill(row("research", "r9 gone"), {
		researchExists: () => false,
		agentHandles: () => undefined,
	});
	assert.equal(missingResearch.action, "unsupported");
	assert.match(missingResearch.message, /no longer available/);
});

// ── C4: confirmed restart outcomes ────────────────────────────────────────

test("C4 resolveFleetRestart restarts specialists and refuses research rows", () => {
	assert.deepEqual(
		resolveFleetRestart(row("specialist", "Builder"), {
			specialistRestartable: () => true,
		}),
		{ action: "restart-specialist", message: "Restarting Builder (fresh)..." },
	);
	const research = resolveFleetRestart(row("research", "r1 explore"), {
		specialistRestartable: () => false,
	});
	assert.equal(research.action, "unsupported");
	assert.match(research.message, /cannot be restarted; spawn a new helper instead/);
});

test("C4 resolveFleetRestart refuses peer, delegate, and taskless rows", () => {
	const deny = { specialistRestartable: () => false };
	const peer = resolveFleetRestart(row("peer", "Claude"), deny);
	assert.equal(peer.action, "unsupported");
	assert.match(peer.message, /Restart is unsupported for peer/);

	const del = resolveFleetRestart(row("delegate", "child"), deny);
	assert.equal(del.action, "unsupported");
	assert.match(del.message, /Restart is unsupported for delegate/);

	const none = resolveFleetRestart(row("specialist", "Builder"), deny);
	assert.equal(none.action, "unsupported");
	assert.match(none.message, /has no previous task to restart/);
});

// ── C5: ticker lifecycle ──────────────────────────────────────────────────

test("C5 attachFleetDashboardTicker refreshes on interval and tears down on dispose", async () => {
	const resources = createPanelResources();
	let renders = 0;
	const dispose = attachFleetDashboardTicker(resources, () => { renders++; }, 15);
	await new Promise((r) => setTimeout(r, 50));
	assert.ok(renders >= 2, `expected ticker renders, got ${renders}`);
	const atDispose = renders;
	dispose();
	await new Promise((r) => setTimeout(r, 40));
	assert.equal(renders, atDispose, "ticker must stop after dispose");
	assert.equal(resources.closed, true);
});

// ── C6: live timeline replacement ─────────────────────────────────────────

test("C6 liveTimeline follows re-dispatch array replacement through detail render", () => {
	const target: { timeline: TimelineEntry[] } = {
		timeline: [{ kind: "text", title: "old", content: "first run", timestamp: 1 }],
	};
	const fleetRow = {
		key: "builder", name: "Builder", kind: "specialist" as const, depth: 0, status: "running" as const,
		model: "m", backend: "native" as const, contextPct: 10, contextTokens: 1, elapsed: 1000,
		toolCount: 0, lastWork: "x", hasTimeline: true,
	};
	assert.match(renderFleetDetail(fleetRow, liveTimeline(target), 0, 80, 3, theme).join("\n"), /first run/);

	// Re-dispatch replaces the array reference (hub does `state.timeline = []`).
	target.timeline = [{ kind: "text", title: "new", content: "second run", timestamp: 2 }];
	const after = renderFleetDetail(fleetRow, liveTimeline(target), 0, 80, 3, theme).join("\n");
	assert.match(after, /second run/);
	assert.doesNotMatch(after, /first run/);

	// Dropped target yields empty body, not a throw.
	assert.deepEqual(liveTimeline(undefined), []);
	assert.deepEqual(liveTimeline(null), []);
});

// ── C7: compact widget off ────────────────────────────────────────────────

test("grid column helpers stay defensive for empty and tiny rosters", () => {
	assert.equal(gridColumnsForSize(0), 1);
	assert.equal(gridColumnsForSize(1), 1);
	assert.equal(gridColumnsForSize(4), 2);
	assert.equal(gridColumnsForSize(5), 3);
	assert.equal(gridColumnsForItems(0, 1), 1);
	assert.equal(gridColumnsForItems(Number.NaN, 1), 1);
	assert.equal(gridColumnsForItems(3, 1), 1);
	assert.doesNotThrow(() => renderCardGrid(["card"], 0, 1, card => [`[${card}]`]));
	assert.deepEqual(renderCardGrid(["card"], 0, 1, card => [`[${card}]`]), ["[card]"]);
});

test("snapshotFleetDetailRow freezes elapsed once the live target is no longer running", () => {
	const row = { key: "r1", name: "r1 research", kind: "research" as const, status: "running" as const, startedAt: 1000, elapsed: 0, lastWork: "searching" };
	const live = snapshotFleetDetailRow(row, { status: "running", lastWork: "still going" }, 2500);
	assert.equal(live.status, "running");
	assert.equal(live.elapsed, 1500);
	assert.equal(live.lastWork, "still going");

	const frozen = snapshotFleetDetailRow(row, { status: "done", elapsed: 1800, lastWork: "found it" }, 99999);
	assert.equal(frozen.status, "done");
	assert.equal(frozen.elapsed, 1800);
	assert.equal(frozen.lastWork, "found it");
});

test("C7 compactWidgetsEnabled hides compact widgets when viewMode is off", () => {
	assert.equal(compactWidgetsEnabled("compact"), true);
	assert.equal(compactWidgetsEnabled("off"), false);

	// This is the production predicate used by every compact-widget guard.
	assert.equal(compactWidgetsEnabled("compact"), true);
	assert.equal(compactWidgetsEnabled("off"), false);
});

