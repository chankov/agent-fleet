import { test } from "node:test";
import assert from "node:assert/strict";

import {
	CARD_PREVIEW_LINE_CHARS,
	CARD_PREVIEW_LINES,
	MAX_RETAINED_TERMINAL_THREADS,
	MAX_SELECTED_MARKDOWN_CHARS,
	MAX_TIMELINE_ENTRIES,
	MAX_TIMELINE_ENTRY_CHARS,
	MODAL_TRUNCATION_MARKER,
	TIMELINE_TRUNCATION_MARKER,
	appendTimelineDelta,
	appendTimelineEntry,
	beginTurn,
	capSelectedMarkdown,
	clampModalView,
	finishTurn,
	formatBtwCardPreview,
	formatBtwResultMarkdown,
	planTerminalRetention,
	reconcileThreadView,
	shiftModalViewForPrunedEntries,
	steerTurn,
	turnElapsedMs,
} from "./state.js";

test("idle follow-up resets current-turn elapsed while mid-run steer preserves it", () => {
	let thread = { id: "t1", status: "done", startedAt: 1_000, turnStartedAt: 2_000, turnFinishedAt: 4_000 };

	thread = beginTurn(thread, 10_000);
	assert.equal(thread.turnStartedAt, 10_000);
	assert.equal(thread.turnFinishedAt, undefined);
	assert.equal(turnElapsedMs(thread, 12_500), 2_500);

	thread = steerTurn(thread);
	assert.equal(thread.turnStartedAt, 10_000, "steering a running turn does not reset elapsed start");
	assert.equal(turnElapsedMs(thread, 13_000), 3_000);

	thread = finishTurn(thread, 15_000, "done");
	assert.equal(turnElapsedMs(thread, 99_000), 5_000, "finished elapsed is stable");
});

test("terminal retention never evicts running threads", () => {
	const order = ["running-old", "done-1", "done-2", "running-new", "done-3"];
	const statuses = new Map([
		["running-old", "running"],
		["done-1", "done"],
		["done-2", "done"],
		["running-new", "running"],
		["done-3", "error"],
	]);

	const plan = planTerminalRetention(order, statuses, 2);

	assert.deepEqual(plan.evictedIds, ["done-1"]);
	assert.ok(plan.order.includes("running-old"));
	assert.ok(plan.order.includes("running-new"));
});

test("terminal retention evicts oldest terminal threads first", () => {
	const order = ["running", "done-a", "done-b", "error-c", "done-d"];
	const statuses = {
		running: "running",
		"done-a": "done",
		"done-b": "done",
		"error-c": "error",
		"done-d": "done",
	};

	const plan = planTerminalRetention(order, statuses, 2);

	assert.deepEqual(plan.evictedIds, ["done-a", "done-b"]);
	assert.deepEqual(plan.order, ["running", "error-c", "done-d"]);
});

test("default terminal retention cap keeps the newest fixed-size terminal history", () => {
	const order = Array.from({ length: MAX_RETAINED_TERMINAL_THREADS + 1 }, (_, i) => `done-${i}`);
	const statuses = Object.fromEntries(order.map((id) => [id, "done"]));

	const plan = planTerminalRetention(order, statuses);

	assert.deepEqual(plan.evictedIds, ["done-0"]);
	assert.equal(plan.order.length, MAX_RETAINED_TERMINAL_THREADS);
});

test("lastViewedId and current modal thread fall back when viewed thread is evicted", () => {
	const view = reconcileThreadView({
		order: ["a", "c"],
		lastViewedId: "b",
		currentId: "b",
	});

	assert.deepEqual(view, { lastViewedId: "c", currentId: "c" });
});

