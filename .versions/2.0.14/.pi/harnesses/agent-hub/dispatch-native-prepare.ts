import { fileURLToPath } from "node:url";
import { isCaptureEnabled } from "./proactive-config.ts";
import type { ProactiveConfig } from "./proactive-types.ts";
import { PROACTIVE_OBSERVER_ENV, isProactiveSpecialist, type ObserverAssignment } from "./proactive-observer.ts";
import { profileFallback, profileChild, PROFILE_ENV } from './policy/profile-runtime.ts';
import { BOUNDED_OUTPUT_DIR_ENV } from './bounded-output.ts';
import { FILESYSTEM_SESSION_DIR_ENV } from './filesystem-tool.ts';
import { chmodSync, mkdirSync, existsSync, copyFileSync, unlinkSync } from "node:fs";
import { applyModelOverride, clampDelegateDepth, DELEGATE_TREE_SPAWN_BUDGET, fallbackModelFor, MAX_DELEGATE_DEPTH, safePathWithin } from "./helpers.ts";
import { contextOverflowDiagnostic, shouldRecycleSession } from "./run-budget.js";
import { estimatePromptTokens, resolveContextWindow, shouldRecycleBeforeSpawn } from "./context-window.js";
import { quarantineIfUnusable } from "./session-health.js";
import { requireSafetyHarness } from "./safety-routing.ts";
import { buildSpecialistContextManifest, nativeSpecialistSystemPrompt } from "../lib/context-budget-child-prompt.ts";
import { extractAssertionIds } from "./return-contract.js";
import type { NativeDispatchResult, NativeRunBase, PreparedNativeRun } from "./dispatch-native-types.ts";
import { bindResume, type TaskResumeInput } from "./task-resume-contract.ts";
import { confineNativeChild, type WriteIsolationRequest } from "./write-isolation.ts";

export function sessionObserverAssignment(config: ProactiveConfig | null | undefined, personaKey: string, assignment: Omit<ObserverAssignment, "config">): ObserverAssignment | undefined {
	return isProactiveSpecialist(personaKey) && config && isCaptureEnabled(config) ? { ...assignment, config } : undefined;
}

