// Static wiring contracts for the large Hub entrypoint. Live work mode behavior is
// exercised through a real offline Pi RPC process in extension-loader.test.ts.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const indexSource = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const budgetSource = readFileSync(new URL("./context/budgets.ts", import.meta.url), "utf8");
const researchRuntimeSource = readFileSync(new URL("./research/runtime.ts", import.meta.url), "utf8");
const researchSpawnSource = readFileSync(new URL("./research/spawn-run.ts", import.meta.url), "utf8");
const sessionStartSource = readFileSync(new URL("./session-start.ts", import.meta.url), "utf8");
const workModeCommandSource = readFileSync(new URL("./commands/work-mode.ts", import.meta.url), "utf8");
const rosterPolicySource = readFileSync(new URL("./policy/roster.ts", import.meta.url), "utf8");
const modelPolicySource = readFileSync(new URL("./policy/models.ts", import.meta.url), "utf8");
const workModePolicySource = readFileSync(new URL("./policy/work-mode.ts", import.meta.url), "utf8");
const fleetDashboardSource = readFileSync(new URL("./ui/fleet-dashboard.ts", import.meta.url), "utf8");
const contextBudgetUiSource = readFileSync(new URL("./ui/context-budget.ts", import.meta.url), "utf8");
const shortcutSource = readFileSync(new URL("./input/shortcuts.ts", import.meta.url), "utf8");
const pressureLifecycleSource = readFileSync(new URL("./lifecycle/context-pressure.ts", import.meta.url), "utf8");
const turnLifecycleSource = readFileSync(new URL("./lifecycle/turn-handlers.ts", import.meta.url), "utf8");
const researchControlsSource = readFileSync(new URL("./research/controls.ts", import.meta.url), "utf8");
const handoffCommandSource = readFileSync(new URL("./commands/handoff.ts", import.meta.url), "utf8");
const compoundCommandSource = readFileSync(new URL("./commands/compound.ts", import.meta.url), "utf8");
const pollCommandSource = readFileSync(new URL("./commands/poll.ts", import.meta.url), "utf8");
const debateCommandSource = readFileSync(new URL("./commands/debate.ts", import.meta.url), "utf8");
const commandContextSource = readFileSync(new URL("./commands/context.ts", import.meta.url), "utf8");
const dispatchAgentToolSource = readFileSync(new URL("./tools/dispatch-agent.ts", import.meta.url), "utf8");
const spawnResearchToolSource = readFileSync(new URL("./tools/spawn-research.ts", import.meta.url), "utf8");
const setTaskTierToolSource = readFileSync(new URL("./tools/set-task-tier.ts", import.meta.url), "utf8");
const teamAdjustToolSource = readFileSync(new URL("./tools/team-adjust.ts", import.meta.url), "utf8");
const verificationContractToolSource = readFileSync(new URL("./tools/verification-contract.ts", import.meta.url), "utf8");
const comsToolsSource = readFileSync(new URL("./tools/coms-tools.ts", import.meta.url), "utf8");
const fleetToolsSource = readFileSync(new URL("./tools/fleet-tools.ts", import.meta.url), "utf8");
const toolContextSource = readFileSync(new URL("./tools/context.ts", import.meta.url), "utf8");
const executionOrchestrationSource = readFileSync(new URL("./tools/execution-orchestration.ts", import.meta.url), "utf8");
const dispatchExecutionSource = readFileSync(new URL("./tools/dispatch-execution.ts", import.meta.url), "utf8");
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
	["poll", "registerPoll"],
	["debate", "registerDebate"],
] as const;
const comsCoreSource = readFileSync(new URL("../lib/coms-core.ts", import.meta.url), "utf8");
const personaSource = readFileSync(new URL("../../../agents/orchestrator.md", import.meta.url), "utf8");