test("modal selection and scroll clamp after timeline shrink and pruning", () => {
	assert.deepEqual(
		clampModalView({ selectedIndex: 30, scrollOffset: 25, followTail: false }, 4, 12),
		{ selectedIndex: 3, scrollOffset: 0, followTail: false },
	);
	assert.deepEqual(
		shiftModalViewForPrunedEntries({ selectedIndex: 12, scrollOffset: 9, followTail: false }, 8, 5, 12),
		{ selectedIndex: 4, scrollOffset: 1, followTail: false },
	);
	assert.deepEqual(
		clampModalView({ selectedIndex: 5, scrollOffset: 5, followTail: false }, 0, 12),
		{ selectedIndex: 0, scrollOffset: 0, followTail: false },
	);
	assert.deepEqual(
		clampModalView({ selectedIndex: 0, scrollOffset: 0, followTail: true }, 3, 12),
		{ selectedIndex: 2, scrollOffset: 0, followTail: true },
	);
});

test("timeline additions cap entry content and prune to the maximum length", () => {
	let timeline = [];
	for (let i = 0; i < MAX_TIMELINE_ENTRIES + 2; i++) {
		({ timeline } = appendTimelineEntry(timeline, { kind: "user", title: "You", content: `entry-${i}` }, i));
	}

	assert.equal(timeline.length, MAX_TIMELINE_ENTRIES);
	assert.equal(timeline[0].content, "entry-2");

	const longText = "x".repeat(MAX_TIMELINE_ENTRY_CHARS + 500);
	({ timeline } = appendTimelineEntry([], { kind: "tool", title: "bash", content: longText }, 1));
	assert.equal(timeline[0].content.length, MAX_TIMELINE_ENTRY_CHARS);
	assert.ok(timeline[0].content.endsWith(TIMELINE_TRUNCATION_MARKER));

	({ timeline } = appendTimelineDelta([], "text", longText, 1));
	({ timeline } = appendTimelineDelta(timeline, "text", "more", 2));
	assert.equal(timeline[0].content.length, MAX_TIMELINE_ENTRY_CHARS);
	assert.ok(timeline[0].content.endsWith(TIMELINE_TRUNCATION_MARKER));
});

test("result markdown keeps metadata except turns and preserves the full final answer body", () => {
	const answer = `${"r".repeat(MAX_TIMELINE_ENTRY_CHARS + 50)}\nunique final tail`;
	const markdown = formatBtwResultMarkdown({
		note: "long result",
		ok: true,
		elapsedMs: 12_345,
		sessionFile: "/tmp/session.jsonl",
		answer,
	});

	assert.ok(markdown.includes("- task: long result"));
	assert.ok(markdown.includes("- ok: true"));
	assert.ok(markdown.includes("- elapsed: 12s"));
	assert.ok(markdown.includes("- session: /tmp/session.jsonl"));
	assert.ok(!markdown.includes("- turns:"));
	assert.ok(markdown.endsWith(`${answer}\n`));
	assert.ok(markdown.includes("unique final tail"));
	assert.ok(!markdown.includes(TIMELINE_TRUNCATION_MARKER));
});

test("compact card preview stays short without changing full result text", () => {
	const answer = [
		"a".repeat(CARD_PREVIEW_LINE_CHARS + 50),
		...Array.from({ length: CARD_PREVIEW_LINES + 2 }, (_, i) => `line-${i + 2}`),
	].join("\n");
	const preview = formatBtwCardPreview(answer);
	const lines = preview.split("\n");

	assert.equal(lines.length, CARD_PREVIEW_LINES + 1);
	assert.equal(lines[0].length, CARD_PREVIEW_LINE_CHARS);
	assert.ok(lines[0].endsWith("…"));
	assert.equal(lines.at(-1), "…");
	assert.ok(!preview.includes(`line-${CARD_PREVIEW_LINES + 2}`));
});

test("selected markdown is capped with a visible modal truncation marker", () => {
	const selected = capSelectedMarkdown("m".repeat(MAX_SELECTED_MARKDOWN_CHARS + 10));

	assert.equal(selected.length, MAX_SELECTED_MARKDOWN_CHARS);
	assert.ok(selected.endsWith(MODAL_TRUNCATION_MARKER));
});
