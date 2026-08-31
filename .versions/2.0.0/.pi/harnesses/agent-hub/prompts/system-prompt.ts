import { MAX_OPEN_ASSERTIONS } from "../assertion-ledger.js";
import { CAPABILITY_PACKS, type CapabilityPack } from "../capability-packs.ts";
import { workModePrompt } from "../work-mode.ts";
import { component, type ContextBudgetComponent } from "../../lib/context-budget.ts";
import { assembleHubSystemPrompt, HUB_HERDR_SECTION, namedHubLedgerParts, recordHubLedger } from "../../lib/context-budget-hub-prompt.ts";
import type { HubPromptContext } from "./context.ts";
import {
	ambiguityFragment,
	askUserFragment,
	COMPACTION_FRAGMENT,
	comsFragment,
	dispatchFragment,
	languageFragment,
	stateCapsuleFragment,
	TASK_TRIAGE_FRAGMENT,
	verificationFragment,
} from "./fragments.ts";

export interface BuiltHubSystemPrompt {
	systemPrompt: string;
	ledger: ContextBudgetComponent[];
}

function capabilityStatus(pack: CapabilityPack, ctx: HubPromptContext, active: readonly CapabilityPack[], provisional: readonly CapabilityPack[]): string {
	if (active.includes(pack)) return "active";
	if (provisional.includes(pack)) return "provisional";
	if ((pack === "peer" && ctx.isComsReady()) || (pack === "workspace" && ctx.isHerdrFleetReady())) return "ready-inactive";
	return pack === "peer" || pack === "workspace" ? "unavailable" : "inactive";
}

/** Pure text and ledger assembly. Turn lifecycle resets are owned by index.ts. */
export function buildHubSystemPrompt(ctx: HubPromptContext): BuiltHubSystemPrompt {
	const resolution = ctx.getCapabilityResolution();
	const modelPacks = new Set<CapabilityPack>([...resolution.active, ...resolution.provisional]);
	const fleetActive = modelPacks.has("fleet");
	const verificationActive = modelPacks.has("verification");
	const peerActive = modelPacks.has("peer");
	const workspaceActive = modelPacks.has("workspace");
	const compactionActive = modelPacks.has("compaction");
	const agents = fleetActive ? ctx.getAgents() : [];
	const agentCards = agents.map(agent => ({
		id: agent.name,
		text: `### ${agent.displayName}\n**Dispatch as:** \`${agent.name}\`\n${agent.description}\n**Tools:** ${agent.tools}`,
	}));
	const agentCatalog = agentCards.map(card => card.text).join("\n\n");
	const teamMembers = agents.map(agent => agent.displayName).join(", ");
	const researchPersonas = fleetActive ? ctx.getResearchPersonas() : [];
	const researchCards = researchPersonas.map(persona => ({
		id: persona.name,
		text: `### ${persona.displayName}\n**Spawn as:** \`spawn_research(persona: "${persona.name}")\`\n**Model:** ${persona.model || "(dispatcher’s default)"} · **Thinking:** ${persona.thinking}\n${persona.description}`,
	}));
	const researchCatalog = !fleetActive ? "" : researchCards.length > 0
		? researchCards.map(card => card.text).join("\n\n")
		: "(No research personas defined. Call `spawn_research` without `persona` for an ad-hoc read-only helper.)";
	const askUserAvailable = ctx.isAskUserAvailable();
	const userLanguage = ctx.getUserLanguage();
	const askUserBlock = askUserFragment(askUserAvailable, userLanguage);
	const dispatchSection = dispatchFragment(fleetActive, askUserAvailable, userLanguage);
	const ambiguityRule = ambiguityFragment(askUserAvailable, userLanguage);
	const languageLines = languageFragment(askUserAvailable, userLanguage);
	const stateCapsule = stateCapsuleFragment(ctx.getPromptState(), resolution);
	const stableModeSection = fleetActive ? TASK_TRIAGE_FRAGMENT : "";
	const verificationSection = verificationActive ? verificationFragment(MAX_OPEN_ASSERTIONS) : "";
	const comsSection = comsFragment(peerActive, ctx.isComsReady(), ctx.getIdentity());
	const workModeText = workModePrompt(ctx.getWorkMode());
	const herdrSection = workspaceActive && ctx.isHerdrFleetReady() ? HUB_HERDR_SECTION : "";
	const compactionSection = compactionActive ? COMPACTION_FRAGMENT : "";
	const systemPrompt = assembleHubSystemPrompt({
		intro: workModeText.intro,
		toolList: `these active packs: ${[...modelPacks].join(", ")}. Tools: ${ctx.getActiveTools().map(name => `\`${name}\``).join(", ") || "(none)"}`,
		languageLines,
		activeTeamName: ctx.getActiveTeamName(),
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
	const ledger = recordHubLedger(systemPrompt, namedHubLedgerParts({
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
		const status = capabilityStatus(pack, ctx, resolution.active, resolution.provisional);
		return component({
			id: `hub/capability/${pack}`, plane: "hub", category: "system", label: `Capability ${pack}: ${status}`,
			source: resolution.reasons[pack], persistence: "turn", visibility: "ui-only", confidence: "exact-chars", chars: 0,
		});
	}));
	return { systemPrompt, ledger };
}
