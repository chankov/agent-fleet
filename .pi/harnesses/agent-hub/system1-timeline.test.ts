import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFleetTranscriptStore, readFleetTranscript } from "../lib/fleet-transcript-store.ts";
import { appendSystem1TimelineCard, appendTimelineEvent, appendTimelineText, flushTimelineStore, isSystem1TimelineCard } from "./timeline.ts";
import { bumpMessageCount } from "./ui/activity-dots.ts";

test("A13 System 1 text cards do not merge with assistant deltas live or on disk", () => {
	const dir = mkdtempSync(join(tmpdir(), "s1-timeline-"));
	try {
		const store = createFleetTranscriptStore(join(dir, "transcript.jsonl"));
		const target: any = { timeline: [], transcriptStore: store, messageCount: 0 };
		bumpMessageCount(target, "text");
		appendTimelineText(target, "text", "hello ");
		appendSystem1TimelineCard(target, "System 1 · watchdog · loop · shadow\ncheck abc · ok · 4ms");
		bumpMessageCount(target, "text");
		appendTimelineText(target, "text", "world");
		flushTimelineStore(target);
		assert.equal(target.timeline.length, 3);
		assert.equal(isSystem1TimelineCard(target.timeline[1]), true);
		assert.equal(target.timeline[0].content.includes("world"), false);
		assert.equal(target.timeline[1].content.includes("hello"), false);
		assert.equal(target.timeline[1].content.includes("world"), false);
		assert.equal(target.timeline[2].content, "world");
		assert.equal(target.messageCount, 1);
		const disk = readFleetTranscript(store.path).events;
		assert.equal(disk.length, 3);
		assert.equal(disk[1].title, "System 1");
		assert.equal(disk[0].content.includes("world"), false);
		assert.equal(disk[2].content, "world");
		assert.equal(disk.some((event) => event.kind !== "text" && event.kind !== "thinking" && event.kind !== "tool-start" && event.kind !== "tool-result"), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("legacy tool row remains a tool in the live UI and becomes a readable durable result", () => {
 const dir = mkdtempSync(join(tmpdir(), "tool-timeline-"));
 try {
  const store = createFleetTranscriptStore(join(dir, "transcript.jsonl"));
  const target: any = { timeline: [], transcriptStore: store };
  appendTimelineEvent(target, { kind: "tool", title: "read", content: "ok", timestamp: 1 });
  assert.equal(target.timeline[0].kind, "tool");
  assert.equal(readFleetTranscript(store.path).events[0].kind, "tool-result");
 } finally {
  rmSync(dir, { recursive: true, force: true });
 }
});

test("A13 tool/System 1/assistant keeps the previous worker count", () => {
	const target: any = { timeline: [], messageCount: 0 };
	target.timeline.push({ kind: "tool-result", title: "Result: read", content: "ok", timestamp: 1 });
	appendSystem1TimelineCard(target, "System 1 · watchdog · failures · shadow\ncheck def · skipped · elapsed unknown");
	const before = target.messageCount;
	bumpMessageCount(target, "text");
	appendTimelineText(target, "text", "after tool");
	assert.equal(target.messageCount, before + 1);
	assert.equal(target.timeline.at(-1).content, "after tool");
	assert.equal(target.timeline.at(-1).title, "Assistant");
	assert.equal(isSystem1TimelineCard(target.timeline.at(-2)), true);
});
