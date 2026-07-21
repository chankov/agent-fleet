import {
	type CreateChildTaskInput,
	type CreateParentTaskInput,
	type MonitorTask,
} from "../../../scripts/lib/hermes-monitor-model.ts";
import { MonitorStore, type MonitorOutput } from "../../../scripts/lib/hermes-monitor-store.ts";
import { correlateHubPane } from "../../../scripts/lib/hermes-monitor-herdr.ts";

export interface ViewerGatedMonitor {
	setViewers(count: number): void;
	stop(): void;
}

export function createViewerGatedMonitor(options: {
	pollMetadata: () => Promise<Array<{ id: string; generation: number; outputSequence: number }>>;
	fetchOutput: (id: string, generation: number, afterSequence: number) => Promise<{ sequence: number }>;
	intervalMs?: number;
}): ViewerGatedMonitor {
	const cursors = new Map<string, number>();
	let viewers = 0;
	let timer: ReturnType<typeof setInterval> | null = null;
	const poll = async () => {
		if (viewers === 0) return;
		for (const row of await options.pollMetadata()) {
			const key = `${row.id}:${row.generation}`;
			const cursor = cursors.get(key) ?? 0;
			if (row.outputSequence > cursor) cursors.set(key, (await options.fetchOutput(row.id, row.generation, cursor)).sequence);
		}
	};
	return { setViewers(count) { viewers = Math.max(0, count); if (viewers > 0 && !timer) timer = setInterval(() => void poll(), options.intervalMs ?? 1000); if (viewers === 0 && timer) { clearInterval(timer); timer = null; } }, stop() { viewers = 0; if (timer) clearInterval(timer); timer = null; } };
}

// Agent Fleet-owned publishing seam. Hub lifecycle wiring is added in later slices.
export class MonitorPublisher {
	private readonly store: MonitorStore;

	constructor(store: MonitorStore) {
		this.store = store;
	}

	publishParent(input: CreateParentTaskInput): MonitorTask {
		return this.store.createParent(input);
	}

	publishChild(input: CreateChildTaskInput): MonitorTask {
		return this.store.createChild(input);
	}

	async publishChildForHub(input: CreateChildTaskInput, env: NodeJS.ProcessEnv = process.env): Promise<MonitorTask> {
		const correlation = await correlateHubPane(env);
		return this.publishChild({ ...input, workspaceId: correlation.workspaceId ?? input.workspaceId, hubPaneId: correlation.hubPaneId ?? input.hubPaneId });
	}

	transition(id: string, generation: number, state: any): MonitorTask { return this.store.transition(id, generation, state); }

	publishPublicOutput(id: string, generation: number, text: string): MonitorOutput {
		return this.store.appendPublicOutput(id, generation, text);
	}
}
