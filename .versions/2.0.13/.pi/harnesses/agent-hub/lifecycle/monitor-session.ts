import type { ChildProcess } from "child_process";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { killPiTree } from "../spawn.ts";
import { createMonitorLifecycle, monitorLifecycleConfig } from "../monitor-lifecycle.ts";
import { createMonitorSessionBridge } from "../monitor-session-bridge.ts";
import { MonitorRuntime } from "../monitor-runtime.ts";
import { MonitorInvokeJournal } from "../monitor-invoke-journal.ts";
import { createMonitorInvokeAdmission, createWatchdogFollowUpEnqueue } from "../monitor-invoke.ts";
import { monitorReconcileEvidence, stableMonitorHubId } from "../monitor-recovery.ts";
import { MonitorRegistry } from "../../lib/hermes-monitor-registry.ts";
import { MonitorStore } from "../../lib/hermes-monitor-store.ts";
import { MonitorEventJournal } from "../../lib/hermes-monitor-events.ts";
import { herdr as herdrApi } from "../../lib/herdr-client.ts";

export interface MonitorSessionPorts {
	pi: ExtensionAPI;
	getBridge(): any;
	setBridge(value: any): void;
	getLifecycle(): any;
	setLifecycle(value: any): void;
	setHubId(value: string): void;
	getOwnerId(): string | undefined;
	setOwnerId(value: string | undefined): void;
	queueDepth(): number;
}

async function herdrEvidence(hubId: string, currentHubId: string) {
	return monitorReconcileEvidence({
		hubId, currentHubId, paneId: process.env.HERDR_PANE_ID, workspaceId: process.env.HERDR_WORKSPACE_ID,
		herdr: {
			pane: { get: async (id: string) => (await herdrApi.paneGet(id)).pane },
			workspace: { get: async (id: string) => {
				const panes = await herdrApi.paneList({ workspace_id: id });
				return panes.panes.length ? { id } : null;
			} },
		},
	});
}

export function createMonitorSession(ports: MonitorSessionPorts) {
	return {
		async restart(ctx: ExtensionContext): Promise<void> {
			const config = monitorLifecycleConfig(process.env);
			if (ports.getBridge() || ports.getLifecycle()) {
				try { await ports.getBridge()?.cancelAllWaitOnly(); await ports.getLifecycle()?.stop(); }
				finally { ports.setBridge(null); ports.setLifecycle(null); }
			}
			if (!config) return;
			try {
				fs.mkdirSync(config.profilePath, { recursive: true, mode: 0o700 });
				const hubId = stableMonitorHubId({ profileId: config.profileId, checkout: ctx.cwd || process.cwd(), workspaceId: process.env.HERDR_WORKSPACE_ID, paneId: process.env.HERDR_PANE_ID });
				ports.setHubId(hubId);
				new MonitorStore();
				const registry = new MonitorRegistry({ runtimeDir: config.runtimeDir });
				const lifecycle = createMonitorLifecycle({
					registry, treeKill: killPiTree,
					wait: (proc: ChildProcess) => new Promise<boolean>(resolve => proc.once("close", () => resolve(true))),
					getRecoveryEvidence: async (task: any) => {
						if (!task?.ownerSessionId) return herdrEvidence(hubId, hubId);
						const evidence = registry.evidenceForOwner(task.ownerSessionId, task.hubInstanceId ?? hubId);
						if (evidence.transient) return { transient: true };
						const reconciled = await herdrEvidence(task.hubInstanceId ?? hubId, hubId);
						return { oldOwner: evidence.owner, oldSocket: evidence.socket, oldSession: evidence.session, oldHerdr: reconciled.herdr, transient: reconciled.transient };
					},
				});
				ports.setLifecycle(lifecycle);
				const events = new MonitorEventJournal({ file: path.join(config.runtimeDir, `monitor-events-${hubId}.ndjson`) });
				const journal = new MonitorInvokeJournal(path.join(config.runtimeDir, `monitor-invokes-${hubId}.ndjson`));
				const bridge = createMonitorSessionBridge({
					events, hubInstanceId: hubId,
					onEventJournalError: (error: unknown) => ctx.ui.notify(`Agent Fleet monitor event journal unavailable: ${error instanceof Error ? error.message : String(error)}`, "warning"),
					runtime: new MonitorRuntime({ runtimeDir: config.runtimeDir, profileId: config.profileId, hubInstanceId: hubId }),
					registerOwnedProcess: (_key: string, process: ChildProcess, task: any) => lifecycle.registerOwnedGeneration({ taskId: task.id, generation: task.generation, process }),
					cancelOwnedProcess: (request: any) => lifecycle.lowLevelCancelOwnedGeneration(request),
				});
				ports.setBridge(bridge);
				const invoke = createMonitorInvokeAdmission({
					journal, task: (id: string, generation: number) => bridge.snapshot().tasks.find((task: any) => task.id === id && task.generation === generation),
					owner: ports.getOwnerId, queueDepth: ports.queueDepth, queueLimit: 64,
					enqueue: createWatchdogFollowUpEnqueue((message, options) => ports.pi.sendMessage(message, options)),
					publish: (kind: any, task: any, extra?: any) => bridge.publishEvent(kind, task, extra),
				});
				const registration = await lifecycle.startBridge(bridge, {
					profilePath: config.profilePath, profileId: config.profileId, hubInstanceId: hubId,
					events: (request: any) => events.replay(request.afterSequence, request.limit, request.waitMs, request.signal), invoke,
				});
				ports.setOwnerId(registration?.ownerId);
			} catch (error) {
				ports.setLifecycle(null);
				ctx.ui.notify(`Agent Fleet monitor disabled: ${error instanceof Error ? error.message : String(error)}`, "warning");
			}
		},
		async shutdown(): Promise<void> {
			const bridge = ports.getBridge();
			if (bridge) try { await bridge.cancelAllWaitOnly(); } catch {}
			const lifecycle = ports.getLifecycle();
			if (lifecycle) try { await lifecycle.stop(); } catch {}
			ports.setLifecycle(null);
			bridge?.reset(); bridge?.stop(); ports.setBridge(null);
		},
	};
}
