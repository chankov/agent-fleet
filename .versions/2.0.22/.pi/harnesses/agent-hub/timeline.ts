import { redactTimelineEvent, type FleetTranscriptStore } from "../lib/fleet-transcript-store.ts";
import type { TimelineEntry } from "./ui/zoom.ts";

const MAX_LIVE_TIMELINE_ENTRIES = 500;
export const MAX_LIVE_ENTRY_CHARS = 64 * 1024;
export const SYSTEM1_CARD_TITLE = "System 1";

export function isSystem1TimelineCard(entry: { kind?: string; title?: string } | undefined): boolean {
	return entry?.kind === "text" && entry.title === SYSTEM1_CARD_TITLE;
}

export type TimelineTarget = {
	timeline: TimelineEntry[];
	transcriptStore?: FleetTranscriptStore;
	transcriptPending?: TimelineEntry;
	transcriptFlushTimer?: ReturnType<typeof setTimeout>;
	zoomRender?: (force?: boolean) => void;
};

export function flushTimelineStore(target: TimelineTarget): void {
	if (target.transcriptFlushTimer) clearTimeout(target.transcriptFlushTimer);
	target.transcriptFlushTimer = undefined;
	if (!target.transcriptPending) return;
	const pending = target.transcriptPending;
	target.transcriptStore?.append({ ...pending, kind: pending.kind === "tool" ? "tool-result" : pending.kind });
	target.transcriptPending = undefined;
}

export function appendTimelineEvent(target: TimelineTarget, event: TimelineEntry): TimelineEntry {
	flushTimelineStore(target);
	// The live UI retains the legacy "tool" kind, but the durable transcript
	// accepts only start/result events; persist a generic tool row as a result.
	const safe = redactTimelineEvent({ ...event, kind: event.kind === "tool" ? "tool-result" : event.kind });
	target.transcriptStore?.append(safe);
	target.timeline.push({ ...safe, kind: event.kind, content: safe.content.slice(-MAX_LIVE_ENTRY_CHARS) });
	if (target.timeline.length > MAX_LIVE_TIMELINE_ENTRIES) target.timeline.splice(0, target.timeline.length - MAX_LIVE_TIMELINE_ENTRIES);
	return safe;
}

/** Safe System 1 metadata. Kind stays text; the title is the merge boundary. */
export function appendSystem1TimelineCard(target: TimelineTarget, content: string): TimelineEntry {
	return appendTimelineEvent(target, {
		kind: "text",
		title: SYSTEM1_CARD_TITLE,
		content,
		timestamp: Date.now(),
	});
}

export function appendTimelineText(target: TimelineTarget, kind: "text" | "thinking", delta: string): void {
	if (!delta) return;
	const safe = redactTimelineEvent({ kind, title: kind === "text" ? "Assistant" : "Thinking", content: delta, timestamp: Date.now() }) as TimelineEntry;
	if (target.transcriptPending?.kind === kind) target.transcriptPending.content += safe.content;
	else { flushTimelineStore(target); target.transcriptPending = { ...safe }; }
	if (!target.transcriptFlushTimer) {
		target.transcriptFlushTimer = setTimeout(() => { flushTimelineStore(target); target.zoomRender?.(); }, 100);
		try { (target.transcriptFlushTimer as any).unref?.(); } catch {}
	}
	let remaining = safe.content;
	while (remaining) {
		const last = target.timeline[target.timeline.length - 1];
		if (last && last.kind === kind && !isSystem1TimelineCard(last) && last.content.length < MAX_LIVE_ENTRY_CHARS) {
			const room = MAX_LIVE_ENTRY_CHARS - last.content.length;
			last.content += remaining.slice(0, room);
			remaining = remaining.slice(room);
		} else {
			target.timeline.push({ ...safe, content: remaining.slice(0, MAX_LIVE_ENTRY_CHARS) });
			remaining = remaining.slice(MAX_LIVE_ENTRY_CHARS);
		}
	}
	if (target.timeline.length > MAX_LIVE_TIMELINE_ENTRIES) target.timeline.splice(0, target.timeline.length - MAX_LIVE_TIMELINE_ENTRIES);
}
