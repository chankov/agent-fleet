import { readActiveProfile } from './policy/profile-runtime.ts';
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { TIMEOUT_MS } from "../lib/coms-core.ts";
import { comsRequiredRefusal, explicitComsRefusal, resolveDispatchBackend } from "./backend-policy.js";
import { monitorKeyForAgent } from "./monitor-control.ts";
import { normalizeAgentInput, safeAgentKey, safePathWithin } from "./helpers.ts";
import { prepareNativeRun } from "./dispatch-native-prepare.ts";
import { runPreparedNative } from "./dispatch-native-spawn.ts";
import { completeNativeRun } from "./dispatch-native-complete.ts";
import type {
	DispatchInputArtifactPreview,
	NativeBackend,
	NativeDispatchDeps,
	NativeDispatchResult,
	NativeDispatchState,
	NativeRunBase,
} from "./dispatch-native-types.ts";

interface NativeDispatchArgs {
	agentName: string;
	task: string;
	ctx: ExtensionContext;
	inputArtifacts: DispatchInputArtifactPreview[];
	scopeGlobs: string[];
	watchdogParam?: boolean;
	requestedBackend: NativeBackend;
	preserveManifest: boolean;
}

function missingOrRunning(deps: NativeDispatchDeps, agentName: string): NativeDispatchResult | NativeDispatchState {
	const state = deps.getAgentState(normalizeAgentInput(agentName));
	if (!state) {
		return {
			output: `Agent "${agentName}" not found. Available: ${deps.listAgentStates().map(item => deps.displayName(item.def.name)).join(", ")}`,
			exitCode: 1,
			elapsed: 0,
		};
	}
	if (state.status === "running") {
		return {
			output: `Agent "${deps.displayName(state.def.name)}" is already running. Wait for it to finish.`,
			exitCode: 1,
			elapsed: 0,
		};
	}
	return state;
}

function beginNativeRun(deps: NativeDispatchDeps, state: NativeDispatchState, args: NativeDispatchArgs): NativeRunBase {
	const { task, ctx, inputArtifacts, scopeGlobs, watchdogParam } = args;
	state.status = "running";
	state.task = task;
	state.toolCount = 0;
	state.elapsed = 0;
	state.lastWork = "";
	state.lastBackend = undefined;
	state.comsPeerModel = undefined;
	state.runCount++;
	state.killedByOperator = false;
	state.restarting = false;
	deps.flushTimelineStore(state);
	state.timeline = [];
	state.transcriptStore = deps.createTranscriptStore(safePathWithin(deps.getSessionDir(), "transcripts", `${safeAgentKey(state.def.name)}-run${state.runCount}.jsonl`));
	state.delegationsWatcher?.close();
	state.delegationsWatcher = undefined;
	state.delegations = undefined;
	deps.updateWidget();

	const histEntry = deps.executionHistory.start("agent", deps.displayName(state.def.name));
	state.histEntry = histEntry;
	const agentKey = safeAgentKey(state.def.name);
	const runNumber = state.runCount;
	const monitorKey = monitorKeyForAgent(state.def.name, state.runCount);
	const monitorStart = deps.startMonitorChild({
		key: monitorKey,
		id: `run-${agentKey}-${state.runCount}`,
		generation: 1,
		specialist: agentKey,
	}, process.env);
	const startTime = Date.now();
	state.timer = setInterval(() => {
		state.elapsed = Date.now() - startTime;
		deps.updateWidget();
	}, 1000);

	const finishRun = async (output: string, exitCode: number, options?: { idle?: boolean; pending?: boolean; notice?: string }): Promise<NativeDispatchResult> => {
		await monitorStart?.then(task => deps.finalizeMonitorChild(
			task,
			output,
			options?.pending ? "blocked" : exitCode === 0 ? "completed" : "failed",
		));
		clearInterval(state.timer);
		state.elapsed = Date.now() - startTime;
		state.status = options?.idle ? "idle" : exitCode === 0 ? "done" : "error";
		state.lastWork = output.split("\n").filter(line => line.trim()).pop() || "";
		if (output.trim()) deps.appendTimelineText(state, "text", output);
		deps.updateWidget();
		state.zoomRender?.(true);
		deps.executionHistory.end(histEntry, state.status);
		if (options?.notice) ctx.ui.notify(options.notice, state.status === "done" ? "success" : state.status === "idle" ? "info" : "error");
		const onTerminate = state.onTerminate;
		state.onTerminate = undefined;
		onTerminate?.();
		return { output, exitCode, elapsed: state.elapsed, ...(options?.pending ? { pending: true } : {}) };
	};

	return {
		deps, state, ctx, task, inputArtifacts, scopeGlobs, watchdogParam,
		key: normalizeAgentInput(args.agentName),
		personaKey: state.def.name.toLowerCase(),
		agentKey, runNumber, histEntry, monitorKey, monitorStart, startTime, finishRun,
	};
}