export async function prepareNativeRun(base: NativeRunBase, _resumeRequested: boolean, requestedContract?: Omit<TaskResumeInput, "previous">): Promise<PreparedNativeRun | NativeDispatchResult> {
	const { deps, state, ctx, task, inputArtifacts, scopeGlobs, personaKey, agentKey, runNumber } = base;
	const model = deps.resolvedModel(state.def)
		?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "openrouter/google/gemini-3-flash-preview");
	const fallbackCandidate = profileFallback(deps.substitutedModel(fallbackModelFor(state.def, model)));
	const originalModelFallback = fallbackCandidate === model ? undefined : fallbackCandidate;
	const agentWindow = resolveContextWindow(model, { lookup: deps.modelWindowLookup(ctx), fallbackWindow: deps.getContextWindow() });
	const agentSessionFile = safePathWithin(base.evidenceDir, "session.json");
	const resumeContract = bindResume({
		taskId: requestedContract?.taskId ?? task,
		instructions: requestedContract?.instructions ?? task,
		scope: requestedContract?.scope ?? scopeGlobs,
		deliverables: requestedContract?.deliverables,
		artifacts: requestedContract?.artifacts ?? inputArtifacts.map(artifact => artifact.path),
		model: requestedContract?.model ?? model,
		permissions: requestedContract?.permissions ?? state.def.tools,
		previous: state.resumeContract,
	});
	let resumeAllowed = resumeContract.resumeAllowed && !!state.sessionFile && existsSync(state.sessionFile);
	if (resumeAllowed) copyFileSync(state.sessionFile!, agentSessionFile);
	else if (state.sessionFile) {
		state.sessionFile = null;
		state.specialistManifest = undefined;
		state.runsSinceFresh = 0;
		state.contextPct = 0;
		state.contextTokens = 0;
	}
	const turnBudget = deps.currentBudget();
	let sessionRecycled = false;

	if (state.sessionFile && shouldRecycleSession(state.runsSinceFresh, state.contextPct, turnBudget)) {
		try { unlinkSync(agentSessionFile); } catch {}
		state.sessionFile = null;
		state.runsSinceFresh = 0;
		state.contextPct = 0;
		state.contextTokens = 0;
		sessionRecycled = true;
		resumeAllowed = false;
		deps.bumpRecycle();
		ctx.ui.notify(`${deps.displayName(state.def.name)}: session recycled (stale context) — starting fresh`, "info");
	} else {
		const overflow = contextOverflowDiagnostic(state.runsSinceFresh, state.contextPct, {
			agent: deps.displayName(state.def.name),
			model: deps.resolvedModel(state.def) ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown model"),
		});
		if (overflow) ctx.ui.notify(overflow, "warning");
	}

	let sessionReset = null;
	const health = quarantineIfUnusable(agentSessionFile, deps.getSessionHealthIo());
	if (!health.usable && health.reason) {
		sessionReset = { reason: health.reason, quarantined: health.quarantined, retried: false };
		state.sessionFile = null;
		state.runsSinceFresh = 0;
		state.contextPct = 0;
		state.contextTokens = 0;
		resumeAllowed = false;
		ctx.ui.notify(`${deps.displayName(state.def.name)}: unusable session file quarantined (${health.reason}) — starting fresh`, "warning");
	}

	const subagentRoles = state.def.subagents && Object.keys(state.def.subagents).length > 0
		? Object.fromEntries(Object.entries(state.def.subagents).map(([role, value]) => {
			const effective = deps.resolvedSubagentModel(personaKey, role, value.model);
			const configured = { ...(effective !== value.model ? applyModelOverride(value, effective) : value) };
			const fallback = profileFallback(deps.substitutedModel(configured.fallbackModel));
			const thinking=profileChild(personaKey,role)?.thinking;
			if(thinking!==undefined) configured.thinking=thinking;
			return [role, fallback === configured.model ? { ...configured, fallbackModel: undefined } : { ...configured, fallbackModel: fallback }];
		}))
		: null;
	const delegateExtPath = deps.getDelegateExtensionPath();
	const delegationActive = turnBudget.delegation && !!subagentRoles && !!delegateExtPath;
	const projectPolicy = {
		rulesPaths: deps.specialistProjectPolicyPaths(ctx.cwd || process.cwd()),
		docsPaths: deps.getProjectDocsPaths(),
	};
	const safetyHarnessPath = deps.getSafetyHarnessPath();
	const safety = requireSafetyHarness(safetyHarnessPath);
	if (!safety.ok) return base.finishRun(safety.error, 1);
	const extensions = [...safety.extensions];
	// Only the Hub's session-start config can authorize child observation. Missing/off stays off
	// even if the on-disk config changes before a later native attempt.
	const config = deps.getProactiveConfig?.();
	let proactiveAssignment: ObserverAssignment | undefined;
	if (config && isProactiveSpecialist(personaKey) && isCaptureEnabled(config)) {
		const root = ctx.cwd || process.cwd();
		const directory = safePathWithin(base.evidenceDir, "proactive-turns");
		const context = deps.getProactiveCapture?.()?.nativeContext(base.sessionDir, agentKey, base.dispatchId, task);
		if (context) proactiveAssignment = sessionObserverAssignment(config, personaKey, { root, directory, session: base.sessionDir, owner: agentKey, attempt: base.dispatchId, context });
		if (proactiveAssignment) extensions.push(fileURLToPath(new URL("./proactive-observer.ts", import.meta.url)));
	}
 const assist = base.assistSnapshot;
 const boundedOutput = assist['bounded-output'];
 const declaredTools = state.def.tools.split(",").map(tool => tool.trim()).filter(Boolean);
 const deterministicTools = assist['deterministic-tools'] && (state.def.toolsExplicit !== true || declaredTools.includes("filesystem"));
 if (boundedOutput) extensions.push(fileURLToPath(new URL("./bounded-output.ts", import.meta.url)));
 if (deterministicTools) extensions.push(fileURLToPath(new URL("./filesystem-tool.ts", import.meta.url)));
 if (declaredTools.includes("bash")) extensions.push(fileURLToPath(new URL("./runtime-test-check.ts", import.meta.url)));
	let effectiveTools = deterministicTools && !declaredTools.includes("filesystem") ? `${state.def.tools},filesystem` : state.def.tools;
	let delegateEnv: Record<string, string> | undefined;
	if (delegationActive) {
		const delegationDir = safePathWithin(base.evidenceDir, "delegations");
		mkdirSync(delegationDir, { recursive: true, mode: 0o700 });
		try { chmodSync(delegationDir, 0o700); } catch {}
		extensions.push(delegateExtPath!);
		effectiveTools = `${state.def.tools},delegate`;
		delegateEnv = {
			AGENT_HUB_DELEGATE_CONFIG: JSON.stringify({
				persona: state.def.name,
				tag: "root",
				roles: subagentRoles,
				depth: clampDelegateDepth(state.def.delegateDepth ?? MAX_DELEGATE_DEPTH),
				callBudget: DELEGATE_TREE_SPAWN_BUDGET,
				remainingSpawns: DELEGATE_TREE_SPAWN_BUDGET,
				parentTools: effectiveTools,
				personaPrompt: state.def.systemPrompt,
				eventDir: delegationDir,
				damageControl: safetyHarnessPath || undefined,
				delegateExt: delegateExtPath,
				reconSearchTimeoutMs: deps.getReconSearchTimeoutMs(),
				turnDeadlineMs: turnBudget.agentTurnMs,
				boundedOutput,
				boundedOutputDir: safePathWithin(base.evidenceDir, "delegations", "bounded-output"),
				deterministicTools,
				filesystemSessionDir: base.sessionDir,
				cwd: ctx.cwd || process.cwd(),
				projectPolicy,
			}),
		};
		deps.startDelegationWatch(state, delegationDir);
	}

	const manifest = resumeAllowed && state.specialistManifest
		? state.specialistManifest
		: buildSpecialistContextManifest({
			personaName: state.def.name,
			personaPath: state.def.file,
			personaPrompt: state.def.systemPrompt,
			task,
			rulesPaths: projectPolicy.rulesPaths,
			docsPaths: projectPolicy.docsPaths,
			hasAssertions: extractAssertionIds(task).length > 0,
			hasScope: scopeGlobs.length > 0,
			hasArtifacts: inputArtifacts.length > 0,
			delegateRoles: delegationActive ? Object.keys(subagentRoles!) : [],
		});
	state.specialistManifest = manifest;
	const replacementSystemPrompt = nativeSpecialistSystemPrompt({ manifest, userLanguage: deps.getUserLanguage(), agentKey, runNumber, artifactRoot: safePathWithin(base.sessionDir, "artifacts"), dispatchId: base.dispatchId });
	const thinkingLevel = deps.resolveThinkingLevel(deps.resolvedThinking(state.def));
	const wantThinking = thinkingLevel !== "off";
	const runPrompt = deps.appendDeclaredScope(deps.appendInputArtifacts(task, inputArtifacts), scopeGlobs);
	let writeIsolation: WriteIsolationRequest | undefined;
	let writeIsolationPolicy;
	if (assist['write-isolation']) {
		const artifactRoot = safePathWithin(base.sessionDir, "artifacts");
		const tempRoot = safePathWithin(base.evidenceDir, "runtime-tmp");
		mkdirSync(artifactRoot, { recursive: true, mode: 0o700 });
		mkdirSync(tempRoot, { recursive: true, mode: 0o700 });
		writeIsolation = {
			enabled: true,
			cwd: ctx.cwd || process.cwd(),
			allowlist: [...scopeGlobs],
			runtimePaths: [base.evidenceDir],
			artifactPaths: [artifactRoot],
			tempPaths: [tempRoot],
		};
		writeIsolationPolicy = confineNativeChild(writeIsolation);
		if (!writeIsolationPolicy.applied) return base.finishRun(`Write isolation refused: ${writeIsolationPolicy.reason ?? "native backend unavailable"}. No unsandboxed child was started.`, 1);
		writeIsolation.backend = writeIsolationPolicy.mechanism;
		writeIsolation.backendPath = writeIsolationPolicy.command;
		delegateEnv = { ...delegateEnv, TMPDIR: tempRoot, TMP: tempRoot, TEMP: tempRoot };
	}
	if (base.activeProfileSnapshot) delegateEnv = { ...delegateEnv, [PROFILE_ENV]: JSON.stringify(base.activeProfileSnapshot) };

	if (state.sessionFile && !sessionRecycled) {
		const overflow = shouldRecycleBeforeSpawn({
			priorTokens: state.contextTokens,
			promptTokens: estimatePromptTokens(runPrompt) + estimatePromptTokens(replacementSystemPrompt),
			window: agentWindow.window,
		});
		if (overflow) {
			try { unlinkSync(agentSessionFile); } catch {}
			state.sessionFile = null;
			state.runsSinceFresh = 0;
			state.contextPct = 0;
			state.contextTokens = 0;
			sessionRecycled = true;
			resumeAllowed = false;
			deps.bumpRecycle();
			ctx.ui.notify(
				`${deps.displayName(state.def.name)}: session recycled before spawn — ${overflow.message}. ` +
				"Resuming would have overflowed the window mid-run; the task text and artifact paths carry the state.",
				"info",
			);
		}
	}

	return {
		...base,
		model,
		originalModelFallback,
		agentWindow,
		agentSessionFile,
		turnBudget,
		sessionRecycled,
		sessionReset,
		effectiveTools,
		extensions,
		delegateEnv: {
			...delegateEnv,
			...(boundedOutput ? { [BOUNDED_OUTPUT_DIR_ENV]: safePathWithin(base.evidenceDir, "bounded-output") } : {}),
			...(deterministicTools ? { [FILESYSTEM_SESSION_DIR_ENV]: base.sessionDir } : {}),
			...(proactiveAssignment ? { [PROACTIVE_OBSERVER_ENV]: JSON.stringify(proactiveAssignment) } : {}),
		},
		writeIsolation,
		writeIsolationPolicy,
		proactiveAssignment,
		thinkingLevel,
		wantThinking,
		resumeContract,
		resumeAllowed,
		replacementSystemPrompt,
		runPrompt,
	};
}
