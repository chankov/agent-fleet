import { PANE_PROMPT_TIMEOUT_MS, launchPeerInPane } from "../../lib/spawned-peers.js";
import { herdrPaneId } from "../../lib/herdr-presence.ts";
import { buildHubPeerSpawnPlan, launchHubPeerInPane } from "../peer-spawn-plan.ts";
import { paneTail, peerManifest, peerPersonaExists, spawnDelaySeconds, STAGGER_ENV_VAR, waitForPeerRegistration } from "./fleet-tools.ts";
import { parseEnvFile, resolveEnvFilePath } from "../../../../scripts/lib/herdr-layout.ts";
import { worktreeTag } from "../../../../scripts/lib/team-project.ts";
import type { HerdrClosePaneParams, HerdrNotifyParams, HerdrReadPaneParams, HerdrSpawnPaneParams, HerdrSpawnPeerParams, ToolExecutionResult, ToolExecutor } from "./context.ts";

export interface HerdrExecutorDeps {
	provisionalCapabilityRefusal(pack: "workspace"): ToolExecutionResult | null;
	isFleetReady(): boolean;
	isComsReady(): boolean;
	getIdentity(): { project: string } | null;
	getCurrentContext(): { cwd?: string; hasUI?: boolean; ui?: any } | null;
	peersInScope(): Array<{ name: string }>;
	getComsPeerNames(): string[];
	herdr: any;
	readEnvFile(path: string): string;
	envFileExists(path: string): boolean;
	getLastPiSpawnAt(): number | null;
	setLastPiSpawnAt(value: number): void;
	recordSpawnedPeer(name: string, paneId: string): void;
}

const unavailable = (): ToolExecutionResult => ({ content: [{ type: "text", text: "herdr is not available in this session." }], details: { error: "no herdr" } });
const noPane = (): ToolExecutionResult => ({ content: [{ type: "text", text: "not inside a herdr pane." }], details: { error: "no pane" } });

