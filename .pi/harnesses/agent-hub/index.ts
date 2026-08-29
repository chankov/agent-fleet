/**
 * Agent Hub — Dispatcher orchestrator + embedded coms peer-to-peer layer
 *
 * The merged harness (plan: docs/plans/agent-hub-multi-agent-harness.md). It is
 * `agent-team` (dispatcher grid + per-agent model + kill/restart + /af-zoom +
 * read-only research helpers) with the `coms` P2P layer
 * EMBEDDED in the same extension — not stacked as a second `-e`, which would
 * double-register the --name/--purpose/... CLI flags and abort startup.
 *
 * So the dispatcher is ALSO a coms peer: it can use another long-lived peer as a
 * subagent (coms_send + coms_await), hand the whole session off to a peer
 * (/af-handoff), and be addressed by other peers as a subagent itself. If the coms
 * endpoint fails to bind, the harness degrades to a coms-less dispatcher
 * (comsReady=false withholds the coms_* tools).
 *
 * Commands:
 *   /af-agents-team          — switch active team
 *   /af-agents-list          — open the Fleet Dashboard
 *   /af-agents-history       — timeline of agent execution (durations + grand total)
 *   /af-context              — read-only full-screen context budget diagnostic
 *   /af-agent-model <persona>[.<role>] — switch a team or research persona's (or
 *                           delegate sub-role's) model from its declared candidates
 *   /af-agent-model-thinking <persona> — switch a team or research persona's thinking
 *                           level (off|minimal|low|medium|high|xhigh)
 *   /af-models [profile]     — apply a named model profile (.pi/agents/model-profiles.yaml)
 *   /af-agent-models-substitute [<source> <target>] — visually pick/save a session-wide model substitution
 *   /af-dispatch-policy      — show which members route to coms peers (.pi/agents/dispatch-policy.yaml)
 *   /af-agents-kill <name|rN|all> — SIGTERM a frozen specialist (and its delegation
 *                           tree); on a research helper it kills AND removes the
 *                           card + session ("all" clears every research helper)
 *   /af-agents-restart <name|rN> — kill + re-run its last task fresh (research: must
 *                           be finished; runs on a fresh session)
 *   /af-zoom <name|rN|child> — scrollable read-only view of an agent's stream
 *                           (team member, research helper rN, or delegate child id)
 *   /af-work-mode [operator|orchestrator]
 *                           — work mode picker (Alt+M)
 *
 * Finished research helpers are auto-pruned: auto-research pipe helpers as soon
 * as they finish (findings persist as files under findings/), dispatcher/persona
 * helpers beyond the `research-keep` most recent (default 4, overrides file).
 *   /af-handoff <peer>       — hand the session off to a coms peer (summarized brief)
 *   /af-coms                 — refresh the coms peer pool (--all / --project <name>)
 *   /af-compound [focus]     — end-of-session compound-learning pass: confirm this
 *                           session's lessons with the user, then dispatch the
 *                           documenter to land them in the project's rules/docs
 *
 * Shortcuts:
 *   Alt+A                 — open the Fleet Dashboard
 *   Alt+M                 — open the work mode picker (operator | orchestrator)
 *   Alt+Shift+A           — toggle the compact running-agents widget
 *   Alt+] / Alt+[         — compact view: mark next/previous running subagent
 *   Alt+\                 — compact view: zoom the marked subagent (Q/Esc closes)
 *
 * Note: the marker/zoom only affect what you *view* — typing always prompts the
 * main session (there is no transcript takeover; zoom is a modal overlay). main
 * is never a marker target.
 *
 * Identity flags (coms): --name --purpose --project --color --explicit
 *
 * Usage: just fleet hub
 * Direct guarded launch: pi -e .pi/harnesses/damage-control-continue/index.ts -e .pi/harnesses/agent-hub/index.ts
 */

import type { ExtensionAPI, ExtensionContext, ImageContent, Theme } from "@mariozechner/pi-coding-agent";
import { DynamicBorder, getMarkdownTheme as getPiMdTheme, copyToClipboard } from "@mariozechner/pi-coding-agent";
import {
	Text, Box, Container, Spacer, Markdown, matchesKey, Key,
	type AutocompleteItem, truncateToWidth, visibleWidth,
} from "@mariozechner/pi-tui";
import { spawn, type ChildProcess } from "child_process";
import { spawnPiAgent, spawnPiAgentWithModelFallback, killPiTree, type Termination } from "./spawn.ts";
import { researchTerminationOutcome, researchWatchdogSpawnOptions } from "./research-watchdog.ts";
import { composeFleetFooterHint, renderHubFooterLeft } from "./footer.ts";
import { HARNESS_VERSION, registerVersionStatus } from "./version.ts";
import { cancelLocalOwnedProcess, cancelLocalWaitOnly, monitorKeyForAgent } from "./monitor-control.ts";
import { createMonitorLifecycle, monitorLifecycleConfig } from "./monitor-lifecycle.ts";
import { MonitorRegistry } from "../lib/hermes-monitor-registry.ts";
import { MonitorStore } from "../lib/hermes-monitor-store.ts";
import { createMonitorSessionBridge } from "./monitor-session-bridge.ts";
import { MonitorRuntime } from "./monitor-runtime.ts";
import { MonitorEventJournal } from "../lib/hermes-monitor-events.ts";
import { MonitorInvokeJournal } from "./monitor-invoke-journal.ts";
import { createMonitorInvokeAdmission, createWatchdogFollowUpEnqueue } from "./monitor-invoke.ts";
import { monitorReconcileEvidence, stableMonitorHubId } from "./monitor-recovery.ts";
import {
	AGENT_ID_ENV, ASK_ENDPOINT_ENV, EXEMPTIONS_FILE_ENV,
	exemptionsFilePath, type AccessRequest,
} from "../lib/damage-control-shared.ts";
import { applyModelOverride, clampDelegateDepth, fallbackModelFor, isReadOnlyToolList, MAX_DELEGATE_DEPTH, normalizeAgentInput, orchestratorNeedsRoster, parseTeamsYaml, safeAgentKey, safePathWithin, taskFingerprint, upsertTeamInYaml } from "./helpers.ts";
import { DEFAULT_TASK_TIER, addTaskClockWait, applyTierChange, blockingFindingCap, budgetStatusLine, checkReviewRoundCap, checkTaskBudget, checkTierPersonaGate, checkTurnBudget, closeTaskClock, createTaskClock, isReviewPersona, openTaskClock, remainingTaskResearch, resetTaskClock, resolveTaskBudget, resolveTurnBudget, reviewBudgetClause, reviewRoundCap, taskClockElapsedMs } from "./run-budget.js";
import { buildBudgetContinuationAudit, buildHubAuditIdentity, buildTaskResetAudit } from "./hub-state-audit.js";
import { countReviewFindings, findingBudgetNotice } from "./review-findings.js";
import { checkDocsLane, docsLaneNotice } from "./docs-lane.js";
import { checkExternalBlockerGate, extractExternalBlockers } from "./external-blocker.js";
import { DEFAULT_RUN_HISTORY_KEEP, appendRunIndex, buildRunMeta, makeRunId, normalizeRunHistoryKeep, pruneRunDirs, RUN_INDEX_FILENAME, RUNS_DIRNAME } from "./run-namespace.js";
import { MAX_OPEN_ASSERTIONS, validateAssertionBatch } from "./assertion-ledger.js";
import { DEFAULT_PROVIDER_LIMITS, createProviderSemaphore, parseProviderLimits } from "./provider-semaphore.js";
import {
	PANE_PROMPT_TIMEOUT_MS,
	launchPeerInPane,
	peerReadyVerdict,
	unaddressedPeerSweep,
} from "../lib/spawned-peers.js";
import { contextPct, estimatePromptTokens, resolveContextWindow } from "./context-window.js";
import { DEFAULT_WATCHDOG_SETTING, WATCHDOG_SETTINGS, normalizeWatchdogSetting, resolveWatchdogActive } from "./drift-watchdog.js";
import { quarantineIfUnusable } from "./session-health.js";
import { shouldExtractReturn } from "./return-extract.js";
import { artifactPreviewFromText, formatInputArtifactsSection, resolveArtifactPaths, ARTIFACT_KINDS } from "./artifacts.js";
import { crossCheck, deliveryDisposition, extractAssertionIds, parseDeliveredReturn } from "./return-contract.js";
import { checkScope, diffAgainst, snapshotWorktree } from "./scope-gate.js";
import { validateEvidence } from "./evidence-rules.js";
import { comsRequiredRefusal, explicitComsRefusal, parseDispatchPolicy, resolveDispatchBackend } from "./backend-policy.js";
import { NATIVE_ROSTER_ENTRY_TYPE, WORK_MODE_ENTRY_TYPE, persistedNativeRosterState, workModePrompt, resolveWorkModeTools, resolveSessionWorkMode, resolveSessionRoster, type WorkMode } from "./work-mode.ts";
import {
	compactWorkMode,
	workModeChangeBlockedByRoster,
	workModePickerOptions,
	selectedPickerValue,
} from "./work-mode-controls.ts";
import { registerWorkMode } from "./commands/work-mode.ts";
import { registerAgentsTeam } from "./commands/agents-team.ts";
import { registerAgentsList } from "./commands/agents-list.ts";
import { registerAgentsHistory } from "./commands/agents-history.ts";
import { registerAgentsAdd } from "./commands/agents-add.ts";
import { registerAgentsDrop } from "./commands/agents-drop.ts";
import { registerAgentsSave } from "./commands/agents-save.ts";
import { registerAgentsKill } from "./commands/agents-kill.ts";
import { registerAgentsRestart } from "./commands/agents-restart.ts";
import { registerContextCommand } from "./commands/context-command.ts";
import { registerHubReport } from "./commands/hub-report.ts";
import { registerZoom } from "./commands/zoom.ts";
import { registerDispatchPolicy } from "./commands/dispatch-policy.ts";
import { registerAgentModel } from "./commands/agent-model.ts";
import { registerAgentModelThinking } from "./commands/agent-model-thinking.ts";
import { registerModels } from "./commands/models.ts";
import { registerAgentModelsSubstitute } from "./commands/agent-models-substitute.ts";
import { registerWatchdog } from "./commands/watchdog.ts";
import { registerComs } from "./commands/coms.ts";
import { registerHandoff } from "./commands/handoff.ts";
import { registerCompound } from "./commands/compound.ts";
import type { CommandContext } from "./commands/context.ts";
import { registerDispatchAgent } from "./tools/dispatch-agent.ts";
import { registerSpawnResearch } from "./tools/spawn-research.ts";
import { registerSetTaskTier } from "./tools/set-task-tier.ts";
import { registerTeamAdjust } from "./tools/team-adjust.ts";
import { registerVerificationContract } from "./tools/verification-contract.ts";
import { registerComsTools } from "./tools/coms-tools.ts";
import { paneTail, peerManifest, peerPersonaExists, registerFleetTools, spawnDelaySeconds, STAGGER_ENV_VAR, waitForPeerRegistration } from "./tools/fleet-tools.ts";
import type { ComsAwaitParams, ComsGetParams, ComsListParams, ComsSendParams, DispatchAgentParams, HerdrClosePaneParams, HerdrNotifyParams, HerdrReadPaneParams, HerdrSpawnPaneParams, HerdrSpawnPeerParams, SetAssertionsParams, SetTaskTierParams, SpawnResearchParams, TeamAdjustParams, ToolContext, ToolExecutionResult, ToolUpdate, UpdateAssertionParams } from "./tools/context.ts";
import { CAPABILITY_PACKS, latestPersistedCapabilityState, persistedCapabilityState, resolveCapabilityPacks, type CapabilityPack, type CapabilityResolution, type ContextState, type PendingOperation } from "./capability-packs.ts";
import { contextPressureDiagnostic, createContextPressureState, transitionContextPressure, type ContextPressureState } from "./context-pressure.ts";
import { confirmationGate, confirmationOutcome, capabilityConfirmationPack, capabilityConfirmationQuestion, type CapabilityConfirmationState, type ConfirmableCapabilityPack } from "./capability-confirmation.ts";
import { budgetContinuationInstruction, budgetContinuationKind, budgetContinuationOutcome, turnBudgetActiveMs, type BudgetContinuationKind } from "./budget-continuation.ts";
import { observeAskUserResults } from "../ask-user-remote/index.ts";
import { buildHubPeerSpawnPlan, launchHubPeerInPane } from "./peer-spawn-plan.ts";
import { DEFAULT_RESEARCH_KEEP, parseResearchKeep, selectResearchPrunable } from "./research-retention.js";
import { requireSafetyHarness, resolveSafetyHarness } from "./safety-routing.ts";
import { createAccessApprovalRouter } from "./access-approval.ts";
import { chmodSync, readdirSync, readFileSync, existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync, rmSync } from "fs";
import { herdrPaneId } from "../lib/herdr-presence.ts";
import { herdr as herdrApi, herdrAvailable } from "../lib/herdr-client.ts";
import {
	abbreviateModel,
	createComsPeer,
	hexFg,
	nowIso,
	readAllRegistryEntries,
	readAllRegistryEntriesAcrossProjects,
	type ComsIdentity,
	type RegistryEntry as ComsRegistryEntry,
	TIMEOUT_MS,
} from "../lib/coms-core.ts";
import { FULLSCREEN_OVERLAY, bodyRows, clampScroll } from "../lib/fleet-overlay.ts";
import { createPanelResources } from "../lib/fleet-panel.ts";
import { createGridUI } from "./ui/grid.ts";
import { openZoom, type TimelineEntry, type Zoomable } from "./ui/zoom.ts";
import { openHistory } from "./ui/history.ts";
import { createExecutionHistoryStore, type HistoryEntry } from "./ui/history-store.ts";
import { createDispatchComs, createDispatchNative, createDispatchObservability, type DelegationChild } from "./dispatch-core.ts";
import { buildFleetRows, fleetTiming, summarise, unionMs, type DelegateInput, type FleetRow, type FleetSource, type PeerInput, type ResearchInput, type SpecialistInput } from "../lib/fleet-read-model.ts";
import { attachFleetDashboardTicker, compactWidgetsEnabled, gridColumnsForSize, liveTimeline, resolveFleetKill, resolveFleetRestart } from "../lib/fleet-dashboard-ops.ts";
import { dashboardTransition, renderFleetDashboard, FLEET_CHROME_ROWS, type DashboardConfirm } from "../lib/fleet-dashboard-view.ts";
import { detailContent, detailEntryOffsets, detailTransition, fleetModelChoices, modelPickerTransition, normalizeFleetDetailInput, renderFleetDetail, renderFleetModelPicker, renderFleetSubstitutionPicker, DETAIL_CHROME_ROWS, type FleetDetailKey, type FleetModelChoice } from "../lib/fleet-detail-view.ts";
import { createFleetTranscriptStore, readFleetTranscript, readFleetTranscriptBefore, readFleetTranscriptTail, redactTimelineEvent, type FleetTranscriptRecord, type FleetTranscriptStore } from "../lib/fleet-transcript-store.ts";
import { reconcileSelection, type Selection } from "../lib/fleet-selection.ts";
import { collectContextBudgetSnapshot, type LivePlane } from "./context-budget-snapshot.ts";
import { CONTEXT_BUDGET_CHROME_ROWS, contextBudgetTransition, renderContextBudget, type ContextBudgetViewState } from "../lib/context-budget-view.ts";
import { component, safeSchemaChars, type ContextBudgetComponent } from "../lib/context-budget.ts";
import { assembleHubSystemPrompt, HUB_HERDR_SECTION, namedHubLedgerParts, recordHubLedger } from "../lib/context-budget-hub-prompt.ts";
import {
	delegateStandingParts,
	buildSpecialistContextManifest,
	nativeResearchSystemPrompt,
	nativeSpecialistSystemPrompt,
	researchStandingParts,
	type SpecialistContextManifest,
	specialistStandingParts,
} from "../lib/context-budget-child-prompt.ts";
import { parseEnvFile, resolveEnvFilePath } from "../../../scripts/lib/herdr-layout.ts";
import { worktreeTag } from "../../../scripts/lib/team-project.ts";
import { join, resolve } from "path";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { fileURLToPath } from "node:url";

// ── Types ────────────────────────────────────────

interface AgentDef {
	name: string;
	description: string;
	tools: string;
	model?: string;
	// Original frontmatter model retained when project/session overrides apply.
	fallbackModel?: string;
	// Allowed switch targets for /af-agent-model and model profiles (frontmatter
	// `models:` list). The default `model:` is implicitly a candidate too.
	models?: string[];
	// Mid-turn delegation (injected delegate tool): the sub-roles this persona
	// may spawn, each with a model and an optional tool cap (frontmatter
	// `subagents:` map). Model choice is configuration, never the child LLM's.
	subagents?: Record<string, SubagentRole>;
	// How deep this persona's delegation tree may go (frontmatter
	// `delegate_depth:`). Default 1: it can spawn children, they cannot.
	delegateDepth?: number;
	// Non-fatal frontmatter problems (e.g. a subagents role without a model),
	// surfaced once at session start.
	warnings?: string[];
	kind?: string;
	// Per-agent thinking level for `/af-zoom` debugging. A pi --thinking level
	// (off|minimal|low|medium|high|xhigh), default off. When non-off, thinking
	// deltas are captured into the zoom timeline.
	thinking?: string;
	systemPrompt: string;
	file: string;
}

interface InputArtifactPreview {
	input: string;
	path: string;
	displayPath: string;
	preview: string;
	/** Set when the file was found under a different artifact kind than requested. */
	resolvedFromKind?: string | null;
}

interface AgentState {
	def: AgentDef;
	status: "idle" | "running" | "done" | "error";
	task: string;
	toolCount: number;
	elapsed: number;
	lastWork: string;
	contextPct: number;
	// Last measured prompt size in tokens (input + cache reads + writes). Kept
	// alongside contextPct because the pre-spawn guard needs the absolute number:
	// a percentage cannot be compared against a window it was not divided by.
	contextTokens: number;
	sessionFile: string | null;
	/** Metadata-only child context retained across research-pause resume. */
	specialistManifest?: SpecialistContextManifest;
	runCount: number;
	// Runs served by the CURRENT accumulated session (-c resume chain). Reset on
	// recycle; drives shouldRecycleSession together with the measured contextPct.
	runsSinceFresh: number;
	timer?: ReturnType<typeof setInterval>;
	// Mid-turn delegation (delegate tool). Children parsed live from the event
	// file, keyed by child id; rendered as nested rows under the card and kept
	// after completion for post-hoc /af-zoom. Reset on each dispatch.
	delegations?: Map<string, DelegationChild>;
	delegationsWatcher?: { close(): void };
	// Kill / restart (Phase 2). The live child is stored so a frozen specialist
	// can be SIGTERM'd. `killedByOperator` tells the close handler the exit was an
	// operator kill (so it returns a "do not auto-retry" message instead of a
	// normal error); `restarting` distinguishes a kill-for-restart from a plain
	// kill; `onTerminate` lets /af-agents-restart await the kill before re-dispatching.
	proc?: ChildProcess;
	killedByOperator?: boolean;
	restarting?: boolean;
	onTerminate?: () => void;
	// Zoom timeline (Phase 3). A structured, persisted record of the specialist's
	// stream — coalesced assistant text, tool calls (name + args), and thinking
	// deltas when the persona opts in. `/af-zoom` renders this; it survives completion
	// so post-hoc zoom works without reading the session file. `zoomRender` is set
	// while a `/af-zoom` overlay is open so the stream parser can refresh it live
	// (throttled; pass force=true for the final frame).
	timeline: TimelineEntry[];
	transcriptStore?: FleetTranscriptStore;
	zoomRender?: (force?: boolean) => void;
	// The /af-agents-history node for the current dispatch, so delegate children parsed
	// from the event file can attach to it as the root parent of their subtree.
	histEntry?: HistoryEntry;
	// Coms-backed dispatch (dispatch-policy.yaml): which backend served the last
	// run, the peer's model for the card badge, and the abandon hook /af-agents-kill
	// and /af-agents-restart use instead of a SIGTERM — the standing peer itself
	// cannot be killed from the hub, only the wait can be released.
	lastBackend?: "native" | "coms";
	comsPeerModel?: string;
	comsAbort?: () => void;
}

// A read-only research helper (Phase 4). Spawned on demand to assist the standing
// team with reconnaissance/search/doc-reading — it never writes and never runs bash.
// Keyed by a numeric id surfaced to the operator as the handle `rN`. Ephemeral by
// construction: session files live under the same dir as team sessions and are wiped
// on session_start; finished helpers are auto-pruned per the retention policy
// (research-retention.js — auto-pipe helpers immediately, older durable ones beyond
// the `research-keep` cap); `/af-agents-kill rN` kills AND removes one by hand.
// Retained finished helpers remain inspectable and can be re-run fresh with
// `/af-agents-restart rN`.
interface ResearchState {
	id: number;
	def: AgentDef;        // a `kind: research` persona, or a synthesized def for anon helpers
	persona: boolean;     // true → spawned from a persona; false → ad-hoc anonymous
	ephemeral: boolean;   // true → auto-research pipe spawn: pruned as soon as it finishes
	model: string;        // resolved pi model spec (shown on the card)
	status: "idle" | "running" | "done" | "error";
	task: string;
	toolCount: number;
	elapsed: number;
	lastWork: string;
	contextPct: number;
	contextTokens: number;
	sessionFile: string | null;  // set after a successful run → enables `-c` resume
	turnCount: number;
	finishedAt?: number;  // last time a run ended (any status) — LRU key for retention
	timer?: ReturnType<typeof setInterval>;
	proc?: ChildProcess;
	killedByOperator?: boolean;
	timeline: TimelineEntry[];
	transcriptStore?: FleetTranscriptStore;
	zoomRender?: (force?: boolean) => void;
	histEntry?: HistoryEntry;
}

// ── Display Name Helper ──────────────────────────

