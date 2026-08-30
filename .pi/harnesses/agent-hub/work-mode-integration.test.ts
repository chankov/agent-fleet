// Static wiring contracts for the large Hub entrypoint. Live work mode behavior is
// exercised through a real offline Pi RPC process in extension-loader.test.ts.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const indexSource = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const sessionStartSource = readFileSync(new URL("./session-start.ts", import.meta.url), "utf8");
const workModeCommandSource = readFileSync(new URL("./commands/work-mode.ts", import.meta.url), "utf8");
const handoffCommandSource = readFileSync(new URL("./commands/handoff.ts", import.meta.url), "utf8");
const compoundCommandSource = readFileSync(new URL("./commands/compound.ts", import.meta.url), "utf8");
const commandContextSource = readFileSync(new URL("./commands/context.ts", import.meta.url), "utf8");
const dispatchAgentToolSource = readFileSync(new URL("./tools/dispatch-agent.ts", import.meta.url), "utf8");
const spawnResearchToolSource = readFileSync(new URL("./tools/spawn-research.ts", import.meta.url), "utf8");
const setTaskTierToolSource = readFileSync(new URL("./tools/set-task-tier.ts", import.meta.url), "utf8");
const teamAdjustToolSource = readFileSync(new URL("./tools/team-adjust.ts", import.meta.url), "utf8");
const verificationContractToolSource = readFileSync(new URL("./tools/verification-contract.ts", import.meta.url), "utf8");
const comsToolsSource = readFileSync(new URL("./tools/coms-tools.ts", import.meta.url), "utf8");
const fleetToolsSource = readFileSync(new URL("./tools/fleet-tools.ts", import.meta.url), "utf8");
const toolContextSource = readFileSync(new URL("./tools/context.ts", import.meta.url), "utf8");
const agentsTeamCommandSource = readFileSync(new URL("./commands/agents-team.ts", import.meta.url), "utf8");
const agentsSaveCommandSource = readFileSync(new URL("./commands/agents-save.ts", import.meta.url), "utf8");
const agentsRestartCommandSource = readFileSync(new URL("./commands/agents-restart.ts", import.meta.url), "utf8");
const agentsCommandSources = [
	"agents-add", "agents-drop", "agents-kill", "agents-restart",
].map(name => readFileSync(new URL(`./commands/${name}.ts`, import.meta.url), "utf8"));
const commandModules = [
	["agents-team", "registerAgentsTeam"],
	["agents-list", "registerAgentsList"],
	["agents-history", "registerAgentsHistory"],
	["context-command", "registerContextCommand"],
	["work-mode", "registerWorkMode"],
	["watchdog", "registerWatchdog"],
	["agents-add", "registerAgentsAdd"],
	["agents-drop", "registerAgentsDrop"],
	["agents-save", "registerAgentsSave"],
	["hub-report", "registerHubReport"],
	["zoom", "registerZoom"],
	["agent-model", "registerAgentModel"],
	["agent-model-thinking", "registerAgentModelThinking"],
	["models", "registerModels"],
	["agent-models-substitute", "registerAgentModelsSubstitute"],
	["dispatch-policy", "registerDispatchPolicy"],
	["agents-kill", "registerAgentsKill"],
	["agents-restart", "registerAgentsRestart"],
	["coms", "registerComs"],
	["handoff", "registerHandoff"],
	["compound", "registerCompound"],
] as const;
const comsCoreSource = readFileSync(new URL("../lib/coms-core.ts", import.meta.url), "utf8");
const personaSource = readFileSync(new URL("../../../agents/orchestrator.md", import.meta.url), "utf8");

