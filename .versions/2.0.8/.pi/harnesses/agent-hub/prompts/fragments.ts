import type { CapabilityResolution } from "../capability-packs.ts";
import type { HubPromptState } from "./context.ts";

export function askUserFragment(askUserAvailable: boolean, userLanguage: string): string {
	return askUserAvailable
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
}

export function dispatchFragment(fleetActive: boolean, askUserAvailable: boolean, userLanguage: string): string {
	if (!fleetActive) return "";
	return askUserAvailable
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
}

export function ambiguityFragment(askUserAvailable: boolean, userLanguage: string): string {
	return askUserAvailable
		? `- NEVER proceed past an ambiguity by guessing. Either call \`ask_user\`, or state
  the assumption explicitly in ${userLanguage} and say you'll proceed unless corrected.`
		: `- NEVER proceed past an ambiguity by guessing. State the assumption explicitly
  in ${userLanguage} and wait for the user to confirm or correct.`;
}

export function languageFragment(askUserAvailable: boolean, userLanguage: string): string {
	const englishNoOp = userLanguage.toLowerCase() === "english" ? " (If user-language is English this is a no-op.)" : "";
	return askUserAvailable
		? `- ALWAYS communicate with the human user in **${userLanguage}**. Every message you
  write to the user, every \`ask_user\` question and \`context\` field — ${userLanguage}.
- Task strings you send via \`dispatch_agent\` stay in **English**. The specialist
  personas are written in English; do not translate task descriptions for them.
- When a specialist emits an \`ASK_USER:\` line in English, translate it to
  ${userLanguage} before passing it through \`ask_user\`.${englishNoOp}`
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
- tier: ${state.taskTier}${state.taskTierAssumed ? "?" : ""}; turn dispatches: ${state.turnDispatchCount}; research: ${state.turnResearchCount}
- task dispatches: ${state.taskDispatchCount}; research: ${state.taskResearchCount}; review rounds: ${state.taskReviewRounds}
- packs active: ${capabilityState}; provisional: ${provisionalState || "none"}
- provisional confirmation: ${state.provisionalConfirmations.map(item => `${item.pack} (${item.reason}) → call ask_user exactly once with ${JSON.stringify(item.question)}`).join("; ") || "none"}
- budgets: dispatch ${cap(state.turnBudget.maxDispatches)}, research ${cap(state.turnBudget.maxResearch)}, task wall ${capMin(state.taskBudget.wallMs)}.`;
}

export const TASK_TRIAGE_FRAGMENT = `## Task triage (before dispatch)
Call \`set_task_tier\` honestly: trivial/small work uses minimal ceremony; feature/project work uses the assertion ledger and a review gate. A provided plan is the specification, not consent to execute unrequested phases. Keep related plan work in coherent batches, pass a narrow scope, and treat a budget refusal as a stop-and-ask-human signal; code enforcement remains authoritative.`;

export function verificationFragment(maxOpenAssertions: number): string {
	return `## Verification Contract
For non-trivial work, record at most ${maxOpenAssertions} narrow, sourced assertions before building and pass them verbatim to specialists. Advance only on named evidence; unproven/failed is not done. Runtime-UI claims require runtime observation. Use \`skills/orchestration-verification/SKILL.md\` for formats, parity inventories, and regression resets. After compaction, read the ledger before continuing.`;
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
