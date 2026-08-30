import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { workModePrompt } from "./work-mode.ts";
import { assembleHubSystemPrompt, namedHubLedgerParts, recordHubLedger } from "../lib/context-budget-hub-prompt.ts";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const promptSource = readFileSync(new URL("./prompts/system-prompt.ts", import.meta.url), "utf8");
const contextCommandSource = readFileSync(new URL("./commands/context-command.ts", import.meta.url), "utf8");
const collector = readFileSync(new URL("./context-budget-snapshot.ts", import.meta.url), "utf8");
const childPrompt = readFileSync(new URL("../lib/context-budget-child-prompt.ts", import.meta.url), "utf8");

test("af-context is registered read-only in both operator and orchestrator work modes", () => {
	assert.match(source, /registerContextCommand\(pi, commandCtx\)/);
	assert.match(contextCommandSource, /registerCommand\("af-context"[\s\S]*?handleContext/);
	assert.match(source, /async function openContextBudget[\s\S]*?ctx\.ui\.custom[\s\S]*?FULLSCREEN_OVERLAY/);
	assert.match(source, /async function openContextBudget[\s\S]*?createPanelResources\(\)[\s\S]*?resources\.every\(1000,[\s\S]*?dispose: \(\) => resources\.dispose\(\)/);
	const command = source.match(/async function openContextBudget[\s\S]*?\n\t}\n\n\tfunction rosterRefusalMessage/)?.[0] ?? "";
	assert.doesNotMatch(command, /sendMessage|appendEntry|compact|triggerTurn|sessionManager\.append|writeFile/);
	const registerIdx = source.indexOf("registerContextCommand(pi, commandCtx)");
	assert.ok(registerIdx > 0);
	assert.equal(source.slice(registerIdx - 80, registerIdx).includes("orchestrator") || source.slice(registerIdx - 80, registerIdx).includes("operator"), false);
	assert.match(source, /openFleetDashboard/);
	assert.doesNotMatch(source, /openFleetDashboard[\s\S]{0,200}af-context|af-context[\s\S]{0,200}openFleetDashboard/);
	for (const workMode of ["operator", "orchestrator"] as const) {
		const pose = workModePrompt(workMode);
		const prompt = assembleHubSystemPrompt({
			intro: pose.intro,
			toolList: "tools",
			languageLines: "lang",
			activeTeamName: "",
			teamMembers: "",
			dispatchSection: "dispatch",
			userLanguage: "English",
			askUserBlock: "ask",
			modeSection: "mode",
			verificationSection: "verify",
			comsSection: "",
			herdrSection: "",
			hardRules: pose.hardRules,
			ambiguityRule: "rule",
			agentCatalog: "",
			researchCatalog: "",
		});
		const again = assembleHubSystemPrompt({
			intro: pose.intro,
			toolList: "tools",
			languageLines: "lang",
			activeTeamName: "",
			teamMembers: "",
			dispatchSection: "dispatch",
			userLanguage: "English",
			askUserBlock: "ask",
			modeSection: "mode",
			verificationSection: "verify",
			comsSection: "",
			herdrSection: "",
			hardRules: pose.hardRules,
			ambiguityRule: "rule",
			agentCatalog: "",
			researchCatalog: "",
		});
		assert.equal(prompt, again);
		assert.equal(recordHubLedger(prompt, namedHubLedgerParts({
			intro: pose.intro,
			languageLines: "lang",
			teamMembers: "",
			agentCards: [],
			dispatchSection: "dispatch",
			modeSection: "mode",
			verificationSection: "verify",
			researchCards: [],
			researchCatalog: "",
			comsSection: "",
			herdrSection: "",
		})).every((entry) => !prompt.includes("hub/")), true);
	}
});

test("af-context normalizes runtime navigation keys while preserving raw context commands", () => {
	const command = source.match(/async function openContextBudget[\s\S]*?\n\t}\n\n\tfunction rosterRefusalMessage/)?.[0] ?? "";
	for (const [key, ansi] of [["up", "\\u001b[A"], ["down", "\\u001b[B"], ["pageUp", "\\u001b[5~"], ["pageDown", "\\u001b[6~"], ["enter", "\\r"], ["escape", "\\u001b"]]) {
		assert.ok(command.includes(`if (matchesKey(data, Key.${key})) return "${ansi}";`));
	}
	assert.match(command, /contextBudgetTransition\(toInput\(data\), state, snapshot/);
	for (const key of ["g", "G", "r", "q"]) assert.equal(command.includes(`matchesKey(data, "${key}")`), false);
});

test("live Hub and af-context use the same extracted prompt and ledger before a turn", () => {
	assert.match(promptSource, /export function buildHubSystemPrompt\(ctx: HubPromptContext\)/);
	assert.match(promptSource, /const systemPrompt = assembleHubSystemPrompt\(/);
	assert.match(promptSource, /const ledger = recordHubLedger\(systemPrompt, namedHubLedgerParts\(/);
	assert.match(source, /function buildHubSystemPrompt\(\): \{ systemPrompt: string \} \{[\s\S]*assembleHubPrompt\(hubPromptCtx\)[\s\S]*lastHubLedger = built\.ledger/);
	assert.match(source, /buildHubSystemPrompt\(\);[\s\S]*ledger: lastHubLedger/);
	assert.match(source, /before_agent_start", async \(\) => \{[\s\S]*resetHubPromptTurn\(\);[\s\S]*return buildHubSystemPrompt\(\)/);
	assert.doesNotMatch(source, /return \{ systemPrompt: built\.systemPrompt,[\s\S]{0,40}ledger/);
});

test("turn resets stay composition-owned and af-context remains side-effect free", () => {
	assert.doesNotMatch(promptSource, /applyWorkModeTools|closeTurnActiveTime|openTaskClock|startTurn|turnDispatchCount\s*=|pendingBudgetContinuation|freshTurnReport|updateModeStatus/);
	const reset = source.slice(source.indexOf("function resetHubPromptTurn"), source.indexOf("\n\tconst hubPromptCtx"));
	for (const required of [
		"applyWorkModeTools()", "closeTurnActiveTime(turnStartedAt)", "openTaskClock(taskClock, turnStartedAt)",
		"executionHistory.startTurn(turnStartedAt)", "turnBudgetAskUserWaitMs = 0", "budgetContinuationAsks.clear()",
		"turnDispatchCount = 0", "turnResearchCount = 0", "turnDispatchFingerprints.clear()",
		"externalBlockerAcknowledged = true", "externalBlockerRefusedOnce = false", "turnReport = freshTurnReport()", "updateModeStatus()",
	]) assert.ok(reset.includes(required), `turn reset preserves ${required}`);
	const contextCommand = source.slice(source.indexOf("async function openContextBudget"), source.indexOf("\n\tfunction rosterRefusalMessage"));
	assert.match(contextCommand, /buildHubSystemPrompt\(\)/);
	assert.doesNotMatch(contextCommand, /resetHubPromptTurn/);
});

test("context collector remains metadata-only and peer windows are never fabricated", () => {
	assert.doesNotMatch(collector, /sendMessage|sendUserMessage|\.compact\(/);
	assert.match(source, /resolveContextWindow\(model, \{ lookup: modelWindowLookup\(ctx\), fallbackWindow: 0 \}\)/);
	assert.match(source, /attribution: "unavailable"/);
	assert.match(source, /allAgentDefs\.filter\(def => def\.kind !== "research"\)/);
	assert.match(source, /researchPersonas\.map/);
	assert.match(source, /specialistStandingParts/);
	assert.match(source, /researchStandingParts/);
	assert.match(source, /delegateStandingParts/);
	assert.match(childPrompt, /function buildClarificationProtocol/);
	assert.match(childPrompt, /function buildDeliverableProtocol/);
	assert.match(childPrompt, /Clarification protocol/);
	assert.match(childPrompt, /Deliverable-to-file protocol/);
	assert.match(childPrompt, /Resolved delegate role protocol/);
	assert.match(source, /projectionParts, attribution: "projected"/);
	assert.match(source, /attribution: "unavailable"/);
	assert.match(source, /percent: peer\.context_used_pct/);
	assert.match(source, /pi\.getAllTools/);
	assert.match(source, /pi\.getCommands/);
});
