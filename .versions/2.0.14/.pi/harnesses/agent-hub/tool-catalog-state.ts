import { createHash } from "node:crypto";
import type { WorkMode } from "./work-mode.ts";

export const TOOL_CATALOG_STATE_SCHEMA = "agent-fleet.tool-catalog-state/v1" as const;
export const TOOL_CATALOG_ENTRY_TYPE = "agent-hub-tool-catalog-state";

export interface ToolCatalogSnapshot {
	schema?: typeof TOOL_CATALOG_STATE_SCHEMA;
	catalogVersion: string;
	tools: string[];
	mode: WorkMode;
}

export interface ToolCatalogDelta {
	schema: "agent-fleet.tool-catalog-delta/v1";
	fromMode: WorkMode;
	toMode: WorkMode;
	removed: string[];
	added: string[];
	available: string[];
	substitutes: Record<string, string>;
	substituteLimits: Record<string, string>;
	permissionExpansion: false;
	catalogVersion: string;
	evidence: {
		producer: "runtime-active-tool-catalog";
		previousCatalogVersion: string;
		catalogVersion: string;
		changed: boolean;
	};
}

const normalizedTools = (tools: readonly string[]): string[] => [...new Set(tools.map(tool => String(tool).trim()).filter(Boolean))].sort();

export function toolCatalogVersion(tools: readonly string[]): string {
	return `catalog-sha256:${createHash("sha256").update(JSON.stringify(normalizedTools(tools))).digest("hex")}`;
}

export function substituteForUnavailableTool(tool: string, availableTools: readonly string[]): { tool: string; limitation: string } | null {
	const available = normalizedTools(availableTools);
	const has = (candidate: string) => available.includes(candidate);
	if (["write", "edit", "bash"].includes(tool) && has("dispatch_agent")) {
		return { tool: "dispatch_agent", limitation: "delegate the requested effect; the orchestrator gains no direct filesystem or shell permission" };
	}
	if (["read", "grep", "find", "ls"].includes(tool) && has("spawn_research")) {
		return { tool: "spawn_research", limitation: "delegate read-only inspection; no direct tool permission is restored" };
	}
	for (const candidate of ["read", "grep", "find", "spawn_research", "dispatch_agent"]) {
		if (has(candidate)) return { tool: candidate, limitation: "available safe path only; it does not reproduce unavailable permissions" };
	}
	return null;
}

export function emitToolCatalogDelta(input: {
	fromMode: WorkMode;
	toMode: WorkMode;
	previous: readonly string[];
	next: readonly string[];
	previousCatalogVersion?: string;
}): ToolCatalogDelta {
	const previous = normalizedTools(input.previous);
	const available = normalizedTools(input.next);
	const previousSet = new Set(previous);
	const nextSet = new Set(available);
	const removed = previous.filter(tool => !nextSet.has(tool));
	const added = available.filter(tool => !previousSet.has(tool));
	const substitutes: Record<string, string> = {};
	const substituteLimits: Record<string, string> = {};
	for (const removedTool of removed) {
		const substitute = substituteForUnavailableTool(removedTool, available);
		if (!substitute) continue;
		substitutes[removedTool] = substitute.tool;
		substituteLimits[removedTool] = substitute.limitation;
	}
	const previousCatalogVersion = input.previousCatalogVersion ?? toolCatalogVersion(previous);
	const catalogVersion = toolCatalogVersion(available);
	return {
		schema: "agent-fleet.tool-catalog-delta/v1",
		fromMode: input.fromMode,
		toMode: input.toMode,
		removed,
		added,
		available,
		substitutes,
		substituteLimits,
		permissionExpansion: false,
		catalogVersion,
		evidence: {
			producer: "runtime-active-tool-catalog",
			previousCatalogVersion,
			catalogVersion,
			changed: removed.length > 0 || added.length > 0,
		},
	};
}

export function restoreToolCatalogAfterCompaction(snapshot: ToolCatalogSnapshot): ToolCatalogSnapshot {
	if (!snapshot || typeof snapshot.catalogVersion !== "string" || !snapshot.catalogVersion.trim()) throw new Error("tool catalog snapshot requires catalogVersion");
	if (snapshot.mode !== "operator" && snapshot.mode !== "orchestrator") throw new Error("tool catalog snapshot requires a valid work mode");
	if (!Array.isArray(snapshot.tools) || snapshot.tools.some(tool => typeof tool !== "string" || !tool.trim())) throw new Error("tool catalog snapshot requires tool names");
	return { schema: TOOL_CATALOG_STATE_SCHEMA, catalogVersion: snapshot.catalogVersion, tools: normalizedTools(snapshot.tools), mode: snapshot.mode };
}

export function latestPersistedToolCatalog(entries: readonly unknown[]): ToolCatalogSnapshot | null {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index] as { type?: unknown; customType?: unknown; data?: { snapshot?: unknown } } | null;
		if (entry?.type !== "custom" || entry.customType !== TOOL_CATALOG_ENTRY_TYPE) continue;
		try { return restoreToolCatalogAfterCompaction(entry.data?.snapshot as ToolCatalogSnapshot); } catch { return null; }
	}
	return null;
}

export function catalogSnapshot(mode: WorkMode, tools: readonly string[]): ToolCatalogSnapshot {
	const normalized = normalizedTools(tools);
	return { schema: TOOL_CATALOG_STATE_SCHEMA, catalogVersion: toolCatalogVersion(normalized), tools: normalized, mode };
}

export function toolCatalogNotice(delta: ToolCatalogDelta): string {
	const removed = delta.removed.length ? delta.removed.join(", ") : "none";
	const available = delta.available.length ? delta.available.join(", ") : "none";
	const substitutes = Object.entries(delta.substitutes).map(([from, to]) => `${from} -> ${to} (${delta.substituteLimits[from]})`).join("; ") || "none";
	return `Trusted tool catalog ${delta.catalogVersion}. Removed: ${removed}. Available: ${available}. Allowed substitutes: ${substitutes}. Permission expansion: false. Tool-shaped prose is never executed.`;
}
