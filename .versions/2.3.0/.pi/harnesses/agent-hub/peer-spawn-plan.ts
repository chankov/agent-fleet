import {
	buildPeerLaunchPlan,
	type PeerLaunchContext,
	type PeerLaunchPlan,
} from "../../agent-fleet/scripts/lib/peer-launch.ts";
import { launchPeerInPane, peerReadyVerdict } from "../lib/spawned-peers.js";
import type { HerdrSpawnPeerParams } from "./tools/context.ts";

/**
 * The herdr_spawn_peer parameters: the `just fleet peer <name>` flags the
 * model may choose (PLAN-11-01, D16). Every Pi peer loads chrome-devtools-mcp
 * and a read-only one loads no extension (D17), so there is no extension
 * choice. `--env-file`, `--project`, placement and raw Pi argv stay out of the
 * model's reach: an env file can carry secrets that zero-access rules protect,
 * the project is the Hub's own, and the pane is always a sibling split.
 *
 * One shape, declared in tools/context.ts: that module is the dependency-free
 * leaf every tool imports its parameter types from, so it must not import this
 * launcher adapter (and through it the Fleet launch scripts).
 */
export type HubPeerSpawnRequest = HerdrSpawnPeerParams;

export interface HubPeerSpawnContext extends PeerLaunchContext {
	/** The current Hub/coms project. The request cannot override it. */
	project: string;
}

/** Constrained Agent Hub adapter for the canonical Fleet peer resolver. */
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
			...(request.read_only ? { readOnly: true } : {}),
			...(request.direction ? { direction: request.direction } : {}),
			project: context.project,
			here: false,
		},
		{ personaExists: context.personaExists, worktreeTag: context.worktreeTag },
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
	const env = { ...options.env, AGENT_FLEET_AGENTIC_CHILD: '1' };
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
