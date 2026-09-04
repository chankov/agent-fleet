import { profileService } from './policy/profile-runtime.ts';
import { unlinkSync } from "node:fs";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { ComsIdentity, ComsSendParams, ComsSendResult, PendingReply, RegistryEntry } from "../lib/coms-core.ts";
import { buildJudgePrompt, parseJudgeVerdict } from "./drift-watchdog.js";
import { externalBlockedProtocol } from "./external-blocker.js";
import { EXTRACTION_DEADLINE_MS, EXTRACTION_MODEL, buildExtractionPrompt, extractionSessionName } from "./return-extract.js";
import { parseStructuredReturn } from "./return-contract.js";
import type { SpawnPiAgentOptions } from "./spawn.ts";

export interface DispatchInputArtifactPreview {
	input: string;
	path: string;
	displayPath: string;
	preview: string;
	resolvedFromKind?: string | null;
}

export interface ComsDispatchState {
	def: { name: string };
	runCount: number;
	lastBackend?: "native" | "coms";
	comsPeerModel?: string;
	contextPct: number;
	lastWork: string;
	comsAbort?: () => void;
}

export interface DriftJudgeInput {
	agentLabel: string;
	agentKey: string;
	task: string;
	scopeGlobs: string[];
	hubOwnedGlobs: string[];
	trail: string[];
	violation: { rule: string; terminal?: boolean; detail: string };
}

interface SpawnResult {
	output: string;
	exitCode: number | null;
	spawnError?: string;
}

export interface DispatchComsDeps {
	getIdentity(): ComsIdentity | null;
	resolveTarget(target: string): RegistryEntry | null;
	send(params: ComsSendParams, auditExtra?: Record<string, unknown>): Promise<ComsSendResult>;
	getPendingReply(msgId: string): PendingReply | undefined;
	deletePendingReply(msgId: string): void;
	getSessionDir(): string;
	getWatchdogJudgeModel(): string | null;
	getResearcherModel(): string | null;
	displayName(name: string): string;
	safeAgentKey(name: string): string;
	safePathWithin(root: string, ...parts: string[]): string;
	appendInputArtifacts(task: string, artifacts: DispatchInputArtifactPreview[]): string;
	appendDeclaredScope(task: string, scopeGlobs: string[]): string;
	buildRulesProtocol(): string;
	buildDocsProtocol(): string;
	updateWidget(): void;
	spawnPiAgent(options: SpawnPiAgentOptions): Promise<SpawnResult>;
}

export interface ComsDispatchResult {
	output: string;
	exitCode: number;
	elapsed: number;
	abandoned?: boolean;
	pending?: boolean;
}

async function dispatchViaComs(
	deps: DispatchComsDeps,
	state: ComsDispatchState,
	task: string,
	peerName: string,
	timeoutMs: number,
	allowNativeFallback: boolean,
	ctx: ExtensionContext,
	inputArtifacts: DispatchInputArtifactPreview[],
	scopeGlobs: string[],
): Promise<ComsDispatchResult | null> {
	const peer = deps.resolveTarget(peerName);
	if (!peer || !deps.getIdentity()) {
		if (allowNativeFallback) return null;
		return { output: `coms dispatch failed: peer "${peerName}" left the pool (fallback: none).`, exitCode: 1, elapsed: 0 };
	}
	state.lastBackend = "coms";
	state.comsPeerModel = peer.model;
	state.contextPct = peer.context_used_pct ?? 0;
	state.lastWork = `→ coms peer ${peer.name}...`;
	deps.updateWidget();

	const agentKey = deps.safeAgentKey(state.def.name);
	const runNumber = state.runCount;
	const dispatchProtocol = `

---
## Dispatch protocol (agent-hub)
You are serving a dispatched task as a standing peer; the dispatcher only receives this reply, so make it your complete final answer.
- Clarification: if you need a HUMAN decision (ambiguity, missing input, contradiction, or a destructive/irreversible next step), do NOT guess — include line(s) of the form \`ASK_USER: <one clear English question>\`; you will be re-dispatched with the answers.
${externalBlockedProtocol()}
- Deliverable-to-file: when your deliverable is a document (plan, review, critique, inventory, report) and your tools allow writing, write the full document to .pi/agent-sessions/artifacts/<kind>/${agentKey}-run${runNumber}.md (kinds: plans, reviews, inventories, evidence) — never repo-root ./artifacts/... — and finish with the artifact-relative path (artifacts/<kind>/${agentKey}-run${runNumber}.md) plus a digest of at most 10 lines.
- If the task includes acceptance assertions (A1, A2, ...), include the structured return from skills/orchestration-verification/SKILL.md.` +
		deps.buildRulesProtocol() + deps.buildDocsProtocol();
	const prompt = deps.appendDeclaredScope(deps.appendInputArtifacts(task, inputArtifacts), scopeGlobs) + dispatchProtocol;

	let sent: ComsSendResult;
	try {
		sent = await deps.send({
			target: peer.name,
			prompt,
			conversation_id: null,
			response_schema: null,
			reply_timeout_ms: timeoutMs,
		}, { dispatched_as: state.def.name });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (allowNativeFallback) {
			ctx.ui.notify(`${deps.displayName(state.def.name)}: coms peer unreachable (${msg}) — falling back to a native subagent.`, "warning");
			return null;
		}
		return { output: `coms dispatch to "${peer.name}" failed: ${msg} (fallback: none).`, exitCode: 1, elapsed: 0 };
	}
	const msgId = sent.msg_id;
	const entry = deps.getPendingReply(msgId)!;
	const timeoutPromise = new Promise<{ error: string }>(resolve => {
		entry.timer = setTimeout(() => resolve({ error: "timeout" }), timeoutMs);
		try { (entry.timer as any).unref?.(); } catch {}
	});
	let abandoned = false;
	const abortPromise = new Promise<{ error: string }>(resolve => {
		state.comsAbort = () => { abandoned = true; resolve({ error: "abandoned" }); };
	});
	const outcome = await Promise.race([entry.promise, abortPromise, timeoutPromise]);
	state.comsAbort = undefined;
	if (entry.timer) {
		try { clearTimeout(entry.timer); } catch {}
		entry.timer = null;
	}
	if (outcome.error !== "timeout") deps.deletePendingReply(msgId);

	const after = deps.resolveTarget(peer.name);
	if (after?.context_used_pct !== undefined) state.contextPct = after.context_used_pct;
	if (abandoned) {
		return {
			output: `Dispatch to coms peer "${peer.name}" was abandoned by the operator. The peer may still be working in its own pane — do NOT auto-retry or re-dispatch; wait for the operator's instruction.`,
			exitCode: 1,
			elapsed: 0,
			abandoned: true,
		};
	}
	const err = outcome.error;
	if (err === "timeout") {
		return {
			output: `coms dispatch pending after ${Math.round(timeoutMs / 1000)}s (msg_id ${msgId}). The peer may still complete; use coms_get/coms_await with this msg_id instead of re-dispatching.`,
			exitCode: 1,
			elapsed: 0,
			pending: true,
		};
	}
	if (err) return { output: `coms peer "${peer.name}" returned an error: ${err}`, exitCode: 1, elapsed: 0 };
	const response = (outcome as { response?: any }).response;
	return { output: typeof response === "string" ? response : JSON.stringify(response, null, 2), exitCode: 0, elapsed: 0 };
}

