/** Cycle 1–5 ASCII periods from a 1-based event count. Zero events → empty. */
export function activityDots(eventCount: number): string {
	if (eventCount <= 0) return "";
	return ".".repeat(((eventCount - 1) % 5) + 1);
}

export function eventCount(toolCount: number, messageCount: number): number {
	return Math.max(0, toolCount) + Math.max(0, messageCount);
}

function previousWorkerKind(timeline: Array<{ kind: string; title?: string }>): string | undefined {
	for (let index = timeline.length - 1; index >= 0; index--) {
		const entry = timeline[index];
		if (entry.kind === "text" && entry.title === "System 1") continue;
		return entry.kind;
	}
	return undefined;
}

/** Call before appending a text timeline delta so each assistant message counts once. */
export function bumpMessageCount(target: { timeline: Array<{ kind: string; title?: string }>; messageCount: number }, kind: "text" | "thinking"): void {
	if (kind !== "text") return;
	const last = previousWorkerKind(target.timeline);
	if (!last || last !== "text") target.messageCount++;
}
