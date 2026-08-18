import { component, type ContextBudgetComponent, type ContextCategory } from "./context-budget.ts";

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
	hardRules: string;
	ambiguityRule: string;
	agentCatalog: string;
	researchCatalog: string;
	dispatcherPersonaPrompt?: string;
}

export const HUB_HERDR_SECTION = `
## Fleet (herdr)
This session runs inside a herdr workspace and can drive panes:
- \`herdr_spawn_peer\` starts an addressable Pi persona, personaless Fleet Core, or Claude Code
  peer next to you. Name-only calls inherit peers.yaml; explicit fields use the same resolver as
  \`just fleet peer\`. Every peer is locked to this Hub's coms project.
- \`herdr_spawn_pane\` starts a raw command pane (for example a build watcher or server). It is
  not a coms peer and has no readiness result. Spawn deliberately; every pane is human-visible.
- A spawned peer BOOTS IDLE and waits for \`coms_send\`: the spawn hands it no task.
  The call waits for it to register and returns \`peer_ready\` with its coms name. Spawn one
  only immediately before the first message you will send it — a peer spawned "to have it
  ready" and never addressed is an empty pane named like a worker. If you sent it no work
  by the end of the turn, say so and offer to close it; the hub names unaddressed
  hub-spawned peers in the session digest.
- \`peer_ready: false\` is a FAILED start, not a slow one. The result carries the pane's last
  output — read it, then fix the cause or close the pane and spawn again. Never \`coms_send\`
  to a name that never registered, and never spawn a second peer to route around the first.
- \`herdr_read_pane\` is read-to-decide: peek at a worker/tool pane's recent output before
  acting on it. It is NOT a messaging channel and NOT a status poll — \`coms_list\` already
  reports each peer's \`pane_id\` and \`status\` (idle | working | booting), so check that
  before sending. Prefer \`coms_send\`/\`coms_await\` for pi and bridged peers; reading screens
  is the last resort for unbridged tools and post-mortems.
- \`herdr_close_pane\` kills a pane and asks the HUMAN to confirm first. Close only panes you
  spawned, when their job is done or they are stuck.
- \`herdr_notify\` reaches the human via desktop notification when they are away — use it when
  a long fleet task finishes or needs attention; it does not replace \`ask_user\`.
`;

/** Assemble the effective Hub replacement prompt. Ledger metadata is never interpolated. */
export function assembleHubSystemPrompt(parts: HubPromptParts): string {
	const team = parts.activeTeamName || "(none)";
	const members = parts.teamMembers || "(none — add a persona before using dispatch_agent)";
	const orchestratorPrompt = `${parts.intro} You have ${parts.toolList}.

## Language
${parts.languageLines}

## Native Roster: ${team}
Members: ${members}
You can ONLY dispatch to agents listed below. Do not attempt to dispatch to agents
outside this team. The roster CAN change mid-session: the human via /af-agents-add,
/af-agents-drop, /af-agents-team — or you via \`team_adjust\` (add/drop with a reason)
when the current roster genuinely cannot serve the task. Use it sparingly; more
personas is usually the wrong answer.

## How to Work
- Analyze the user's request and break it into clear sub-tasks.
- Choose the right agent(s) for each sub-task.
${parts.dispatchSection}
- Choose \`backend: native\` when the user explicitly requests a local Pi specialist, \`backend: coms\` when they explicitly request a live same-name peer, and \`backend: auto\` otherwise. Never substitute one explicit backend for another.
- Review results and dispatch follow-up agents if needed.
- If a task fails, try a different agent or adjust the task description.
- Summarize the outcome for the user in ${parts.userLanguage}.

${parts.askUserBlock}

${parts.modeSection}
${parts.verificationSection}

## Research helpers (read-only)
- \`spawn_research\` runs a READ-ONLY helper (read/grep/find/ls — no bash, no writes)
  and returns its findings to you inline. Use it for reconnaissance, code search, and
  reading docs/code BEFORE you dispatch a builder — or to fan out background research.
- Two flavours: pass \`persona\` to spawn one of the research personas listed below (it
  brings its own role/model); omit \`persona\` for an ad-hoc helper (optional \`model\`).
- Match the helper to the job: use a lighter/faster persona for simple reads and a
  higher-capability one for ambiguous, cross-cutting, or high-stakes research. Compare
  the **Model** / **Thinking** shown for each persona below and pick deliberately.
- Specialists you dispatch are sandboxed and CANNOT spawn their own helpers. When a
  specialist needs research help, YOU run \`spawn_research\`, collect the findings, and
  fold them into the specialist's task — do not ask the specialist to do it itself.
- Research helpers are ephemeral and read-only, so they are always safe to run.
${parts.comsSection}${parts.herdrSection}
## Hard Rules
${parts.hardRules}
${parts.ambiguityRule}
- You can chain agents: spawn_research to gather context, builder to implement.
- You can dispatch the same agent multiple times with different tasks.
- Keep tasks focused — one clear objective per dispatch.

## Agents

${parts.agentCatalog}

## Research personas

${parts.researchCatalog}`;
	return parts.dispatcherPersonaPrompt
		? `${parts.dispatcherPersonaPrompt}\n\n${orchestratorPrompt}`
		: orchestratorPrompt;
}

