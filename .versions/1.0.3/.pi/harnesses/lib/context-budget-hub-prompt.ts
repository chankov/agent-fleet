import { component, type ContextBudgetComponent, type ContextCategory } from "./context-budget.ts";

/**
 * Prompt inputs are deliberately split between stable policy and a small volatile
 * state capsule. Callers must not put counters or task state in policy fragments.
 */
export interface HubPromptParts {
	intro: string;
	toolList: string;
	languageLines: string;
	activeTeamName: string;
	teamMembers: string;
	dispatchSection: string;
	userLanguage: string;
	askUserBlock: string;
	modeSection: string;
	verificationSection: string;
	comsSection: string;
	herdrSection: string;
	compactionSection?: string;
	hardRules: string;
	ambiguityRule: string;
	agentCatalog: string;
	researchCatalog: string;
	/** Changes per turn: tier, budgets, active counters, and pending state only. */
	stateCapsule?: string;
	dispatcherPersonaPrompt?: string;
}

export const HUB_HERDR_SECTION = `
## Fleet (herdr)
- Use panes only for auxiliary processes; never bypass specialist delegation.
- Spawn a peer immediately before its first message. It boots idle; \`peer_ready: false\` is a failed start.
- Check \`coms_list\` for peer status; read panes only for unbridged tools or post-mortems.
- \`herdr_close_pane\` requires human confirmation. Close only panes you opened when their work ends.
- \`herdr_notify\` reaches an away human; it never replaces \`ask_user\`.
`;

/** Assemble the effective Hub replacement prompt. Ledger metadata is never interpolated. */
export function assembleHubSystemPrompt(parts: HubPromptParts): string {
	const team = parts.activeTeamName || "(none)";
	const members = parts.teamMembers || "(none — add a persona before using dispatch_agent)";
	const state = parts.stateCapsule ? `\n${parts.stateCapsule}\n` : "";
	const fleet = parts.dispatchSection ? `
## Native Roster: ${team}
Members: ${members}
Dispatch only listed agents. The roster may change through its Fleet commands or \`team_adjust\` when it genuinely cannot serve the task; more personas is usually the wrong answer.

## How to Work
${parts.dispatchSection}
- Choose \`backend: native\` only for an explicitly requested local Pi specialist, \`backend: coms\` only for an explicitly requested live same-name peer, and \`backend: auto\` otherwise. Never substitute an explicit backend.
- Review results, follow up when needed, and summarize for the user in ${parts.userLanguage}.

## Research helpers (read-only)
- \`spawn_research\` is read-only (read/grep/find/ls; no bash or writes). Use it for necessary reconnaissance, not to read a return artifact you already have.
- Choose a light persona for simple reads and a stronger one for ambiguous, cross-cutting, or high-stakes research.
- Specialists cannot spawn helpers; run necessary research and pass its findings or artifact path to the specialist.

## Agents

${parts.agentCatalog}

## Research personas

${parts.researchCatalog}
` : "";
	const verification = parts.verificationSection ? `\n${parts.verificationSection}\n` : "";
	const policy = `${parts.intro} You have ${parts.toolList}.

## Language
${parts.languageLines}${fleet}
${parts.askUserBlock}

${parts.modeSection}${state}${verification}
${parts.comsSection}${parts.herdrSection}${parts.compactionSection ?? ""}
## Hard Rules
${parts.hardRules}
${parts.ambiguityRule}
- Keep each dispatch focused and use the returned evidence before reporting completion.`;
	return parts.dispatcherPersonaPrompt ? `${parts.dispatcherPersonaPrompt}\n\n${policy}` : policy;
}

export interface NamedHubPart { id: string; text: string; category: ContextCategory; persistence?: ContextBudgetComponent["persistence"]; source?: string; }

export function namedHubLedgerParts(input: {
	intro: string; languageLines: string; teamMembers: string; agentCards: readonly { id: string; text: string }[];
	dispatchSection: string; modeSection: string; verificationSection: string; researchCards: readonly { id: string; text: string }[];
	researchCatalog: string; comsSection: string; herdrSection: string; compactionSection?: string; stateCapsule?: string; dispatcherPersonaPrompt?: string;
}): NamedHubPart[] {
	return [
		{ id: "hub/policy/posture", text: input.intro, category: "system", persistence: "fixed", source: "posture.ts" },
		{ id: "hub/policy/language", text: input.languageLines, category: "protocol", persistence: "fixed", source: "hub-policy" },
		{ id: "hub/roster-header", text: input.teamMembers, category: "roster", persistence: "session", source: "active-roster" },
		...input.agentCards.map(card => ({ id: `hub/roster/${card.id}`, text: card.text, category: "roster" as const, persistence: "session" as const, source: "agent-persona" })),
		{ id: "hub/policy/dispatch", text: input.dispatchSection, category: "protocol", persistence: "fixed", source: "hub-policy" },
		{ id: "hub/policy/triage", text: input.modeSection, category: "protocol", persistence: "fixed", source: "run-budget" },
		{ id: "hub/policy/verification", text: input.verificationSection, category: "protocol", persistence: "fixed", source: "orchestration-verification" },
		{ id: "hub/state", text: input.stateCapsule ?? "", category: "system", persistence: "turn", source: "hub-state" },
		...(input.researchCards.length ? input.researchCards.map(card => ({ id: `hub/research/${card.id}`, text: card.text, category: "persona" as const, persistence: "session" as const, source: "research-persona" })) : [{ id: "hub/research-empty", text: input.researchCatalog, category: "persona" as const, persistence: "session" as const, source: "research-persona" }]),
		{ id: "hub/policy/coms", text: input.comsSection, category: "protocol", persistence: "fixed", source: "coms" },
		{ id: "hub/policy/workspace", text: input.herdrSection, category: "protocol", persistence: "fixed", source: "herdr" },
		{ id: "hub/policy/compaction", text: input.compactionSection ?? "", category: "protocol", persistence: "fixed", source: "compaction" },
		{ id: "hub/persona", text: input.dispatcherPersonaPrompt ?? "", category: "persona", persistence: "session", source: "dispatcher-persona" },
	];
}

export function recordHubLedger(systemPrompt: string, parts: readonly NamedHubPart[]): ContextBudgetComponent[] {
	const namedChars = parts.reduce((sum, part) => sum + part.text.length, 0);
	return parts.map(part => component({
		id: part.id, plane: "hub", category: part.category, label: part.id.replace("hub/", "Hub "), source: part.source,
		persistence: part.persistence ?? "turn", visibility: "model-visible", confidence: "exact-chars", chars: part.text.length,
	})).concat(component({
		id: "hub/separators-and-rules", plane: "hub", category: "system", label: "Hub separators and formatting", source: "hub-prompt-template",
		persistence: "fixed", visibility: "model-visible", confidence: "exact-chars", chars: Math.max(0, systemPrompt.length - namedChars),
	}));
}