test("wiring contract: all 23 Hub commands use typed modules and one flat registrar list", () => {
	assert.equal(commandModules.length, 23);
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
	assert.match(indexSource, /registerPoll\(pi, commandCtx\)/);
	assert.match(pollCommandSource, /registerCommand\("af-poll"[\s\S]*?handlePoll/);
	assert.match(indexSource, /registerDebate\(pi, commandCtx\)/);
	assert.match(debateCommandSource, /registerCommand\("af-debate"[\s\S]*?handleDebate/);
	assert.doesNotMatch(indexSource, /if \(workMode === [^)]+\)\s*\{\s*pi\.registerCommand/);
});

test("wiring contract: work-mode policy persists while root restores session order", () => {
	assert.match(workModePolicySource, /ports\.persist\(WORK_MODE_ENTRY_TYPE/);
	assert.match(indexSource, /createWorkModePolicy\(\{/);
	assert.match(indexSource, /const sessionEntries = _ctx\.sessionManager\.getEntries\(\)/);
	assert.match(indexSource, /setRestoredWorkMode\(resolveSessionWorkMode\(\{[\s\S]*?entries: sessionEntries/);
});
test("wiring contract: Hub restores named rosters and gates stale orchestrator sessions", () => {
	assert.match(indexSource, /resolveSessionRoster\(\{/);
	assert.match(indexSource, /hasExplicitRoster: startupRoster\.source === "explicit"/);
	assert.match(indexSource, /persist: team => pi\.appendEntry\(NATIVE_ROSTER_ENTRY_TYPE, persistedNativeRosterState\(team\)\)/);
	assert.match(rosterPolicySource, /ports\.persist\(team\)/);
	assert.match(indexSource, /registerAgentsSave\(pi, commandCtx\)/);
	assert.match(agentsSaveCommandSource, /registerCommand\("af-agents-save"[\s\S]*?handleAgentsSave/);
	assert.match(indexSource, /handleAgentsSave: async \(args, ctx\) => \{[\s\S]*?activeTeamName = name;[\s\S]*?persistActiveRoster\(\)/);
	assert.match(workModePolicySource, /rosterRecoveryRequired[\s\S]*?modelWorkBlockedByRosterRecovery/);
	assert.match(indexSource, /modelWorkBlocked: modelWorkBlockedByRosterRecovery/);
	assert.match(pressureLifecycleSource, /ports\.modelWorkBlocked\(ctx\)[\s\S]*?return \{ action: "handled" \}/);
	assert.doesNotMatch(indexSource, /registerCommand\("af-persona"/);
	assert.doesNotMatch(indexSource, /personaGateEnabled|pickDispatcherPersona/);
	assert.match(indexSource, /registerAgentsTeam\(pi, commandCtx\)/);
	assert.match(agentsTeamCommandSource, /registerCommand\("af-agents-team"[\s\S]*?handleAgentsTeam/);
	assert.match(indexSource, /handleAgentsTeam: async \(_args, ctx\) => \{[\s\S]*?clearRosterRecovery\(\);[\s\S]*?setTimeout\(replayDeferredRecoveryInputs/);
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

test("wiring contract: research lifecycle is owned by the typed runtime with root-backed state ports", () => {
	assert.match(researchRuntimeSource, /export interface ResearchRuntime</);
	assert.match(researchRuntimeSource, /export function parseResearchHandle/);
	for (const port of ["getResearchStates", "setResearchStates", "getNextResearchId", "setNextResearchId", "getResearchKeep", "setResearchKeep"]) {
		assert.match(researchRuntimeSource, new RegExp(`${port}\\(`));
		assert.match(indexSource, new RegExp(`${port}:`));
	}
	assert.match(indexSource, /createResearchRuntime<AgentDef>\(\{/);
	assert.match(indexSource, /hubState: hubStateCtx, budget: budgetCtx, artifacts: assertionsArtifactsCtx/);
	assert.match(indexSource, /guardrailEnv, notifyProviderQueue, spawnPiAgentWithModelFallback/);
	assert.match(researchSpawnSource, /providerSemaphore\.run/);
	for (const streamPort of ["appendTimelineText", "appendTimelineEvent", "executionHistory.end"]) assert.match(researchSpawnSource, new RegExp(streamPort.replace(".", "\\.")));
	assert.match(researchSpawnSource, /artifacts\.appendInputArtifacts/);
	assert.doesNotMatch(indexSource, /async function spawnResearch\(/);
	assert.doesNotMatch(indexSource, /function createResearchState\(/);
	assert.doesNotMatch(indexSource, /function pruneResearch\(/);
});

test("wiring contract: every fleet action assumes a tier before its persona gate", () => {
	assert.match(budgetSource, /ensureTaskTier\(\) \{[\s\S]*?setTaskTier\(DEFAULT_TASK_TIER\);[\s\S]*?setTaskTierAssumed\(true\);[\s\S]*?getTurnReport\(\)\.tier = DEFAULT_TASK_TIER;[\s\S]*?updateModeStatus\(\)/);
	assert.match(executionOrchestrationSource, /export interface DispatchExecutionContext/);
	assert.match(indexSource, /createToolExecutionOrchestration\(\{[\s\S]*?budget: budgetCtx, artifacts: assertionsArtifactsCtx, research: researchRuntime/);
	assert.doesNotMatch(indexSource, /async function executeDispatchAgent|async function executeSpawnResearch/);
	assert.match(dispatchExecutionSource, /function prepareDispatch[\s\S]*?budget\.ensureTaskTier\(\);[\s\S]*?preflightGate\(d, agent\)/);
	assert.match(dispatchExecutionSource, /createResearchExecutor[\s\S]*?budget\.ensureTaskTier\(\);[\s\S]*?preflightGate\(d, params\.persona \|\| ""\)/);
});

test("wiring contract: Hub applies extracted work mode tools at startup and live switches", () => {
	const applications = (indexSource + pressureLifecycleSource + turnLifecycleSource).match(/applyWorkMode(?:Tools)?\(\)/g) ?? [];
	assert.ok(applications.length >= 3, `expected startup, command, and lifecycle applications, got ${applications.length}`);
	assert.match(workModePolicySource, /resolveWorkModeTools\(\{/);
	assert.match(workModePolicySource, /async function applySelection\(/);
	assert.match(workModePolicySource, /async function openPicker\(/);
	assert.match(workModeCommandSource, /registerCommand\("af-work-mode"[\s\S]*?openWorkModePicker/);
	assert.match(indexSource, /registerInputShortcuts\(pi,/);
	assert.match(shortcutSource, /registerShortcut\("alt\+m"[\s\S]*?openWorkModePicker/);
});

test("wiring contract: policy maps and mutations have one typed owner", () => {
	for (const map of ["personaOverrides", "substitutions", "thinkingOverrides", "subagentOverrides"]) {
		assert.match(modelPolicySource, new RegExp(`const ${map} = new Map`));
		assert.doesNotMatch(indexSource, new RegExp(`const ${map} = new Map`));
	}
	assert.match(indexSource, /createModelPolicy<AgentDef>\(\{/);
	assert.match(indexSource, /createRosterPolicy<AgentDef, AgentState>\(\{/);
	assert.match(indexSource, /createWorkModePolicy\(\{/);
});
test("wiring contract: orchestrator persona defers authority to active work mode", () => {
	assert.match(personaSource, /active Hub work mode/i);
	assert.match(personaSource, /operator work mode/i);
	assert.match(personaSource, /orchestrator work mode/i);
});

test("same-turn pressure aborts after a large tool result and compacts only after the run settles", () => {
	assert.match(indexSource, /pi\.on\("message_end"[\s\S]*?pressureLifecycle\.messageEnd/);
	assert.match(pressureLifecycleSource, /messageEnd\(event, ctx\)[\s\S]*?event\.message\.role !== "toolResult"[\s\S]*?observe\(ctx, "message_end", projected\)[\s\S]*?ctx\.abort\(\)/);
	assert.match(indexSource, /pi\.on\("turn_end"[\s\S]*?pressureLifecycle\.turnEnd/);
	assert.match(pressureLifecycleSource, /context\(ctx\)[\s\S]*?automaticPending[\s\S]*?ctx\.abort\(\)/);
	assert.match(indexSource, /pi\.on\("agent_settled"[\s\S]*?pressureLifecycle\.agentSettled/);
	assert.match(pressureLifecycleSource, /const runCompaction[\s\S]*?ctx\.compact\(/);
	assert.match(indexSource, /pi\.on\("session_compact", async/);
});

test("pressure diagnostics stay metadata-only and feed status plus /af-context", () => {
	assert.match(contextBudgetUiSource, /pressure: contextPressureDiagnostic\(deps\.getPressureState\(\)\)/);
	assert.match(pressureLifecycleSource, /setStatus\("context-pressure",[\s\S]*?state\(\)\.pressure\.phase/);
	assert.match(pressureLifecycleSource, /appendEntry\("agent-hub-context-pressure", \{[\s\S]*?warning_percent:[\s\S]*?automatic_percent:[\s\S]*?last_recovery_outcome:/);
});

test("high-context startup and input defer prompts until compaction completes", () => {
	assert.match(sessionStartSource, /pi\.on\("session_start"[\s\S]*?runSessionStart\(ctx, deps\)/);
	assert.match(indexSource, /resolveCapabilities: async \(_ctx\) => \{[\s\S]*?pressureLifecycle\.observe\(_ctx, "session_start"\)/);
	assert.match(indexSource, /pi\.on\("input"[\s\S]*?pressureLifecycle\.input/);
	assert.match(pressureLifecycleSource, /state\(\)\.deferredInputs\.push[\s\S]*?action: "handled"/);
	assert.match(pressureLifecycleSource, /const replayDeferred[\s\S]*?ports\.sendUserMessage\(/);
	assert.match(pressureLifecycleSource, /const markSucceeded[\s\S]*?automaticPending = false/, "any observed compaction success clears a stale pending request");
	assert.match(pressureLifecycleSource, /if \(replaying && ports\.modelWorkBlocked\(ctx\)\)[\s\S]*?deferredInputs\.push/, "recovery replay is retained again when a roster gate is still active");
	assert.match(indexSource, /handleAgentsTeam: async \(_args, ctx\) => \{[\s\S]*?clearRosterRecovery\(\);[\s\S]*?setTimeout\(replayDeferredRecoveryInputs/,
		"team recovery clears the roster gate before replaying retained input");
});

test("stale-roster gate covers every command and dashboard path that can start model work", () => {
	assert.match(comsCoreSource, /function handlePrompt\([\s\S]*?deps\.acceptInbound/);
	assert.match(indexSource, /acceptInbound: \(\) => currentCtx && modelWorkBlockedByRosterRecovery\(currentCtx\)/);
	const guardedBlocks = [
		/function restartRow\([\s\S]*?deps\.modelWorkBlocked\(ctx\)/,
		/async handleRestart\(args, ctx\) \{[\s\S]*?ports\.modelWorkBlocked\(ctx\)/,
		/handleHandoff: async \(args, ctx\) => \{[\s\S]*?modelWorkBlockedByRosterRecovery\(ctx\)/,
		/handleCompound: async \(args, ctx\) => \{[\s\S]*?modelWorkBlockedByRosterRecovery\(ctx\)/,
		/handlePoll: async \(args, ctx\) => \{[\s\S]*?modelWorkBlockedByRosterRecovery\(ctx\)/,
		/handleDebate: async \(args, ctx\) => \{[\s\S]*?modelWorkBlockedByRosterRecovery\(ctx\)/,
	];
	assert.match(fleetDashboardSource, guardedBlocks[0]);
	assert.match(researchControlsSource, guardedBlocks[1]);
	for (const pattern of guardedBlocks.slice(2)) assert.match(indexSource, pattern);
	assert.match(agentsRestartCommandSource, /registerCommand\("af-agents-restart"[\s\S]*?handleAgentsRestart/);
});

test("same-turn lifecycle has one pre-model surface assembly point for normal and resumed remote turns", () => {
	assert.match(indexSource, /pi\.on\("input"[\s\S]*?pressureLifecycle\.input/, "incoming normal and remote messages share Pi's input hook");
	assert.match(indexSource, /pi\.on\("before_agent_start"[\s\S]*?turnHandlers\.beforeAgentStart/, "all model turns share the before_agent_start hook");
	assert.match(pressureLifecycleSource, /ports\.resolveCapabilities\(incomingText\(event\)\); ports\.applyWorkMode\(\)/);
	assert.match(turnLifecycleSource, /const resetTurn[\s\S]*?ports\.applyWorkMode\(\)/);
	assert.match(indexSource, /function buildHubSystemPrompt\(\): \{ systemPrompt: string \} \{[\s\S]*?assembleHubPrompt\(hubPromptCtx\)/);
	assert.doesNotMatch(indexSource, /classification model|classify.*model request|sendMessage\([\s\S]{0,100}classif/i);
});
