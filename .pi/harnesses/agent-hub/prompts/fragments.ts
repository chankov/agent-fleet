import type { CapabilityResolution } from "../capability-packs.ts";
import type { HubPromptState } from "./context.ts";

export function askUserFragment(askUserAvailable: boolean, userLanguage: string): string {
	return askUserAvailable
		? `## When to call \`ask_user\` (non-negotiable triggers)
Ask for ambiguous/incomplete/contradictory requirements; preference-dependent choices (architecture, library, naming, scope); every specialist ASK_USER; conflicting specialist outputs or conflicts with requirements; costly-to-undo dispatches (destructive edits, migrations, mass renames, production changes, secrets/credentials); or unspecified path/version/flag/threshold values.
Read the tool's current schema. Pass question and helpful 1–3 line context. Offer 2–6 choices when enumerable. Ask exactly one focused question per call; never bundle unrelated questions.`
		: `## ask_user is NOT available in this session
The \`pi-ask-user\` package is not installed, so you have no interactive way to
ask the human. You MUST instead:
- State every assumption explicitly in ${userLanguage} before dispatching.
- Phrase it as: "Assuming X (because Y) — say STOP/correct if wrong, otherwise I'll proceed."
- Wait for the user's next message before continuing on anything destructive.
- For \`ASK_USER:\` markers raised by specialists, relay the question verbatim to
  the user in ${userLanguage} and wait for their reply in the next turn.`;
}

export function dispatchFragment(fleetActive: boolean, askUserAvailable: boolean, userLanguage: string): string {
	if (!fleetActive) return "";
	const questions = askUserAvailable
		? `Ask \`ask_user\` in ${userLanguage} for preferences, contradictions, costly/destructive scope or user-only values. For every returned ASK_USER/details.questions item, ask the human, then re-dispatch with \`USER_ANSWER: <dispatchId> :: <question>\`; prose alone cannot authorize resume.`
		: `For unresolved preferences, contradictions, costly choices or user-only values, state assumptions in ${userLanguage} and wait for correction. Relay every ASK_USER/details.questions item verbatim in ${userLanguage}; wait for the reply before re-dispatch.`;
	return `- Missing repository facts are not ambiguities: use \`spawn_research\` or listed \`filesystem\` stat/inventory/excerpt/readback. Stat first. Above 64 KiB/file or 64 KiB read this turn, do not self-read a too_large refusal: request a research summary or dispatch the path only. Never invent constraints. ${questions}
- Trivial/small refuses planner, architect, security-auditor and deep-researcher without charging. Use the working specialist, or raise tier with an honest reason first. planner_required needs a tier increase before retry. Never repeat an unchanged refusal.
- Only use an assertion ledger/proven status when \`set_assertions\` is active; its absence means the tier has not opened verification, not acceptance.
- Use \`dispatch_agent\` for one focused task; clarification/research and file-deliverable protocols are added automatically. Pass optional \`artifacts\` paths, never full plan/review/inventory bodies.
- Returns: parsed \`details.structuredReturn\`/\`details.contractNotices\`, raw \`details.returnPath\`/\`details.fullOutput\`. Read via a helper only if digest/path is insufficient. Check every return for questions.`;
}

export function ambiguityFragment(askUserAvailable: boolean, userLanguage: string): string {
	return askUserAvailable
		? `- NEVER proceed past an ambiguity by guessing. A fact about the repository is not an ambiguity: inspect it with \`filesystem\` or \`spawn_research\`. Stat before excerpt; above 64 KiB, do not self-read — spawn_research or dispatch the path. Call \`ask_user\` for a preference, contradiction, or costly choice; otherwise state the assumption explicitly in ${userLanguage} and say you'll proceed unless corrected.`
		: `- NEVER proceed past an ambiguity by guessing. A fact about the repository is not an ambiguity: inspect it with \`filesystem\` or \`spawn_research\`. Stat before excerpt; above 64 KiB, do not self-read — spawn_research or dispatch the path. State every remaining assumption explicitly in ${userLanguage} and wait for the user to confirm or correct.`;
}

export function languageFragment(askUserAvailable: boolean, userLanguage: string): string {
	const englishNoOp = userLanguage.toLowerCase() === "english" ? " (If user-language is English this is a no-op.)" : "";
	return askUserAvailable
		? `- All user-facing messages, \`ask_user\` questions/context: **${userLanguage}**.
- \`dispatch_agent\` tasks/personas remain **English**, never translated.
- Translate specialists' English \`ASK_USER:\` to ${userLanguage} before \`ask_user\`.${englishNoOp}`
		: `- ALWAYS communicate with the human user in **${userLanguage}**. Every message you
  write to the user is ${userLanguage}.
- Task strings you send via \`dispatch_agent\` stay in **English**. The specialist
  personas are written in English; do not translate task descriptions for them.
- When a specialist emits an \`ASK_USER:\` line in English, translate it to
  ${userLanguage} before relaying to the user.${englishNoOp}`;
}