async function runDriftJudge(deps: DispatchComsDeps, input: DriftJudgeInput, ctx: ExtensionContext): Promise<{ verdict: string; reason: string } | null> {
	const selection=profileService('watchdog');
	const model = selection?.model ?? deps.getWatchdogJudgeModel()
		?? deps.getResearcherModel()
		?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "openrouter/google/gemini-3-flash-preview");
	const judgeSession = deps.safePathWithin(deps.getSessionDir(), `drift-judge-${input.agentKey}.json`);
	try { unlinkSync(judgeSession); } catch {}
	try {
		const res = await deps.spawnPiAgent({
			model,
			tools: "read",
			thinking: selection?.thinking ?? "off",
			appendSystemPrompt: "You are a strict, terse runtime watchdog. Answer with exactly one VERDICT line.",
			sessionFile: judgeSession,
			prompt: buildJudgePrompt({
				agent: input.agentLabel,
				task: input.task,
				scopeGlobs: input.scopeGlobs,
				hubOwnedGlobs: input.hubOwnedGlobs,
				trail: input.trail,
				violation: input.violation,
			}),
			detached: true,
			turnDeadlineMs: 60_000,
		});
		if (res.spawnError || res.exitCode !== 0) return null;
		return parseJudgeVerdict(res.output);
	} catch { return null; }
	finally { try { unlinkSync(judgeSession); } catch {} }
}

async function runReturnExtraction(deps: DispatchComsDeps, returnPath: string, assertionIds: string[]): Promise<any | null> {
	const extractSession = deps.safePathWithin(deps.getSessionDir(), extractionSessionName(returnPath));
	try { unlinkSync(extractSession); } catch {}
	try {
		const res = await deps.spawnPiAgent({
			model: profileService('return-extractor')?.model ?? EXTRACTION_MODEL,
			tools: "read",
			thinking: profileService('return-extractor')?.thinking ?? "off",
			appendSystemPrompt: "You restate an existing report in a fixed format. You never judge the work and never invent evidence.",
			sessionFile: extractSession,
			prompt: buildExtractionPrompt({ returnPath, assertionIds }),
			detached: true,
			turnDeadlineMs: EXTRACTION_DEADLINE_MS,
		});
		if (res.spawnError || res.exitCode !== 0) return null;
		return parseStructuredReturn(res.output);
	} catch { return null; }
	finally { try { unlinkSync(extractSession); } catch {} }
}

export function createDispatchComs(deps: DispatchComsDeps) {
	return {
		dispatchViaComs: (
			state: ComsDispatchState,
			task: string,
			peerName: string,
			timeoutMs: number,
			allowNativeFallback: boolean,
			ctx: ExtensionContext,
			inputArtifacts: DispatchInputArtifactPreview[],
			scopeGlobs: string[],
		) => dispatchViaComs(deps, state, task, peerName, timeoutMs, allowNativeFallback, ctx, inputArtifacts, scopeGlobs),
		runDriftJudge: (input: DriftJudgeInput, ctx: ExtensionContext) => runDriftJudge(deps, input, ctx),
		runReturnExtraction: (returnPath: string, assertionIds: string[], _ctx?: ExtensionContext) => runReturnExtraction(deps, returnPath, assertionIds),
	};
}
