import { component, type ContextBudgetComponent, type ContextCategory } from "./context-budget.ts";

/**
 * Prompt inputs are deliberately split between stable policy and a small volatile
 * state capsule. Callers must not put counters or task state in policy fragments.
 */
export interface HubPromptParts {
	intro: string;
	toolList: string;
	languageLines: string;
	dispatchSection: string;
	askUserBlock: string;
	modeSection: string;
	verificationSection: string;
	projectPolicySection?: string;
	comsSection: string;
	herdrSection: string;
	compactionSection?: string;
	hardRules: string;
	ambiguityRule: string;
	/** The three runtime roles with their authority (one line each). */
	roleCatalog: string;
	/** The code-owned practice catalog: id and one-line expected result. */
	practiceCatalog: string;
	/** Work-mode guidance on when to delegate; stable policy. */
	delegationGuide?: string;
	/** Live task state and catalog notices, appended after the stable instructions. */
	stateCapsule?: string;
}

export const HUB_HERDR_SECTION = `
## Fleet (herdr)
- Use panes only for auxiliary processes; never bypass specialist delegation.
- Spawn a peer immediately before its first message. It boots idle; \`peer_ready: false\` is a failed start.
- Check \`coms_list\` for peer status; read panes only for unbridged tools or post-mortems.
- \`herdr_close_pane\` requires human confirmation. Close only panes you opened when their work ends.
- \`herdr_notify\` reaches an away human. Use Decision routing when you need their answer.
`;

const HUB_STATE_ID = "hub/state";

function stateSection(stateCapsule?: string): string {
	return stateCapsule ? `\n\n${stateCapsule}` : "";
}

/** Assemble the effective Hub replacement prompt. Ledger metadata is never interpolated.
 *
 * T9 truthful guidance: the prompt points at the active catalog and the read-only
 * inspection route, never at routine slash resets. Preflight refusals carry their
 * authoritative tier/catalog/revision snapshot; tool availability is never gate admission.
 */
export function assembleHubSystemPrompt(parts: HubPromptParts): string {
	const fleet = parts.dispatchSection ? `
${parts.delegationGuide ? `\n${parts.delegationGuide}\n` : ""}
## How to Work
${parts.dispatchSection}
- Choose \`backend: native\` only for an explicitly requested local Pi specialist, \`backend: coms\` only for an explicitly requested live coms peer, and \`backend: auto\` otherwise. Never substitute an explicit backend.

## Roles and practices
An assignment is one role (its authority) plus \`practices\` (combinable; empty: role default) that add method and evidence, never authority. Specialists cannot spawn helpers; pass them findings or artifact paths.
${parts.roleCatalog}
Practices:
${parts.practiceCatalog}
` : "";
	const verification = parts.verificationSection ? `\n${parts.verificationSection}\n` : "";
	const policy = `${parts.intro} You have ${parts.toolList}.

## Language
${parts.languageLines}${fleet}
${parts.askUserBlock}

${parts.modeSection}${verification}${parts.projectPolicySection ?? ""}
${parts.comsSection}${parts.herdrSection}${parts.compactionSection ?? ""}
## Hard Rules
${parts.hardRules}
${parts.ambiguityRule}
- Keep each dispatch focused; check its returned evidence and follow up on gaps before reporting completion.`;
	return policy + stateSection(parts.stateCapsule);
}

export interface NamedHubPart { id: string; text: string; category: ContextCategory; persistence?: ContextBudgetComponent["persistence"]; source?: string; }

export function namedHubLedgerParts(input: {
	intro: string; languageLines: string; roleCards: readonly { id: string; text: string }[]; practiceCatalog: string;
	dispatchSection: string; modeSection: string; verificationSection: string; projectPolicySection?: string;
	comsSection: string; herdrSection: string; compactionSection?: string; stateCapsule?: string;
}): NamedHubPart[] {
	return [
		{ id: "hub/policy/work-mode", text: input.intro, category: "system", persistence: "fixed", source: "work-mode.ts" },
		{ id: "hub/policy/language", text: input.languageLines, category: "protocol", persistence: "fixed", source: "hub-policy" },
		{ id: "hub/policy/dispatch", text: input.dispatchSection, category: "protocol", persistence: "fixed", source: "hub-policy" },
		...input.roleCards.map(card => ({ id: `hub/role/${card.id}`, text: card.text, category: "roster" as const, persistence: "session" as const, source: "config/roles.ts" })),
		{ id: "hub/practices", text: input.practiceCatalog, category: "roster", persistence: "fixed", source: "config/practices.ts" },
		{ id: "hub/policy/triage", text: input.modeSection, category: "protocol", persistence: "fixed", source: "run-budget" },
		{ id: "hub/policy/verification", text: input.verificationSection, category: "protocol", persistence: "fixed", source: "orchestration-verification" },
		{ id: "hub/policy/project", text: input.projectPolicySection ?? "", category: "protocol", persistence: "session", source: "project-overrides" },
		{ id: "hub/policy/coms", text: input.comsSection, category: "protocol", persistence: "fixed", source: "coms" },
		{ id: "hub/policy/workspace", text: input.herdrSection, category: "protocol", persistence: "fixed", source: "herdr" },
		{ id: "hub/policy/compaction", text: input.compactionSection ?? "", category: "protocol", persistence: "fixed", source: "compaction" },
		{ id: HUB_STATE_ID, text: stateSection(input.stateCapsule), category: "system", persistence: "turn", source: "hub-state" },
	];
}

export function recordHubLedger(systemPrompt: string, parts: readonly NamedHubPart[]): ContextBudgetComponent[] {
	const namedChars = parts.reduce((sum, part) => sum + part.text.length, 0);
	const ledger = parts.map(part => component({
		id: part.id, plane: "hub", category: part.category, label: part.id.replace("hub/", "Hub "), source: part.source,
		persistence: part.persistence ?? "turn", visibility: "model-visible", confidence: "exact-chars", chars: part.text.length,
	}));
	const stateIndex = ledger.findIndex(entry => entry.id === HUB_STATE_ID);
	// The residual describes the shared template, so keep it with the stable rows.
	ledger.splice(stateIndex === -1 ? ledger.length : stateIndex, 0, component({
		id: "hub/separators-and-rules", plane: "hub", category: "system", label: "Hub separators and formatting", source: "hub-prompt-template",
		persistence: "fixed", visibility: "model-visible", confidence: "exact-chars", chars: Math.max(0, systemPrompt.length - namedChars),
	}));
	return ledger;
}