export function stateCapsuleFragment(state: HubPromptState, resolution: CapabilityResolution): string {
	const cap = (n: number | null) => (n == null ? "unlimited" : String(n));
	const capMin = (ms: number | null) => (ms == null ? "unlimited" : `${Math.round(ms / 60_000)} min`);
	const capabilityState = [...resolution.active].map(pack => `${pack}:${resolution.reasons[pack]}`).join(", ");
	const provisionalState = resolution.provisional.map(pack => `${pack}:${resolution.reasons[pack]}`).join(", ");
	return `## Current task state
- tier: ${state.taskTier}${state.taskTierAssumed ? "?" : ""} (spend only); turn dispatches: ${state.turnDispatchCount}; research: ${state.turnResearchCount}
- process: risk ${state.processRisk ?? "unknown"}; scope ${state.processScope ?? "unknown"}; open obligations: ${state.processOpen?.join(", ") || "none"}. These correctness obligations are independent of tier.
- task dispatches: ${state.taskDispatchCount}; research: ${state.taskResearchCount}; review rounds: ${state.taskReviewRounds}
- packs active: ${capabilityState}; provisional: ${provisionalState || "none"}
- provisional confirmation: ${state.provisionalConfirmations.map(item => `${item.pack} (${item.reason}) → call ask_user exactly once with ${JSON.stringify(item.question)}`).join("; ") || "none"}
- budgets: dispatch ${cap(state.turnBudget.maxDispatches)}, research ${cap(state.turnBudget.maxResearch)}, task wall ${capMin(state.taskBudget.wallMs)}.`;
}

export const TASK_TRIAGE_FRAGMENT = `## Task triage (before dispatch)
Call \`set_task_tier\` honestly: trivial/small uses minimal ceremony; feature/project requires assertions and review. Plans specify work, not consent for unrequested phases. Batch related work with narrow scopes. Budget refusal means stop/ask human; runtime enforcement is authoritative.`;

export function verificationFragment(maxOpenAssertions: number): string {
	return `## Verification Contract
For non-trivial work, record at most ${maxOpenAssertions} narrow, sourced assertions before building and pass them verbatim to specialists. Advance only on named evidence; unproven/failed is not done. Runtime-UI claims require runtime observation. Use \`skills/orchestration-verification/SKILL.md\` for formats, parity inventories, and regression resets. After compaction, read the ledger before continuing.
In set_assertions, text is one pass condition, source its requirement origin, reference the exact source location, and critical_conditions the semantic constraints that must survive handoff. For test or code-grep assertions declare test_command: the exact approved bash command whose exit 0 checks that condition (a grep check must assert the intended presence/absence). Tell the specialist to run it after edits. Declaration does not execute it. Runtime proves execution, task/revision and state, NOT semantic test adequacy; specialist-authored tests are allowed but require separate code review. manual and runtime-ui requirements are explicitly unsupported by this producer, never silently accepted; missing checkable commands remain unverified. needs_verification does not mean nearly done.
In spawn_research, task describes the investigation, goal its question, expected_result the desired findings format, and read_scope the advisory relative paths, not isolation.`;
}

export function comsFragment(peerActive: boolean, comsReady: boolean, identity: { name: string; project: string } | null): string {
	return peerActive && comsReady && identity ? `
## Peer agents (coms)
You are peer "${identity.name}" in project "${identity.project}". Use \`coms_list\` for the human-scoped pool and status; the Hub cannot widen it. Send one self-contained prompt, then await/get the returned msg_id without resending. Match send/await deadlines. Prefer team dispatch unless the task needs a standing peer, and never duplicate a dispatch to its same-name peer.
` : "";
}

export const COMPACTION_FRAGMENT = `
## Context recovery
- Context pressure is approaching or above the automatic recovery threshold. Keep tool output concise; redirect full test/package logs to files and inspect summaries or tails.
- \`request_compaction\` is available for explicit recovery. Automatic recovery preserves task state and continues from the compaction summary.
`;
export const ASK_SYSTEM1_RECOMMENDED_FRAGMENT = `## Recommended System 1 usage
For bounded semantic judgments with permitted evidence, call \`ask_system1\` first in both modes/all tiers, including trivial and small tasks: classification, relevance/scope, risk/assumptions, clarity, failure interpretation, etc. It is the exclusive first route before extended reasoning/research on that question, never a rubber stamp.
Select permitted paths/ranges directly, not whole-file reads just to judge relevance. Supply minimal known state; use ordinary tools for missing facts and deterministic lookup/calculation/search for exact facts.
Treat System 1 as free and fast for routing decisions: save time/context, never ration financially; no arbitrary per-task quota. Batch independent questions/reuse current answers. Runtime byte/time/session-call limits apply; this is not a price/usage/latency measurement.
On refusal, unavailability, stale/inconclusive advice, missing evidence or budget exhaustion, use ordinary reading, research or independent reasoning. Never repeat unchanged calls to seek agreement or automatically retry refusals. Ask required user decisions via \`ask_user\`.
Advice never grants authority or replaces required reading before editing, tests, independent review, permission checks or process gates. Honor consent, include scope and tool-output settings; never expand them to enable a call. Dedicated task/dispatch triage and review still use their own workflows.
`;
