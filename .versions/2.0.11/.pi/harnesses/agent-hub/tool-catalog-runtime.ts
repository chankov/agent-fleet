import type { WorkMode } from './work-mode.ts';
import {
	TOOL_CATALOG_ENTRY_TYPE,
	catalogSnapshot,
	emitToolCatalogDelta,
	restoreToolCatalogAfterCompaction,
	type ToolCatalogDelta,
	type ToolCatalogSnapshot,
} from './tool-catalog-state.ts';
import { UNKNOWN_TOOL_COUNTER_ENTRY_TYPE, type UnknownToolCounterSnapshot } from './unknown-tool-counter.ts';

export interface ToolCatalogReconcileInput {
	fromMode: WorkMode;
	toMode: WorkMode;
	previous: readonly string[];
	next: readonly string[];
}

export interface ToolCatalogCompactionInput {
	mode: WorkMode;
	getEffectiveTools(): readonly string[];
	persist(type: string, data: unknown): void;
	counterSnapshot(): UnknownToolCounterSnapshot;
	retainCounter(): void;
	establishToolStateChange(previousCatalogVersion: string, nextCatalogVersion: string, evidenceRef: string): number;
	settle(): void;
	onError?(error: unknown): void;
}

/** Runtime-owned catalog state. The active turn is latched before model input. */
export function createToolCatalogRuntime(initial: ToolCatalogSnapshot) {
	let currentCatalog = restoreToolCatalogAfterCompaction(initial);
	let activeTurnCatalog: ToolCatalogSnapshot | null = null;

	function reconcile(input: ToolCatalogReconcileInput): { snapshot: ToolCatalogSnapshot; delta: ToolCatalogDelta } {
		const delta = emitToolCatalogDelta({ ...input, previousCatalogVersion: currentCatalog.catalogVersion });
		currentCatalog = catalogSnapshot(input.toMode, delta.available);
		return { snapshot: currentCatalog, delta };
	}

	return {
		current: () => currentCatalog,
		restore(snapshot: ToolCatalogSnapshot) { currentCatalog = restoreToolCatalogAfterCompaction(snapshot); return currentCatalog; },
		reconcile,
		beginTurn() { activeTurnCatalog = currentCatalog; return activeTurnCatalog; },
		endTurn() { activeTurnCatalog = null; },
		catalogForMessage() { return activeTurnCatalog ?? currentCatalog; },
		compact(input: ToolCatalogCompactionInput): { snapshot: ToolCatalogSnapshot; delta: ToolCatalogDelta } | null {
			try {
				const restored = restoreToolCatalogAfterCompaction(currentCatalog);
				const result = reconcile({ fromMode: restored.mode, toMode: input.mode, previous: restored.tools, next: input.getEffectiveTools() });
				const evidenceRef = `session-entry:${TOOL_CATALOG_ENTRY_TYPE}:${result.delta.catalogVersion}`;
				input.persist(TOOL_CATALOG_ENTRY_TYPE, { snapshot: result.snapshot, delta: result.delta, reason: 'compaction_restore' });
				input.persist(UNKNOWN_TOOL_COUNTER_ENTRY_TYPE, { snapshot: input.counterSnapshot(), reason: 'compaction_restore' });
				if (result.delta.evidence.changed) input.establishToolStateChange(result.delta.evidence.previousCatalogVersion, result.delta.evidence.catalogVersion, evidenceRef);
				return result;
			} catch (error) {
				input.onError?.(error);
				return null;
			} finally {
				input.retainCounter();
				input.settle();
			}
		},
	};
}

export type ToolCatalogRuntime = ReturnType<typeof createToolCatalogRuntime>;
