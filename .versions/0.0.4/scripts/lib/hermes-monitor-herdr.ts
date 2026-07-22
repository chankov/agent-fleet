import { herdr, subscribe, type HerdrClientOptions, type SubscribeHandle } from "../../.pi/harnesses/lib/herdr-client.ts";

export interface HubCorrelation { workspaceId?: string; hubPaneId?: string; status: "correlated" | "uncorrelated" | "reconnecting"; }

export async function correlateHubPane(env: NodeJS.ProcessEnv = process.env, opts: HerdrClientOptions = {}): Promise<HubCorrelation> {
 const hubPaneId = env.HERDR_PANE_ID;
 if (env.HERDR_ENV !== "1" || !hubPaneId) return { status: "uncorrelated" };
 try { const { pane } = await herdr.paneGet(hubPaneId, { socketPath: env.HERDR_SOCKET_PATH, ...opts }); return { workspaceId: pane.workspace_id, hubPaneId, status: "correlated" }; }
 catch { return { hubPaneId, status: "reconnecting" }; }
}

export function watchHubMonitor(options: { env?: NodeJS.ProcessEnv; onStatus: (value: HubCorrelation) => void; onOutput?: (output: { sequence: number; text: string }) => void; initialCursor?: number; reconnectDelayMs?: number }): SubscribeHandle | null {
 const env = options.env ?? process.env;
 const paneId = env.HERDR_PANE_ID;
 if (env.HERDR_ENV !== "1" || !paneId) { options.onStatus({ status: "uncorrelated" }); return null; }
 let cursor = options.initialCursor ?? 0;
 const refresh = async () => {
  try {
   const { pane } = await herdr.paneGet(paneId, { socketPath: env.HERDR_SOCKET_PATH });
   options.onStatus({ workspaceId: pane.workspace_id, hubPaneId: paneId, status: "correlated" });
   const output = (pane as { monitor_resync_output?: { sequence?: number; text?: string } }).monitor_resync_output;
   if (output && typeof output.sequence === "number" && output.sequence > cursor && typeof output.text === "string") { cursor = output.sequence; options.onOutput?.({ sequence: output.sequence, text: output.text }); }
  } catch { options.onStatus({ hubPaneId: paneId, status: "reconnecting" }); }
 };
 void refresh();
 let connected = false;
 return subscribe([{ type: "pane.agent_status_changed", pane_id: paneId }], () => void refresh(), { socketPath: env.HERDR_SOCKET_PATH, reconnectDelayMs: options.reconnectDelayMs, onConnect: () => { if (connected) options.onStatus({ hubPaneId: paneId, status: "reconnecting" }); connected = true; void refresh(); }, onError: () => options.onStatus({ hubPaneId: paneId, status: "reconnecting" }) });
}
