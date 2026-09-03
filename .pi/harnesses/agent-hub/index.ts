/** Agent Hub composition root: constructs mutable state, contexts, registrars, and ordered lifecycle ports. */

import type { AgentDef, AgentState, ResearchState } from "./types.ts";
import { DEFAULT_OVERRIDES, THINKING_LEVELS, parseAgentTeamOverrides } from "./config/overrides.ts";
import { loadAgentConfiguration } from "./config/agents.ts";
import { abbrevThinking, displayName, extractAskUserQuestions, extractNeedsResearch, resolveDelegateExtension, resolveThinkingLevel } from "./presentation.ts";
import { MAX_LIVE_ENTRY_CHARS, appendTimelineEvent, appendTimelineText, flushTimelineStore } from "./timeline.ts";
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
import { createMonitorLifecycle } from "./monitor-lifecycle.ts";
import { createMonitorSessionBridge } from "./monitor-session-bridge.ts";
import {
	AGENT_ID_ENV, ASK_ENDPOINT_ENV, EXEMPTIONS_FILE_ENV,
	exemptionsFilePath, type AccessRequest,
} from "../lib/damage-control-shared.ts";
import { applyModelOverride, clampDelegateDepth, fallbackModelFor, isReadOnlyToolList, MAX_DELEGATE_DEPTH, normalizeAgentInput, orchestratorNeedsRoster, parseTeamsYaml, safeAgentKey, safePathWithin, taskFingerprint, upsertTeamInYaml } from "./helpers.ts";
import { DEFAULT_TASK_TIER, addTaskClockWait, applyTierChange, blockingFindingCap, checkReviewRoundCap, checkTaskBudget, checkTierPersonaGate, checkTurnBudget, createTaskClock, isReviewPersona, openTaskClock, remainingTaskResearch, reviewBudgetClause, reviewRoundCap } from "./run-budget.js";
import { countReviewFindings, findingBudgetNotice } from "./review-findings.js";
import { checkDocsLane, docsLaneNotice } from "./docs-lane.js";
import { checkExternalBlockerGate, extractExternalBlockers } from "./external-blocker.js";
import { DEFAULT_RUN_HISTORY_KEEP, normalizeRunHistoryKeep } from "./run-namespace.js";
import { validateAssertionBatch } from "./assertion-ledger.js";
import { DEFAULT_PROVIDER_LIMITS, createProviderSemaphore, parseProviderLimits } from "./provider-semaphore.js";
import {
	PANE_PROMPT_TIMEOUT_MS,
	launchPeerInPane,
	peerReadyVerdict,
	unaddressedPeerSweep,
} from "../lib/spawned-peers.js";
import { contextPct, estimatePromptTokens, resolveContextWindow } from "./context-window.js";
import { DEFAULT_WATCHDOG_SETTING, WATCHDOG_SETTINGS, normalizeWatchdogSetting, resolveWatchdogActive } from "./drift-watchdog.js";
import { shouldExtractReturn } from "./return-extract.js";
import { crossCheck, deliveryDisposition, extractAssertionIds, parseDeliveredReturn } from "./return-contract.js";
import { checkScope, diffAgainst, snapshotWorktree } from "./scope-gate.js";
import { validateEvidence } from "./evidence-rules.js";
import { comsRequiredRefusal, explicitComsRefusal, parseDispatchPolicy, resolveDispatchBackend } from "./backend-policy.js";
import { NATIVE_ROSTER_ENTRY_TYPE, persistedNativeRosterState, resolveSessionWorkMode, resolveSessionRoster } from "./work-mode.ts";
import { compactWorkMode } from "./work-mode-controls.ts";
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
import { registerPoll } from "./commands/poll.ts";
import type { CommandContext } from "./commands/context.ts";
import { formatAfPollStarted, formatAfPollVoiceProgress, handleAfPoll } from "./poll-command.ts";
import { registerDispatchAgent } from "./tools/dispatch-agent.ts";
import { registerSpawnResearch } from "./tools/spawn-research.ts";
import { registerSetTaskTier } from "./tools/set-task-tier.ts";
import { registerTeamAdjust } from "./tools/team-adjust.ts";
import { registerVerificationContract } from "./tools/verification-contract.ts";
import { registerComsTools } from "./tools/coms-tools.ts";
import { paneTail, peerManifest, peerPersonaExists, registerFleetTools, spawnDelaySeconds, STAGGER_ENV_VAR, waitForPeerRegistration } from "./tools/fleet-tools.ts";
import type { ToolContext } from "./tools/context.ts";
import { createToolExecutionOrchestration } from "./tools/execution-orchestration.ts";
import { latestPersistedCapabilityState, type ContextState, type PendingOperation } from "./capability-packs.ts";
import { contextPressureDiagnostic, createContextPressureState, transitionContextPressure, type ContextPressureState } from "./context-pressure.ts";
import { confirmationOutcome, capabilityConfirmationPack, capabilityConfirmationQuestion, type ConfirmableCapabilityPack } from "./capability-confirmation.ts";
import { budgetContinuationInstruction, budgetContinuationKind, budgetContinuationOutcome, turnBudgetActiveMs, type BudgetContinuationKind } from "./budget-continuation.ts";
import { observeAskUserResults } from "../ask-user-remote/index.ts";
import { buildHubPeerSpawnPlan, launchHubPeerInPane } from "./peer-spawn-plan.ts";
import { DEFAULT_RESEARCH_KEEP, RESEARCH_TOOLS, createResearchRuntime, parseResearchHandle } from "./research/runtime.ts";
import { requireSafetyHarness, resolveSafetyHarness } from "./safety-routing.ts";
import { createAccessApprovalRouter } from "./access-approval.ts";
import { readdirSync, readFileSync, existsSync, mkdirSync, unlinkSync, writeFileSync, rmSync } from "fs";
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
import { createGridUI } from "./ui/grid.ts";
import { createDetailPanel } from "./ui/detail-panel.ts";
import { createFleetDashboard } from "./ui/fleet-dashboard.ts";
import { createContextBudgetUi } from "./ui/context-budget.ts";
import { createPoolPresentation } from "./ui/pool.ts";
import { registerInputShortcuts } from "./input/shortcuts.ts";
import { createCompletionPresentation } from "./input/completions.ts";
import { createResearchControls } from "./research/controls.ts";
import { createContextPressureLifecycle, createContextPressureRootState } from "./lifecycle/context-pressure.ts";
import { createTurnLifecycleHandlers } from "./lifecycle/turn-handlers.ts";
import { createMonitorSession } from "./lifecycle/monitor-session.ts";
import { applySessionOverrides, registerSessionOrchestration, resetHubSession } from "./lifecycle/session-orchestration.ts";
import { openZoom, type TimelineEntry, type Zoomable } from "./ui/zoom.ts";
import { openHistory } from "./ui/history.ts";
import { createExecutionHistoryStore, type HistoryEntry } from "./ui/history-store.ts";
import { createDispatchComs, createDispatchNative, createDispatchObservability, type DelegationChild } from "./dispatch-core.ts";
import { buildFleetRows, type PeerInput } from "../lib/fleet-read-model.ts";
import { compactWidgetsEnabled, gridColumnsForSize } from "../lib/fleet-dashboard-ops.ts";
import { createFleetTranscriptStore } from "../lib/fleet-transcript-store.ts";
import type { ContextBudgetComponent } from "../lib/context-budget.ts";
import { buildHubSystemPrompt as assembleHubPrompt } from "./prompts/system-prompt.ts";
import type { HubPromptContext } from "./prompts/context.ts";
import { buildSessionStartNotice, createSessionFooter } from "./prompts/session-start.ts";
import { registerSessionStart } from "./session-start.ts";
import { createHubStateContext } from "./context/hub-state.ts";
import { createAgentStateFactory } from "./context/agent-state.ts";
import { createBudgetContext, createSessionTotals, freshTurnReport, type PendingBudgetContinuation, type TurnReport } from "./context/budgets.ts";
import { createAssertionsArtifactsContext, type Assertion, type InputArtifactPreview } from "./context/assertions-artifacts.ts";
import { createModelPolicy } from "./policy/models.ts";
import { createRosterPolicy } from "./policy/roster.ts";
import { createWorkModePolicy } from "./policy/work-mode.ts";
import { nativeResearchSystemPrompt } from "../lib/context-budget-child-prompt.ts";
import { parseEnvFile, resolveEnvFilePath } from "../../../scripts/lib/herdr-layout.ts";
import { worktreeTag } from "../../../scripts/lib/team-project.ts";
import { join, resolve } from "path";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