export interface NamedHubPart {
	id: string;
	text: string;
	category: ContextCategory;
}

export function namedHubLedgerParts(input: {
	intro: string;
	languageLines: string;
	teamMembers: string;
	agentCards: readonly { id: string; text: string }[];
	dispatchSection: string;
	modeSection: string;
	verificationSection: string;
	researchCards: readonly { id: string; text: string }[];
	researchCatalog: string;
	comsSection: string;
	herdrSection: string;
	dispatcherPersonaPrompt?: string;
}): NamedHubPart[] {
	const herdrReady = input.herdrSection.length > 0;
	return [
		{ id: "hub/intro", text: input.intro, category: "system" },
		{ id: "hub/language", text: input.languageLines, category: "protocol" },
		{ id: "hub/roster-header", text: input.teamMembers, category: "roster" },
		...input.agentCards.map((card) => ({ id: `hub/roster/${card.id}`, text: card.text, category: "roster" as const })),
		{ id: "hub/work-policy", text: input.dispatchSection, category: "protocol" },
		{ id: "hub/task-triage", text: input.modeSection, category: "protocol" },
		{ id: "hub/verification", text: input.verificationSection, category: "protocol" },
		...(input.researchCards.length
			? input.researchCards.map((card) => ({ id: `hub/research/${card.id}`, text: card.text, category: "persona" as const }))
			: [{ id: "hub/research-empty", text: input.researchCatalog, category: "persona" as const }]),
		{ id: "hub/coms", text: input.comsSection, category: "protocol" },
		{ id: "hub/herdr", text: input.herdrSection, category: "protocol" },
		{ id: "hub/persona", text: input.dispatcherPersonaPrompt ?? "", category: "persona" },
	].map((part) => part.id === "hub/herdr" && !herdrReady
		? { ...part, text: "" }
		: part);
}

export function recordHubLedger(systemPrompt: string, parts: readonly NamedHubPart[]): ContextBudgetComponent[] {
	const namedChars = parts.reduce((sum, part) => sum + part.text.length, 0);
	return parts.map((part) => component({
		id: part.id,
		plane: "hub",
		category: part.category,
		label: part.id.replace("hub/", "Hub "),
		persistence: "turn",
		visibility: part.id === "hub/herdr" && part.text.length === 0 ? "unknown" : "model-visible",
		confidence: part.id === "hub/herdr" && part.text.length === 0 ? "unavailable" : "exact-chars",
		chars: part.text.length,
	})).concat(component({
		id: "hub/separators-and-rules",
		plane: "hub",
		category: "system",
		label: "Hub separators, hard rules, and formatting",
		persistence: "turn",
		visibility: "model-visible",
		confidence: "exact-chars",
		chars: Math.max(0, systemPrompt.length - namedChars),
	}));
}
