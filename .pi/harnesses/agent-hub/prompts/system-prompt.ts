import { MAX_OPEN_ASSERTIONS } from "../assertion-ledger.js";
import { CAPABILITY_PACKS, type CapabilityPack } from "../capability-packs.ts";
import { workModePrompt } from "../work-mode.ts";
import { component, type ContextBudgetComponent } from "../../lib/context-budget.ts";
import { assembleHubSystemPrompt, HUB_HERDR_SECTION, namedHubLedgerParts, recordHubLedger } from "../../lib/context-budget-hub-prompt.ts";
import type { HubPromptContext } from "./context.ts";
import {
	ASK_SYSTEM1_RECOMMENDED_FRAGMENT,
 FILE_DISCOVERY_FRAGMENT,
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
	const triageBeforeDispatch = fleetActive && ctx.getWorkMode() === "orchestrator" && ctx.getActiveTools().includes("dispatch_triage") && ctx.getTriageBeforeDispatch?.() === true;
	const dispatchSection = dispatchFragment(fleetActive, askUserAvailable, userLanguage) + (triageBeforeDispatch ? `

## Enabled System 1 pre-dispatch advice
After resolving requirements, task classification and the active roster, call \`dispatch_triage\` once for each focused task you intend to delegate, before choosing its \`dispatch_agent\` persona. Send only minimal non-secret context, relative scope, and the actual language/domain. Do not read files or credentials merely to populate triage.
Then independently decide whether and whom to dispatch. An \`uncalibrated\` result contains experimental observations, NOT an approved recommendation; never invent a calibration profile. Do not ask the human solely because calibration is absent. All existing ambiguity, risk, permission, budget and acceptance rules still apply. Low predicted risk never means safe.
If triage abstains, fails, is unavailable, stale, or reaches its budget, use ordinary independent judgment without automatic retries or forcing a specialist. Do not delegate operator/research-only work just to exercise triage. When dispatching after an applicable result, include its \`triage_id\` and a truthful \`triage_reason\` (\`independent_judgment\` for uncalibrated observations). A triage result is never authorization to execute.
` : "");
	const ambiguityRule = ambiguityFragment(askUserAvailable, userLanguage);
	const languageLines = languageFragment(askUserAvailable, userLanguage);
	const stateCapsule = stateCapsuleFragment(ctx.getPromptState(), resolution);
	const agenticRecommended = ctx.getActiveTools().includes("ask_system1") && ctx.getAgenticAskMode?.() === "recommended";
	const stableModeSection = [fleetActive ? TASK_TRIAGE_FRAGMENT : "", agenticRecommended ? ASK_SYSTEM1_RECOMMENDED_FRAGMENT : "", ctx.getActiveTools().includes('ask_system1_files') ? FILE_DISCOVERY_FRAGMENT : ""].filter(Boolean).join("\n\n");
	const artifactRoot = ctx.getArtifactRoot?.();
	const verificationSection = (verificationActive ? verificationFragment(MAX_OPEN_ASSERTIONS) : "") +
		(artifactRoot && (verificationActive || fleetActive) ? `\n\nSession artifact root: ${artifactRoot}. Use this absolute root for read/write tools. Handoff paths artifacts/<kind>/... are relative to this root, not the repository. Legacy shared .pi/agent-sessions/artifacts paths belong to other sessions; do not overwrite them.` : "");
	const projectPolicySection = ctx.getRulesProtocol() + ctx.getDocsProtocol();
	const comsSection = comsFragment(peerActive, ctx.isComsReady(), ctx.getIdentity());
	const workModeText = workModePrompt(ctx.getWorkMode());
	const herdrSection = workspaceActive && ctx.isHerdrFleetReady() ? HUB_HERDR_SECTION : "";
	const compactionSection = compactionActive ? COMPACTION_FRAGMENT : "";
	const systemPrompt = assembleHubSystemPrompt({
		intro: workModeText.intro,
		toolList: `these active packs: ${[...modelPacks].join(", ")}. Tools: ${ctx.getActiveTools().map(name => `\`${name}\``).join(", ") || "(none)"}${ctx.getToolCatalogNotice?.() ? `\n${ctx.getToolCatalogNotice()}` : ""}`,
		languageLines,
		activeTeamName: ctx.getActiveTeamName(),
		teamMembers,
		dispatchSection,
		userLanguage,
		askUserBlock,
		modeSection: stableModeSection,
		verificationSection,
		projectPolicySection,
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
		projectPolicySection,
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
