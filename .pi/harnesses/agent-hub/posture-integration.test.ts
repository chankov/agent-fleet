// Static wiring contracts for the large Hub entrypoint. Live posture behavior is
// exercised through a real offline Pi RPC process in extension-loader.test.ts.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const indexSource = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const personaSource = readFileSync(new URL("../../../agents/orchestrator.md", import.meta.url), "utf8");

test("wiring contract: Hub registers posture controls without conditional commands", () => {
	assert.match(indexSource, /registerFlag\("posture"/);
	assert.match(indexSource, /registerCommand\("af-posture"/);
	assert.match(indexSource, /registerCommand\("af-work-mode"/);
	assert.match(indexSource, /registerCommand\("af-handoff"/);
	assert.doesNotMatch(indexSource, /if \(posture === [^)]+\)\s*\{\s*pi\.registerCommand/);
});

test("wiring contract: Hub persists and restores posture entries", () => {
	assert.match(indexSource, /appendEntry\("agent-hub-posture"/);
	assert.match(indexSource, /resolveSessionPosture\(\{/);
	assert.match(indexSource, /const sessionEntries = _ctx\.sessionManager\.getEntries\(\)/);
	assert.match(indexSource, /resolveSessionPosture\(\{[\s\S]*?entries: sessionEntries/);
});

test("wiring contract: Hub restores named rosters and gates stale orchestrator sessions", () => {
	assert.match(indexSource, /resolveSessionRoster\(\{/);
	assert.match(indexSource, /hasExplicitRoster: startupRoster\.source === "explicit"/);
	assert.match(indexSource, /appendEntry\(NATIVE_ROSTER_ENTRY_TYPE, persistedNativeRosterState\(/);
	const saveCommand = indexSource.match(/registerCommand\("af-agents-save"[\s\S]*?(?=\n\tpi\.registerCommand\("af-hub-report")/);
	assert.ok(saveCommand, "save-team command is registered");
	assert.match(saveCommand[0], /activeTeamName = name;[\s\S]*?persistActiveRoster\(\)/);
	assert.match(indexSource, /rosterRecoveryRequired[\s\S]*?return \{ action: "handled" as const \}/);
	assert.doesNotMatch(indexSource, /registerCommand\("af-persona"/);
	assert.doesNotMatch(indexSource, /personaGateEnabled|pickDispatcherPersona/);
	const teamCommand = indexSource.match(/registerCommand\("af-agents-team"[\s\S]*?(?=\n\tlet fleetShowFinished)/);
	assert.ok(teamCommand, "team-selection command is registered");
	assert.match(teamCommand[0], /rosterRecoveryRequired = false;[\s\S]*?setTimeout\(replayDeferredRecoveryInputs/);
	assert.doesNotMatch(indexSource, /throw new Error\("Orchestrator posture requires --agent-team/);
});

test("wiring contract: every fleet action assumes a tier before its persona gate", () => {
	assert.match(indexSource, /function ensureTaskTier\(\): void \{[\s\S]*?taskTier = DEFAULT_TASK_TIER;[\s\S]*?taskTierAssumed = true;[\s\S]*?turnReport\.tier = taskTier;[\s\S]*?updateModeStatus\(\)/);
	const dispatchTool = indexSource.match(/name: "dispatch_agent",[\s\S]*?(?=\n\t\}\);\n\n\t\/\/ ── spawn_research Tool)/);
	const researchTool = indexSource.match(/name: "spawn_research",[\s\S]*?(?=\n\t\/\/ ── set_task_tier Tool)/);
	assert.ok(dispatchTool, "dispatch_agent tool is registered");
	assert.ok(researchTool, "spawn_research tool is registered");
	assert.match(dispatchTool[0], /ensureTaskTier\(\);[\s\S]*?preflightGate\(agent\)/);
	assert.match(researchTool[0], /ensureTaskTier\(\);[\s\S]*?preflightGate\(persona \|\| ""\)/);
});

test("wiring contract: Hub applies posture tools at startup and live switches", () => {
	const applications = indexSource.match(/applyPostureTools\(\)/g) ?? [];
	assert.ok(applications.length >= 3, `expected definition plus startup and command applications, got ${applications.length}`);
	assert.match(indexSource, /resolvePostureTools\(/);
	assert.match(indexSource, /async function applyPostureSelection\(/);
	assert.match(indexSource, /async function openPosturePicker\(/);
	assert.match(indexSource, /registerCommand\("af-work-mode"[\s\S]*?openPosturePicker/);
	assert.match(indexSource, /registerShortcut\("alt\+m"[\s\S]*?openPosturePicker/);
	assert.doesNotMatch(indexSource, /registerCommand\("af-hub-mode"/);
});

test("wiring contract: orchestrator persona defers authority to active posture", () => {
	assert.match(personaSource, /active Hub posture/i);
	assert.match(personaSource, /operator posture/i);
	assert.match(personaSource, /orchestrator posture/i);
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
	assert.match(indexSource, /pi\.on\("session_start", async \(_event, _ctx\) => \{[\s\S]*?observeContextPressure\(_ctx, "session_start"\)/);
	assert.match(indexSource, /pi\.on\("input", async \(event, ctx\) => \{[\s\S]*?deferredRecoveryInputs\.push[\s\S]*?action: "handled"/);
	assert.match(indexSource, /function replayDeferredRecoveryInputs\([\s\S]*?pi\.sendUserMessage\(/);
	assert.match(indexSource, /function markContextCompactionSucceeded\(\)[\s\S]*?automaticCompactionPending = false/,
		"any observed compaction success clears a stale pending request");
	assert.match(indexSource, /if \(replayingDeferredRecoveryInput && modelWorkBlockedByRosterRecovery\(ctx\)\)[\s\S]*?deferredRecoveryInputs\.push/,
		"recovery replay is retained again when a roster gate is still active");
	const teamRecovery = indexSource.match(/registerCommand\("af-agents-team"[\s\S]*?(?=\n\tlet fleetShowFinished)/);
	assert.ok(teamRecovery, "team recovery command is registered");
	assert.match(teamRecovery[0], /rosterRecoveryRequired = false;[\s\S]*?setTimeout\(replayDeferredRecoveryInputs/,
		"team recovery clears the roster gate before replaying retained input");
});

test("stale-roster gate covers every command and dashboard path that can start model work", () => {
	const guardedBlocks = [
		/function handlePrompt\([\s\S]*?modelWorkBlockedByRosterRecovery\(currentCtx\)/,
		/function restartFleetRow\([\s\S]*?modelWorkBlockedByRosterRecovery\(ctx\)/,
		/registerCommand\("af-research"[\s\S]*?handler: async \(args, ctx\) => \{[\s\S]*?modelWorkBlockedByRosterRecovery\(ctx\)/,
		/const researchContHandler[\s\S]*?modelWorkBlockedByRosterRecovery\(ctx\)/,
		/registerCommand\("af-agents-restart"[\s\S]*?handler: async \(args, ctx\) => \{[\s\S]*?modelWorkBlockedByRosterRecovery\(ctx\)/,
		/registerCommand\("af-handoff"[\s\S]*?handler: async \(args, ctx\) => \{[\s\S]*?modelWorkBlockedByRosterRecovery\(ctx\)/,
		/registerCommand\("af-compound"[\s\S]*?handler: async \(args, ctx\) => \{[\s\S]*?modelWorkBlockedByRosterRecovery\(ctx\)/,
	];
	for (const pattern of guardedBlocks) assert.match(indexSource, pattern);
});

test("same-turn lifecycle has one pre-model surface assembly point for normal and resumed remote turns", () => {
	const inputHook = indexSource.match(/pi\.on\("input", async \(event, ctx\) => \{[\s\S]*?\n\t\}\);/);
	const beforeHook = indexSource.match(/pi\.on\("before_agent_start", async \(_event, _ctx\) => buildHubSystemPrompt\(true\)\);/);
	assert.ok(inputHook, "incoming normal and remote messages share Pi's input hook");
	assert.ok(beforeHook, "all model turns share the before_agent_start hook");
	// Registration order is intentionally irrelevant: Pi invokes input before model startup.
	assert.match(indexSource, /pi\.on\("input", async \(event, ctx\) => \{[\s\S]*?resolveIncomingCapabilities\(incomingText\(event\)\);[\s\S]*?applyPostureTools\(\)/);
	assert.match(indexSource, /function buildHubSystemPrompt\(forTurn: boolean\)[\s\S]*?if \(forTurn\) \{[\s\S]*?applyPostureTools\(\)/);
	assert.doesNotMatch(indexSource, /classification model|classify.*model request|sendMessage\([\s\S]{0,100}classif/i);
});