function displayName(name: string): string {
	return name.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

// ── ASK_USER: marker extraction ──────────────────
// Specialists emit `ASK_USER: <question>` per the clarification protocol injected
// into their system prompt. We pull them out so the dispatcher can surface each.

function extractAskUserQuestions(output: string): string[] {
	const questions: string[] = [];
	for (const rawLine of output.split("\n")) {
		const line = rawLine.trim();
		const match = line.match(/^ASK_USER\s*:\s*(.+)$/i);
		if (match) {
			const q = match[1].trim();
			if (q && !questions.includes(q)) questions.push(q);
		}
	}
	return questions;
}

// ── NEEDS_RESEARCH: marker extraction ────────────
// Specialists emit `NEEDS_RESEARCH: <question>` per the research protocol when they
// need reconnaissance they cannot perform with their own tools. The HUB (not the
// dispatcher LLM) intercepts these in code: it fans out read-only research helpers,
// writes each helper's findings to a file under .pi/agent-sessions/findings/, and
// resumes the specialist's session with the file paths — so large findings never
// pass through the dispatcher's context.

function extractNeedsResearch(output: string): string[] {
	const questions: string[] = [];
	for (const rawLine of output.split("\n")) {
		const line = rawLine.trim();
		const match = line.match(/^NEEDS_RESEARCH\s*:\s*(.+)$/i);
		if (match) {
			const q = match[1].trim();
			if (q && !questions.includes(q)) questions.push(q);
		}
	}
	return questions;
}

// ── Overrides Parser (.ai/agent-fleet-overrides.md) ──
// Reads the `## agent-hub` section (`## agent-team` is accepted as a legacy
// alias; when both are present their keys merge, later lines winning).
// Supported keys:
//   language: <name>           — user-facing language. Default: English.
//   model.<persona>: <spec>    — replace the persona's default model for this project.
//   models.<persona>: <a>, <b> — replace the persona's model candidate list.
//   thinking.<persona>: <level> — replace the persona's thinking level for this
//                              project (off|minimal|low|medium|high|xhigh).
//   subagents.<persona>.<role>: <model>[, tools=<caps>]
//                              — replace/add one delegate sub-role for this project.
//   delegate-depth.<persona>: <n> — replace the persona's delegation depth budget.
//   rules: <dir>[, <dir>...]   — repo-relative folders of project rule files (HOW —
//                              compliance). Personas resolve them index-first: a
//                              folder's top-level README.md/index.md is a loading
//                              manifest when present; otherwise the folder is
//                              searched recursively.
//   docs: <path>[, <path>...]  — repo-relative documentation entry points (WHAT/WHY —
//                              orientation): canonical files (e.g. Docs/AGENTS.md) or
//                              doc folders. Specialists and research helpers read the
//                              ones relevant to their task; context, not compliance.
//   research-keep: <n>|all     — how many finished durable/persona research helpers
//                              to retain for inspection/restart (LRU, default 4);
//                              "all" disables pruning. Auto-research pipe helpers
//                              are always pruned as soon as they finish.
//   recon-search-timeout-s: <1..3600>|off — parent-side deadline for each
//                              read/grep/find/ls call made by research helpers
//                              and read-only delegate children (default 120).
//   mode:                      — REMOVED. Ignored with a warning; budgets follow
//                              task tier (see run-budget.js).
//   max-dispatches-per-turn: <n>|off — ceiling on dispatch_agent calls per user turn
//                              (min with the task-tier envelope; "off" stays at the tier).
//   max-research-per-turn: <n>|off — spawn_research calls allowed per user turn.
//   turn-wall-time-s: <n>|off  — active-time budget per user turn (ask_user waits excluded).
//   agent-turn-timeout-s: <n>|off — whole-run deadline for each spawned
//                              specialist/research/delegate run (not per tool).
//   session-recycle-runs: <n>|off — recycle a specialist's accumulated session
//                              after this many resumed runs (also recycled at
//                              ≥60% measured context regardless).
//   watchdog: on|off|auto      — drift watchdog default for dispatched
//                              specialists (default auto; see drift-watchdog.js).
//   watchdog-judge-model: <model spec> — model for the drift judge (default:
//                              the researcher persona's model, else the
//                              dispatcher's).
//   run-history-keep: <n>|off  — how many previous sessions' artifact archives to
//                              retain under .pi/agent-sessions/runs/ (default 10).
//                              Each session archives the previous one's artifacts
//                              into an immutable runs/<runId>/ namespace instead of
//                              deleting them; "off" retains every run.

interface AgentTeamOverrides {
	language: string;
	personaModels: Record<string, string>;
	personaModelLists: Record<string, string[]>;
	personaThinking: Record<string, string>;
	personaSubagents: Record<string, Record<string, SubagentRole>>;
	personaDelegateDepth: Record<string, number>;
	rulesDirs: string[];
	docsPaths: string[];
	researchKeep: number;
	reconSearchTimeoutMs: number | null;
	// Per-axis turn-budget ceilings for run-budget.js resolveTurnBudget():
	// number is min()'d with the task tier; null/"off" stays at the tier.
	budgetOverrides: {
		maxDispatches?: number | null;
		maxResearch?: number | null;
		wallMs?: number | null;
		agentTurnMs?: number | null;
		recycleRuns?: number | null;
	};
	watchdogSetting: string;
	watchdogJudgeModel: string | null;
	// How many previous sessions' artifact archives to keep under
	// .pi/agent-sessions/runs/ (run-namespace.js). null = keep everything.
	runHistoryKeep: number | null;
	warnings: string[];
}

const DEFAULT_OVERRIDES: AgentTeamOverrides = {
	language: "English",
	personaModels: {},
	personaModelLists: {},
	personaThinking: {},
	personaSubagents: {},
	personaDelegateDepth: {},
	rulesDirs: [],
	docsPaths: [],
	researchKeep: DEFAULT_RESEARCH_KEEP,
	reconSearchTimeoutMs: 120_000,
	budgetOverrides: {},
	watchdogSetting: DEFAULT_WATCHDOG_SETTING,
	watchdogJudgeModel: null,
	runHistoryKeep: DEFAULT_RUN_HISTORY_KEEP,
	warnings: [],
};

function freshOverrides(): AgentTeamOverrides {
	return {
		...DEFAULT_OVERRIDES,
		personaModels: {},
		personaModelLists: {},
		personaThinking: {},
		personaSubagents: {},
		personaDelegateDepth: {},
		rulesDirs: [],
		docsPaths: [],
		budgetOverrides: {},
		warnings: [],
	};
}

function parseAgentTeamOverrides(cwd: string): AgentTeamOverrides {
	const path = join(cwd, ".ai", "agent-fleet-overrides.md");
	if (!existsSync(path)) return freshOverrides();

	let raw: string;
	try {
		raw = readFileSync(path, "utf-8");
	} catch {
		return freshOverrides();
	}

	const result: AgentTeamOverrides = freshOverrides();
	let inSection = false;
	for (const rawLine of raw.split("\n")) {
		const line = rawLine.replace(/\r$/, "");
		const heading = line.match(/^##\s+(.+?)\s*$/);
		if (heading) {
			const name = heading[1].trim().toLowerCase();
			inSection = name === "agent-hub" || name === "agent-team";
			continue;
		}
		if (!inSection) continue;
		const kv = line.match(/^\s*([a-zA-Z][\w.-]*)\s*:\s*(.+?)\s*$/);
		if (!kv) continue;
		const key = kv[1].toLowerCase();
		const value = kv[2].trim();
		if (key === "language" && value) result.language = value;
		if (key === "rules" && value) {
			result.rulesDirs = value.split(",").map(s => s.trim()).filter(Boolean);
		}
		if (key === "docs" && value) {
			result.docsPaths = value.split(",").map(s => s.trim()).filter(Boolean);
		}
		if (key === "run-history-keep" && value) {
			const keep = normalizeRunHistoryKeep(value);
			if (keep === undefined) {
				result.warnings.push(`run-history-keep "${value}" is not a positive integer or "off" — using the default (${DEFAULT_RUN_HISTORY_KEEP})`);
			} else {
				result.runHistoryKeep = keep;
			}
		}
		if (key === "research-keep" && value) {
			const keep = parseResearchKeep(value);
			if (keep != null) {
				result.researchKeep = keep;
			} else {
				result.warnings.push(`research-keep "${value}" is not a non-negative integer or "all" — using the default (${DEFAULT_RESEARCH_KEEP})`);
			}
		}
		if (key === "recon-search-timeout-s" && value) {
			if (value.toLowerCase() === "off") {
				result.reconSearchTimeoutMs = null;
			} else if (/^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 3600) {
				result.reconSearchTimeoutMs = Number(value) * 1000;
			} else {
				result.warnings.push(`recon-search-timeout-s "${value}" is not an integer from 1 to 3600 or "off" — using the default (120)`);
			}
		}
		if (key === "mode" && value) {
			result.warnings.push(`mode "${value}" is ignored — execution modes were removed; budgets follow task tier. Remove this key.`);
		}
		if (key === "watchdog" && value) {
			const setting = normalizeWatchdogSetting(value);
			if (setting) {
				result.watchdogSetting = setting;
			} else {
				result.warnings.push(`watchdog "${value}" is not one of ${WATCHDOG_SETTINGS.join("|")} — using the default (${DEFAULT_WATCHDOG_SETTING})`);
			}
		}
		if (key === "watchdog-judge-model" && value) result.watchdogJudgeModel = value;
		// Turn-budget keys: a positive integer is a ceiling (min with the tier);
		// "off" stays at the tier. Counts are unitless; *-s keys are seconds → ms.
		const budgetKeys: Record<string, { field: keyof AgentTeamOverrides["budgetOverrides"]; scaleMs: boolean }> = {
			"max-dispatches-per-turn": { field: "maxDispatches", scaleMs: false },
			"max-research-per-turn": { field: "maxResearch", scaleMs: false },
			"turn-wall-time-s": { field: "wallMs", scaleMs: true },
			"agent-turn-timeout-s": { field: "agentTurnMs", scaleMs: true },
			"session-recycle-runs": { field: "recycleRuns", scaleMs: false },
		};
		if (budgetKeys[key] && value) {
			const { field, scaleMs } = budgetKeys[key];
			if (value.toLowerCase() === "off") {
				result.budgetOverrides[field] = null;
			} else if (/^\d+$/.test(value) && Number(value) >= 1) {
				result.budgetOverrides[field] = Number(value) * (scaleMs ? 1000 : 1);
			} else {
				result.warnings.push(`${key} "${value}" is not a positive integer or "off" — using the task-tier default`);
			}
		}
		const slug = "[a-z0-9]+(?:-[a-z0-9]+)*";
		const modelKey = key.match(new RegExp(`^model\\.(${slug})$`));
		if (modelKey && value) result.personaModels[modelKey[1]] = value;
		const modelsKey = key.match(new RegExp(`^models\\.(${slug})$`));
		if (modelsKey && value) {
			result.personaModelLists[modelsKey[1]] = value.split(",").map(s => s.trim()).filter(Boolean);
		}
		const thinkingKey = key.match(new RegExp(`^thinking\\.(${slug})$`));
		if (thinkingKey && value) {
			const level = value.toLowerCase();
			if (VALID_THINKING_LEVELS.has(level)) {
				result.personaThinking[thinkingKey[1]] = level;
			} else {
				result.warnings.push(`thinking.${thinkingKey[1]} "${value}" is not a valid level (off|minimal|low|medium|high|xhigh) — ignored`);
			}
		}
		const subKey = key.match(new RegExp(`^subagents\\.(${slug})\\.(${slug})$`));
		if (subKey && value) {
			// `<model>` or `<model>, tools=<caps>` — the caps list itself contains
			// commas, hence the anchored optional group instead of a comma split.
			const m = value.match(/^(\S+?)(?:\s*,\s*tools\s*=\s*([\w,-]+))?$/);
			if (m) {
				(result.personaSubagents[subKey[1]] ||= {})[subKey[2]] = {
					model: m[1],
					...(m[2] ? { tools: m[2] } : {}),
				};
			}
		}
		const depthKey = key.match(new RegExp(`^delegate-depth\\.(${slug})$`));
		if (depthKey && value) {
			const n = Number(value);
			if (Number.isInteger(n) && n >= 0) {
				result.personaDelegateDepth[depthKey[1]] = clampDelegateDepth(n);
				if (n > MAX_DELEGATE_DEPTH) {
					result.warnings.push(`delegate-depth.${depthKey[1]} ${n} exceeds the maximum (${MAX_DELEGATE_DEPTH}) — clamped to ${MAX_DELEGATE_DEPTH}`);
				}
			}
		}
	}
	return result;
}

// ── Model Profiles Parser (.pi/agents/model-profiles.yaml) ──
// Two-level YAML: profile name → persona → model spec. Validated at session
// start against each persona's declared candidates; an invalid entry drops the
// whole profile (never a partial apply).

function parseModelProfilesYaml(raw: string): Record<string, Record<string, string>> {
	const profiles: Record<string, Record<string, string>> = {};
	let current: string | null = null;
	for (const line of raw.split("\n")) {
		if (/^\s*(#|$)/.test(line)) continue;
		const top = line.match(/^(\S[^:]*):\s*$/);
		if (top) {
			current = top[1].trim();
			profiles[current] = {};
			continue;
		}
		const kv = line.match(/^\s+([\w-]+)\s*:\s*(.+?)\s*$/);
		if (kv && current) profiles[current][kv[1].toLowerCase()] = kv[2];
	}
	return profiles;
}

// ── Frontmatter Parser ───────────────────────────

// One declared delegate sub-role: the model the child runs on and an optional
// tool cap that wins over tool inheritance (see delegate.ts write safety).
interface SubagentRole {
	model: string;
	tools?: string;
	// Original role model retained across project/session overrides.
	fallbackModel?: string;
}

// Inline forms of a subagents role value: `role: <model-spec>` shorthand or
// `role: { model: x, tools: a,b }`. Regex extraction (not comma-splitting)
// because the tools cap itself contains commas.
function parseInlineSubagentRole(v: string): { model?: string; tools?: string } {
	const s = v.trim();
	if (!s) return {};
	if (s.startsWith("{")) {
		const model = s.match(/model\s*:\s*([^\s,}]+)/)?.[1];
		const tools = s.match(/tools\s*:\s*([\w,-]+)/)?.[1];
		return { ...(model ? { model } : {}), ...(tools ? { tools } : {}) };
	}
	return { model: s };
}

function parseAgentFile(filePath: string): AgentDef | null {
	try {
		const raw = readFileSync(filePath, "utf-8");
		const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
		if (!match) return null;

		const frontmatter: Record<string, string> = {};
		const lists: Record<string, string[]> = {};
		const warnings: string[] = [];
		let subagents: Record<string, SubagentRole> | undefined;
		const fmLines = match[1].split("\n");
		for (let i = 0; i < fmLines.length; i++) {
			const line = fmLines[i];
			const idx = line.indexOf(":");
			if (idx <= 0) continue;
			const key = line.slice(0, idx).trim();
			const value = line.slice(idx + 1).trim();
			if (key === "subagents") {
				// One-level role map. Each role is `role: <model>`, an inline
				// `role: { model: x, tools: y }`, or an indented `model:`/`tools:`
				// block. Malformed roles are skipped with a warning, never fatal.
				const entries: Record<string, { model?: string; tools?: string }> = {};
				let currentRole: string | null = null;
				let roleIndent = -1;
				let j = i + 1;
				while (j < fmLines.length) {
					const m = fmLines[j].match(/^(\s+)([a-z0-9]+(?:-[a-z0-9]+)*)\s*:\s*(.*)$/);
					if (!m) break;
					const ind = m[1].length;
					if (roleIndent === -1) roleIndent = ind;
					if (ind < roleIndent) break;
					if (ind === roleIndent) {
						currentRole = m[2];
						entries[currentRole] = parseInlineSubagentRole(m[3]);
					} else if (currentRole) {
						const v = m[3].trim();
						if (m[2] === "model" && v) entries[currentRole].model = v;
						else if (m[2] === "tools" && v) entries[currentRole].tools = v;
					}
					j++;
				}
				i = j - 1;
				const roles: Record<string, SubagentRole> = {};
				for (const [role, e] of Object.entries(entries)) {
					if (e.model) roles[role] = { model: e.model, ...(e.tools ? { tools: e.tools } : {}) };
					else warnings.push(`subagents role "${role}" declares no model — skipped`);
				}
				if (Object.keys(roles).length > 0) subagents = roles;
				continue;
			}
			if (value) {
				frontmatter[key] = value;
				continue;
			}
			// Empty value → possibly a YAML list (e.g. `models:` followed by `- item`
			// lines). Consume the indented items so they aren't re-parsed as keys.
			const items: string[] = [];
			let j = i + 1;
			while (j < fmLines.length) {
				const m = fmLines[j].match(/^\s+-\s+(.+)$/);
				if (!m) break;
				items.push(m[1].trim());
				j++;
			}
			if (items.length > 0) {
				lists[key] = items;
				i = j - 1;
			}
		}

		if (!frontmatter.name) return null;
		try {
			safeAgentKey(frontmatter.name);
		} catch {
			return null;
		}

		let delegateDepth: number | undefined;
		if (frontmatter.delegate_depth !== undefined) {
			const n = Number(frontmatter.delegate_depth);
			if (Number.isInteger(n) && n >= 0) {
				delegateDepth = clampDelegateDepth(n);
				if (n > MAX_DELEGATE_DEPTH) warnings.push(`delegate_depth "${frontmatter.delegate_depth}" exceeds the maximum (${MAX_DELEGATE_DEPTH}) — clamped to ${MAX_DELEGATE_DEPTH}`);
			} else {
				warnings.push(`delegate_depth "${frontmatter.delegate_depth}" is not a non-negative integer — using default (1)`);
			}
		}

		return {
			name: frontmatter.name,
			description: frontmatter.description || "",
			tools: frontmatter.tools || "read,grep,find,ls",
			model: frontmatter.model || undefined,
			models: lists.models,
			subagents,
			delegateDepth,
			warnings: warnings.length > 0 ? warnings : undefined,
			kind: frontmatter.kind || undefined,
			thinking: frontmatter.thinking || undefined,
			systemPrompt: match[2].trim(),
			file: filePath,
		};
	} catch {
		return null;
	}
}

// ── Thinking level + timeline helpers (Phase 3) ──

// pi --thinking levels, off→xhigh. Single source of truth for the validator, the
// /af-agent-model-thinking picker, and the display badge.
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
const VALID_THINKING_LEVELS = new Set<string>(THINKING_LEVELS);

// Map a persona's `thinking:` frontmatter value to a pi --thinking level.
// Pass-through for valid levels; truthy words ("on"/"true"/"yes"/"1") → "low";
// anything else (or unset) → "off".
function resolveThinkingLevel(raw?: string): string {
	if (!raw) return "off";
	const v = raw.trim().toLowerCase();
	if (VALID_THINKING_LEVELS.has(v)) return v;
	if (v === "on" || v === "true" || v === "yes" || v === "1") return "low";
	return "off";
}

// Short display codes for the thinking level, shown as a "(code)" badge after the
// model in cards + the compact view (e.g. gpt-5.5 (xh)). `off` → "" so no badge
// renders for the common no-extended-thinking case.
const THINKING_ABBREV: Record<string, string> = {
	off: "",
	minimal: "min",
	low: "low",
	medium: "med",
	high: "hi",
	xhigh: "xh",
};

function abbrevThinking(level: string): string {
	return THINKING_ABBREV[level] ?? "";
}

const MAX_LIVE_TIMELINE_ENTRIES = 500;
const MAX_LIVE_ENTRY_CHARS = 64 * 1024;

type TimelineTarget = {
	timeline: TimelineEntry[];
	transcriptStore?: FleetTranscriptStore;
	transcriptPending?: TimelineEntry;
	transcriptFlushTimer?: ReturnType<typeof setTimeout>;
	zoomRender?: (force?: boolean) => void;
};

function flushTimelineStore(target: TimelineTarget): void {
	if (target.transcriptFlushTimer) clearTimeout(target.transcriptFlushTimer);
	target.transcriptFlushTimer = undefined;
	if (!target.transcriptPending) return;
	target.transcriptStore?.append(target.transcriptPending as any);
	target.transcriptPending = undefined;
}

/** Redact before both persistence and display, while keeping live memory bounded. */
function appendTimelineEvent(target: TimelineTarget, event: TimelineEntry): TimelineEntry {
	flushTimelineStore(target);
	const safe = redactTimelineEvent(event) as TimelineEntry;
	target.transcriptStore?.append(safe as any);
	target.timeline.push({ ...safe, content: safe.content.slice(-MAX_LIVE_ENTRY_CHARS) });
	if (target.timeline.length > MAX_LIVE_TIMELINE_ENTRIES) target.timeline.splice(0, target.timeline.length - MAX_LIVE_TIMELINE_ENTRIES);
	return safe;
}

// Coalesce streaming deltas in the bounded live window; the append-only store
// still receives every redacted delta, so compacting memory cannot lose history.
function appendTimelineText(target: TimelineTarget, kind: "text" | "thinking", delta: string) {
	if (!delta) return;
	const safe = redactTimelineEvent({ kind, title: kind === "text" ? "Assistant" : "Thinking", content: delta, timestamp: Date.now() }) as TimelineEntry;
	if (target.transcriptPending?.kind === kind) target.transcriptPending.content += safe.content;
	else {
		flushTimelineStore(target);
		target.transcriptPending = { ...safe };
	}
	if (!target.transcriptFlushTimer) {
		target.transcriptFlushTimer = setTimeout(() => {
			flushTimelineStore(target);
			target.zoomRender?.();
		}, 100);
		try { (target.transcriptFlushTimer as any).unref?.(); } catch {}
	}
	let remaining = safe.content;
	while (remaining) {
		const last = target.timeline[target.timeline.length - 1];
		if (last && last.kind === kind && last.content.length < MAX_LIVE_ENTRY_CHARS) {
			const room = MAX_LIVE_ENTRY_CHARS - last.content.length;
			last.content += remaining.slice(0, room);
			remaining = remaining.slice(room);
		} else {
			target.timeline.push({ ...safe, content: remaining.slice(0, MAX_LIVE_ENTRY_CHARS) });
			remaining = remaining.slice(MAX_LIVE_ENTRY_CHARS);
		}
	}
	if (target.timeline.length > MAX_LIVE_TIMELINE_ENTRIES) target.timeline.splice(0, target.timeline.length - MAX_LIVE_TIMELINE_ENTRIES);
}

// ── Zoom overlay (Phase 3) ───────────────────────
// Read-only, scrollable view of one specialist's stream, modelled on the
// session-replay overlay but reading a *live* AgentState.timeline so it updates
// while the agent runs. Holds a reference to the state (not a snapshot) so each
// render reflects newly-streamed events.

// ── Research helpers (Phase 4) ───────────────────
// Read-only by construction: a research helper only ever gets these tools — no bash,
// no write/edit — regardless of what its persona declares. This is the defining
// constraint of a research helper vs. a full specialist (requirement 3).
const RESEARCH_TOOLS = "read,grep,find,ls";

// Auto-research pipe budgets: how many NEEDS_RESEARCH pause/resume rounds a single
// dispatch_agent call may trigger, and how many questions are honored per round.
const MAX_AUTO_RESEARCH_ROUNDS = 2;
const MAX_AUTO_RESEARCH_QUESTIONS = 4;
const CONTEXT_WARN_THRESHOLD = 70;

// Conservative delegation budgets: one delegate layer only, with four total
// child spawns reserved tree-wide for a dispatch.

// System prompt for an ad-hoc (anonymous) research helper — one with no persona file.
const ANON_RESEARCH_PROMPT = `# Research Helper

You are an ad-hoc read-only research helper assisting a team of specialist agents.
Locate the relevant code or docs, read the surrounding context, and report concise,
well-cited findings the rest of the team can act on.`;

// Parse a research handle: "r3", "R3", "#3", or bare "3" → 3. null if not a handle.
function parseResearchHandle(arg: string): number | null {
	const m = arg.trim().match(/^#?r?(\d+)$/i);
	return m ? parseInt(m[1], 10) : null;
}

function scanAgentDirs(cwd: string): AgentDef[] {
	const dirs = [
		join(cwd, "agents"),
		join(cwd, ".claude", "agents"),
		join(cwd, ".pi", "agents"),
	];

	const agents: AgentDef[] = [];
	const seen = new Set<string>();

	for (const dir of dirs) {
		if (!existsSync(dir)) continue;
		try {
			for (const file of readdirSync(dir)) {
				if (!file.endsWith(".md")) continue;
				const fullPath = resolve(dir, file);
				const def = parseAgentFile(fullPath);
				if (def && !seen.has(def.name.toLowerCase())) {
					seen.add(def.name.toLowerCase());
					agents.push(def);
				}
			}
		} catch {}
	}

	return agents;
}

// Persona names whose read-only tools receive the research watchdog policy.
const RESEARCHER_PERSONAS = new Set(["researcher", "deep-researcher"]);
// Existing native fallback-status formatting resolves this lazily inside its callback.
declare const shortModel: (model: string) => string;

// The delegate extension injected into specialists that declare `subagents:`.
// It lives next to this file; fall back to the conventional project path when
// import.meta resolution doesn't map to a real file (e.g. a bundling loader).
function resolveDelegateExtension(cwd: string): string | null {
	try {
		const p = fileURLToPath(new URL("./delegate.ts", import.meta.url));
		if (existsSync(p)) return p;
	} catch {}
	const local = join(cwd, ".pi", "harnesses", "agent-hub", "delegate.ts");
	return existsSync(local) ? local : null;
}

// ── Extension ────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// ── Embedded coms: identity CLI flags ──
	// Registered here (factory load time) so pi's CLI parser accepts them. Because
	// coms is EMBEDDED (one extension, not a second `-e`), these register exactly once.
	pi.registerFlag("name", { description: "Coms: override agent name (else frontmatter or auto-generated)", type: "string", default: undefined });
	pi.registerFlag("purpose", { description: "Coms: override agent purpose (else frontmatter description)", type: "string", default: undefined });
	pi.registerFlag("project", { description: "Coms: project namespace for peer discovery", type: "string", default: "default" });
	pi.registerFlag("color", { description: "Coms: hex color #RRGGBB (else frontmatter or palette fallback)", type: "string", default: undefined });
	pi.registerFlag("explicit", { description: "Coms: hide from auto-discovery; addressable only by exact name", type: "boolean", default: false });
	pi.registerFlag("solo", { description: "Run without the coms layer (fixed specialists + research only — `just fleet hub --solo`)", type: "boolean", default: false });
	pi.registerFlag("work-mode", { description: "Fleet main-agent work mode: operator|orchestrator", type: "string", default: undefined });
	pi.registerFlag("agent-team", { description: "Internal: activate a named native roster from .pi/agents/teams.yaml", type: "string", default: undefined });

	// ── Embedded coms: shared peer state ──
	let currentCtx: ExtensionContext | null = null;
	const coms = createComsPeer({
		pi,
		getContext: () => currentCtx,
		onPeersChanged: () => { if (currentCtx?.hasUI) installPoolWidget(currentCtx); },
		acceptInbound: () => currentCtx && modelWorkBlockedByRosterRecovery(currentCtx)
			? "orchestrator roster recovery required"
			: null,
		handleCustomEnvelope: (socket, envelope) => {
			if (envelope.type !== "access_request") return false;
			void accessApprovalRouter.handle(socket, envelope as AccessRequest);
			return true;
		},
	});
	let identity: ComsIdentity | null = null;
	const peerCards = coms.peerCards;
	const pendingReplies = coms.pendingReplies;
	const inboundQueue = coms.inboundQueue;
	let comsReady = false;
	let monitorLifecycle: ReturnType<typeof createMonitorLifecycle> | null = null;
	let monitorHubId: string | null = null;
	let monitorTurnId: string | null = null;
	let monitorBridge: ReturnType<typeof createMonitorSessionBridge> | null = null;
	let monitorOwnerId: string | undefined;

	// ── Damage-control exemptions + access escalation state ──
	// exemptionsFile is the session-scoped shared exemptions file: /af-allow
	// session grants (via the co-loaded damage-control-continue) and approved
	// escalations land here, and spawned children read it through the
	// AGENT_HUB_EXEMPTIONS_FILE env plumbing.
	let exemptionsFile: string | null = null;
	const accessApprovalRouter = createAccessApprovalRouter({
		getContext: () => currentCtx,
		getExemptionsFile: () => exemptionsFile,
		appendLog: (entry) => { try { pi.appendEntry("damage-control-log", entry); } catch { /* best-effort */ } },
		now: nowIso,
	});

	const agentStates: Map<string, AgentState> = new Map();
	// Read-only research helpers (Phase 4), keyed by numeric id (handle `rN`). Lives
	// alongside the standing team but renders in its own widget row.
	const researchStates: Map<number, ResearchState> = new Map();
	// Metadata only: prompt text is never retained by this ledger.
	let lastHubLedger: ContextBudgetComponent[] = [];
	let nextResearchId = 1;
	// Retention cap for finished durable (manual/persona) helpers — set from the
	// overrides file's `research-keep:` key at session start (default 4, Infinity
	// for "all"). Ephemeral auto-pipe helpers ignore the cap: pruned on finish.
	let researchKeep = DEFAULT_RESEARCH_KEEP;

	// ── Execution history (/af-agents-history) ──────────
	// The typed store owns entries and turn/ask_user bookkeeping; index.ts owns
	// composition and wires lifecycle events to its explicit API.
	const executionHistory = createExecutionHistoryStore();

	let researchPersonas: AgentDef[] = [];
	let allAgentDefs: AgentDef[] = [];
	let teams: Record<string, string[]> = {};
	// Named model profiles from .pi/agents/model-profiles.yaml (validated at
	// session start) and the session-lifetime per-persona model overrides set by
	// /af-agent-model and /af-models (lowercase persona name → pi model spec). Overrides
	// reset on session_start; profiles make re-applying cheap.
	let modelProfiles: Record<string, Record<string, string>> = {};
	// Backend routing policy (.pi/agents/dispatch-policy.yaml): per dispatch, a
	// member preferring coms is served by a live same-name pool peer instead of a
	// native subagent spawn. Missing file → everything native (status quo).
	let dispatchPolicy: {
		default: string;
		grace_s: number;
		substitutions: Record<string, { prefer: string; fallback: string; timeout_s?: number }>;
	} = { default: "native", grace_s: 30, substitutions: {} };
	let dispatchPolicyWarnings: string[] = [];
	// One "coms peer missing → native" notice per member per team activation.
	const comsMissNotified = new Set<string>();
	const modelOverrides = new Map<string, string>();
	// Session-wide source → target substitutions. Unlike the eager per-persona map,
	// these are resolved at spawn time, so personas and delegate roles activated or
	// created later in the same session inherit the substitution automatically.
	const modelSubstitutions = new Map<string, string>();
	// Session-lifetime per-persona thinking-level overrides set by
	// /af-agent-model-thinking (lowercase persona name → pi --thinking level). Wins
	// over the persona's frontmatter `thinking:`; resets on session_start; takes
	// effect on the persona's next dispatch (/af-agents-restart applies it now).
	const thinkingOverrides = new Map<string, string>();
	// Session-lifetime model overrides for delegate sub-roles, set by
	// /af-agent-model <persona>.<role>. Keyed "<persona>.<role>" (lowercase); applied
	// when the dispatch serializes AGENT_HUB_DELEGATE_CONFIG, so nested children
	// inherit them. Session-wide source substitutions are resolved after this map.
	// Resets on session_start. /af-models profiles never touch these.
	const subagentModelOverrides = new Map<string, string>();
	let activeTeamName = "";
	let gridCols = 2;
	// View mode toggled by Alt+A: "dashboard" = full bordered card grid above the
	// editor; "compact" = one line per *running* agent (name · context · state)
	// rendered BELOW the editor, just above the footer. Compact is the default;
	// idle/done agents are hidden so an idle session shows only the prompt + footer.
	let viewMode: "compact" | "off" = "compact";
	// Compact-view agent switcher: the key of the marked subagent (lowercase persona
	// name for team specialists, `rN` for research helpers — matching /af-zoom
	// resolution), or null when nothing is marked. main is never listed (it is the
	// session under the input box). Alt+]/Alt+[ move it; Alt+\ zooms it.
	let markedAgent: string | null = null;
	let runningWidgetInstalled = false;
	let widgetCtx: any;
	let sessionDir = "";
	let contextWindow = 0;
	// Per-provider in-flight cap for the hub's OWN spawns (specialists and
	// research helpers, which the dispatcher can start in parallel). Delegate
	// children are gated by the same policy inside their parent's process. The
	// drift judge and the return extractor are deliberately NOT gated: both run
	// while a specialist holds a permit, so queueing them behind that specialist
	// would stall the very watchdog that is supposed to stop it.
	const providerSemaphore = createProviderSemaphore({
		...DEFAULT_PROVIDER_LIMITS,
		...parseProviderLimits(process.env.AGENT_HUB_PROVIDER_LIMITS),
	});
	/**
	 * pi's model registry as a plain lookup — the documented source for every
	 * model's window, and the same one the dispatcher's own window comes from.
	 */
	function modelWindowLookup(ctx: any): (provider: string, modelId: string) => any {
		return (provider, modelId) => ctx?.modelRegistry?.find?.(provider, modelId);
	}

	/** Say so when a run is about to wait on a provider permit, not just hang. */
	function notifyProviderQueue(model: string, label: string, ctx: any): void {
		const cap = providerSemaphore.limitFor(model);
		if (cap == null || providerSemaphore.inFlight(model) < cap) return;
		const ahead = providerSemaphore.queued(model) + 1;
		ctx?.ui?.notify(
			`${label}: queued — ${cap} requests already in flight on this provider (${ahead} waiting). ` +
			"Raise or disable the cap with AGENT_HUB_PROVIDER_LIMITS (e.g. custom=4, custom=off).",
			"info",
		);
	}

	let activeWritableDispatches = 0;
	let writableOverlapCounter = 0;
	let pendingHandoff: { target: string; token: string } | null = null;
	let userLanguage: string = DEFAULT_OVERRIDES.language;
	// Project rule folders from the overrides file's `rules:` key (repo-relative,
	// validated at session_start). Non-empty → every dispatched specialist gets a
	// "Project rules" prompt block; personas resolve the folders index-first (a
	// top-level README.md/index.md is a loading manifest) with recursive discovery
	// as the no-index fallback.
	let projectRulesDirs: string[] = [];
	// Project documentation entry points from the overrides file's `docs:` key
	// (repo-relative files or folders, validated at session_start). Non-empty →
	// dispatched specialists and research helpers get a "Project docs" prompt block.
	let projectDocsPaths: string[] = [];

	// Prompt blocks for the project's own rules (HOW — compliance) and docs
	// (WHAT/WHY — orientation). Rules discovery is index-first so a curated rule
	// tree (README manifest + session bundles) is honored instead of bulk-read;
	// the blind recursive find is only the no-index fallback. The validation duty
	// itself is written into the planner/code-reviewer personas.
	function buildRulesProtocol(): string {
		if (projectRulesDirs.length === 0) return "";
		return `

## Project rules
This project keeps its own rules in: ${projectRulesDirs.join(", ")} (repo-relative).
Rules are HOW constraints — read the ones relevant to your task and comply with them.
Resolve them index-first: when a listed folder has a top-level README.md or index.md,
read that first and follow its loading manifest (session bundles, "load X when Y"
lists) to select the rule files that apply to your task; do not bulk-read the tree.
Only when a folder has no such index, discover rule files recursively
(\`find <dir> -type f\`) and read the relevant ones. If you plan or review work,
validate your subject against the rules; when delegating, pass the relevant rule
file paths and the specific points to check on to the child.`;
	}

	function buildDocsProtocol(): string {
		if (projectDocsPaths.length === 0) return "";
		return `

## Project docs
This project's canonical documentation entry points are: ${projectDocsPaths.join(", ")}
(repo-relative). Docs carry WHAT/WHY context — architecture, standards, decisions.
They orient you; they are not compliance rules. Before working in an unfamiliar area,
read the entry points relevant to your task and follow the links they contain rather
than bulk-reading doc trees; when an entry point is a folder, start from its README.md
or index file. If your work changes something the docs describe (architecture, public
APIs, commands, structure), say so in your final response so the docs can be updated.`;
	}

	/** One canonical repository context file plus explicitly configured rule roots. */
	function specialistProjectPolicyPaths(cwd: string): string[] {
		const canonical = ["AGENTS.md", "CLAUDE.md"].find(candidate => existsSync(path.join(cwd, candidate)));
		return [...new Set([...(canonical ? [canonical] : []), ...projectRulesDirs])];
	}
	// The one supported safety harness. Every native specialist, researcher, and
	// nested delegate receives it; a missing harness refuses child dispatch.
	let safetyHarnessPath: string | null = null;
	// Resolved once at session_start: the delegate extension injected into
	// specialists that declare `subagents:` (null → delegation disabled).
	let delegateExtPath: string | null = null;
	// Per-tool deadline for read/grep/find/ls in research helpers/delegates. The
	// whole-run bound is separate: the turn budget's agentTurnMs (run-budget.js).
	let reconSearchTimeoutMs: number | null = 120_000;
	// ── Per-turn budgets (run-budget.js) ──
	// Envelopes follow task tier. Override keys are a ceiling (min with the tier).
	// Counters reset in before_agent_start, or after an explicit one-click
	// continuation. executionHistory.turnStartedAt() is the active-time base; ask_user
	// waits are subtracted.
	let budgetOverrides: AgentTeamOverrides["budgetOverrides"] = {};
	let turnDispatchCount = 0;
	let turnResearchCount = 0;
	// Human wait time is not fleet work. Track it separately from history UI
	// intervals so a continuation can rebase the budget without erasing history.
	let turnBudgetAskUserWaitMs = 0;
	type PendingBudgetContinuation = { kind: BudgetContinuationKind; reason: string };
	let pendingBudgetContinuation: PendingBudgetContinuation | null = null;
	const budgetContinuationAsks = new Map<string, { kind: BudgetContinuationKind; reason: string; params: { context?: unknown; options?: unknown } }>();
	let taskContinuationCount = 0;
	let turnContinuationCount = 0;
	// ── Task-scoped budget & tier (run-budget.js) ──
	// A per-message allowance cannot bound a task: every steering message opened a
	// fresh turn window, so a run could spend 8 dispatches and 60 minutes again and
	// again without any counter ever binding. These counters span the whole TASK
	// and are cleared only by an explicit new task (`set_task_tier` with
	// `new_task: true`) or an approved task-budget continuation — never by an
	// ordinary user message.
	let taskDispatchCount = 0;
	let taskResearchCount = 0;
	let taskLabel: string | null = null;
	// The task clock charges ACTIVE time only — turns that ran, minus the time the
	// dispatcher spent blocked on ask_user. Raw wall clock would bill the human's
	// lunch break, an overnight pause, and every long answer against the task, and
	// at small tier's 45-minute envelope that hard-stops a task with two dispatches
	// spent. A false stop is worse than no stop: it teaches people to reset the
	// task window reflexively, which is the one thing that must stay deliberate.
	// The explicit clock state makes `active` authoritative: a stale timestamp can
	// never turn inter-turn idle time into task work.
	let taskClock = createTaskClock();
	// Review dispatches spent on this task (review-round cap).
	let taskReviewRounds = 0;
	// Task tier (complexity triage): declared by the dispatcher via set_task_tier.
	// TASK-scoped, not turn-scoped, and it moves by ratchet — down freely, up only
	// with a stated reason (applyTierChange). Null until declared; the first
	// dispatch assumes DEFAULT_TASK_TIER. Caps come from the tier envelope.
	let taskTier: string | null = null;
	// Was the tier ASSUMED by the hub rather than declared by the dispatcher? The
	// distinction matters to the ratchet: an assumed tier must not turn the
	// dispatcher's own first triage call into an "escalation" that needs a reason.
	let taskTierAssumed = false;
	// Duplicate-dispatch guard: fingerprints of (agent, task) already dispatched
	// THIS turn. Auto-research resumes and /af-agents-restart call dispatchAgent
	// directly, so only real dispatcher tool calls are guarded.
	const turnDispatchFingerprints = new Set<string>();
	// ── External-blocker circuit breaker (external-blocker.js) ──
	// Set when a specialist reports it needs something outside the fleet's reach;
	// gates the next dispatch until the human has been addressed. Cleared by an
	// ask_user call, by a new user turn (the human spoke), and by a new task.
	let externalBlockers: { agent: string; what: string }[] = [];
	let externalBlockerAcknowledged = false;
	let externalBlockerRefusedOnce = false;
	// Per-run artifact archive retention (run-namespace.js).
	let runHistoryKeep: number | null = DEFAULT_RUN_HISTORY_KEEP;
	// ── Drift watchdog (drift-watchdog.js) ──
	// Hub-wide setting from the overrides file, live-switchable via /af-watchdog;
	// per-agent overrides ("on"/"off") win over it. In operator work mode a
	// dispatch_agent `watchdog` param wins over both. In orchestrator work mode the
	// watchdog auto-arms unless hub or per-agent is explicitly off; dispatch
	// `watchdog: false` cannot disarm it.
	let watchdogSetting: string = DEFAULT_WATCHDOG_SETTING;
	let watchdogJudgeModel: string | null = null;
	const watchdogAgentOverrides = new Map<string, "on" | "off">();
	function currentBudget() {
		return resolveTurnBudget(taskTier ?? DEFAULT_TASK_TIER, budgetOverrides);
	}
	function currentTaskBudget() {
		return resolveTaskBudget(currentBudget());
	}
	function taskCounters() {
		return { dispatches: taskDispatchCount, research: taskResearchCount };
	}
	/**
	 * Active time spent on this task: finished turns plus the open turn, each
	 * minus its ask_user waits. An ask_user still in flight is subtracted too, so
	 * the clock does not tick while the dispatcher sits at a question.
	 */
	function taskActiveElapsedMs(now = Date.now()): number {
		let openWait = 0;
		openWait = executionHistory.openAskUserWaitMs(now);
		return taskClockElapsedMs(taskClock, now, openWait);
	}
	function turnBudgetActiveElapsedMs(now = Date.now()): number {
		let openWait = 0;
		openWait = executionHistory.openAskUserWaitMs(now);
		return turnBudgetActiveMs(executionHistory.turnStartedAt(), now, turnBudgetAskUserWaitMs, openWait);
	}
	function armBudgetContinuation(kind: BudgetContinuationKind, reason: string): void {
		pendingBudgetContinuation = { kind, reason };
	}
	/** Renew only the per-turn envelope; the task identity and outer counters stay intact. */
	function renewTurnBudgetWindow(now = Date.now()): void {
		turnDispatchCount = 0;
		turnResearchCount = 0;
		executionHistory.renewTurnStartedAt(now);
		turnBudgetAskUserWaitMs = 0;
		turnDispatchFingerprints.clear();
		turnContinuationCount++;
		updateModeStatus();
	}
	/** Add one task tranche while preserving tier, assertions, packs, blockers, and label. */
	function continueTaskBudgetWindow(now = Date.now()): void {
		taskDispatchCount = 0;
		taskResearchCount = 0;
		taskClock = resetTaskClock(taskClock, now);
		taskReviewRounds = 0;
		taskContinuationCount++;
		renewTurnBudgetWindow(now);
	}
	/** Fold the turn that is ending into the task's active-time accumulator. */
	function closeTurnActiveTime(now = Date.now()) {
		taskClock = closeTaskClock(taskClock, now);
	}
	/** Clear the task window: counters, tier, clock, review rounds, blocker breaker. */
	function resetTaskWindow(label: string | null = null, now = Date.now()) {
		taskDispatchCount = 0;
		taskResearchCount = 0;
		taskClock = resetTaskClock(taskClock, now);
		taskReviewRounds = 0;
		taskContinuationCount = 0;
		pendingBudgetContinuation = null;
		budgetContinuationAsks.clear();
		taskLabel = label;
		taskTier = null;
		taskTierAssumed = false;
		taskCapabilityPacks = [];
		taskProvisionalPacks = [];
		capabilityConfirmation = {};
		externalBlockers = [];
		externalBlockerAcknowledged = false;
		externalBlockerRefusedOnce = false;
		turnDispatchFingerprints.clear();
		resolveIncomingCapabilities("", true);
		applyWorkModeTools();
		updateModeStatus();
	}
	function hubAuditIdentity(ctx?: ExtensionContext) {
		return buildHubAuditIdentity({
			cwd: ctx?.cwd ?? identity?.cwd ?? currentCtx?.cwd ?? process.cwd(),
			pid: process.pid,
			sessionId: identity?.session_id,
			project: identity?.project,
			workspaceId: process.env.HERDR_WORKSPACE_ID,
			paneId: process.env.HERDR_PANE_ID,
		});
	}
	function hubLocationSuffix(ctx?: ExtensionContext): string {
		const where = hubAuditIdentity(ctx);
		return `\nRepository: ${where.cwd ?? "unknown"}${where.herdr_pane_id ? ` · pane ${where.herdr_pane_id}` : ""}`;
	}
	function taskResetSnapshot(now = Date.now()) {
		return {
			tier: taskTier,
			dispatches: taskDispatchCount,
			research: taskResearchCount,
			reviewRounds: taskReviewRounds,
			activeMs: taskActiveElapsedMs(now),
		};
	}
	function budgetContinuationSnapshot(kind: BudgetContinuationKind, now = Date.now()) {
		return kind === "task" ? taskResetSnapshot(now) : {
			tier: taskTier,
			dispatches: turnDispatchCount,
			research: turnResearchCount,
			reviewRounds: 0,
			activeMs: turnBudgetActiveElapsedMs(now),
		};
	}
	function appendTaskResetEntry(source: "tool:set_task_tier", label: string | null, prior: ReturnType<typeof taskResetSnapshot>, ctx?: ExtensionContext) {
		try {
			pi.appendEntry("agent-hub-task-reset", buildTaskResetAudit({
				source,
				label,
				prior,
				identity: hubAuditIdentity(ctx),
			}));
		} catch { /* diagnostics are best-effort; state changes still succeed */ }
	}
	function appendBudgetContinuationEntry(kind: BudgetContinuationKind, reason: string, prior: ReturnType<typeof taskResetSnapshot>, ctx?: ExtensionContext) {
		try {
			pi.appendEntry("agent-hub-budget-continuation", buildBudgetContinuationAudit({
				kind,
				continuation: kind === "task" ? taskContinuationCount : turnContinuationCount,
				reason,
				prior,
				identity: hubAuditIdentity(ctx),
			}));
		} catch { /* diagnostics are best-effort; state changes still succeed */ }
	}
	function updateModeStatus() {
		try {
			widgetCtx?.ui?.setStatus(
				"hub-tier",
				budgetStatusLine(
					{ dispatches: turnDispatchCount, research: turnResearchCount },
					currentBudget(),
					// A trailing "?" marks a tier the hub assumed rather than one the
					// dispatcher declared — the human can see that triage was skipped.
					taskTier && taskTierAssumed ? `${taskTier}?` : (taskTier ?? DEFAULT_TASK_TIER),
					{ counters: taskCounters(), budget: currentTaskBudget() },
				),
			);
		} catch {}
	}
	/**
	 * The two gates that must run BEFORE any budget is charged, in severity
	 * order: an unacknowledged external blocker, then the tier's persona gate.
	 * Returns the refusal text, or null when the call may proceed.
	 */
	/** Latch the conservative tier before any fleet action can pass a persona gate. */
	function ensureTaskTier(): void {
		if (taskTier !== null) return;
		taskTier = DEFAULT_TASK_TIER;
		taskTierAssumed = true;
		turnReport.tier = taskTier;
		updateModeStatus();
	}
	function preflightGate(persona: string): { reason: string; message: string } | null {
		const blocked = checkExternalBlockerGate({
			blockers: externalBlockers,
			acknowledged: externalBlockerAcknowledged,
			askUserAvailable,
			refusedOnce: externalBlockerRefusedOnce,
		});
		if (blocked) {
			externalBlockerRefusedOnce = true;
			return blocked;
		}
		return checkTierPersonaGate(taskTier, persona);
	}
	// ── Per-turn cost report (/af-hub-report) ──
	interface TurnReport {
		startedAt: number;
		tier: string | null;
		dispatches: { agent: string; status: string; elapsed: number; billed: number; out: number }[];
		research: number;
		recycles: number;
		driftStops: number;
		refusals: number;
	}
	const freshTurnReport = (): TurnReport => ({ startedAt: Date.now(), tier: null, dispatches: [], research: 0, recycles: 0, driftStops: 0, refusals: 0 });
	let turnReport: TurnReport = freshTurnReport();
	let lastTurnReport: TurnReport | null = null;
	const sessionTotals = { turns: 0, dispatches: 0, research: 0, recycles: 0, driftStops: 0, refusals: 0, billed: 0, out: 0 };
	// Session-wide delegated-spend counter (tokens across all delegate children),
	// surfaced in the status line. Resets on session_start.
	let delegatedTokens = 0;

	// ── Verification Contract: assertion ledger (advisory) ──
	// The dispatcher (orchestrator persona) owns a list of checkable acceptance
	// assertions built from the request before any builder runs, recorded via the
	// set_assertions / update_assertion tools. The hub persists the ledger to
	// <sessionDir>/assertions.json (wiped on session_start like findings/) and
	// renders a one-line status, so the contract survives compaction without
	// flooding the dispatcher LLM context. Advisory by design: status is surfaced,
	// but a dispatch is never hard-refused on an unproven assertion (PRD open
	// question 2 — start advisory, revisit enforcement at Checkpoint A). The only
	// in-tool refusal is cosmetic: "proven" requires named evidence.
	type AssertionStatus = "open" | "proven" | "unproven" | "failed";
	interface Assertion {
		id: string;        // A1, A2, …
		tag: string;       // test | runtime-ui | code-grep | manual
		text: string;      // one checkable pass condition
		source: string;    // where it came from — plan/spec line, user request, finding id
		status: AssertionStatus;
		evidence?: string; // named evidence for proven / failed
	}
	let assertions: Assertion[] = [];

	function persistAssertions() {
		if (!sessionDir) return;
		try {
			writeFileSync(safePathWithin(sessionDir, "assertions.json"), JSON.stringify(assertions, null, 2));
		} catch {}
	}

	function assertionStatusLine(): string {
		if (assertions.length === 0) return "";
		const count = (s: AssertionStatus) => assertions.filter(a => a.status === s).length;
		const open = assertions.filter(a => a.status === "open" || a.status === "unproven").map(a => a.id);
		const failed = assertions.filter(a => a.status === "failed").map(a => a.id);
		const head = `Assertions: ${count("proven")}✓ ${open.length}○ ${count("failed")}✗`;
		if (failed.length) return `${head} · failed: ${failed.join(",")}`;
		if (open.length) return `${head} · open: ${open.join(",")}`;
		return `${head} · all proven`;
	}

	function renderAssertionLedgerLines(): string[] {
		return assertions.map(a => {
			const ev = a.evidence ? ` — evidence: ${a.evidence}` : "";
			const src = a.source ? ` ⇐ ${a.source}` : "";
			return `${a.id} [${a.tag}] ${a.status.toUpperCase()}: ${a.text}${src}${ev}`;
		});
	}

	function renderAssertionLedgerText(): string {
		if (assertions.length === 0) return "";
		return `${assertionStatusLine()}\n${renderAssertionLedgerLines().join("\n")}`;
	}

	// One-line status only — the full ledger lives on disk and in this closure,
	// never re-injected into the dispatcher LLM context.
	function updateAssertionStatus() {
		const line = assertionStatusLine();
		if (!line) return;
		try { widgetCtx?.ui?.setStatus("assertions", line); } catch {}
	}

	// Candidate models a persona may switch to: the default `model:` plus the
	// `models:` list, deduped, order preserved.
	function allowedModels(def: AgentDef): string[] {
		const out: string[] = [];
		for (const m of [def.model, ...(def.models || [])]) {
			if (m && !out.includes(m)) out.push(m);
		}
		return out;
	}

	function substitutedModel(model: string | undefined): string | undefined {
		return model ? (modelSubstitutions.get(model) ?? model) : undefined;
	}

	// The model a persona would dispatch on right now: explicit per-persona
	// override → frontmatter default, then the session-wide source substitution.
	// Resolving here (rather than eagerly rewriting every loaded def) makes the
	// mapping apply to agents activated or spawned later in the same session.
	function resolvedModel(def: AgentDef): string | undefined {
		return substitutedModel(modelOverrides.get(def.name.toLowerCase()) ?? def.model);
	}

	function resolvedSubagentModel(persona: string, role: string, declared: string): string {
		return substitutedModel(subagentModelOverrides.get(`${persona.toLowerCase()}.${role.toLowerCase()}`) ?? declared) ?? declared;
	}

	// The raw thinking value a persona would dispatch with right now: session
	// override (/af-agent-model-thinking) → frontmatter `thinking:`. Pass through
	// resolveThinkingLevel before use to get a valid pi --thinking level.
	function resolvedThinking(def: AgentDef): string | undefined {
		return thinkingOverrides.get(def.name.toLowerCase()) ?? def.thinking;
	}

	// Resolve a model/thinking-switchable persona def by its (lowercased) name:
	// a live team member's def first, then a research persona (researcher /
	// deep-researcher). Lets /af-agent-model and /af-agent-model-thinking target
	// research helpers exactly like standard team members — the override maps
	// are keyed by name, so the switch is honored on the helper's next spawn.
	function switchablePersonaDef(name: string): AgentDef | undefined {
		return agentStates.get(name)?.def
			?? researchPersonas.find(d => d.name.toLowerCase() === name);
	}

	function artifactsRoot(): string {
		return safePathWithin(sessionDir, "artifacts");
	}

	function ensureArtifactsLayout(): string {
		const root = artifactsRoot();
		mkdirSync(root, { recursive: true });
		for (const kind of ARTIFACT_KINDS) {
			mkdirSync(safePathWithin(root, kind), { recursive: true });
		}
		return root;
	}

	/**
	 * Move the PREVIOUS session's artifacts into `runs/<runId>/artifacts/` — a
	 * namespace written once and never reused — record it in `runs/index.json`,
	 * and prune to `run-history-keep` archives. Best-effort throughout: failing to
	 * archive must never stop a session from starting, but it must also never
	 * silently fall back to deleting the artifacts.
	 */
	function archivePreviousRun(): string | null {
		const root = artifactsRoot();
		if (!existsSync(root)) return null;
		let counts: Record<string, number> = {};
		let total = 0;
		try {
			for (const kind of ARTIFACT_KINDS) {
				const dir = safePathWithin(root, kind);
				if (!existsSync(dir)) continue;
				const n = readdirSync(dir).length;
				if (n > 0) counts[kind] = n;
				total += n;
			}
		} catch { /* unreadable tree — fall through and try the move anyway */ }
		if (total === 0) {
			// Nothing worth keeping: an empty layout is not history.
			try { rmSync(root, { recursive: true, force: true }); } catch {}
			return null;
		}
		const runId = makeRunId();
		try {
			const runsDir = safePathWithin(sessionDir, RUNS_DIRNAME);
			const runDir = safePathWithin(runsDir, runId);
			mkdirSync(runDir, { recursive: true });
			renameSync(root, safePathWithin(runDir, "artifacts"));
			const meta = buildRunMeta({
				runId,
				archivedAt: Date.now(),
				cwd: sessionDir,
				project: process.env.PI_COMS_PROJECT || null,
				workspace: process.env.HERDR_WORKSPACE_ID || null,
				artifactCounts: counts,
			});
			const metaPath = safePathWithin(runDir, "meta.json");
			writeFileSync(metaPath, JSON.stringify(meta, null, 2));
			// Written once, never rewritten: make that a file mode, not a promise.
			try { chmodSync(metaPath, 0o444); } catch {}

			const indexPath = safePathWithin(runsDir, RUN_INDEX_FILENAME);
			let existing: any = null;
			try { existing = JSON.parse(readFileSync(indexPath, "utf-8")); } catch {}
			const index = appendRunIndex(existing, { runId, archivedAt: meta.archivedAt, artifactCounts: counts, project: meta.project, workspace: meta.workspace }, runHistoryKeep);
			writeFileSync(indexPath, JSON.stringify(index, null, 2));

			for (const stale of pruneRunDirs(readdirSync(runsDir), runHistoryKeep)) {
				try { rmSync(safePathWithin(runsDir, stale), { recursive: true, force: true }); } catch {}
			}
			return runId;
		} catch {
			// The archive failed. Leave the artifacts exactly where they are rather
			// than deleting them — a stale tree is recoverable, a deleted one is not.
			return null;
		}
	}

	function loadInputArtifacts(paths: string[] | undefined, ctx: any): InputArtifactPreview[] {
		if (!paths || paths.length === 0) return [];
		const root = ensureArtifactsLayout();
		return resolveArtifactPaths(paths, {
			repoDir: ctx.cwd || process.cwd(),
			sessionDir,
			artifactRoot: root,
			exists: existsSync,
		}).map((item: any) => {
			if (!existsSync(item.path)) {
				throw new Error(`Artifact not found: ${item.input} (resolved to ${item.path})`);
			}
			const preview = artifactPreviewFromText(readFileSync(item.path, "utf-8"));
			return { ...item, preview };
		});
	}

	function appendInputArtifacts(task: string, artifacts: InputArtifactPreview[]): string {
		return artifacts.length > 0 ? task + formatInputArtifactsSection(artifacts) : task;
	}

	function appendDeclaredScope(task: string, scopeGlobs: string[]): string {
		if (!scopeGlobs || scopeGlobs.length === 0) return task;
		return task + `\n\n## Declared scope — advisory guardrail\nStay within these paths/globs when changing files; changes outside them will be flagged to the dispatcher for a human decision, not auto-reverted.\n${scopeGlobs.map(s => `- ${s}`).join("\n")}`;
	}

	function hasWriteCapability(tools: string): boolean {
		const toolSet = new Set(String(tools || "").split(",").map(t => t.trim()).filter(Boolean));
		return ["write", "edit", "bash"].some(t => toolSet.has(t));
	}

	function scopeNoticeText(scopeViolations: any): string {
		if (!scopeViolations) return "";
		if (scopeViolations.skipped) {
			return `\n\n⚠ Scope gate skipped: ${scopeViolations.reason || "not a git worktree"}.`;
		}
		if (!scopeViolations.outOfScope || scopeViolations.outOfScope.length === 0) return "";
		const overlap = scopeViolations.concurrentWritableOverlap
			? " Concurrent writable dispatches overlapped this run, so attribution is approximate."
			: "";
		return `\n\n⚠ Scope advisory: changed outside declared scope: ${scopeViolations.outOfScope.join(", ")}. Review these paths and decide whether to accept them or explicitly order cleanup; the hub did not revert anything.${overlap}`;
	}

	/**
	 * Persist a run's output. `kind` is "returns" for a run that completed and
	 * "failures" for one that errored or timed out — an error stub filed as a
	 * return reads as a specialist verdict and is acted on as one.
	 */
	function writeRunArtifact(agentKey: string, runCount: number, output: string, kind: "returns" | "failures" = "returns"): string {
		const root = ensureArtifactsLayout();
		const dir = safePathWithin(root, kind);
		mkdirSync(dir, { recursive: true });
		const file = safePathWithin(dir, `${agentKey}-run${runCount}.md`);
		writeFileSync(file, output, "utf-8");
		return file;
	}

	function evidencePathExists(evidencePath: string): boolean {
		const raw = String(evidencePath || "").trim().replace(/\\/g, "/");
		const evidenceRoot = safePathWithin(artifactsRoot(), "evidence");
		let candidate: string | null = null;
		try {
			if (raw.startsWith("artifacts/evidence/")) {
				candidate = safePathWithin(evidenceRoot, raw.slice("artifacts/evidence/".length));
			} else if (raw.startsWith(".pi/agent-sessions/artifacts/evidence/")) {
				candidate = safePathWithin(evidenceRoot, raw.slice(".pi/agent-sessions/artifacts/evidence/".length));
			} else if (path.isAbsolute(raw)) {
				const resolved = path.resolve(raw);
				const rel = path.relative(evidenceRoot, resolved);
				if (!rel.startsWith("..") && !path.isAbsolute(rel)) candidate = resolved;
			}
		} catch {
			candidate = null;
		}
		return !!candidate && existsSync(candidate);
	}

	function listArtifactFiles(): string[] {
		const root = artifactsRoot();
		if (!existsSync(root)) return [];
		const out: string[] = [];
		const walk = (dir: string) => {
			for (const entry of readdirSync(dir, { withFileTypes: true } as any)) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) walk(full);
				else if (entry.isFile()) out.push(full);
			}
		};
		try { walk(root); } catch { return []; }
		return out.sort();
	}

	function renderArtifactIndexText(): string {
		const root = artifactsRoot();
		const lines = listArtifactFiles().map(file => {
			const rel = path.relative(root, file).split(path.sep).join("/");
			let preview = "(unreadable)";
			try { preview = artifactPreviewFromText(readFileSync(file, "utf-8")); } catch {}
			return `artifacts/${rel} — ${preview}`;
		});
		return lines.join("\n");
	}

	function appendMachineHandoffSections(brief: string): string {
		const sections: string[] = [];
		const ledger = renderAssertionLedgerText();
		if (ledger) sections.push(`## Verification ledger (verbatim, machine-appended)\n${ledger}`);
		const artifacts = renderArtifactIndexText();
		if (artifacts) sections.push(`## Artifact index\n${artifacts}`);
		return sections.length > 0 ? `${brief}\n\n${sections.join("\n\n")}` : brief;
	}

	function structuredReturnDigest(parsed: any): string {
		if (!parsed) return "";
		const lines: string[] = ["Structured return (parsed):"];
		for (const key of ["assertions_proven", "assertions_unproven", "assertions_failed"]) {
			const entries = parsed[key] || [];
			if (entries.length === 0) continue;
			lines.push(`${key}:`);
			for (const entry of entries) {
				const evidence = entry.evidence ? ` — evidence: ${entry.evidence}` : "";
				// Line-form verdicts carry evidence and no separate note; printing
				// "(no note)" next to real evidence is noise, not information.
				const note = entry.note || (entry.evidence ? "" : "(no note)");
				lines.push(`- ${entry.id}${note ? `: ${note}` : ""}${evidence}`);
			}
		}
		for (const key of ["changed_files", "tests_run", "open_risks", "requires_user_decision"]) {
			const entries = parsed[key] || [];
			if (entries.length > 0) lines.push(`${key}: ${entries.slice(0, 5).join("; ")}${entries.length > 5 ? " …" : ""}`);
		}
		return lines.join("\n");
	}

	function contractNoticeText(notices: any[]): string {
		if (!notices || notices.length === 0) return "";
		const lines = ["⚠ Structured return contract notices:"];
		const missing = notices.filter(n => n.type === "missing").map(n => n.id);
		const noStructured = notices.find(n => n.type === "no_structured_return");
		const noEvidence = notices.filter(n => n.type === "proven_without_evidence");
		if (noStructured) lines.push(`- no_structured_return: no parseable structured return for dispatched assertions ${(noStructured.ids || []).join(", ")} — treat all as unproven; full output is on disk.`);
		if (missing.length > 0) lines.push(`- missing: return does not cover ${missing.join(", ")} — treat as unproven.`);
		for (const notice of noEvidence) lines.push(`- proven_without_evidence: ${notice.id} claimed proven without named evidence — demoted to unproven.`);
		return lines.join("\n");
	}

	function loadAgents(cwd: string) {
		// Create session storage dir
		sessionDir = safePathWithin(cwd, ".pi", "agent-sessions");
		if (!existsSync(sessionDir)) {
			mkdirSync(sessionDir, { recursive: true });
		}

		// Findings from auto-research rounds are as ephemeral as the agent sessions
		// that consumed them — wipe at session start. Same for delegation event
		// dirs (delegate children's events + sessions).
		try { rmSync(safePathWithin(sessionDir, "findings"), { recursive: true, force: true }); } catch {}
		try { rmSync(safePathWithin(sessionDir, "delegations"), { recursive: true, force: true }); } catch {}
		try { rmSync(safePathWithin(sessionDir, "transcripts"), { recursive: true, force: true }); } catch {}
		// Artifacts are NOT ephemeral, and deleting them here is what made a
		// post-mortem record eleven specialist returns and two reviews as NOT
		// RECOVERABLE: the next session's `builder-run1.md` reused the same path as
		// the previous session's, and the wipe removed the originals first. Archive
		// the previous session's artifacts into an immutable per-run namespace
		// instead, then start this session with an empty tree.
		archivePreviousRun();
		ensureArtifactsLayout();
		// The assertion ledger is per-task and as ephemeral as the session that owns
		// it — wipe on session start like findings/, then start with an empty ledger.
		try { rmSync(safePathWithin(sessionDir, "assertions.json"), { force: true }); } catch {}
		assertions = [];

		// Load all agent definitions
		allAgentDefs = scanAgentDirs(cwd);

		// Load teams from .pi/agents/teams.yaml
		const teamsPath = join(cwd, ".pi", "agents", "teams.yaml");
		if (existsSync(teamsPath)) {
			try {
				teams = parseTeamsYaml(readFileSync(teamsPath, "utf-8"));
			} catch {
				teams = {};
			}
		} else {
			teams = {};
		}

		// If no teams defined, create a default "all" team
		if (Object.keys(teams).length === 0) {
			teams = { all: allAgentDefs.map(d => d.name) };
		}

		// Load model profiles (raw — validated at session_start once per-project
		// overrides have been applied to the persona defs).
		const profilesPath = join(cwd, ".pi", "agents", "model-profiles.yaml");
		if (existsSync(profilesPath)) {
			try {
				modelProfiles = parseModelProfilesYaml(readFileSync(profilesPath, "utf-8"));
			} catch {
				modelProfiles = {};
			}
		} else {
			modelProfiles = {};
		}

		// Load the dispatch backend policy from .pi/agents/dispatch-policy.yaml.
		// parseDispatchPolicy never throws; a malformed file degrades to defaults
		// with warnings surfaced once at session_start.
		const policyPath = join(cwd, ".pi", "agents", "dispatch-policy.yaml");
		dispatchPolicy = { default: "native", grace_s: 30, substitutions: {} };
		dispatchPolicyWarnings = [];
		if (existsSync(policyPath)) {
			try {
				const parsed = parseDispatchPolicy(readFileSync(policyPath, "utf-8"));
				dispatchPolicy = parsed.policy;
				dispatchPolicyWarnings = parsed.warnings;
			} catch (err) {
				dispatchPolicyWarnings = [`dispatch-policy.yaml unreadable: ${err instanceof Error ? err.message : String(err)}`];
			}
		}
	}

	// Only the first record decides whether pi will accept a session file, and these
	// files reach megabytes (one observed at 2.1 MB) — so read a head slice, not the
	// whole thing. This check runs on every dispatch and every team activation.
	const SESSION_HEAD_BYTES = 64 * 1024;
	function readSessionHead(file: string): string {
		const fd = fs.openSync(file, "r");
		try {
			const buf = Buffer.alloc(SESSION_HEAD_BYTES);
			const read = fs.readSync(fd, buf, 0, SESSION_HEAD_BYTES, 0);
			return buf.subarray(0, read).toString("utf-8");
		} finally {
			fs.closeSync(fd);
		}
	}
	const sessionHealthIo = { existsSync, readFileSync: readSessionHead, renameSync };

	// Would the persona's on-disk session file survive contact with pi? A corrupt
	// one must never be adopted: doing so is what made every `builder` dispatch
	// fail in ~1s, and re-adding the agent re-adopted the same bad file, so
	// drop + add looked like a recovery that could not work.
	function adoptableSessionFile(def: AgentDef): { file: string | null; quarantined: string | null; reason: string | null } {
		const sessionFile = safePathWithin(sessionDir, `${safeAgentKey(def.name)}.json`);
		const health = quarantineIfUnusable(sessionFile, sessionHealthIo);
		return { file: health.usable ? sessionFile : null, quarantined: health.quarantined, reason: health.reason };
	}

	function freshAgentState(def: AgentDef, adoption = adoptableSessionFile(def)): AgentState {
		return {
			def,
			status: "idle",
			task: "",
			toolCount: 0,
			elapsed: 0,
			lastWork: "",
			contextPct: 0,
			contextTokens: 0,
			sessionFile: adoption.file,
			runCount: 0,
			runsSinceFresh: 0,
			timeline: [],
		};
	}

	// Auto-size grid columns based on team size
	function recomputeGrid() {
		gridCols = gridColumnsForSize(agentStates.size);
	}

	function activateTeam(teamName: string) {
		activeTeamName = teamName;
		const members = teams[teamName] || [];
		const defsByName = new Map(allAgentDefs.map(d => [d.name.toLowerCase(), d]));

		agentStates.clear();
		comsMissNotified.clear();
		for (const member of members) {
			const def = defsByName.get(member.toLowerCase());
			if (!def) continue;
			agentStates.set(def.name.toLowerCase(), freshAgentState(def));
		}
		recomputeGrid();
	}

	function persistActiveRoster(): void {
		if (!activeTeamName || agentStates.size === 0) return;
		pi.appendEntry(NATIVE_ROSTER_ENTRY_TYPE, persistedNativeRosterState(activeTeamName));
	}

	// ── Dynamic roster (add/drop/save; /af-agents-add, /af-agents-drop, team_adjust) ──
	// The system prompt is rebuilt every turn from agentStates, so a roster
	// change takes effect on the dispatcher's next turn with no restart.

	function rosterAdd(name: string): { ok: boolean; message: string } {
		const key = normalizeAgentInput(name);
		const def = allAgentDefs.find(d => d.name.toLowerCase() === key);
		if (!def) {
			const available = allAgentDefs.map(d => d.name).sort().join(", ") || "(none)";
			return { ok: false, message: `No persona "${name}". Available: ${available}` };
		}
		if (agentStates.has(def.name.toLowerCase())) {
			return { ok: false, message: `${displayName(def.name)} is already in the active team` };
		}
		const adoption = adoptableSessionFile(def);
		agentStates.set(def.name.toLowerCase(), freshAgentState(def, adoption));
		if (!activeTeamName) activeTeamName = "ad-hoc";
		recomputeGrid();
		updateWidget();
		const quarantineNote = adoption.quarantined
			? ` — its previous session file was unusable (${adoption.reason}) and was quarantined to ${adoption.quarantined}; it starts clean`
			: "";
		return { ok: true, message: `${displayName(def.name)} added to the active team${quarantineNote}` };
	}

	function rosterDrop(name: string): { ok: boolean; message: string } {
		const key = normalizeAgentInput(name);
		const state = agentStates.get(key);
		if (!state) {
			return { ok: false, message: `"${name}" is not in the active team (${Array.from(agentStates.values()).map(s => s.def.name).join(", ") || "empty"})` };
		}
		if (state.status === "running") {
			return { ok: false, message: `${displayName(state.def.name)} is running — wait for it to finish or /af-agents-kill it first` };
		}
		if (orchestratorNeedsRoster(workMode, agentStates.size - 1)) {
			return { ok: false, message: `${displayName(state.def.name)} is the last team member — switch to operator work mode or add a replacement before dropping it` };
		}
		agentStates.delete(key);
		if (agentStates.size === 0) activeTeamName = "";
		recomputeGrid();
		updateWidget();
		// Promise a reusable session file only when pi would actually accept it.
		// The old unconditional "kept for re-adding" is what made a corrupt file
		// look re-addable: the dispatcher dropped the agent, added it back, and got
		// the same instant failures.
		const health = quarantineIfUnusable(
			safePathWithin(sessionDir, `${safeAgentKey(state.def.name)}.json`),
			sessionHealthIo,
		);
		const fileNote = health.usable
			? " (its session file is kept for re-adding)"
			: health.quarantined
				? ` (its session file was unusable — ${health.reason} — and was quarantined to ${health.quarantined}; re-adding starts clean)`
				: " (it has no session file; re-adding starts clean)";
		return { ok: true, message: `${displayName(state.def.name)} dropped from the active team${fileNote}` };
	}

	// ── Grid Rendering ───────────────────────────
	const gridUI = createGridUI({
		getWidgetContext: () => widgetCtx,
		getViewMode: () => viewMode,
		getGridCols: () => gridCols,
		getAgentStates: () => agentStates,
		getResearchStates: () => researchStates,
		getMarkedAgent: () => markedAgent,
		setMarkedAgent: value => { markedAgent = value; },
		isRunningWidgetInstalled: () => runningWidgetInstalled,
		markRunningWidgetInstalled: () => { runningWidgetInstalled = true; },
		displayName, resolvedModel, resolvedThinking, resolveThinkingLevel, abbrevThinking,
		contextWarnThreshold: CONTEXT_WARN_THRESHOLD,
	});
	const { updateWidget, updateResearchWidget, switchableAgents, clampMarker } = gridUI;

	// ── Delegation observability ─────────────────
	const dispatchObservability = createDispatchObservability({
		getSessionDir: () => sessionDir,
		getDelegatedTokens: () => delegatedTokens,
		setDelegatedTokens: value => { delegatedTokens = value; },
		getWidgetContext: () => widgetCtx,
		executionHistory,
		displayName,
		safeAgentKey,
		safePathWithin,
		createTranscriptStore: createFleetTranscriptStore,
		appendTimelineText,
		appendTimelineEvent,
		updateWidget,
	});
	const { startDelegationWatch } = dispatchObservability;

	// ── Dispatch Agent (returns Promise) ─────────

	// ── Extracted coms dispatch, drift judge, and return extraction ──
	const dispatchComs = createDispatchComs({
		getIdentity: () => identity,
		resolveTarget: target => coms.resolveTarget(target),
		send: (params, auditExtra) => coms.send(params, auditExtra),
		getPendingReply: msgId => pendingReplies.get(msgId),
		deletePendingReply: msgId => { pendingReplies.delete(msgId); },
		getSessionDir: () => sessionDir,
		getWatchdogJudgeModel: () => watchdogJudgeModel,
		getResearcherModel: () => {
			const researcherDef = allAgentDefs.find(def => def.name.toLowerCase() === "researcher");
			return researcherDef ? resolvedModel(researcherDef) ?? null : null;
		},
		displayName,
		safeAgentKey,
		safePathWithin,
		appendInputArtifacts,
		appendDeclaredScope,
		buildRulesProtocol,
		buildDocsProtocol,
		updateWidget,
		spawnPiAgent,
	});
	const { dispatchViaComs, runDriftJudge, runReturnExtraction } = dispatchComs;

	const nativeDispatch = createDispatchNative({
		getAgentState: key => agentStates.get(key),
		listAgentStates: () => Array.from(agentStates.values()),
		getSessionDir: () => sessionDir,
		getDispatchPolicy: () => dispatchPolicy,
		isComsReady: () => comsReady,
		getIdentity: () => identity,
		peersInScope: () => peersInScope(),
		wasComsMissNotified: personaKey => comsMissNotified.has(personaKey),
		markComsMissNotified: personaKey => { comsMissNotified.add(personaKey); },
		startMonitorChild: (input, env) => {
			const monitorStart = monitorTurnId;
			return monitorStart ? monitorBridge?.startChild({ ...input, parentId: monitorStart }, env) : undefined;
		},
		finalizeMonitorChild: (task, output, status) => monitorBridge?.finalizeChildFor(task, output, status),
		registerMonitorWaitOnly: (monitorKey, state) => monitorBridge?.registerWaitOnly(monitorKey, () => state.comsAbort?.()),
		registerMonitorProcess: (task, proc) => monitorBridge?.registerOwnedProcessFor(task, proc),
		appendMonitorOutput: (task, delta) => monitorBridge?.appendOutputFor(task, delta),
		getContextWindow: () => contextWindow,
		currentBudget,
		bumpRecycle: () => { turnReport.recycles++; sessionTotals.recycles++; },
		bumpDriftStop: () => { turnReport.driftStops++; sessionTotals.driftStops++; },
		getSessionHealthIo: () => sessionHealthIo,
		getSafetyHarnessPath: () => safetyHarnessPath,
		getDelegateExtensionPath: () => delegateExtPath,
		getReconSearchTimeoutMs: () => reconSearchTimeoutMs,
		getProjectDocsPaths: () => projectDocsPaths,
		getUserLanguage: () => userLanguage,
		getWatchdogSetting: () => watchdogSetting,
		getWatchdogAgentOverride: key => watchdogAgentOverrides.get(key),
		getWorkMode: () => workMode,
		providerSemaphore,
		executionHistory,
		displayName,
		shortModel: model => shortModel(model),
		resolvedModel,
		resolvedThinking,
		resolveThinkingLevel,
		resolvedSubagentModel,
		substitutedModel,
		modelWindowLookup,
		specialistProjectPolicyPaths,
		guardrailEnv,
		appendInputArtifacts,
		appendDeclaredScope,
		flushTimelineStore,
		appendTimelineText,
		appendTimelineEvent,
		createTranscriptStore: createFleetTranscriptStore,
		updateWidget,
		startDelegationWatch,
		dispatchViaComs,
		runDriftJudge,
		notifyProviderQueue,
		spawnPiAgentWithModelFallback,
	});
	const { dispatchAgent } = nativeDispatch;

	// ── Research helpers (Phase 4) ───────────────

	function researchSessionPath(id: number): string {
		return safePathWithin(sessionDir, `research-${id}.json`);
	}

	// A synthesized def for an anonymous (no-persona) research helper.
	function anonResearchDef(): AgentDef {
		return {
			name: "research",
			description: "Ad-hoc read-only research helper.",
			tools: RESEARCH_TOOLS,
			systemPrompt: ANON_RESEARCH_PROMPT,
			file: "",
		};
	}

	// Resolve the model for a research helper: an explicit --model wins, then the
	// persona's resolved model (session override via /af-agent-model → frontmatter
	// default), then the dispatcher's model (the default for anon helpers).
	function resolveResearchModel(def: AgentDef, explicit: string | undefined, ctx: any): string {
		if (explicit) return explicit;
		const resolved = resolvedModel(def);
		if (resolved) return resolved;
		return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "openrouter/google/gemini-3-flash-preview";
	}

	function createResearchState(def: AgentDef, persona: boolean, model: string, ephemeral = false): ResearchState {
		const id = nextResearchId++;
		const state: ResearchState = {
			id,
			def,
			persona,
			ephemeral,
			model,
			status: "running",
			task: "",
			toolCount: 0,
			elapsed: 0,
			lastWork: "",
			contextPct: 0,
			contextTokens: 0,
			sessionFile: null,
			turnCount: 1,
			timeline: [],
		};
		researchStates.set(id, state);
		return state;
	}

	// Retention pass, run whenever a helper finishes: drop finished auto-pipe
	// helpers immediately (their findings persist as files under findings/, their
	// handles are never resumed) and finished durable helpers beyond the
	// `research-keep` most recent — so the research row doesn't grow without
	// bound. Running helpers are untouched; ids stay monotonic (no handle reuse).
	// /af-agents-history is unaffected: the timeline holds its own entries.
	function pruneResearch() {
		const ids = selectResearchPrunable(Array.from(researchStates.values()), researchKeep);
		if (ids.length === 0) return;
		for (const id of ids) {
			try { unlinkSync(researchSessionPath(id)); } catch {}
			researchStates.delete(id);
		}
		updateResearchWidget();
	}

	// Env plumbing for spawned children: the shared exemptions file and, when
	// coms is up, the endpoint damage-control-continue escalates blocked path
	// access to (access_request → user dialog in this hub). spawnPiAgent
	// spreads process.env, so delegate grandchildren inherit these for free.
	function guardrailEnv(agentId: string): Record<string, string> {
		const env: Record<string, string> = { [AGENT_ID_ENV]: agentId };
		if (exemptionsFile) env[EXEMPTIONS_FILE_ENV] = exemptionsFile;
		if (comsReady && identity) env[ASK_ENDPOINT_ENV] = identity.endpoint;
		return env;
	}

	// Spawn (or resume) a read-only research helper. Mirrors dispatchAgent's stream
	// handling but is forced read-only (RESEARCH_TOOLS), drives the research widget, and
	// resolves with the findings — the CALLER decides what to do with them. The
	// spawn_research tool returns them inline; command-driven restarts deliver a follow-up.
	async function spawnResearch(
		state: ResearchState,
		prompt: string,
		ctx: any,
		inputArtifacts: InputArtifactPreview[] = [],
		signal?: AbortSignal,
	): Promise<{ output: string; exitCode: number; elapsed: number; termination?: Termination }> {
		const safety = requireSafetyHarness(safetyHarnessPath);
		if (!safety.ok) return { output: safety.error, exitCode: 1, elapsed: 0 };

		state.status = "running";
		state.task = prompt;
		state.toolCount = 0;
		state.elapsed = 0;
		state.lastWork = "";
		state.killedByOperator = false;
		flushTimelineStore(state);
		state.timeline = [];
		state.transcriptStore = createFleetTranscriptStore(safePathWithin(sessionDir, "transcripts", `research-r${state.id}-turn${state.turnCount}.jsonl`));
		updateResearchWidget();

		const histEntry = executionHistory.start("research", `Research r${state.id}`);
		state.histEntry = histEntry;

		const startTime = Date.now();
		state.timer = setInterval(() => {
			state.elapsed = Date.now() - startTime;
			updateResearchWidget();
		}, 1000);

		const thinkingLevel = resolveThinkingLevel(resolvedThinking(state.def));
		const wantThinking = thinkingLevel !== "off";
		const sessionPath = researchSessionPath(state.id);

		// READ-ONLY by construction: RESEARCH_TOOLS only, regardless of persona frontmatter.
		let fullText = "";
		const researchWindow = resolveContextWindow(state.model, { lookup: modelWindowLookup(ctx), fallbackWindow: contextWindow });
		const researchFallbackCandidate = substitutedModel(fallbackModelFor(state.def, state.model));
		const researchFallback = researchFallbackCandidate === state.model ? undefined : researchFallbackCandidate;
		notifyProviderQueue(state.model, `Research r${state.id}`, ctx);
		const res = await providerSemaphore.run(state.model, () => spawnPiAgentWithModelFallback({
			model: state.model,
			tools: RESEARCH_TOOLS,
			thinking: thinkingLevel,
			// Replacement policy avoids inherited skills and project context files.
			// The selected persona remains available by its explicit source path.
			systemPrompt: nativeResearchSystemPrompt({
				...(state.persona ? { personaName: state.def.name, personaPath: state.def.file } : {}),
				cwd: ctx.cwd || process.cwd(),
			}),
			noSkills: true,
			noContextFiles: true,
			sessionFile: sessionPath,
			resume: !!state.sessionFile,
			prompt: appendInputArtifacts(prompt, inputArtifacts),
			cwd: ctx.cwd || process.cwd(),
			// A blocked read feeds back so the helper can adapt without aborting.
			extensions: safety.extensions,
			env: guardrailEnv(`research-r${state.id}`),
			// Shared native-research policy: owns a child group and applies the
			// configured per-tool deadline (including explicit `off`/null).
			...researchWatchdogSpawnOptions(reconSearchTimeoutMs, signal),
			// Whole-run deadline from the active mode's budget (null in strict mode).
			turnDeadlineMs: currentBudget().agentTurnMs,
		}, researchFallback, {
			onProcess: (p) => { state.proc = p; },
			onModelFallback: ({ from, to, reason }) => {
				state.lastWork = `model fallback: ${shortModel(from)} → ${shortModel(to)}`;
				ctx.ui.notify(`Research r${state.id}: overridden model ${from} failed before work began; retrying with persona model ${to} (${reason})`, "warning");
				updateResearchWidget();
			},
			onTextDelta: (delta) => {
				fullText += delta;
				state.lastWork = fullText.split("\n").filter((l: string) => l.trim()).pop() || "";
				appendTimelineText(state, "text", delta);
				updateResearchWidget();
				state.zoomRender?.();
			},
			onThinkingDelta: (delta) => {
				if (!wantThinking) return;
				appendTimelineText(state, "thinking", delta);
				state.zoomRender?.();
			},
			onToolStart: (toolName, argStr, callId) => {
				state.toolCount++;
				appendTimelineEvent(state, {
					kind: "tool-start",
					title: `Tool: ${toolName}`,
					content: argStr,
					timestamp: Date.now(),
					...(callId ? { callId } : {}),
				});
				updateResearchWidget();
				state.zoomRender?.();
			},
			onToolEnd: (toolName, callId, isError, resultText, durationMs) => {
				appendTimelineEvent(state, {
					kind: "tool-result",
					title: `Result: ${toolName}`,
					content: resultText ?? "",
					timestamp: Date.now(),
					...(callId ? { callId } : {}),
					status: isError ? "error" : "success",
					...(durationMs == null ? {} : { durationMs }),
				});
				state.zoomRender?.();
			},
			onUsage: (usage) => {
				state.contextTokens = (usage.input || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0);
			if (researchWindow.window > 0) {
					// Same context truth as dispatchAgent: include cache reads/writes,
					// measured against THIS helper's window rather than the dispatcher's.
					state.contextPct = contextPct(usage, researchWindow.window);
					updateResearchWidget();
				}
			},
		}, {
			// Read-only by construction (RESEARCH_TOOLS), so a provider failure
			// mid-run is recoverable: re-running a reader repeats nothing.
			midRun: isReadOnlyToolList(RESEARCH_TOOLS),
		}));

		clearInterval(state.timer);
		state.elapsed = Date.now() - startTime;
		state.proc = undefined;

		// The process could not be spawned at all (proc `error` event).
		if (res.spawnError) {
			state.status = "error";
			state.finishedAt = Date.now();
			state.lastWork = `Error: ${res.spawnError}`;
			state.killedByOperator = false;
			updateResearchWidget();
			state.zoomRender?.(true);
			executionHistory.end(histEntry, "error");
			pruneResearch();
			return {
				output: `Error spawning research helper: ${res.spawnError}`,
				exitCode: 1,
				elapsed: state.elapsed,
			};
		}

		const full = res.output;
		const code = res.exitCode;
		const termination = res.termination;
		if (termination) {
			const outcome = researchTerminationOutcome(state.id, termination);
			state.status = "error";
			state.finishedAt = Date.now();
			state.lastWork = outcome.lastWork;
			updateResearchWidget();
			state.zoomRender?.(true);
			executionHistory.end(histEntry, "error");
			pruneResearch();
			return {
				output: outcome.output,
				exitCode: outcome.exitCode,
				elapsed: state.elapsed,
				termination,
			};
		}

		// Operator kill via /af-agents-kill rN|all.
		// Resolve gracefully so a spawn_research tool call awaiting this helper
		// doesn't hang.
		if (state.killedByOperator) {
			state.killedByOperator = false;
			state.status = "idle";
			state.finishedAt = Date.now();
			state.lastWork = "(killed by operator)";
			updateResearchWidget();
			state.zoomRender?.(true);
			executionHistory.end(histEntry, "idle");
			pruneResearch();
			return {
				output: `Research helper r${state.id} was killed by the operator before it finished.`,
				exitCode: code ?? 143,
				elapsed: state.elapsed,
			};
		}

		state.status = code === 0 ? "done" : "error";
		state.finishedAt = Date.now();
		if (code === 0) state.sessionFile = sessionPath;
		state.lastWork = full.split("\n").filter((l: string) => l.trim()).pop() || "";
		updateResearchWidget();
		state.zoomRender?.(true);
		executionHistory.end(histEntry, state.status);
		pruneResearch();

		ctx.ui.notify(
			`Research r${state.id} ${state.status} in ${Math.round(state.elapsed / 1000)}s`,
			state.status === "done" ? "success" : "error",
		);

		let output = full;
		if (res.modelFallback) {
			output = `(ℹ model fallback: ${res.modelFallback.from} failed before work began; retried once with original persona model ${res.modelFallback.to}.)\n\n${output}`;
		}
		if (code !== 0) {
			const errText = res.stderr.trim();
			const tail = errText.length > 1500 ? "...\n" + errText.slice(-1500) : errText;
			const errBlock = tail ? `\n\n[stderr]\n${tail}` : "";
			output = full
				? `${full}${errBlock}`
				: `Research helper r${state.id} exited with code ${code} and produced no output.${errBlock}`;
		}

		return { output, exitCode: code ?? 1, elapsed: state.elapsed };
	}

	// Deliver a command-driven research restart back to the dispatcher as a follow-up
	// turn; there is no awaiting tool call to return to.
	function deliverResearchFollowUp(state: ResearchState, result: { output: string; exitCode: number; elapsed: number }) {
		const truncated = result.output.length > 8000
			? result.output.slice(0, 8000) + "\n\n... [truncated]"
			: result.output;
		const status = result.exitCode === 0 ? "finished" : "failed";
		const label = state.persona ? displayName(state.def.name) : "research";
		pi.sendMessage({
			customType: "research-result",
			content: `[research r${state.id} · ${label}${state.turnCount > 1 ? ` · Turn ${state.turnCount}` : ""}] ${status} in ${Math.round(result.elapsed / 1000)}s.\n\nFindings:\n${truncated}`,
			display: true,
		}, { deliverAs: "followUp", triggerTurn: true });
	}

	// ── Embedded coms: shared registry, transport, and pool core ──
	const peersInScope = () => coms.peersInScope();
	const resolveTarget = (target: string) => coms.resolveTarget(target);

	let cachedRegistryProject: string | undefined;
	let cachedRegistryEntries: ComsRegistryEntry[] = [];
	let cachedRegistryAt = 0;
	const scrubFleetText = (text: string) => text.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim();
	/** Build the one peer source consumed by both the compact pool and dashboard. */
	function fleetPeerInputs(formatModel: (model: string) => string = (model) => model): PeerInput[] {
		const projectFilter = coms.scope.displayProject ?? identity?.project ?? "default";
		if (cachedRegistryProject !== projectFilter || Date.now() - cachedRegistryAt > 1000) {
			cachedRegistryProject = projectFilter;
			cachedRegistryEntries = projectFilter === "*" ? readAllRegistryEntriesAcrossProjects() : readAllRegistryEntries(projectFilter);
			cachedRegistryAt = Date.now();
		}
		const registryEntries = cachedRegistryEntries;
		const peers: PeerInput[] = [];
		const seenSessions = new Set<string>();
		const seenNames = new Set<string>();

		for (const [sid, card] of peerCards.entries()) {
			if (identity && sid === identity.session_id) continue;
			seenSessions.add(sid);
			seenNames.add(card.name);
			peers.push({ key: `peer:${sid}`, name: scrubFleetText(card.name), model: formatModel(card.model), lastWork: scrubFleetText(card.purpose), colorHex: card.color, staleCount: card.staleCount });
		}

		// Registry-only entries have not answered a ping, so the read model owns their pending status.
		for (const entry of registryEntries) {
			if (identity && entry.session_id === identity.session_id) continue;
			if (!coms.scope.includeExplicit && entry.explicit) continue;
			if (seenSessions.has(entry.session_id) || seenNames.has(entry.name)) continue;
			peers.push({ key: `peer:${entry.session_id}`, name: scrubFleetText(entry.name), model: formatModel(entry.model), lastWork: scrubFleetText(entry.purpose), colorHex: entry.color, pending: true });
		}
		return peers;
	}

	function renderPool(width: number, theme: Theme): string[] {
		// Compact mode hides the coms pool too — only running agents show below the editor.
		if (!compactWidgetsEnabled(viewMode)) return [];
		const rows = buildFleetRows(
			{ specialists: [], research: [], peers: fleetPeerInputs() },
			{ showFinished: true },
		);

		// Border helpers — sandwich the body with single-line box-drawing rules
		// so the widget reads as its own block. The top border carries a branded
		// ` coms ` tag; bottom border stays a plain rule for minimalism.
		const safeWidth = Math.max(0, width);
		let topBorder: string;
		let bottomBorder: string;
		if (safeWidth < 12) {
			topBorder = theme.fg("dim", "━".repeat(safeWidth));
			bottomBorder = theme.fg("dim", "━".repeat(safeWidth));
		} else {
			const left = theme.fg("dim", "┏━") + theme.fg("border", " coms ");
			const leftFill = theme.fg("dim", "━");
			const nameLen = identity ? identity.name.length : 0;
			const rightTagVisLen = identity ? nameLen + 4 : 0;
			const remaining = safeWidth - 9 /* "┏━ coms ━" */ - rightTagVisLen - 1 /* "┓" */;
			if (identity && remaining >= 1) {
				const rightTag =
					theme.fg("dim", " ") +
					hexFg(identity.color, identity.name) +
					theme.fg("dim", " ━");
				const middle = theme.fg("dim", "━".repeat(remaining));
				const right = theme.fg("dim", "┓");
				topBorder = left + leftFill + middle + rightTag + right;
			} else {
				const fallbackRemaining = Math.max(0, safeWidth - 2 /* "┏━" */ - 6 /* " coms " */ - 1 /* "┓" */);
				const right = theme.fg("dim", "━".repeat(fallbackRemaining) + "┓");
				topBorder = left + right;
			}
			bottomBorder = theme.fg("dim", "┗" + "━".repeat(safeWidth - 2) + "┛");
		}

		if (rows.length === 0) {
			const emptyMsg = theme.fg("muted", "no peers connected");
			return [
				topBorder,
				truncateToWidth(theme.fg("dim", " ") + emptyMsg, width),
				bottomBorder,
			];
		}

		rows.sort((a, b) => a.name.localeCompare(b.name));

		const out: string[] = [topBorder];

		for (const r of rows) {
			const pctNum = r.contextPct ?? 0;
			const filled = Math.max(0, Math.min(15, Math.round((pctNum / 100) * 15)));
			const empty = 15 - filled;
			const pctLabel = r.contextPct == null ? "--%" : `${r.contextPct}%`;

			if (r.status === "stale") {
				const dimRow = `✗ ${r.name.padEnd(12)} ${abbreviateModel(r.model).padEnd(14)} [${"-".repeat(15)}] ${pctLabel.padStart(4)}  —  ${r.lastWork || ""}`;
				out.push(truncateToWidth(" " + theme.fg("dim", dimRow), width));
				continue;
			}

			const pending = r.status === "pending";
			const color = r.colorHex ?? "#808080";
			const swatch = pending ? theme.fg("dim", "●") : hexFg(color, "●");
			const namePart = theme.fg("accent", r.name.padEnd(12));
			const modelPart = theme.fg("dim", abbreviateModel(r.model).padEnd(14));
			const barFill = pending
				? theme.fg("dim", "-".repeat(15))
				: hexFg(color, "#".repeat(filled)) + theme.fg("dim", "-".repeat(empty));
			const bar = theme.fg("warning", "[") + barFill + theme.fg("warning", "]");
			const pctPart = " " + theme.fg("accent", pctLabel.padStart(4));
			const sep = theme.fg("dim", "  —  ");
			const purposePart = theme.fg("muted", r.lastWork || "");

			const line = " " + swatch + " " + namePart + " " + modelPart + " " + bar + pctPart + sep + purposePart;
			out.push(truncateToWidth(line, width));
		}

		out.push(bottomBorder);
		return out;
	}

	function installPoolWidget(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		try {
			ctx.ui.setWidget("coms-pool", (_tui, theme) => ({
				invalidate() {},
				render(width: number): string[] {
					return renderPool(width, theme);
				},
			}), { placement: "belowEditor" });
		} catch {
			// non-fatal
		}
	}

	// ── Extracted tool execution wiring ──

		async function executeDispatchAgent(_toolCallId: string, params: DispatchAgentParams, _signal: AbortSignal | undefined, onUpdate: ToolUpdate, ctx: ExtensionContext): Promise<ToolExecutionResult> {
			const confirmationRefusal = provisionalCapabilityRefusal("fleet");
			if (confirmationRefusal) return confirmationRefusal;
			const { task, artifacts, scope, watchdog, review_reason, backend = "auto" } = params as { agent: string; task: string; artifacts?: string[]; scope?: string[]; watchdog?: boolean; review_reason?: string; backend?: "auto" | "native" | "coms" };
			// Display names / underscores resolve to the persona slug key space, so
			// `agent: "Test Engineer"` never burns a dispatch on a lookup error.
			const agent = normalizeAgentInput((params as { agent: string }).agent);
			// Unclassified task: assume the default tier. The prompt asks for
			// set_task_tier FIRST; this is the fail-safe, not the intended path.
			ensureTaskTier();
			// Pre-flight refusals, in severity order, BEFORE anything is charged: an
			// unacknowledged external blocker, the tier's persona gate, the review-round
			// cap, then the docs-only lane. None of these reached a specialist, so none
			// of them costs a budget slot.
			const preflight = preflightGate(agent)
				?? checkReviewRoundCap(taskTier, agent, taskReviewRounds)
				?? checkDocsLane(agent, scope || [], review_reason);
			if (preflight) {
				turnReport.refusals++;
				sessionTotals.refusals++;
				return {
					content: [{ type: "text", text: preflight.message }],
					details: { agent, task, status: preflight.reason, reason: preflight.reason, elapsed: 0, exitCode: 1, fullOutput: "" },
				};
			}
			// Task-budget gate: the outer bound a turn window never provided. Checked
			// BEFORE the turn budget because it is the more severe stop — a new user
			// message reopens the turn window but not the task window.
			const taskRefusal = checkTaskBudget(
				"dispatch",
				taskCounters(),
				currentTaskBudget(),
				taskActiveElapsedMs(),
				taskTier,
			);
			if (taskRefusal) {
				turnReport.refusals++;
				sessionTotals.refusals++;
				armBudgetContinuation("task", taskRefusal.reason);
				return {
					content: [{ type: "text", text: budgetContinuationInstruction(taskRefusal.message, "task", userLanguage) }],
					details: { agent, task, status: "task_budget_refused", reason: taskRefusal.reason, elapsed: 0, exitCode: 1, fullOutput: "" },
				};
			}
			// Turn-budget gate: refuse BEFORE any spawn. The dispatcher must stop,
			// summarize, and ask the user; a new user turn opens a fresh window.
			const budgetRefusal = checkTurnBudget(
				"dispatch",
				{ dispatches: turnDispatchCount, research: turnResearchCount },
				currentBudget(),
				turnBudgetActiveElapsedMs(),
				taskTier,
			);
			if (budgetRefusal) {
				turnReport.refusals++;
				sessionTotals.refusals++;
				armBudgetContinuation("turn", budgetRefusal.reason);
				return {
					content: [{ type: "text", text: budgetContinuationInstruction(budgetRefusal.message, "turn", userLanguage) }],
					details: { agent, task, status: "budget_refused", reason: budgetRefusal.reason, elapsed: 0, exitCode: 1, fullOutput: "" },
				};
			}
			// Duplicate-dispatch guard: the same agent with a near-identical task in
			// one turn is running in circles — the result already exists.
			const fingerprint = taskFingerprint(agent, task);
			if (turnDispatchFingerprints.has(fingerprint)) {
				turnReport.refusals++;
				sessionTotals.refusals++;
				return {
					content: [{ type: "text", text: `⚠ Duplicate dispatch refused: you already dispatched ${agent} with this task (or a trivial rewording of it) THIS turn. Use the earlier result — re-read its digest/returnPath — or change the task materially (new instructions, corrected inputs) before re-dispatching.` }],
					details: { agent, task, status: "duplicate_refused", elapsed: 0, exitCode: 1, fullOutput: "" },
				};
			}
			// Input artifacts resolve BEFORE the dispatch is counted. Validation used to
			// run after the increment, so four "Artifact not found" typos each burned a
			// real budget slot — and the turn budget was exhausted three times in the
			// same session. A path the hub cannot resolve is a pre-flight error: nothing
			// was spawned, so nothing should be charged.
			let inputArtifacts: InputArtifactPreview[];
			try {
				inputArtifacts = loadInputArtifacts(artifacts, ctx);
			} catch (err: any) {
				return {
					content: [{
						type: "text",
						text: `⚠ Dispatch NOT sent and NOT counted against the turn budget — input artifact could not be resolved:\n` +
							`${err?.message || err}\n\nFix the path and dispatch again.`,
					}],
					details: { agent, task, status: "artifact_preflight_failed", elapsed: 0, exitCode: 1, fullOutput: "" },
				};
			}
			turnDispatchCount++;
			taskDispatchCount++;
			if (isReviewPersona(agent)) taskReviewRounds++;
			sessionTotals.dispatches++;
			updateModeStatus();
			let writableTracked = false;
			let scopeSnapshot: any = null;
			let scopeOverlapBaseline = writableOverlapCounter;
			let concurrentWritableAtStart = false;

			try {
				if (onUpdate) {
					onUpdate({
						content: [{ type: "text", text: `Dispatching to ${agent}...` }],
						details: { agent, task, status: "dispatching" },
					});
				}

				const dispatchedAssertionIds = extractAssertionIds(task);
				const scopeGlobs = (scope || []).map(s => String(s).trim()).filter(Boolean);
				const stateForScope = agentStates.get(agent.toLowerCase());
				const agentCanWrite = !!stateForScope && hasWriteCapability(stateForScope.def.tools);
				if (agentCanWrite) {
					concurrentWritableAtStart = activeWritableDispatches > 0;
					scopeOverlapBaseline = writableOverlapCounter;
					if (concurrentWritableAtStart) writableOverlapCounter++;
					activeWritableDispatches++;
					writableTracked = true;
				}
				if (scopeGlobs.length > 0 && agentCanWrite) {
					scopeSnapshot = snapshotWorktree(ctx.cwd || process.cwd());
				}

				// A review is a gate, and a gate has a size. Unbounded review authority
				// ratchets: each round's findings become plan invariants, and the larger
				// plan justifies another round. The cap binds BLOCKING findings only —
				// everything else is still reported, just not as a gate.
				const findingClause = reviewBudgetClause(taskTier, agent);
				const dispatchedTask = findingClause ? `${task}\n\n${findingClause}` : task;

				let result = await dispatchAgent(agent, dispatchedTask, ctx, inputArtifacts, scopeGlobs, watchdog, backend);
				let dispatchBilled = result.billed ?? 0;
				let dispatchOut = result.out ?? 0;

				// Auto-research pipe: when the specialist pauses with NEEDS_RESEARCH
				// lines, the hub (in code, not the dispatcher LLM) fans out read-only
				// helpers, writes findings to files, and resumes the specialist's
				// session with the paths. The dispatcher only ever sees a short notice,
				// keeping its context clean of raw findings.
				const researchRounds: { questions: string[]; files: string[] }[] = [];
				let autoResearchTaskCapped = false;
				while (result.exitCode === 0 && researchRounds.length < MAX_AUTO_RESEARCH_ROUNDS) {
					// The auto-pipe is exempt from the TURN budget (it is hub mechanics,
					// not a dispatcher decision, and must not steal the dispatcher's
					// slots) but NOT from the TASK envelope. At 2 rounds x 4 questions per
					// dispatch and 18 dispatches per task, leaving it uncounted would put
					// 144 research runs inside the bound that is meant to be the outer one.
					const researchLeft = remainingTaskResearch(currentTaskBudget(), taskCounters());
					if (researchLeft === 0) {
						autoResearchTaskCapped = true;
						break;
					}
					const questionCap = researchLeft == null
						? MAX_AUTO_RESEARCH_QUESTIONS
						: Math.min(MAX_AUTO_RESEARCH_QUESTIONS, researchLeft);
					const researchQs = extractNeedsResearch(result.output).slice(0, questionCap);
					if (researchQs.length === 0) break;
					taskResearchCount += researchQs.length;
					updateModeStatus();

					if (onUpdate) {
						onUpdate({
							content: [{ type: "text", text: `${agent} paused for research (${researchQs.length} question(s)) — spawning read-only helpers...` }],
							details: { agent, task, status: "researching" },
						});
					}

					const findingsDir = safePathWithin(sessionDir, "findings");
					mkdirSync(findingsDir, { recursive: true });
					const agentKey = safeAgentKey(agentStates.get(agent.toLowerCase())?.def.name ?? agent);

					const answered = await Promise.all(researchQs.map(async (q) => {
						const rDef = anonResearchDef();
						// Ephemeral: auto-pipe helpers are pruned as soon as they finish —
						// their findings persist as files, their rN handles are never resumed.
						const rState = createResearchState(rDef, false, resolveResearchModel(rDef, undefined, ctx), true);
						updateResearchWidget();
						const rRes = await spawnResearch(rState, q, ctx);
						const file = safePathWithin(findingsDir, `${agentKey}-r${rState.id}.md`);
						const body = `# Research findings r${rState.id}\n\n**Question:** ${q}\n\n` +
							(rRes.exitCode === 0 ? rRes.output : `(research helper failed, exit ${rRes.exitCode})\n\n${rRes.output}`) + "\n";
						writeFileSync(file, body, "utf-8");
						return { question: q, file };
					}));

					researchRounds.push({ questions: researchQs, files: answered.map(a => a.file) });

					const resumePrompt = "Research findings for your NEEDS_RESEARCH questions are ready. " +
						"Read each file with your read tool, then continue from where you paused:\n" +
						answered.map((a, i) => `${i + 1}. ${a.question}\n   → ${a.file}`).join("\n");
					result = await dispatchAgent(agent, resumePrompt, ctx, inputArtifacts, scopeGlobs, watchdog, backend, true);
					dispatchBilled += result.billed ?? 0;
					dispatchOut += result.out ?? 0;
				}

				let scopeViolations: any = null;
				if (scopeSnapshot) {
					const diff = diffAgainst(scopeSnapshot, ctx.cwd || process.cwd());
					const concurrentWritableOverlap = concurrentWritableAtStart || writableOverlapCounter !== scopeOverlapBaseline;
					if (diff.skipped) {
						scopeViolations = { skipped: true, reason: diff.reason, declaredScope: scopeGlobs, concurrentWritableOverlap };
					} else {
						const checked = checkScope(diff.paths, scopeGlobs);
						scopeViolations = { ...checked, changedPaths: diff.paths, declaredScope: scopeGlobs, concurrentWritableOverlap };
					}
				}

				const disposition = deliveryDisposition(result.exitCode, result.pending === true);
				const pendingDelivery = disposition.pending;
				const delivered = disposition.delivered;
				let { parsed: parsedReturn, notices: contractNotices } = parseDeliveredReturn(
					result.output,
					dispatchedAssertionIds,
					delivered,
				);
				const shouldUseDigest = dispatchedAssertionIds.length > 0 || !!parsedReturn;
				const state = agentStates.get(agent.toLowerCase());
				const agentKey = safeAgentKey(state?.def.name ?? agent);
				// A failed run delivered no result. Its output — a coms error, a
				// timeout stub, a truncated crash — goes to failures/, never returns/:
				// a return path is read as "the specialist answered", and one 142-byte
				// error stub filed as a return cost a 103s dispatch investigating a
				// review that had actually succeeded.
				const runArtifactPath = disposition.artifactKind && (shouldUseDigest || !delivered)
					? writeRunArtifact(agentKey, state?.runCount ?? 0, result.output, disposition.artifactKind)
					: null;
				const returnPath = delivered ? runArtifactPath : null;
				const failurePath = delivered ? null : runArtifactPath;

				// Nothing parsed but assertions were tracked: give the report one cheap
				// read-only pass before writing the whole run off as unproven. Never on
				// a failure — there is no report to extract from.
				let returnExtracted = false;
				if (returnPath && shouldExtractReturn(parsedReturn, dispatchedAssertionIds)) {
					if (onUpdate) {
						onUpdate({
							content: [{ type: "text", text: `${agent} returned no structured block — extracting it from the report...` }],
							details: { agent, task, status: "extracting_return" },
						});
					}
					const recovered = await runReturnExtraction(returnPath, dispatchedAssertionIds, ctx);
					if (recovered) {
						parsedReturn = recovered;
						contractNotices = crossCheck(recovered, dispatchedAssertionIds);
						returnExtracted = true;
					}
				}

				const truncated = result.output.length > 8000
					? result.output.slice(0, 8000) + "\n\n... [truncated]"
					: result.output;

				// Extract bubble-up questions emitted via the clarification protocol.
				const questions = extractAskUserQuestions(result.output);

				const status = disposition.status;
				// Record the fingerprint only for completed or watchdog/deadline-stopped
				// runs — those must not be repeated unchanged. A failed spawn or plain
				// error stays retryable (the failure may be transient).
				if (result.exitCode === 0 || result.exitCode === 124 || result.exitCode === 125) {
					turnDispatchFingerprints.add(fingerprint);
				}
				turnReport.dispatches.push({ agent, status, elapsed: result.elapsed, billed: dispatchBilled, out: dispatchOut });
				sessionTotals.billed += dispatchBilled;
				sessionTotals.out += dispatchOut;
				const summary = `[${agent}] ${status} in ${Math.round(result.elapsed / 1000)}s`;
				const questionsNotice = questions.length > 0
					? `\n\n⚠ ${questions.length} ASK_USER question(s) raised by ${agent}. ` +
					  `You MUST call ask_user for each (in ${userLanguage}) before re-dispatching:\n` +
					  questions.map((q, i) => `  ${i + 1}. ${q}`).join("\n")
					: "";

				const answeredCount = researchRounds.reduce((n, r) => n + r.questions.length, 0);
				const unresolved = extractNeedsResearch(result.output);
				const researchNotice = researchRounds.length > 0
					? `\n\nℹ ${agent} auto-paused for research ${researchRounds.length} round(s); ${answeredCount} question(s) answered by read-only helpers. ` +
					  `Findings were saved under ${safePathWithin(sessionDir, "findings")} and read by the agent directly — they are NOT inlined here.`
					: "";
				const budgetNotice = unresolved.length > 0 && researchRounds.length >= MAX_AUTO_RESEARCH_ROUNDS
					? `\n\n⚠ ${agent} still requests research (${unresolved.length} question(s)) but the auto-research budget is exhausted. ` +
					  `Run spawn_research yourself and re-dispatch with the findings, or simplify the task.`
					: "";
				const autoResearchTaskNotice = autoResearchTaskCapped
					? `\n\n⚠ ${agent} paused for research, but the TASK research envelope is spent ` +
					  `(${taskResearchCount}/${currentTaskBudget().maxResearch}) — no helper was spawned and the specialist ` +
					  `was not resumed. Its questions are unanswered. Narrow the task so it can proceed on what it has, ` +
					  `or call set_task_tier with new_task: true if this is genuinely different work.`
					: "";

				const returnPathNotice = returnPath ? `\n\nFull specialist output: ${returnPath}` : "";
				// Named as a delivery failure, not a result: the run did not answer.
				// Whether the work itself succeeded is unknown from here — a lost coms
				// reply looks identical to a crash, and treating the stub as a verdict
				// is what turned a successful review into a re-investigation.
				const pendingNotice = pendingDelivery
					? `\n\n⏳ DELIVERY PENDING — no result or assertion evidence is available yet, and no return/failure artifact was written. Use the msg_id above with coms_get/coms_await; do not re-dispatch.`
					: "";
				const failurePathNotice = failurePath
					? `\n\n⚠ DELIVERY FAILURE (exit ${result.exitCode}) — no specialist result was returned. ` +
						`The error output is at ${failurePath}; it is NOT a return and carries no assertion evidence. ` +
						"The work may or may not have happened — check the artifacts the task was supposed to produce before re-dispatching."
					: "";
				// Tell the dispatcher which path actually held the file, so the next
				// dispatch names it directly instead of guessing the kind again.
				const corrected = inputArtifacts.filter(a => a.resolvedFromKind);
				const artifactKindNotice = corrected.length > 0
					? `\n\nℹ Artifact path corrected: ${corrected.map(a => `"${a.input}" → ${a.displayPath}`).join("; ")}. ` +
						`Use the corrected path from now on.`
					: "";
				const contextNotice = state && contextPressure(state.contextPct)
					? `\n\n⚠ ${displayName(state.def.name)} context at ${Math.ceil(state.contextPct)}% — consider /af-agents-restart ${state.def.name} (state lives in the artifacts/ledger, a restart is cheap).`
					: "";
				const scopeNotice = scopeNoticeText(scopeViolations);
				const contractNotice = contractNoticeText(contractNotices);
				// External blockers arm the circuit breaker: the NEXT dispatch is refused
				// until the human has been addressed. Recording it here (not in the
				// dispatcher's reading of the prose) is the point — a blocker that only
				// exists in a summary gets routed around.
				const reportedBlockers = extractExternalBlockers(result.output);
				let externalBlockerNotice = "";
				if (reportedBlockers.length > 0) {
					for (const what of reportedBlockers) {
						if (!externalBlockers.some(b => b.what === what)) externalBlockers.push({ agent, what });
					}
					externalBlockerAcknowledged = false;
					externalBlockerRefusedOnce = false;
					externalBlockerNotice = `\n\n⛔ ${agent} reported an EXTERNAL BLOCKER — something outside the fleet's reach is missing:\n` +
						reportedBlockers.map((w, i) => `  ${i + 1}. ${w}`).join("\n") +
						`\nThe next dispatch/research call is refused until you escalate this to the human. ` +
						`Do not build a substitute for the missing fact.`;
				}
				// Review accounting: count what came back and say so when it exceeds the
				// tier's cap. The hub does NOT reclassify findings — no rule it can
				// evaluate tells "invents a manifest" from "this leaks a credential",
				// and demoting the second by position is worse than tolerating the
				// first. The enforcement is the review-ROUND cap above, which needs no
				// judgement about content.
				let findingNotice = "";
				if (isReviewPersona(agent)) {
					findingNotice = findingBudgetNotice(
						agent,
						blockingFindingCap(taskTier),
						countReviewFindings(result.output),
						taskReviewRounds,
						reviewRoundCap(taskTier),
					) || "";
				}
				// A documentation-only dispatch closes on the writer's own verification.
				const docsNotice = docsLaneNotice(agent, scopeGlobs);
				const docsLaneText = docsNotice ? `\n\n${docsNotice}` : "";
				// An extracted block is labelled every time it is shown: it was restated
				// by a cheap pass, not declared by the specialist, and it must never be
				// mistaken for first-hand evidence when gating on it.
				const extractionNotice = returnExtracted
					? `ℹ The specialist declared no structured return. The block below was EXTRACTED from its report ` +
						`by a cheap read-only pass — weaker than a declared return. Verify the named evidence before you gate on it.`
					: "";
				const digest = shouldUseDigest
					? [extractionNotice, structuredReturnDigest(parsedReturn) || "Structured return: (none parsed)", contractNotice].filter(Boolean).join("\n\n")
					: truncated;

				return {
					content: [{ type: "text", text: `${summary}${externalBlockerNotice}${questionsNotice}${researchNotice}${budgetNotice}${autoResearchTaskNotice}${returnPathNotice}${pendingNotice}${failurePathNotice}${artifactKindNotice}${contextNotice}${scopeNotice}${findingNotice}${docsLaneText}\n\n${digest}` }],
					details: {
						agent,
						task,
						status,
						backendRequested: backend,
						backendUsed: state?.lastBackend ?? null,
						elapsed: result.elapsed,
						exitCode: result.exitCode,
						fullOutput: result.output,
						structuredReturn: parsedReturn,
						returnExtracted,
						pending: pendingDelivery,
						returnPath,
						failurePath,
						contractNotices,
						questions,
						researchRounds,
						scopeViolations,
						sessionReset: result.sessionReset ?? null,
						artifacts: inputArtifacts.map(a => ({ path: a.path, displayPath: a.displayPath, preview: a.preview, resolvedFromKind: a.resolvedFromKind ?? null })),
					},
				};
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `Error dispatching to ${agent}: ${err?.message || err}` }],
					details: { agent, task, status: "error", elapsed: 0, exitCode: 1, fullOutput: "" },
				};
			} finally {
				if (writableTracked) activeWritableDispatches = Math.max(0, activeWritableDispatches - 1);
			}
		}

		async function executeSpawnResearch(_toolCallId: string, params: SpawnResearchParams, _signal: AbortSignal | undefined, onUpdate: ToolUpdate, ctx: ExtensionContext): Promise<ToolExecutionResult> {
			const confirmationRefusal = provisionalCapabilityRefusal("fleet");
			if (confirmationRefusal) return confirmationRefusal;
			const { task, persona, model, artifacts } = params as { task: string; persona?: string; model?: string; artifacts?: string[] };

			// Research is also a fleet action: latch the conservative tier before
			// its persona gate, so research-first cannot bypass assumed-small.
			ensureTaskTier();
			// Pre-flight refusals before anything is charged: an unacknowledged
			// external blocker, then the tier's persona gate (deep-researcher is the
			// most expensive helper in the system and is not a trivial-tier tool).
			const preflight = preflightGate(persona || "");
			if (preflight) {
				turnReport.refusals++;
				sessionTotals.refusals++;
				return {
					content: [{ type: "text", text: preflight.message }],
					details: { status: preflight.reason, reason: preflight.reason },
				};
			}
			// Task-budget gate: checked before the turn budget (the more severe stop).
			const taskRefusal = checkTaskBudget(
				"research",
				taskCounters(),
				currentTaskBudget(),
				taskActiveElapsedMs(),
				taskTier,
			);
			if (taskRefusal) {
				turnReport.refusals++;
				sessionTotals.refusals++;
				armBudgetContinuation("task", taskRefusal.reason);
				return {
					content: [{ type: "text", text: budgetContinuationInstruction(taskRefusal.message, "task", userLanguage) }],
					details: { status: "task_budget_refused", reason: taskRefusal.reason },
				};
			}
			// Turn-budget gate for dispatcher-initiated research. The automatic
			// NEEDS_RESEARCH pipe is exempt from this per-turn budget.
			const budgetRefusal = checkTurnBudget(
				"research",
				{ dispatches: turnDispatchCount, research: turnResearchCount },
				currentBudget(),
				turnBudgetActiveElapsedMs(),
				taskTier,
			);
			if (budgetRefusal) {
				turnReport.refusals++;
				sessionTotals.refusals++;
				armBudgetContinuation("turn", budgetRefusal.reason);
				return {
					content: [{ type: "text", text: budgetContinuationInstruction(budgetRefusal.message, "turn", userLanguage) }],
					details: { status: "budget_refused", reason: budgetRefusal.reason },
				};
			}
			// Pre-flight BEFORE the research slot is spent — same rule as dispatch_agent:
			// an unknown persona or an unresolvable artifact path never reached a helper,
			// so it must not be charged against the turn budget.
			let def: AgentDef;
			let isPersona = false;
			if (persona) {
				const found = researchPersonas.find(d => d.name.toLowerCase() === persona.toLowerCase());
				if (!found) {
					const available = researchPersonas.map(d => d.name).join(", ") || "(none defined)";
					return {
						content: [{ type: "text", text: `No research persona "${persona}". Available: ${available}. Omit \`persona\` for an ad-hoc helper. (Not counted against the turn budget.)` }],
						details: { status: "error" },
					};
				}
				def = found;
				isPersona = true;
			} else {
				def = anonResearchDef();
			}

			const resolvedModel = resolveResearchModel(def, isPersona ? undefined : model, ctx);
			let inputArtifacts: InputArtifactPreview[];
			try {
				inputArtifacts = loadInputArtifacts(artifacts, ctx);
			} catch (err: any) {
				return {
					content: [{
						type: "text",
						text: `⚠ Research NOT spawned and NOT counted against the turn budget — input artifact could not be resolved:\n` +
							`${err?.message || err}\n\nFix the path and try again.`,
					}],
					details: { status: "artifact_preflight_failed" },
				};
			}

			turnResearchCount++;
			taskResearchCount++;
			turnReport.research++;
			sessionTotals.research++;
			updateModeStatus();

			const state = createResearchState(def, isPersona, resolvedModel);
			updateResearchWidget();

			if (onUpdate) {
				onUpdate({
					content: [{ type: "text", text: `Spawning research helper r${state.id}...` }],
					details: { handle: `r${state.id}`, persona: isPersona ? def.name : null, status: "spawning" },
				});
			}

			try {
				const result = await spawnResearch(state, task, ctx, inputArtifacts, _signal);
				const truncated = result.output.length > 8000
					? result.output.slice(0, 8000) + "\n\n... [truncated]"
					: result.output;
				const status = result.termination
					? result.termination.reason
					: result.exitCode === 0 ? "done" : "error";
				const label = isPersona ? displayName(def.name) : "ad-hoc";
				const summary = `[research r${state.id} · ${label} · read-only] ${status} in ${Math.round(result.elapsed / 1000)}s`;
				return {
					content: [{ type: "text", text: `${summary}\n\n${truncated}` }],
					details: {
						handle: `r${state.id}`,
						persona: isPersona ? def.name : null,
						model: resolvedModel,
						status,
						elapsed: result.elapsed,
						exitCode: result.exitCode,
						fullOutput: result.output,
						termination: result.termination,
						artifacts: inputArtifacts.map(a => ({ path: a.path, displayPath: a.displayPath, preview: a.preview, resolvedFromKind: a.resolvedFromKind ?? null })),
					},
				};
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `Error spawning research helper: ${err?.message || err}` }],
					details: { handle: `r${state.id}`, status: "error", elapsed: 0, exitCode: 1, fullOutput: "" },
				};
			}
		}

	// ── Extracted tool execution wiring ──

	const TEAM_ADJUST_ROSTER_CAP = 8;

		async function executeSetTaskTier(_callId: string, params: SetTaskTierParams, _signal: AbortSignal | undefined, _onUpdate: ToolUpdate, _ctx: ExtensionContext): Promise<ToolExecutionResult> {
			const { tier, reason, new_task } = params as { tier: string; reason?: string; new_task?: boolean };
			// An explicit new-task reset is the lifecycle escape hatch and clears
			// provisional decisions; it must not itself require the old task's consent.
			if (!new_task) {
				const confirmationRefusal = provisionalCapabilityRefusal("fleet");
				if (confirmationRefusal) return confirmationRefusal;
			}

			// A new task classifies from an empty ratchet. Validate the requested tier
			// before mutating/resetting anything so invalid input cannot erase a task.
			const currentTier = new_task ? null : (taskTierAssumed ? null : taskTier);
			const change = applyTierChange(currentTier, tier, reason);
			if (!change.ok) {
				return {
					content: [{ type: "text" as const, text: change.message }],
					details: { status: "error", reason: change.reason, tier: change.tier },
				};
			}
			if (new_task) {
				const resetAt = Date.now();
				const prior = taskResetSnapshot(resetAt);
				resetTaskWindow(null, resetAt);
				appendTaskResetEntry("tool:set_task_tier", null, prior, _ctx);
			}
			taskTier = change.tier;
			taskTierAssumed = false;
			turnReport.tier = change.tier;
			updateModeStatus();
			const b = currentBudget();
			const tb = currentTaskBudget();
			const cap = (n: number | null) => (n == null ? "unlimited" : String(n));
			const spent = `${taskDispatchCount}/${cap(tb.maxDispatches)} dispatches, ${taskResearchCount}/${cap(tb.maxResearch)} research`;
			return {
				content: [{
					type: "text" as const,
					text: `${change.message}${new_task ? " (new task window opened)" : ""}\n` +
						`Per turn: ${cap(b.maxDispatches)} dispatches, ${cap(b.maxResearch)} research. ` +
						`Whole task: ${spent} spent. ` +
						`Size the apparatus accordingly — do not spend a cap just because it exists.`,
				}],
				details: { status: "ok", tier: change.tier, escalated: change.escalated, newTask: !!new_task },
			};
		}

		async function executeTeamAdjust(_callId: string, params: TeamAdjustParams, _signal: AbortSignal | undefined, _onUpdate: ToolUpdate, ctx: ExtensionContext): Promise<ToolExecutionResult> {
			const confirmationRefusal = provisionalCapabilityRefusal("fleet");
			if (confirmationRefusal) return confirmationRefusal;
			const { action, agent, reason } = params as { action: string; agent: string; reason: string };
			const act = String(action || "").trim().toLowerCase();
			if (!currentBudget().delegation) {
				const tier = taskTier ?? DEFAULT_TASK_TIER;
				return {
					content: [{ type: "text" as const, text: `team_adjust is disabled at tier "${tier}" — a single-specialist path never needs roster changes. Raise the task tier with set_task_tier if the work outgrew "${tier}".` }],
					details: { status: "refused" },
				};
			}
			if (act !== "add" && act !== "drop") {
				return { content: [{ type: "text" as const, text: `Unknown action "${action}" — expected add or drop.` }], details: { status: "error" } };
			}
			if (act === "add" && agentStates.size >= TEAM_ADJUST_ROSTER_CAP) {
				return {
					content: [{ type: "text" as const, text: `Roster cap reached (${TEAM_ADJUST_ROSTER_CAP}) — drop an unused member first, or ask the user to /af-agents-add manually.` }],
					details: { status: "refused" },
				};
			}
			const result = act === "add" ? rosterAdd(agent) : rosterDrop(agent);
			if (result.ok) {
				ctx.ui.notify(`team_adjust (${act}): ${result.message} — dispatcher's reason: ${reason || "(none given)"}`, "info");
			}
			const roster = Array.from(agentStates.values()).map(s => s.def.name).join(", ");
			return {
				content: [{ type: "text" as const, text: `${result.message}. Active team: ${roster}.` }],
				details: { status: result.ok ? "ok" : "refused", roster },
			};
		}

		async function executeSetAssertions(_callId: string, params: SetAssertionsParams, _signal: AbortSignal | undefined, _onUpdate: ToolUpdate, ctx: ExtensionContext): Promise<ToolExecutionResult> {
			const input = (params as { assertions: Array<{ id: string; tag: string; text: string; source?: string }> }).assertions;
			const verdict = validateAssertionBatch(input);
			if (!verdict.ok) {
				return {
					content: [{ type: "text" as const, text: verdict.refusal! }],
					details: { status: "rejected", reason: "missing-source" },
				};
			}
			assertions = verdict.assertions.map(a => ({ ...a, status: "open" as AssertionStatus }));
			persistAssertions();
			updateAssertionStatus();
			if (verdict.warning) ctx.ui.notify(verdict.warning, "warning");
			const ids = assertions.map(a => a.id).join(", ") || "(none)";
			const head = `Ledger set: ${assertions.length} assertion(s) open — ${ids}. Pass the relevant ones verbatim into each dispatch and advance only on proven.`;
			return {
				content: [{ type: "text" as const, text: verdict.warning ? `${head}\n\n${verdict.warning}` : head }],
				details: { count: assertions.length, capWarning: Boolean(verdict.warning) },
			};
		}

		async function executeUpdateAssertion(_callId: string, params: UpdateAssertionParams, _signal: AbortSignal | undefined, _onUpdate: ToolUpdate, _ctx: ExtensionContext): Promise<ToolExecutionResult> {
			const { id, status, evidence } = params as { id: string; status: string; evidence?: string };
			const wanted = String(status).trim().toLowerCase();
			if (!["proven", "unproven", "failed"].includes(wanted)) {
				return {
					content: [{ type: "text" as const, text: `status must be one of proven | unproven | failed (got "${status}").` }],
					details: { status: "error" },
				};
			}
			const a = assertions.find(x => x.id.toLowerCase() === String(id).trim().toLowerCase());
			if (!a) {
				const known = assertions.map(x => x.id).join(", ") || "(empty)";
				return {
					content: [{ type: "text" as const, text: `No assertion "${id}" in the ledger. Call set_assertions first, or check the id. Current: ${known}.` }],
					details: { status: "error" },
				};
			}
			if (wanted === "proven") {
				const validation = validateEvidence(a.tag, evidence || "", { fileExists: evidencePathExists, evidenceRoot: safePathWithin(artifactsRoot(), "evidence") });
				if (!validation.ok) {
					return {
						content: [{ type: "text" as const, text: `${a.id} stays ${a.status}: ${validation.reason}` }],
						details: { status: "rejected", reason: validation.reason },
					};
				}
			}
			a.status = wanted as AssertionStatus;
			a.evidence = wanted === "unproven" ? undefined : (evidence?.trim() || undefined);
			persistAssertions();
			updateAssertionStatus();
			const open = assertions.filter(x => x.status === "open" || x.status === "unproven").map(x => x.id);
			const failed = assertions.filter(x => x.status === "failed").map(x => x.id);
			const tail = failed.length
				? `Failed: ${failed.join(", ")}. Still open: ${open.join(", ") || "none"}.`
				: open.length
					? `Still open: ${open.join(", ")}.`
					: "All assertions proven.";
			return {
				content: [{ type: "text" as const, text: `${a.id} → ${a.status}${a.evidence ? ` (${a.evidence})` : ""}. ${tail}` }],
				details: { id: a.id, status: a.status },
			};
		}

		async function executeGetAssertions(_callId: string, _params: Record<string, never>, _signal: AbortSignal | undefined, _onUpdate: ToolUpdate, _ctx: ExtensionContext): Promise<ToolExecutionResult> {
			if (assertions.length === 0) {
				return {
					content: [{ type: "text" as const, text: "Ledger is empty. Call set_assertions to build the acceptance assertions before dispatching." }],
					details: { count: 0 },
				};
			}
			return {
				content: [{ type: "text" as const, text: renderAssertionLedgerText() }],
				details: { count: assertions.length },
			};
		}

		async function executeComsList(_callId: string, params: ComsListParams): Promise<ToolExecutionResult> {
			if (!identity) return { content: [{ type: "text" as const, text: "coms not initialised." }], details: { agents: [], project: null } };
			const result = await coms.list(params);
			const notice = result.widenRequested
				? `\n\n(Discovery is scoped to "${result.project}"${coms.scope.includeExplicit ? "" : ", explicit peers hidden"}. ` +
				  `Widening to other projects or revealing --explicit peers is a human action via ` +
				  `/af-coms --project <name> or /af-coms --all.)`
				: "";
			const lines = result.agents.length === 0 ? "No peer agents in your pool." : result.agents.map(agent => {
				const context = agent.context_used_pct != null ? ` ${agent.context_used_pct}%` : " ?%";
				const state = agent.alive ? agent.status ?? "unknown" : "unreachable";
				return `${agent.alive ? "●" : "✗"} ${agent.name} (${agent.model})${context} [${state}${agent.pane_id ? ` pane ${agent.pane_id}` : ""}]${agent.purpose ? ` — ${agent.purpose}` : ""}`;
			}).join("\n");
			return { content: [{ type: "text" as const, text: `${result.agents.length} peer(s) in pool (project ${result.project}):
${lines}${notice}` }], details: result };
		}

		async function executeComsSend(_callId: string, params: ComsSendParams): Promise<ToolExecutionResult> {
			const confirmationRefusal = provisionalCapabilityRefusal("peer");
			if (confirmationRefusal) return confirmationRefusal;
			const target = resolveTarget(params.target);
			let outboundPrompt = String(params.prompt || "");
			const handoffAppendAuthorized = !!(target && pendingHandoff && pendingHandoff.target === target.name && params.handoff_token === pendingHandoff.token);
			if (handoffAppendAuthorized) outboundPrompt = appendMachineHandoffSections(outboundPrompt);
			const sent = await coms.send({
				target: params.target,
				prompt: outboundPrompt,
				conversation_id: params.conversation_id ?? null,
				response_schema: (params.response_schema as object | undefined) ?? null,
				reply_timeout_ms: params.reply_timeout_ms ?? null,
			});
			markPeerAddressed(sent.target);
			if (handoffAppendAuthorized) pendingHandoff = null;
			return {
				content: [{ type: "text" as const, text: `coms_send → ${sent.target}
msg_id ${sent.msg_id}
hops ${sent.hops}` }],
				details: { msg_id: sent.msg_id, target: sent.target, target_session: sent.target_session, hops: sent.hops },
			};
		}

		async function executeComsGet(_callId: string, params: ComsGetParams): Promise<ToolExecutionResult> {
			const result = coms.get(params.msg_id);
			const text = result.status === "error"
				? `coms_get: unknown msg_id ${params.msg_id}`
				: result.status === "pending"
					? "coms_get: pending"
					: result.error
						? `coms_get: error — ${result.error}`
						: `coms_get: complete
${typeof result.response === "string" ? result.response : JSON.stringify(result.response, null, 2)}`;
			return { content: [{ type: "text" as const, text }], details: result };
		}

		async function executeComsAwait(_callId: string, params: ComsAwaitParams): Promise<ToolExecutionResult> {
			const result = await coms.await(params.msg_id, typeof params.timeout_ms === "number" && params.timeout_ms > 0 ? params.timeout_ms : TIMEOUT_MS);
			if (result.status === "pending") return { content: [{ type: "text" as const, text: "coms_await: pending — wait budget exhausted; the peer may still complete" }], details: { status: "pending" } };
			if (result.status === "error") {
				const unknown = result.error === "unknown msg_id";
				return {
					content: [{ type: "text" as const, text: unknown ? `coms_await: unknown msg_id ${params.msg_id}` : `coms_await: error — ${result.error}` }],
					details: unknown ? { error: "unknown msg_id" } : { status: "error", error: result.error },
				};
			}
			return { content: [{ type: "text" as const, text: typeof result.response === "string" ? result.response : JSON.stringify(result.response, null, 2) }], details: { response: result.response } };
		}

	const toolCtx: ToolContext = {
		executeDispatchAgent,
		executeSpawnResearch,
		executeSetTaskTier,
		executeTeamAdjust,
		executeSetAssertions,
		executeUpdateAssertion,
		executeGetAssertions,
		executeComsList,
		executeComsSend,
		executeComsGet,
		executeComsAwait,
		executeHerdrSpawnPeer,
		executeHerdrSpawnPane,
		executeHerdrReadPane,
		executeHerdrClosePane,
		executeHerdrNotify,
		getAssertionCount: () => assertions.length,
	};

	// Keep the extracted tool surface flat and greppable in this composition root.
	registerDispatchAgent(pi, toolCtx);
	registerSpawnResearch(pi, toolCtx);
	registerSetTaskTier(pi, toolCtx);
	registerTeamAdjust(pi, toolCtx);
	registerVerificationContract(pi, toolCtx);
	registerComsTools(pi, toolCtx);
	registerFleetTools(pi, toolCtx);

	// ── Fleet (herdr) tools ─────────────────────
	//
	// Registered unconditionally (registerTool must run at load), but gated
	// into setActiveTools only when the session runs inside a herdr pane AND
	// the server answers ping (herdrFleetReady, probed at session_start) —
	// outside herdr the tools are absent, like coms. Destructive verbs:
	// herdr_close_pane confirms with the HUMAN before closing (the continue-
	// flow equivalent for a dispatcher-owned tool); the bash-level
	// `herdr pane close` etc. are hard-blocked by .pi/damage-control-rules.yaml
	// for spawned specialists.

	let herdrFleetReady = false;

	// Peers this hub spawned, and whether anyone ever sent to them. A spawned
	// coms peer boots idle and waits — spawning it delivers no work, so an
	// unaddressed one is an empty pane holding a model session.
	const hubSpawnedPeers = new Map<string, { name: string; paneId: string | null; addressed: boolean }>();
	const markPeerAddressed = (name: string) => {
		const entry = hubSpawnedPeers.get(String(name || "").toLowerCase());
		if (entry) entry.addressed = true;
	};

	/** When the last hub-spawned pi peer was launched — input to the stale-token stagger. */
	let lastHubPiSpawnAt: number | null = null;

	async function executeHerdrSpawnPeer(_callId: string, params: HerdrSpawnPeerParams): Promise<ToolExecutionResult> {
		const confirmationRefusal = provisionalCapabilityRefusal("workspace");
		if (confirmationRefusal) return confirmationRefusal;
		if (!herdrFleetReady) {
			return { content: [{ type: "text" as const, text: "herdr is not available in this session." }], details: { error: "no herdr" } };
		}
		const ownPane = herdrPaneId();
		if (!ownPane) {
			return { content: [{ type: "text" as const, text: "not inside a herdr pane." }], details: { error: "no pane" } };
		}
		if (!comsReady || !identity) {
			return {
				content: [{ type: "text" as const, text: "Cannot spawn an addressable peer while coms is unavailable. Start without --solo/--no-coms, or use herdr_spawn_pane for a non-peer command." }],
				details: { error: "no coms" },
			};
		}
		try {
			const cwd = currentCtx?.cwd ?? process.cwd();
			const plan = buildHubPeerSpawnPlan(params, {
				project: identity.project,
				peersYaml: peerManifest(cwd),
				personaExists: (persona) => peerPersonaExists(cwd, persona),
				worktreeTag: worktreeTag(cwd),
			});
			if (peersInScope().some(peer => peer.name.toLowerCase() === plan.name.toLowerCase())) {
				throw new Error(`Peer "${plan.name}" is already visible in project "${identity.project}"; use coms_send instead of spawning a duplicate.`);
			}
			const env: Record<string, string> = {};
			if (plan.envFile) {
				const envPath = resolveEnvFilePath(plan.envFile, cwd);
				if (!fs.existsSync(envPath)) throw new Error(`env_file not found: ${plan.envFile} (resolved: ${envPath})`);
				Object.assign(env, parseEnvFile(fs.readFileSync(envPath, "utf-8"), plan.envFile));
			}
			const delay = plan.runner === "pi" ? spawnDelaySeconds(lastHubPiSpawnAt) : 0;
			if (delay > 0) env[STAGGER_ENV_VAR] = String(delay);
			const launched = await launchHubPeerInPane(plan, {
				client: herdrApi,
				targetPaneId: ownPane,
				cwd,
				env,
				waitForRegistration: (name, timeoutMs) => waitForPeerRegistration(
					name,
					() => comsReady && identity !== null,
					() => peersInScope().map(peer => peer.name),
					timeoutMs,
				),
				paneTail,
				onLaunched: (paneId) => {
					hubSpawnedPeers.set(plan.name.toLowerCase(), { name: plan.name, paneId, addressed: false });
					if (plan.runner === "pi") lastHubPiSpawnAt = Date.now();
				},
			});
			const promptNote = launched.promptSeen
				? ""
				: `\n⚠ pane ${launched.paneId} showed no shell prompt within ${Math.round(PANE_PROMPT_TIMEOUT_MS / 1000)}s; the command was sent anyway.`;
			return {
				content: [{ type: "text" as const, text: `spawned ${plan.kind} in pane ${launched.paneId} (${plan.name}): ${plan.command.join(" ")}${promptNote}\n\n${launched.verdict.message}` }],
				details: {
					pane_id: launched.paneId,
					name: plan.name,
					kind: plan.kind,
					runner: plan.runner,
					project: plan.project,
					prompt_seen: launched.promptSeen,
					env_file: plan.envFile ?? null,
					...launched.verdict,
				},
			};
		} catch (err) {
			const m = err instanceof Error ? err.message : String(err);
			return { content: [{ type: "text" as const, text: `herdr_spawn_peer failed before readiness: ${m}` }], details: { error: m } };
		}
	}

	async function executeHerdrSpawnPane(_callId: string, params: HerdrSpawnPaneParams): Promise<ToolExecutionResult> {
		const confirmationRefusal = provisionalCapabilityRefusal("workspace");
		if (confirmationRefusal) return confirmationRefusal;
		if (!herdrFleetReady) {
			return { content: [{ type: "text" as const, text: "herdr is not available in this session." }], details: { error: "no herdr" } };
		}
		const ownPane = herdrPaneId();
		if (!ownPane) {
			return { content: [{ type: "text" as const, text: "not inside a herdr pane." }], details: { error: "no pane" } };
		}
		try {
			const cwd = currentCtx?.cwd ?? process.cwd();
			const argv = ["bash", "-lc", params.command];
			const { pane } = await herdrApi.paneSplit({
				target_pane_id: ownPane,
				direction: params.direction ?? "right",
				cwd,
				focus: false,
			});
			try { await herdrApi.paneRename(pane.pane_id, params.name); } catch { /* cosmetic */ }
			const launch = await launchPeerInPane(herdrApi, pane.pane_id, argv);
			const promptNote = launch.promptSeen
				? ""
				: `\n⚠ pane ${pane.pane_id} showed no shell prompt within ${Math.round(PANE_PROMPT_TIMEOUT_MS / 1000)}s; the command was sent anyway.`;
			return {
				content: [{ type: "text" as const, text: `spawned raw pane ${pane.pane_id} (${params.name}): ${params.command}${promptNote}` }],
				details: { pane_id: pane.pane_id, name: params.name, prompt_seen: launch.promptSeen },
			};
		} catch (err) {
			const m = err instanceof Error ? err.message : String(err);
			return { content: [{ type: "text" as const, text: `herdr_spawn_pane failed: ${m}` }], details: { error: m } };
		}
	}

	async function executeHerdrReadPane(_callId: string, params: HerdrReadPaneParams): Promise<ToolExecutionResult> {
		if (!herdrFleetReady) {
			return { content: [{ type: "text" as const, text: "herdr is not available in this session." }], details: { error: "no herdr" } };
		}
		const lines = Math.min(Math.max(1, params.lines ?? 60), 200);
		try {
			const { read } = await herdrApi.paneRead({ pane_id: params.pane_id, lines });
			return { content: [{ type: "text" as const, text: read.text || "(pane is empty)" }], details: { pane_id: params.pane_id, lines } };
		} catch (err) {
			const m = err instanceof Error ? err.message : String(err);
			return { content: [{ type: "text" as const, text: `herdr_read_pane failed: ${m}` }], details: { error: m } };
		}
	}

	async function executeHerdrClosePane(_callId: string, params: HerdrClosePaneParams): Promise<ToolExecutionResult> {
		const confirmationRefusal = provisionalCapabilityRefusal("workspace");
		if (confirmationRefusal) return confirmationRefusal;
		if (!herdrFleetReady) {
			return { content: [{ type: "text" as const, text: "herdr is not available in this session." }], details: { error: "no herdr" } };
		}
		const ctx = currentCtx;
		if (!ctx?.hasUI) {
			return { content: [{ type: "text" as const, text: "no UI to confirm the close — refused." }], details: { error: "no ui" } };
		}
		const ok = await ctx.ui.confirm(
			"herdr_close_pane",
			`Close pane ${params.pane_id}? Reason: ${params.reason}\nThis kills the process running in it.`,
		);
		if (!ok) {
			return { content: [{ type: "text" as const, text: `human declined closing ${params.pane_id} — adapt and continue.` }], details: { declined: true } };
		}
		try {
			await herdrApi.paneClose(params.pane_id);
			return { content: [{ type: "text" as const, text: `closed ${params.pane_id}` }], details: { closed: params.pane_id } };
		} catch (err) {
			const m = err instanceof Error ? err.message : String(err);
			return { content: [{ type: "text" as const, text: `herdr_close_pane failed: ${m}` }], details: { error: m } };
		}
	}

	async function executeHerdrNotify(_callId: string, params: HerdrNotifyParams): Promise<ToolExecutionResult> {
		const confirmationRefusal = provisionalCapabilityRefusal("workspace");
		if (confirmationRefusal) return confirmationRefusal;
		if (!herdrFleetReady) {
			return { content: [{ type: "text" as const, text: "herdr is not available in this session." }], details: { error: "no herdr" } };
		}
		try {
			await herdrApi.notificationShow({ title: params.title, body: params.body ?? "" });
			return { content: [{ type: "text" as const, text: `notified: ${params.title}` }], details: { title: params.title } };
		} catch (err) {
			const m = err instanceof Error ? err.message : String(err);
			return { content: [{ type: "text" as const, text: `herdr_notify failed: ${m}` }], details: { error: m } };
		}
	}
	// ── ask_user Tool (dispatcher → human) ──
	//
	// We do NOT register `ask_user` here. The recommended companion package
	// `pi-ask-user` (see docs/pi-setup.md) owns that tool name with a richer
	// implementation. Registering our own conflicts regardless of load order:
	//   - if we register first, pi-ask-user fails to load
	//   - if pi-ask-user registers first, our registration fails
	// and pi has no synchronous probe at load time — `pi.getAllTools()` is
	// a runtime action method that throws when called from the factory.
	//
	// Instead, in `session_start` (where action methods ARE allowed) we check
	// `pi.getAllTools()`, gate `ask_user` into `setActiveTools` only if present,
	// and warn the user to `pi install npm:pi-ask-user` if it's missing.

	let askUserAvailable = false;
	let workMode: WorkMode = "operator";
	let rosterRecoveryRequired = false;
	let rosterRecoveryDiagnostic = "";
	let baselineTools: string[] = [];
	let taskCapabilityPacks: CapabilityPack[] = [];
	let taskProvisionalPacks: CapabilityPack[] = [];
	let capabilityConfirmation: CapabilityConfirmationState = {};
	let contextPressureState: ContextPressureState = createContextPressureState();
	let capabilityResolution: CapabilityResolution = resolveCapabilityPacks({
		workMode, userText: "", taskPacks: [], comsReady: false, herdrReady: false,
		pendingOperations: [], contextState: "normal",
	});

	function pendingCapabilityOperations(): PendingOperation[] {
		const pending: PendingOperation[] = [];
		if (Array.from(agentStates.values()).some(state => state.status === "running") || Array.from(researchStates.values()).some(state => state.status === "running")) pending.push({ pack: "fleet", kind: "child" });
		if (pendingReplies.size > 0 || pendingHandoff) pending.push({ pack: "peer", kind: "message" });
		if (hubSpawnedPeers.size > 0) pending.push({ pack: "workspace", kind: "pane" });
		return pending;
	}

	function capabilityContextState(): ContextState {
		if (contextPressureState.phase === "warning") return "approaching-compaction";
		if (contextPressureState.phase !== "normal") return "imminent-compaction";
		if (contextPressureState.pressure === "imminent") return "imminent-compaction";
		if (contextPressureState.pressure === "approaching") return "approaching-compaction";
		// Before the first turn_end sample, preserve startup/input protection from
		// the live Pi measurement without mutating the single-flight state machine.
		const percent = currentCtx?.getContextUsage?.()?.percent;
		if (typeof percent === "number" && percent >= 90) return "imminent-compaction";
		if (typeof percent === "number" && percent >= 80) return "approaching-compaction";
		return "normal";
	}

	function resolveIncomingCapabilities(userText: string, newTask = false): void {
		capabilityResolution = resolveCapabilityPacks({
			workMode,
			userText,
			taskTier: taskTier === "trivial" || taskTier === "small" || taskTier === "feature" || taskTier === "project" ? taskTier : undefined,
			taskPacks: taskCapabilityPacks,
			provisionalPacks: taskProvisionalPacks,
			comsReady,
			herdrReady: herdrFleetReady,
			pendingOperations: pendingCapabilityOperations(),
			contextState: capabilityContextState(),
			newTask,
		});
		for (const pack of ["fleet", "peer", "workspace"] as const) {
			if (capabilityConfirmation[pack] === "promoted" || capabilityConfirmation[pack] === "declined") {
				capabilityResolution.provisional = capabilityResolution.provisional.filter(candidate => candidate !== pack);
				capabilityResolution.confirmationRequired = capabilityResolution.confirmationRequired.filter(candidate => candidate !== pack);
				if (capabilityConfirmation[pack] === "promoted" && !capabilityResolution.active.includes(pack)) capabilityResolution.active.push(pack);
			}
		}
		taskCapabilityPacks = capabilityResolution.nextTaskPacks = CAPABILITY_PACKS.filter(pack => pack !== "core" && pack !== "compaction" && capabilityResolution.active.includes(pack));
		taskProvisionalPacks = capabilityResolution.provisional.filter(pack => capabilityConfirmation[pack as ConfirmableCapabilityPack] !== "declined");
		try { pi.appendEntry("agent-hub-capability-packs", persistedCapabilityState(capabilityResolution, capabilityConfirmation)); } catch { /* state persistence is best-effort */ }
	}

	function provisionalCapabilityRefusal(pack: ConfirmableCapabilityPack) {
		const gate = confirmationGate(capabilityConfirmation, pack, capabilityResolution.provisional.includes(pack));
		if (gate.allowed) return null;
		return { content: [{ type: "text" as const, text: gate.message }], details: { status: "provisional_confirmation_required", confirmation: gate.status, pack } };
	}

	function applyWorkModeTools(): void {
		pi.setActiveTools(resolveWorkModeTools({
			workMode,
			baselineTools,
			comsReady,
			herdrReady: herdrFleetReady,
			askUserAvailable,
			capabilityPacks: [...capabilityResolution.active, ...capabilityResolution.provisional],
		}));
	}

	function updateWorkModeStatus(ctx: ExtensionContext): void {
		ctx.ui.setStatus("hub-work-mode", `Work Mode: ${workMode}`);
	}

	function modelWorkBlockedByRosterRecovery(ctx: ExtensionContext): boolean {
		if (workMode !== "orchestrator" || !rosterRecoveryRequired) return false;
		const message = `${rosterRecoveryDiagnostic || "No valid native roster is active."} Select one with /af-agents-team, restart with --agent-team <name>, or switch explicitly with /af-work-mode operator.`;
		ctx.ui.notify(message, "error");
		// Print/JSON modes do not render extension notifications. Never include the
		// blocked prompt or command arguments in this metadata-only diagnostic.
		if (!ctx.hasUI) console.error(`[agent-hub] ${message}`);
		return true;
	}

	function workModeStatusText(): string {
		return [
			`Work Mode: ${workMode}`,
			`Direct tools: ${workMode === "operator" ? "enabled" : "disabled"}`,
			`Native roster: ${activeTeamName || "(none)"} (${agentStates.size})`,
			`Coms: ${comsReady ? `ready${identity ? ` (${identity.name}@${identity.project})` : ""}` : "unavailable"}`,
			`Herdr: ${herdrFleetReady ? "ready" : "unavailable"}`,
		].join("\n");
	}

	// ── Commands ─────────────────────────────────

	const commandCtx: CommandContext = {
		setWidgetContext: ctx => { widgetCtx = ctx; },
		applyWorkModeSelection,
		getWorkModeStatusText: workModeStatusText,
		openWorkModePicker,
		handleAgentsTeam: async (_args, ctx) => {
			widgetCtx = ctx;
			const teamNames = Object.keys(teams);
			if (teamNames.length === 0) {
				ctx.ui.notify("No teams defined in .pi/agents/teams.yaml", "warning");
				return;
			}

			const options = teamNames.map(name => {
				const members = teams[name].map(m => displayName(m));
				return `${name} — ${members.join(", ")}`;
			});

			const choice = await ctx.ui.select("Select Team", options);
			if (choice === undefined) return;

			const idx = options.indexOf(choice);
			const name = teamNames[idx];
			const selected = resolveSessionRoster({
				teams,
				entries: [],
				explicitRoster: name,
				availablePersonas: allAgentDefs.map(def => def.name),
			});
			if (!selected.roster) {
				ctx.ui.notify(`${selected.diagnostic} Fix .pi/agents/teams.yaml or select another team.`, "error");
				return;
			}
			activateTeam(selected.roster.name);
			rosterRecoveryRequired = false;
			rosterRecoveryDiagnostic = "";
			persistActiveRoster();
			resolveIncomingCapabilities("");
			applyWorkModeTools();
			setTimeout(replayDeferredRecoveryInputs, 0);
			updateWidget();
			ctx.ui.setStatus("agent-team", `Team: ${name} (${agentStates.size})`);
			ctx.ui.notify(`Team: ${name} — ${Array.from(agentStates.values()).map(s => displayName(s.def.name)).join(", ")}`, "info");
		},
		handleAgentsList: async (_args, _ctx) => {
			widgetCtx = _ctx;
			await openFleetDashboard(_ctx);
		},
		handleAgentsHistory: async (_args, ctx) => {
			widgetCtx = ctx;
			await openHistory(ctx, executionHistory, () => (activeTeamName ? `Team: ${activeTeamName}` : "Agent Hub"));
		},
		handleAgentsAdd: async (args, ctx) => {
			widgetCtx = ctx;
			const names = (args || "").trim().split(/\s+/).filter(Boolean);
			if (names.length === 0) {
				const available = allAgentDefs
					.filter(d => !agentStates.has(d.name.toLowerCase()))
					.map(d => d.name).sort().join(", ") || "(all personas are already in the team)";
				ctx.ui.notify(`Usage: /af-agents-add <persona> [<persona>…]\nNot in the team yet: ${available}`, "info");
				return;
			}
			const results = names.map(n => rosterAdd(n));
			const level = results.some(r => r.ok) ? "success" : "error";
			ctx.ui.notify(results.map(r => r.message).join("\n"), level as any);
			ctx.ui.setStatus("agent-team", `Native roster: ${activeTeamName || "(none)"}* (${agentStates.size})`);
		},
		handleAgentsDrop: async (args, ctx) => {
			widgetCtx = ctx;
			const names = (args || "").trim().split(/\s+/).filter(Boolean);
			if (names.length === 0) {
				ctx.ui.notify(`Usage: /af-agents-drop <persona> [<persona>…]\nActive team: ${Array.from(agentStates.values()).map(s => s.def.name).join(", ")}`, "info");
				return;
			}
			const results = names.map(n => rosterDrop(n));
			const level = results.some(r => r.ok) ? "success" : "error";
			ctx.ui.notify(results.map(r => r.message).join("\n"), level as any);
			ctx.ui.setStatus("agent-team", `Native roster: ${activeTeamName || "(none)"}* (${agentStates.size})`);
		},
		handleAgentsSave: async (args, ctx) => {
			widgetCtx = ctx;
			const name = (args || "").trim();
			if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) {
				ctx.ui.notify("Usage: /af-agents-save <team-name> (letters, digits, hyphens, underscores)", "error");
				return;
			}
			const members = Array.from(agentStates.values()).map(s => s.def.name);
			if (members.length === 0) {
				ctx.ui.notify("The active team is empty — nothing to save.", "error");
				return;
			}
			const teamsPath = join(ctx.cwd || process.cwd(), ".pi", "agents", "teams.yaml");
			let raw = "";
			try { raw = existsSync(teamsPath) ? readFileSync(teamsPath, "utf-8") : ""; } catch {}
			try {
				mkdirSync(join(ctx.cwd || process.cwd(), ".pi", "agents"), { recursive: true });
				writeFileSync(teamsPath, upsertTeamInYaml(raw, name, members), "utf-8");
			} catch (err) {
				ctx.ui.notify(`Could not write ${teamsPath}: ${err instanceof Error ? err.message : String(err)}`, "error");
				return;
			}
			teams[name] = members;
			activeTeamName = name;
			persistActiveRoster();
			ctx.ui.setStatus("agent-team", `Team: ${name} (${agentStates.size})`);
			ctx.ui.notify(`Team "${name}" saved to .pi/agents/teams.yaml — ${members.join(", ")}`, "success");
		},
		handleAgentsKill: async (args, ctx) => {
			widgetCtx = ctx;
			const name = args?.trim();
			// "all" clears every research helper (kill any running). Team specialists
			// are standing — never touched by "all".
			if (name?.toLowerCase() === "all") {
				clearResearchHelpers(ctx);
				return;
			}
			// An rN handle targets a research helper. Research helpers are disposable
			// by design, so kill also REMOVES — the card, the state, and the session
			// file go with the process (a finished helper is simply removed).
			const rid = name ? parseResearchHandle(name) : null;
			if (rid != null) {
				const rState = researchStates.get(rid);
				if (!rState) {
					const known = Array.from(researchStates.values()).map(s => `r${s.id}`).join(", ");
					ctx.ui.notify(`No research helper "${name}". Known: ${known || "none"}`, "error");
					return;
				}
				removeResearchHelper(rState, ctx);
				return;
			}
			const state = name ? agentStates.get(name.toLowerCase()) : undefined;
			if (!state) {
				const known = [
					...Array.from(agentStates.values()).map(s => displayName(s.def.name)),
					...Array.from(researchStates.values()).map(s => `r${s.id}`),
				].join(", ");
				ctx.ui.notify(`Usage: /af-agents-kill <name|rN|all>. Known: ${known || "none"}`, "error");
				return;
			}
			if (state.status !== "running" || (!state.proc && !state.comsAbort)) {
				ctx.ui.notify(`${displayName(state.def.name)} is not running — nothing to kill.`, "warning");
				return;
			}
			// Coms-backed run: no local process to SIGTERM — only the wait can be
			// released; the standing peer keeps running its turn in its own pane.
			if (!state.proc) {
				void cancelLocalWaitOnly({ abort: state.comsAbort, monitorBridge, monitorKey: monitorKeyForAgent(state.def.name, state.runCount), event: { kind: "wait_only_cancelled" } });
				ctx.ui.notify(`Abandoning ${displayName(state.def.name)}'s coms dispatch (the peer pane keeps running)...`, "info");
				return;
			}
			// Branch A: SIGTERM the child's process group (killPiTree) so any live
			// delegate children die with it. The close handler resolves the awaited
			// dispatch with a "do not auto-retry" message, unblocking the dispatcher.
			state.killedByOperator = true;
			cancelLocalOwnedProcess({ process: state.proc, monitorBridge, monitorKey: monitorKeyForAgent(state.def.name, state.runCount), treeKill: killPiTree });
			ctx.ui.notify(`Killing ${displayName(state.def.name)}...`, "info");
		},
		handleAgentsRestart: async (args, ctx) => {
			widgetCtx = ctx;
			if (modelWorkBlockedByRosterRecovery(ctx)) return;
			const name = args?.trim();
			// An rN handle re-runs a finished helper's last task on a fresh session.
			// A running helper can't be restarted mid-flight — spawnResearch's promise is held by its
			// original caller, and /af-agents-kill removes the helper outright.
			const rid = name ? parseResearchHandle(name) : null;
			if (rid != null) {
				const rState = researchStates.get(rid);
				if (!rState) {
					const known = Array.from(researchStates.values()).map(s => `r${s.id}`).join(", ");
					ctx.ui.notify(`No research helper "${name}". Known: ${known || "none"}`, "error");
					return;
				}
				if (rState.status === "running") {
					ctx.ui.notify(`Research r${rState.id} is still running — wait for it to finish, or use /af-agents-kill r${rState.id} to discard it; a new research request will spawn a fresh helper.`, "warning");
					return;
				}
				if (!rState.task) {
					ctx.ui.notify(`Research r${rState.id} has no previous task to restart.`, "warning");
					return;
				}
				rState.sessionFile = null;
				rState.turnCount = 1;
				updateResearchWidget();
				ctx.ui.notify(`Restarting research r${rState.id} (fresh)...`, "info");
				spawnResearch(rState, rState.task, ctx).then(result => deliverResearchFollowUp(rState, result));
				return;
			}
			const state = name ? agentStates.get(name.toLowerCase()) : undefined;
			if (!state) {
				const known = [
					...Array.from(agentStates.values()).map(s => displayName(s.def.name)),
					...Array.from(researchStates.values()).map(s => `r${s.id}`),
				].join(", ");
				ctx.ui.notify(`Usage: /af-agents-restart <name|rN>. Known: ${known || "none"}`, "error");
				return;
			}
			const task = state.task;
			if (!task) {
				ctx.ui.notify(`${displayName(state.def.name)} has no previous task to restart.`, "warning");
				return;
			}
			// If it's mid-run, kill it and wait for the child to actually exit before
			// re-dispatching (dispatchAgent rejects a re-entry while status is running).
			// A coms-backed run has no process — abandoning the wait is the "kill".
			if (state.status === "running" && (state.proc || state.comsAbort)) {
				let resolveTermination!: () => void;
				const terminated = new Promise<void>(res => { resolveTermination = res; });
				state.onTerminate = resolveTermination;
				if (state.proc) {
					state.killedByOperator = true;
					state.restarting = true;
					killPiTree(state.proc);
				} else {
					await cancelLocalWaitOnly({ abort: state.comsAbort, monitorBridge, monitorKey: monitorKeyForAgent(state.def.name, state.runCount), event: { kind: "restart" } });
				}
				await terminated;
			}
			// Re-run fresh: a frozen session file may be inconsistent, so drop it (no -c).
			// The file itself still reaches pi via --session, so an unusable one is
			// quarantined by dispatchAgent's session preflight, not here.
			state.sessionFile = null;
			ctx.ui.notify(`Restarting ${displayName(state.def.name)} (fresh)...`, "info");
			const result = await dispatchAgent(state.def.name, task, ctx);
			// The original dispatch_agent tool call already returned, so deliver the
			// fresh result to the dispatcher as a follow-up turn (subagent-widget style).
			const truncated = result.output.length > 8000
				? result.output.slice(0, 8000) + "\n\n... [truncated]"
				: result.output;
			const status = result.exitCode === 0 ? "completed" : "failed";
			pi.sendMessage({
				customType: "agent-restart-result",
				content: `[${displayName(state.def.name)}] restarted by operator and ${status} in ${Math.round(result.elapsed / 1000)}s.\n\n${truncated}`,
				display: true,
			}, { deliverAs: "followUp", triggerTurn: true });
		},
		handleContext: async (_args, ctx) => {
			widgetCtx = ctx;
			await openContextBudget(ctx);
		},
		handleHubReport: async (_args, ctx) => {
			widgetCtx = ctx;
			const fmtTok = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
			const renderReport = (label: string, r: TurnReport): string => {
				const billed = r.dispatches.reduce((n, d) => n + d.billed, 0);
				const out = r.dispatches.reduce((n, d) => n + d.out, 0);
				const rows = r.dispatches.map(d => `  ${d.agent}: ${d.status} in ${Math.round(d.elapsed / 1000)}s · ${fmtTok(d.billed)} billed / ${fmtTok(d.out)} out`);
				return [
					`${label} — tier ${r.tier ?? "(unset)"} · ${r.dispatches.length} dispatch(es) · ${r.research} research · ` +
						`${fmtTok(billed)} billed / ${fmtTok(out)} out · ${r.recycles} recycle(s) · ${r.driftStops} drift stop(s) · ${r.refusals} refusal(s)`,
					...rows,
				].join("\n");
			};
			const lines: string[] = [];
			if (turnReport.dispatches.length > 0 || turnReport.research > 0 || turnReport.refusals > 0) {
				lines.push(renderReport("Current turn", turnReport));
			}
			if (lastTurnReport) lines.push(renderReport("Last turn", lastTurnReport));
			lines.push(
				`Session — ${sessionTotals.turns} dispatching turn(s) · ${sessionTotals.dispatches} dispatch(es) · ${sessionTotals.research} research · ` +
				`${fmtTok(sessionTotals.billed)} billed / ${fmtTok(sessionTotals.out)} out · ${sessionTotals.recycles} recycle(s) · ` +
				`${sessionTotals.driftStops} drift stop(s) · ${sessionTotals.refusals} refusal(s)`,
			);
			const sweep = unaddressedPeerSweep(Array.from(hubSpawnedPeers.values()));
			if (sweep) lines.push(sweep.message);
			ctx.ui.notify(lines.join("\n\n"), "info");
		},
		handleZoom: async (args, ctx) => {
			widgetCtx = ctx;
			const arg = args?.trim() || "";
			const rid = parseResearchHandle(arg);
			const target: Zoomable | undefined = rid != null
				? researchStates.get(rid)
				: arg
					? agentStates.get(arg.toLowerCase()) ?? findDelegationChild(arg)?.child
					: undefined;
			if (!target) {
				const teamKnown = Array.from(agentStates.values()).map(s => displayName(s.def.name)).join(", ");
				const researchKnown = Array.from(researchStates.values()).map(s => `r${s.id}`).join(", ");
				const childKnown = Array.from(agentStates.values())
					.flatMap(s => Array.from(s.delegations?.keys() || [])).join(", ");
				const known = [teamKnown, researchKnown, childKnown].filter(Boolean).join(", ");
				ctx.ui.notify(`Usage: /af-zoom <name|rN|child-id>. Known: ${known || "none"}`, "error");
				return;
			}
			const rowKey = (rid != null ? `r${rid}` : arg).toLowerCase();
			const row = fleetRows(true).find(r => r.key.toLowerCase() === rowKey);
			if (row) await openFleetDetail(row, ctx);
			else await openZoom(target, ctx);
		},
		handleDispatchPolicy: async (_args, ctx) => {
			widgetCtx = ctx;
			const live = new Set(comsReady && identity ? peersInScope().map(e => e.name.toLowerCase()) : []);
			const lines = Array.from(agentStates.values()).map(s => {
				const key = s.def.name.toLowerCase();
				const sub = dispatchPolicy.substitutions[key];
				const prefer = sub ? sub.prefer : dispatchPolicy.default === "coms" ? "coms" : "native";
				if (prefer !== "coms") return `${displayName(s.def.name)}: native`;
				const fb = sub?.fallback === "none" ? "coms-required" : "coms, fallback native";
				return `${displayName(s.def.name)}: ${fb} — peer ${live.has(key) ? "LIVE" : "not in pool"}`;
			});
			const policyPath = join(ctx.cwd || process.cwd(), ".pi", "agents", "dispatch-policy.yaml");
			const src = existsSync(policyPath) ? ".pi/agents/dispatch-policy.yaml" : "(no dispatch-policy.yaml — all native)";
			ctx.ui.notify(
				`Dispatch backends — ${src}, default: ${dispatchPolicy.default}\n${lines.join("\n") || "(no active team)"}\n` +
				`Routing is decided per dispatch against the live coms pool (/af-coms to refresh).`,
				"info",
			);
		},
		handleAgentModel: async (args, ctx) => {
			widgetCtx = ctx;
			const arg = (args || "").trim().toLowerCase();

			// Dot form: <persona>.<role> targets a delegate sub-role. Candidates are
			// the role's declared model (default) + the parent's candidate list.
			if (arg.includes(".")) {
				const dot = arg.indexOf(".");
				const personaName = arg.slice(0, dot);
				const roleName = arg.slice(dot + 1);
				const parent = agentStates.get(personaName);
				const roles = parent?.def.subagents || {};
				const roleKey = Object.keys(roles).find(r => r.toLowerCase() === roleName);
				if (!parent || !roleKey) {
					const valid = Array.from(agentStates.values()).flatMap(s =>
						Object.keys(s.def.subagents || {}).map(r => `${s.def.name}.${r}`));
					ctx.ui.notify(
						`No sub-role "${arg}". Valid targets: ${valid.join(", ") || "none (no persona declares subagents:)"}`,
						"error",
					);
					return;
				}
				const role = roles[roleKey];
				const overrideKey = `${personaName}.${roleKey.toLowerCase()}`;
				const candidates: string[] = [];
				for (const m of [role.model, ...allowedModels(parent.def)]) {
					if (m && !candidates.includes(m)) candidates.push(m);
				}
				const current = resolvedSubagentModel(parent.def.name, roleKey, role.model);
				const options = candidates.map(m => {
					const tags = [m === role.model ? "default" : "", m === current ? "current" : ""].filter(Boolean);
					return tags.length ? `${m} (${tags.join(", ")})` : m;
				});
				const label = `${displayName(parent.def.name)}.${roleKey}`;
				const choice = await ctx.ui.select(`Model for ${label}`, options);
				if (choice === undefined) return;
				const picked = candidates[options.indexOf(choice)];
				const effectivePicked = substitutedModel(picked) ?? picked;
				if (effectivePicked === current) {
					ctx.ui.notify(`${label} is already on ${effectivePicked}`, "info");
					return;
				}
				if (picked === role.model) {
					subagentModelOverrides.delete(overrideKey);
				} else {
					subagentModelOverrides.set(overrideKey, picked);
				}
				updateWidget();
				ctx.ui.notify(
					`${label} → ${effectivePicked} (applies on next dispatch of ${parent.def.name})`,
					"success",
				);
				return;
			}

			const name = arg;
			// Team member (live state) OR a research persona — both switchable.
			const def = name ? switchablePersonaDef(name) : undefined;
			if (!def) {
				const known = [
					...Array.from(agentStates.values()).map(s => s.def.name),
					...researchPersonas.map(d => d.name),
				].join(", ");
				ctx.ui.notify(`Usage: /af-agent-model <persona>[.<role>]. Known: ${known || "none"}`, "error");
				return;
			}
			if (!def.models || def.models.length === 0) {
				ctx.ui.notify(
					`${displayName(def.name)} declares no model candidates — add a \`models:\` list to ${def.file} or a \`models.${def.name}:\` override in .ai/agent-fleet-overrides.md.`,
					"warning",
				);
				return;
			}
			const candidates = allowedModels(def);
			const current = resolvedModel(def);
			// A persona without a frontmatter default runs on the dispatcher's model —
			// offer that as an explicit candidate so the override can be cleared.
			const DISPATCHER_DEFAULT = "(dispatcher's model)";
			if (!def.model) candidates.unshift(DISPATCHER_DEFAULT);
			const options = candidates.map(m => {
				const isDefault = def.model ? m === def.model : m === DISPATCHER_DEFAULT;
				const isCurrent = current ? m === current : m === DISPATCHER_DEFAULT;
				const tags = [isDefault ? "default" : "", isCurrent ? "current" : ""].filter(Boolean);
				return tags.length ? `${m} (${tags.join(", ")})` : m;
			});
			const choice = await ctx.ui.select(`Model for ${displayName(def.name)}`, options);
			if (choice === undefined) return;
			const picked = candidates[options.indexOf(choice)];
			const effectivePicked = picked === DISPATCHER_DEFAULT ? picked : (substitutedModel(picked) ?? picked);
			const pickedIsCurrent = current ? effectivePicked === current : picked === DISPATCHER_DEFAULT;
			if (pickedIsCurrent) {
				ctx.ui.notify(`${displayName(def.name)} is already on ${effectivePicked}`, "info");
				return;
			}
			if (picked === def.model || picked === DISPATCHER_DEFAULT) {
				modelOverrides.delete(name);
			} else {
				modelOverrides.set(name, picked);
			}
			updateWidget();
			// Research helpers spawn fresh each time, so the switch lands on their
			// next spawn; team members apply on next dispatch (restartable now).
			const applyHint = (def.kind || "").toLowerCase() === "research"
				? "applies on next spawn_research"
				: `applies on next dispatch; /af-agents-restart ${def.name} to apply now`;
			ctx.ui.notify(`${displayName(def.name)} → ${effectivePicked} (${applyHint})`, "success");
			if ((dispatchPolicy.substitutions[name]?.prefer ?? dispatchPolicy.default) === "coms") {
				ctx.ui.notify(
					`Note: ${displayName(def.name)} prefers a coms peer (dispatch-policy.yaml) — this model override only applies to native(-fallback) runs; the peer keeps its own model.`,
					"info",
				);
			}
		},
		handleAgentModelThinking: async (args, ctx) => {
			widgetCtx = ctx;
			const name = (args || "").trim().toLowerCase();
			// Team member (live state) OR a research persona — both switchable.
			const def = name ? switchablePersonaDef(name) : undefined;
			if (!def) {
				const known = [
					...Array.from(agentStates.values()).map(s => s.def.name),
					...researchPersonas.map(d => d.name),
				].join(", ");
				ctx.ui.notify(`Usage: /af-agent-model-thinking <persona>. Known: ${known || "none"}`, "error");
				return;
			}
			const defaultLevel = resolveThinkingLevel(def.thinking);
			const current = resolveThinkingLevel(resolvedThinking(def));
			const levels = [...THINKING_LEVELS];
			const options = levels.map(l => {
				const tags = [l === defaultLevel ? "default" : "", l === current ? "current" : ""].filter(Boolean);
				return tags.length ? `${l} (${tags.join(", ")})` : l;
			});
			const choice = await ctx.ui.select(`Thinking level for ${displayName(def.name)}`, options);
			if (choice === undefined) return;
			const picked = levels[options.indexOf(choice)];
			if (picked === current) {
				ctx.ui.notify(`${displayName(def.name)} is already on thinking: ${picked}`, "info");
				return;
			}
			if (picked === defaultLevel) {
				thinkingOverrides.delete(name);
			} else {
				thinkingOverrides.set(name, picked);
			}
			updateWidget();
			// Research helpers spawn fresh each time, so the switch lands on their
			// next spawn; team members apply on next dispatch (restartable now).
			const applyHint = (def.kind || "").toLowerCase() === "research"
				? "applies on next spawn_research"
				: `applies on next dispatch; /af-agents-restart ${def.name} to apply now`;
			ctx.ui.notify(`${displayName(def.name)} thinking → ${picked} (${applyHint})`, "success");
		},
		handleModels: async (args, ctx) => {
			widgetCtx = ctx;
			const names = Object.keys(modelProfiles);
			if (names.length === 0) {
				ctx.ui.notify("No model profiles loaded — define .pi/agents/model-profiles.yaml (invalid profiles are dropped at session start).", "warning");
				return;
			}
			let profileName = (args || "").trim();
			if (!profileName) {
				const options = names.map(n =>
					`${n} — ${Object.entries(modelProfiles[n]).map(([p, m]) => `${p}: ${shortModel(m)}`).join(", ")}`,
				);
				const choice = await ctx.ui.select("Select model profile", options);
				if (choice === undefined) return;
				profileName = names[options.indexOf(choice)];
			}
			const profile = modelProfiles[profileName];
			if (!profile) {
				ctx.ui.notify(`No profile "${profileName}". Known: ${names.join(", ")}`, "error");
				return;
			}
			const applied: string[] = [];
			for (const [persona, model] of Object.entries(profile)) {
				const def = allAgentDefs.find(d => d.name.toLowerCase() === persona);
				if (!def) continue; // validated at session start; defensive
				if (model === def.model) modelOverrides.delete(persona);
				else modelOverrides.set(persona, model);
				applied.push(`${displayName(persona)} → ${shortModel(model)}`);
			}
			updateWidget();
			ctx.ui.notify(`Profile "${profileName}": ${applied.join(", ")} (applies on next dispatch)`, "success");
		},
		handleAgentModelsSubstitute: async (args, ctx) => {
			widgetCtx = ctx;
			const tokens = (args || "").trim().split(/\s+/).filter(Boolean);
			if (tokens.length === 0) {
				if (allKnownModels().length === 0) {
					ctx.ui.notify("No configured persona or sub-role models are available as substitution sources.", "warning");
					return;
				}
				await openFleetDashboard(ctx, true);
				return;
			}
			if (tokens.length !== 2) {
				ctx.ui.notify("Usage: /af-agent-models-substitute [<source> <target>]", "error");
				return;
			}
			await applySessionModelSubstitution(tokens[0], tokens[1], ctx);
		},
		handleWatchdog: async (args, ctx) => {
			widgetCtx = ctx;
			const parts = (args || "").trim().split(/\s+/).filter(Boolean);
			if (parts.length === 0) {
				const perAgent = watchdogAgentOverrides.size > 0
					? Array.from(watchdogAgentOverrides.entries()).map(([k, v]) => `${k}: ${v}`).join(", ")
					: "(none)";
				ctx.ui.notify(
					`Drift watchdog: ${watchdogSetting} (hub-wide)\nPer-agent overrides: ${perAgent}\n` +
					`Judge model: ${watchdogJudgeModel || "(researcher persona's, else dispatcher's)"}\n` +
					`Usage: /af-watchdog on|off|auto — or /af-watchdog <agent> on|off|clear`,
					"info",
				);
				return;
			}
			if (parts.length === 1) {
				const setting = normalizeWatchdogSetting(parts[0]);
				if (!setting) {
					ctx.ui.notify(`Unknown setting "${parts[0]}" — expected one of: ${WATCHDOG_SETTINGS.join(", ")} (or /af-watchdog <agent> on|off|clear)`, "error");
					return;
				}
				watchdogSetting = setting;
				ctx.ui.notify(`Drift watchdog → ${setting} (applies from the next dispatch)`, "success");
				return;
			}
			const agentKey = normalizeAgentInput(parts[0]);
			const value = parts[1].toLowerCase();
			if (!agentStates.has(agentKey)) {
				ctx.ui.notify(`"${parts[0]}" is not in the active team (${Array.from(agentStates.values()).map(s => s.def.name).join(", ")})`, "error");
				return;
			}
			if (value === "clear") {
				watchdogAgentOverrides.delete(agentKey);
				ctx.ui.notify(`Drift watchdog override cleared for ${agentKey} (hub-wide setting "${watchdogSetting}" applies)`, "success");
				return;
			}
			if (value !== "on" && value !== "off") {
				ctx.ui.notify(`Per-agent watchdog must be on, off, or clear — got "${parts[1]}"`, "error");
				return;
			}
			watchdogAgentOverrides.set(agentKey, value);
			ctx.ui.notify(`Drift watchdog for ${agentKey} → ${value} (overrides the hub-wide "${watchdogSetting}")`, "success");
		},
		handleComs: async (args, ctx) => {
			if (!comsReady) { ctx.ui.notify("coms is not active in this session.", "warning"); return; }
			await coms.updateScope((args ?? "").trim(), ctx);
		},
		handleHandoff: async (args, ctx) => {
			if (modelWorkBlockedByRosterRecovery(ctx)) return;
			if (!comsReady) { ctx.ui.notify("coms is not active in this session — /af-handoff unavailable.", "warning"); return; }
			const target = (args ?? "").trim();
			if (!target) {
				ctx.ui.notify("Usage: /af-handoff <peer>. See the coms pool for live peer names.", "error");
				return;
			}
			const peer = resolveTarget(target);
			if (!peer) {
				ctx.ui.notify(`coms: no live peer "${target}". Use /af-coms to refresh the pool.`, "error");
				return;
			}
			const handoffToken = crypto.randomBytes(8).toString("hex");
			pendingHandoff = { target: peer.name, token: handoffToken };
			pi.sendMessage({
				customType: "coms-handoff",
				content:
					`HANDOFF REQUEST → peer "${peer.name}".\n\n` +
					`Compose a SELF-CONTAINED handoff brief (the peer does NOT share your context): state the ` +
					`overall goal, what's been done so far, key decisions and constraints, the current status, ` +
					`and the concrete next steps you want the peer to take. Then call ` +
					`coms_send(target: "${peer.name}", handoff_token: "${handoffToken}", prompt: <the brief only; the hub appends the verification ledger and artifact index in code only when this token matches>), coms_await its msg_id, and relay ` +
					`the peer's reply to me in ${userLanguage}.`,
				display: true,
			}, { deliverAs: "followUp", triggerTurn: true });
			ctx.ui.notify(`Handoff to ${peer.name}: asking the dispatcher to compose a brief…`, "info");
		},
		handleCompound: async (args, ctx) => {
			if (modelWorkBlockedByRosterRecovery(ctx)) return;
			if (!agentStates.has("documenter")) {
				ctx.ui.notify(
					"compound: the documenter persona is not in the active team — switch with /af-agents-team (e.g. default or release), then re-run /af-compound.",
					"warning",
				);
				return;
			}
			const focus = (args ?? "").trim();
			const rulesLine = projectRulesDirs.length > 0
				? projectRulesDirs.join(", ")
				: "(none declared in .ai/agent-fleet-overrides.md — the documenter must locate an existing rules tree or, failing that, propose lessons without writing)";
			const docsLine = projectDocsPaths.length > 0
				? projectDocsPaths.join(", ")
				: "(none declared)";
			pi.sendMessage({
				customType: "compound-learning",
				content:
					`COMPOUND REQUEST — capture this session's lessons into the project's rules and docs (compound-learning pass).\n\n` +
					`1. From THIS session's context, compose a candidate-lessons brief: user corrections, review findings that recurred, ` +
					`wrong assumptions that cost rework, debugging root causes, and changes that invalidated existing docs. At most 5 lessons; ` +
					`each is one imperative sentence plus a one-line Why (the failure it prevents) and a one-line Evidence (what happened this session). ` +
					`${focus ? `Focus especially on: ${focus}. ` : ""}` +
					`If nothing rises to a lesson, tell the user there is nothing worth compounding and stop.\n` +
					`2. Confirm the list with the user in ${userLanguage} (ask_user when available) — they approve, trim, or reword. Do not dispatch before this confirmation.\n` +
					`3. Dispatch the documenter with a SELF-CONTAINED task (it shares none of your context) containing: the approved lessons verbatim ` +
					`(with Why + Evidence); the project rule folders: ${rulesLine}; the docs entry points: ${docsLine}; the assertion ledger path ` +
					`.pi/agent-sessions/assertions.json (when it exists); and the instruction to read skills/compound-learning/SKILL.md and follow it exactly — ` +
					`dedupe index-first against the existing rule tree, minimal diffs on existing files, caps of 5 lessons / 1 new file. State that the user ` +
					`already approved this lesson list, so it may apply without a second gate. Pass the relevant review/return/evidence artifact paths via the ` +
					`dispatch's artifacts array — paths only, never pasted bodies.\n` +
					`4. Relay the documenter's file-by-file result to me in ${userLanguage}.`,
				display: true,
			}, { deliverAs: "followUp", triggerTurn: true });
			ctx.ui.notify("Compound: asking the dispatcher to compose the candidate-lessons brief…", "info");
		},
		getAgentsKillCompletions: prefix => agentsKillCompletions(prefix),
		getZoomCompletions: prefix => zoomCompletions(prefix),
		getAgentModelCompletions: prefix => agentModelCompletions(prefix),
		getAgentModelThinkingCompletions: prefix => agentThinkingCompletions(prefix),
		getModelProfileCompletions: prefix => modelProfileCompletions(prefix),
		getSubstituteCompletions: prefix => substituteCompletions(prefix),
		getComsPeerCompletions: prefix => comsPeerCompletions(prefix),
		getSubagentTargetCompletions: prefix => subagentTargetCompletions(prefix),
	};

	// Keep the complete command surface flat and greppable in this composition root.
	registerAgentsTeam(pi, commandCtx);
	registerAgentsList(pi, commandCtx);
	registerAgentsHistory(pi, commandCtx);
	registerContextCommand(pi, commandCtx);
	registerWorkMode(pi, commandCtx);
	registerWatchdog(pi, commandCtx);
	registerAgentsAdd(pi, commandCtx);
	registerAgentsDrop(pi, commandCtx);
	registerAgentsSave(pi, commandCtx);
	registerHubReport(pi, commandCtx);
	registerZoom(pi, commandCtx);
	registerAgentModel(pi, commandCtx);
	registerAgentModelThinking(pi, commandCtx);
	registerModels(pi, commandCtx);
	registerAgentModelsSubstitute(pi, commandCtx);
	registerDispatchPolicy(pi, commandCtx);
	registerAgentsKill(pi, commandCtx);
	registerAgentsRestart(pi, commandCtx);
	registerComs(pi, commandCtx);
	registerHandoff(pi, commandCtx);
	registerCompound(pi, commandCtx);

	let fleetShowFinished = false;
	let fleetFilter = "";
	function fleetRows(unfiltered = false): FleetRow[] {
		// agentStates is the roster and its live state in one keyed map: a dispatch
		// updates this row instead of adding a second live-specialist source.
		const specialists: SpecialistInput[] = Array.from(agentStates.entries()).map(([key, state]) => ({
			key, name: displayName(state.def.name), status: state.status,
			model: state.lastBackend === "coms" ? `⇄ ${shortModel(state.comsPeerModel)}` : modelWithThinking(state.def), backend: state.lastBackend ?? "native",
			contextPct: state.contextPct, contextTokens: state.contextTokens, ...fleetTiming(state.histEntry),
			toolCount: state.toolCount, lastWork: state.lastWork || state.task || state.def.description, hasTimeline: true,
			delegates: Array.from(state.delegations?.values() ?? []).map(child => ({ key: child.id, name: child.role || child.id, status: child.status, model: shortModel(child.model), contextPct: null, contextTokens: child.tokens, elapsed: child.status === "running" ? Date.now() - child.startedAt : child.elapsed, startedAt: child.startedAt, toolCount: child.toolCount, lastWork: child.lastWork, children: [] })),
		}));
		const research: ResearchInput[] = Array.from(researchStates.values()).map(state => ({ key: `r${state.id}`, name: `r${state.id} ${state.persona ? displayName(state.def.name) : "research"}`, status: state.status, model: shortModel(state.model) + thinkingSuffix(resolvedThinking(state.def)), backend: "native", contextPct: state.contextPct, contextTokens: null, ...fleetTiming(state.histEntry), toolCount: state.toolCount, lastWork: state.lastWork || state.task, hasTimeline: true }));
		const peers = fleetPeerInputs(model => `⇄ ${abbreviateModel(model)}`);
		return buildFleetRows({ specialists, research, peers }, unfiltered ? { showFinished: true } : { showFinished: fleetShowFinished, query: fleetFilter });
	}
	type FleetDetailModelTarget =
		| { kind: "specialist"; current: string; state: AgentState }
		| { kind: "research"; current: string; state: ResearchState }
		| { kind: "delegate"; current: string; delegation: NonNullable<ReturnType<typeof findDelegationChild>>; role: [string, SubagentRole]; overrideKey: string };

	function resolveFleetDetailModelTarget(row: FleetRow, ctx: any): FleetDetailModelTarget | null {
		if (row.kind === "peer") {
			ctx.ui.notify("External coms peers control their own model; switch it in that peer's Pi session.", "info");
			return null;
		}
		if (row.kind === "specialist") {
			const state = agentStates.get(row.key);
			if (!state) { ctx.ui.notify("This specialist is no longer available.", "warning"); return null; }
			return { kind: "specialist", current: resolvedModel(state.def) ?? "", state };
		}
		if (row.kind === "research") {
			const state = researchStates.get(parseResearchHandle(row.key)!);
			if (!state) { ctx.ui.notify("This research helper is no longer available.", "warning"); return null; }
			return { kind: "research", current: state.model, state };
		}
		const delegation = findDelegationChild(row.key);
		if (!delegation) { ctx.ui.notify("This nested delegate is no longer available.", "warning"); return null; }
		const role = Object.entries(delegation.owner.def.subagents ?? {})
			.find(([name]) => name.toLowerCase() === delegation.child.role.toLowerCase());
		if (!role) {
			ctx.ui.notify(`The role for ${row.name} is no longer declared by ${displayName(delegation.owner.def.name)}.`, "warning");
			return null;
		}
		const overrideKey = `${delegation.owner.def.name.toLowerCase()}.${role[0].toLowerCase()}`;
		return { kind: "delegate", current: resolvedSubagentModel(delegation.owner.def.name, role[0], role[1].model), delegation, role, overrideKey };
	}

	async function loadAvailableModelChoices(ctx: any, current?: string): Promise<FleetModelChoice[] | null> {
		try { await ctx.modelRegistry?.refresh?.(); } catch { /* retain the registry's last-known available list */ }
		const choices = fleetModelChoices(ctx.modelRegistry?.getAvailable?.() ?? [], current);
		if (choices.length === 0) {
			const diagnostic = ctx.modelRegistry?.getError?.();
			ctx.ui.notify(`Pi reports no available models${diagnostic ? `: ${diagnostic}` : "."}`, "warning");
			return null;
		}
		return choices;
	}

	/** Load every model Pi currently reports as available for the inline picker. */
	async function loadFleetDetailModelChoices(row: FleetRow, ctx: any): Promise<{ choices: FleetModelChoice[]; current: string } | null> {
		const target = resolveFleetDetailModelTarget(row, ctx);
		if (!target) return null;
		const choices = await loadAvailableModelChoices(ctx, target.current);
		return choices ? { choices, current: target.current } : null;
	}

	function substitutionSourceChoices(): FleetModelChoice[] {
		return allKnownModels().map(spec => {
			const target = modelSubstitutions.get(spec);
			return { spec, label: target ? `${spec} → ${target} (active this session)` : spec };
		});
	}

	async function applySessionModelSubstitution(source: string, target: string, ctx: any): Promise<boolean> {
		const known = allKnownModels();
		if (!known.includes(source)) {
			ctx.ui.notify(`Unknown configured source model "${source}". Choose one of: ${known.join(", ") || "none"}.`, "error");
			return false;
		}
		const available = await loadAvailableModelChoices(ctx, modelSubstitutions.get(source));
		if (!available) return false;
		if (!available.some(choice => choice.spec === target)) {
			ctx.ui.notify(`Target model "${target}" is not currently available in Pi.`, "error");
			return false;
		}
		if (source === target) {
			ctx.ui.notify(`Source and target are the same (${source}); the session substitution was not changed.`, "info");
			return false;
		}
		const previous = modelSubstitutions.get(source);
		if (previous === target) {
			ctx.ui.notify(`Substitution ${source} → ${target} is already active for this session.`, "info");
			return false;
		}
		modelSubstitutions.set(source, target);
		const personas = allAgentDefs.filter(def => (modelOverrides.get(def.name.toLowerCase()) ?? def.model) === source);
		const roles = allAgentDefs.flatMap(def => Object.entries(def.subagents ?? {})
			.filter(([role, config]) => (subagentModelOverrides.get(`${def.name.toLowerCase()}.${role.toLowerCase()}`) ?? config.model) === source)
			.map(([role]) => `${def.name}.${role}`));
		updateWidget();
		ctx.ui.notify(
			`${previous ? "Updated" : "Saved"} session substitution ${source} → ${target}. ` +
			`${personas.length} persona${personas.length === 1 ? "" : "s"} and ${roles.length} sub-role${roles.length === 1 ? "" : "s"} currently resolve through it; ` +
			`future agents spawned from the same configured source inherit it automatically. Current runs are not interrupted.`,
			"success",
		);
		return true;
	}

	/** Apply an inline-picker choice to the next run; never interrupt a live child. */
	function applyFleetDetailModel(row: FleetRow, picked: string, ctx: any): boolean {
		const target = resolveFleetDetailModelTarget(row, ctx);
		if (!target) return false;
		const effectivePicked = substitutedModel(picked) ?? picked;
		if (effectivePicked === target.current) {
			ctx.ui.notify(`${row.name} is already on ${effectivePicked}`, "info");
			return false;
		}
		let applyHint = "applies on the next run";
		if (target.kind === "specialist") {
			const key = target.state.def.name.toLowerCase();
			if (picked === target.state.def.model) modelOverrides.delete(key);
			else modelOverrides.set(key, picked);
			applyHint = "applies on the next dispatch";
		} else if (target.kind === "research") {
			target.state.model = picked;
			applyHint = `applies when r${target.state.id} next continues or restarts`;
		} else {
			if (picked === target.role[1].model) subagentModelOverrides.delete(target.overrideKey);
			else subagentModelOverrides.set(target.overrideKey, picked);
			applyHint = `applies on the next ${displayName(target.delegation.owner.def.name)} dispatch`;
		}
		updateWidget();
		ctx.ui.notify(`${row.name} → ${effectivePicked} (${applyHint}; current runs are not interrupted)`, "success");
		if (target.kind === "specialist" && (dispatchPolicy.substitutions[target.state.def.name.toLowerCase()]?.prefer ?? dispatchPolicy.default) === "coms") {
			ctx.ui.notify("This specialist prefers a coms peer; the choice applies to native fallback runs, while the peer keeps its own model.", "info");
		}
		return true;
	}

	function matchedFleetDetailInput(data: string): string {
		const key: FleetDetailKey | undefined =
			matchesKey(data, Key.up) ? "up"
				: matchesKey(data, Key.down) ? "down"
					: matchesKey(data, Key.pageUp) ? "pageUp"
						: matchesKey(data, Key.pageDown) ? "pageDown"
							: matchesKey(data, Key.home) ? "home"
								: matchesKey(data, Key.end) ? "end"
									: matchesKey(data, Key.enter) ? "enter"
										: matchesKey(data, Key.escape) ? "escape"
											: matchesKey(data, Key.ctrl("c")) ? "copy"
												: undefined;
		return normalizeFleetDetailInput(data, key);
	}

	async function openFleetDetail(row: FleetRow, ctx: any, initialVerbose = false): Promise<boolean> {
		const target = row.kind === "research" ? researchStates.get(parseResearchHandle(row.key)!) : row.kind === "delegate" ? findDelegationChild(row.key)?.child : agentStates.get(row.key);
		const resources = createPanelResources();
		let detailRow = row;
		let modelPicker: { choices: FleetModelChoice[]; index: number; scrollOffset: number } | null = null;
		let scrollOffset = 0, selectedIndex = 0, expandedIndex: number | null = null, followTail = true, verbose = initialVerbose, lastRender = 0;
		const transcriptPath = target?.transcriptStore?.path;
		let transcriptRecords: FleetTranscriptRecord[] | null = transcriptPath
			? readFleetTranscriptTail(transcriptPath, { limit: 2000 }).records
			: null;
		const compactRecords = (records: readonly FleetTranscriptRecord[]): TimelineEntry[] => {
			const entries: TimelineEntry[] = [];
			for (const { event } of records) {
				const current = event as TimelineEntry;
				const last = entries[entries.length - 1];
				const merge = last && last.kind === current.kind
					&& (current.kind === "text" || current.kind === "thinking" || (last.callId && last.callId === current.callId));
				if (merge && last.content.length < MAX_LIVE_ENTRY_CHARS) {
					const room = MAX_LIVE_ENTRY_CHARS - last.content.length;
					last.content += current.content.slice(0, room);
					if (current.content.length > room) entries.push({ ...current, content: current.content.slice(room) });
				} else entries.push({ ...current });
			}
			return entries;
		};
		const timeline = () => transcriptRecords ? compactRecords(transcriptRecords) : [...liveTimeline(target)] as TimelineEntry[];
		const syncTranscriptTail = () => {
			if (!transcriptPath || !transcriptRecords || !followTail) return;
			const after = transcriptRecords[transcriptRecords.length - 1]?.endOffset ?? 0;
			const page = readFleetTranscript(transcriptPath, { after, limit: 500 });
			if (page.records.length > 0) transcriptRecords.push(...page.records);
			if (transcriptRecords.length > 2000) transcriptRecords.splice(0, transcriptRecords.length - 2000);
		};
		const loadOlderTranscript = () => {
			if (!transcriptPath || !transcriptRecords) return 0;
			const before = transcriptRecords[0]?.startOffset ?? 0;
			if (before <= 0) return 0;
			const older = readFleetTranscriptBefore(transcriptPath, { before, limit: 500 }).records;
			transcriptRecords.unshift(...older);
			if (transcriptRecords.length > 2000) transcriptRecords.splice(2000);
			return compactRecords(older).length;
		};
		const loadNewerTranscript = (): number => {
			if (!transcriptPath || !transcriptRecords) return 0;
			const after = transcriptRecords[transcriptRecords.length - 1]?.endOffset ?? 0;
			const newer = readFleetTranscript(transcriptPath, { after, limit: 500 }).records;
			if (newer.length === 0) return 0;
			transcriptRecords.push(...newer);
			const overflow = Math.max(0, transcriptRecords.length - 2000);
			const removed = overflow > 0 ? compactRecords(transcriptRecords.slice(0, overflow)).length : 0;
			if (overflow > 0) transcriptRecords.splice(0, overflow);
			return removed;
		};
		const reloadTranscriptTail = () => {
			if (!transcriptPath) return;
			transcriptRecords = readFleetTranscriptTail(transcriptPath, { limit: 2000 }).records;
		};
		try { await ctx.ui.custom((tui: any, theme: any, _kb: any, done: () => void) => {
			if (target) target.zoomRender = (force?: boolean) => { const now = Date.now(); if (force || now - lastRender > 80) { lastRender = now; tui.requestRender(); } };
			resources.every(2000, () => tui.requestRender());
			return {
				render: (w: number) => {
					const body = bodyRows(tui.terminal?.rows, DETAIL_CHROME_ROWS);
					if (modelPicker) return renderFleetModelPicker(detailRow.name, modelPicker.choices, modelPicker, w, body, theme);
					syncTranscriptTail();
					const entries = timeline();
					if (followTail) {
						selectedIndex = Math.max(0, entries.length - 1);
						scrollOffset = Math.max(0, detailContent(entries, w, expandedIndex, verbose, selectedIndex).length - body);
					}
					const liveRow = detailRow.status === "running" && detailRow.startedAt != null
						? { ...detailRow, elapsed: Date.now() - detailRow.startedAt }
						: detailRow;
					return renderFleetDetail(liveRow, entries, scrollOffset, w, body, theme, expandedIndex, verbose, selectedIndex);
				},
				handleInput: async (data: string) => {
					const input = matchedFleetDetailInput(data);
					const body = bodyRows(tui.terminal?.rows, DETAIL_CHROME_ROWS);
					if (modelPicker) {
						const action = modelPickerTransition(input, modelPicker, modelPicker.choices.length, body);
						if (action === "cancel") modelPicker = null;
						else if (action === "select") {
							const picked = modelPicker.choices[modelPicker.index]?.spec;
							modelPicker = null;
							if (picked && applyFleetDetailModel(detailRow, picked, ctx)) {
								const effectivePicked = substitutedModel(picked) ?? picked;
								detailRow = { ...detailRow, model: detailRow.status === "running" ? `${detailRow.model} → ${shortModel(effectivePicked)} next` : `${shortModel(effectivePicked)} (next)` };
							}
						}
						tui.requestRender();
						return;
					}
					if ((input === "\u001b[A" || input === "k" || input === "\u001b[5~" || input === "\u001b[H") && scrollOffset === 0) {
						const added = loadOlderTranscript();
						selectedIndex += added;
					}
					if (input === "\u001b[F") reloadTranscriptTail();
					let entries = timeline();
					if (!followTail && (input === "\u001b[B" || input === "j" || input === "\u001b[6~") && selectedIndex >= entries.length - 1) {
						selectedIndex = Math.max(0, selectedIndex - loadNewerTranscript());
						entries = timeline();
					}
					const width = tui.terminal?.columns ?? 80;
					const state = { scrollOffset, selectedIndex, expandedIndex, followTail, verbose };
					const content = detailContent(entries, width, expandedIndex, verbose, selectedIndex);
					const offsets = detailEntryOffsets(entries, width, expandedIndex, verbose);
					const action = detailTransition(input, state, entries, body, content.length, offsets);
					({ scrollOffset, selectedIndex, expandedIndex, followTail, verbose } = state);
					if (action === "close") done();
					else if (action === "copy") {
						const item = entries[selectedIndex];
						if (item) { try { await copyToClipboard(item.content); ctx.ui.notify("Copied selected zoom row", "success"); } catch { ctx.ui.notify("Failed to copy selected zoom row", "error"); } }
					} else if (action === "model") {
						const loaded = await loadFleetDetailModelChoices(detailRow, ctx);
						if (loaded) {
							const currentIndex = loaded.choices.findIndex(choice => choice.spec === loaded.current);
							modelPicker = { choices: loaded.choices, index: Math.max(0, currentIndex), scrollOffset: Math.max(0, currentIndex) };
						}
					}
					tui.requestRender();
				},
				invalidate() {},
				dispose: () => resources.dispose(),
			};
		}, FULLSCREEN_OVERLAY); } finally { resources.dispose(); if (target) target.zoomRender = undefined; }
		return verbose;
	}
	async function restartFleetRow(selected: FleetRow, ctx: any): Promise<void> {
		if (modelWorkBlockedByRosterRecovery(ctx)) return;
		const decision = resolveFleetRestart(selected, {
			researchRestartable: (key) => {
				const state = researchStates.get(parseResearchHandle(key)!);
				return !!(state?.task && state.status !== "running");
			},
			specialistRestartable: (key) => !!(agentStates.get(key)?.task),
		});
		if (decision.action === "unsupported") {
			ctx.ui.notify(decision.message, decision.level);
			return;
		}
		if (decision.action === "restart-research") {
			const state = researchStates.get(parseResearchHandle(selected.key)!);
			if (!state?.task) { ctx.ui.notify(decision.message.replace("Restarting", "Cannot restart"), "warning"); return; }
			state.sessionFile = null; state.turnCount = 1;
			ctx.ui.notify(decision.message, "info");
			spawnResearch(state, state.task, ctx).then(result => deliverResearchFollowUp(state, result));
			return;
		}
		const state = agentStates.get(selected.key);
		if (!state?.task) { ctx.ui.notify(decision.message.replace("Restarting", "Cannot restart"), "warning"); return; }
		if (state.status === "running" && (state.proc || state.comsAbort)) {
			let resolveTermination!: () => void;
			const terminated = new Promise<void>(resolve => { resolveTermination = resolve; });
			state.onTerminate = resolveTermination;
			if (state.proc) { state.killedByOperator = true; state.restarting = true; killPiTree(state.proc); }
			else await cancelLocalWaitOnly({ abort: state.comsAbort, monitorBridge, monitorKey: monitorKeyForAgent(state.def.name, state.runCount), event: { kind: "restart" } });
			await terminated;
		}
		state.sessionFile = null;
		ctx.ui.notify(decision.message.includes(displayName(state.def.name)) ? decision.message : `Restarting ${displayName(state.def.name)} (fresh)...`, "info");
		const result = await dispatchAgent(state.def.name, state.task, ctx);
		pi.sendMessage({ customType: "agent-restart-result", content: `[${displayName(state.def.name)}] restarted by operator and ${result.exitCode === 0 ? "completed" : "failed"} in ${Math.round(result.elapsed / 1000)}s.`, display: true }, { deliverAs: "followUp", triggerTurn: true });
	}
	type FleetSubstitutionPickerState = {
		stage: "source" | "target";
		source?: string;
		choices: FleetModelChoice[];
		index: number;
		scrollOffset: number;
	};

	async function openFleetDashboard(ctx: any, startSubstitution = false): Promise<void> {
		const resources = createPanelResources();
		const selection: Selection = { index: 0 };
		let scrollOffset = 0;
		let filtering = false;
		let detailVerbose = false;
		let confirm: DashboardConfirm = null;
		let substitutionPicker: FleetSubstitutionPickerState | null = startSubstitution
			? { stage: "source", choices: substitutionSourceChoices(), index: 0, scrollOffset: 0 }
			: null;
		const toInput = (data: string): string => {
			if (matchesKey(data, Key.up)) return "\u001b[A";
			if (matchesKey(data, Key.down)) return "\u001b[B";
			if (matchesKey(data, Key.pageUp)) return "\u001b[5~";
			if (matchesKey(data, Key.pageDown)) return "\u001b[6~";
			if (matchesKey(data, Key.enter)) return "\r";
			if (matchesKey(data, Key.escape)) return "\u001b";
			return data;
		};
		try {
			await ctx.ui.custom((tui: any, theme: any, _kb: any, done: () => void) => {
				attachFleetDashboardTicker(resources, () => tui.requestRender());
				return {
				render: (w: number) => {
					const rows = fleetRows();
					reconcileSelection(selection, rows);
					const body = bodyRows(tui.terminal?.rows, FLEET_CHROME_ROWS);
					if (substitutionPicker) {
						return renderFleetSubstitutionPicker(
							substitutionPicker.stage, substitutionPicker.source, substitutionPicker.choices,
							substitutionPicker, w, body, theme,
						);
					}
					scrollOffset = clampScroll(scrollOffset, rows.length, body);
					const summary = summarise(rows);
					return renderFleetDashboard({
						rows, selection, scrollOffset, filterQuery: fleetFilter, showFinished: fleetShowFinished,
						confirmation: confirm && confirm.until > Date.now()
							? `press ${confirm.action === "kill" ? "x" : "r"} again to ${confirm.action} ${rows.find(r => r.key === confirm!.key)?.name ?? "agent"}`
							: undefined,
						summary: { ...summary, wallMs: unionMs(summary.intervals) },
					}, w, body, theme);
				},
				handleInput: async (data: string) => {
					const rows = fleetRows();
					reconcileSelection(selection, rows);
					const body = bodyRows(tui.terminal?.rows, FLEET_CHROME_ROWS);
					const input = toInput(data);
					if (substitutionPicker) {
						const action = modelPickerTransition(input, substitutionPicker, substitutionPicker.choices.length, body);
						if (action === "cancel") {
							if (substitutionPicker.stage === "target") {
								const source = substitutionPicker.source;
								const choices = substitutionSourceChoices();
								const index = Math.max(0, choices.findIndex(choice => choice.spec === source));
								substitutionPicker = { stage: "source", choices, index, scrollOffset: index };
							} else substitutionPicker = null;
						} else if (action === "select") {
							const picked = substitutionPicker.choices[substitutionPicker.index]?.spec;
							if (picked && substitutionPicker.stage === "source") {
								const targets = await loadAvailableModelChoices(ctx, modelSubstitutions.get(picked));
								if (targets) {
									const current = modelSubstitutions.get(picked);
									const index = Math.max(0, targets.findIndex(choice => choice.spec === current));
									substitutionPicker = { stage: "target", source: picked, choices: targets, index, scrollOffset: index };
								}
							} else if (picked && substitutionPicker.source) {
								await applySessionModelSubstitution(substitutionPicker.source, picked, ctx);
								substitutionPicker = null;
							}
						}
						tui.requestRender();
						return;
					}
					const state = { selection, scrollOffset, filtering, filterQuery: fleetFilter, showFinished: fleetShowFinished, confirm };
					const intent = dashboardTransition(input, state, rows, body);
					({ scrollOffset, filtering, confirm } = state);
					fleetFilter = state.filterQuery;
					fleetShowFinished = state.showFinished;
					if (intent === "close") done();
					else if (intent === "substitute") {
						const choices = substitutionSourceChoices();
						if (choices.length === 0) ctx.ui.notify("No configured persona or sub-role models are available as substitution sources.", "warning");
						else substitutionPicker = { stage: "source", choices, index: 0, scrollOffset: 0 };
					} else if (intent && typeof intent === "object" && "open" in intent) {
						const selected = rows.find(r => r.key === intent.open) ?? rows[selection.index];
						if (selected) detailVerbose = await openFleetDetail(selected, ctx, detailVerbose);
					} else if (intent && typeof intent === "object" && "kill" in intent) {
						const selected = rows.find(r => r.key === intent.kill);
						if (!selected) ctx.ui.notify("Selected fleet row no longer exists.", "warning");
						else {
							const decision = resolveFleetKill(selected, {
								researchExists: (key) => !!researchStates.get(parseResearchHandle(key)!),
								agentHandles: (key) => {
									const agent = agentStates.get(key);
									return agent ? { proc: agent.proc, comsAbort: agent.comsAbort } : undefined;
								},
							});
							if (decision.action === "kill-research") {
								const rs = researchStates.get(parseResearchHandle(selected.key)!);
								if (rs) { removeResearchHelper(rs, ctx); ctx.ui.notify(decision.message, "info"); }
								else ctx.ui.notify(`Research ${selected.name} is no longer available.`, "warning");
							} else if (decision.action === "kill-proc") {
								const agent = agentStates.get(selected.key)!;
								agent.killedByOperator = true;
								cancelLocalOwnedProcess({ process: agent.proc, monitorBridge, monitorKey: monitorKeyForAgent(agent.def.name, agent.runCount), treeKill: killPiTree });
								ctx.ui.notify(decision.message, "info");
							} else if (decision.action === "coms-abort") {
								agentStates.get(selected.key)?.comsAbort?.();
								ctx.ui.notify(decision.message, "info");
							} else {
								ctx.ui.notify(decision.message, decision.level);
							}
						}
					} else if (intent && typeof intent === "object" && "restart" in intent) {
						const selected = rows.find(r => r.key === intent.restart);
						if (selected) await restartFleetRow(selected, ctx);
					}
					tui.requestRender();
				},
				invalidate() {},
				dispose: () => resources.dispose(),
				};
			}, FULLSCREEN_OVERLAY);
		} finally { resources.dispose(); }
	}


	function toolSchemaChars(toolList: string): number {
		const names = toolList.split(",").map(name => name.trim()).filter(Boolean);
		const all = typeof pi.getAllTools === "function" ? pi.getAllTools() : [];
		const byName = new Map(all.map((tool: any) => [tool.name, tool]));
		return names.reduce((sum, name) => {
			const tool = byName.get(name);
			return sum + (tool ? safeSchemaChars({ name: tool.name, description: tool.description, parameters: tool.parameters, promptGuidelines: tool.promptGuidelines }) : name.length);
		}, 0);
	}
	function contextPlanes(ctx: any): LivePlane[] {
		// Keep the projection decomposed along the same standing components native
		// spawn appends. It intentionally counts no task/history: this is cold-start.
		const baseChars = safeSchemaChars(ctx?.getSystemPromptOptions?.() ?? {});
		const projection = (def: AgentDef, research = false) => research
			? researchStandingParts({
				replacementPrompt: nativeResearchSystemPrompt({
					personaName: def.name,
					personaPath: def.file,
					cwd: ctx?.cwd || process.cwd(),
				}),
				toolChars: toolSchemaChars(RESEARCH_TOOLS),
				// --system-prompt plus --no-skills/--no-context-files replaces
				// inherited child prompt inputs; only the explicit prompt/tools remain.
				basePromptChars: 0,
			})
			: specialistStandingParts({
				replacementPrompt: nativeSpecialistSystemPrompt({
					// An active child projects the exact metadata retained for its
					// spawn/resume; an inactive card is a task-free cold-start estimate.
					manifest: agentStates.get(def.name.toLowerCase())?.specialistManifest
						?? buildSpecialistContextManifest({
							personaName: def.name, personaPath: def.file, personaPrompt: def.systemPrompt,
							task: "", rulesPaths: specialistProjectPolicyPaths(ctx?.cwd || process.cwd()), docsPaths: projectDocsPaths,
							hasAssertions: false, hasScope: false, hasArtifacts: false,
							delegateRoles: def.subagents && delegateExtPath ? Object.keys(def.subagents) : [],
						}),
					userLanguage, agentKey: safeAgentKey(def.name), runNumber: agentStates.get(def.name.toLowerCase())?.runCount ?? 0,
				}),
				toolChars: toolSchemaChars(def.tools),
			});
		const delegateProjection = (owner: AgentState, child: DelegationChild) => {
			const roleEntry = Object.entries(owner.def.subagents ?? {}).find(([name]) => name.toLowerCase() === child.role.toLowerCase());
			if (!roleEntry) return undefined;
			return delegateStandingParts({
				toolChars: toolSchemaChars(child.tools || roleEntry[1].tools || owner.def.tools),
				basePromptChars: baseChars,
				roleNames: [roleEntry[0]],
			});
		};
		const windowFor = (model: string) => model ? resolveContextWindow(model, { lookup: modelWindowLookup(ctx), fallbackWindow: 0 }).window || undefined : undefined;
		const local = allAgentDefs.filter(def => def.kind !== "research").map(def => {
			const state = agentStates.get(def.name.toLowerCase());
			const model = state ? (resolvedModel(state.def) ?? "") : (resolvedModel(def) ?? "");
			return { id: `specialist/${def.name}`, label: displayName(def.name), plane: "specialist" as const, model, window: windowFor(model), tokens: state?.contextTokens, projectionParts: projection(def) };
		});
		const research = researchPersonas.map(def => {
			const active = Array.from(researchStates.values()).find(state => state.def.name === def.name);
			const model = active?.model ?? resolvedModel(def) ?? "";
			return { id: `research/${def.name}`, label: displayName(def.name), plane: "research" as const, model, window: windowFor(model), tokens: active?.contextTokens, projectionParts: projection(def, true), attribution: "projected" as const };
		});
		const delegates = Array.from(agentStates.values()).flatMap(state => Array.from(state.delegations?.values() ?? []).map(child => {
			const projectionParts = delegateProjection(state, child);
			return projectionParts
				? { id: `delegate/${child.id}`, label: child.role, plane: "delegate" as const, model: child.model, window: windowFor(child.model), tokens: child.tokens, projectionParts, attribution: "projected" as const }
				: { id: `delegate/${child.id}`, label: child.role, plane: "delegate" as const, model: child.model, window: windowFor(child.model), tokens: child.tokens, attribution: "unavailable" as const };
		}));
		const peers = Array.from(peerCards.values()).map(peer => ({ id: `peer/${peer.name}`, label: peer.name, plane: "peer" as const, model: peer.model, window: windowFor(peer.model ?? ""), percent: peer.context_used_pct, projectionChars: 0, attribution: "unavailable" as const }));
		return [...local, ...research, ...delegates, ...peers];
	}

	async function openContextBudget(ctx: any): Promise<void> {
		const resources = createPanelResources();
		const toInput = (data: string): string => {
			if (matchesKey(data, Key.up)) return "\u001b[A";
			if (matchesKey(data, Key.down)) return "\u001b[B";
			if (matchesKey(data, Key.pageUp)) return "\u001b[5~";
			if (matchesKey(data, Key.pageDown)) return "\u001b[6~";
			if (matchesKey(data, Key.enter)) return "\r";
			if (matchesKey(data, Key.escape)) return "\u001b";
			return data;
		};
		const state: ContextBudgetViewState = { selection: { index: 0 }, expanded: new Set(), scrollOffset: 0 };
		const collect = () => {
			// Build the replacement prompt ledger now rather than waiting for the first
			// before_agent_start hook; this is pure prompt construction, not a turn.
			buildHubSystemPrompt(false);
			return collectContextBudgetSnapshot(ctx, {
			ledger: lastHubLedger,
			pressure: contextPressureDiagnostic(contextPressureState),
			planes: contextPlanes(ctx),
			tools: typeof pi.getAllTools === "function" ? pi.getAllTools() : [],
			activeToolNames: typeof pi.getActiveTools === "function" ? pi.getActiveTools() : [],
			commands: typeof pi.getCommands === "function" ? pi.getCommands() : [],
			});
		};
		let snapshot = collect();
		const refresh = () => { snapshot = collect(); };
		try {
			await ctx.ui.custom((tui: any, _theme: any, _kb: any, done: () => void) => {
				resources.every(1000, () => { refresh(); tui.requestRender(); });
				return {
					render: (w: number) => renderContextBudget(snapshot, state, w, bodyRows(tui.terminal?.rows, CONTEXT_BUDGET_CHROME_ROWS)),
					handleInput: (data: string) => { const intent = contextBudgetTransition(toInput(data), state, snapshot, bodyRows(tui.terminal?.rows, CONTEXT_BUDGET_CHROME_ROWS)); if (intent === "close") done(); if (intent === "refresh") refresh(); tui.requestRender(); },
					invalidate() {}, dispose: () => resources.dispose(),
				};
			}, FULLSCREEN_OVERLAY);
		} finally { resources.dispose(); }
	}

	function rosterRefusalMessage(): string {
		return "Orchestrator work mode requires at least one native specialist. Add one with /af-agents-add or select /af-agents-team first.";
	}

	function watchdogArmedNote(next: WorkMode): string {
		if (next !== "orchestrator") return "";
		const armed = resolveWatchdogActive(undefined, undefined, watchdogSetting, next);
		return armed
			? "\nDrift watchdog: armed (orchestrator auto). /af-watchdog off to disarm."
			: "\nDrift watchdog: off (explicit hub setting).";
	}

	async function commitWorkMode(next: WorkMode, ctx: ExtensionContext): Promise<"ok" | "unchanged" | "roster"> {
		if (orchestratorNeedsRoster(next, agentStates.size)) return "roster";
		if (next === workMode) return "unchanged";
		workMode = next;
		if (workMode === "operator") {
			rosterRecoveryRequired = false;
			rosterRecoveryDiagnostic = "";
			setTimeout(replayDeferredRecoveryInputs, 0);
		}
		resolveIncomingCapabilities("");
		applyWorkModeTools();
		updateWorkModeStatus(ctx);
		pi.appendEntry(WORK_MODE_ENTRY_TYPE, { workMode });
		return "ok";
	}

	async function applyWorkModeSelection(next: WorkMode, ctx: ExtensionContext): Promise<void> {
		if (workModeChangeBlockedByRoster(workMode, next, agentStates.size)) {
			ctx.ui.notify(rosterRefusalMessage(), "warning");
			return;
		}
		const result = await commitWorkMode(next, ctx);
		if (result === "roster") {
			ctx.ui.notify(rosterRefusalMessage(), "warning");
			return;
		}
		ctx.ui.notify(
			`${workModeStatusText()}\nPrompt and tools update on the next model call.${watchdogArmedNote(next)}`,
			result === "ok" ? "success" : "info",
		);
	}

	async function openWorkModePicker(ctx: ExtensionContext): Promise<void> {
		const picker = workModePickerOptions(workMode);
		const choice = await ctx.ui.select(picker.title, picker.options);
		const next = selectedPickerValue(picker.options, choice, picker.workModes);
		if (!next) return;
		await applyWorkModeSelection(next, ctx);
	}

	// Alt+A toggles the agent view between the full dashboard grid (above the
	// editor) and the compact running-agents list (below the editor). alt+a has no
	// default pi binding — every useful ctrl+letter is already taken (ctrl+r is
	// session-rename), and alt+a is not consumed by the editor, so it reaches the
	// extension shortcut handler in the main input.
	pi.registerShortcut("alt+a", {
		description: "Open Fleet Dashboard",
		handler: (ctx) => {
			widgetCtx = ctx;
			void openFleetDashboard(ctx);
		},
	});
	pi.registerShortcut("alt+m", {
		description: "Open work mode picker",
		handler: (ctx) => {
			widgetCtx = ctx;
			if (!ctx.hasUI || typeof ctx.ui.select !== "function") {
				ctx.ui.notify(
					`${workModeStatusText()}\nSwitch with /af-work-mode operator|orchestrator`,
					"info",
				);
				return;
			}
			void openWorkModePicker(ctx);
		},
	});
	pi.registerShortcut("alt+shift+a", {
		description: "Toggle compact agent widget",
		handler: (ctx) => { widgetCtx = ctx; viewMode = viewMode === "compact" ? "off" : "compact"; updateWidget(); updateResearchWidget(); ctx.ui.notify(`Compact agent widget: ${viewMode}`, "info"); },
	});

	// Compact-view agent switcher. Alt+] / Alt+[ move the marker through the running
	// subagents; Alt+\ zooms the marked one (same overlay as /af-zoom). main is never a
	// target — it is the session under the input, which always takes typed prompts.
	// Keys verified free of pi's reserved editor bindings (keybindings.d.ts): alt+up/
	// down/left/right and ctrl+] / ctrl+alt+] are reserved, but alt+[ / alt+] / alt+\
	// are not. Caveat: alt+[ emits `ESC [` (CSI prefix) on some terminals and may be
	// eaten by the escape parser — alt+] and alt+\ are the reliable pair.
	function cycleMarker(delta: number, ctx: any) {
		widgetCtx = ctx;
		if (!compactWidgetsEnabled(viewMode)) {
			ctx.ui.notify("Agent switching is a compact-view feature — press Alt+A first", "info");
			return;
		}
		const keys = switchableAgents().map(a => a.key);
		if (keys.length === 0) {
			ctx.ui.notify("No running subagents to switch between", "info");
			return;
		}
		const cur = markedAgent ? keys.indexOf(markedAgent) : -1;
		markedAgent = cur === -1
			? (delta > 0 ? keys[0] : keys[keys.length - 1])
			: keys[(cur + delta + keys.length) % keys.length];
		updateWidget();
	}

	pi.registerShortcut("alt+]", {
		description: "Compact view: mark next subagent",
		handler: (ctx) => cycleMarker(1, ctx),
	});
	pi.registerShortcut("alt+[", {
		description: "Compact view: mark previous subagent",
		handler: (ctx) => cycleMarker(-1, ctx),
	});
	pi.registerShortcut("alt+\\", {
		description: "Compact view: zoom the marked subagent",
		handler: async (ctx) => {
			widgetCtx = ctx;
			if (!compactWidgetsEnabled(viewMode)) {
				ctx.ui.notify("Agent zoom from the marker is a compact-view feature — press Alt+A first", "info");
				return;
			}
			clampMarker();
			if (!markedAgent) {
				ctx.ui.notify("No running subagent marked to zoom", "info");
				return;
			}
			const rid = parseResearchHandle(markedAgent);
			const target: Zoomable | undefined = rid != null
				? researchStates.get(rid)
				: agentStates.get(markedAgent);
			if (!target) {
				ctx.ui.notify(`Marked agent ${markedAgent} is no longer available`, "warning");
				return;
			}
			const row = fleetRows(true).find(r => r.key === markedAgent);
			if (row) await openFleetDetail(row, ctx);
			else await openZoom(target, ctx);
		},
	});

	// Completions over loaded agent names, annotated with current status.
	const agentNameCompletions = (prefix: string): AutocompleteItem[] | null => {
		const items = Array.from(agentStates.values()).map(s => ({
			value: s.def.name,
			label: `${displayName(s.def.name)} (${s.status})`,
		}));
		if (items.length === 0) return null;
		const filtered = items.filter(i => i.value.toLowerCase().startsWith(prefix.toLowerCase()));
		return filtered.length > 0 ? filtered : items;
	};

	// A delegate child anywhere in the team, by its id (e.g. "quality-1").
	function findDelegationChild(arg: string): { child: DelegationChild; owner: AgentState } | null {
		const lower = arg.toLowerCase();
		for (const st of agentStates.values()) {
			const child = Array.from(st.delegations?.values() ?? []).find(candidate => candidate.id.toLowerCase() === lower);
			if (child) return { child, owner: st };
		}
		return null;
	}

	// Completions for /af-zoom: team member names, research handles (rN), and
	// delegate child ids nested under their parent specialist.
	const zoomCompletions = (prefix: string): AutocompleteItem[] | null => {
		const teamItems = Array.from(agentStates.values()).map(s => ({
			value: s.def.name,
			label: `${displayName(s.def.name)} (${s.status})`,
		}));
		const researchItems = Array.from(researchStates.values()).map(s => ({
			value: `r${s.id}`,
			label: `r${s.id} ${s.persona ? displayName(s.def.name) : "research"} (${s.status})`,
		}));
		const childItems = Array.from(agentStates.values()).flatMap(s =>
			Array.from(s.delegations?.values() || []).map(c => ({
				value: c.id,
				label: `${c.id} — delegate of ${displayName(s.def.name)} (${c.status})`,
			})),
		);
		const items = [...teamItems, ...researchItems, ...childItems];
		if (items.length === 0) return null;
		const filtered = items.filter(i => i.value.toLowerCase().startsWith(prefix.toLowerCase()));
		return filtered.length > 0 ? filtered : items;
	};


	// Completions for /af-agent-model: persona names plus a `persona.role` entry per
	// declared delegate sub-role, labeled with the model currently in effect.
	const agentModelCompletions = (prefix: string): AutocompleteItem[] | null => {
		const personaItems = Array.from(agentStates.values()).map(s => ({
			value: s.def.name,
			label: `${displayName(s.def.name)} (${s.status})`,
		}));
		// Research personas (researcher / deep-researcher) are switchable too —
		// spawned on demand, so they have no live status to show.
		const researchItems = researchPersonas.map(d => ({
			value: d.name,
			label: `${displayName(d.name)} (research — ${shortModel(resolvedModel(d))})`,
		}));
		const roleItems = Array.from(agentStates.values()).flatMap(s =>
			Object.entries(s.def.subagents || {}).map(([role, r]) => {
				const override = subagentModelOverrides.get(`${s.def.name.toLowerCase()}.${role.toLowerCase()}`);
				const effective = resolvedSubagentModel(s.def.name, role, r.model);
				return {
					value: `${s.def.name}.${role}`,
					label: `${s.def.name}.${role} — ${shortModel(effective)}${override || effective !== r.model ? " (switched)" : ""}`,
				};
			}),
		);
		const items = [...personaItems, ...researchItems, ...roleItems];
		if (items.length === 0) return null;
		const filtered = items.filter(i => i.value.toLowerCase().startsWith(prefix.toLowerCase()));
		return filtered.length > 0 ? filtered : items;
	};

	// /af-agent-model <persona>[.<role>] — switch a persona's model among its
	// declared candidates (frontmatter `model:` + `models:`), or a delegate
	// sub-role's model among its declared default + the parent persona's
	// candidates. Session-lifetime: the choice resets on session_start and takes
	// effect on the persona's NEXT dispatch (/af-agents-restart applies it
	// immediately). Nothing outside the declared lists is ever selectable.
	// Completions for /af-agent-model-thinking: persona names labeled with the
	// thinking level currently in effect.
	const agentThinkingCompletions = (prefix: string): AutocompleteItem[] | null => {
		const items = [
			...Array.from(agentStates.values()).map(s => ({
				value: s.def.name,
				label: `${displayName(s.def.name)} — ${resolveThinkingLevel(resolvedThinking(s.def))}`,
			})),
			...researchPersonas.map(d => ({
				value: d.name,
				label: `${displayName(d.name)} (research) — ${resolveThinkingLevel(resolvedThinking(d))}`,
			})),
		];
		if (items.length === 0) return null;
		const filtered = items.filter(i => i.value.toLowerCase().startsWith(prefix.toLowerCase()));
		return filtered.length > 0 ? filtered : items;
	};

	// /af-agent-model-thinking <persona> — switch a persona's reasoning effort among
	// pi's --thinking levels (off|minimal|low|medium|high|xhigh). Session-lifetime:
	// the choice resets on session_start and takes effect on the persona's NEXT
	// dispatch (/af-agents-restart applies it immediately). Selecting the frontmatter
	// default clears the override.
	// Completions for /af-models: profile names with their persona → model summary.
	const modelProfileCompletions = (prefix: string): AutocompleteItem[] | null => {
		const items = Object.entries(modelProfiles).map(([name, entries]) => ({
			value: name,
			label: `${name} — ${Object.entries(entries).map(([p, m]) => `${p}: ${shortModel(m)}`).join(", ")}`,
		}));
		if (items.length === 0) return null;
		const filtered = items.filter(i => i.value.toLowerCase().startsWith(prefix.toLowerCase()));
		return filtered.length > 0 ? filtered : items;
	};

	// /af-models [profile] — apply a named model profile (a validated macro over the
	// personas' declared candidates). Bare /af-models opens a picker.
	// Every configured model source across persona defaults/candidates, retained
	// fallbacks, and delegate sub-roles. Active mapping keys remain visible so the
	// operator can replace a session substitution even if the roster changes.
	function allKnownModels(): string[] {
		const seen = new Set<string>();
		const out: string[] = [];
		const add = (model: string | undefined) => {
			if (model && !seen.has(model)) { seen.add(model); out.push(model); }
		};
		for (const def of allAgentDefs) {
			add(def.model);
			add(def.fallbackModel);
			for (const model of def.models ?? []) add(model);
			for (const role of Object.values(def.subagents ?? {})) {
				add(role.model);
				add(role.fallbackModel);
			}
		}
		for (const model of modelOverrides.values()) add(model);
		for (const model of subagentModelOverrides.values()) add(model);
		for (const source of modelSubstitutions.keys()) add(source);
		return out;
	}

	const substituteCompletions = (prefix: string): AutocompleteItem[] | null => {
		const items = substitutionSourceChoices().map(choice => ({ value: choice.spec, label: choice.label }));
		if (items.length === 0) return null;
		const p = prefix.toLowerCase();
		const filtered = items.filter(i => i.value.toLowerCase().startsWith(p));
		return filtered.length > 0 ? filtered : items;
	};

	// Bare command opens the exact same source → available-target picker as `m` in
	// Fleet Dashboard. The two-argument form remains available for scripting.
	// Completions over research handles, annotated with status.
	const researchHandleCompletions = (prefix: string): AutocompleteItem[] | null => {
		const items = Array.from(researchStates.values()).map(s => ({
			value: `r${s.id}`,
			label: `r${s.id} ${s.persona ? displayName(s.def.name) : "research"} (${s.status})`,
		}));
		if (items.length === 0) return null;
		const filtered = items.filter(i => i.value.toLowerCase().startsWith(prefix.toLowerCase()));
		return filtered.length > 0 ? filtered : items;
	};

	// ── Unified subagent commands ────────────────
	// Team specialists are addressed by persona name, research helpers by their rN
	// handle — one command family covers kill/restart controls and timeline inspection.

	// Remove one research helper (SIGTERM if running) — the state, its card, and
	// its session file. Team specialists are standing and cannot be removed.
	function removeResearchHelper(state: ResearchState, ctx: any) {
		if (state.proc && state.status === "running") {
			state.killedByOperator = true;
			state.proc.kill("SIGTERM");
			ctx.ui.notify(`Research r${state.id} killed and removed.`, "warning");
		} else {
			ctx.ui.notify(`Research r${state.id} removed.`, "info");
		}
		try { unlinkSync(researchSessionPath(state.id)); } catch {}
		researchStates.delete(state.id);
		updateResearchWidget();
	}

	// Remove all helpers (SIGTERM any running) for /af-agents-kill all.
	function clearResearchHelpers(ctx: any) {
		let killed = 0;
		const total = researchStates.size;
		for (const [, state] of Array.from(researchStates.entries())) {
			if (state.proc && state.status === "running") {
				state.killedByOperator = true;
				state.proc.kill("SIGTERM");
				killed++;
			}
			try { unlinkSync(researchSessionPath(state.id)); } catch {}
		}
		researchStates.clear();
		nextResearchId = 1;
		updateResearchWidget();
		const msg = total === 0
			? "No research helpers to clear."
			: `Cleared ${total} research helper${total !== 1 ? "s" : ""}${killed > 0 ? ` (${killed} killed)` : ""}.`;
		ctx.ui.notify(msg, total === 0 ? "info" : "success");
	}

	// Completions over both target kinds: team persona names + research handles
	// (rN), each annotated with status — for the unified /af-agents-kill and
	// /af-agents-restart.
	const subagentTargetCompletions = (prefix: string): AutocompleteItem[] | null => {
		const items = [...(agentNameCompletions("") ?? []), ...(researchHandleCompletions("") ?? [])];
		if (items.length === 0) return null;
		const filtered = items.filter(i => i.value.toLowerCase().startsWith(prefix.toLowerCase()));
		return filtered.length > 0 ? filtered : items;
	};

	// /af-agents-kill completions additionally offer "all" (research helpers only).
	const agentsKillCompletions = (prefix: string): AutocompleteItem[] | null => {
		const targets = subagentTargetCompletions("") ?? [];
		const items = researchStates.size > 0
			? [...targets, { value: "all", label: "all — kill & remove every research helper" }]
			: targets;
		if (items.length === 0) return null;
		const filtered = items.filter(i => i.value.toLowerCase().startsWith(prefix.toLowerCase()));
		return filtered.length > 0 ? filtered : items;
	};

	// ── Embedded coms: /af-coms + /af-handoff ──

	// Completions over live peer names for /af-handoff.
	const comsPeerCompletions = (prefix: string): AutocompleteItem[] | null => {
		// Same pool scope as coms_send/handoff resolution — only offer peers you can reach.
		const entries = peersInScope();
		const items = entries.map(e => ({ value: e.name, label: `${e.name} — ${e.purpose || e.model}` }));
		if (items.length === 0) return null;
		const p = prefix.toLowerCase();
		const filtered = items.filter(i => i.value.toLowerCase().startsWith(p));
		return filtered.length > 0 ? filtered : items;
	};

	// ━━ herdr presence: turn-state reporting ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
	// The herdr sidebar mirrors turn state (idle ↔ working) push-style;
	// context % rides the keepalive refresh.
	pi.on("before_agent_start", async () => {
		await coms.setTurnState("working");
		if (monitorBridge && monitorTurnId) monitorBridge.finishParent(monitorTurnId, "completed");
		if (monitorBridge && monitorHubId) {
			monitorTurnId = `hub-turn-${monitorHubId}-${crypto.randomUUID()}`;
			monitorBridge.startParent({ id: monitorTurnId, hubInstanceId: monitorHubId, checkoutId: currentCtx?.cwd || process.cwd() });
		} else monitorTurnId = null;
	});
	pi.on("agent_end", async () => {
		await coms.setTurnState("idle");
		if (monitorBridge && monitorTurnId) {
			monitorBridge.finishParent(monitorTurnId, "completed");
			monitorTurnId = null;
		}
	});

	// /af-handoff <peer> — hand the session off to a coms peer. Per decision G1 we do NOT
	// extract the compaction summary; instead we ask the dispatcher LLM (next turn) to
	// compose a SELF-CONTAINED brief and coms_send it, then await + relay the reply.
	// /af-compound [focus] — end-of-session compound-learning pass. Mirrors /af-handoff's
	// shape: the dispatcher LLM (which saw the whole session) composes the
	// candidate-lessons brief itself, gates it on the user, then dispatches the
	// documenter to land the approved lessons per skills/compound-learning/SKILL.md.
	// The rules/docs targets come from the overrides file; artifacts travel as
	// paths through the dispatch's `artifacts` array, never as pasted bodies.
	// ── ask_user wait tracking (for /af-agents-history real-work) ──
	// pi-ask-user blocks the dispatcher turn while the human answers. Bracket each
	// ask_user call with its tool_execution start/end so /af-agents-history can subtract
	// that "away from keyboard" time from the dispatcher's real work.
	pi.on("tool_execution_start", async (event) => {
		if (event.toolName !== "ask_user") return;
		executionHistory.startAskUser(event.toolCallId);
		const kind = budgetContinuationKind(event.args?.context);
		if (kind && pendingBudgetContinuation?.kind === kind) {
			budgetContinuationAsks.set(event.toolCallId, {
				kind,
				reason: pendingBudgetContinuation.reason,
				params: event.args,
			});
		}
		// Asking the human IS the escalation the external-blocker breaker demands:
		// once it is under way, the gate opens.
		externalBlockerAcknowledged = true;
		externalBlockerRefusedOnce = false;
	});
	observeAskUserResults(({ params, result, phase }) => {
		const pack = capabilityConfirmationPack(params.context);
		if (!pack) return;
		if (phase === "start") capabilityConfirmation[pack] = "pending";
		else {
			const outcome = confirmationOutcome(result);
			if (!outcome) return;
			capabilityConfirmation[pack] = outcome;
			resolveIncomingCapabilities("");
			applyWorkModeTools();
		}
	});

	pi.on("tool_execution_end", async (event) => {
		if (event.toolName !== "ask_user") return;
		const endedAt = Date.now();
		const waitMs = executionHistory.endAskUser(event.toolCallId, endedAt);
		// The task clock bills active time only — the human's answer is not the
		// fleet's work, and billing it is what would false-stop a steered session.
		if (waitMs > 0) taskClock = addTaskClockWait(taskClock, waitMs);
		turnBudgetAskUserWaitMs += waitMs;

		// Renew only when this exact marked ask selected its first option. This uses
		// Pi's tool events rather than wrapper internals, so it also works when the
		// stock ask_user package owns the tool under extension discovery.
		const confirmation = budgetContinuationAsks.get(event.toolCallId);
		budgetContinuationAsks.delete(event.toolCallId);
		if (confirmation) {
			const outcome = budgetContinuationOutcome(confirmation.params, event.result);
			if (outcome) pendingBudgetContinuation = null;
			if (outcome === "continue") {
				const prior = budgetContinuationSnapshot(confirmation.kind, endedAt);
				if (confirmation.kind === "task") continueTaskBudgetWindow(endedAt);
				else renewTurnBudgetWindow(endedAt);
				appendBudgetContinuationEntry(confirmation.kind, confirmation.reason, prior, currentCtx ?? undefined);
				widgetCtx?.ui?.notify(
					confirmation.kind === "task"
						? "Task budget continued; task tier, assertions, capabilities, and progress were preserved."
						: "Turn budget continued; continuing without another message.",
					"success",
				);
			}
		}
	});

	// ── System Prompt Override ───────────────────

	// This is also called by /af-context before the first turn. Keep prompt assembly
	// in this one production path so its ledger describes the exact next replacement.
	function buildHubSystemPrompt(forTurn: boolean): { systemPrompt: string } {
		if (forTurn) {
		// Re-assert the selected work mode for every turn so prompt and tool policy stay
		// synchronized after commands or runtime capability changes.
		applyWorkModeTools();
		// Open a fresh dispatcher turn for /af-agents-history. The orchestrator entry is
		// created lazily (only if this turn actually dispatches), so chat-only turns
		// add no history rows. Defensively close any entry a prior turn left open
		// (e.g. an aborted turn where agent_end never fired).
		// Fold the turn that just ended into the task's active-time accumulator
		// before the clock is re-based; inter-turn idle is never charged because
		// no turn is open across it.
		const turnStartedAt = Date.now();
		closeTurnActiveTime(turnStartedAt);
		taskClock = openTaskClock(taskClock, turnStartedAt);
		executionHistory.startTurn(turnStartedAt);
		turnBudgetAskUserWaitMs = 0;
		budgetContinuationAsks.clear();
		if (pendingBudgetContinuation?.kind === "turn") pendingBudgetContinuation = null;
		// Fresh turn → fresh TURN budget window (mode persists across turns). The
		// TASK budget, the tier, and the external-blocker breaker deliberately do
		// NOT reset here: a steering message is a correction to the same work, not
		// a new ask, and resetting on it is precisely how a run spent eight fresh
		// dispatches per correction and never hit a bound. A task continuation is
		// instead an explicit Yes/No confirmation; genuinely different work uses
		// set_task_tier with new_task: true.
		turnDispatchCount = 0;
		turnResearchCount = 0;
		turnDispatchFingerprints.clear();
		// The human sent a message, so an external blocker has been surfaced to them
		// by definition — the breaker opens and re-arms on the next report.
		externalBlockerAcknowledged = true;
		externalBlockerRefusedOnce = false;
		// Snapshot the previous turn's cost report before opening a fresh one.
		if (turnReport.dispatches.length > 0 || turnReport.research > 0 || turnReport.refusals > 0) {
			lastTurnReport = turnReport;
			sessionTotals.turns++;
		}
		turnReport = freshTurnReport();
		updateModeStatus();
		}

		const modelPacks = new Set<CapabilityPack>([...capabilityResolution.active, ...capabilityResolution.provisional]);
		const fleetActive = modelPacks.has("fleet");
		const verificationActive = modelPacks.has("verification");
		const peerActive = modelPacks.has("peer");
		const workspaceActive = modelPacks.has("workspace");
		const compactionActive = modelPacks.has("compaction");
		// Fleet roster and research policy are absent unless the fleet pack is model-visible.
		const agentCards = fleetActive ? Array.from(agentStates.values())
			.map(s => ({ id: s.def.name, text: `### ${displayName(s.def.name)}\n**Dispatch as:** \`${s.def.name}\`\n${s.def.description}\n**Tools:** ${s.def.tools}` })) : [];
		const agentCatalog = agentCards.map(card => card.text).join("\n\n");

		const teamMembers = fleetActive ? Array.from(agentStates.values()).map(s => displayName(s.def.name)).join(", ") : "";

		// Research personas (kind: research) the dispatcher can spawn read-only via
		// spawn_research. Independent of team membership.
		const researchCards = fleetActive ? researchPersonas.map(d => ({ id: d.name, text: `### ${displayName(d.name)}\n**Spawn as:** \`spawn_research(persona: "${d.name}")\`\n**Model:** ${resolvedModel(d) || "(dispatcher’s default)"} · **Thinking:** ${resolveThinkingLevel(resolvedThinking(d))}\n${d.description}` })) : [];
		const researchCatalog = !fleetActive ? "" : researchCards.length > 0
			? researchCards.map(card => card.text).join("\n\n")
			: "(No research personas defined. Call `spawn_research` without `persona` for an ad-hoc read-only helper.)";

		// Two flavors of the system prompt depending on whether ask_user is
		// registered (i.e. pi-ask-user is installed). Without it the dispatcher
		// must state assumptions explicitly instead of asking.
		const askUserBlock = askUserAvailable
			? `## When to call \`ask_user\` (non-negotiable triggers)
- Requirements are ambiguous, incomplete, or contradictory.
- Multiple valid approaches exist and the trade-off is preference-dependent
  (architecture, library choice, naming, scope cuts).
- A specialist returned an \`ASK_USER:\` marker — surface every one.
- A specialist's output contradicts an earlier specialist's output, or contradicts
  the user's stated requirement — ask the user to resolve it.
- The next dispatch would be costly to undo (destructive edit, migration, mass
  rename, production-facing change, secret/credential handling).
- You're about to assume a value (path, version, flag, threshold) the user did
  not specify.

Calling \`ask_user\`:
- Read the tool's own description for the exact parameter shape — different
  installs ship slightly different schemas. Always pass \`question\` and, when
  helpful, \`context\` (a 1–3 line summary of what you've already found).
- Provide multiple-choice \`options\` whenever you can enumerate 2–6 valid
  answers — it's faster for the user than free text.
- Ask exactly **one** focused question per call. Do not bundle unrelated questions.`
			: `## ask_user is NOT available in this session
The \`pi-ask-user\` package is not installed, so you have no interactive way to
ask the human. You MUST instead:
- State every assumption explicitly in ${userLanguage} before dispatching.
- Phrase it as: "Assuming X (because Y) — say STOP/correct if wrong, otherwise I'll proceed."
- Wait for the user's next message before continuing on anything destructive.
- For \`ASK_USER:\` markers raised by specialists, relay the question verbatim to
  the user in ${userLanguage} and wait for their reply in the next turn.`;

		const toolList = `these active packs: ${[...modelPacks].join(", ")}. Tools: ${pi.getActiveTools().map(name => `\`${name}\``).join(", ") || "(none)"}`;

		const dispatchSection = !fleetActive ? "" : askUserAvailable
			? `- BEFORE dispatching: if anything is ambiguous, missing, or could go several valid
  ways, call \`ask_user\` first. Never invent constraints or "reasonable defaults"
  the user did not state.
- Dispatch tasks via \`dispatch_agent\`. Each dispatched task is automatically
  augmented with clarification/research plus deliverable-to-file protocols. For document handoff, pass artifact paths through the optional \`artifacts\` array; never paste full plan/review/inventory bodies into a task.
- For dispatches carrying A1/A2-style assertions, specialist returns arrive pre-parsed as \`details.structuredReturn\` with \`details.contractNotices\`; the full raw output is persisted at \`details.returnPath\` and kept for compatibility in \`details.fullOutput\`. Spawn a reader only when the digest/path is not enough.
- After each dispatch, INSPECT the result for ASK_USER questions (also surfaced in
  the result \`details.questions\`). For each one: call \`ask_user\` in ${userLanguage},
  then re-dispatch the specialist with the answer.`
			: `- BEFORE dispatching: if anything is ambiguous, missing, or could go several valid
  ways, STATE your assumption explicitly in ${userLanguage} and wait for the user
  to correct it. Never invent constraints or "reasonable defaults" silently.
- Dispatch tasks via \`dispatch_agent\`. Each dispatched task is automatically
  augmented with clarification/research plus deliverable-to-file protocols. For document handoff, pass artifact paths through the optional \`artifacts\` array; never paste full plan/review/inventory bodies into a task.
- For dispatches carrying A1/A2-style assertions, specialist returns arrive pre-parsed as \`details.structuredReturn\` with \`details.contractNotices\`; the full raw output is persisted at \`details.returnPath\` and kept for compatibility in \`details.fullOutput\`. Spawn a reader only when the digest/path is not enough.
- After each dispatch, INSPECT the result for ASK_USER questions (also surfaced in
  the result \`details.questions\`). For each one: relay it verbatim to the user
  in ${userLanguage} and wait for the reply before re-dispatching.`;

		const ambiguityRule = askUserAvailable
			? `- NEVER proceed past an ambiguity by guessing. Either call \`ask_user\`, or state
  the assumption explicitly in ${userLanguage} and say you'll proceed unless corrected.`
			: `- NEVER proceed past an ambiguity by guessing. State the assumption explicitly
  in ${userLanguage} and wait for the user to confirm or correct.`;

		const languageLines = askUserAvailable
			? `- ALWAYS communicate with the human user in **${userLanguage}**. Every message you
  write to the user, every \`ask_user\` question and \`context\` field — ${userLanguage}.
- Task strings you send via \`dispatch_agent\` stay in **English**. The specialist
  personas are written in English; do not translate task descriptions for them.
- When a specialist emits an \`ASK_USER:\` line in English, translate it to
  ${userLanguage} before passing it through \`ask_user\`.${userLanguage.toLowerCase() === "english" ? " (If user-language is English this is a no-op.)" : ""}`
			: `- ALWAYS communicate with the human user in **${userLanguage}**. Every message you
  write to the user is ${userLanguage}.
- Task strings you send via \`dispatch_agent\` stay in **English**. The specialist
  personas are written in English; do not translate task descriptions for them.
- When a specialist emits an \`ASK_USER:\` line in English, translate it to
  ${userLanguage} before relaying to the user.${userLanguage.toLowerCase() === "english" ? " (If user-language is English this is a no-op.)" : ""}`;

		// ── Task triage + Verification Contract ──
		// The hub ENFORCES budgets in code (dispatch_agent/spawn_research refuse
		// past the task-tier envelope); the prompt teaches the dispatcher to plan
		// within them instead of hitting them.
		const budget = currentBudget();
		const taskBudget = currentTaskBudget();
		const cap = (n: number | null) => (n == null ? "unlimited" : String(n));
		const capMin = (ms: number | null) => (ms == null ? "unlimited" : `${Math.round(ms / 60_000)} min`);
		const capabilityState = [...capabilityResolution.active].map(pack => `${pack}:${capabilityResolution.reasons[pack]}`).join(", ");
		const provisionalState = capabilityResolution.provisional.map(pack => `${pack}:${capabilityResolution.reasons[pack]}`).join(", ");
		const stateCapsule = `## Current task state
- tier: ${taskTier ?? DEFAULT_TASK_TIER}${taskTierAssumed ? "?" : ""}; turn dispatches: ${turnDispatchCount}; research: ${turnResearchCount}
- task dispatches: ${taskDispatchCount}; research: ${taskResearchCount}; review rounds: ${taskReviewRounds}
- packs active: ${capabilityState}; provisional: ${provisionalState || "none"}
- provisional confirmation: ${capabilityResolution.provisional.filter(pack => capabilityConfirmation[pack as ConfirmableCapabilityPack] !== "declined").map(pack => `${pack} (${capabilityResolution.reasons[pack]}) → call ask_user exactly once with ${JSON.stringify(capabilityConfirmationQuestion(pack as ConfirmableCapabilityPack))}`).join("; ") || "none"}
- budgets: dispatch ${cap(budget.maxDispatches)}, research ${cap(budget.maxResearch)}, task wall ${capMin(taskBudget.wallMs)}.`;

		const stableModeSection = fleetActive ? `## Task triage (before dispatch)
Call \`set_task_tier\` honestly: trivial/small work uses minimal ceremony; feature/project work uses the assertion ledger and a review gate. A provided plan is the specification, not consent to execute unrequested phases. Keep related plan work in coherent batches, pass a narrow scope, and treat a budget refusal as a stop-and-ask-human signal; code enforcement remains authoritative.` : "";

		const fullVerificationContract = `## Verification Contract
For non-trivial work, record at most ${MAX_OPEN_ASSERTIONS} narrow, sourced assertions before building and pass them verbatim to specialists. Advance only on named evidence; unproven/failed is not done. Runtime-UI claims require runtime observation. Use \`skills/orchestration-verification/SKILL.md\` for formats, parity inventories, and regression resets. After compaction, read the ledger before continuing.`;

		const verificationSection = !verificationActive ? "" : fullVerificationContract;

		// Peer section only when coms initialised. Decision G4: the coms_* tools are
		// already in the active tool surface when ready; here we just teach the
		// dispatcher how and when to reach for them.
		const comsSection = peerActive && comsReady && identity
			? `
## Peer agents (coms)
You are peer "${identity.name}" in project "${identity.project}". Use \`coms_list\` for the human-scoped pool and status; the Hub cannot widen it. Send one self-contained prompt, then await/get the returned msg_id without resending. Match send/await deadlines. Prefer team dispatch unless the task needs a standing peer, and never duplicate a dispatch to its same-name peer.
`
			: "";

		const workModeText = workModePrompt(workMode);
		const herdrSection = workspaceActive && herdrFleetReady ? HUB_HERDR_SECTION : "";
		const compactionSection = compactionActive ? `
## Context recovery
- Context pressure is approaching or above the automatic recovery threshold. Keep tool output concise; redirect full test/package logs to files and inspect summaries or tails.
- \`request_compaction\` is available for explicit recovery. Automatic recovery preserves task state and continues from the compaction summary.
` : "";
		const systemPrompt = assembleHubSystemPrompt({
			intro: workModeText.intro,
			toolList,
			languageLines,
			activeTeamName,
			teamMembers,
			dispatchSection,
			userLanguage,
			askUserBlock,
			modeSection: stableModeSection,
			verificationSection,
			stateCapsule,
			comsSection,
			herdrSection,
			compactionSection,
			hardRules: workModeText.hardRules,
			ambiguityRule,
			agentCatalog,
			researchCatalog,
		});
		// Ledger is metadata-only and never written back into the replacement prompt.
		lastHubLedger = recordHubLedger(systemPrompt, namedHubLedgerParts({
			intro: workModeText.intro,
			languageLines,
			teamMembers,
			agentCards,
			dispatchSection,
			modeSection: stableModeSection,
			verificationSection,
			stateCapsule,
			researchCards,
			researchCatalog,
			comsSection,
			herdrSection,
			compactionSection,
		})).concat(CAPABILITY_PACKS.map(pack => {
			const status = capabilityResolution.active.includes(pack) ? "active"
				: capabilityResolution.provisional.includes(pack) ? "provisional"
				: (pack === "peer" && comsReady) || (pack === "workspace" && herdrFleetReady) ? "ready-inactive"
				: pack === "peer" || pack === "workspace" ? "unavailable" : "inactive";
			return component({
				id: `hub/capability/${pack}`, plane: "hub", category: "system", label: `Capability ${pack}: ${status}`,
				source: capabilityResolution.reasons[pack], persistence: "turn", visibility: "ui-only", confidence: "exact-chars", chars: 0,
			});
		}));

		return { systemPrompt };
	}

	pi.on("before_agent_start", async (_event, _ctx) => buildHubSystemPrompt(true));

	const AUTOMATIC_COMPACTION_INSTRUCTIONS = "Preserve the current goal, completed and open assertions, decisions, modified/read files, pending child or peer operations, blockers, and the concrete next step.";
	type DeferredRecoveryInput = { text: string; images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" };
	let automaticCompactionPending = false;
	let automaticCompactionRunning = false;
	let deferredReplayAllowance = 0;
	const deferredRecoveryInputs: DeferredRecoveryInput[] = [];

	function recordContextPressure(source: "message_end" | "turn_end" | "context" | "input" | "agent_settled" | "session_start" | "session_compact" | "compaction_callback", action: string, reason: string): void {
		const diagnostic = contextPressureDiagnostic(contextPressureState);
		try {
			pi.appendEntry("agent-hub-context-pressure", {
				version: 1,
				source,
				phase: diagnostic.phase,
				pressure: diagnostic.pressure,
				episode: diagnostic.episode,
				tokens: diagnostic.tokens,
				context_window: diagnostic.contextWindow,
				percent: diagnostic.percent,
				warning_percent: diagnostic.warningPercent,
				automatic_percent: diagnostic.automaticPercent,
				last_recovery_outcome: diagnostic.lastRecoveryOutcome,
				action,
				reason,
			});
		} catch { /* diagnostics are best-effort */ }
	}

	function updateContextPressureStatus(ctx: ExtensionContext): void {
		const diagnostic = contextPressureDiagnostic(contextPressureState);
		const percent = diagnostic.percent === null ? "unknown" : `${diagnostic.percent.toFixed(1)}%`;
		ctx.ui.setStatus("context-pressure", `Context: ${contextPressureState.phase} · ${percent} · auto ${diagnostic.automaticPercent}% · last ${diagnostic.lastRecoveryOutcome}`);
	}

	function observeContextPressure(ctx: ExtensionContext, source: "message_end" | "turn_end" | "input" | "session_start", additionalTokens = 0): "none" | "expose-compaction" | "compact-now" {
		const usage = ctx.getContextUsage();
		const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? null;
		const tokens = usage?.tokens == null ? null : usage.tokens + Math.max(0, additionalTokens);
		const percent = tokens != null && contextWindow != null && contextWindow > 0
			? tokens / contextWindow * 100
			: usage?.percent ?? null;
		const decision = transitionContextPressure(contextPressureState, {
			type: "usage",
			usage: { tokens, contextWindow, percent },
		});
		const previousPhase = contextPressureState.phase;
		contextPressureState = decision.state;
		updateContextPressureStatus(ctx);
		resolveIncomingCapabilities("");
		applyWorkModeTools();
		if (decision.action !== "none" || previousPhase !== decision.state.phase) {
			recordContextPressure(source, decision.action, decision.reason);
		}
		if (decision.action === "compact-now") {
			automaticCompactionPending = true;
			if (ctx.hasUI) ctx.ui.notify("Context reached 90%; pausing the tool loop for automatic compaction.", "warning");
		}
		return decision.action;
	}

	function markContextCompactionSucceeded(): void {
		automaticCompactionPending = false;
		if (contextPressureState.phase === "recovered") return;
		const decision = transitionContextPressure(contextPressureState, { type: "compaction-succeeded" });
		contextPressureState = decision.state;
		if (currentCtx) updateContextPressureStatus(currentCtx);
		resolveIncomingCapabilities("");
		applyWorkModeTools();
		recordContextPressure("session_compact", decision.action, decision.reason);
	}

	function replayDeferredRecoveryInputs(): void {
		if (automaticCompactionPending || automaticCompactionRunning || deferredRecoveryInputs.length === 0) return;
		const queued = deferredRecoveryInputs.splice(0);
		deferredReplayAllowance += queued.length;
		for (let index = 0; index < queued.length; index++) {
			const input = queued[index];
			const content = input.images?.length
				? [{ type: "text" as const, text: input.text }, ...input.images]
				: input.text;
			pi.sendUserMessage(content, {
				deliverAs: index === 0 ? input.streamingBehavior : "followUp",
			});
		}
	}

	function runAutomaticCompaction(ctx: ExtensionContext, source: "input" | "agent_settled" | "session_start"): void {
		if (!automaticCompactionPending || automaticCompactionRunning) return;
		automaticCompactionPending = false;
		automaticCompactionRunning = true;
		recordContextPressure(source, "compact-now", "automatic-threshold");
		if (ctx.hasUI) ctx.ui.notify("Automatic context compaction started.", "warning");
		ctx.compact({
			customInstructions: AUTOMATIC_COMPACTION_INSTRUCTIONS,
			onComplete: () => {
				automaticCompactionRunning = false;
				markContextCompactionSucceeded();
				if (ctx.hasUI) ctx.ui.notify("Automatic context compaction completed.", "success");
				replayDeferredRecoveryInputs();
			},
			onError: (error) => {
				automaticCompactionRunning = false;
				const failed = transitionContextPressure(contextPressureState, { type: "compaction-failed", error: "automatic compaction failed" });
				contextPressureState = failed.state;
				updateContextPressureStatus(ctx);
				resolveIncomingCapabilities("");
				applyWorkModeTools();
				recordContextPressure("compaction_callback", failed.action, failed.reason);
				if (ctx.hasUI) ctx.ui.notify(`Automatic compaction failed: ${error.message}. Deferred input is retained; run /compact or switch to a larger-context model.`, "error");
			},
		});
	}

	// A finalized tool result is already present in Agent state when message_end
	// fires, so live usage includes its size. Abort synchronously here: compacting
	// directly from turn_end races the next provider request in Pi 0.84.x.
	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "toolResult") return;
		// Pi persists the tool result after this hook, so project its model-visible
		// content onto the last trusted usage sample. JSON includes text and image
		// payload sizes while excluding non-contextual tool details.
		const projectedResultTokens = estimatePromptTokens(JSON.stringify(event.message.content ?? []));
		if (observeContextPressure(ctx, "message_end", projectedResultTokens) === "compact-now") ctx.abort();
	});

	pi.on("turn_end", async (_event, ctx) => {
		observeContextPressure(ctx, "turn_end");
	});

	// Abort again at Pi's pre-model context boundary. The message_end abort can
	// race agent-core's tool-loop continuation; this signal belongs to the next
	// request and prevents a network call while recovery is pending.
	pi.on("context", async (_event, ctx) => {
		if (!automaticCompactionPending) return;
		recordContextPressure("context", "compact-now", "single-flight");
		ctx.abort();
	});

	// Wait until abort persistence and agent cleanup finish before compaction. This
	// gives prepareCompaction the finalized tool result and prevents a continuation
	// request from winning the race.
	pi.on("agent_settled", async (_event, ctx) => {
		runAutomaticCompaction(ctx, "agent_settled");
	});

	pi.on("session_compact", async () => {
		markContextCompactionSucceeded();
		if (!automaticCompactionRunning) setTimeout(replayDeferredRecoveryInputs, 0);
	});

	function incomingText(event: unknown): string {
		const value = event as { text?: unknown; message?: unknown; input?: unknown } | null;
		if (typeof value?.text === "string") return value.text;
		if (typeof value?.message === "string") return value.message;
		if (typeof value?.input === "string") return value.input;
		const message = value?.message as { content?: unknown } | undefined;
		return typeof message?.content === "string" ? message.content : "";
	}

	pi.on("input", async (event, ctx) => {
		const replayingDeferredRecoveryInput = event.source === "extension" && deferredReplayAllowance > 0;
		if (replayingDeferredRecoveryInput) {
			deferredReplayAllowance--;
		} else {
			// Session usage can already be over threshold before the first model turn
			// (resume/startup). Sample it here as a final preflight, retain the exact
			// input in memory, and replay only after compaction has completed.
			if (contextPressureState.phase === "normal") observeContextPressure(ctx, "input");
			if (automaticCompactionPending || automaticCompactionRunning || contextPressureState.phase === "failed") {
				deferredRecoveryInputs.push({
					text: event.text,
					images: event.images ? [...event.images] : undefined,
					streamingBehavior: event.streamingBehavior,
				});
				if (automaticCompactionPending && ctx.isIdle()) setTimeout(() => runAutomaticCompaction(ctx, "input"), 0);
				ctx.ui.notify(
					contextPressureState.phase === "failed"
						? "Context recovery failed; input is retained. Run /compact or switch to a larger-context model."
						: "Input retained until automatic context recovery completes.",
					"warning",
				);
				return { action: "handled" as const };
			}
		}
		if (replayingDeferredRecoveryInput && modelWorkBlockedByRosterRecovery(ctx)) {
			// Compaction succeeded, but this resumed orchestrator still needs an
			// explicit roster decision. Retain the exact replay payload again and
			// resume it only after the live recovery command clears the gate.
			deferredRecoveryInputs.push({
				text: event.text,
				images: event.images ? [...event.images] : undefined,
				streamingBehavior: event.streamingBehavior,
			});
			return { action: "handled" as const };
		}
		if (modelWorkBlockedByRosterRecovery(ctx)) return { action: "handled" as const };
		// Pi routes normal, resumed, and remote prompts through this hook before
		// before_agent_start, so this local resolver changes the same request's surface.
		resolveIncomingCapabilities(incomingText(event));
		applyWorkModeTools();
		return { action: "continue" as const };
	});

	// ── Session Start ────────────────────────────

	pi.on("session_start", async (_event, _ctx) => {
		registerVersionStatus(_ctx);
		contextPressureState = createContextPressureState();
		updateContextPressureStatus(_ctx);
		automaticCompactionPending = false;
		automaticCompactionRunning = false;
		deferredReplayAllowance = 0;
		deferredRecoveryInputs.length = 0;
		rosterRecoveryRequired = false;
		rosterRecoveryDiagnostic = "";
		// Capture the configured surface before Agent Hub applies either work mode.
		// Operator work mode restores this baseline (minus gated Hub-owned tools).
		baselineTools = pi.getActiveTools();
		accessApprovalRouter.reset();
		// Clear widgets + any research helpers from a previous session
		for (const [, st] of Array.from(researchStates.entries())) {
			if (st.proc && st.status === "running") { st.killedByOperator = true; st.proc.kill("SIGTERM"); }
		}
		researchStates.clear();
		nextResearchId = 1;
		// Wipe the /af-agents-history log from any previous session.
		executionHistory.reset();
		taskClock = createTaskClock();
		turnBudgetAskUserWaitMs = 0;
		turnContinuationCount = 0;
		taskContinuationCount = 0;
		pendingBudgetContinuation = null;
		budgetContinuationAsks.clear();
		if (widgetCtx) {
			widgetCtx.ui.setWidget("agent-team", undefined);
			widgetCtx.ui.setWidget("agent-research", undefined);
		}
		// Stop tailing any delegation event files from a previous session.
		for (const [, st] of Array.from(agentStates.entries())) {
			st.delegationsWatcher?.close();
			st.delegationsWatcher = undefined;
		}
		delegatedTokens = 0;
		hubSpawnedPeers.clear();
		widgetCtx = _ctx;
		contextWindow = _ctx.model?.contextWindow || 0;
		safetyHarnessPath = resolveSafetyHarness(_ctx.cwd);
		if (!safetyHarnessPath) {
			_ctx.ui.notify(
				"damage-control-continue harness not found — native child dispatches will be refused. Install .pi/harnesses/damage-control-continue/.",
				"error",
			);
		}
		delegateExtPath = resolveDelegateExtension(_ctx.cwd);

		const monitorConfig = monitorLifecycleConfig(process.env);
		if (monitorBridge || monitorLifecycle) { try { await monitorBridge?.cancelAllWaitOnly(); await monitorLifecycle?.stop(); } finally { monitorBridge=null; monitorLifecycle=null; } }
		if (monitorConfig) {
			try {
				fs.mkdirSync(monitorConfig.profilePath, { recursive: true, mode: 0o700 });
				const stableHubId = stableMonitorHubId({ profileId: monitorConfig.profileId, checkout: _ctx.cwd || process.cwd(), workspaceId: process.env.HERDR_WORKSPACE_ID, paneId: process.env.HERDR_PANE_ID });
				monitorHubId = stableHubId;
				const store = new MonitorStore();
				const monitorRegistry = new MonitorRegistry({ runtimeDir: monitorConfig.runtimeDir });
				monitorLifecycle = createMonitorLifecycle({
					registry: monitorRegistry,
					treeKill: killPiTree,
					wait: (proc: ChildProcess) => new Promise<boolean>((resolve) => proc.once("close", () => resolve(true))),
					getRecoveryEvidence: async (task: any) => {
						if (task?.ownerSessionId) {
							const evidence = monitorRegistry.evidenceForOwner(task.ownerSessionId, task.hubInstanceId ?? stableHubId);
							if (evidence.transient) return { transient: true };
							const herdr = await monitorReconcileEvidence({
								hubId: task.hubInstanceId ?? stableHubId,
								currentHubId: stableHubId,
								paneId: process.env.HERDR_PANE_ID,
								workspaceId: process.env.HERDR_WORKSPACE_ID,
								herdr: {
									pane: { get: async (id: string) => (await herdrApi.paneGet(id)).pane },
									workspace: { get: async (id: string) => {
										const panes = await herdrApi.paneList({ workspace_id: id });
										return panes.panes.length ? { id } : null;
									} },
								},
							});
							return {
								oldOwner: evidence.owner,
								oldSocket: evidence.socket,
								oldSession: evidence.session,
								oldHerdr: herdr.herdr,
								transient: herdr.transient,
							};
						}
						return monitorReconcileEvidence({
							owner: monitorLifecycle?.isAlive(),
							socket: monitorLifecycle?.isAlive(),
							session: true,
							hubId: stableHubId,
							currentHubId: stableHubId,
							paneId: process.env.HERDR_PANE_ID,
							workspaceId: process.env.HERDR_WORKSPACE_ID,
							herdr: {
								pane: { get: async (id: string) => (await herdrApi.paneGet(id)).pane },
								workspace: { get: async (id: string) => {
									const panes = await herdrApi.paneList({ workspace_id: id });
									return panes.panes.length ? { id } : null;
								} },
							},
						});
					},
				});
				const eventJournal = new MonitorEventJournal({ file: path.join(monitorConfig.runtimeDir, `monitor-events-${stableHubId}.ndjson`) });
				const invokeJournal = new MonitorInvokeJournal(path.join(monitorConfig.runtimeDir, `monitor-invokes-${stableHubId}.ndjson`));
				monitorBridge = createMonitorSessionBridge({
					events: eventJournal,
					hubInstanceId: stableHubId,
					onEventJournalError: (error: unknown) => _ctx.ui.notify(`Agent Fleet monitor event journal unavailable: ${error instanceof Error ? error.message : String(error)}`, "warning"),
					runtime: new MonitorRuntime({
						runtimeDir: monitorConfig.runtimeDir,
						profileId: monitorConfig.profileId,
						hubInstanceId: stableHubId,
					}),
					registerOwnedProcess: (_key: string, process: ChildProcess, task: any) => monitorLifecycle?.registerOwnedGeneration({
						taskId: task.id,
						generation: task.generation,
						process,
					}),
					cancelOwnedProcess: (request: any) => monitorLifecycle?.lowLevelCancelOwnedGeneration(request) ?? {
						cancelled: false,
						reason: "unsupported",
					},
				});
				const invoke = createMonitorInvokeAdmission({
					journal: invokeJournal,
					task: (id: string, generation: number) => monitorBridge?.snapshot().tasks.find((task: any) => task.id === id && task.generation === generation),
					owner: () => monitorOwnerId,
					queueDepth: () => inboundQueue.size,
					queueLimit: 64,
					enqueue: createWatchdogFollowUpEnqueue((message, options) => pi.sendMessage(message, options)),
					publish: (kind: "action.requested" | "action.accepted" | "action.rejected" | "action.completed" | "hub.queue_depth_changed", task: any, extra?: any) => monitorBridge?.publishEvent(kind, task, extra),
				});
				const registration = await monitorLifecycle.startBridge(monitorBridge, {
					profilePath: monitorConfig.profilePath, profileId: monitorConfig.profileId, hubInstanceId: stableHubId,
					events: (request: any) => eventJournal.replay(request.afterSequence, request.limit, request.waitMs, request.signal), invoke,
				});
				monitorOwnerId = registration?.ownerId;
			} catch (error) {
				monitorLifecycle = null;
				_ctx.ui.notify(`Agent Fleet monitor disabled: ${error instanceof Error ? error.message : String(error)}`, "warning");
			}
		}

		// ── Embedded coms init ──
		// Always refresh the ctx the coms handlers use. Bind the endpoint + register
		// in the pool exactly once per process (guard on comsReady), so a /new session
		// keeps the same peer identity rather than leaking a second socket. On any
		// failure we degrade: comsReady stays false and the coms_* tools are withheld.
		currentCtx = _ctx;
		const soloMode = pi.getFlag("solo") === true;
		if (!comsReady && !soloMode) {
			try {
				identity = await coms.connect({ ctx: _ctx, defaultNamePrefix: "hub", defaultPurpose: "agent-hub dispatcher" });
				comsReady = true;
				try {
					_ctx.ui.setStatus("coms", `📡 ${identity.name}@${identity.project}`);
					installPoolWidget(_ctx);
				} catch { /* hasUI may be false — non-fatal */ }
			} catch (err) {
				comsReady = false;
				try { _ctx.ui?.notify?.(`📡 coms: init failed — ${err instanceof Error ? err.message : String(err)} (coms tools disabled)`, "error"); } catch { /* ignore */ }
			}
		}

		// ── Damage-control shared exemptions file ──
		// One per hub session (solo mode included). Exporting the path on our own
		// process.env lets the co-loaded damage-control-continue mirror /af-allow
		// session grants into the same file the spawned children read.
		if (!exemptionsFile) {
			exemptionsFile = exemptionsFilePath(identity?.session_id ?? `hub-solo-${process.pid}`);
			process.env[EXEMPTIONS_FILE_ENV] = exemptionsFile;
		}

		// Wipe old agent session files so subagents start fresh
		const sessDir = safePathWithin(_ctx.cwd, ".pi", "agent-sessions");
		if (existsSync(sessDir)) {
			for (const f of readdirSync(sessDir)) {
				if (f.endsWith(".json")) {
					try { unlinkSync(join(sessDir, f)); } catch {}
				}
			}
		}

		// Per-project overrides are parsed BEFORE loadAgents: loadAgents archives the
		// previous session's artifacts, and that archive has to honor this project's
		// `run-history-keep` — reading it afterwards would apply the retention one
		// session late. Everything else the overrides drive is assigned below.
		const overrides = parseAgentTeamOverrides(_ctx.cwd);
		runHistoryKeep = overrides.runHistoryKeep;

		loadAgents(_ctx.cwd);

		// Surface non-fatal persona frontmatter warnings (skipped subagents roles,
		// bad delegate_depth) once per session.
		const fmWarnings = allAgentDefs.flatMap(d => (d.warnings || []).map(w => `${d.name}: ${w}`));
		if (fmWarnings.length > 0) {
			_ctx.ui.notify(`Persona frontmatter warnings:\n${fmWarnings.join("\n")}`, "warning");
		}
		if (!delegateExtPath && allAgentDefs.some(d => d.subagents)) {
			_ctx.ui.notify(
				"delegate.ts not found next to agent-hub — `subagents:` declarations are inert (specialists dispatch without a delegate tool).",
				"warning",
			);
		}

		// Apply the rest of the per-project overrides (user-facing language, persona
		// gate, models) — parsed above, before loadAgents.
		userLanguage = overrides.language;
		researchKeep = overrides.researchKeep;
		reconSearchTimeoutMs = overrides.reconSearchTimeoutMs;
		budgetOverrides = overrides.budgetOverrides;
		watchdogSetting = overrides.watchdogSetting;
		watchdogJudgeModel = overrides.watchdogJudgeModel;
		turnDispatchCount = 0;
		turnResearchCount = 0;
		// A new session is a new task by definition.
		resetTaskWindow(null);
		updateModeStatus();
		if (overrides.warnings.length > 0) {
			_ctx.ui.notify(`agent-fleet-overrides warnings:\n${overrides.warnings.join("\n")}`, "warning");
		}

		// Project rule folders and doc entry points: keep the configured lists
		// as-is (personas resolve them against the repo root), but warn once per
		// missing path — a typo'd path would otherwise silently yield nothing.
		projectRulesDirs = overrides.rulesDirs;
		for (const dir of projectRulesDirs) {
			if (!existsSync(join(_ctx.cwd, dir))) {
				_ctx.ui.notify(`agent-fleet-overrides: rules folder "${dir}" not found in ${_ctx.cwd}`, "warning");
			}
		}
		projectDocsPaths = overrides.docsPaths;
		for (const p of projectDocsPaths) {
			if (!existsSync(join(_ctx.cwd, p))) {
				_ctx.ui.notify(`agent-fleet-overrides: docs entry point "${p}" not found in ${_ctx.cwd}`, "warning");
			}
		}

		// Model switching state resets each session; per-project overrides replace
		// the persona defs' default model / candidate list before anything reads them.
		modelOverrides.clear();
		modelSubstitutions.clear();
		subagentModelOverrides.clear();
		thinkingOverrides.clear();
		for (const def of allAgentDefs) {
			const lower = def.name.toLowerCase();
			if (overrides.personaModels[lower]) Object.assign(def, applyModelOverride(def, overrides.personaModels[lower]));
			if (overrides.personaModelLists[lower]) def.models = overrides.personaModelLists[lower];
			if (overrides.personaThinking[lower]) def.thinking = overrides.personaThinking[lower];
			// Delegation overrides: replace/add individual sub-roles (other declared
			// roles keep their frontmatter values) and the depth budget.
			const subOv = overrides.personaSubagents[lower];
			if (subOv) {
				def.subagents = { ...(def.subagents || {}) };
				for (const [role, r] of Object.entries(subOv)) {
					const declared = def.subagents[role];
					// A model-only override keeps the declared tool cap; an explicit
					// tools= value replaces it. Either way the frontmatter model is
					// retained as the one-shot runtime fallback.
					def.subagents[role] = declared
						? applyModelOverride({ ...declared, ...(r.tools ? { tools: r.tools } : {}) }, r.model)
						: r;
				}
			}
			if (overrides.personaDelegateDepth[lower] !== undefined) {
				def.delegateDepth = overrides.personaDelegateDepth[lower];
			}
		}

		// Validate model profiles against the (post-override) declared candidates.
		// Any violation drops the whole profile — never a partial apply.
		const profileErrors: string[] = [];
		for (const [profileName, entries] of Object.entries(modelProfiles)) {
			for (const [persona, model] of Object.entries(entries)) {
				const def = allAgentDefs.find(d => d.name.toLowerCase() === persona);
				if (!def) {
					profileErrors.push(`profile "${profileName}": unknown persona "${persona}"`);
				} else if (!allowedModels(def).includes(model)) {
					profileErrors.push(`profile "${profileName}": ${persona} does not declare ${model} (model:/af-models: in ${def.file})`);
				}
			}
		}
		if (profileErrors.length > 0) {
			const dropped = new Set(profileErrors.map(e => e.match(/^profile "([^"]+)"/)![1]));
			for (const name of dropped) delete modelProfiles[name];
			_ctx.ui.notify(
				`model-profiles.yaml: dropped ${Array.from(dropped).map(n => `"${n}"`).join(", ")}:\n${profileErrors.join("\n")}`,
				"error",
			);
		}

		if (dispatchPolicyWarnings.length > 0) {
			_ctx.ui.notify(
				`dispatch-policy.yaml: ${dispatchPolicyWarnings.length} construct(s) dropped:\n${dispatchPolicyWarnings.join("\n")}`,
				"warning",
			);
		}

		// Research personas (kind: research) — spawnable read-only via spawn_research,
		// independent of team membership.
		researchPersonas = allAgentDefs.filter(d => (d.kind || "").toLowerCase() === "research");

		// Explicit CLI selection wins; otherwise restore only the canonical team name
		// and re-resolve it against current teams.yaml/persona files. An explicit
		// Operator work mode suppresses an ambient persisted roster unless --agent-team
		// was also supplied.
		agentStates.clear();
		activeTeamName = "";
		comsMissNotified.clear();
		recomputeGrid();
		const sessionEntries = _ctx.sessionManager.getEntries();
		const explicitWorkMode = pi.getFlag("work-mode");
		const explicitRoster = pi.getFlag("agent-team");
		const hasExplicitRoster = typeof explicitRoster === "string" && explicitRoster.trim() !== "";
		const startupRoster = resolveSessionRoster({
			teams,
			entries: sessionEntries,
			explicitRoster,
			availablePersonas: allAgentDefs.map(def => def.name),
			includePersisted: !(explicitWorkMode === "operator" && !hasExplicitRoster),
		});
		workMode = resolveSessionWorkMode({
			entries: sessionEntries,
			explicitWorkMode,
			hasExplicitRoster: startupRoster.source === "explicit",
		});
		if (startupRoster.roster) {
			activateTeam(startupRoster.roster.name);
			persistActiveRoster();
		}
		rosterRecoveryRequired = orchestratorNeedsRoster(workMode, agentStates.size);
		rosterRecoveryDiagnostic = rosterRecoveryRequired
			? startupRoster.diagnostic || "Persisted orchestrator work mode has no native roster."
			: "";
		if (startupRoster.diagnostic) {
			_ctx.ui.notify(
				`${startupRoster.diagnostic} ${rosterRecoveryRequired ? "Model input is blocked until you select /af-agents-team, restart with --agent-team <name>, or switch explicitly with --work-mode operator." : "Continuing without that roster."}`,
				rosterRecoveryRequired ? "error" : "warning",
			);
		} else if (rosterRecoveryRequired) {
			_ctx.ui.notify(
				`${rosterRecoveryDiagnostic} Model input is blocked until you select /af-agents-team, restart with --agent-team <name>, or switch explicitly with --work-mode operator.`,
				"error",
			);
		}

		// Probe for `ask_user` (registered by the `pi-ask-user` companion package
		// when installed). Action methods like getAllTools are runtime-only, so
		// this MUST happen at session_start, not at extension load.
		askUserAvailable = pi.getAllTools().some(t => t.name === "ask_user");

		// Fleet tools are available only inside a herdr pane with a live server.
		// The work mode policy adds gated groups without activating unavailable tools.
		herdrFleetReady = herdrPaneId() !== null && (await herdrAvailable()) !== null;
		const persistedCapabilities = latestPersistedCapabilityState(_ctx.sessionManager.getEntries());
		taskCapabilityPacks = persistedCapabilities?.taskPacks ?? [];
		taskProvisionalPacks = persistedCapabilities?.provisional ?? [];
		capabilityConfirmation = persistedCapabilities?.confirmation ?? {};
		resolveIncomingCapabilities("");
		applyWorkModeTools();
		if (observeContextPressure(_ctx, "session_start") === "compact-now") {
			setTimeout(() => runAutomaticCompaction(_ctx, "session_start"), 0);
		}
		updateWorkModeStatus(_ctx);

		_ctx.ui.setStatus("agent-team", `Native roster: ${activeTeamName || "(none)"} (${agentStates.size})`);
		const members = Array.from(agentStates.values()).map(s => displayName(s.def.name)).join(", ");
		const askUserLabel = askUserAvailable
			? "available (via pi-ask-user)"
			: "NOT AVAILABLE — run `pi install npm:pi-ask-user`";
		const comsLabel = comsReady && identity
			? `📡 ${identity.name}@${identity.project} — peers via coms_list; /af-handoff <peer> to delegate`
			: soloMode
				? "off (--solo: fixed specialists + research only)"
				: "off (endpoint bind failed — coms tools disabled)";
		const fleetLabel = herdrFleetReady
			? "herdr — spawn/read/close panes + notify (herdr_* tools active)"
			: "off (not inside a herdr pane, or no herdr server)";
		const comsPreferred = Object.entries(dispatchPolicy.substitutions)
			.filter(([, s]) => s.prefer === "coms")
			.map(([n]) => n);
		const dispatchLabel = dispatchPolicy.default === "coms"
			? "coms default — any member with a live same-name pool peer is served by it (/af-dispatch-policy)"
			: comsPreferred.length > 0
				? `coms-preferred: ${comsPreferred.join(", ")} (live peer wins, /af-dispatch-policy for status)`
				: "all native (no substitutions in .pi/agents/dispatch-policy.yaml)";
		_ctx.ui.notify(
			`Work Mode: ${workMode} (${workMode === "operator" ? "direct tools enabled" : "delegate-only"})\n` +
			`Native roster: ${activeTeamName || "(none)"} (${agentStates.size}${members ? `: ${members}` : ""})\n` +
			`Native roster sets loaded from: .pi/agents/teams.yaml\n` +
			`Dispatch backends: ${dispatchLabel}\n` +
			`User-facing language: ${userLanguage} (override in .ai/agent-fleet-overrides.md)\n` +
			`ask_user: ${askUserLabel}; specialists bubble up via ASK_USER:\n` +
			`Coms: ${comsLabel}\n` +
			`Fleet: ${fleetLabel}\n\n` +
			`/af-work-mode [mode]      Operator | Orchestrator (Alt+M)\n` +
			`/af-agents-team          Select a team\n` +
			`/af-agents-list          Open Fleet Dashboard\n` +
			`/af-agents-history       Timeline of agent runs — durations, parallel markers, grand total\n` +
			`/af-context              Read-only full-screen context budget diagnostic\n` +
			`/af-agent-model <persona>[.<role>] Switch a persona's or sub-role's model\n` +
			`/af-agent-model-thinking <persona> Switch a persona's thinking level\n` +
			`/af-models [profile]     Apply a named model profile to the team\n` +
			`/af-agent-models-substitute [src tgt] Pick/save a session-wide source → target model substitution\n` +
			`/af-dispatch-policy      Show which members route to coms peers (dispatch-policy.yaml)\n` +
			`/af-agents-kill <name|rN|all> Kill a frozen specialist or remove research helper(s)\n` +
			`/af-agents-restart <name|rN> Kill + re-run its last task fresh\n` +
			`/af-zoom <name|rN|child> Scrollable view of an agent / research / delegate-child stream\n` +
			`/af-coms [--all|--project N] Refresh the coms peer pool\n` +
			`/af-handoff <peer>       Hand the session off to a coms peer\n` +
			`/af-compound [focus]     Capture session lessons into the project rules/docs`,
			"info",
		);
		updateWidget();

		// Footer: version | model (thinking) | context bar, with the pi-voice-stt
		// recording indicator on a second line below it (when recording).
		_ctx.ui.setFooter((_tui, theme, footerData) => ({
			dispose: () => {},
			invalidate() {},
			render(width: number): string[] {
				const model = _ctx.model?.id || "no-model";
				// Dispatcher's live thinking level as the same " (code)" badge subagents
				// show after their model (off → no badge). Optional-chained so an older
				// pi without getThinkingLevel just renders the model alone.
				const think = thinkingSuffix(pi.getThinkingLevel?.());
				const usage = _ctx.getContextUsage();
				const pct = usage ? usage.percent : 0;
				const filled = Math.round(pct / 10);
				const bar = "#".repeat(filled) + "-".repeat(10 - filled);

				const left = renderHubFooterLeft(theme, HARNESS_VERSION, model, think);
				const hint = theme.fg("dim", composeFleetFooterHint(viewMode, compactWorkMode(workMode)));
				// The btw extension flips this global the first time a /af-btw command or
				// Alt+' is used; surface its reopen shortcut right next to the Alt+A hint.
				const btwHint = (globalThis as { __btwActivated?: boolean }).__btwActivated
					? theme.fg("muted", "  ·  Alt+' ") + theme.fg("dim", "btw")
					: "";
				const right = hint + btwHint +
					theme.fg("muted", "  ·  ") +
					theme.fg("dim", `[${bar}] ${Math.round(pct)}% `);
				const pad = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)));

				const lines = [truncateToWidth(left + pad + right, width)];

				// The pi-voice-stt extension publishes its animated indicator via
				// setStatus("voice-stt", …). The custom footer above replaces the
				// built-in one (which would render it), so surface it here as a second
				// line below the model line. Optional-chained for older pi runtimes.
				const stt = footerData?.getExtensionStatuses?.().get("voice-stt");
				if (stt && stt.trim()) {
					// Recording → accent (live), transcribing → muted (working).
					const color = /REC/.test(stt) ? "accent" : "muted";
					lines.push(truncateToWidth(theme.fg(color, ` ${stt}`), width));
				}

				return lines;
			},
		}));
	});

	// ── Embedded coms: respond to inbound peer prompts at turn end ──
	// When this agent was addressed by a peer (an inbound prompt in the queue), the
	// turn's final assistant text becomes the response we ship back to the sender.
	pi.on("agent_end", async (_event, ctx) => {
		// Close both the task clock and /af-agents-history dispatcher turn at the
		// actual end event, so time awaiting the next user message is never charged.
		const turnEndedAt = Date.now();
		closeTurnActiveTime(turnEndedAt);
		executionHistory.endTurn(turnEndedAt);

		// End-of-turn sweep: a peer spawned this turn and never sent to is still
		// running. Named once per turn it stays unaddressed; the close itself is
		// the human's call (herdr_close_pane keeps its confirmation).
		const peerSweep = unaddressedPeerSweep(Array.from(hubSpawnedPeers.values()));
		if (peerSweep) ctx.ui.notify(peerSweep.message, "warning");

		await coms.respond(ctx);
	});

	// ── Embedded coms: clean shutdown ──
	// Tear down the coms layer (timers, server, registry, socket) and SIGTERM any
	// specialist/research children so they don't outlive the dispatcher.
	let shuttingDown = false;
	async function cleanShutdown(): Promise<void> {
		if (shuttingDown) return;
		shuttingDown = true;
		await coms.shutdown();
		if (monitorBridge) { try { await monitorBridge.cancelAllWaitOnly(); } catch { /* ignore */ } }
		if (monitorLifecycle) {
			try { await monitorLifecycle.stop(); } catch { /* ignore */ }
			monitorLifecycle = null;
		}
		monitorBridge?.reset();
		monitorBridge?.stop();
		monitorBridge = null;
		if (exemptionsFile) {
			// Session-scoped by definition — remove so grants never leak into the next session.
			try { fs.unlinkSync(exemptionsFile); } catch { /* ignore */ }
			exemptionsFile = null;
		}
		for (const st of agentStates.values()) {
			if (st.proc && st.status === "running") { try { st.killedByOperator = true; st.proc.kill("SIGTERM"); } catch { /* ignore */ } }
		}
		for (const st of researchStates.values()) {
			if (st.proc && st.status === "running") { try { st.killedByOperator = true; st.proc.kill("SIGTERM"); } catch { /* ignore */ } }
		}
		if (currentCtx?.hasUI) {
			try { currentCtx.ui.setWidget("coms-pool", undefined); } catch { /* ignore */ }
		}
	}

	pi.on("session_shutdown", async () => { await cleanShutdown(); });
	process.on("SIGINT", () => { void cleanShutdown(); });
	process.on("SIGTERM", () => { void cleanShutdown(); });
}
