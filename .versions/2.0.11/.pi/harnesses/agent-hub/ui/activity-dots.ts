/** Cycle 1–5 ASCII periods from a 1-based event count. Zero events → empty. */
export function activityDots(eventCount: number): string {
	if (eventCount <= 0) return "";
	return ".".repeat(((eventCount - 1) % 5) + 1);
}

export function eventCount(toolCount: number, messageCount: number): number {
	return Math.max(0, toolCount) + Math.max(0, messageCount);
}

/** Call before appending a text timeline delta so each assistant message counts once. */
export function bumpMessageCount(target: { timeline: Array<{ kind: string }>; messageCount: number }, kind: "text" | "thinking"): void {
	if (kind !== "text") return;
	const last = target.timeline[target.timeline.length - 1];
	if (!last || last.kind !== "text") target.messageCount++;
}
