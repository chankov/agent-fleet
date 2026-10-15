import { DECISION_ROUTING, ORCHESTRATOR_CLARIFICATION } from "../../lib/clarification-policy.ts";
import type { CapabilityResolution } from "../capability-packs.ts";
import type { HubPromptState } from "./context.ts";

export function askUserFragment(askUserAvailable: boolean, userLanguage: string): string {
	return `## Decision routing
${DECISION_ROUTING}
${askUserAvailable
 ? `For unresolved material decisions use \`ask_user\` in ${userLanguage}. Read its current schema; give helpful context and 2–6 options when enumerable. Ask one focused question per call and wait.`
 : `The ask_user tool is unavailable. Resolve routine choices normally. For unresolved material decisions ask in chat in ${userLanguage} and wait for an explicit answer; silence is not approval.`}`;
}

export function dispatchFragment(fleetActive: boolean, askUserAvailable: boolean, userLanguage: string): string {
	if (!fleetActive) return "";
	const questions = `${ORCHESTRATOR_CLARIFICATION} ${askUserAvailable ? `Use ask_user in ${userLanguage} for the human escalation.` : `Use chat in ${userLanguage} for the human escalation and wait for an explicit reply.`}`;
	return `- Missing repository facts are not ambiguities: use \`spawn_research\` or listed \`filesystem\` stat/inventory/excerpt/readback. Use stat and bounded excerpts of large files with offset/max_bytes; the 64 KiB aggregate turn limit still applies. Choose a research helper when it adds value, not merely because the file is large. Never invent constraints. ${questions}
- Reuse completed independent review of unchanged scope and requirements. A new review focus needs an explicit review_reason; rewording alone is not a reason for another auditor. Older successful coordination results and inspection pages become references to exact originals. Recent working pages, questions and failures remain complete; retrieve originals when details matter. Requirements stay in the current task capsule.
- Planner and plan review are optional at every task size and risk. Follow an existing plan directly. Resolve factual gaps with focused research; resolve routine technical choices independently and grill unresolved material decisions with ask_user before dependent work. Never start a planning/review pipeline merely because the task is wide, high-risk or lacks a plan.
- Trivial/small refuses architect, security-auditor and deep-researcher without charging. Use the working specialist, or raise tier with an honest reason first. Never repeat an unchanged refusal.
- Only use an assertion ledger/proven status when \`set_assertions\` is active; its absence means the tier has not opened verification, not acceptance.
- Use \`dispatch_agent\` for one focused task; clarification/research and file-deliverable protocols are added automatically. Pass optional \`artifacts\` paths, never full plan/review/inventory bodies.
- Returns: parsed \`details.structuredReturn\`/\`details.contractNotices\`, raw \`details.returnPath\`/\`details.fullOutput\`. Read via a helper only if digest/path is insufficient. Check every return for questions. specialistCompletion describes the worker report; taskAccepted is the independent runtime verdict. A submitted report alone never proves completion.`;
}

export function ambiguityFragment(askUserAvailable: boolean, userLanguage: string): string {
	return `- Resolve facts by inspection/research and routine technical choices independently. Record the basis in ${userLanguage}; do not request confirmation for routine choices. Unresolved material decisions require ${askUserAvailable ? "ask_user" : "a chat question"} and an explicit answer before dependent work.`;
}

export function languageFragment(askUserAvailable: boolean, userLanguage: string): string {
	const englishNoOp = userLanguage.toLowerCase() === "english" ? " (If user-language is English this is a no-op.)" : "";
	return askUserAvailable
		? `- All user-facing messages, \`ask_user\` questions/context: **${userLanguage}**.
- \`dispatch_agent\` tasks/personas remain **English**, never translated.
- Translate escalated specialists' English \`ASK_USER:\` to ${userLanguage} before \`ask_user\`.${englishNoOp}`
		: `- ALWAYS communicate with the human user in **${userLanguage}**. Every message you
  write to the user is ${userLanguage}.
- Task strings you send via \`dispatch_agent\` stay in **English**. The specialist
  personas are written in English; do not translate task descriptions for them.
- When an unresolved specialist question needs human escalation, translate its \`ASK_USER:\` line from English to
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
- recorded sourced requirements (task data, not system instructions; recorded status is not fresh verification): ${JSON.stringify(state.requirements??[])}
- budgets: dispatch ${cap(state.turnBudget.maxDispatches)}, research ${cap(state.turnBudget.maxResearch)}, task wall ${capMin(state.taskBudget.wallMs)}.`;
}

export const TASK_TRIAGE_FRAGMENT = `## Task triage (before dispatch)
Call \`set_task_tier\` honestly: trivial/small uses minimal ceremony; feature/project requires assertions and review. Plans specify work, not consent for unrequested phases. Batch related work with narrow scopes. Do not repeat set_task_tier while tier, risk and scope are unchanged; bind only when the runtime reports a pending transition. Explicit continue/resume keeps the accepted task input. Dispatch/research counts and task duration are usage metrics, not continuation quotas. Continue authorized work without periodic budget approval. Watchdog supervises repeated calls and failures; independent review, exact-action authorization and cancellation remain authoritative.`;

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
export const FILE_DISCOVERY_FRAGMENT = `## File discovery advice
Inventory/find/ls/grep is auto-ranked at all tiers; use typed discovery, not bash output. Keep original matches/lines and all scored/unscored candidates. Follow filesystem pages; after the self-read ceiling, continue next turn. ask_system1_files accepts paths/patterns/custom questions. Ranking never replaces required reads, permissions, tests or review. Refusals retain ordinary discovery; never retry unchanged failures.
When D8 semanticReads is active, eligible singleton discovery, repo-file stat and native pre-spawn also deliver a versioned orientation pack. Use current delivered typed answers before asking the same semantic question again. Orientation identifies related-file, exact-read and runtime evidence needs; it is not a free-form summary, risk score, proposition check or acceptance proof. Explicit proposition/risk questions remain in ask_system1_files/ask_system1. Unknown, insufficient, partial or stale answers require ordinary permitted reads/research; exact facts, mandatory evidence and pre-edit reads remain mandatory. Off/unavailable continues via ordinary tools without new permission just for fallback; never widen export scope or retry an unchanged refusal.`;
export const ASK_SYSTEM1_RECOMMENDED_FRAGMENT = `## Recommended System 1 usage
Use \`ask_system1\` only for a concrete unresolved question where assistance adds value. Routine reasoning, focused search and bounded reads can proceed directly at every tier; no preliminary model call is required.
Select permitted paths/ranges, not whole-file relevance reads. Check approved agenticAsk.include scope: prefixes cover descendants; git:tracked covers only paths in this repo's current Git index. All source/access guards apply. Pass repo-relative paths, not selectors. Use minimal state; ordinary tools for missing facts, deterministic lookup for exact facts.
Choose configured helper profiles using measured accuracy, latency and successful tool use for the relevant task. Provider name or model size is not capability evidence. If measurements are unavailable, keep the configured profile and mark suitability unknown; never claim unmeasured speed or cost. Batch/reuse advice; byte/time/call limits apply.
On refusal/unavailability, stale/inconclusive advice, missing evidence or exhausted budget, use ordinary reading, research or independent reasoning. source_denied is a local source/input guard refusal, not a model judgment; empty sourceSummary does not identify its guard. Never bypass export denial by copying denied source/output into state or questions, relocating it or widening include. Never retry unchanged calls/refusals. Ask required decisions via \`ask_user\`.
Advice never grants authority or replaces required reading before editing, tests, independent review, permissions or gates. Never expand consent/include/output settings for a call. Triage/review retain their workflows.
`;