// ── Extension ────────────────────────────────────

const CONTEXT_WARN_THRESHOLD = 70;
const RESEARCHER_PERSONAS = new Set(["researcher", "deep-researcher"]);

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
	let researchStates: Map<number, ResearchState> = new Map();
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
	const hubStateCtx = createHubStateContext({
		getCurrentContext: () => currentCtx, setCurrentContext: value => { currentCtx = value; },
		getExemptionsFile: () => exemptionsFile, setExemptionsFile: value => { exemptionsFile = value; },
		getSessionDir: () => sessionDir, setSessionDir: value => { sessionDir = value; },
		getWidgetContext: () => widgetCtx, setWidgetContext: value => { widgetCtx = value; },
		getPendingHandoff: () => pendingHandoff, setPendingHandoff: value => { pendingHandoff = value; },
	});
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
	// ── Per-turn cost report (/af-hub-report) ──
	let turnReport: TurnReport = freshTurnReport();
	let lastTurnReport: TurnReport | null = null;
	const sessionTotals = createSessionTotals();
	// Session-wide delegated-spend counter (tokens across all delegate children),
	// surfaced in the status line. Resets on session_start.
	let delegatedTokens = 0;

	const budgetCtx = createBudgetContext({
		getBudgetOverrides: () => budgetOverrides,
		getTurnDispatchCount: () => turnDispatchCount, setTurnDispatchCount: value => { turnDispatchCount = value; },
		getTurnResearchCount: () => turnResearchCount, setTurnResearchCount: value => { turnResearchCount = value; },
		getTurnBudgetAskUserWaitMs: () => turnBudgetAskUserWaitMs, setTurnBudgetAskUserWaitMs: value => { turnBudgetAskUserWaitMs = value; },
		setPendingBudgetContinuation: value => { pendingBudgetContinuation = value; }, clearBudgetContinuationAsks: () => budgetContinuationAsks.clear(),
		getTaskContinuationCount: () => taskContinuationCount, setTaskContinuationCount: value => { taskContinuationCount = value; },
		getTurnContinuationCount: () => turnContinuationCount, setTurnContinuationCount: value => { turnContinuationCount = value; },
		getTaskDispatchCount: () => taskDispatchCount, setTaskDispatchCount: value => { taskDispatchCount = value; },
		getTaskResearchCount: () => taskResearchCount, setTaskResearchCount: value => { taskResearchCount = value; },
		getTaskLabel: () => taskLabel, setTaskLabel: value => { taskLabel = value; },
		getTaskClock: () => taskClock, setTaskClock: value => { taskClock = value; },
		getTaskReviewRounds: () => taskReviewRounds, setTaskReviewRounds: value => { taskReviewRounds = value; },
		getTaskTier: () => taskTier, setTaskTier: value => { taskTier = value; },
		getTaskTierAssumed: () => taskTierAssumed, setTaskTierAssumed: value => { taskTierAssumed = value; },
		clearTurnDispatchFingerprints: () => turnDispatchFingerprints.clear(),
		clearTaskCapabilities: () => workModePolicy.resetCapabilities(),
		clearExternalBlockers: () => { externalBlockers = []; externalBlockerAcknowledged = false; externalBlockerRefusedOnce = false; },
		resolveIncomingCapabilities: () => { resolveIncomingCapabilities("", true); }, applyWorkModeTools: () => { applyWorkModeTools(); },
		getTurnReport: () => turnReport,
		setStatus: (key, value) => { widgetCtx?.ui?.setStatus(key, value); },
		getAuditContext: () => ({ cwd: identity?.cwd ?? currentCtx?.cwd, sessionId: identity?.session_id, project: identity?.project }),
		appendEntry: (type, data) => { pi.appendEntry(type, data); },
		executionHistory,
	});
	const {
		currentBudget, currentTaskBudget, taskCounters, taskActiveElapsedMs, turnBudgetActiveElapsedMs,
		armBudgetContinuation, renewTurnBudgetWindow, continueTaskBudgetWindow, closeTurnActiveTime, resetTaskWindow,
		hubAuditIdentity, hubLocationSuffix, taskResetSnapshot, budgetContinuationSnapshot,
		appendTaskResetEntry, appendBudgetContinuationEntry, updateModeStatus, ensureTaskTier,
	} = budgetCtx;

	// ── Verification Contract: assertion ledger (advisory) ──
	// Mutable ownership remains here; the extracted runtime receives explicit ports.
	let assertions: Assertion[] = [];
	const assertionsArtifactsCtx = createAssertionsArtifactsContext({
		getAssertions: () => assertions,
		getSessionDir: () => sessionDir,
		getRunHistoryKeep: () => runHistoryKeep,
		setStatus: (key, value) => { widgetCtx?.ui?.setStatus(key, value); },
	});
	const {
		persistAssertions, assertionStatusLine, renderAssertionLedgerLines, renderAssertionLedgerText,
		updateAssertionStatus, artifactsRoot, ensureArtifactsLayout, archivePreviousRun,
		loadInputArtifacts, appendInputArtifacts, writeRunArtifact, evidencePathExists,
		listArtifactFiles, renderArtifactIndexText, appendMachineHandoffSections,
	} = assertionsArtifactsCtx;

	const modelPolicy = createModelPolicy<AgentDef>({
		getAllDefs: () => allAgentDefs,
		getActiveDef: name => agentStates.get(name)?.def,
		getResearchDefs: () => researchPersonas,
		refreshUi: () => updateWidget(),
	});
	const {
		allowedModels, substitutedModel, resolvedModel, resolvedSubagentModel,
		resolvedThinking, switchablePersonaDef, allKnownModels,
	} = modelPolicy;

	function appendDeclaredScope(task: string, scopeGlobs: string[]): string {
		if (!scopeGlobs || scopeGlobs.length === 0) return task;
		return task + `\n\n## Declared scope — advisory guardrail\nStay within these paths/globs when changing files; changes outside them will be flagged to the dispatcher for a human decision, not auto-reverted.\n${scopeGlobs.map(s => `- ${s}`).join("\n")}`;
	}

	function loadAgents(cwd: string): void {
		loadAgentConfiguration(cwd, {
			setSessionDir: hubStateCtx.setSessionDir, getSessionDir: hubStateCtx.getSessionDir,
			archivePreviousRun, ensureArtifactsLayout, resetAssertions: () => { assertions = []; },
			setAgentDefs: value => { allAgentDefs = value; }, setTeams: value => { teams = value; },
			setModelProfiles: value => { modelProfiles = value; }, setDispatchPolicy: value => { dispatchPolicy = value; },
			setDispatchPolicyWarnings: value => { dispatchPolicyWarnings = value; },
		});
	}

	const agentStateFactory = createAgentStateFactory(() => sessionDir);
	const { sessionHealthIo, adoptableSessionFile, freshAgentState } = agentStateFactory;

	// Auto-size grid columns based on team size
	function recomputeGrid() {
		gridCols = gridColumnsForSize(agentStates.size);
	}

	const rosterPolicy = createRosterPolicy<AgentDef, AgentState>({
		getTeams: () => teams, getAllDefs: () => allAgentDefs, getStates: () => agentStates,
		getActiveTeamName: () => activeTeamName, setActiveTeamName: value => { activeTeamName = value; },
		clearBackendNotices: () => comsMissNotified.clear(), createFreshState: freshAgentState,
		adoptSession: adoptableSessionFile,
		quarantineSession: agentStateFactory.quarantine,
		persist: team => pi.appendEntry(NATIVE_ROSTER_ENTRY_TYPE, persistedNativeRosterState(team)),
		recompute: recomputeGrid, refreshUi: () => updateWidget(), displayName,
		orchestratorNeedsRosterAfterDrop: size => orchestratorNeedsRoster(getWorkMode(), size),
	});
	const { activateTeam, persistActiveRoster, add: rosterAdd, drop: rosterDrop } = rosterPolicy;

	// ── Shared model presentation ─────────────────
	// These formatters serve the extracted grid and the remaining composition-root
	// call sites. Keep one implementation so cards, fleet rows, menus, fallback
	// notices, and the footer retain the same presentation semantics.
	function shortModel(model: string | undefined): string {
		return model ? model.split("/").pop()! : "default";
	}

	// A " (code)" thinking badge for display, or "" when the level is off.
	function thinkingSuffix(rawThinking: string | undefined): string {
		const code = abbrevThinking(resolveThinkingLevel(rawThinking));
		return code ? ` (${code})` : "";
	}

	// The model + thinking badge a persona would dispatch with: "gpt-5.5 (xh)".
	function modelWithThinking(def: AgentDef): string {
		return shortModel(resolvedModel(def)) + thinkingSuffix(resolvedThinking(def));
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
		displayName, resolvedThinking, shortModel, thinkingSuffix, modelWithThinking,
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
		getWorkMode: () => getWorkMode(),
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

	// Shared child guardrail environment. Dispatch-native and research use the
	// same root-owned exemptions and coms escalation endpoint.
	function guardrailEnv(agentId: string): Record<string, string> {
		const env: Record<string, string> = { [AGENT_ID_ENV]: agentId };
		if (exemptionsFile) env[EXEMPTIONS_FILE_ENV] = exemptionsFile;
		if (comsReady && identity) env[ASK_ENDPOINT_ENV] = identity.endpoint;
		return env;
	}

	// ── Research helper runtime ────────────────────
	// The composition root owns the mutable bindings; the runtime reaches them only
	// through these explicit ports so later controls can keep stable handles.
	const researchRuntime = createResearchRuntime<AgentDef>({
		getResearchStates: () => researchStates,
		setResearchStates: value => { researchStates = value; },
		getNextResearchId: () => nextResearchId,
		setNextResearchId: value => { nextResearchId = value; },
		getResearchKeep: () => researchKeep,
		setResearchKeep: value => { researchKeep = value; },
		hubState: hubStateCtx, budget: budgetCtx, artifacts: assertionsArtifactsCtx,
		executionHistory, providerSemaphore,
		getSafetyHarnessPath: () => safetyHarnessPath,
		getReconSearchTimeoutMs: () => reconSearchTimeoutMs,
		getContextWindow: () => contextWindow,
		resolvedModel, resolvedThinking, resolveThinkingLevel, fallbackModelFor, substitutedModel,
		modelWindowLookup, guardrailEnv, notifyProviderQueue, spawnPiAgentWithModelFallback,
		nativeResearchSystemPrompt, requireSafetyHarness, shortModel, displayName,
		flushTimelineStore, appendTimelineText, appendTimelineEvent,
		createTranscriptStore: createFleetTranscriptStore, updateResearchWidget,
		sendResearchMessage: message => {
			pi.sendMessage(message, { deliverAs: "followUp", triggerTurn: true });
		},
	});

	// ── Embedded coms: shared registry, transport, and pool core ──
	const peersInScope = () => coms.peersInScope();
	const resolveTarget = (target: string) => coms.resolveTarget(target);

	const poolPresentation = createPoolPresentation({
		getIdentity: () => identity,
		getDisplayProject: () => coms.scope.displayProject,
		includeExplicitPeers: () => coms.scope.includeExplicit,
		getPeerCards: () => peerCards,
		readProjectEntries: readAllRegistryEntries,
		readAllEntries: readAllRegistryEntriesAcrossProjects,
		isCompact: () => compactWidgetsEnabled(viewMode),
		truncate: truncateToWidth,
	});
	const fleetPeerInputs = poolPresentation.peerInputs;
	const renderPool = poolPresentation.render;
	const installPoolWidget = poolPresentation.install;

	// ── Extracted tool execution wiring ──
	// Mutable fleet state remains composition-owned; executor modules receive ports.
	let herdrFleetReady = false;
	const hubSpawnedPeers = new Map<string, { name: string; paneId: string | null; addressed: boolean }>();
	const markPeerAddressed = (name: string) => {
		const entry = hubSpawnedPeers.get(String(name || "").toLowerCase());
		if (entry) entry.addressed = true;
	};
	let lastHubPiSpawnAt: number | null = null;

	let askUserAvailable = false;
	let baselineTools: string[] = [];
	let contextPressureState: ContextPressureState = createContextPressureState();
	const pressureRootState = createContextPressureRootState();

	function pendingCapabilityOperations(): PendingOperation[] {
		const pending: PendingOperation[] = [];
		if (Array.from(agentStates.values()).some(state => state.status === "running") || Array.from(researchStates.values()).some(state => state.status === "running")) pending.push({ pack: "fleet", kind: "child" });
		if (pendingReplies.size > 0 || pendingHandoff) pending.push({ pack: "peer", kind: "message" });
		if (hubSpawnedPeers.size > 0) pending.push({ pack: "workspace", kind: "pane" });
		return pending;
	}
	function capabilityContextState(): ContextState {
		if (contextPressureState.phase === "warning") return "approaching-compaction";
		if (contextPressureState.phase !== "normal" || contextPressureState.pressure === "imminent") return "imminent-compaction";
		if (contextPressureState.pressure === "approaching") return "approaching-compaction";
		const percent = currentCtx?.getContextUsage?.()?.percent;
		if (typeof percent === "number" && percent >= 90) return "imminent-compaction";
		if (typeof percent === "number" && percent >= 80) return "approaching-compaction";
		return "normal";
	}
	const workModePolicy = createWorkModePolicy({
		getBaselineTools: () => baselineTools, getRosterSize: () => agentStates.size,
		getActiveTeamName: () => activeTeamName, getComsReady: () => comsReady,
		getHerdrReady: () => herdrFleetReady, getAskUserAvailable: () => askUserAvailable,
		getIdentityLabel: () => identity ? `${identity.name}@${identity.project}` : null,
		getTaskTier: () => taskTier, getPendingOperations: pendingCapabilityOperations,
		getContextState: capabilityContextState, setActiveTools: tools => pi.setActiveTools(tools),
		persist: (type, data) => pi.appendEntry(type, data), replayDeferredInputs: replayDeferredRecoveryInputs,
		watchdogArmed: mode => resolveWatchdogActive(undefined, undefined, watchdogSetting, mode),
	});
	const {
		getWorkMode, getCapabilityResolution, resolveIncomingCapabilities, provisionalCapabilityRefusal,
		applyWorkModeTools, modelWorkBlockedByRosterRecovery,
		statusText: workModeStatusText, applySelection: applyWorkModeSelection, openPicker: openWorkModePicker,
	} = workModePolicy;


	const toolCtx: ToolContext = createToolExecutionOrchestration({
		dispatch: {
			state: {
				getTurnDispatchCount: () => turnDispatchCount, setTurnDispatchCount: value => { turnDispatchCount = value; },
				getTurnResearchCount: () => turnResearchCount, setTurnResearchCount: value => { turnResearchCount = value; },
				getTaskDispatchCount: () => taskDispatchCount, setTaskDispatchCount: value => { taskDispatchCount = value; },
				getTaskResearchCount: () => taskResearchCount, setTaskResearchCount: value => { taskResearchCount = value; },
				getTaskReviewRounds: () => taskReviewRounds, setTaskReviewRounds: value => { taskReviewRounds = value; },
				getTaskTier: () => taskTier, getTurnReport: () => turnReport, getSessionTotals: () => sessionTotals,
				getTurnDispatchFingerprints: () => turnDispatchFingerprints,
				getExternalBlockers: () => externalBlockers,
				getExternalBlockerAcknowledged: () => externalBlockerAcknowledged, setExternalBlockerAcknowledged: value => { externalBlockerAcknowledged = value; },
				getExternalBlockerRefusedOnce: () => externalBlockerRefusedOnce, setExternalBlockerRefusedOnce: value => { externalBlockerRefusedOnce = value; },
				isAskUserAvailable: () => askUserAvailable, getUserLanguage: () => userLanguage, getSessionDir: () => sessionDir,
				getAgentStates: () => agentStates as any, getResearchPersonas: () => researchPersonas,
				getActiveWritableDispatches: () => activeWritableDispatches, setActiveWritableDispatches: value => { activeWritableDispatches = value; },
				getWritableOverlapCounter: () => writableOverlapCounter, setWritableOverlapCounter: value => { writableOverlapCounter = value; },
			},
			budget: budgetCtx, artifacts: assertionsArtifactsCtx, research: researchRuntime,
			provisionalCapabilityRefusal, dispatchAgent, runReturnExtraction,
			extractNeedsResearch, extractAskUserQuestions, contextPressure: percent => percent >= CONTEXT_WARN_THRESHOLD, displayName, updateResearchWidget,
		},
		actions: {
			budget: budgetCtx, artifacts: assertionsArtifactsCtx, hubState: hubStateCtx,
			provisionalCapabilityRefusal,
			getTaskTier: () => taskTier, setTaskTier: value => { taskTier = value; },
			getTaskTierAssumed: () => taskTierAssumed, setTaskTierAssumed: value => { taskTierAssumed = value; },
			getTaskDispatchCount: () => taskDispatchCount, getTaskResearchCount: () => taskResearchCount,
			getTurnReport: () => turnReport, getAssertions: () => assertions, setAssertions: value => { assertions = value; },
			getAgentStates: () => agentStates, rosterAdd, rosterDrop,
			getIdentity: () => identity, getComs: () => coms, resolveTarget,
			appendMachineHandoffSections, markPeerAddressed,
		},
		herdr: {
			provisionalCapabilityRefusal, isFleetReady: () => herdrFleetReady, isComsReady: () => comsReady,
			getIdentity: () => identity, getCurrentContext: () => currentCtx, peersInScope,
			getComsPeerNames: () => peersInScope().map(peer => peer.name), herdr: herdrApi,
			readEnvFile: file => fs.readFileSync(file, "utf-8"), envFileExists: file => fs.existsSync(file),
			getLastPiSpawnAt: () => lastHubPiSpawnAt, setLastPiSpawnAt: value => { lastHubPiSpawnAt = value; },
			recordSpawnedPeer: (name, paneId) => { hubSpawnedPeers.set(name.toLowerCase(), { name, paneId, addressed: false }); },
		},
	});

	// Keep the extracted tool surface flat and greppable in this composition root.
	registerDispatchAgent(pi, toolCtx);
	registerSpawnResearch(pi, toolCtx);
	registerSetTaskTier(pi, toolCtx);
	registerTeamAdjust(pi, toolCtx);
	registerVerificationContract(pi, toolCtx);
	registerComsTools(pi, toolCtx);
	registerFleetTools(pi, toolCtx);

	const researchControls = createResearchControls({
		runtime: researchRuntime,
		refresh: updateResearchWidget,
		getAgents: () => agentStates, displayName, modelWorkBlocked: modelWorkBlockedByRosterRecovery,
		cancelWait: (state, kind) => cancelLocalWaitOnly({ abort: state.comsAbort, monitorBridge, monitorKey: monitorKeyForAgent(state.def.name, state.runCount), event: { kind } }),
		cancelOwned: state => cancelLocalOwnedProcess({ process: state.proc, monitorBridge, monitorKey: monitorKeyForAgent(state.def.name, state.runCount), treeKill: killPiTree }),
		restartSpecialist: async (state: AgentState, ctx) => {
			if (state.status === "running" && (state.proc || state.comsAbort)) {
				let resolveTermination!: () => void;
				const terminated = new Promise<void>(resolve => { resolveTermination = resolve; });
				state.onTerminate = resolveTermination;
				if (state.proc) { state.killedByOperator = true; state.restarting = true; killPiTree(state.proc); }
				else await cancelLocalWaitOnly({ abort: state.comsAbort, monitorBridge, monitorKey: monitorKeyForAgent(state.def.name, state.runCount), event: { kind: "restart" } });
				await terminated;
			}
			state.sessionFile = null;
			const result = await dispatchAgent(state.def.name, state.task, ctx);
			pi.sendMessage({ customType: "agent-restart-result", content: `[${displayName(state.def.name)}] restarted by operator and ${result.exitCode === 0 ? "completed" : "failed"} in ${Math.round(result.elapsed / 1000)}s.`, display: true }, { deliverAs: "followUp", triggerTurn: true });
		},
	});

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
			workModePolicy.clearRosterRecovery();
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
		handleAgentsKill: async (args, ctx) => { widgetCtx = ctx; await researchControls.handleKill(args, ctx); },
		handleAgentsRestart: async (args, ctx) => { widgetCtx = ctx; await researchControls.handleRestart(args, ctx); },
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
					modelPolicy.setSubagentOverride(personaName, roleKey, undefined);
				} else {
					modelPolicy.setSubagentOverride(personaName, roleKey, picked);
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
				modelPolicy.setPersonaOverride(name, undefined);
			} else {
				modelPolicy.setPersonaOverride(name, picked);
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
				modelPolicy.setThinkingOverride(name, undefined);
			} else {
				modelPolicy.setThinkingOverride(name, picked);
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
			const applied = modelPolicy.applyProfile(profile)
				.map(persona => `${displayName(persona)} → ${shortModel(profile[persona])}`);
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
			hubStateCtx.setPendingHandoff({ target: peer.name, token: handoffToken });
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
		handlePoll: async (args, ctx) => {
			if (modelWorkBlockedByRosterRecovery(ctx)) return;
			const cwd = ctx.cwd || process.cwd();
			const result = await handleAfPoll({
				args: args ?? "",
				cwd,
				pollPanelOverride: parseAgentTeamOverrides(cwd).pollPanel,
				listPanels: async dir => {
					const { listPanelNames } = await import("../../../scripts/workflows/lib/voices.ts");
					return listPanelNames(dir);
				},
				preflight: async ({ panel, persona, cwd: root }) => {
					const [{ resolvePersona }, { resolvePanel }, { checkChildVisibility }] = await Promise.all([
						import("../../../scripts/workflows/lib/personas.ts"),
						import("../../../scripts/workflows/lib/voices.ts"),
						import("../../../scripts/workflows/lib/model-visibility.ts"),
					]);
					try { resolvePersona(persona, root); }
					catch (error) { return error instanceof Error ? error.message : String(error); }
					let voices;
					try { voices = resolvePanel(panel, root); }
					catch (error) { return error instanceof Error ? error.message : String(error); }
					const report = checkChildVisibility(voices.map(voice => voice.model));
					if (report.diagnostic) return `could not verify clean-room model visibility (${report.diagnostic})`;
					const hidden = report.models.filter(model => !model.ok);
					if (hidden.length) {
						return `panel "${panel}" has models not visible to a clean-room child: ${hidden.map(model => model.reasons[0] ?? model.model).join("; ")}`;
					}
					return null;
				},
				checkBudget: () => {
					ensureTaskTier();
					const turnRefusal = checkTurnBudget("dispatch", { dispatches: turnDispatchCount, research: turnResearchCount }, currentBudget(), turnBudgetActiveElapsedMs(), taskTier);
					return turnRefusal ? budgetContinuationInstruction(turnRefusal.message, "turn", userLanguage) : null;
				},
				chargeBudget: () => {
					turnDispatchCount += 1;
					taskDispatchCount += 1;
					sessionTotals.dispatches += 1;
					updateModeStatus();
				},
				onAccepted: async ({ panel, persona, question }) => {
					let voices: { name: string; model: string }[] = [];
					try {
						const { resolvePanel } = await import("../../../scripts/workflows/lib/voices.ts");
						voices = resolvePanel(panel, cwd).map(voice => ({ name: voice.name, model: voice.model }));
					} catch { /* names are decorative */ }
					const started = formatAfPollStarted({ panel, persona, question, voices });
					ctx.ui.setStatus("hub-poll", `Poll: ${panel} (${voices.length || "?"} voices) running…`);
					ctx.ui.notify(`Poll started — panel ${panel}. This can take a minute.`, "info");
					pi.sendMessage({ customType: "af-poll-started", content: started, display: true }, { deliverAs: "followUp", triggerTurn: false });
				},
				execute: async ({ panel, persona, question }) => {
					const [{ Run }, { runPoll }, { runMerge }, { resolvePersona }] = await Promise.all([
						import("../../../scripts/workflows/lib/run.ts"),
						import("../../../scripts/workflows/lib/poll.ts"),
						import("../../../scripts/workflows/lib/merge.ts"),
						import("../../../scripts/workflows/lib/personas.ts"),
					]);
					const run = new Run({ cwd, command: ["/af-poll", "--panel", panel, question] });
					const personaDef = resolvePersona(persona, cwd);
					const poll = await runPoll({
						run, cwd, persona: personaDef, panel, task: question,
						onVoice: result => {
							const voice = result.ok
								? { name: result.voice.name, model: result.voice.model, ok: true as const, position: result.report.position, confidence: result.report.confidence }
								: { name: result.voice.name, model: result.voice.model, ok: false as const, reason: result.reason };
							pi.sendMessage({ customType: "af-poll-voice", content: formatAfPollVoiceProgress(voice), display: true }, { deliverAs: "followUp", triggerTurn: false });
						},
					});
					ctx.ui.setStatus("hub-poll", `Poll: ${panel} merging…`);
					const merge = await runMerge({ run, cwd, persona: personaDef, panel, task: question, opinions: poll.results });
					const directory = path.relative(cwd, poll.directory) || poll.directory;
					return {
						panel,
						directory: directory.endsWith(path.sep) ? directory : `${directory}${path.sep}`,
						voices: poll.results.map(item => item.ok
							? { name: item.voice.name, model: item.voice.model, ok: true as const, position: item.report.position, confidence: item.report.confidence }
							: { name: item.voice.name, model: item.voice.model, ok: false as const, reason: item.reason }),
						recommendation: merge.report.recommendation,
						integrator: merge.integrator.name,
					};
				},
			});
			ctx.ui.setStatus("hub-poll", "");
			if (!result.ok) {
				ctx.ui.notify(result.message, "error");
				pi.sendMessage({ customType: "af-poll-failed", content: `POLL FAILED\n\n${result.message}`, display: true }, { deliverAs: "followUp", triggerTurn: false });
				return;
			}
			ctx.ui.notify(result.digest ?? result.message, "info");
			pi.sendMessage({
				customType: "af-poll",
				content: result.dispatcherNote ?? result.message,
				display: true,
			}, { deliverAs: "followUp", triggerTurn: true });
		},
		getAgentsKillCompletions: prefix => completions.agentsKill(prefix),
		getZoomCompletions: prefix => completions.zoom(prefix),
		getAgentModelCompletions: prefix => completions.agentModels(prefix),
		getAgentModelThinkingCompletions: prefix => completions.agentThinking(prefix),
		getModelProfileCompletions: prefix => completions.modelProfiles(prefix),
		getSubstituteCompletions: prefix => completions.substitutions(prefix),
		getComsPeerCompletions: prefix => completions.comsPeers(prefix),
		getSubagentTargetCompletions: prefix => completions.subagentTargets(prefix),
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
	registerPoll(pi, commandCtx);

	const detailPanel = createDetailPanel<AgentDef, AgentState, ResearchState>({
		getAgent: key => agentStates.get(key),
		getResearch: id => researchStates.get(id),
		parseResearchHandle,
		findDelegationChild,
		modelPolicy,
		displayName,
		shortModel,
		refreshUi: updateWidget,
		getDispatchPreference: name => dispatchPolicy.substitutions[name.toLowerCase()]?.prefer ?? dispatchPolicy.default,
		maxLiveEntryChars: MAX_LIVE_ENTRY_CHARS,
	});
	const { openFleetDetail, loadAvailableModelChoices } = detailPanel;
	const applySessionModelSubstitution = (source: string, target: string, ctx: any) => modelPolicy.applySessionSubstitution(source, target, {
		loadAvailable: current => loadAvailableModelChoices(ctx, current),
		notify: (message, level) => ctx.ui.notify(message, level),
	});

	let fleetShowFinished = false;
	let fleetFilter = "";
	const fleetDashboard = createFleetDashboard<AgentDef, AgentState, ResearchState>({
		getAgents: () => agentStates,
		getResearch: () => researchStates,
		getShowFinished: () => fleetShowFinished,
		setShowFinished: value => { fleetShowFinished = value; },
		getFilter: () => fleetFilter,
		setFilter: value => { fleetFilter = value; },
		getPeerInputs: fleetPeerInputs,
		parseResearchHandle,
		displayName,
		shortModel,
		thinkingSuffix,
		modelWithThinking,
		resolvedThinking,
		abbreviatePeerModel: abbreviateModel,
		modelPolicy,
		loadAvailableModels: loadAvailableModelChoices,
		openDetail: openFleetDetail,
		modelWorkBlocked: modelWorkBlockedByRosterRecovery,
		restartResearch: researchControls.restart,
		restartSpecialist: researchControls.restartSpecialist,
		removeResearch: researchControls.remove,
		killSpecialistProcess: state => cancelLocalOwnedProcess({ process: state.proc, monitorBridge, monitorKey: monitorKeyForAgent(state.def.name, state.runCount), treeKill: killPiTree }),
		abortComs: state => { state.comsAbort?.(); },
	});
	const { fleetRows, openFleetDashboard } = fleetDashboard;

	const contextBudgetUi = createContextBudgetUi<AgentDef, AgentState, ResearchState>({
		getAgents: () => agentStates,
		getResearch: () => researchStates,
		getAllDefs: () => allAgentDefs,
		getResearchPersonas: () => researchPersonas,
		getPeers: () => peerCards.values(),
		modelPolicy,
		displayName,
		getProjectDocsPaths: () => projectDocsPaths,
		getUserLanguage: () => userLanguage,
		getDelegateExtensionPath: () => delegateExtPath,
		safeAgentKey,
		projectPolicyPaths: specialistProjectPolicyPaths,
		modelWindowLookup,
		getResearchTools: () => RESEARCH_TOOLS,
		getPromptLedger: () => lastHubLedger,
		getPressureState: () => contextPressureState,
		buildHubSystemPrompt: () => { buildHubSystemPrompt(); },
		getAllTools: () => typeof pi.getAllTools === "function" ? pi.getAllTools() : [],
		getActiveTools: () => typeof pi.getActiveTools === "function" ? pi.getActiveTools() : [],
		getCommands: () => typeof pi.getCommands === "function" ? pi.getCommands() : [],
	});
	const { openContextBudget } = contextBudgetUi;

	// A delegate child anywhere in the team, by its id (e.g. "quality-1").
	function findDelegationChild(arg: string): { child: DelegationChild; owner: AgentState } | null {
		const lower = arg.toLowerCase();
		for (const state of agentStates.values()) {
			const child = Array.from(state.delegations?.values() ?? []).find(candidate => candidate.id.toLowerCase() === lower);
			if (child) return { child, owner: state };
		}
		return null;
	}

	const completions = createCompletionPresentation({
		getAgents: () => agentStates.values(), getResearch: () => researchStates.values(),
		getResearchPersonas: () => researchPersonas, getModelProfiles: () => modelProfiles,
		getPeers: peersInScope, displayName, shortModel, resolvedModel, resolvedThinking,
		resolveThinkingLevel, resolvedSubagentModel,
		getSubagentOverride: (persona, role) => modelPolicy.getSubagentOverride(persona, role),
		getSubstitutionSources: () => modelPolicy.allKnownModels().map(spec => {
			const target = modelPolicy.getSubstitution(spec);
			return { spec, label: target ? `${spec} → ${target} (active this session)` : spec };
		}),
	});

	registerInputShortcuts(pi, {
		setWidgetContext: ctx => { widgetCtx = ctx; }, openFleetDashboard,
		workModeStatusText, openWorkModePicker,
		isCompact: () => compactWidgetsEnabled(viewMode),
		toggleCompact: () => { viewMode = viewMode === "compact" ? "off" : "compact"; return viewMode; },
		refreshWidgets: () => { updateWidget(); updateResearchWidget(); },
		getSwitchableKeys: () => switchableAgents().map(agent => agent.key),
		getMarkedAgent: () => markedAgent, setMarkedAgent: key => { markedAgent = key; }, clampMarker,
		openMarkedAgent: async (ctx, key) => {
			const rid = parseResearchHandle(key);
			const target: Zoomable | undefined = rid != null ? researchStates.get(rid) : agentStates.get(key);
			if (!target) return false;
			const row = fleetRows(true).find(candidate => candidate.key === key);
			if (row) await openFleetDetail(row, ctx); else await openZoom(target, ctx);
			return true;
		},
	});

	// Root owns subscription order; lifecycle modules own handler bodies.
	pi.on("before_agent_start", async () => turnHandlers.beforeAgentPresence());
	pi.on("agent_end", async () => turnHandlers.agentEndPresence());

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
	pi.on("tool_execution_start", async event => turnHandlers.toolStart(event));
	observeAskUserResults(({ params, result, phase }) => {
		const pack = capabilityConfirmationPack(params.context);
		if (!pack) return;
		if (phase === "start") workModePolicy.setCapabilityConfirmation(pack, "pending");
		else {
			const outcome = confirmationOutcome(result);
			if (!outcome) return;
			workModePolicy.setCapabilityConfirmation(pack, outcome);
			resolveIncomingCapabilities("");
			applyWorkModeTools();
		}
	});

	pi.on("tool_execution_end", async event => turnHandlers.toolEnd(event));

	// ── System Prompt Override ───────────────────


	const hubPromptCtx: HubPromptContext = {
		getCapabilityResolution,
		getActiveTools: () => pi.getActiveTools(),
		getAgents: () => Array.from(agentStates.values()).map(state => ({
			name: state.def.name,
			displayName: displayName(state.def.name),
			description: state.def.description,
			tools: state.def.tools,
		})),
		getResearchPersonas: () => researchPersonas.map(def => ({
			name: def.name,
			displayName: displayName(def.name),
			description: def.description,
			model: resolvedModel(def),
			thinking: resolveThinkingLevel(resolvedThinking(def)),
		})),
		getPromptState: () => ({
			taskTier: taskTier ?? DEFAULT_TASK_TIER,
			taskTierAssumed,
			turnDispatchCount,
			turnResearchCount,
			taskDispatchCount,
			taskResearchCount,
			taskReviewRounds,
			turnBudget: currentBudget(),
			taskBudget: currentTaskBudget(),
			provisionalConfirmations: getCapabilityResolution().provisional
				.filter(pack => workModePolicy.getCapabilityConfirmation()[pack as ConfirmableCapabilityPack] !== "declined")
				.map(pack => ({
					pack,
					reason: getCapabilityResolution().reasons[pack],
					question: capabilityConfirmationQuestion(pack as ConfirmableCapabilityPack),
				})),
		}),
		getWorkMode,
		getActiveTeamName: () => activeTeamName,
		getUserLanguage: () => userLanguage,
		isAskUserAvailable: () => askUserAvailable,
		isComsReady: () => comsReady,
		getIdentity: () => identity,
		isHerdrFleetReady: () => herdrFleetReady,
	};

	// This is also called by /af-context before the first turn. Keep prompt assembly
	// in this one production path so its ledger describes the exact next replacement.
	function buildHubSystemPrompt(): { systemPrompt: string } {
		const built = assembleHubPrompt(hubPromptCtx);
		lastHubLedger = built.ledger;
		return { systemPrompt: built.systemPrompt };
	}

	const turnHandlers = createTurnLifecycleHandlers({
		setTurnState: state => coms.setTurnState(state),
		finishMonitorTurn: () => { if (monitorBridge && monitorTurnId) { monitorBridge.finishParent(monitorTurnId, "completed"); monitorTurnId = null; } },
		startMonitorTurn: () => { if (monitorBridge && monitorHubId) { monitorTurnId = `hub-turn-${monitorHubId}-${crypto.randomUUID()}`; monitorBridge.startParent({ id: monitorTurnId, hubInstanceId: monitorHubId, checkoutId: currentCtx?.cwd || process.cwd() }); } },
		startAskUser: id => executionHistory.startAskUser(id), endAskUser: (id, at) => executionHistory.endAskUser(id, at),
		continuationKind: budgetContinuationKind, getPendingContinuation: () => pendingBudgetContinuation,
		setPendingContinuation: value => { pendingBudgetContinuation = value; },
		getContinuationAsk: id => budgetContinuationAsks.get(id), setContinuationAsk: (id, value) => budgetContinuationAsks.set(id, value), deleteContinuationAsk: id => budgetContinuationAsks.delete(id),
		acknowledgeExternalBlocker: () => { externalBlockerAcknowledged = true; externalBlockerRefusedOnce = false; },
		addAskUserWait: waitMs => { if (waitMs > 0) taskClock = addTaskClockWait(taskClock, waitMs); turnBudgetAskUserWaitMs += waitMs; },
		continuationOutcome: budgetContinuationOutcome, continuationSnapshot: budgetContinuationSnapshot,
		continueBudget: (kind, at) => { if (kind === "task") continueTaskBudgetWindow(at); else renewTurnBudgetWindow(at); },
		appendContinuation: appendBudgetContinuationEntry, getCurrentContext: () => currentCtx, getWidgetContext: () => widgetCtx,
		applyWorkMode: applyWorkModeTools, closeTurnActiveTime, openTaskClock: at => { taskClock = openTaskClock(taskClock, at); }, startHistoryTurn: at => executionHistory.startTurn(at),
		resetTurnBudgetState: () => {
			turnBudgetAskUserWaitMs = 0; budgetContinuationAsks.clear(); if (pendingBudgetContinuation?.kind === "turn") pendingBudgetContinuation = null;
			turnDispatchCount = 0; turnResearchCount = 0; turnDispatchFingerprints.clear(); externalBlockerAcknowledged = true; externalBlockerRefusedOnce = false;
			if (turnReport.dispatches.length > 0 || turnReport.research > 0 || turnReport.refusals > 0) { lastTurnReport = turnReport; sessionTotals.turns++; }
			turnReport = freshTurnReport();
		},
		updateModeStatus, buildPrompt: buildHubSystemPrompt, endHistoryTurn: at => executionHistory.endTurn(at),
		unaddressedPeerWarning: () => unaddressedPeerSweep(Array.from(hubSpawnedPeers.values()))?.message ?? null,
		respondToPeer: ctx => coms.respond(ctx),
	});
	pi.on("before_agent_start", async () => turnHandlers.beforeAgentStart());

	const pressureLifecycle = createContextPressureLifecycle({
		getState: () => pressureRootState,
		setPressure: value => { contextPressureState = value; pressureRootState.pressure = value; },
		getCurrentContext: () => currentCtx,
		appendEntry: (type, data) => pi.appendEntry(type, data),
		sendUserMessage: (content, options) => pi.sendUserMessage(content as any, options),
		resolveCapabilities: resolveIncomingCapabilities, applyWorkMode: applyWorkModeTools,
		modelWorkBlocked: modelWorkBlockedByRosterRecovery,
	});
	function replayDeferredRecoveryInputs(): void { pressureLifecycle.replayDeferred(); }
	pi.on("message_end", async (event, ctx) => pressureLifecycle.messageEnd(event, ctx));
	pi.on("turn_end", async (_event, ctx) => pressureLifecycle.turnEnd(ctx));
	pi.on("context", async (_event, ctx) => pressureLifecycle.context(ctx));
	pi.on("agent_settled", async (_event, ctx) => pressureLifecycle.agentSettled(ctx));
	pi.on("session_compact", async () => pressureLifecycle.sessionCompact());
	pi.on("input", async (event, ctx) => pressureLifecycle.input(event, ctx));

	// ── Session Start ────────────────────────────

	let sessionOverrides: ReturnType<typeof parseAgentTeamOverrides> | undefined;
	let sessionSoloMode = false;
	const monitorSession = createMonitorSession({
		pi,
		getBridge: () => monitorBridge, setBridge: value => { monitorBridge = value; },
		getLifecycle: () => monitorLifecycle, setLifecycle: value => { monitorLifecycle = value; },
		setHubId: value => { monitorHubId = value; },
		getOwnerId: () => monitorOwnerId, setOwnerId: value => { monitorOwnerId = value; },
		queueDepth: () => inboundQueue.size,
	});
	registerSessionOrchestration(pi, {
		resetSession: (_ctx) => resetHubSession(_ctx, {
			registerVersion: registerVersionStatus, resetPressure: pressureLifecycle.reset,
			clearRosterRecovery: workModePolicy.clearRosterRecovery, captureBaselineTools: () => { baselineTools = pi.getActiveTools(); },
			resetAccessApproval: accessApprovalRouter.reset,
			terminateResearch: () => { for (const st of researchStates.values()) if (st.proc && st.status === "running") { st.killedByOperator = true; st.proc.kill("SIGTERM"); } },
			resetResearch: researchRuntime.reset, resetHistory: executionHistory.reset,
			resetBudgets: () => { taskClock = createTaskClock(); turnBudgetAskUserWaitMs = 0; turnContinuationCount = 0; taskContinuationCount = 0; pendingBudgetContinuation = null; budgetContinuationAsks.clear(); },
			clearWidgets: ctx => { if (widgetCtx) { ctx.ui.setWidget("agent-team", undefined); ctx.ui.setWidget("agent-research", undefined); } },
			closeDelegationWatchers: () => { for (const st of agentStates.values()) { st.delegationsWatcher?.close(); st.delegationsWatcher = undefined; } },
			resetSessionState: ctx => { delegatedTokens = 0; hubSpawnedPeers.clear(); widgetCtx = ctx; contextWindow = ctx.model?.contextWindow || 0; },
			resolveSafety: cwd => Boolean(safetyHarnessPath = resolveSafetyHarness(cwd)), resolveDelegate: cwd => { delegateExtPath = resolveDelegateExtension(cwd); },
		}),
		restartMonitor: _ctx => monitorSession.restart(_ctx),
		initializeComs: async (_ctx) => {
			// ── Embedded coms init ──
			// Always refresh the ctx the coms handlers use. Bind the endpoint + register
			// in the pool exactly once per process (guard on comsReady), so a /new session
			// keeps the same peer identity rather than leaking a second socket. On any
			// failure we degrade: comsReady stays false and the coms_* tools are withheld.
			hubStateCtx.setCurrentContext(_ctx);
			sessionSoloMode = pi.getFlag("solo") === true;
			if (!comsReady && !sessionSoloMode) {
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
		},
		initializeExemptions: (_ctx) => {
			// ── Damage-control shared exemptions file ──
			// One per hub session (solo mode included). Exporting the path on our own
			// process.env lets the co-loaded damage-control-continue mirror /af-allow
			// session grants into the same file the spawned children read.
			if (!exemptionsFile) {
				hubStateCtx.setExemptionsFile(exemptionsFilePath(identity?.session_id ?? `hub-solo-${process.pid}`));
				process.env[EXEMPTIONS_FILE_ENV] = exemptionsFile!;
			}
		},
		loadAgents: (_ctx) => {
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
			sessionOverrides = parseAgentTeamOverrides(_ctx.cwd);
			runHistoryKeep = sessionOverrides.runHistoryKeep;

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
		},
		applyOverrides: (_ctx) => {
			if (!sessionOverrides) throw new Error("session_start applyOverrides ran before loadAgents");
			applySessionOverrides(_ctx, sessionOverrides, {
				setLanguage: value => { userLanguage = value; }, setResearchRetention: researchRuntime.setRetention,
				setReconTimeout: value => { reconSearchTimeoutMs = value; }, setBudgetOverrides: value => { budgetOverrides = value; },
				setWatchdog: (setting, judge) => { watchdogSetting = setting; watchdogJudgeModel = judge; },
				resetTurnCounts: () => { turnDispatchCount = 0; turnResearchCount = 0; }, resetTaskWindow: () => resetTaskWindow(null), updateModeStatus,
				setProjectRules: value => { projectRulesDirs = value; }, setProjectDocs: value => { projectDocsPaths = value; },
				resetModelPolicy: modelPolicy.reset, getAgentDefs: () => allAgentDefs, getModelProfiles: () => modelProfiles,
				deleteModelProfile: name => { delete modelProfiles[name]; }, allowedModels,
				getDispatchPolicyWarnings: () => dispatchPolicyWarnings, setResearchPersonas: value => { researchPersonas = value; },
			});
		},
		restoreRoster: (_ctx) => {
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
			workModePolicy.setRestoredWorkMode(resolveSessionWorkMode({
				entries: sessionEntries,
				explicitWorkMode,
				hasExplicitRoster: startupRoster.source === "explicit",
			}));
			if (startupRoster.roster) {
				activateTeam(startupRoster.roster.name);
				persistActiveRoster();
			}
			const rosterRecoveryRequired = orchestratorNeedsRoster(getWorkMode(), agentStates.size);
			const rosterRecoveryDiagnostic = rosterRecoveryRequired
				? startupRoster.diagnostic || "Persisted orchestrator work mode has no native roster."
				: "";
			workModePolicy.setRosterRecovery(rosterRecoveryRequired, rosterRecoveryDiagnostic);
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
		},
		resolveCapabilities: async (_ctx) => {
			// Probe for `ask_user` (registered by the `pi-ask-user` companion package
			// when installed). Action methods like getAllTools are runtime-only, so
			// this MUST happen at session_start, not at extension load.
			askUserAvailable = pi.getAllTools().some(t => t.name === "ask_user");

			// Fleet tools are available only inside a herdr pane with a live server.
			// The work mode policy adds gated groups without activating unavailable tools.
			herdrFleetReady = herdrPaneId() !== null && (await herdrAvailable()) !== null;
			const persistedCapabilities = latestPersistedCapabilityState(_ctx.sessionManager.getEntries());
			workModePolicy.restoreCapabilities({ taskPacks: persistedCapabilities?.taskPacks ?? [], provisional: persistedCapabilities?.provisional ?? [], confirmation: persistedCapabilities?.confirmation ?? {} });
			resolveIncomingCapabilities("");
			applyWorkModeTools();
			if (pressureLifecycle.observe(_ctx, "session_start") === "compact-now") {
				setTimeout(() => pressureLifecycle.runCompaction(_ctx, "session_start"), 0);
			}
			workModePolicy.updateStatus(_ctx);
		},
		notifyStartup: (_ctx) => {
			_ctx.ui.setStatus("agent-team", `Native roster: ${activeTeamName || "(none)"} (${agentStates.size})`);
			const members = Array.from(agentStates.values()).map(s => displayName(s.def.name)).join(", ");
			const askUserLabel = askUserAvailable
				? "available (via pi-ask-user)"
				: "NOT AVAILABLE — run `pi install npm:pi-ask-user`";
			const comsLabel = comsReady && identity
				? `📡 ${identity.name}@${identity.project} — peers via coms_list; /af-handoff <peer> to delegate`
				: sessionSoloMode
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
			_ctx.ui.notify(buildSessionStartNotice({
				workMode: getWorkMode(),
				activeTeamName,
				agentCount: agentStates.size,
				members,
				dispatchLabel,
				userLanguage,
				askUserLabel,
				comsLabel,
				fleetLabel,
			}), "info");
		},
		updateWidget: (_ctx) => {
			updateWidget();
		},
		installFooter: (_ctx) => {
			_ctx.ui.setFooter(createSessionFooter({
				ctx: _ctx,
				version: HARNESS_VERSION,
				getModel: () => _ctx.model?.id || "no-model",
				getThinkingLevel: () => pi.getThinkingLevel?.(),
				thinkingSuffix,
				getHint: () => composeFleetFooterHint(viewMode, compactWorkMode(getWorkMode())),
				renderLeft: renderHubFooterLeft,
				truncateToWidth,
				visibleWidth,
			}));
		},
	}, {
		shutdownComs: () => coms.shutdown(), shutdownMonitor: () => monitorSession.shutdown(),
		removeExemptions: () => {
			if (!exemptionsFile) return;
			try { fs.unlinkSync(exemptionsFile); } catch {}
			hubStateCtx.setExemptionsFile(null);
		},
		terminateChildren: () => {
			for (const st of [...agentStates.values(), ...researchStates.values()]) {
				if (st.proc && st.status === "running") try { st.killedByOperator = true; st.proc.kill("SIGTERM"); } catch {}
			}
		},
		clearPoolWidget: () => {
			if (currentCtx?.hasUI) try { currentCtx.ui.setWidget("coms-pool", undefined); } catch {}
		},
	});

	// Ordered end-turn peer response remains after session-start registration.
	pi.on("agent_end", async (_event, ctx) => turnHandlers.agentEnd(ctx));

}