async function routeDispatch(run: NativeRunBase, requestedBackend: NativeBackend): Promise<NativeDispatchResult | null> {
	const { deps, state, task, ctx, inputArtifacts, scopeGlobs, personaKey, monitorKey, startTime, histEntry } = run;
	const livePeerNames = () => deps.isComsReady() && deps.getIdentity() ? deps.peersInScope().map(entry => entry.name) : [];
	const forceNative=readActiveProfile()?.profile.routing==='native';
	if(forceNative&&requestedBackend==='coms') return run.finishRun('Active model profile requires native execution; coms dispatch refused.',1);
	const dispatchPolicy = forceNative?{default:'native',grace_s:0,substitutions:{}}:deps.getDispatchPolicy();
	let route: any = resolveDispatchBackend({ agentName: state.def.name, policy: dispatchPolicy, livePeerNames: livePeerNames(), requestedBackend });
	if (route.backend === "invalid") return run.finishRun(`Invalid dispatch backend "${route.requestedBackend}". Expected auto|native|coms.`, 1);
	if (route.backend === "coms-unavailable") return run.finishRun(explicitComsRefusal(deps.displayName(state.def.name)), 1);
	if (route.backend === "await-coms") {
		const graceS = route.grace_s;
		const deadline = Date.now() + graceS * 1000;
		state.lastWork = `waiting for coms peer (≤${graceS}s)...`;
		deps.updateWidget();
		while (Date.now() < deadline && route.backend !== "coms") {
			await new Promise(resolve => setTimeout(resolve, 1000));
			route = resolveDispatchBackend({ agentName: state.def.name, policy: dispatchPolicy, livePeerNames: livePeerNames(), requestedBackend });
		}
		if (route.backend !== "coms") return run.finishRun(comsRequiredRefusal(deps.displayName(state.def.name), graceS), 1);
	}
	if (route.backend === "native" && route.comsMissedNotice && !deps.wasComsMissNotified(personaKey)) {
		deps.markComsMissNotified(personaKey);
		ctx.ui.notify(route.comsMissedNotice, "warning");
	}
	if (route.backend === "coms") {
		void deps.registerMonitorWaitOnly(monitorKey, state);
		const allowNativeFallback = !route.explicit && (dispatchPolicy.substitutions[personaKey]?.fallback ?? "native") !== "none";
		const timeoutMs = route.timeout_s ? route.timeout_s * 1000 : TIMEOUT_MS;
		const comsResult = await deps.dispatchViaComs(state, task, route.peerName, timeoutMs, allowNativeFallback, ctx, inputArtifacts, scopeGlobs);
		if (comsResult) {
			histEntry.name = `${deps.displayName(state.def.name)} (coms)`;
			return run.finishRun(comsResult.output, comsResult.exitCode, {
				idle: comsResult.abandoned || comsResult.pending,
				pending: comsResult.pending,
				notice: comsResult.abandoned
					? `${deps.displayName(state.def.name)} coms dispatch abandoned (the peer pane keeps running)`
					: comsResult.pending
						? `${deps.displayName(state.def.name)} coms dispatch is pending (the peer pane keeps running)`
						: `${deps.displayName(state.def.name)} ${comsResult.exitCode === 0 ? "done" : "error"} in ${Math.round((Date.now() - startTime) / 1000)}s (coms peer)`,
			});
		}
	}
	state.lastBackend = "native";
	state.comsPeerModel = undefined;
	return null;
}

async function dispatchNative(deps: NativeDispatchDeps, args: NativeDispatchArgs): Promise<NativeDispatchResult> {
	const found = missingOrRunning(deps, args.agentName);
	if (!("def" in found)) return found;
	const run = beginNativeRun(deps, found, args);
	const routed = await routeDispatch(run, args.requestedBackend);
	if (routed) return routed;
	const prepared = await prepareNativeRun(run, args.preserveManifest);
	if ("output" in prepared) return prepared;
	const outcome = await runPreparedNative(prepared);
	return completeNativeRun(prepared, outcome);
}

export function createDispatchNative(deps: NativeDispatchDeps) {
	return {
		dispatchAgent: (
			agentName: string,
			task: string,
			ctx: ExtensionContext,
			inputArtifacts: DispatchInputArtifactPreview[] = [],
			scopeGlobs: string[] = [],
			watchdogParam?: boolean,
			requestedBackend: NativeBackend = "auto",
			preserveManifest = false,
		) => dispatchNative(deps, { agentName, task, ctx, inputArtifacts, scopeGlobs, watchdogParam, requestedBackend, preserveManifest }),
	};
}
