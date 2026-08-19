import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { posturePrompt } from "./posture.ts";
import { assembleHubSystemPrompt, namedHubLedgerParts, recordHubLedger } from "../lib/context-budget-hub-prompt.ts";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const collector = readFileSync(new URL("./context-budget-snapshot.ts", import.meta.url), "utf8");
const childPrompt = readFileSync(new URL("../lib/context-budget-child-prompt.ts", import.meta.url), "utf8");

test("af-context is registered read-only in both operator and orchestrator postures", () => {
	assert.match(source, /pi\.registerCommand\("af-context",[\s\S]*?openContextBudget\(ctx\)/);
	assert.match(source, /async function openContextBudget[\s\S]*?ctx\.ui\.custom[\s\S]*?FULLSCREEN_OVERLAY/);
	assert.match(source, /async function openContextBudget[\s\S]*?createPanelResources\(\)[\s\S]*?resources\.every\(1000,[\s\S]*?dispose: \(\) => resources\.dispose\(\)/);
	const command = source.match(/async function openContextBudget[\s\S]*?\n\t}\n\n\tpi\.registerCommand\("af-context"/)?.[0] ?? "";
	assert.doesNotMatch(command, /sendMessage|appendEntry|compact|triggerTurn|sessionManager\.append|writeFile/);
	const registerIdx = source.indexOf('pi.registerCommand("af-context"');
	assert.ok(registerIdx > 0);
	assert.equal(source.slice(registerIdx - 80, registerIdx).includes("orchestrator") || source.slice(registerIdx - 80, registerIdx).includes("operator"), false);
	assert.match(source, /openFleetDashboard/);
	assert.doesNotMatch(source, /openFleetDashboard[\s\S]{0,200}af-context|af-context[\s\S]{0,200}openFleetDashboard/);
	for (const posture of ["operator", "orchestrator"] as const) {
		const pose = posturePrompt(posture);
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
	const command = source.match(/async function openContextBudget[\s\S]*?\n\t}\n\n\tpi\.registerCommand\("af-context"/)?.[0] ?? "";
	for (const [key, ansi] of [["up", "\\u001b[A"], ["down", "\\u001b[B"], ["pageUp", "\\u001b[5~"], ["pageDown", "\\u001b[6~"], ["enter", "\\r"], ["escape", "\\u001b"]]) {
		assert.ok(command.includes(`if (matchesKey(data, Key.${key})) return "${ansi}";`));
	}
	assert.match(command, /contextBudgetTransition\(toInput\(data\), state, snapshot/);
	for (const key of ["g", "G", "r", "q"]) assert.equal(command.includes(`matchesKey(data, "${key}")`), false);
});

test("live Hub and af-context use the same on-demand replacement prompt ledger before a turn", () => {
	assert.match(source, /function buildHubSystemPrompt\(forTurn: boolean\)/);
	assert.match(source, /const systemPrompt = assembleHubSystemPrompt\(/);
	assert.match(source, /lastHubLedger = recordHubLedger\(systemPrompt, namedHubLedgerParts\(/);
	assert.match(source, /buildHubSystemPrompt\(false\);[\s\S]*ledger: lastHubLedger/);
	assert.match(source, /before_agent_start", async \(_event, _ctx\) => buildHubSystemPrompt\(true\)/);
	assert.doesNotMatch(source, /return \{ systemPrompt:[\s\S]{0,40}ledger/);
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
