import {
	buildPeerLaunchPlan,
	type PeerLaunchContext,
	type PeerLaunchPlan,
	type PeerRunner,
} from "../../../scripts/lib/peer-launch.ts";
import { launchPeerInPane, peerReadyVerdict } from "../lib/spawned-peers.js";

export interface HubPeerSpawnRequest {
	name: string;
	runner?: PeerRunner;
	persona?: string;
	no_persona?: boolean;
	model?: string;
	extensions?: string;
	browser?: boolean;
	all_extensions?: boolean;
	direction?: "right" | "down";
}

export interface HubPeerSpawnContext extends PeerLaunchContext {
	/** The current Hub/coms project. The request cannot override it. */
	project: string;
}

/**
 * Constrained Agent Hub adapter for the canonical Fleet peer resolver.
 * Project, placement, env-file source, and raw Pi argv are not LLM-controlled:
 * the project comes from the Hub identity and envFile can only come back from
 * a validated peers.yaml declaration inside buildPeerLaunchPlan().
 */
export function buildHubPeerSpawnPlan(
	request: HubPeerSpawnRequest,
	context: HubPeerSpawnContext,
): PeerLaunchPlan {
	return buildPeerLaunchPlan(
		{
			name: request.name,
			...(request.runner ? { runner: request.runner } : {}),
			...(request.persona ? { persona: request.persona } : {}),
			...(request.no_persona ? { noPersona: true } : {}),
			...(request.model ? { model: request.model } : {}),
			...(request.extensions ? { extensions: request.extensions } : {}),
			...(request.browser ? { browser: true } : {}),
			...(request.all_extensions ? { allExtensions: true } : {}),
			...(request.direction ? { direction: request.direction } : {}),
			project: context.project,
			here: false,
		},
		context,
	);
}

interface HubPeerPaneClient {
	paneSplit(params: {
		target_pane_id: string;
		direction: "right" | "down";
		cwd: string;
		env?: Record<string, string>;
		focus: boolean;
	}): Promise<{ pane: { pane_id: string } }>;
	paneRename(paneId: string, label: string): Promise<unknown>;
	paneRead(params: { pane_id: string; lines: number }): Promise<{ read: { text?: string } }>;
	paneSendText(paneId: string, text: string): Promise<unknown>;
	paneSendKeys(paneId: string, keys: string[]): Promise<unknown>;
}

export interface HubPeerPaneLaunchOptions {
	client: HubPeerPaneClient;
	targetPaneId: string;
	cwd: string;
	env?: Record<string, string>;
	waitForRegistration(name: string): Promise<{ found: boolean; waitedMs: number }>;
	paneTail(paneId: string): Promise<string>;
	onLaunched?(paneId: string): void;
}

/** Split next to the Hub, type the canonical argv, then return readiness proof. */
export async function launchHubPeerInPane(
	plan: PeerLaunchPlan,
	options: HubPeerPaneLaunchOptions,
): Promise<{
	paneId: string;
	promptSeen: boolean;
	promptWaitedMs: number;
	verdict: ReturnType<typeof peerReadyVerdict>;
}> {
	const env = options.env ?? {};
	const { pane } = await options.client.paneSplit({
		target_pane_id: options.targetPaneId,
		direction: plan.direction,
		cwd: options.cwd,
		...(Object.keys(env).length > 0 ? { env } : {}),
		focus: false,
	});
	try {
		await options.client.paneRename(pane.pane_id, plan.name);
	} catch {
		// A label is cosmetic; the pane id and coms identity remain authoritative.
	}
	const launch = await launchPeerInPane(options.client, pane.pane_id, plan.command);
	options.onLaunched?.(pane.pane_id);
	const readiness = await options.waitForRegistration(plan.name);
	const tail = readiness.found ? undefined : await options.paneTail(pane.pane_id);
	return {
		paneId: pane.pane_id,
		promptSeen: launch.promptSeen,
		promptWaitedMs: launch.waitedMs,
		verdict: peerReadyVerdict({
			name: plan.name,
			paneId: pane.pane_id,
			...readiness,
			...(tail === undefined ? {} : { paneTail: tail }),
		}),
	};
}