export function createHerdrExecutors(d: HerdrExecutorDeps): Pick<import("./context.ts").ToolContext, "executeHerdrSpawnPeer" | "executeHerdrSpawnPane" | "executeHerdrReadPane" | "executeHerdrClosePane" | "executeHerdrNotify"> {
	const executeHerdrSpawnPeer: ToolExecutor<HerdrSpawnPeerParams> = async (_id, params) => {
		const refusal = d.provisionalCapabilityRefusal("workspace"); if (refusal) return refusal;
		if (!d.isFleetReady()) return unavailable();
		const ownPane = herdrPaneId(); if (!ownPane) return noPane();
		const identity = d.getIdentity();
		if (!d.isComsReady() || !identity) return { content: [{ type: "text", text: "Cannot spawn an addressable peer while coms is unavailable. Start without --solo/--no-coms, or use herdr_spawn_pane for a non-peer command." }], details: { error: "no coms" } };
		try {
			const cwd = d.getCurrentContext()?.cwd ?? process.cwd();
			const plan = buildHubPeerSpawnPlan(params, { project: identity.project, peersYaml: peerManifest(cwd), personaExists: persona => peerPersonaExists(cwd, persona), worktreeTag: worktreeTag(cwd) });
			if (d.peersInScope().some(peer => peer.name.toLowerCase() === plan.name.toLowerCase())) throw new Error(`Peer "${plan.name}" is already visible in project "${identity.project}"; use coms_send instead of spawning a duplicate.`);
			const env: Record<string, string> = {};
			if (plan.envFile) { const envPath = resolveEnvFilePath(plan.envFile, cwd); if (!d.envFileExists(envPath)) throw new Error(`env_file not found: ${plan.envFile} (resolved: ${envPath})`); Object.assign(env, parseEnvFile(d.readEnvFile(envPath), plan.envFile)); }
			const delay = plan.runner === "pi" ? spawnDelaySeconds(d.getLastPiSpawnAt()) : 0; if (delay > 0) env[STAGGER_ENV_VAR] = String(delay);
			const launched = await launchHubPeerInPane(plan, {
				client: d.herdr, targetPaneId: ownPane, cwd, env,
				waitForRegistration: (name, timeoutMs) => waitForPeerRegistration(name, () => d.isComsReady() && d.getIdentity() !== null, d.getComsPeerNames, timeoutMs),
				paneTail,
				onLaunched: paneId => { d.recordSpawnedPeer(plan.name, paneId); if (plan.runner === "pi") d.setLastPiSpawnAt(Date.now()); },
			});
			const promptNote = launched.promptSeen ? "" : `\n⚠ pane ${launched.paneId} showed no shell prompt within ${Math.round(PANE_PROMPT_TIMEOUT_MS / 1000)}s; the command was sent anyway.`;
			return { content: [{ type: "text", text: `spawned ${plan.kind} in pane ${launched.paneId} (${plan.name}): ${plan.command.join(" ")}${promptNote}\n\n${launched.verdict.message}` }], details: { pane_id: launched.paneId, name: plan.name, kind: plan.kind, runner: plan.runner, project: plan.project, prompt_seen: launched.promptSeen, env_file: plan.envFile ?? null, ...launched.verdict } };
		} catch (err) { const m = err instanceof Error ? err.message : String(err); return { content: [{ type: "text", text: `herdr_spawn_peer failed before readiness: ${m}` }], details: { error: m } }; }
	};
	const executeHerdrSpawnPane: ToolExecutor<HerdrSpawnPaneParams> = async (_id, params) => {
		const refusal = d.provisionalCapabilityRefusal("workspace"); if (refusal) return refusal;
		if (!d.isFleetReady()) return unavailable(); const ownPane = herdrPaneId(); if (!ownPane) return noPane();
		try {
			const cwd = d.getCurrentContext()?.cwd ?? process.cwd(); const argv = ["bash", "-lc", params.command];
			const { pane } = await d.herdr.paneSplit({ target_pane_id: ownPane, direction: params.direction ?? "right", cwd, focus: false });
			try { await d.herdr.paneRename(pane.pane_id, params.name); } catch {}
			const launch = await launchPeerInPane(d.herdr, pane.pane_id, argv); const promptNote = launch.promptSeen ? "" : `\n⚠ pane ${pane.pane_id} showed no shell prompt within ${Math.round(PANE_PROMPT_TIMEOUT_MS / 1000)}s; the command was sent anyway.`;
			return { content: [{ type: "text", text: `spawned raw pane ${pane.pane_id} (${params.name}): ${params.command}${promptNote}` }], details: { pane_id: pane.pane_id, name: params.name, prompt_seen: launch.promptSeen } };
		} catch (err) { const m = err instanceof Error ? err.message : String(err); return { content: [{ type: "text", text: `herdr_spawn_pane failed: ${m}` }], details: { error: m } }; }
	};
	const executeHerdrReadPane: ToolExecutor<HerdrReadPaneParams> = async (_id, params) => {
		if (!d.isFleetReady()) return unavailable(); const lines = Math.min(Math.max(1, params.lines ?? 60), 200);
		try { const { read } = await d.herdr.paneRead({ pane_id: params.pane_id, lines }); return { content: [{ type: "text", text: read.text || "(pane is empty)" }], details: { pane_id: params.pane_id, lines } }; }
		catch (err) { const m = err instanceof Error ? err.message : String(err); return { content: [{ type: "text", text: `herdr_read_pane failed: ${m}` }], details: { error: m } }; }
	};
	const executeHerdrClosePane: ToolExecutor<HerdrClosePaneParams> = async (_id, params) => {
		const refusal = d.provisionalCapabilityRefusal("workspace"); if (refusal) return refusal; if (!d.isFleetReady()) return unavailable();
		const ctx = d.getCurrentContext(); if (!ctx?.hasUI) return { content: [{ type: "text", text: "no UI to confirm the close — refused." }], details: { error: "no ui" } };
		const ok = await ctx.ui.confirm("herdr_close_pane", `Close pane ${params.pane_id}? Reason: ${params.reason}\nThis kills the process running in it.`);
		if (!ok) return { content: [{ type: "text", text: `human declined closing ${params.pane_id} — adapt and continue.` }], details: { declined: true } };
		try { await d.herdr.paneClose(params.pane_id); return { content: [{ type: "text", text: `closed ${params.pane_id}` }], details: { closed: params.pane_id } }; }
		catch (err) { const m = err instanceof Error ? err.message : String(err); return { content: [{ type: "text", text: `herdr_close_pane failed: ${m}` }], details: { error: m } }; }
	};
	const executeHerdrNotify: ToolExecutor<HerdrNotifyParams> = async (_id, params) => {
		const refusal = d.provisionalCapabilityRefusal("workspace"); if (refusal) return refusal; if (!d.isFleetReady()) return unavailable();
		try { await d.herdr.notificationShow({ title: params.title, body: params.body ?? "" }); return { content: [{ type: "text", text: `notified: ${params.title}` }], details: { title: params.title } }; }
		catch (err) { const m = err instanceof Error ? err.message : String(err); return { content: [{ type: "text", text: `herdr_notify failed: ${m}` }], details: { error: m } }; }
	};
	return { executeHerdrSpawnPeer, executeHerdrSpawnPane, executeHerdrReadPane, executeHerdrClosePane, executeHerdrNotify };
}
