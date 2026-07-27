// Pure state helpers for the btw extension. Keep this file free of pi runtime imports so
// behavior that affects retention, elapsed timing, and transcript bounds stays testable
// with `node --test .pi/extensions/btw/state.test.js`.

export const MAX_RETAINED_TERMINAL_THREADS = 12;
export const MAX_TIMELINE_ENTRIES = 200;
export const MAX_TIMELINE_ENTRY_CHARS = 12_000;
export const MAX_SELECTED_MARKDOWN_CHARS = 20_000;
export const CARD_PREVIEW_LINES = 6;
export const CARD_PREVIEW_LINE_CHARS = 240;

export const TIMELINE_TRUNCATION_MARKER = "\n… [truncated]";
export const MODAL_TRUNCATION_MARKER = "\n… [truncated for modal]";

export function isTerminalStatus(status) {
	return status === "done" || status === "error";
}

export function beginTurn(thread, now) {
	return {
		...thread,
		status: "running",
		turnStartedAt: now,
		turnFinishedAt: undefined,
	};
}

export function steerTurn(thread) {
	return {
		...thread,
		status: "running",
	};
}

export function finishTurn(thread, now, status = thread.status) {
	return {
		...thread,
		status,
		turnFinishedAt: now,
	};
}

export function turnElapsedMs(thread, now = Date.now()) {
	if (typeof thread.turnStartedAt !== "number") return 0;
	const end = typeof thread.turnFinishedAt === "number" ? thread.turnFinishedAt : now;
	return Math.max(0, end - thread.turnStartedAt);
}

export function truncateText(text, maxChars, marker = TIMELINE_TRUNCATION_MARKER) {
	const value = typeof text === "string" ? text : text == null ? "" : String(text);
	if (value.length <= maxChars) return value;
	if (maxChars <= 0) return "";
	if (marker.length >= maxChars) return marker.slice(0, maxChars);
	return value.slice(0, maxChars - marker.length) + marker;
}

export function formatBtwCardPreview(text, lines = CARD_PREVIEW_LINES, maxLineChars = CARD_PREVIEW_LINE_CHARS) {
	const value = typeof text === "string" ? text : text == null ? "" : String(text);
	const parts = value.split("\n");
	const head = parts
		.slice(0, lines)
		.map((line) => truncateText(line, maxLineChars, "…"))
		.join("\n");
	return parts.length > lines ? `${head}\n…` : head;
}

export function formatBtwResultMarkdown({ note, ok, elapsedMs, sessionFile, answer }) {
	return `# btw result\n\n- task: ${note}\n- ok: ${ok}\n- elapsed: ${Math.round(elapsedMs / 1000)}s\n- session: ${sessionFile}\n\n---\n\n${answer}\n`;
}

export function capTimelineContent(content) {
	return truncateText(content, MAX_TIMELINE_ENTRY_CHARS, TIMELINE_TRUNCATION_MARKER);
}

export function capSelectedMarkdown(content) {
	return truncateText(content, MAX_SELECTED_MARKDOWN_CHARS, MODAL_TRUNCATION_MARKER);
}

function normalizeEntry(entry, now) {
	return {
		...entry,
		content: capTimelineContent(entry.content ?? ""),
		timestamp: typeof entry.timestamp === "number" ? entry.timestamp : now,
	};
}

export function pruneTimeline(timeline, maxEntries = MAX_TIMELINE_ENTRIES) {
	const overflow = Math.max(0, timeline.length - maxEntries);
	return {
		timeline: overflow > 0 ? timeline.slice(overflow) : timeline,
		prunedCount: overflow,
	};
}

export function appendTimelineEntry(timeline, entry, now = Date.now(), maxEntries = MAX_TIMELINE_ENTRIES) {
	return pruneTimeline([...timeline, normalizeEntry(entry, now)], maxEntries);
}

export function appendTimelineDelta(timeline, kind, delta, now = Date.now(), maxEntries = MAX_TIMELINE_ENTRIES) {
	if (!delta) return { timeline, prunedCount: 0 };
	const next = timeline.slice();
	const last = next[next.length - 1];
	if (last && last.kind === kind) {
		next[next.length - 1] = {
			...last,
			content: capTimelineContent(`${last.content ?? ""}${delta}`),
		};
	} else {
		next.push(normalizeEntry({ kind, title: kind === "text" ? "Assistant" : "Thinking", content: delta }, now));
	}
	return pruneTimeline(next, maxEntries);
}

function statusFor(statusById, id) {
	if (statusById instanceof Map) return statusById.get(id);
	return statusById?.[id];
}

export function planTerminalRetention(order, statusById, maxRetained = MAX_RETAINED_TERMINAL_THREADS) {
	const terminalIds = order.filter((id) => isTerminalStatus(statusFor(statusById, id)));
	const evictCount = Math.max(0, terminalIds.length - maxRetained);
	const evictedIds = terminalIds.slice(0, evictCount);
	if (evictedIds.length === 0) return { evictedIds, order: order.slice() };
	const evicted = new Set(evictedIds);
	return {
		evictedIds,
		order: order.filter((id) => !evicted.has(id)),
	};
}

export function mostRecentThreadId(order) {
	return order.length > 0 ? order[order.length - 1] : undefined;
}

export function resolveThreadId(preferredId, order) {
	return preferredId && order.includes(preferredId) ? preferredId : mostRecentThreadId(order);
}

export function reconcileThreadView({ order, lastViewedId, currentId }) {
	return {
		lastViewedId: resolveThreadId(lastViewedId, order),
		currentId: currentId === undefined ? undefined : resolveThreadId(currentId, order),
	};
}

function clamp(value, min, max) {
	return Math.min(max, Math.max(min, Number.isFinite(value) ? Math.trunc(value) : min));
}

export function clampModalView(view, itemCount, rows) {
	const count = Math.max(0, Math.trunc(itemCount || 0));
	const page = Math.max(1, Math.floor((rows || 1) / 3));
	const maxIndex = Math.max(0, count - 1);
	const followTail = Boolean(view.followTail);
	let selectedIndex = followTail && count > 0 ? maxIndex : clamp(view.selectedIndex ?? 0, 0, maxIndex);
	let scrollOffset = clamp(view.scrollOffset ?? 0, 0, Math.max(0, count - page));

	if (count === 0) {
		return { ...view, selectedIndex: 0, scrollOffset: 0, followTail };
	}
	if (selectedIndex < scrollOffset) scrollOffset = selectedIndex;
	else if (selectedIndex >= scrollOffset + page) scrollOffset = selectedIndex - page + 1;
	scrollOffset = clamp(scrollOffset, 0, Math.max(0, count - page));

	return { ...view, selectedIndex, scrollOffset, followTail };
}

export function shiftModalViewForPrunedEntries(view, prunedCount, itemCount, rows) {
	const n = Math.max(0, Math.trunc(prunedCount || 0));
	return clampModalView(
		{
			...view,
			selectedIndex: Math.max(0, (view.selectedIndex ?? 0) - n),
			scrollOffset: Math.max(0, (view.scrollOffset ?? 0) - n),
		},
		itemCount,
		rows,
	);
}
