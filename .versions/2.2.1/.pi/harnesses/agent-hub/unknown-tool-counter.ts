import { substituteForUnavailableTool, type ToolCatalogSnapshot } from "./tool-catalog-state.ts";

export const UNKNOWN_TOOL_COUNTER_SCHEMA = "agent-fleet.unknown-tool-counter/v1" as const;
export const UNKNOWN_TOOL_COUNTER_ENTRY_TYPE = "agent-hub-unknown-tool-counter";

export interface UnknownToolRefusalKey {
	taskId: string;
	tool: string;
	normalizedArgs: unknown;
	catalogVersion: string;
	prose?: string;
}

export interface UnknownToolCounterSnapshot {
	schema: typeof UNKNOWN_TOOL_COUNTER_SCHEMA;
	activeTaskId: string | null;
	counts: Array<{ taskId: string; tool: string; count: number; lastArgsIdentity: string; lastCatalogVersion: string }>;
}

const canonical = (value: unknown): string => {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
	return JSON.stringify(value);
};
const identity = (taskId: string, tool: string) => `${taskId.trim()}\0${tool.trim().toLowerCase()}`;

type Entry = { taskId: string; tool: string; count: number; lastArgsIdentity: string; lastCatalogVersion: string };

export function createUnknownToolCounter(options: { limit: number }, snapshot?: UnknownToolCounterSnapshot) {
	if (!Number.isInteger(options.limit) || options.limit < 1) throw new Error("unknown-tool refusal limit must be a positive integer");
	let activeTaskId = snapshot?.activeTaskId ?? null;
	const entries = new Map<string, Entry>();
	for (const item of snapshot?.counts ?? []) {
		if (!item.taskId?.trim() || !item.tool?.trim() || !Number.isInteger(item.count) || item.count < 0) continue;
		entries.set(identity(item.taskId, item.tool), { ...item, taskId: item.taskId.trim(), tool: item.tool.trim().toLowerCase() });
	}
	return {
		recordRefusal(key: UnknownToolRefusalKey) {
			const taskId = String(key.taskId ?? "").trim();
			const tool = String(key.tool ?? "").trim().toLowerCase();
			if (!taskId || !tool || !String(key.catalogVersion ?? "").trim()) throw new Error("unknown-tool refusal requires task, tool, and catalog identity");
			const mapKey = identity(taskId, tool);
			const previous = entries.get(mapKey);
			const argsIdentity = canonical(key.normalizedArgs);
			const priorCount = previous?.count ?? 0;
			const count = priorCount + 1;
			const reevaluatedAvailability = Boolean(previous && previous.lastCatalogVersion !== key.catalogVersion);
			const normalizedInputChanged = Boolean(previous && previous.lastArgsIdentity !== argsIdentity);
			entries.set(mapKey, { taskId, tool, count, lastArgsIdentity: argsIdentity, lastCatalogVersion: key.catalogVersion });
			activeTaskId = taskId;
			return { count, limit: options.limit, exhausted: count >= options.limit, reevaluatedAvailability, normalizedInputChanged, automaticRetry: false as const };
		},
		noteCompaction() { /* state is intentionally retained */ },
		noteModeSwitch(_mode: string) { /* mode is catalog evidence, not a reset */ },
		noteCatalogChange(_catalogVersion: string) { /* next refusal compares trusted identities */ },
		resetForNewTask(taskId: string) { entries.clear(); activeTaskId = String(taskId ?? "").trim() || null; },
		snapshot(): UnknownToolCounterSnapshot {
			return { schema: UNKNOWN_TOOL_COUNTER_SCHEMA, activeTaskId, counts: [...entries.values()].map(item => ({ ...item })).sort((a, b) => identity(a.taskId, a.tool).localeCompare(identity(b.taskId, b.tool))) };
		},
	};
}

export function latestPersistedUnknownToolCounter(entries: readonly unknown[]): UnknownToolCounterSnapshot | null {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index] as { type?: unknown; customType?: unknown; data?: { snapshot?: unknown } } | null;
		if (entry?.type !== "custom" || entry.customType !== UNKNOWN_TOOL_COUNTER_ENTRY_TYPE) continue;
		const snapshot = entry.data?.snapshot as UnknownToolCounterSnapshot | undefined;
		if (snapshot?.schema === UNKNOWN_TOOL_COUNTER_SCHEMA && Array.isArray(snapshot.counts)) return snapshot;
		return null;
	}
	return null;
}

export function observeUnknownToolCalls(input: {
	message: unknown;
	catalog: ToolCatalogSnapshot;
	taskId: string;
	counter: UnknownToolCounter;
	seenCallIds: Set<string>;
}) {
	const message = input.message as { role?: unknown; content?: unknown } | null;
	if (message?.role !== "assistant" || !Array.isArray(message.content)) return [];
	const active = new Set(input.catalog.tools.map(tool => tool.toLowerCase()));
	const diagnostics: Array<Record<string, unknown>> = [];
	for (const block of message.content as any[]) {
		if (!block || (block.type !== "toolCall" && block.type !== "tool_call" && block.type !== "tool-use" && block.type !== "tool_use")) continue;
		const tool = String(block.name ?? block.toolName ?? "").trim().toLowerCase();
		const callId = String(block.id ?? block.toolCallId ?? block.tool_call_id ?? "").trim();
		if (!tool || active.has(tool) || (callId && input.seenCallIds.has(callId))) continue;
		if (callId) input.seenCallIds.add(callId);
		const refusal = input.counter.recordRefusal({ taskId: input.taskId, tool, normalizedArgs: block.arguments ?? block.input ?? {}, catalogVersion: input.catalog.catalogVersion });
		const substitute = substituteForUnavailableTool(tool, input.catalog.tools);
		diagnostics.push({
			schema: "agent-fleet.unknown-tool-refusal/v1", status: "unknown_tool", recoveryCategory: "unknown_tool",
			taskId: input.taskId, tool, toolCallId: callId || null, count: refusal.count, limit: refusal.limit,
			exhausted: refusal.exhausted, catalogVersion: input.catalog.catalogVersion, effectiveTools: [...input.catalog.tools],
			substitute, permissionExpansion: false, automaticRetry: false,
			message: refusal.exhausted
				? `Unknown tool ${tool} refusal budget is exhausted for this task. Do not retry it; choose the listed active substitute only if it fits.`
				: `Unknown tool ${tool} was refused (${refusal.count}/${refusal.limit}). Use only the listed active substitute if it fits.`,
		});
	}
	return diagnostics;
}

export function unknownToolNotice(diagnostic: Record<string, unknown>): string {
	const substitute = (diagnostic.substitute as { tool?: string; limitation?: string } | null) ?? null;
	return `${String(diagnostic.message ?? "Unknown tool was refused.")}${substitute?.tool ? ` Valid active substitute: ${substitute.tool}. ${substitute.limitation ?? "No unavailable permission is restored."}` : " No valid substitute is active."} No automatic retry was performed.`;
}

export function restoreUnknownToolCounter(snapshot: UnknownToolCounterSnapshot, options: { limit: number }) {
	if (snapshot?.schema !== UNKNOWN_TOOL_COUNTER_SCHEMA || !Array.isArray(snapshot.counts)) throw new Error("invalid unknown-tool counter snapshot");
	return createUnknownToolCounter(options, snapshot);
}

export type UnknownToolCounter = ReturnType<typeof createUnknownToolCounter>;
