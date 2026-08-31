import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { workModePrompt } from "./work-mode.ts";
import { assembleHubSystemPrompt, namedHubLedgerParts, recordHubLedger } from "../lib/context-budget-hub-prompt.ts";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const turnLifecycleSource = readFileSync(new URL("./lifecycle/turn-handlers.ts", import.meta.url), "utf8");
const contextUiSource = readFileSync(new URL("./ui/context-budget.ts", import.meta.url), "utf8");
const promptSource = readFileSync(new URL("./prompts/system-prompt.ts", import.meta.url), "utf8");
const contextCommandSource = readFileSync(new URL("./commands/context-command.ts", import.meta.url), "utf8");
const collector = readFileSync(new URL("./context-budget-snapshot.ts", import.meta.url), "utf8");
const childPrompt = readFileSync(new URL("../lib/context-budget-child-prompt.ts", import.meta.url), "utf8");

test("af-context is registered read-only in both operator and orchestrator work modes", () => {
	assert.match(source, /registerContextCommand\(pi, commandCtx\)/);
	assert.match(contextCommandSource, /registerCommand\("af-context"[\s\S]*?handleContext/);
	assert.match(contextUiSource, /async function openContextBudget[\s\S]*?ctx\.ui\.custom[\s\S]*?FULLSCREEN_OVERLAY/);
	assert.match(contextUiSource, /async function openContextBudget[\s\S]*?createPanelResources\(\)[\s\S]*?resources\.every\(1000,[\s\S]*?dispose: \(\) => resources\.dispose\(\)/);
	const command = contextUiSource.match(/async function openContextBudget[\s\S]*?return \{ contextPlanes, openContextBudget \}/)?.[0] ?? "";
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
	const command = contextUiSource.match(/async function openContextBudget[\s\S]*?return \{ contextPlanes, openContextBudget \}/)?.[0] ?? "";
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
	assert.match(contextUiSource, /deps\.buildHubSystemPrompt\(\);[\s\S]*ledger: deps\.getPromptLedger\(\)/);
	assert.match(source, /before_agent_start"[\s\S]*turnHandlers\.beforeAgentStart/);
	assert.match(turnLifecycleSource, /beforeAgentStart\(\) \{ resetTurn\(\); return ports\.buildPrompt\(\); \}/);
	assert.doesNotMatch(source, /return \{ systemPrompt: built\.systemPrompt,[\s\S]{0,40}ledger/);
});

test("turn resets stay lifecycle-owned and af-context remains side-effect free", () => {
	assert.doesNotMatch(promptSource, /applyWorkModeTools|closeTurnActiveTime|openTaskClock|startTurn|turnDispatchCount\s*=|pendingBudgetContinuation|freshTurnReport|updateModeStatus/);
	for (const required of ["ports.applyWorkMode()", "ports.closeTurnActiveTime(startedAt)", "ports.openTaskClock(startedAt)", "ports.startHistoryTurn(startedAt)", "ports.resetTurnBudgetState()", "ports.updateModeStatus()"])
		assert.ok(turnLifecycleSource.includes(required), `turn reset preserves ${required}`);
	assert.match(source, /resetTurnBudgetState: \(\) => \{[\s\S]*turnBudgetAskUserWaitMs = 0[\s\S]*budgetContinuationAsks\.clear\(\)[\s\S]*turnDispatchCount = 0[\s\S]*turnResearchCount = 0[\s\S]*turnDispatchFingerprints\.clear\(\)[\s\S]*externalBlockerAcknowledged = true[\s\S]*externalBlockerRefusedOnce = false[\s\S]*turnReport = freshTurnReport\(\)/);
	const contextCommand = contextUiSource.slice(contextUiSource.indexOf("async function openContextBudget"));
	assert.match(contextCommand, /buildHubSystemPrompt\(\)/);
	assert.doesNotMatch(contextCommand, /resetHubPromptTurn/);
});

test("context collector remains metadata-only and peer windows are never fabricated", () => {
	assert.doesNotMatch(collector, /sendMessage|sendUserMessage|\.compact\(/);
	assert.match(contextUiSource, /resolveContextWindow\(model, \{ lookup: deps\.modelWindowLookup\(ctx\), fallbackWindow: 0 \}\)/);
	assert.match(contextUiSource, /attribution: "unavailable"/);
	assert.match(contextUiSource, /getAllDefs\(\)\.filter/);
	assert.match(contextUiSource, /getResearchPersonas\(\)\.map/);
	assert.match(contextUiSource, /specialistStandingParts/);
	assert.match(contextUiSource, /researchStandingParts/);
	assert.match(contextUiSource, /delegateStandingParts/);
	assert.match(childPrompt, /function buildClarificationProtocol/);
	assert.match(childPrompt, /function buildDeliverableProtocol/);
	assert.match(childPrompt, /Clarification protocol/);
	assert.match(childPrompt, /Deliverable-to-file protocol/);
	assert.match(childPrompt, /Resolved delegate role protocol/);
	assert.match(contextUiSource, /projectionParts: parts, attribution: "projected"/);
	assert.match(contextUiSource, /attribution: "unavailable"/);
	assert.match(contextUiSource, /percent: peer\.context_used_pct/);
	assert.match(source, /getAllTools: \(\) => typeof pi\.getAllTools/);
	assert.match(source, /getCommands: \(\) => typeof pi\.getCommands/);
});
