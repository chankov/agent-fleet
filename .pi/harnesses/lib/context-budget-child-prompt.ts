import { DELEGATE_TREE_SPAWN_BUDGET } from "../agent-hub/helpers.ts";
import { externalBlockedProtocol } from "../agent-hub/external-blocker.js";

export { DELEGATE_TREE_SPAWN_BUDGET };
export const RESEARCH_TOOLS = "read,grep,find,ls";
export const MAX_AUTO_RESEARCH_QUESTIONS = 4;

export const RESEARCH_PROTOCOL = `

## You are a READ-ONLY research helper
You can ONLY read, search, and list files (tools: read, grep, find, ls). You CANNOT
edit, write, or run shell/bash commands — they are not available to you. Investigate
what you're asked, then report findings concisely, citing concrete locations as
path:line. Do not propose or attempt edits; another agent will act on your findings.
If something can't be found or is ambiguous, say so plainly rather than guessing.`;

export function buildClarificationProtocol(userLanguage: string, maxQuestions = MAX_AUTO_RESEARCH_QUESTIONS): string {
	return `

## Clarification protocol
If at any point you need a decision from the human user (ambiguity, missing input,
contradiction, or a destructive/irreversible next step), DO NOT guess. Stop and
return a single line of the form:

  ASK_USER: <your question in one clear English sentence>

You may emit multiple ASK_USER lines if you have several questions. The dispatcher
will surface each to the human user in ${userLanguage} and re-dispatch you with the
answers. Do not invent values, do not pick "reasonable defaults" silently — ask.

## External-blocker protocol
${externalBlockedProtocol()}

## Research protocol
If you need reconnaissance you cannot perform with your own tools (broad code search,
reading unfamiliar areas of the codebase, summarizing docs), DO NOT guess and DO NOT
ask the user. Pause for research instead: end your turn with one or more lines of the
form

  NEEDS_RESEARCH: <one specific, self-contained question>

with nothing after them. Your session pauses there; read-only research helpers are
spawned for you, each helper's findings are saved to a file, and you are resumed in
this same session with the file paths — read them and continue from where you left
off. Ask at most ${maxQuestions} questions per pause. Use ASK_USER only
for decisions a human must make; use NEEDS_RESEARCH for facts that can be looked up.`;
}

export function buildDelegationProtocol(roleNames: readonly string[], spawnBudget = DELEGATE_TREE_SPAWN_BUDGET): string {
	if (roleNames.length === 0) return "";
	return `

## Delegation protocol
You have a \`delegate\` tool with pre-configured sub-agents on cheaper models
(roles: ${roleNames.join(", ")}). Prefer delegating scoped, self-contained
sub-tasks to them over doing everything yourself. A child shares NONE of your
context — put everything it needs into its instruction/context. You may run up
to ${spawnBudget} delegate calls for this dispatch; parallel children are forced read-only.
Children are terminal workers: they do not receive delegate tooling at remaining depth 0.`;
}

export function buildDeliverableProtocol(agentKey: string, runNumber: number): string {
	return `

## Deliverable-to-file protocol
When your deliverable is a document (plan, review, critique, inventory, report), write the full document to the real session artifact path when your tools allow it: .pi/agent-sessions/artifacts/<kind>/${agentKey}-run${runNumber}.md (kinds: plans, reviews, inventories, evidence). Do NOT write repo-root ./artifacts/... files. In your final response, report and pass the artifact-relative handoff path: artifacts/<kind>/${agentKey}-run${runNumber}.md. If your persona already has an explicit output path contract such as planner PLAN_FILE, keep that existing behavior and also summarize/return the session artifact path the hub gives you.
Finish with the artifact-relative path plus a digest of no more than 10 lines. If the dispatch includes acceptance assertions (A1, A2, ...), also include the structured return from skills/orchestration-verification/SKILL.md. If your tools are read-only and you cannot write a document artifact yourself, finish with the digest + structured return; the hub will still persist your full final return under artifacts/returns/ for dispatcher recovery.`;
}

export interface ChildPromptParts {
	id: string;
	category: "persona" | "tool" | "system" | "protocol";
	label: string;
	chars: number;
}

export function specialistStandingParts(input: {
	personaChars: number;
	toolChars: number;
	basePromptChars: number;
	docsProtocol: string;
	rulesProtocol: string;
	userLanguage: string;
	delegateRoles?: readonly string[];
	agentKey?: string;
	runNumber?: number;
}): ChildPromptParts[] {
	const clarification = buildClarificationProtocol(input.userLanguage);
	const delegation = buildDelegationProtocol(input.delegateRoles ?? []);
	const deliverable = buildDeliverableProtocol(input.agentKey ?? "<persona>", input.runNumber ?? 0);
	return [
		{ id: "persona", category: "persona", label: "Full persona", chars: input.personaChars },
		{ id: "child-tools", category: "tool", label: "Configured child tools", chars: input.toolChars },
		{ id: "pi-base", category: "system", label: "Pi child base prompt inputs", chars: input.basePromptChars },
		{ id: "docs-protocol", category: "protocol", label: "Project docs protocol", chars: input.docsProtocol.length },
		{ id: "clarification-protocol", category: "protocol", label: "Clarification and external-blocker protocols", chars: clarification.length },
		{ id: "rules-protocol", category: "protocol", label: "Project rules protocol", chars: input.rulesProtocol.length },
		{ id: "delegation-protocol", category: "protocol", label: "Delegation protocol", chars: delegation.length },
		{ id: "deliverable-protocol", category: "protocol", label: "Deliverable and artifact framing", chars: deliverable.length },
	];
}

export function researchStandingParts(input: {
	personaChars: number;
	toolChars: number;
	basePromptChars: number;
	docsProtocol: string;
}): ChildPromptParts[] {
	return [
		{ id: "persona", category: "persona", label: "Full persona", chars: input.personaChars },
		{ id: "child-tools", category: "tool", label: "Configured child tools", chars: input.toolChars },
		{ id: "pi-base", category: "system", label: "Pi child base prompt inputs", chars: input.basePromptChars },
		{ id: "docs-protocol", category: "protocol", label: "Project docs protocol", chars: input.docsProtocol.length },
		{ id: "research-protocol", category: "protocol", label: "Read-only research protocol", chars: RESEARCH_PROTOCOL.length },
	];
}

export function delegateStandingParts(input: {
	toolChars: number;
	basePromptChars: number;
	roleNames: readonly string[];
}): ChildPromptParts[] {
	return [
		{ id: "delegate-protocol", category: "protocol", label: "Resolved delegate role protocol", chars: buildDelegationProtocol(input.roleNames).length },
		{ id: "child-tools", category: "tool", label: "Resolved delegate tools", chars: input.toolChars },
		{ id: "pi-base", category: "system", label: "Pi child base prompt inputs", chars: input.basePromptChars },
	];
}

export function nativeSpecialistAppendedPrompt(input: {
	systemPrompt: string;
	userLanguage: string;
	rulesProtocol: string;
	docsProtocol: string;
	delegateRoles?: readonly string[];
	agentKey: string;
	runNumber: number;
}): string {
	return input.systemPrompt
		+ buildClarificationProtocol(input.userLanguage)
		+ input.rulesProtocol
		+ input.docsProtocol
		+ buildDelegationProtocol(input.delegateRoles ?? [])
		+ buildDeliverableProtocol(input.agentKey, input.runNumber);
}

export function nativeResearchAppendedPrompt(systemPrompt: string, docsProtocol: string): string {
	return systemPrompt + RESEARCH_PROTOCOL + docsProtocol;
}
