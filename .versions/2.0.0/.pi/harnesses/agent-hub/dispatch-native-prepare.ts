import { chmodSync, mkdirSync, rmSync, unlinkSync } from "node:fs";
import { applyModelOverride, clampDelegateDepth, DELEGATE_TREE_SPAWN_BUDGET, fallbackModelFor, MAX_DELEGATE_DEPTH, safePathWithin } from "./helpers.ts";
import { contextOverflowDiagnostic, shouldRecycleSession } from "./run-budget.js";
import { estimatePromptTokens, resolveContextWindow, shouldRecycleBeforeSpawn } from "./context-window.js";
import { quarantineIfUnusable } from "./session-health.js";
import { requireSafetyHarness } from "./safety-routing.ts";
import { buildSpecialistContextManifest, nativeSpecialistSystemPrompt } from "../lib/context-budget-child-prompt.ts";
import { extractAssertionIds } from "./return-contract.js";
import type { NativeDispatchResult, NativeRunBase, PreparedNativeRun } from "./dispatch-native-types.ts";

export async function prepareNativeRun(base: NativeRunBase, preserveManifest: boolean): Promise<PreparedNativeRun | NativeDispatchResult> {
	const { deps, state, ctx, task, inputArtifacts, scopeGlobs, personaKey, agentKey, runNumber } = base;
	const model = deps.resolvedModel(state.def)
		?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "openrouter/google/gemini-3-flash-preview");
	const fallbackCandidate = deps.substitutedModel(fallbackModelFor(state.def, model));
	const originalModelFallback = fallbackCandidate === model ? undefined : fallbackCandidate;
	const agentWindow = resolveContextWindow(model, { lookup: deps.modelWindowLookup(ctx), fallbackWindow: deps.getContextWindow() });
	const agentSessionFile = safePathWithin(deps.getSessionDir(), `${agentKey}.json`);
	const turnBudget = deps.currentBudget();
	let sessionRecycled = false;

	if (state.sessionFile && shouldRecycleSession(state.runsSinceFresh, state.contextPct, turnBudget)) {
		try { unlinkSync(agentSessionFile); } catch {}
		state.sessionFile = null;
		state.runsSinceFresh = 0;
		state.contextPct = 0;
		state.contextTokens = 0;
		sessionRecycled = true;
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
		ctx.ui.notify(`${deps.displayName(state.def.name)}: unusable session file quarantined (${health.reason}) — starting fresh`, "warning");
	}

	const subagentRoles = state.def.subagents && Object.keys(state.def.subagents).length > 0
		? Object.fromEntries(Object.entries(state.def.subagents).map(([role, value]) => {
			const effective = deps.resolvedSubagentModel(personaKey, role, value.model);
			const configured = effective !== value.model ? applyModelOverride(value, effective) : value;
			const fallback = deps.substitutedModel(configured.fallbackModel);
			return [role, fallback === configured.model ? { ...configured, fallbackModel: undefined } : { ...configured, fallbackModel: fallback }];
		}))
		: null;
	const delegateExtPath = deps.getDelegateExtensionPath();
	const delegationActive = turnBudget.delegation && !!subagentRoles && !!delegateExtPath;
	const safetyHarnessPath = deps.getSafetyHarnessPath();
	const safety = requireSafetyHarness(safetyHarnessPath);
	if (!safety.ok) return base.finishRun(safety.error, 1);
	const extensions = [...safety.extensions];
	let effectiveTools = state.def.tools;
	let delegateEnv: Record<string, string> | undefined;
	if (delegationActive) {
		const delegationDir = safePathWithin(deps.getSessionDir(), "delegations", agentKey);
		try { rmSync(delegationDir, { recursive: true, force: true }); } catch {}
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
				parentTools: state.def.tools,
				personaPrompt: state.def.systemPrompt,
				eventDir: delegationDir,
				damageControl: safetyHarnessPath || undefined,
				delegateExt: delegateExtPath,
				reconSearchTimeoutMs: deps.getReconSearchTimeoutMs(),
				turnDeadlineMs: turnBudget.agentTurnMs,
				cwd: ctx.cwd || process.cwd(),
			}),
		};
		deps.startDelegationWatch(state, delegationDir);
	}

	const manifest = preserveManifest && state.specialistManifest
		? state.specialistManifest
		: buildSpecialistContextManifest({
			personaName: state.def.name,
			personaPath: state.def.file,
			personaPrompt: state.def.systemPrompt,
			task,
			rulesPaths: deps.specialistProjectPolicyPaths(ctx.cwd || process.cwd()),
			docsPaths: deps.getProjectDocsPaths(),
			hasAssertions: extractAssertionIds(task).length > 0,
			hasScope: scopeGlobs.length > 0,
			hasArtifacts: inputArtifacts.length > 0,
			delegateRoles: delegationActive ? Object.keys(subagentRoles!) : [],
		});
	state.specialistManifest = manifest;
	const replacementSystemPrompt = nativeSpecialistSystemPrompt({ manifest, userLanguage: deps.getUserLanguage(), agentKey, runNumber });
	const thinkingLevel = deps.resolveThinkingLevel(deps.resolvedThinking(state.def));
	const wantThinking = thinkingLevel !== "off";
	const runPrompt = deps.appendDeclaredScope(deps.appendInputArtifacts(task, inputArtifacts), scopeGlobs);

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
		delegateEnv,
		thinkingLevel,
		wantThinking,
		replacementSystemPrompt,
		runPrompt,
	};
}
