import assert from "node:assert/strict";
import test from "node:test";
import { activityDots, bumpMessageCount, eventCount } from "./activity-dots.ts";
import { collectRunningStripItems, renderRunningStrip } from "./running-strip.ts";

test("activityDots cycles 1–5 periods", () => {
	assert.equal(activityDots(0), "");
	assert.equal(activityDots(1), ".");
	assert.equal(activityDots(2), "..");
	assert.equal(activityDots(5), ".....");
	assert.equal(activityDots(6), ".");
	assert.equal(eventCount(3, 2), 5);
});

test("bumpMessageCount counts each new text message once", () => {
	const target = { timeline: [] as Array<{ kind: string }>, messageCount: 0 };
	bumpMessageCount(target, "text");
	assert.equal(target.messageCount, 1);
	target.timeline.push({ kind: "text" });
	bumpMessageCount(target, "text");
	assert.equal(target.messageCount, 1);
	target.timeline.push({ kind: "tool-start" });
	bumpMessageCount(target, "text");
	assert.equal(target.messageCount, 2);
	bumpMessageCount(target, "thinking");
	assert.equal(target.messageCount, 2);
});

test("collectRunningStripItems includes running specialist, delegate, research, and coms", () => {
	const items = collectRunningStripItems({
		specialists: [{
			name: "planner",
			status: "running",
			model: "gpt-6-astra",
			elapsed: 12_000,
			toolCount: 2,
			messageCount: 1,
			delegations: [
				{ role: "scout", id: "scout-1", status: "running", model: "spark", elapsed: 0, startedAt: 1_000, toolCount: 1, messageCount: 0 },
				{ role: "rules", id: "rules-1", status: "done", model: "luna", elapsed: 9_000, startedAt: 1, toolCount: 4, messageCount: 1 },
			],
		}, {
			name: "builder",
			status: "idle",
			model: "sol",
			elapsed: 0,
			toolCount: 0,
			messageCount: 0,
		}],
		research: [
			{ id: 2, persona: true, displayName: "researcher", status: "running", model: "luna", elapsed: 7_000, toolCount: 1, messageCount: 1 },
			{ id: 3, persona: false, displayName: "research", status: "done", model: "luna", elapsed: 1, toolCount: 0, messageCount: 0 },
		],
		coms: [
			{ name: "alpha", model: "p/m", elapsed: 8_000, eventCount: 2, running: true },
			{ name: "beta", model: "x", elapsed: 0, eventCount: 0, running: false },
		],
	}, 5_000);
	assert.equal(items.length, 4);
	assert.equal(items[0].name, "planner");
	assert.equal(items[0].model, "gpt-6-astra");
	assert.equal(items[1].name, "planner/scout");
	assert.equal(items[1].elapsedMs, 4_000);
	assert.equal(items[2].name, "r2 researcher");
	assert.equal(items[3].name, "alpha (coms)");
});

test("renderRunningStrip is empty when idle and shows name, model, seconds, dots", () => {
	const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
	assert.deepEqual(renderRunningStrip([], 80, theme), []);
	const lines = renderRunningStrip([{ name: "planner", model: "gpt-6-astra", elapsedMs: 12_400, eventCount: 3 }], 80, theme);
	assert.equal(lines.length, 1);
	assert.match(lines[0], /planner/);
	assert.match(lines[0], /gpt-6-astra/);
	assert.match(lines[0], /12s/);
	assert.match(lines[0], /\.\.\./);
});