test("wiring contract: all 21 Hub commands use typed modules and one flat registrar list", () => {
	assert.equal(commandModules.length, 21);
	for (const [file, registrar] of commandModules) {
		const commandSource = readFileSync(new URL(`./commands/${file}.ts`, import.meta.url), "utf8");
		assert.match(commandSource, new RegExp(`export function ${registrar}\\(pi: ExtensionAPI, commandCtx: CommandContext\\)`));
		assert.equal((commandSource.match(/registerCommand\("af-/g) ?? []).length, 1, file);
	}
	assert.equal((indexSource.match(/registerCommand\("af-/g) ?? []).length, 0);
	const flatCalls = commandModules.map(([, registrar]) => `${registrar}\\(pi, commandCtx\\);`).join("\\s*");
	assert.match(indexSource, new RegExp(flatCalls));
});

test("wiring contract: Hub registers one work-mode command without conditional commands", () => {
	assert.match(indexSource, /registerFlag\("work-mode"/);
	assert.match(indexSource, /registerWorkMode\(pi, commandCtx\)/);
	assert.equal((workModeCommandSource.match(/registerCommand\("af-work-mode"/g) ?? []).length, 1);
	assert.match(workModeCommandSource, /registerWorkMode\(pi: ExtensionAPI, commandCtx: CommandContext\)/);
	assert.match(commandContextSource, /setWidgetContext\(ctx: ExtensionContext\)/);
	assert.match(commandContextSource, /getWorkModeStatusText\(\): string/);
	for (const removed of ["af-posture", "af-research", "af-research-cont", "af-research-rm", "af-research-clear", "af-agents-cont"]) {
		assert.doesNotMatch(indexSource, new RegExp(`registerCommand\\("${removed}"`));
	}
	for (const retained of ["af-agents-add", "af-agents-drop", "af-agents-kill", "af-agents-restart"]) {
		assert.ok(agentsCommandSources.some(source => source.includes(`registerCommand(\"${retained}\"`)), `${retained} is registered`);
	}
	assert.match(indexSource, /registerHandoff\(pi, commandCtx\)/);
	assert.match(handoffCommandSource, /registerCommand\("af-handoff"[\s\S]*?getComsPeerCompletions[\s\S]*?handleHandoff/);
	assert.match(indexSource, /registerCompound\(pi, commandCtx\)/);
	assert.match(compoundCommandSource, /registerCommand\("af-compound"[\s\S]*?handleCompound/);
	assert.doesNotMatch(indexSource, /if \(workMode === [^)]+\)\s*\{\s*pi\.registerCommand/);
});

test("wiring contract: Hub persists and restores work-mode entries", () => {
	assert.match(indexSource, /appendEntry\(WORK_MODE_ENTRY_TYPE/);
	assert.match(indexSource, /resolveSessionWorkMode\(\{/);
	assert.match(indexSource, /const sessionEntries = _ctx\.sessionManager\.getEntries\(\)/);
	assert.match(indexSource, /resolveSessionWorkMode\(\{[\s\S]*?entries: sessionEntries/);
});

test("wiring contract: Hub restores named rosters and gates stale orchestrator sessions", () => {
	assert.match(indexSource, /resolveSessionRoster\(\{/);
	assert.match(indexSource, /hasExplicitRoster: startupRoster\.source === "explicit"/);
	assert.match(indexSource, /appendEntry\(NATIVE_ROSTER_ENTRY_TYPE, persistedNativeRosterState\(/);
	assert.match(indexSource, /registerAgentsSave\(pi, commandCtx\)/);
	assert.match(agentsSaveCommandSource, /registerCommand\("af-agents-save"[\s\S]*?handleAgentsSave/);
	assert.match(indexSource, /handleAgentsSave: async \(args, ctx\) => \{[\s\S]*?activeTeamName = name;[\s\S]*?persistActiveRoster\(\)/);
	assert.match(indexSource, /rosterRecoveryRequired[\s\S]*?return \{ action: "handled" as const \}/);
	assert.doesNotMatch(indexSource, /registerCommand\("af-persona"/);
	assert.doesNotMatch(indexSource, /personaGateEnabled|pickDispatcherPersona/);
	assert.match(indexSource, /registerAgentsTeam\(pi, commandCtx\)/);
	assert.match(agentsTeamCommandSource, /registerCommand\("af-agents-team"[\s\S]*?handleAgentsTeam/);
	assert.match(indexSource, /handleAgentsTeam: async \(_args, ctx\) => \{[\s\S]*?rosterRecoveryRequired = false;[\s\S]*?setTimeout\(replayDeferredRecoveryInputs/);
	assert.doesNotMatch(indexSource, /throw new Error\("Orchestrator workMode requires --agent-team/);
});

test("wiring contract: extracted Hub tools use typed modules and one flat registrar list", () => {
	const toolModules = [
		[dispatchAgentToolSource, "registerDispatchAgent", 1],
		[spawnResearchToolSource, "registerSpawnResearch", 1],
		[setTaskTierToolSource, "registerSetTaskTier", 1],
		[teamAdjustToolSource, "registerTeamAdjust", 1],
		[verificationContractToolSource, "registerVerificationContract", 3],
		[comsToolsSource, "registerComsTools", 4],
		[fleetToolsSource, "registerFleetTools", 5],
	] as const;
	assert.equal(toolModules.length, 7);
	for (const [source, registrar, count] of toolModules) {
		assert.match(source, new RegExp(`export function ${registrar}\\(pi: ExtensionAPI, toolCtx: ToolContext\\)`));
		assert.equal((source.match(/registerTool\(\{/g) ?? []).length, count, registrar);
	}
	const extractedNames = ["dispatch_agent", "spawn_research", "set_task_tier", "team_adjust", "set_assertions", "update_assertion", "get_assertions", "coms_list", "coms_send", "coms_get", "coms_await", "herdr_spawn_peer", "herdr_spawn_pane", "herdr_read_pane", "herdr_close_pane", "herdr_notify"];
	assert.equal(extractedNames.length, 16);
	for (const name of extractedNames) assert.doesNotMatch(indexSource, new RegExp(`name: "${name}"`));
	assert.equal((indexSource.match(/registerTool\(\{/g) ?? []).length, 0);
	assert.match(indexSource, /registerDispatchAgent\(pi, toolCtx\);\s*registerSpawnResearch\(pi, toolCtx\);\s*registerSetTaskTier\(pi, toolCtx\);\s*registerTeamAdjust\(pi, toolCtx\);\s*registerVerificationContract\(pi, toolCtx\);\s*registerComsTools\(pi, toolCtx\);\s*registerFleetTools\(pi, toolCtx\);/);
	assert.equal(existsSync(new URL("./tools/ask-user.ts", import.meta.url)), false);
	assert.match(toolContextSource, /export interface ToolContext/);
	for (const callback of ["executeDispatchAgent", "executeSpawnResearch", "executeSetTaskTier", "executeTeamAdjust", "executeSetAssertions", "executeUpdateAssertion", "executeGetAssertions", "executeComsList", "executeComsSend", "executeComsGet", "executeComsAwait", "executeHerdrSpawnPeer", "executeHerdrSpawnPane", "executeHerdrReadPane", "executeHerdrClosePane", "executeHerdrNotify"]) {
		assert.match(toolContextSource, new RegExp(`${callback}: ToolExecutor<`));
	}
	assert.match(toolContextSource, /getAssertionCount\(\): number/);
});

test("wiring contract: every fleet action assumes a tier before its persona gate", () => {
	assert.match(indexSource, /function ensureTaskTier\(\): void \{[\s\S]*?taskTier = DEFAULT_TASK_TIER;[\s\S]*?taskTierAssumed = true;[\s\S]*?turnReport\.tier = taskTier;[\s\S]*?updateModeStatus\(\)/);
	const dispatchExecution = indexSource.match(/async function executeDispatchAgent\([\s\S]*?(?=\n\t+async function executeSpawnResearch)/);
	const researchExecution = indexSource.match(/async function executeSpawnResearch\([\s\S]*?(?=\n\t+\/\/ ── Extracted tool execution wiring)/);
	assert.ok(dispatchExecution, "dispatch_agent execution remains in the composition root");
	assert.ok(researchExecution, "spawn_research execution remains in the composition root");
	assert.match(dispatchExecution[0], /ensureTaskTier\(\);[\s\S]*?preflightGate\(agent\)/);
	assert.match(researchExecution[0], /ensureTaskTier\(\);[\s\S]*?preflightGate\(persona \|\| ""\)/);
});

test("wiring contract: Hub applies work mode tools at startup and live switches", () => {
	const applications = indexSource.match(/applyWorkModeTools\(\)/g) ?? [];
	assert.ok(applications.length >= 3, `expected definition plus startup and command applications, got ${applications.length}`);
	assert.match(indexSource, /resolveWorkModeTools\(/);
	assert.match(indexSource, /async function applyWorkModeSelection\(/);
	assert.match(indexSource, /async function openWorkModePicker\(/);
	assert.match(workModeCommandSource, /registerCommand\("af-work-mode"[\s\S]*?openWorkModePicker/);
	assert.match(indexSource, /registerShortcut\("alt\+m"[\s\S]*?openWorkModePicker/);
	assert.doesNotMatch(indexSource, /registerCommand\("af-hub-mode"/);
});

test("wiring contract: orchestrator persona defers authority to active work mode", () => {
	assert.match(personaSource, /active Hub work mode/i);
	assert.match(personaSource, /operator work mode/i);
	assert.match(personaSource, /orchestrator work mode/i);
});

test("same-turn pressure aborts after a large tool result and compacts only after the run settles", () => {
	assert.match(indexSource, /pi\.on\("message_end", async \(event, ctx\) => \{[\s\S]*?event\.message\.role !== "toolResult"[\s\S]*?observeContextPressure\(ctx, "message_end", projectedResultTokens\)[\s\S]*?ctx\.abort\(\)/);
	assert.match(indexSource, /pi\.on\("turn_end", async \(_event, ctx\) => \{[\s\S]*?observeContextPressure\(ctx, "turn_end"\)/);
	assert.match(indexSource, /pi\.on\("context", async \(_event, ctx\) => \{[\s\S]*?automaticCompactionPending[\s\S]*?ctx\.abort\(\)/);
	assert.match(indexSource, /pi\.on\("agent_settled", async \(_event, ctx\) => \{[\s\S]*?runAutomaticCompaction\(ctx, "agent_settled"\)/);
	assert.match(indexSource, /function runAutomaticCompaction\([\s\S]*?ctx\.compact\(/);
	assert.match(indexSource, /pi\.on\("session_compact", async/);
});

test("pressure diagnostics stay metadata-only and feed status plus /af-context", () => {
	assert.match(indexSource, /pressure: contextPressureDiagnostic\(contextPressureState\)/);
	assert.match(indexSource, /setStatus\("context-pressure",[\s\S]*?contextPressureState\.phase/);
	assert.match(indexSource, /appendEntry\("agent-hub-context-pressure", \{[\s\S]*?warning_percent:[\s\S]*?automatic_percent:[\s\S]*?last_recovery_outcome:/);
});

test("high-context startup and input defer prompts until compaction completes", () => {
	assert.match(sessionStartSource, /pi\.on\("session_start"[\s\S]*?runSessionStart\(ctx, deps\)/);
	assert.match(indexSource, /resolveCapabilities: async \(_ctx\) => \{[\s\S]*?observeContextPressure\(_ctx, "session_start"\)/);
	assert.match(indexSource, /pi\.on\("input", async \(event, ctx\) => \{[\s\S]*?deferredRecoveryInputs\.push[\s\S]*?action: "handled"/);
	assert.match(indexSource, /function replayDeferredRecoveryInputs\([\s\S]*?pi\.sendUserMessage\(/);
	assert.match(indexSource, /function markContextCompactionSucceeded\(\)[\s\S]*?automaticCompactionPending = false/,
		"any observed compaction success clears a stale pending request");
	assert.match(indexSource, /if \(replayingDeferredRecoveryInput && modelWorkBlockedByRosterRecovery\(ctx\)\)[\s\S]*?deferredRecoveryInputs\.push/,
		"recovery replay is retained again when a roster gate is still active");
	assert.match(indexSource, /handleAgentsTeam: async \(_args, ctx\) => \{[\s\S]*?rosterRecoveryRequired = false;[\s\S]*?setTimeout\(replayDeferredRecoveryInputs/,
		"team recovery clears the roster gate before replaying retained input");
});

test("stale-roster gate covers every command and dashboard path that can start model work", () => {
	assert.match(comsCoreSource, /function handlePrompt\([\s\S]*?deps\.acceptInbound/);
	assert.match(indexSource, /acceptInbound: \(\) => currentCtx && modelWorkBlockedByRosterRecovery\(currentCtx\)/);
	const guardedBlocks = [
		/function restartFleetRow\([\s\S]*?modelWorkBlockedByRosterRecovery\(ctx\)/,
		/handleAgentsRestart: async \(args, ctx\) => \{[\s\S]*?modelWorkBlockedByRosterRecovery\(ctx\)/,
		/handleHandoff: async \(args, ctx\) => \{[\s\S]*?modelWorkBlockedByRosterRecovery\(ctx\)/,
		/handleCompound: async \(args, ctx\) => \{[\s\S]*?modelWorkBlockedByRosterRecovery\(ctx\)/,
	];
	for (const pattern of guardedBlocks) assert.match(indexSource, pattern);
	assert.match(agentsRestartCommandSource, /registerCommand\("af-agents-restart"[\s\S]*?handleAgentsRestart/);
});

test("same-turn lifecycle has one pre-model surface assembly point for normal and resumed remote turns", () => {
	const inputHook = indexSource.match(/pi\.on\("input", async \(event, ctx\) => \{[\s\S]*?\n\t\}\);/);
	const beforeHook = indexSource.match(/pi\.on\("before_agent_start", async \(\) => \{[\s\S]*?resetHubPromptTurn\(\);[\s\S]*?return buildHubSystemPrompt\(\);[\s\S]*?\}\);/);
	assert.ok(inputHook, "incoming normal and remote messages share Pi's input hook");
	assert.ok(beforeHook, "all model turns share the before_agent_start hook");
	// Registration order is intentionally irrelevant: Pi invokes input before model startup.
	assert.match(indexSource, /pi\.on\("input", async \(event, ctx\) => \{[\s\S]*?resolveIncomingCapabilities\(incomingText\(event\)\);[\s\S]*?applyWorkModeTools\(\)/);
	assert.match(indexSource, /function resetHubPromptTurn\(\): void \{[\s\S]*?applyWorkModeTools\(\)/);
	assert.match(indexSource, /function buildHubSystemPrompt\(\): \{ systemPrompt: string \} \{[\s\S]*?assembleHubPrompt\(hubPromptCtx\)/);
	assert.doesNotMatch(indexSource, /classification model|classify.*model request|sendMessage\([\s\S]{0,100}classif/i);
});
