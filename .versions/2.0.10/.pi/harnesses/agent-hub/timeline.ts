import { redactTimelineEvent, type FleetTranscriptStore } from "../lib/fleet-transcript-store.ts";
import type { TimelineEntry } from "./ui/zoom.ts";

const MAX_LIVE_TIMELINE_ENTRIES = 500;
export const MAX_LIVE_ENTRY_CHARS = 64 * 1024;

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
	target.transcriptStore?.append(target.transcriptPending as any);
	target.transcriptPending = undefined;
}

export function appendTimelineEvent(target: TimelineTarget, event: TimelineEntry): TimelineEntry {
	flushTimelineStore(target);
	const safe = redactTimelineEvent(event) as TimelineEntry;
	target.transcriptStore?.append(safe as any);
	target.timeline.push({ ...safe, content: safe.content.slice(-MAX_LIVE_ENTRY_CHARS) });
	if (target.timeline.length > MAX_LIVE_TIMELINE_ENTRIES) target.timeline.splice(0, target.timeline.length - MAX_LIVE_TIMELINE_ENTRIES);
	return safe;
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
		if (last && last.kind === kind && last.content.length < MAX_LIVE_ENTRY_CHARS) {
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
